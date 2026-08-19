#!/usr/bin/env bash
#
# Soak runner for BLO-20885 AC2 — "the file's full suite passes 20 consecutive
# runs with no failure", at ONE head.
#
# Runs server/src/__tests__/heartbeat-queued-backlog-convergence.test.ts N times
# in a FRESH vitest process per iteration and emits the same summary.txt table
# shape as the two hand-run series that preceded it:
#
#   head=<sha> started=<iso> nproc=<n> ...
#   iter=01 rc=0 dur=150s load0=12.76 | Test Files 1 passed (1) | Tests 11 passed (11)
#
# A fresh process per iteration is NOT the same thing as `vitest --repeat N`,
# which repeats each *test* inside a single process and therefore never
# re-exercises process startup, the global setup, or the embedded-Postgres
# lifecycle — which is where the timing sensitivity this ticket is about lives.
#
# The load regime matters as much as the pass count. Series 1 (head 3cbf0b6f)
# produced its single real failure at iteration 14 only once the host reached
# load average ~11 on 48 cores (~0.23/core) and iteration time roughly doubled
# from its ~130s baseline. A soak on an idle runner can go 20/20 without ever
# reaching that condition, which is a vacuous green. So this script can hold
# synthetic CPU load, and — either way — reports what the regime actually was
# instead of assuming it.
#
# Env:
#   ITERATIONS    iteration count (default 20)
#   LOAD_WORKERS  "auto" (default) | "off" | integer count of busy-loop workers
#   OUT_DIR       output directory (default ./soak-out)
#
# Exit: 0 only if every iteration returned rc=0.

set -uo pipefail

TEST_FILE="src/__tests__/heartbeat-queued-backlog-convergence.test.ts"
ITERATIONS="${ITERATIONS:-20}"
LOAD_WORKERS="${LOAD_WORKERS:-auto}"
OUT_DIR="${OUT_DIR:-${PWD}/soak-out}"

# Series-1 iter-14 failure regime: load average 11 on a 48-core host.
TARGET_LOAD_PER_CORE="0.229"
# Series-1 idle-regime baseline iteration time, for the "did it slow down?" read.
BASELINE_DUR_S="131"
# Wait this long after starting burners so the 1-minute load average — which is
# an exponentially-weighted decay, not an instantaneous gauge — actually
# reflects them before iteration 1 samples it.
LOAD_WARMUP_S="${LOAD_WARMUP_S:-90}"

if ! [[ "$ITERATIONS" =~ ^[0-9]+$ ]] || [ "$ITERATIONS" -lt 1 ]; then
  echo "soak: ITERATIONS must be a positive integer, got '$ITERATIONS'" >&2
  exit 2
fi

if [ ! -f "server/${TEST_FILE}" ]; then
  echo "soak: expected server/${TEST_FILE} to exist at this ref" >&2
  exit 2
fi

NPROC="$(nproc)"

case "$LOAD_WORKERS" in
  off | 0)
    WORKERS=0
    ;;
  auto)
    # ceil(nproc * target) — enough busy loops to sit at or just above the
    # load/core ratio the series-1 failure appeared at.
    WORKERS="$(awk -v n="$NPROC" -v r="$TARGET_LOAD_PER_CORE" \
      'BEGIN { w = int(n * r); if (w < n * r) w += 1; if (w < 1) w = 1; print w }')"
    ;;
  *[!0-9]*)
    echo "soak: LOAD_WORKERS must be 'auto', 'off', or an integer, got '$LOAD_WORKERS'" >&2
    exit 2
    ;;
  *)
    WORKERS="$LOAD_WORKERS"
    ;;
esac

mkdir -p "$OUT_DIR"
SUMMARY="${OUT_DIR}/summary.txt"
: > "$SUMMARY"

HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
# AC2's whole claim is "20 consecutive green at ONE head", so an artifact that
# cannot name its head is worthless. Fail loudly rather than emit head=HEAD.
if ! [[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "soak: could not resolve HEAD to a commit sha (got '${HEAD_SHA}')" >&2
  exit 2
fi
BASELINE_LOAD="$(awk '{ print $1 }' /proc/loadavg)"

BURNER_PIDS=()
cleanup() {
  if [ "${#BURNER_PIDS[@]}" -gt 0 ]; then
    kill "${BURNER_PIDS[@]}" 2>/dev/null || true
    wait "${BURNER_PIDS[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [ "$WORKERS" -gt 0 ]; then
  echo "soak: starting ${WORKERS} synthetic load worker(s) on ${NPROC} cores (baseline load0=${BASELINE_LOAD})"
  for _ in $(seq 1 "$WORKERS"); do
    # shellcheck disable=SC2050
    while :; do :; done &
    BURNER_PIDS+=("$!")
  done
  echo "soak: warming up ${LOAD_WARMUP_S}s so load average reflects the workers"
  sleep "$LOAD_WARMUP_S"
fi

{
  printf 'head=%s started=%s nproc=%s\n' \
    "$HEAD_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$NPROC"
  printf 'iterations=%s process_model=one-fresh-vitest-process-per-iteration (not --repeat)\n' \
    "$ITERATIONS"
  printf 'synthetic_load_workers=%s (mode=%s) baseline_load0_before_workers=%s\n' \
    "$WORKERS" "$LOAD_WORKERS" "$BASELINE_LOAD"
} >> "$SUMMARY"

FAILURES=0
LOADS=()
DURS=()

for i in $(seq 1 "$ITERATIONS"); do
  idx="$(printf '%02d' "$i")"
  log="${OUT_DIR}/iter-${i}.log"

  # Sample load *before* the iteration so the number describes the conditions
  # the run started under, matching how the hand-run series recorded it.
  load0="$(awk '{ print $1 }' /proc/loadavg)"
  start="$(date +%s)"

  (cd server && NO_COLOR=1 npx vitest run "$TEST_FILE") > "$log" 2>&1
  rc=$?

  dur=$(( $(date +%s) - start ))
  LOADS+=("$load0")
  DURS+=("$dur")
  [ "$rc" -eq 0 ] || FAILURES=$(( FAILURES + 1 ))

  # Strip ANSI defensively (NO_COLOR should already have done it) and collapse
  # vitest's column padding so the table lines up like the earlier series.
  clean="$(sed -e 's/\x1b\[[0-9;]*m//g' -e 's/[[:space:]]\{1,\}/ /g' -e 's/^ //' -e 's/ $//' "$log")"
  tf="$(printf '%s\n' "$clean" | grep -m1 -E '^Test Files ' || echo 'Test Files ?')"
  ts="$(printf '%s\n' "$clean" | grep -m1 -E '^Tests ' || echo 'Tests ?')"

  line="$(printf 'iter=%s rc=%s dur=%ss load0=%s | %s | %s' \
    "$idx" "$rc" "$dur" "$load0" "$tf" "$ts")"
  echo "$line" >> "$SUMMARY"
  echo "$line"
done

printf 'finished=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$SUMMARY"

# ---- regime verdict -------------------------------------------------------
# Stated explicitly rather than assumed: a 20/20 green that never reached the
# series-1 conditions is weak evidence, and the summary has to say so.
verdict="$(
  printf '%s\n' "${LOADS[@]}" | paste -d' ' - <(printf '%s\n' "${DURS[@]}") | awk \
    -v n="$NPROC" -v target="$TARGET_LOAD_PER_CORE" -v base="$BASELINE_DUR_S" -v iters="$ITERATIONS" '
    {
      l = $1; d = $2;
      lsum += l; dsum += d;
      if (NR == 1 || l < lmin) lmin = l;
      if (NR == 1 || l > lmax) lmax = l;
      if (NR == 1 || d > dmax) dmax = d;
      if (l / n >= target) at_or_above += 1;
    }
    END {
      lmean = lsum / NR; dmean = dsum / NR;
      printf "load0 min=%.2f mean=%.2f max=%.2f | per-core min=%.3f mean=%.3f max=%.3f (nproc=%d)\n",
        lmin, lmean, lmax, lmin / n, lmean / n, lmax / n, n;
      printf "duration mean=%ds max=%ds vs series-1 idle baseline ~%ss (%.2fx mean)\n",
        dmean, dmax, base, dmean / base;
      printf "iterations at or above the series-1 failure ratio (%.3f load/core): %d/%d\n",
        target, at_or_above, NR;
      if (at_or_above == NR)
        print "REGIME: REACHED for every iteration.";
      else if (at_or_above > 0)
        printf "REGIME: PARTIALLY reached (%d of %d iterations).\n", at_or_above, NR;
      else
        print "REGIME: NOT REACHED — the runner stayed below the series-1 load ratio for every iteration, so a green here is WEAK evidence and does not exercise the condition that produced the iter-14 failure.";
    }'
)"
printf '%s\n' "$verdict" >> "$SUMMARY"
printf 'result=%s failures=%s/%s\n' \
  "$([ "$FAILURES" -eq 0 ] && echo GREEN || echo RED)" "$FAILURES" "$ITERATIONS" >> "$SUMMARY"

echo
cat "$SUMMARY"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo '### Soak — heartbeat queued-backlog convergence'
    echo
    echo '```'
    cat "$SUMMARY"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi

if [ "$FAILURES" -ne 0 ]; then
  echo "soak: ${FAILURES}/${ITERATIONS} iteration(s) failed" >&2
  exit 1
fi

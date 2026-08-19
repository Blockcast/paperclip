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
#   iter=01 rc=0 dur=150s load0=12.76 dload0=+11.90 | Test Files 1 passed (1) | ...
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
#   LOAD_WARMUP_S seconds to let the load average converge (default 240)
#   OUT_DIR       output directory (default ./soak-out)
#
# Exit: 0 only if every iteration returned rc=0.

set -uo pipefail

TEST_FILE="src/__tests__/heartbeat-queued-backlog-convergence.test.ts"
ITERATIONS="${ITERATIONS:-20}"
LOAD_WORKERS="${LOAD_WORKERS:-auto}"
OUT_DIR="${OUT_DIR:-${PWD}/soak-out}"

# Series-1 iter-14 failure regime: load average 11 on a 48-core host. This is
# the bar the VERDICT tests against; it is deliberately not the bar the burners
# are sized to — see LOAD_SIZING_HEADROOM.
TARGET_LOAD_PER_CORE="0.229"
# Size burners ABOVE the verdict threshold. Sizing at exactly ceil(n*r) puts
# steady-state load at n*r against a test of l/n >= r — a ~0.07% margin, so any
# sampling jitter flips an iteration to "below" and a correctly-held regime
# reports as PARTIAL. 1.15 buys real headroom without changing the bar.
LOAD_SIZING_HEADROOM="1.15"
# Series-1 idle-regime baseline iteration time, for the "did it slow down?" read.
BASELINE_DUR_S="131"
# The 1-minute load average is an EWMA with a 60s time constant: it reaches only
# 1-e^(-t/60) of steady state — 77.7% at 90s, 95% at 180s, 98% at 240s. Warming
# up for much less than this guarantees iteration 1 samples below target no
# matter how many burners are running, which is what made the old 90s default
# under-report the regime by construction.
LOAD_WARMUP_S="${LOAD_WARMUP_S:-240}"

mkdir -p "$OUT_DIR"
SUMMARY="${OUT_DIR}/summary.txt"
: > "$SUMMARY"

# Fatal-path helper. The artifact upload runs with `if-no-files-found: error`,
# so an early exit must still leave a summary.txt naming the real cause --
# otherwise the upload fails second and its "no files found" message masks this
# one. Creating OUT_DIR above the validation block is what makes that possible.
die() {
  echo "soak: $1" >&2
  printf 'FATAL: %s\nresult=ERROR\n' "$1" >> "$SUMMARY"
  exit 2
}

if ! [[ "$ITERATIONS" =~ ^[0-9]+$ ]] || [ "$ITERATIONS" -lt 1 ]; then
  die "ITERATIONS must be a positive integer, got '$ITERATIONS'"
fi

if [ ! -f "server/${TEST_FILE}" ]; then
  die "expected server/${TEST_FILE} to exist at this ref"
fi

NPROC="$(nproc)"

# nproc reflects sched_getaffinity (a cpuset), NOT a CFS quota. On a
# quota-limited runner it returns host cores, so burner sizing can overshoot the
# job's real CPU budget and starve vitest rather than merely loading it. Record
# the quota next to it so that case is self-evident in the artifact.
read_cpu_quota() {
  if [ -r /sys/fs/cgroup/cpu.max ]; then
    tr -d '\n' < /sys/fs/cgroup/cpu.max
  elif [ -r /sys/fs/cgroup/cpu/cpu.cfs_quota_us ] && [ -r /sys/fs/cgroup/cpu/cpu.cfs_period_us ]; then
    printf '%s %s' \
      "$(tr -d '\n' < /sys/fs/cgroup/cpu/cpu.cfs_quota_us)" \
      "$(tr -d '\n' < /sys/fs/cgroup/cpu/cpu.cfs_period_us)"
  else
    printf 'unknown'
  fi
}
CPU_MAX="$(read_cpu_quota)"

case "$LOAD_WORKERS" in
  off | 0)
    WORKERS=0
    ;;
  auto)
    # ceil(nproc * target * headroom) — see LOAD_SIZING_HEADROOM.
    WORKERS="$(awk -v n="$NPROC" -v r="$TARGET_LOAD_PER_CORE" -v h="$LOAD_SIZING_HEADROOM" \
      'BEGIN { x = n * r * h; w = int(x); if (w < x) w += 1; if (w < 1) w = 1; print w }')"
    ;;
  *[!0-9]*)
    die "LOAD_WORKERS must be 'auto', 'off', or an integer, got '$LOAD_WORKERS'"
    ;;
  *)
    WORKERS="$LOAD_WORKERS"
    ;;
esac

HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
# AC2's whole claim is "20 consecutive green at ONE head", so an artifact that
# cannot name its head is worthless. Fail loudly rather than emit head=HEAD.
if ! [[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  die "could not resolve HEAD to a commit sha (got '${HEAD_SHA}')"
fi
BASELINE_LOAD="$(awk '{ print $1 }' /proc/loadavg)"

BURNER_PIDS=()
cleanup() {
  if [ "${#BURNER_PIDS[@]}" -gt 0 ]; then
    kill "${BURNER_PIDS[@]}" 2>/dev/null || true
    wait "${BURNER_PIDS[@]}" 2>/dev/null || true
    BURNER_PIDS=()
  fi
}
# A trapped INT/TERM handler that does not exit lets bash RESUME after it, so a
# single interrupt would kill the burners and leave the remaining iterations
# running with no load — a silently different experiment. Re-raise instead.
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap cleanup EXIT

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
  printf 'head=%s started=%s nproc=%s cpu_max=%s\n' \
    "$HEAD_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$NPROC" "$CPU_MAX"
  printf 'iterations=%s process_model=one-fresh-vitest-process-per-iteration (not --repeat)\n' \
    "$ITERATIONS"
  printf 'synthetic_load_workers=%s (mode=%s) warmup=%ss baseline_load0_before_workers=%s\n' \
    "$WORKERS" "$LOAD_WORKERS" "$LOAD_WARMUP_S" "$BASELINE_LOAD"
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
  # /proc/loadavg is host-wide and not namespaced by container or cgroup, so the
  # absolute figure can be a neighbour's. The delta against the pre-burner
  # baseline is what this job can actually claim.
  dload0="$(awk -v a="$load0" -v b="$BASELINE_LOAD" 'BEGIN { printf "%+.2f", a - b }')"
  start="$(date +%s)"

  # `pnpm exec`, not bare `npx`: npx does not fail when the local install is
  # incomplete — it fetches vitest@latest from the registry and runs THAT, which
  # either stalls a 90-minute soak on a registry blip or silently runs a
  # different major against this repo's vitest config. See BLO-28813.
  (cd server && NO_COLOR=1 pnpm exec vitest run "$TEST_FILE") > "$log" 2>&1
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

  line="$(printf 'iter=%s rc=%s dur=%ss load0=%s dload0=%s | %s | %s' \
    "$idx" "$rc" "$dur" "$load0" "$dload0" "$tf" "$ts")"
  echo "$line" >> "$SUMMARY"
  echo "$line"
done

printf 'finished=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$SUMMARY"

# ---- regime verdict -------------------------------------------------------
# Stated explicitly rather than assumed: a 20/20 green that never reached the
# series-1 conditions is weak evidence, and the summary has to say so.
#
# Two independent signals, reported separately rather than conflated:
#   * burner count — ground truth for how much load this job ASKED for;
#   * observed load0 — what the host actually experienced, but host-wide and
#     therefore not attributable to this job on its own.
# The verdict still tests observed load against TARGET_LOAD_PER_CORE; the
# attribution line says whether that observation is plausibly ours.
verdict="$(
  printf '%s\n' "${LOADS[@]}" | paste -d' ' - <(printf '%s\n' "${DURS[@]}") | awk \
    -v n="$NPROC" -v target="$TARGET_LOAD_PER_CORE" -v base="$BASELINE_DUR_S" \
    -v workers="$WORKERS" -v baseload="$BASELINE_LOAD" '
    {
      l = $1; d = $2;
      lsum += l; dsum += d;
      if (NR == 1 || l < lmin) lmin = l;
      if (NR == 1 || l > lmax) lmax = l;
      if (NR == 1 || d > dmax) dmax = d;
      if (l / n >= target) at_or_above += 1;
      delta = l - baseload;
      dlsum += delta;
      if (NR == 1 || delta < dlmin) dlmin = delta;
      if (NR == 1 || delta > dlmax) dlmax = delta;
    }
    END {
      lmean = lsum / NR; dmean = dsum / NR; dlmean = dlsum / NR;
      printf "load0 min=%.2f mean=%.2f max=%.2f | per-core min=%.3f mean=%.3f max=%.3f (nproc=%d)\n",
        lmin, lmean, lmax, lmin / n, lmean / n, lmax / n, n;
      printf "load0 delta vs pre-burner baseline %.2f: min=%+.2f mean=%+.2f max=%+.2f\n",
        baseload, dlmin, dlmean, dlmax;
      printf "duration mean=%ds max=%ds vs series-1 idle baseline ~%ss (%.2fx mean)\n",
        dmean, dmax, base, dmean / base;
      if (workers > 0)
        printf "synthetic load requested: %d burner(s) = %.3f load/core on %d cores (ground truth for what this job asked for)\n",
          workers, workers / n, n;
      else
        print "synthetic load requested: none (LOAD_WORKERS=off) — any load below is the host'\''s, not this job'\''s.";
      printf "iterations at or above the series-1 failure ratio (%.3f load/core): %d/%d\n",
        target, at_or_above, NR;

      if (workers == 0) {
        if (lmean / n >= target) {
          attributed = 0;
          print "LOAD ATTRIBUTION: this job held NO synthetic load, yet observed load0 sits at or above the target — that load is a neighbour'\''s. /proc/loadavg is host-wide, so this regime is NOT attributable to this job.";
        } else {
          attributed = 1;
          print "LOAD ATTRIBUTION: no synthetic load requested and none observed; this was an idle-regime run.";
        }
      } else if (dlmean >= workers * 0.5) {
        attributed = 1;
        printf "LOAD ATTRIBUTION: mean load0 delta (%+.2f) is consistent with the %d burner(s) this job started.\n",
          dlmean, workers;
      } else {
        attributed = 0;
        printf "LOAD ATTRIBUTION: mean load0 delta (%+.2f) is well below the %d burner(s) started — suspect a CFS quota (see cpu_max in the header; nproc reflects a cpuset, not a quota) or burners starved by vitest. Treat the per-core figures with caution.\n",
          dlmean, workers;
      }

      # The REGIME line is the headline someone greps for, so it has to carry
      # the attribution caveat itself rather than relying on the reader also
      # taking in the line above it.
      caveat = attributed ? "" : " NOTE: see LOAD ATTRIBUTION — this reading is not attributable to load this job produced, so it is incidental and may not recur.";
      if (at_or_above == NR)
        printf "REGIME: REACHED for every iteration.%s\n", caveat;
      else if (at_or_above > 0)
        printf "REGIME: PARTIALLY reached (%d of %d iterations) — read the delta and attribution lines before concluding the load was absent.%s\n", at_or_above, NR, caveat;
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

#!/usr/bin/env bash
# Cancel merge_group workflow runs whose queue branch no longer exists (BLO-41174).
#
# When the merge queue re-forms -- master moves, or an entry is removed -- GitHub
# deletes the old `gh-readonly-queue/master/pr-N-<sha>` ref but the `pr.yml` run
# built for it keeps going. `pr.yml`'s concurrency key is per-`head_ref`, which is
# unique per generation, so the successor never shares a group with the run it
# supersedes and nothing cancels the dead one. Each re-formation therefore strands
# a full heavy build on `arc-merge-queue`, a 12-runner FIFO pool, ahead of the live
# head. Measured 2026-10-07: 17 orphans against 2 live runs, all 12 runners on
# orphan jobs, `MergeQueueHeadStarvedPoolNotSaturated` firing (BLO-33021).
#
# This is option 1 from BLO-41174 -- the manual mitigation, automated. Options 2
# (early-exit guard in each heavy lane) and 3 (shared concurrency key) were
# rejected on that row: 2 still burns a runner slot per orphan job as it starts,
# and 3 needs a PR number that `merge_group` does not carry and would cancel a
# legitimate second build once `max_entries_to_build > 1`.
#
# SAFETY PROPERTY -- the whole point of this script. Liveness is re-resolved PER
# RUN, immediately before that run's cancel, never from the listing pass. A new
# group can form between the list and the cancel, and a sweeper trusting a stale
# list would cancel a live build. That failure is worse than the defect it fixes.
#
# It therefore FAILS CLOSED: only an explicit HTTP 404 on the ref counts as gone.
# A 403, a rate-limit, a network error or any other failure leaves the run alone.
# `gh api` exits non-zero for all of them alike, so the exit code is not a
# sufficient discriminator -- `classify_ref_probe` is, and is self-tested below.
#
# Every cancel is logged with the run id and the branch that was missing, so this
# canceller is attributable. BLO-35314 is an open, unexplained recurring mass
# cancellation of queued runs in `onprem-k8s`; different repo, but an unlogged
# canceller in this org would be indistinguishable from it.

set -uo pipefail

QUEUE_PREFIX="gh-readonly-queue/master/"

# (rc, stderr) -> alive | gone | unknown. The only decision in this script.
classify_ref_probe() {
  local rc="$1" err="$2"
  if [ "$rc" -eq 0 ]; then echo alive; return; fi
  case "$err" in
    *"(HTTP 404)"*) echo gone ;;
    *) echo unknown ;;
  esac
}

if [ "${SELF_TEST:-}" = "1" ]; then
  fail=0
  check() {
    local got; got="$(classify_ref_probe "$2" "$3")"
    [ "$got" = "$1" ] || { echo "FAIL: $4 -> $got (want $1)"; fail=1; }
  }
  check alive   0 ""                                  "exit 0 is a live ref"
  check gone    1 "gh: Not Found (HTTP 404)"           "404 is a deleted ref"
  # Everything below MUST NOT be read as 'gone' -- that is the cancel-a-live-build bug.
  check unknown 1 "gh: Forbidden (HTTP 403)"           "403 is not evidence of deletion"
  check unknown 1 "gh: API rate limit exceeded (HTTP 429)" "rate limit is not evidence of deletion"
  check unknown 1 "dial tcp: i/o timeout"              "network failure is not evidence of deletion"
  check unknown 1 ""                                   "non-zero with no message is unknown"
  check unknown 1 "gh: Server Error (HTTP 500)"        "5xx is not evidence of deletion"
  [ "$fail" -eq 0 ] && echo "classify_ref_probe: ok"
  exit "$fail"
fi

R="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

runs="$(gh api "repos/$R/actions/runs?event=merge_group&per_page=100" --paginate \
          --jq '.workflow_runs[]|select(.status!="completed")|[.id,.head_branch]|@tsv')" || {
  echo "::error::could not list merge_group runs for $R"
  exit 1
}

cancelled=0
while IFS=$'\t' read -r id branch; do
  [ -n "${id:-}" ] || continue
  case "$branch" in
    "$QUEUE_PREFIX"*) ;;
    *) echo "::notice::run $id: head_branch '$branch' is outside $QUEUE_PREFIX, leaving alone"; continue ;;
  esac

  err="$(gh api "repos/$R/git/ref/heads/$branch" 2>&1 >/dev/null)"; rc=$?
  case "$(classify_ref_probe "$rc" "$err")" in
    alive) continue ;;
    unknown)
      echo "::warning::run $id: liveness probe for '$branch' failed, NOT cancelling: ${err:-exit $rc}"
      continue ;;
  esac

  if gh api -X POST "repos/$R/actions/runs/$id/cancel" --silent; then
    echo "::notice::cancelled orphaned merge_group run $id -- branch '$branch' no longer exists"
    cancelled=$((cancelled + 1))
  else
    echo "::warning::run $id: cancel failed (already finishing, or missing actions:write)"
  fi
done <<< "$runs"

echo "swept $R: cancelled $cancelled orphaned merge_group run(s)"

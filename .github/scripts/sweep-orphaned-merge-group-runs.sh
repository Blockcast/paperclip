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
# sufficient discriminator -- `classify_ref_probe` is, and is tested by
# `.github/scripts/tests/sweep-orphaned-merge-group-runs.test.mjs`.
#
# SECOND CANCEL REASON -- a DECIDED run (BLO-51600). `pr.yml`'s matrix fail-fast
# (BLO-33021) only cancels siblings INSIDE `general_tests`; a failure in any other
# job (`e2e`, `build`, ...) leaves the server shards running to completion, and
# the queue cannot evict the entry until the run completes. Latency is one sweep
# interval (10m) rather than seconds, deliberately: an in-run canceller would be
# a new merge_group check, i.e. a new ALLGREEN ejection path (see the workflow
# header), or a per-job `actions: write` grant on every heavy lane. Measured
# 2026-11-03 on run 41685616129: `e2e` failed 18:27Z and two server shards were
# still running 40+ min later with the queue ref alive. Only a failed job that
# `verify` aggregates decides the run: `e2e` and `Canary Dry Run` are outside
# `verify.needs`, and that same run merged with `e2e` red. So only GATING_JOBS
# count -- `verify`'s own `lane_job_names`, plus `policy` (its failure skips
# every lane, which `verify` reads as red) and `ally-verdict`. The test pins
# this list to `pr.yml`. Scoped to `pr.yml`; it has no job-level
# `continue-on-error`.
# The gate cannot soften: a cancelled run's `verify` reads `cancelled`, never
# `success` (runs 41684074606, 41676078687). Same fail-closed rule: if the jobs
# read fails, the run is left alone.
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

# Jobs whose failure reds `verify` in pr.yml. "General tests" covers its matrix
# legs ("General tests (server 1/6)"). Kept in sync by the test.
GATING_JOBS=(
  "Helm chart"
  "Typecheck + Release Registry"
  "General tests"
  "Worktree install (NODE_ENV=production)"
  "OpenCode Responses replay"
  "k8s-ro seed transport cold start"
  "Build"
  "Vendored claude_k8s adapter"
  "Vendored opencode_k8s adapter"
  "policy"
  "ally-verdict"
)

# stdin: "<conclusion>\t<name>" per job. Prints the names of gating jobs whose
# conclusion already decides the run red; empty output = not decided.
decided_failed_jobs() {
  local conclusion name g
  while IFS=$'\t' read -r conclusion name; do
    case "$conclusion" in failure|timed_out) ;; *) continue ;; esac
    for g in "${GATING_JOBS[@]}"; do
      if [ "$name" = "$g" ] || [[ "$name" == "$g ("* ]]; then echo "$name"; break; fi
    done
  done
}

main() {
R="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

runs="$(gh api "repos/$R/actions/runs?event=merge_group&per_page=100" \
          --jq '.workflow_runs[]|select(.status!="completed")|[.id,.head_branch,.path]|@tsv')" || {
  echo "::error::could not list merge_group runs for $R"
  exit 1
}

cancelled=0
while IFS=$'\t' read -r id branch path; do
  [ -n "${id:-}" ] || continue
  case "$branch" in
    "$QUEUE_PREFIX"*) ;;
    *) echo "::notice::run $id: head_branch '$branch' is outside $QUEUE_PREFIX, leaving alone"; continue ;;
  esac

  err="$(gh api "repos/$R/git/ref/heads/$branch" 2>&1 >/dev/null </dev/null)"; rc=$?
  reason="branch '$branch' no longer exists"
  case "$(classify_ref_probe "$rc" "$err")" in
    alive)
      [ "$path" = ".github/workflows/pr.yml" ] || continue
      jobs="$(gh api "repos/$R/actions/runs/$id/jobs?per_page=100" \
                --jq '.jobs[]|[.conclusion // "",.name]|@tsv' 2>&1 </dev/null)" || {
        echo "::warning::run $id: jobs read failed, NOT cancelling: $jobs"
        continue
      }
      failed="$(decided_failed_jobs <<< "$jobs" | paste -sd, -)"
      [ -n "$failed" ] || continue
      reason="already decided red by failed job(s): $failed" ;;
    unknown)
      echo "::warning::run $id: liveness probe for '$branch' failed, NOT cancelling: ${err:-exit $rc}"
      continue ;;
  esac

  if gh api -X POST "repos/$R/actions/runs/$id/cancel" --silent </dev/null; then
    echo "::notice::cancelled merge_group run $id ($branch) -- $reason"
    cancelled=$((cancelled + 1))
  else
    echo "::warning::run $id: cancel failed (already finishing, or missing actions:write)"
  fi
done <<< "$runs"

echo "swept $R: cancelled $cancelled orphaned or decided merge_group run(s)"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi

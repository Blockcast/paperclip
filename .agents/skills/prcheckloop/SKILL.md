---
name: prcheckloop
description: >
  Iterate on a GitHub PR until latest-head checks are green or a precise blocker
  is named. Use when a PR still has failing or pending checks after review fixes,
  including after greploop.
---

# PRCheckloop

Get a GitHub PR to a fully green check state, or exit with a concrete blocker.

## Scope

- GitHub PRs only. If the repo is GitLab, stop and use `check-pr`.
- Focus on checks for the latest PR head SHA, not old commits.
- Focus on CI/status checks, not review comments or PR template cleanup.
- If the user also wants review-comment cleanup, pair this with `check-pr`.

## Inputs

- **PR number** (optional): If not provided, detect the PR for the current branch.
- **Max iterations**: default `5`.

## Workflow

### 1. Identify the PR

If no PR number is provided, detect it from the current branch:

```bash
gh pr view --json number,headRefName,headRefOid,url,isDraft
```

If needed, switch to the PR branch before making changes.

Stop early if:

- `gh` is not authenticated
- there is no PR for the branch
- the repo is not hosted on GitHub

### 2. Track the latest head SHA

Always work against the current PR head SHA:

```bash
PR_JSON=$(gh pr view "$PR_NUMBER" --json number,headRefName,headRefOid,url)
HEAD_SHA=$(echo "$PR_JSON" | jq -r .headRefOid)
PR_URL=$(echo "$PR_JSON" | jq -r .url)
```

Ignore failing checks from older SHAs. After every push, refresh `HEAD_SHA` and
restart the inspection loop.

### 3. Inventory checks for that SHA

Fetch both GitHub check runs and legacy commit status contexts:

```bash
gh api "repos/{owner}/{repo}/commits/$HEAD_SHA/check-runs?per_page=100"
gh api "repos/{owner}/{repo}/commits/$HEAD_SHA/status"
```

For a compact PR-level view, this GraphQL payload is useful:

```bash
gh api graphql -f query='
query($owner:String!, $repo:String!, $pr:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$pr) {
      headRefOid
      url
      statusCheckRollup {
        contexts(first:100) {
          nodes {
            __typename
            ... on CheckRun { name status conclusion detailsUrl workflowName }
            ... on StatusContext { context state targetUrl description }
          }
        }
      }
    }
  }
}' -F owner=OWNER -F repo=REPO -F pr="$PR_NUMBER"
```

### 4. Wait for checks to actually run

After a new push, checks can take a moment to appear. Never use an unbounded
`gh pr checks --watch`. Poll the API with a hard deadline (default 15 minutes)
and a minimum interval of one minute. Re-read PR state on every iteration and
stop immediately when the PR is merged or closed, because a repo that parks a
legacy commit status as a lease (see `check-pr`) never lets the rollup settle.

**Run the block below as a single `bash` invocation.** It bounds itself on
wall-clock time from `date`; a block split across several tool calls restarts its
own loop each time and never reaches its deadline.

Exit codes match the `check-pr` skill: 0 all terminal and green, 1 at least one
failure, 2 invalid configuration, 3 merged, 4 closed unmerged, 5 no checks ever
appeared, 124 deadline exceeded with checks still pending.

```bash
CHECK_DEADLINE_SEC=${CHECK_DEADLINE_SEC:-900}
CHECK_INTERVAL_SEC=${CHECK_INTERVAL_SEC:-60}
# How long to wait for checks to appear at all before declaring none exist.
# Distinct from CHECK_DEADLINE_SEC: "CI never started" and "CI is slow" are
# different answers and want different exit codes.
NO_CHECKS_DEADLINE_SEC=${NO_CHECKS_DEADLINE_SEC:-180}
for var in CHECK_DEADLINE_SEC CHECK_INTERVAL_SEC NO_CHECKS_DEADLINE_SEC; do
  if [[ ! ${!var} =~ ^[0-9]+$ ]]; then
    printf '%s must be a non-negative integer (got %q).\n' "$var" "${!var}" >&2
    exit 2
  fi
done
(( CHECK_INTERVAL_SEC < 60 )) && CHECK_INTERVAL_SEC=60

# Per-invocation temp files. A fixed /tmp path is shared by every concurrent
# run on the host, so two agents polling different PRs would classify each
# other's results.
workdir=$(mktemp -d) || { printf 'mktemp -d failed.\n' >&2; exit 2; }
trap 'rm -rf "$workdir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

poll_started=$(date +%s)
while :; do
  # --repo is required: without it gh resolves the PR from the current
  # directory's git remote, which can be a different repository than
  # $OWNER_REPO used two lines below.
  PR_STATE=$(gh pr view "$PR_NUMBER" --repo "$OWNER_REPO" \
    --json state,mergedAt --jq '.state + " " + (.mergedAt // "")') || {
      printf 'Could not read PR state for %s#%s.\n' "$OWNER_REPO" "$PR_NUMBER" >&2
      exit 1
    }
  case "$PR_STATE" in
    MERGED*) printf 'PR is merged; nothing to wait for.\n'; exit 3 ;;
    CLOSED*) printf 'PR was closed without merging; nothing to wait for.\n'; exit 4 ;;
  esac

  # Re-read the head EVERY iteration. A SHA captured once goes stale the moment
  # anyone pushes, and then this loop keeps querying the OLD commit — whose
  # checks are already terminal — and reports it green while claiming to have
  # inspected the latest head. That is the same fail-open the rest of this
  # block exists to remove, just sourced from the URL instead of the
  # classifier. Restart the clock on a change: the new head's checks have not
  # had the deadline yet, and inheriting the old one would time out a PR that
  # was pushed to a minute ago.
  CURRENT_SHA=$(gh pr view "$PR_NUMBER" --repo "$OWNER_REPO" --json headRefOid \
    --jq .headRefOid) || {
      printf 'Could not read the current head SHA.\n' >&2
      exit 1
    }
  if [[ $CURRENT_SHA != "$HEAD_SHA" ]]; then
    printf 'Head moved %s -> %s; restarting the wait on the new commit.\n' \
      "${HEAD_SHA:0:9}" "${CURRENT_SHA:0:9}"
    HEAD_SHA=$CURRENT_SHA
    poll_started=$(date +%s)
  fi

  # Inventory current-head checks and statuses; do not leave a watcher behind.
  # Check both exits: on a 403 secondary rate limit the redirect truncates the
  # file and gh writes the error to stderr, leaving an empty array. An empty
  # array satisfies "every item is terminal" vacuously, so an API failure
  # would otherwise be classified as GREEN.
  gh api "repos/$OWNER_REPO/commits/$HEAD_SHA/check-runs?per_page=100" \
    >"$workdir/check-runs.json" || {
      printf 'check-runs query failed; not treating that as "no checks".\n' >&2
      exit 1
    }
  gh api "repos/$OWNER_REPO/commits/$HEAD_SHA/status" \
    >"$workdir/commit-status.json" || {
      printf 'commit-status query failed; not treating that as "no checks".\n' >&2
      exit 1
    }

  # Classification, per the tables below. Counted here rather than described,
  # so the loop has a success exit and not just a deadline.
  #
  # Every state is enumerated on ALL THREE sides and anything left over lands
  # in `unknown`, which is fatal. Counting only known failures would leave an
  # unrecognized value in neither `pending` nor `failed`, and "not pending and
  # not failed" is the green path — so a conclusion GitHub adds after this was
  # written would be reported as SUCCESS. Fail closed on what you do not
  # recognize; the message names the values so "this script is out of date" is
  # distinguishable from "CI is red".
  read -r total pending failed unknown unknown_values < <(jq -rn \
    --slurpfile runs "$workdir/check-runs.json" \
    --slurpfile status "$workdir/commit-status.json" '
      ["success","neutral","skipped"] as $run_ok
      | ["failure","timed_out","cancelled","action_required","startup_failure","stale"] as $run_bad
      | ($runs[0].check_runs // []) as $r
      | ($status[0].statuses // []) as $s
      | [ $r[] | select(.status == "completed") | .conclusion // "" ] as $done
      | [ $r[] | select(.status != "completed") | .status ] as $running
      | [ $s[] | .state // "" ] as $ctx
      | ( [ $running[] | select(. != "queued" and . != "in_progress" and . != "waiting"
              and . != "requested" and . != "pending") ]
          + [ $done[] | select(IN($run_ok[]) or IN($run_bad[]) | not) ]
          + [ $ctx[] | select(. != "pending" and . != "success"
              and . != "failure" and . != "error") ] ) as $weird
      | [ ($r | length) + ($s | length),
          ($running | length) + ([ $ctx[] | select(. == "pending") ] | length),
          ([ $done[] | select(IN($run_bad[])) ] | length)
            + ([ $ctx[] | select(. == "failure" or . == "error") ] | length),
          ($weird | length),
          (($weird | unique | join(",")) // "")
        ] | @tsv') || { printf 'Could not classify check results.\n' >&2; exit 1; }

  elapsed=$(( $(date +%s) - poll_started ))

  if (( total == 0 )); then
    if (( elapsed >= NO_CHECKS_DEADLINE_SEC )); then
      printf 'No checks appeared for %s after %ss.\n' "$HEAD_SHA" "$elapsed" >&2
      exit 5
    fi
  elif (( failed > 0 )); then
    printf '%s check(s) failed on %s.\n' "$failed" "$HEAD_SHA" >&2
    exit 1
  elif (( unknown > 0 )); then
    # Never poll on an unrecognized state: it is terminal for all we know, so
    # waiting would just burn the deadline and then report a timeout.
    printf '%s check(s) on %s report state(s) this script does not recognize: %s\n' \
      "$unknown" "$HEAD_SHA" "$unknown_values" >&2
    exit 1
  elif (( pending == 0 )); then
    printf 'All %s check(s) terminal and green on %s.\n' "$total" "$HEAD_SHA"
    break
  fi

  if (( elapsed >= CHECK_DEADLINE_SEC )); then
    printf 'Timed out waiting for checks after %ss (%s pending).\n' \
      "$CHECK_DEADLINE_SEC" "$pending" >&2
    exit 124
  fi
  sleep "$CHECK_INTERVAL_SEC"
done
```

The loop above classifies against these tables. Keep them and the `jq` filter in
sync — the filter is the executable form of exactly this list.

Treat these as terminal success states:

- check runs: `SUCCESS`, `NEUTRAL`, `SKIPPED`
- status contexts: `SUCCESS`

Treat these as pending:

- check runs: `QUEUED`, `PENDING`, `WAITING`, `REQUESTED`, `IN_PROGRESS`
- status contexts: `PENDING`

Treat these as failures:

- check runs: `FAILURE`, `TIMED_OUT`, `CANCELLED`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, `STALE`
- status contexts: `FAILURE`, `ERROR`

These three lists are exhaustive as of writing, so **anything not on them is
fatal** (exit 1, with the unrecognized value named). That is not pedantry: an
unrecognized state left out of both the pending and the failure count is
neither, and "not pending and not failed" is the green path — so a conclusion
GitHub adds later would be reported as SUCCESS by the one script whose job is
to not do that. Polling on it instead is no better; an unknown state may well
be terminal, so waiting just burns the deadline to report a timeout. If you
see this fire, add the new value to the list above AND to the `jq` filter.

If no checks appear for the latest SHA (exit 5), inspect `.github/workflows/`,
workflow path filters, and branch protection expectations. If the missing check
cannot be caused or fixed from the repo, escalate.

### 5. Investigate failing checks

For GitHub Actions failures, inspect runs and failed logs for the current SHA:

```bash
gh run list --commit "$HEAD_SHA" --json databaseId,workflowName,status,conclusion,url,headSha
gh run view <RUN_ID> --json databaseId,name,workflowName,status,conclusion,jobs,url,headSha
gh run view <RUN_ID> --log-failed
```

For each failing check, classify it:

| Failure type | Action |
|---|---|
| Code/test regression | Reproduce locally, fix, and verify |
| Lint/type/build mismatch | Run the matching local command from the workflow and fix it |
| Flake or transient infra issue | Rerun once if evidence supports flakiness |
| External service/status app failure | Escalate with the details URL and owner guess |
| Missing secret/permission/branch protection issue | Escalate immediately |

Only rerun a failed job once without code changes. Do not loop on reruns.

### 6. Fix actionable failures

If the failure is actionable from the checked-out code:

1. Read the workflow or failing command to identify the real gate.
2. Reproduce locally where reasonable.
3. Make the smallest correct fix.
4. Run focused verification first, then broader verification if needed.
5. Commit in a logical commit.
6. Push before re-checking the PR.

Do not stop at a local fix. The loop is only complete when the remote PR checks
for the new head SHA are green.

### 7. Push and repeat

After each fix:

```bash
git push
sleep 5
```

Then refresh the PR metadata, get the new `HEAD_SHA`, and restart from Step 3.

Exit the loop only when:

- all checks for the latest head SHA are green, or
- a blocker remains after reasonable repair effort, or
- the max iteration count is reached

### 8. Escalate blockers precisely

If you cannot get the PR green, report:

- PR URL
- latest head SHA
- exact failing or missing check names
- details URLs
- what you already tried
- why it is blocked
- who should likely unblock it
- the next concrete action

Good blocker examples:

- external status app outage
- missing GitHub secret or permission
- required check name mismatch in branch protection
- persistent flake after one rerun
- failure needs credentials or infrastructure access you do not have

## Output

When the skill completes, report:

- PR URL and branch
- final head SHA
- green/pending/failing check summary
- fixes made and verification run
- whether changes were pushed
- blocker summary if not fully green

## Notes

- This skill is intentionally narrower than `check-pr`: it is a repair loop for
  PR checks.
- This skill complements `greploop`: Greptile can be perfect while CI is still
  red.

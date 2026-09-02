---
name: check-pr
description: >
  Check a GitHub, GitLab, or Perforce PR/MR/CL for review comments, failing
  checks, and PR-body gaps. Use when asked to inspect, fix, or prepare a change
  for submission.
license: MIT
compatibility: Requires git and gh (GitHub CLI), glab (GitLab CLI), or p4 (Perforce CLI) installed and authenticated.
metadata:
  author: greptileai
  version: "1.3"
allowed-tools: Bash(gh:*) Bash(glab:*) Bash(git:*) Bash(p4:*)
---

# Check PR

Analyze a pull request (GitHub), merge request (GitLab), or shelved changelist (Perforce) for review comments, status checks, and description completeness, then help address any issues found.

## Inputs

- **PR/MR/CL number** (optional): If not provided, detect the PR/MR for the current branch, or the default pending changelist for p4.

## Instructions

### 0. Detect platform

First check if the user is working in a Perforce depot by looking for a `.p4config` file or `P4CLIENT`/`P4PORT` environment variables:

```bash
# Check for Perforce environment
if p4 info >/dev/null 2>&1; then
  VCS="perforce"
else
  # Fall back to git remote detection
  REMOTE_URL=$(git remote get-url origin)
  if echo "$REMOTE_URL" | grep -qi "gitlab"; then
    VCS="gitlab"
  else
    VCS="github"
  fi
fi
```

For self-hosted GitLab instances whose hostname doesn't contain "gitlab", the user can override by passing `--vcs gitlab` as an input. For Perforce, the user can override by passing `--vcs perforce`.

### 1. Identify the PR/MR/CL

If a number was provided, use it. Otherwise, detect it:

**GitHub:**
```bash
gh pr view --json number,headRefName,headRefOid -q '{number: .number, branch: .headRefName, head: .headRefOid}'
```

**GitLab:**
```bash
glab mr view --output json | jq '.iid'
```

**Perforce:**
```bash
# List pending changelists for the current user/client
p4 changes -s pending -u $P4USER -c $P4CLIENT
```

Key field differences between platforms:
- GitHub: `number`, `headRefName`, `headRefOid`
- GitLab: `iid`, `source_branch`, `sha`
- Perforce: changelist number (CL), `shelved` files for in-review CLs

### 2. Fetch PR/MR/CL details

**GitHub:**
```bash
gh pr view <PR_NUMBER> --json title,body,state,reviews,comments,headRefName,headRefOid,statusCheckRollup
OWNER_REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api "repos/$OWNER_REPO/pulls/<PR_NUMBER>/comments"
gh api --paginate "repos/$OWNER_REPO/issues/<PR_NUMBER>/comments?per_page=100"
```

GitHub PRs are also issues, so general PR comments live on the issue comments endpoint. Greptile may edit a single general PR comment on each review cycle instead of creating a new review or comment. Always inspect the latest Greptile-authored general comment by `updated_at`, including any "Prompt to fix all with AI" section, before concluding that the PR is clear.

**GitLab:**
```bash
glab mr view <MR_IID> --output json
# Fetch discussions (inline diff comments are type "DiffNote"; general comments have null type)
glab api "projects/:fullpath/merge_requests/<MR_IID>/discussions"
```

For GitLab, paginate discussions if needed (add `?per_page=100&page=N`).

**Perforce:**
```bash
# Get changelist description, files, and status
p4 describe -s <CL_NUMBER>

# Get shelved files (for in-review CLs)
p4 describe -S <CL_NUMBER>

# Get the diff of the shelved changelist
p4 diff2 //...@=<CL_NUMBER> //...@=<CL_NUMBER>

# List review comments (if using p4 review workflow)
p4 review -c <CL_NUMBER>
```

Key Perforce CL fields:
- `Change`: changelist number
- `Status`: `pending`, `submitted`, `shelved`
- `Description`: the CL description / commit message
- `Files`: list of files in the CL

### 3. Wait for pending checks

Never start an unbounded `gh pr checks --watch` process. Before polling a GitHub
PR, read its lifecycle state and return immediately for merged or closed PRs:
there is no useful check transition left to await, and a repo that parks a
*legacy commit status* as a lease will never let the rollup settle. (Concretely:
`Blockcast/onprem-k8s` posts `review/ally-worker-owner` only ever as `pending`,
because `worker_ownership_is_current` treats any terminal state as "lease lost".
`gh pr checks --watch` on a merged PR there polls forever —
`timeout 30 gh pr checks 2831 -R Blockcast/onprem-k8s --watch` exits 124.)

For an open PR, use a bounded loop with a minimum interval of one minute and a
deadline appropriate to the caller (the default below is 15 minutes).

**Run the block below as a single `bash` invocation** — `bash script.sh`, or one
tool call containing the whole block. It bounds itself on wall-clock time read
from `date`, but its `trap`s and its loop state exist only within one shell; a
block split across several invocations re-enters the loop from the top each time
and never reaches its own deadline.

Exit codes are distinct so a caller can act on `$?` without re-parsing output:

| Code | Meaning |
|---|---|
| 0 | every check reached a terminal state and all passed |
| 1 | at least one check failed, or the repo reports no checks at all |
| 2 | invalid configuration (non-numeric deadline/interval, `mktemp` failed) |
| 3 | PR is already merged — nothing to wait for |
| 4 | PR was closed without merging — nothing to wait for |
| 124 | deadline exceeded with checks still pending |

```bash
CHECK_DEADLINE_SEC=${CHECK_DEADLINE_SEC:-900}
CHECK_INTERVAL_SEC=${CHECK_INTERVAL_SEC:-60}
# Validate before arithmetic: $(( )) evaluates array subscripts, so an
# unvalidated value is a command-execution vector as well as a silent zero.
for var in CHECK_DEADLINE_SEC CHECK_INTERVAL_SEC; do
  if [[ ! ${!var} =~ ^[0-9]+$ ]]; then
    printf '%s must be a non-negative integer (got %q).\n' "$var" "${!var}" >&2
    exit 2
  fi
done
(( CHECK_INTERVAL_SEC < 60 )) && CHECK_INTERVAL_SEC=60

# Reads PR lifecycle state into $pr_state. Returns non-zero if gh itself
# failed, so a 404 or an expired token is never mistaken for "still open".
read_pr_state() {
  pr_state=$(gh pr view "$PR_NUMBER" --repo "$OWNER_REPO" \
    --json state,mergedAt --jq '.state + " " + (.mergedAt // "")') || return 1
  [[ -n $pr_state ]]
}

# Maps a settled PR to its own exit code. Callers must be able to tell
# "green, proceed" from "this PR was thrown away".
exit_if_settled() {
  case "$pr_state" in
    MERGED*) printf 'PR is merged; nothing to wait for.\n'; exit 3 ;;
    CLOSED*) printf 'PR was closed without merging; nothing to wait for.\n'; exit 4 ;;
  esac
}

if ! read_pr_state; then
  printf 'Could not read PR state for %s#%s.\n' "$OWNER_REPO" "$PR_NUMBER" >&2
  exit 1
fi
exit_if_settled

checks_output=$(mktemp) || { printf 'mktemp failed.\n' >&2; exit 2; }
watch_pid=''
# ONE EXIT trap. `trap` replaces rather than appends, so a second
# `trap ... EXIT` anywhere below would silently drop this cleanup.
cleanup() {
  if [[ -n $watch_pid ]] && kill -0 "$watch_pid" 2>/dev/null; then
    kill "$watch_pid" 2>/dev/null || true
    wait "$watch_pid" 2>/dev/null || true
  fi
  rm -f "$checks_output"
}
trap cleanup EXIT
# These must *exit*, not just clean up: bash resumes execution after a
# non-default signal handler returns, so a handler that only removes the
# temp file leaves the loop running and recreates it on the next pass.
trap 'exit 130' INT
trap 'exit 143' TERM

watch_started=$(date +%s)
while :; do
  # A fresh state read prevents a watch from surviving a merge/close race.
  if ! read_pr_state; then
    printf 'Lost PR state for %s#%s while polling.\n' "$OWNER_REPO" "$PR_NUMBER" >&2
    exit 1
  fi
  exit_if_settled

  # Read the status directly, NOT through a pipe: in a pipeline $? is the
  # last command's status. gh pr checks exits 0 only when every check
  # PASSED, 8 while any are pending, and 1 both when a check failed and
  # when the repo reports no checks at all. Collapsing non-zero into
  # "still pending" makes a red PR poll to the deadline and report a
  # timeout it already knew the answer to.
  gh pr checks "$PR_NUMBER" --repo "$OWNER_REPO" >"$checks_output" 2>"$checks_output.err"
  rc=$?
  cat "$checks_output"
  case $rc in
    0)
      break
      ;;
    8)
      : # genuinely pending — fall through to the deadline check
      ;;
    *)
      # `gh` prints "no checks reported on the '<branch>' branch" to stderr
      # and leaves stdout empty, so surface stderr or the failure is silent.
      cat "$checks_output.err" >&2
      printf 'Checks are failing or unavailable (gh exit %s).\n' "$rc" >&2
      rm -f "$checks_output.err"
      exit 1
      ;;
  esac
  rm -f "$checks_output.err"

  if (( $(date +%s) - watch_started >= CHECK_DEADLINE_SEC )); then
    printf 'Timed out waiting for checks after %ss.\n' "$CHECK_DEADLINE_SEC" >&2
    exit 124
  fi
  sleep "$CHECK_INTERVAL_SEC"
done
```

If you start a child process for a longer-running equivalent, capture its PID
with `$!` **in the same shell** and reuse the `cleanup` trap above — a PID read
from `$(...)` or from the end of a pipeline is not the process you need to reap:

```bash
gh pr checks "$PR_NUMBER" --repo "$OWNER_REPO" --watch --interval 60 & watch_pid=$!
wait "$watch_pid"
```

`cleanup` already terminates `$watch_pid` on normal exit and on INT/TERM, so do
not install a second `trap ... EXIT` for it.

**GitHub:** poll `statusCheckRollup` from `gh pr view`.

**GitLab:**
```bash
glab api "projects/:fullpath/merge_requests/<MR_IID>/pipelines"
```
Pipeline statuses: `running`, `pending`, `success`, `failed`, `canceled`, `skipped`.

The same bound applies here — do not wait forever for a remote status provider.
Poll under the same deadline and one-minute interval floor as the GitHub loop,
and stop early when the MR itself settles (an MR closed with a stuck pipeline has
exactly the hazard the GitHub path guards against):

```bash
# $CHECK_DEADLINE_SEC / $CHECK_INTERVAL_SEC validated as above.
poll_started=$(date +%s)
while :; do
  mr_state=$(glab api "projects/:fullpath/merge_requests/$MR_IID" --jq .state) || {
    printf 'Could not read MR state.\n' >&2; exit 1; }
  case "$mr_state" in
    merged) printf 'MR is merged; nothing to wait for.\n'; exit 3 ;;
    closed) printf 'MR was closed without merging; nothing to wait for.\n'; exit 4 ;;
  esac

  statuses=$(glab api "projects/:fullpath/merge_requests/$MR_IID/pipelines" --jq '.[].status') || {
    printf 'Could not read pipeline statuses.\n' >&2; exit 1; }
  if ! grep -qE '^(running|pending)$' <<<"$statuses"; then
    grep -qE '^(failed|canceled)$' <<<"$statuses" && { printf '%s\n' "$statuses"; exit 1; }
    printf '%s\n' "$statuses"
    break
  fi

  if (( $(date +%s) - poll_started >= CHECK_DEADLINE_SEC )); then
    printf 'Timed out waiting for pipelines after %ss.\n' "$CHECK_DEADLINE_SEC" >&2
    exit 124
  fi
  sleep "$CHECK_INTERVAL_SEC"
done
```

**Perforce:** Perforce doesn't have built-in CI checks natively. If the team uses a review tool (Swarm, etc.) or an external CI triggered by shelve events, check the relevant system. Otherwise, proceed to analysis immediately.

### 4. Require a fresh Greptile review for the current head

For GitHub PRs, do not treat an existing Greptile review, comment, or summary as current unless it is tied to the PR's exact current `headRefOid`. This is especially important after pushing a new commit to an existing PR: a Greptile review on an older commit is stale, even if the PR still has a Greptile comment or prior review.

Fetch the current head SHA immediately before the Greptile gate:

```bash
HEAD_SHA=$(gh pr view <PR_NUMBER> --json headRefOid -q .headRefOid)
```

Then inspect check-runs for that commit and require a completed Greptile run:

```bash
OWNER_REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
GREPTILE_CHECKS=$(gh api "repos/$OWNER_REPO/commits/$HEAD_SHA/check-runs?per_page=100" \
  --jq '[.check_runs[] | select(.name | test("greptile"; "i"))]')

# A run only counts as a valid fresh pass when it has completed AND concluded cleanly.
# GitHub check-run conclusions: success, neutral, skipped, failure, timed_out,
# cancelled, action_required, stale. Treat success/neutral as clean;
# everything else (especially failure and action_required) must block.
FRESH_GREPTILE_COMPLETED=$(echo "$GREPTILE_CHECKS" \
  | jq '[.[] | select(.status == "completed")] | length')
FRESH_GREPTILE_CLEAN=$(echo "$GREPTILE_CHECKS" \
  | jq '[.[] | select(.status == "completed" and (.conclusion | IN("success","neutral")))] | length')
FRESH_GREPTILE_BLOCKING=$(echo "$GREPTILE_CHECKS" \
  | jq '[.[] | select(.status == "completed" and ((.conclusion | IN("success","neutral")) | not))] | length')

if [ "$FRESH_GREPTILE_COMPLETED" = "0" ]; then
  echo "Blocked: no completed Greptile review/check is tied to current PR head $HEAD_SHA."
  echo "Request a fresh Greptile review against this head before marking the PR check done."
  echo "Suggested trigger: gh pr comment <PR_NUMBER> --body \"@greptile review\""
  exit 1
fi

if [ "$FRESH_GREPTILE_BLOCKING" != "0" ] || [ "$FRESH_GREPTILE_CLEAN" = "0" ]; then
  echo "Blocked: Greptile completed on head $HEAD_SHA but did not conclude clean"
  echo "(conclusion was failure/action_required/timed_out/cancelled/stale, or no clean run exists)."
  echo "Address the findings, push, and re-run Greptile until it concludes success/clean on the new head."
  exit 1
fi
```

If a Greptile check exists for the current head but is still pending or in progress, wait for it with the same polling pattern used by `greploop` rather than proceeding from older review material. If no Greptile check appears for the current head after a reasonable wait, report the PR as blocked on a fresh Greptile review for `HEAD_SHA` and stop. Do not mark the check complete from PR comments, PR reviews, or Greptile summaries that cannot be associated with the current head SHA.

For GitLab installations with Greptile integration, apply the same freshness rule against the MR's current head SHA:

```bash
# 1. Get the MR's current head SHA
MR_SHA=$(glab mr view <MR_IID> --output json | jq -r '.sha // .diff_refs.head_sha')

# 2. Find the latest pipeline for that EXACT sha, then the Greptile job within it.
LATEST_PIPELINE_ID=$(glab api "projects/:fullpath/merge_requests/<MR_IID>/pipelines" \
  | jq -r --arg sha "$MR_SHA" '[.[] | select(.sha == $sha)] | sort_by(.id) | last | .id // empty')

if [ -n "$LATEST_PIPELINE_ID" ]; then
  GREPTILE_JOBS=$(glab api "projects/:fullpath/pipelines/$LATEST_PIPELINE_ID/jobs" \
    | jq --arg sha "$MR_SHA" '[.[] | select(.name | test("greptile"; "i"))
        | {name, status, pipeline_sha: $sha}]')
else
  GREPTILE_JOBS='[]'
fi

GREPTILE_JOB_SUCCESS=$(echo "$GREPTILE_JOBS" \
  | jq '[.[] | select(.status == "success")] | length')
GREPTILE_JOB_BLOCKING=$(echo "$GREPTILE_JOBS" \
  | jq '[.[] | select(.status != "success")] | length')

# 3. If Greptile integrates via MR notes instead of a CI job, require the newest
#    Greptile note to reference the current head sha and report a clean review.
GREPTILE_NOTES=$(glab api "projects/:fullpath/merge_requests/<MR_IID>/discussions?per_page=100" \
  | jq --arg sha "$MR_SHA" '[.[].notes[]
      | select(.author.username | test("greptile"; "i"))]
      | sort_by(.updated_at // .created_at)')
GREPTILE_NOTE_CLEAN=$(echo "$GREPTILE_NOTES" \
  | jq --arg sha "$MR_SHA" 'if length == 0 then 0
      elif ((last.body // "") | contains($sha) and test("Confidence Score:[[:space:]]*5/5|Confidence:[[:space:]]*5/5|\\b5/5\\b"; "i") and (test("Prompt To Fix|blocking issue|failed|action required"; "i") | not)) then 1
      else 0 end')

if [ "$GREPTILE_JOB_SUCCESS" = "0" ] && [ "$GREPTILE_NOTE_CLEAN" = "0" ]; then
  echo "Blocked: no successful Greptile job or completed-clean current-head Greptile note is tied to MR head $MR_SHA."
  exit 1
fi

if [ "$GREPTILE_JOB_BLOCKING" != "0" ]; then
  echo "Blocked: at least one Greptile job for MR head $MR_SHA did not succeed."
  exit 1
fi
```

Block completion if, for `MR_SHA`, there is (a) no Greptile job or note at all (missing), (b) the newest Greptile job/note is tied to a different sha (stale), or (c) the Greptile job status is not `success`. A completed Greptile result for a different SHA is stale and must block completion.

For Perforce installations with Greptile integration, apply the same rule using the CL's current shelved-revision identity and the Greptile webhook/review artifact tied to it; a Greptile result for an earlier shelf is stale and must block completion.

### 5. Analyze the PR/MR

Once all checks are complete, evaluate these areas:

#### A. Status Checks

- Are all CI checks passing?
- If any are failing, identify which ones and the failure reason.

#### B. PR/MR Description

- Is the description complete and follows team conventions?
- Are all required sections filled in?
- Are there TODOs or placeholders that need updating?

#### C. Review Comments

- Inline code review comments that need addressing
- Look for bot review comments (e.g. from `greptile-apps[bot]` on GitHub, or the Greptile bot user on GitLab, linters, etc.)
- Human reviewer comments
- **Perforce:** review comments from `p4 review` or external review tools

#### D. General Comments

- Discussion comments on the PR/MR
- For GitHub, check the issue comments endpoint and use `updated_at` to catch bot comments edited in place. Greptile's latest edited summary can contain actionable items even when there are no new inline comments.
- Bot comments (deploy previews, etc.) - usually informational
- **Perforce:** CL description should include a clear summary, affected files rationale, and testing notes

### 6. Categorize issues

For each issue found, categorize as:

| Category | Meaning |
|---|---|
| **Actionable** | Code changes, test improvements, or fixes needed |
| **Informational** | Verification notes, questions, or FYIs that don't require changes |
| **Already addressed** | Issues that appear to be resolved by subsequent commits |

### 7. Report findings

Present a summary table:

| Area | Issue | Status | Action Needed |
|------|-------|--------|---------------|
| Status Checks | CI build failing | Failing | Fix type error in `src/api.ts` |
| Review | "Add null check" - @reviewer | Actionable | Add guard clause |
| Description | TODO placeholder in test plan | Actionable | Fill in test plan |
| Review | "Looks good" - @teammate | Informational | None |

### 8. Fix issues (if requested)

If there are actionable items:

1. Switch to the PR/MR's branch (git) or ensure files are open in the correct CL (Perforce) if not already.
2. Ask the user if they want to fix the issues.
3. If yes, make the fixes, then:

**GitHub/GitLab:** commit and push:
```bash
git add <files>
git commit -m "address review feedback"
git push
```

**Perforce:** open files for edit, make changes, and re-shelve:
```bash
p4 edit <file>
# make changes
p4 shelve -f -c <CL_NUMBER>
```

### 9. Resolve review threads

After addressing comments, resolve the corresponding review threads.

**Perforce** - Perforce does not have a native "resolve thread" concept. Instead, mark comments as addressed by updating the CL description or by responding in the review tool being used (Swarm, etc.). If using `p4 review`:

```bash
# Mark files as reviewed after addressing feedback
p4 review -c <CL_NUMBER>
```

**GitHub** - fetch unresolved thread IDs (paginate if needed - see [the GraphQL reference](references/graphql-queries.md)):

```bash
gh api graphql -f query='
query($cursor: String) {
  repository(owner: "OWNER", name: "REPO") {
    pullRequest(number: PR_NUMBER) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { body path }
          }
        }
      }
    }
  }
}'
```

If `hasNextPage` is true, repeat with `-f cursor=ENDCURSOR` to get remaining threads.

Then resolve threads that have been addressed or are informational:

```bash
gh api graphql -f query='
mutation {
  resolveReviewThread(input: {threadId: "THREAD_ID"}) {
    thread { isResolved }
  }
}'
```

Batch multiple resolutions into a single mutation using aliases (`t1`, `t2`, etc.).

**GitLab** - fetch unresolved discussions (see [the GitLab API reference](references/gitlab-api.md)):

```bash
glab api "projects/:fullpath/merge_requests/<MR_IID>/discussions?per_page=100"
```

Filter for discussions where `"resolved": false`. Collect each discussion's `id`.

Resolve each discussion individually (GitLab has no batch resolution):

```bash
glab api --method PUT \
  "projects/:fullpath/merge_requests/<MR_IID>/discussions/<DISCUSSION_ID>" \
  --field resolved=true
```

Repeat for each unresolved discussion ID.

### 10. Multiple PRs/MRs/CLs

If checking a chain of PRs/MRs/CLs, process them sequentially.

**Perforce** - to check multiple changelists at once:
```bash
p4 changes -s pending -u $P4USER -c $P4CLIENT -l
```

## Output format

Summarize:
- PR/MR/CL title or description and current state
- Platform detected (GitHub / GitLab / Perforce)
- Status checks summary (passing/failing/pending) - or N/A for Perforce
- Total issues found
- Actionable items with descriptions
- Items that can be ignored with reasons
- Recommended next steps

# Merge queue stalled at head-of-queue — when to dequeue

Source: [BLO-21953](/BLO/issues/BLO-21953) (`master` merge queue frozen for
~30h across 2026-08-04 to 2026-08-06, 14→50 queued entries, zero merges for
stretches over 21h). Trigger: `master` has not advanced in >90 minutes while
the merge queue is non-empty, or
`gh api graphql` shows the position-1 entry's `mergeQueueEntry.state` stuck at
`AWAITING_CHECKS` with its backing `merge_group` Actions run not yet
`completed`. Owner: Platform/SRE (staffed by CTO timebox — see
[BLO-518](/BLO/issues/BLO-518#document-plan)).

## The three failure shapes, and why only two are automatic

GitHub's merge queue removes a queue entry automatically **once a required
check concludes as failing** — that path needs no runbook, it already works
(confirmed in this incident: entries with a deterministic failing test were
evicted and had to be re-added after a fix, they did not wedge the queue by
themselves).

The shape that stalls the fleet is different: a head-of-queue entry whose
`merge_group` check **never reaches a terminal state** — stuck `queued`
(starved for a self-hosted ARC runner) or stuck `in_progress` with no job
progressing. GitHub cannot call that a failure; it only evicts a
non-terminal check via `checkResponseTimeout`, which in this repo is
**21600s (6h)**. A healthy `merge_group` run on this repo completes in
roughly 30-40 minutes end to end (the `General tests (server)` shard alone
runs ~30-36 min). A 6h passive timeout is a >10x margin over that baseline —
long enough for one stuck head, repeated across each new head as the batch
re-stages behind it, to freeze the only path to production for the better
part of a day, exactly as this incident did.

A third shape emits **no signal at all**, automatic or otherwise: see
"Silent eviction: un-stageable rebase" below.

## Silent eviction: un-stageable rebase (BLO-23395)

Source: [BLO-23395](/BLO/issues/BLO-23395)
([Blockcast/paperclip#1092](https://github.com/Blockcast/paperclip/pull/1092)
sat evicted from the merge queue for 9h13m unnoticed — added
`2026-08-08T09:24:35Z`, removed `13:55:45Z`, six issues blocked behind it).

If `master` advances far enough past a queued entry's merge base while it
waits, the entry goes `CONFLICTING`/`DIRTY` and the queue **cannot stage it
at all**. This is neither of the two shapes above:

- It is not a failing required check — no check ever ran, so there is
  nothing to fail. **Zero `merge_group` runs are created for that PR.**
- It does not stall the queue — the queue keeps draining every other entry
  perfectly well, so `master`'s tip keeps advancing and step 2's "position-1
  unchanged" trigger never fires.

The only trace is a `removed_from_merge_queue` timeline event, with no PR
comment, no check-run, and no reviewer wake. This is a foreseeable
recurrence, not a one-off: any PR that sits in a queue behind a busy `master`
long enough will eventually go `CONFLICTING` — the longer the queue, the more
likely it is.

**Detection is automated** (`.github/workflows/merge-queue-eviction-detector.yml`,
`scripts/merge-queue-eviction-detector.mjs`): GitHub fires
`pull_request` `action=dequeued` for every queue removal, including a
successful merge. The workflow resolves its own trigger time from the
workflow run's creation timestamp (`gh api .../actions/runs/<run_id>`,
captured as its own step right after checkout) — **not** `Date.now()` inside
the script, which reflects when a runner became free to execute it, not when
the webhook fired. Under a real runner-capacity delay (this fleet has had
them — BLO-25481/BLO-24992/BLO-25596), a PR could be re-enqueued and
dequeued again while this job was still waiting for a runner; anchoring to
the runner's own start time would misread that fresh, run-less attempt as
this attempt's outcome (Ally review #1220, 4th pass). It then waits out a
short merge-race grace period, confirms the PR is genuinely unmerged, and
reads the PR's own timeline to find the boundaries of the queue attempt that
just ended (`selectLatestQueueAttemptWindow` — the most recent
`added_to_merge_queue` **that had already happened by the resolved trigger
time** paired with the next `removed_from_merge_queue` after it). Anchoring
to the trigger time, not to whenever the function happens to run, matters
twice over: it keeps a prior queue attempt for the same PR from leaking into
this one, and it keeps a PR that gets manually re-added to the queue *during*
the grace-period sleep from having its brand-new, run-less attempt misread as
this attempt's outcome (Ally review #1220, third pass).

If the enqueue it anchors to has no matching `removed_from_merge_queue` event
yet — the `/timeline` endpoint lagging behind the webhook that triggered this
run — the detector never fabricates a timestamp to fill the gap (Ally review
#1220, 4th pass: that gap previously read as "evicted right now," which could
misclassify a still-active or freshly-requeued attempt with no run yet as a
false eviction). It retries the timeline a few times with a short delay
first; if the removal still hasn't appeared, it logs a warning and exits
without posting anything, rather than risk a false notice.

It then enumerates `merge_group` runs created inside that window
(`buildRunSearchWindow`, `gh run list --created <window>`), and classifies
the eviction:

- **zero `merge_group` runs found inside that attempt's window → `conflict_unstageable`**
  (this shape),
- **a run exists and concluded `failure` → `check_failure`** (the automatic
  shape above — should already have produced its own signal; a detector hit
  here means something upstream is missing evidence),
- **a run exists, did not fail, PR still unmerged → `manual`** (the stalled-head
  procedure's manual dequeue, or a GitHub-side timeout),
- **the run-list lookup hit its 500-run sample cap with no match → `unknown`**
  (an incomplete sample isn't proof of zero — don't guess conflict on a
  truncated result; this is a deliberately conservative bailout, distinct
  from the three real causes above).

Bounding the lookup to the specific attempt's time window (rather than an
unbounded newest-N sample across the whole repo's history) is what makes the
zero-runs signal trustworthy even on a busy repo, and what keeps a re-queued
PR's earlier attempt from being misread as this attempt's outcome.

The posted comment also embeds any Paperclip identifier the detector can
recover from the PR's branch name, title, or body (Ally review #1220, 4th
pass): the webhook's `issue_comment` handler has no branch name to fall back
on, so a PR linked to Paperclip only through its branch (no ticket ref in
the title or body text) would otherwise be dropped as `no_paperclip_identifier`
and never wake anyone.

It posts the classification as a PR comment carrying a
`<!-- paperclip:merge-queue-eviction -->` marker; `github-webhook.ts`
recognizes that marker (from the `github-actions[bot]` login only — see
`MERGE_QUEUE_EVICTION_BOT_LOGIN`) and wakes the PR's assignee the same way an
`@ally` review comment does, so the PR author's Paperclip agent is notified
directly rather than needing a human to notice a GitHub-side artifact. This
closes the gap for an agent-authored PR, which has no human watching it.

### A fourth eviction cause the detector already gets right, but a human probe won't: `REBASE`-unstageable history

Source: CTO's evidence comment on
[BLO-23395](/BLO/issues/BLO-23395), reproduced twice (98s apart) on
[Blockcast/paperclip#920](https://github.com/Blockcast/paperclip/pull/920).
This repo's merge queue configuration is
`mergeMethod: REBASE, mergingStrategy: ALLGREEN` — confirmed live via
`gh api graphql -f query='{ repository(owner:"Blockcast", name:"paperclip") {
mergeQueue(branch:"master") { configuration { mergeMethod mergingStrategy } } } }'`.
Under `REBASE`, the queue replays each of the PR's original commits onto the
current base individually, rather than testing the merge of the final tree.
A branch that has absorbed several `merge master into branch` commits (the
standard remedy for "stay mergeable" advice) can have a **byte-identical,
conflict-free final tree** while one of its individual commits — one authored
against an older `master` — fails to replay cleanly onto today's `master`.

**This is why `mergeable`/`mergeStateStatus` cannot be trusted as the probe
for this eviction cause under a `REBASE` queue**: both read `CLEAN` before,
during, and after the eviction in the #920 case (18/18 checks green, no
`reviewDecision` block, `git merge-tree` against `origin/master` clean) — the
PR *merges* fine, it just cannot be *rebased* commit-by-commit. The natural
instinct — "the PR looks clean, this must be something else" — is wrong here
specifically because `REBASE` is not `MERGE`; the failure mode does not exist
under `mergeMethod: MERGE`.

**The detector above is unaffected by this trap.** `classifyMergeQueueEviction`
(`scripts/merge-queue-eviction-detector.mjs`) never reads `mergeable` or
`mergeStateStatus` — it classifies purely from `merge_group` run count for
the queue attempt's window, and a `REBASE`-unstageable eviction produces
**zero** `merge_group` runs exactly like the plain-conflict shape above, so
it already resolves to `conflict_unstageable` correctly. The risk is not in
this detector; it is in a human (or an agent) manually diagnosing an eviction
by checking `mergeable` first, the way the two-shape framing at the top of
this doc might suggest, and concluding "clean, so it's not that."

**The standard remedy is self-inflicted under `REBASE`.** "Merge `master`
into your branch to stay mergeable" is correct advice under `mergeMethod:
MERGE` and actively counterproductive under `mergeMethod: REBASE` — each
absorbed merge commit is itself a commit the queue will later try to replay,
and a merge commit's diff against its own first parent frequently touches
files (lockfiles, generated journals, migration manifests) that a later
`master` has since changed again. Prefer `git rebase origin/master` over
`git merge origin/master` to keep a branch mergeable on a `REBASE` queue; if
the branch already carries merge commits, a cheap structural precondition
check is:

```
git rev-list --min-parents=2 --count origin/master..<head>
```

A nonzero count on a `REBASE` queue is a leading indicator of this risk, not
a confirmed conflict — confirm with a throwaway rebase before concluding
anything is actually unstageable:

```
git rebase --onto origin/master origin/master <head>   # in a throwaway worktree; abort after
```

**Manual diagnosis**, if you need to confirm or replay a specific eviction by
hand — this is exactly what the detector automates:

```
# 1. Confirm the eviction and its timing from the PR's own timeline. If the
#    PR has been queued more than once, use the LAST added_to_merge_queue /
#    removed_from_merge_queue pair -- that is the attempt this eviction
#    belongs to.
gh api repos/Blockcast/paperclip/issues/<PR_NUMBER>/timeline --paginate \
  | jq '.[] | select(.event | test("_merge_queue$")) | {event, created_at}'
```

```
# 2. Enumerate merge_group runs created inside that attempt's window (with a
#    few minutes of buffer on each side) and confirm none of them belongs to
#    this PR (head branch gh-readonly-queue/<base>/pr-<PR_NUMBER>-<sha>).
#    Bounding by --created is what keeps this correct on a busy repo -- an
#    unbounded --limit 500 can silently drop a real run on a busy day.
gh run list --repo Blockcast/paperclip --event merge_group \
  --created "<enqueued_at - 5m>..<removed_at + 5m>" \
  --json databaseId,headBranch,status,conclusion,createdAt --limit 500 \
  | jq --arg pr "pr-<PR_NUMBER>-" '[.[] | select(.headBranch | startswith("gh-readonly-queue/") and contains($pr))]'
```

An empty array from step 2, alongside a `removed_from_merge_queue` event and
no matching `merged` event from step 1, is the conflict/un-stageable
signature — provided the result count from step 2 is below the 500-run cap
(if it isn't, treat the result as inconclusive, not as zero, and widen or
narrow the window). Fix is routine: rebase the PR onto the current base and
re-add it to the queue — this runbook exists for the missing *signal*, not
for a special repair procedure.

A PR whose queue entry is evicted must not be left reporting a stale
"enqueued" state anywhere an agent might read it as progress: the detector's
wake/comment is the correction, and it fires whether or not anyone is
watching.

## The policy

This is the "how long before it is dequeued" answer AC4 asked for. It is an
**active SRE threshold below GitHub's own passive 6h timeout**, not a
replacement for it:

1. **Baseline**: if `master`'s tip has not advanced and the merge queue is
   non-empty, that alone is not actionable — queues drain in bursts and a
   healthy run can legitimately take up to ~40 minutes.
2. **90 minutes since the last merge, queue non-empty, position-1 unchanged**:
   resolve the position-1 entry's exact identity first — do not trust the
   newest repo-wide `merge_group` run, since concurrent re-staging can make
   that a different PR's run entirely. Query the queue for the entry's PR
   node ID and head commit:
   ```
   gh api graphql -f query='{ repository(owner:"Blockcast", name:"paperclip") {
     mergeQueue(branch: "master") {
       entries(first: 1) { nodes { pullRequest { id number } headCommit { oid } } }
     } } }'
   ```
   then filter Actions runs by that exact commit, not by recency:
   `gh run list --repo Blockcast/paperclip --event merge_group --commit <headCommit.oid> --json databaseId,status,createdAt,headSha`,
   and confirm the returned `headSha` matches `headCommit.oid` before acting
   on it. Record the PR node ID and the run's `databaseId`. If the run is
   `in_progress` and its per-job timestamps are still advancing, keep
   monitoring — this is a slow but live run, not a stall.
3. **150 minutes since the run identified in step 2 was created** (the run's
   own `createdAt`, never wall-clock time since the last merge — a freshly
   promoted position-1 entry has not been stalled just because its
   predecessor was) **with that same run still `queued` (never started) or
   `in_progress` with no job having progressed since the step-2 check**:
   this is a stall. Re-run the step-2 resolution and require the PR node ID
   and run `databaseId` to be identical to what you recorded — if either has
   changed, a different entry was promoted to position 1 and the elapsed-time
   clock resets; do not carry over the previous head's stall time. Once
   identity and elapsed time are both confirmed, post the evidence (PR node
   ID, run `databaseId`, `createdAt`, per-job state) to the incident/alert
   issue and escalate for a **manual dequeue** of that one entry. Immediately
   before mutating, re-fetch and re-confirm the same PR node ID and run
   `databaseId` one more time — this check must be the last thing done
   before the write, not something verified minutes earlier, to close the
   race between evidence-gathering and the mutation:
   ```
   gh api graphql -f query='mutation { dequeuePullRequest(input: { id: "<PR node ID, re-confirmed>" }) { clientMutationId } }'
   ```
   (`input.id` is the pull request's node ID, not the merge-queue entry's) or
   the "Remove from queue" action in the GitHub UI — this requires a named
   approver per this agent's standing permissions, since it mutates shared
   queue state. Do not cancel the underlying Actions run first; GitHub
   requires the dequeue as the primary action and will handle the run.
   Postcondition: re-query `mergeQueue.entries` and confirm the dequeued PR
   node ID is gone and the next entry has been promoted to position 1.
4. **If the very next head also stalls with the same signature** (not a
   different PR's own failure): stop dequeuing one-by-one. That pattern means
   the constraint is systemic (runner capacity, an Actions-side outage — see
   [BLO-22428](/BLO/issues/BLO-22428)), not one bad PR, and continuing to
   evict entries only burns queue slots without addressing the cause. File or
   update the capacity/infra incident instead, and freeze the queue
   operationally: announce the freeze and hold off enqueueing new PRs by
   convention, leaving branch protections untouched. Do **not** disable
   `auto_merge` or the branch-protection/ruleset merge-queue requirement as a
   pause mechanism — repository `auto_merge` configuration does not gate
   queue admission, and removing the merge-queue requirement can let merges
   bypass the only enforced path to production; ruleset edits can also drop
   unrelated protections. No tested snapshot/restore procedure for that
   exists today, so it is out of scope for this runbook — if an
   admission-level pause is ever genuinely required, that is a repo-admin
   decision to hand off, not a step to take solo.

## Why 150 minutes and not GitHub's 6h

`checkResponseTimeout=21600` (6h) is a safety net for the case nobody is
watching. It is not a target. At this repo's observed drain rate (~1
merge/45-60 min when healthy — see BLO-21953 evidence log), a single stuck
head left for the full 6h can cost 6-8 merges' worth of fleet-wide
throughput. 150 minutes bounds that loss to roughly 2-3 missed merges before
an SRE intervenes, while still being long enough (2.5x the observed healthy
run duration) that a merely slow-but-live run is not mistaken for a stall.

## Verifying signal

- `gh api graphql` merge-queue query (see BLO-21953 evidence comments for the
  exact query) shows queue depth trending down over the following hour, and
  `git ls-remote blockcast refs/heads/master` advances within the same
  window.
- The dequeued PR's owning agent/author is notified with the run ID and
  failure evidence so they can re-add it once fixed — a silent dequeue with
  no notification just re-creates the "silently stalls the fleet" failure
  mode one PR later.

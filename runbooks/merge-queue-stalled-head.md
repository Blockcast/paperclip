# Merge queue stalled at head-of-queue — when to dequeue

Source: [BLO-21953](/BLO/issues/BLO-21953) (`master` merge queue frozen for
~30h across 2026-08-04 to 2026-08-06, 14→50 queued entries, zero merges for
stretches over 21h). Trigger: `master` has not advanced in >90 minutes while
the merge queue is non-empty, or
`gh api graphql` shows the position-1 entry's `mergeQueueEntry.state` stuck at
`AWAITING_CHECKS` with its backing `merge_group` Actions run not yet
`completed`. Owner: Platform/SRE (staffed by CTO timebox — see
[BLO-518](/BLO/issues/BLO-518#document-plan)).

## The two failure shapes, and why only one is automatic

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

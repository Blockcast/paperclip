# Merge queue stalled at head-of-queue — when to dequeue

Source: [BLO-21953](/BLO/issues/BLO-21953) (`master` merge queue frozen for
~30h across 2026-08-04 to 2026-08-06, 14→50 queued entries, zero merges for
stretches over 21h).

**Trigger** (both conditions, measured with the instruments below):
`master` has merged nothing in >90 minutes **by `merged_at` on closed PRs**,
**and** the `merge_group` Actions run at the position-1 entry's `headCommit.oid`
is `queued` with no job started, or `in_progress` with no job advancing, or
does not exist at all **when queried with the full 40-hex SHA** (a dispatch
gap; step 2 below says how to clock it).

Owner: Platform/SRE (staffed by CTO timebox — see
[BLO-518](/BLO/issues/BLO-518#document-plan)). Detection is **manual** by
deliberate decision — see "Why there is no alert" at the end.

## ⚠ Three instruments that read as a stall on a perfectly healthy queue

Measured on [BLO-26427](/BLO/issues/BLO-26427), 2026-09-30. **Four independent
observations across seven weeks each reported a multi-hour to multi-day
head-of-queue stall. All four were refuted by control** — the queue was
draining continuously through every claimed window. Every one used at least
one of these:

1. **`enqueuedAt` is when an entry joins the BACK of the queue, not when it
   reaches the head.** `now − enqueuedAt` is *residency*, not time-at-head.
   With `max_entries_to_build: 1` the builder is serial, so residency ≈
   `position × build duration` ≈ `position × 35 min` **by design**. At depth 6
   that is 3.5h; at depth 51, ~30h; at depth 85, ~50h. Growing residency is the
   throughput ceiling ([BLO-36439](/BLO/issues/BLO-36439)), not a stall.
2. **A commit date on `master` is NOT a merge time.** `merge_method: REBASE`
   stamps the commit at *enqueue*, so a commit date lags wall-clock by exactly
   the queue residency. Reading `commits/master` as "last merge" manufactures a
   multi-day gap out of a queue that merged all day. **Use `merged_at` on
   closed PRs**, which is the only field that means what it says:
   ```
   gh api graphql -f query='{ search(query:"repo:Blockcast/paperclip is:pr is:merged merged:<START>..<END>", type:ISSUE, first:100){ issueCount nodes{ ... on PullRequest { number mergedAt } } } }'
   ```
   `<START>..<END>` is the claimed stall window, both ends ISO-8601. Keep it
   bounded: an open-ended `merged:>=<START>` also counts every merge *after*
   the window, so it refutes a genuine stall.
3. **`state: AWAITING_CHECKS` at position 1 is the HEALTHY steady state.** It is
   what the head entry reads for the entire ~35 min it is building. Under a
   1-wide serial builder it is true nearly whenever the queue is non-empty and
   draining. It is not evidence of anything on its own — which is exactly why
   the old trigger above, keyed on it, was uninformative.

**The one clock that is correct is the run's own `createdAt` at the entry's
`headCommit.oid`** — step 3 below already says so; use it, and pass the **full
40-hex SHA** (`actions/runs?head_sha=` silently returns zero rows for an
abbreviated SHA, which reads as "no runs ever" for the wrong reason).

**Before escalating, run the control:** if PRs merged by `merged_at` inside
your claimed stall window, there was no stall. That single query refuted all
four reports.

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

1. **Baseline**: if `master` has not merged anything **by `merged_at` on
   closed PRs** and the merge queue is
   non-empty, that alone is not actionable — queues drain in bursts and a
   healthy run can legitimately take up to ~40 minutes.
2. **90 minutes since the last merge by `merged_at`, queue non-empty,
   position-1 unchanged**:
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
   If no run is returned for that full 40-hex `oid`, that is the dispatch-gap
   arm of the trigger: record the PR node ID and the time of this check. That
   time stands in for the run's `createdAt` in step 3 (absence began no later
   than it), and "no run" stands in for its `databaseId` in every identity
   check below.
3. **150 minutes since the run identified in step 2 was created** (the run's
   own `createdAt`, never wall-clock time since the last merge — a freshly
   promoted position-1 entry has not been stalled just because its
   predecessor was) **with that same run still `queued` (never started) or
   `in_progress` with no job having progressed since the step-2 check, or
   still no run at all at that `oid`**:
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

## Why there is no alert (decision, [BLO-26427](/BLO/issues/BLO-26427), 2026-09-30)

**Decision: detection stays manual. Owner is Platform/SRE.** Recorded here
rather than left implicit, because the issue that previously owned this
runbook's monitoring ([BLO-21953](/BLO/issues/BLO-21953)) is `cancelled`.

The obvious alert — *"position-1 entry `AWAITING_CHECKS` longer than the
150 min dequeue threshold"* — **must not be built**. Per instrument 3 above,
that predicate is the healthy steady state of a 1-wide serial builder: it would
have fired on all four refuted observations and on most of any normal day. An
alert that fires while the system works is worse than none, because it trains
the reader to discount the one time it is right.

The one **genuine** stall on record (2026-08-26, [BLO-27641](/BLO/issues/BLO-27641))
had the opposite signature: check-suites *were* dispatched and sat `queued`
with **zero `arc-merge-queue` runner pods**, after a listener restart. Control
confirms it — merge cadence that day was ~45 min with a 3h20m hole at
14:29Z→17:49Z spanning the observation. That is a **runner-supply** fault, not
a dispatch-gap fault, and the correct predicate for it is *`merge_group` run
`queued` with zero runners in its target scale set*.

Automating that predicate needs a scheduled workflow polling the GitHub API
(Prometheus has no merge-queue data). At one real occurrence in seven weeks,
caught manually inside 4.6h, a 15-minute poll costs ~96 runs/day on a pool
under documented eviction pressure ([BLO-20369](/BLO/issues/BLO-20369)) — the
same cost argument `master-health.yml` already makes for keeping its own scope
narrow. Revisit if this shape recurs: **two genuine runner-supply stalls in one
month flips the decision**, and the predicate to implement is the one above.

The defect these four reports actually exposed was never missing automation —
it was the instruments. That is fixed at the top of this file.


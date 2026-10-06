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
   The builder runs `max_entries_to_build` lanes in parallel, so residency ≈
   `(position ÷ lanes) × build duration` **by design**. Growing residency is
   the throughput ceiling ([BLO-36439](/BLO/issues/BLO-36439)), not a stall.

   ⚠ **Read both constants live — this line has already gone stale once, and
   it went stale _invisibly_.** It previously hard-coded
   `max_entries_to_build: 1` and `35 min`. BLO-36439 changed the first to `2`
   on 2026-10-03T22:15:49Z, and measured 2026-10-05 over the 78 successful
   post-change builds the second is now **median 67.9 min, mean 71.2**.
   Both inputs moved and they very nearly cancelled: `position × 35` became
   `(position ÷ 2) × 67.9 = position × 34.0`, a **3% change**. The three depth
   figures this line used to quote were all still within 4% of correct
   (depth 6 → 3.4h vs "3.5h"; 51 → 28.9h vs "~30h"; 85 → 48.1h vs "~50h").
   That is the reason to re-derive rather than trust: the quoted figures can
   look right while **both** inputs are stale, so agreement with the text is
   not evidence the constants still hold. At 2 lanes residency ≈
   `position × 34 min`, and at depth 27 that is ~15h.

   Lanes:

   ```
   gh api repos/Blockcast/paperclip/rules/branches/master \
     --jq '.[]|select(.type=="merge_queue")|.parameters.max_entries_to_build'
   ```

   Build duration — this is the input that actually moved (`35 → 67.9 min`,
   +94%, against `1 → 2` lanes), so re-derive it rather than the lane count if
   you only do one. This is the query the 2026-10-05 figure came from; set
   `$SINCE` to the last `max_entries_to_build` change (`2026-10-03T22:15:49Z`
   for the 2-lane change) so the window covers one lane count only:

   ```
   gh run list --repo Blockcast/paperclip --workflow pr.yml --event merge_group \
     --status success --json createdAt,startedAt,updatedAt --limit 200 \
     --jq '[.[]|select(.createdAt>="'"$SINCE"'")
            |(((.updatedAt|fromdate)-(.startedAt|fromdate))/60)]
           |sort
           |if length==0 then "NO BUILDS IN WINDOW — check $SINCE and --limit"
            else {n:length,median:.[length/2|floor],mean:(add/length)} end'
   ```

   The empty-window guard is not decoration: without it an empty result set
   divides by zero and prints `cannot divide: null and number (0)`, which
   reads as a broken command rather than as "your window selected nothing".
   `--limit 200` is a cap, not a window — if `n` comes back at or near it,
   the window is wider than the page and the median is over a prefix.

   `--workflow pr.yml` is load-bearing: two other workflows (`Comment-review
   gate`, `commitperclip PR Review`) also run on `merge_group` and finish in
   ~2 min, so an unfiltered query reports a median less than half the real
   one. Clock from `startedAt`, not `createdAt` — the gap between them is
   runner wait, which is tracked separately by the stall counter below and is
   not build duration. Re-run 2026-10-06, n=96: median 68.5, mean 69.4.
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
   what the head entry reads for the entire ~68 min it is building. While the
   queue is non-empty and draining it is true of whichever entries occupy the
   `max_entries_to_build` lanes. It is not evidence of anything on its own —
   which is exactly why the old trigger above, keyed on it, was uninformative.

**For ranking the candidate clocks against each other** — residency, the
commit date, and `AWAITING_CHECKS` are all unusable above, and the run's own
timestamps at the entry's `headCommit.oid` are what remain. Pass the **full
40-hex SHA** (`actions/runs?head_sha=` silently returns zero rows for an
abbreviated SHA, which reads as "no runs ever" for the wrong reason).
**Which** of the run's timestamps to clock from is not uniform — step 3's
table decides it per arm, and `run_started_at` is the right one whenever the
run has started.

**Before escalating, run the control:** if PRs merged by `merged_at` inside
your claimed stall window, there was no stall. That single query refuted all
four reports.

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

The same holds for a missing `added_to_merge_queue` — the *enqueue* side —
and this is the case an operator is most likely to trip over (Ally review
#1220, 5th pass). Timeline replication is one event stream, so the lag that
hides a dequeue can equally hide the enqueue that preceded it. The detector
applies the same bounded retry and then **declines to classify**; it does
*not* fall back to an unbounded `merge_group` lookup. That fallback used to
exist and was a misclassification vector: `filterMergeGroupRunsForPr` matches
on PR number, not on time, so an unbounded sample surfaces a *previous*
attempt's runs and an un-stageable eviction gets reported as `check_failure`
or `manual` — a confidently wrong cause. `ghMergeGroupRuns` now *requires* a
bounded `--created` range so that path cannot be reintroduced by a caller
passing nothing, and `buildRunSearchWindow` throws rather than emitting a
1970-epoch bound from a `null` `dequeuedAt`.

**Operator consequence:** a declined classification means **no comment and no
wake for that eviction** — the detector is deliberately choosing a missed
notification (recoverable) over a wrong cause (not). It is not silent about
it: the workflow run logs which side was missing. If you find a PR sitting
evicted with no notice, check that run, then replay by hand once the timeline
has caught up:

```bash
gh workflow run merge-queue-eviction-detector.yml \
  --repo Blockcast/paperclip -f pr_number=<PR> -f comment=true
```

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

The webhook inlines that comment as `githubMergeQueueEvictionBody`, and the
woken agent's prompt renders it under a dedicated **"GitHub merge-queue
eviction directive"** (`heartbeat.ts`) — so the cause is in the prompt and the
agent does not have to fetch `githubEventUrl` to learn why it was woken. Three
properties of that directive are load-bearing and covered by tests in
`server/src/__tests__/heartbeat-context-summary.test.ts`:

- `github_pr_merge_queue_evicted` is deliberately **absent** from
  `AUTHOR_REVIEW_CONTENT_WAKE_REASONS`. No review exists on this wake, so it
  must never reach the review-feedback directive's "a reviewer just posted
  findings on YOUR pull request … push a follow-up commit" text
  (BLO-19522/BLO-20886). The eviction branch runs ahead of that check.
- The key is registered in `GITHUB_PR_CONTEXT_KEYS`, so the BLO-19118 cross-PR
  scrub drops it when a coalesced wake names a **different** PR — otherwise
  PR #A's eviction cause could render as PR #B's.
- Each eviction wake owns the key outright (same rule as BLO-22229's
  review-content block), so a **re-eviction** of the same PR whose notice
  comment wasn't captured cannot render the *previous* eviction's cause.

"Author-directed" here means the PR is owned by this agent's *issue*; the PR
itself may have a different author. In that case the directive drops the
"rebase and re-enqueue" instruction and asks the agent to report on the PR
instead — pushing to a third party's branch is the BLO-20886 damage path.

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
   `gh run list --repo Blockcast/paperclip --event merge_group --commit <headCommit.oid> --json databaseId,status,createdAt,startedAt,headSha`,
   and confirm the returned `headSha` matches `headCommit.oid` before acting
   on it. `startedAt` is in that list so step 3's table is decidable from this
   one call — it is `gh`'s camelCase spelling of the REST field
   `run_started_at`, same value, and it is null on a run that never started.
   Record the PR node ID and the run's `databaseId`. If the run is
   `in_progress` and its per-job timestamps are still advancing, keep
   monitoring — this is a slow but live run, not a stall.
   If no run is returned for that full 40-hex `oid`, that is the dispatch-gap
   arm of the trigger: record the PR node ID and the time of this check. That
   time is what the dispatch-gap row of step 3's table clocks from (absence
   began no later than it), and "no run" stands in for its `databaseId` in
   every identity check below.
3. **150 minutes of elapsed time, clocked per the arm below** — never
   wall-clock time since the last merge, which is not a property of this
   entry at all (a freshly promoted position-1 entry has not been stalled
   just because its predecessor was). Which field you clock from depends on
   what step 2 found, because at 2 lanes `createdAt` no longer means one
   thing (see "Why 150 minutes" below — clocking a *started* run from
   `createdAt` fails toward dequeuing a **healthy** entry):

   | step 2 found | clock from | trigger at |
   |---|---|---|
   | run `in_progress`, no job progressed since the step-2 check | **`run_started_at`** (`gh`: `startedAt`) | 150 min |
   | run `queued`, never started (`run_started_at` is null) | `createdAt` | 150 min — ⚠ margin is thin, see below |
   | no run at all at that `oid` (dispatch gap) | the step-2 check time recorded above | 150 min |

   ```
   gh api repos/Blockcast/paperclip/actions/runs/<id> --jq '{created_at,run_started_at,status}'
   ```

   ⚠ The `queued` arm is the weak one: the longest *legitimate* runner wait
   measured is **113.2 min**, so 150 min is only 1.3× it, not a comfortable
   margin. Prefer raising `arc-merge-queue`'s warm pool over loosening this
   (see the cold-start burst section); if you do trip it during a known
   cold-start burst, treat it as runner supply, not a wedged build.

   With the elapsed time met on the applicable arm,
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
watching. It is not a target. At this repo's observed drain rate (**~1
merge/36 min**, = 40.0/day, measured over the 80 PRs merged in the 2 days
after the 2-lane change; the 1-lane baseline was **~1 merge/83 min**, =
17.3/day, over the 121 PRs merged in the 7 days before it), a single stuck
head left for the full 6h costs **`360 ÷ 36 ≈ 10` merges'** worth of
fleet-wide throughput. 150 minutes bounds that loss to **`150 ÷ 36 ≈ 4`**
missed merges before an SRE intervenes.

Both loss figures are written as the division that produces them so that the
next time the drain rate moves, the staleness is visible rather than silent.
They were previously quoted as "6-8" and "2-3", which were `360 ÷ 45-60` and
`150 ÷ 45-60` against the superseded rate below and survived the revision
that replaced it. At the 1.4× higher cost the current rate implies, this
argues *for* the 150 min threshold over 6h, not against it.

Both rates above are `merged_at` counts over a stated window, which is the
only methodology this runbook uses for drain — see instrument 2. An earlier
revision quoted "~1 merge/45-60 min" for the 1-lane baseline with no window
attached; that is **superseded** and was optimistic by ~1.5×, because it
timed consecutive *successful* builds and so silently excluded the failures,
cancellations and idle gaps that net drain has to carry.

☠️ **A flat 150 min / `createdAt` pairing is NOT SAFE at 2 lanes — it fails
toward dequeuing a HEALTHY entry.** This is the defect step 3's per-arm table
exists to avoid; it is recorded here because the sizing argument is what
justifies the table. The threshold was sized as 2.5× a ~35 min end-to-end run
started on a free runner. Measured 2026-10-05, neither half of that premise
holds: builds now take a **median 67.9 min** (150 min = 2.2×), and runner
supply is no longer instant — two runs waited **113.2 min** between
`createdAt` and `run_started_at` (see the 2-lane cold-start burst below). A
healthy build can therefore legitimately be `113 + 68 = 181 min` old by
`createdAt` while nothing whatsoever is wrong, which is **past** the dequeue
trigger.

**This is why step 3 clocks a started run from `run_started_at`, not
`createdAt`.** `createdAt` measures "waiting for a runner" and "wedged
mid-build" as the same number, and only the second is a stall. `createdAt`
survives only on the arms where there is no started run to clock from — the
`queued` and dispatch-gap rows of step 3's table. Step 3 is the procedure;
this section is only its justification, so if the two ever disagree again,
**step 3 wins and this section is the stale one**.

```
gh api repos/Blockcast/paperclip/actions/runs/<id> --jq '{created_at,run_started_at,status}'
```

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
that predicate is the healthy steady state of the build lanes: it would
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

### Runner-supply stall counter (the revisit condition above)

The decision flips at **two genuine runner-supply stalls in one month**. Add a
row rather than re-deriving the count.

**The counting unit is one row per supply *incident*, not per stalled run.** A
single eviction re-forms every lane at once, so an N-lane repo turns one
supply event into N stalled runs; counting runs would make the same incident
flip the decision faster purely because the lane count went up, which is not
what the threshold is about. The 2026-10-05 row below is two runs
(`pr-2228` + `pr-2224`) and counts as **one**.

**A row qualifies when** the `merge_group` run was dispatched and sat unable
to start for want of a runner — a `createdAt` → `run_started_at` gap of
**≥ 10 min** — not merely slow once running. The exact floor is not
load-bearing, because the measured distribution has nothing in the band it
cuts: over 107 post-change `pr.yml` builds the gap is **exactly 0.0 on 105 of
them**, and the only two non-zero values are the 113.2 min pair in the row
below. Any floor between 1 and 110 min selects the same set. Re-measure
before trusting that — if intermediate values ever appear, the floor becomes
a real judgement call and wants re-deriving from the new distribution:

```
gh run list --repo Blockcast/paperclip --workflow pr.yml --event merge_group \
  --json createdAt,startedAt --limit 300 \
  --jq '[.[]|select(.createdAt>="'"$SINCE"'")
         |(((.startedAt|fromdate)-(.createdAt|fromdate))/60)]
        |sort|{n:length,nonzero:[.[]|select(.>=10)]}'
```

| date | gap | evidence |
|---|---:|---|
| 2026-08-26 | ~3h20m | [BLO-27641](/BLO/issues/BLO-27641) — zero `arc-merge-queue` pods after a listener restart |
| 2026-10-05 | 113.2 min | `pr-2228` + `pr-2224`, both `createdAt 19:07:44/45Z` → `run_started_at 21:00:53/55Z`; 2-lane cold-start burst, below |

**As of 2026-10-05 that is one incident inside the trailing month** (the
2026-08-26 row is ~40 days back), so the decision does **not** flip yet. Note
the hazard rate is now higher than it was when the decision was taken — see
the mode below — so treat the next occurrence as flipping it rather than
re-opening the cost argument.

### 2-lane cold-start burst (new since BLO-36439 raised `max_entries_to_build` to 2)

An eviction invalidates every lane stacked behind it, so **all lanes re-form
and cold-start at the same instant**. At 1 lane that asked ARC for one build's
worth of runners; at N lanes it asks for N at once, and `arc-merge-queue`
scales from a warm pool sized for the steady state, not for an N-wide
simultaneous cold start.

Measured 2026-10-05, the `#2214` eviction (`removed_from_merge_queue` by
`github-merge-queue[bot]` at 19:07:40Z): 3 builds cancelled in one 25-min
window, then both lanes re-formed at 19:07:44/45Z and **both waited 113.2 min
for a runner**. Across the window: `createdAt → run_started_at` was **0.0 min
at every percentile including max over 143 pre-change builds**, versus median
0.0 / max 113.2 over 88 post-change builds (2 of 88, 2%).

**This is a cost of parallelism, not a regression to back out** — net drain
still went 17.3/day → 40.0/day (`merged_at` counts over the 7 days before and
the 2 days after the change) and depth 108 → 27. But two consequences:

- It is why the `createdAt` clock in step 3 is now unsafe (see "Why 150
  minutes" above). Both affected runs were healthy.
- It is the shape most likely to trip the counter above. If it does,
  the cheaper fix is raising `arc-merge-queue`'s **minimum warm pool** to
  `max_entries_to_build` × one build's runner demand, so an N-wide re-form
  never cold-starts — not lowering `max_entries_to_build` back to 1.

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
   ⚠ **A transient empty has been observed on an otherwise-correct
   invocation** — three different people hit it, and on the last occasion the
   next four runs returned `n=114` identically. Re-run before concluding your
   `$SINCE` is wrong.
   `--limit 200` is a cap, not a window — if `n` comes back at or near it,
   the window is wider than the page and the median is over a prefix. ⚠ **The
   same applies to every `$SINCE`-anchored query in this file**: they are
   anchored to a fixed date and so grow monotonically, and at ~15-20
   builds/day each reaches its cap within weeks and then silently reports a
   prefix. **Check `n` against the expectation below before believing a
   median** — a short page returns a plausible, wrong number rather than an
   error. While writing this file one invocation of this block returned
   `n=48` where the correct count was `148`; the number looked entirely
   reasonable and was only caught by a second read.

   `--workflow pr.yml` is load-bearing: two other workflows (`Comment-review
   gate`, `commitperclip PR Review`) also run on `merge_group` and finish in
   ~2 min, so an unfiltered query reports a median less than half the real
   one. Clock from `startedAt`, not `createdAt`: the two are *equal* on a
   first-attempt run, and on a re-run `startedAt` is the latest attempt's
   start, so it times that attempt instead of the dead time back to the
   original dispatch. Re-run 2026-10-06 with `$SINCE` at the exact 2-lane
   change: **n=114, median 69.0, mean 69.8** — 1.6% above the 67.9 quoted
   above, which does not move any figure derived from it.
   ⚠ Set `$SINCE` to the *timestamp*, not the date: `>= "2026-10-03"` sweeps
   in ~20 one-lane builds from earlier that day and returns n=134, mixing the
   two lane counts the window exists to separate.
   **Expectation for the `n` check above:** ~15-20 successful builds/day, so
   `n ≈ 114 + 17 × (days since 2026-10-06)`. An `n` well under that is a short
   page, not a quiet queue.
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
table decides it per arm, and `run_started_at` is the right one whenever a
run exists at all, `queued` or `in_progress` alike.

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

⚠ "That path needs no runbook" is a claim about the *mechanism*, not about
the *diagnosis*. When the base itself is red, the automatic path works
perfectly and evicts every entry in turn — each one reporting a failure that
reads like that PR's own fault. See "The base is red" below for the one query
that tells the two apart.

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

- **zero `merge_group` runs found inside that attempt's window, and the
  removal is attributed to `github-merge-queue[bot]` → `conflict_unstageable`**
  (this shape),
- **zero runs, but the removal carries any other actor → `manual`** (PEN-3926).
  A human or App can remove a PR from the queue *before* the queue gets as far
  as staging a run, which produces zero runs for a reason that has nothing to
  do with stageability — so run count alone cannot separate the two. Measured
  2026-10-10 over 74 removals across 56 PRs: 53 queue-bot, 21 human, none
  absent, no actor on both sides; before the fix this misreported 13 notices
  across 8 PRs, each telling the reader to rebase a branch that was clean and
  deliberately held. An absent or unparseable actor falls back to
  `conflict_unstageable`, so the classifier cannot be made quieter by a missing
  field,
- **a run exists and concluded `failure` → `check_failure`** (the automatic
  shape above — should already have produced its own signal; a detector hit
  here means something upstream is missing evidence). The actor does *not*
  override this: a human who dequeues a PR whose run already failed still
  reports `check_failure`,
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

The removal actor is read from the attempt's own `removed_from_merge_queue`
timeline event (`selectLatestQueueAttemptWindow` → `dequeuedBy`), not from
`github.event.sender.login`. That binds it to the removal the window already
anchored to rather than to whoever sent the webhook, and it keeps working on
`workflow_dispatch` replay, which carries no sender at all. It is not a
`mergeable`/`mergeStateStatus` check — see "A fourth eviction cause..." below,
whose prohibition stands: a `REBASE`-unstageable branch still reads `CLEAN`,
and nothing in the classifier consults it.

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

## The base is red: every entry fails the same job (BLO-41267)

The merge group is `master` + the entry. If `master` is red, **every** entry
fails — one at a time, each with a failure that looks like that PR's own. This
produces more total stall time than any other shape in this file, because it
blocks the whole queue rather than one position, and it is the only shape where
reading the head entry's log leads you to the wrong conclusion *by design*.

**The discriminator is the failing job name grouped across entries, not the
contents of any one log.** Group by job, count **distinct PRs**:

```bash
# $WINDOW is the suspected red period, e.g. "2026-10-07..2026-10-08".
gh run list --repo Blockcast/paperclip --workflow pr.yml --event merge_group \
  --status failure --created "$WINDOW" \
  --json databaseId,headBranch --limit 100 \
  --jq '.[]|"\(.databaseId)\t\(.headBranch)"' \
| while IFS=$'\t' read -r id br; do
    pr=${br##*/pr-}; pr=${pr%%-*}
    gh api "repos/Blockcast/paperclip/actions/runs/$id/jobs?per_page=100" --paginate \
      --jq '.jobs[]|select(.conclusion=="failure")|.name' \
    | grep -vxF verify | sed "s|\$|\t$pr|"
  done | sort -u \
| awk -F'\t' '{n[$1]++; p[$1]=p[$1]" "$2} END{for(j in n) printf "%d\t%s\t%s\n", n[j], j, p[j]}' \
| sort -rn
```

| grouping | reading | action |
|---|---|---|
| **one job name across most or all entries** | the base is red; the entries are innocent | fix `master`, then re-enqueue what was evicted. Do **not** dequeue entries one by one — step 4 of the policy below is the same instinct and the same answer |
| **a different job per entry** | the entries are genuinely bad | ordinary eviction handling; each PR owns its own failure |

**Three ways to read this query wrong:**

- **Exclude `verify`.** It is the aggregate required check (`needs:` every
  lane, `if: always() && !cancelled()`), so it fails on every failing entry by
  construction and reads as "same job everywhere" on *any* bad day. Left in, it
  is a permanent false positive. The `grep -vxF verify` above is load-bearing.
- **Count distinct PRs, not runs.** One PR re-queued three times contributes
  three runs and is one data point; the `sort -u` above is what makes the count
  mean what the table says.
- **Two entries sharing a job name is not a red base.** It is the weakest
  reading the query can produce and a plausible coincidence — the same window
  below contains exactly that (`Typecheck + Release Registry`, 2 PRs, hours
  away from the real cluster). **Confirm on `master` itself before acting**:
  the one `master-health.yml` failure in the whole of 2026-10-01→10-08 is the
  red base here, at `73231deccc3c` `09:29:24Z`. ⚠ That workflow is **not** a
  detector — it self-cancels on supersession (31 of 46 runs that day), so a red
  can pass under it unobserved. A `success` there is evidence; an absence is
  not.

**Worked example — 2026-10-07, this repo.** `master` red from **08:59:36Z**
(`f3e05fc53`, [#2263](https://github.com/Blockcast/paperclip/pull/2263)) until
**16:31:11Z** ([#2290](https://github.com/Blockcast/paperclip/pull/2290)). The
query above over `2026-10-07..2026-10-08` returns:

```
6  General tests (server 5/6)       1699 2041 2142 2143 2252 2267
2  Typecheck + Release Registry     1864 2157
2  General tests (workspaces-b)     2142 2241
1  Canary Dry Run                   2269
```

Six distinct PRs, ten runs, **one assertion** —
`security-audit-overrides.test.ts > has a guard wired for every ticket bucket`.
The bottom three rows are the other side of the discriminator in the same
output — different jobs, one or two entries each, scattered across the window
rather than clustered in the red period. Those entries own their own failures.
PR 2142 appears on both sides: innocent at 09:5xZ against the red base,
genuinely bad at 18:29Z against a fixed one.

**How it landed** — a semantic conflict between two individually-correct
commits. `3c6322515` ([BLO-40607](/BLO/issues/BLO-40607)) added a
`securityAuditRemediations` bucket plus its guard; `f3e05fc53`
([BLO-40334](/BLO/issues/BLO-40334)) added a ticket-key pin enumerating only
the buckets that existed in *its* tree. Neither is wrong alone. #2263 merged
with **zero `merge_group` builds**, so the queue — the only check that
evaluates a PR against the real `master` — never saw the pair. The pin worked
exactly as designed; it was never shown the entry. **A PR that reaches `master`
without a `merge_group` build is the generator of this shape**, so it is worth
checking what merged just before the first same-job failure.

Out of scope here, deliberately: how the repo admin uses their own bypass.
That is their call. This step is diagnosis, and it is useful however the red
arrived.

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
   `run_started_at`, same value. ⚠ It is **not** null on a run that has not
   started: it is the start of the run's *latest attempt*, and until a re-run
   happens it is a copy of `created_at` — populated, equal, and present even
   while the run is `queued`. See step 3's table note.
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
   just because its predecessor was).

   | step 2 found | clock from | trigger at |
   |---|---|---|
   | a run at that `oid` — **any** `status`, `queued` or `in_progress` | **`run_started_at`** (`gh`: `startedAt`) | 150 min |
   | no run at all at that `oid` (dispatch gap) | the step-2 check time recorded above | 150 min |

   ```
   gh api repos/Blockcast/paperclip/actions/runs/<id> --jq '{created_at,run_started_at,run_attempt,status}'
   ```

   **One clock covers both run states, and `run_attempt` is why.**
   `run_started_at` is the start of the run's *latest attempt*. On a
   first-attempt run it is a byte-identical copy of `created_at`, so the two
   candidate clocks agree and the choice does not matter; it diverges only
   after a re-run, and there it is the one you want, because it excludes the
   dead time between a cancelled attempt and its replacement. Measured over
   1000 `merge_group` `pr.yml` runs (2026-08-20 → 2026-10-06), the two fields
   differ on exactly 7 runs and **all 7 are `run_attempt > 1`**; no
   first-attempt run differs, and no re-run fails to. So do not special-case
   `queued`: `status` tells you what the run is doing, `run_attempt` tells you
   whether the clocks differ, and `run_started_at` is right either way.
   (If `run_started_at` is ever null, fall back to `createdAt` — on a
   first attempt they are equal.)

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

**Sizing.** The threshold was set as 2.5× a ~35 min end-to-end run started on
a free runner. Half of that premise is gone: builds now take a **median
69.0 min** (n=114, 2026-10-06, over the 2-lane window), so 150 min is
**2.2×** a healthy build, not 2.5×. That is still a margin, but a thinner one
than the number was chosen to give, and it shrinks further if build duration
keeps climbing — re-derive it from instrument 1 rather than trusting the
constant.

**Why step 3 clocks from `run_started_at` and not `createdAt`: re-runs.** On a
first-attempt run the two are identical, so this changes nothing on the
ordinary path. It matters when a build is cancelled and re-run — the merge
queue re-forms lanes on every invalidation, and a re-run's `created_at` still
points at the *original* dispatch. Clocking from it charges the new attempt
with all the dead time since, which on the one measured instance was **113.2
min** of already-elapsed clock before the attempt had run for a second. That
fails toward dequeuing a **healthy** entry. `run_started_at` tracks the
attempt that is actually running, so it cannot.

⚠ **A previous revision of this file justified the same rule with "runner
supply is no longer instant — two runs waited 113.2 min for a runner", and
that was wrong.** Those two runs are `run_attempt: 3`; their first attempt
started with *zero* wait (`run_started_at == created_at == 19:07:44Z`) and the
113.2 min is the span to a manual re-run at 21:00:53Z. The field never
measures runner wait (see the stall counter below). The prescription survived
the correction, the reason did not — which is exactly why this section is only
a justification. Step 3 is the procedure: if the two ever disagree again,
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
what the threshold is about. (The retracted 2026-10-05 row below was two runs
and would have counted as **one** — the unit rule was right even though the
row itself did not qualify.)

**A row qualifies when** the `merge_group` run was dispatched and sat unable
to start for want of a runner. ☠️ **Do not measure that with
`createdAt → run_started_at`. That gap is re-run delay, not runner wait, and
it is structurally incapable of detecting a runner-supply stall.** Over 1000
`merge_group` `pr.yml` runs (2026-08-20 → 2026-10-06) the gap is non-zero on
exactly 7, and all 7 are `run_attempt > 1`; it is **0.0 on every one of the
993 first-attempt runs**, no matter how long the runner took. The reason is
in step 3's table: `run_started_at` is a copy of `created_at` until a re-run
happens, so on the only attempt that could show a wait it is pinned to zero
by construction. An earlier revision of this file used that gap as the
qualifying test and classified the 2026-10-05 re-run pair as a supply
incident; both readings were wrong.

Runner wait lives at **job** level, and it is **every job, not the first**:

```
gh api repos/Blockcast/paperclip/actions/runs/<id>/jobs?per_page=100 --paginate \
  --jq '.jobs[]|select(.status!="queued" and .started_at)|[.created_at,.started_at]|@tsv'
```

Two filters, both load-bearing, both the same defect in different clothes:

- **Every job, not the first.** A `pr.yml` merge-group run has ~17 jobs, so
  `[.started_at]|sort|first` reports the *luckiest* acquisition in the run — a
  min-of-17 estimator, structurally blind to pool pressure in exactly the way
  `run_started_at` is. An earlier revision of this section prescribed that and
  measured p50 12s / p90 41s / max 50s from it. Those numbers are real and the
  method is wrong; see the correction below.
- **Exclude `status == "queued"`.** A job that has not acquired a runner yet
  reports `started_at == created_at` — a placeholder, not an acquisition, the
  same pin-to-zero shape as `run_started_at` one level down. Left in, every
  job still waiting contributes a **zero**, so the metric is biased low
  precisely when the pool is most saturated. Measured 2026-10-08 the dilution
  was p50 173s → 137s with only 39 placeholder rows in 523; it scales with how
  much is in flight when you sample.

`created_at` at job level is stamped when the job is **unblocked**, not when
the run is dispatched, so this gap contains no `needs:` time. Verified on run
`37786264532`: the three first-wave jobs are created `13:40:49Z`, and every
second-wave job is created `14:01:25Z` — `policy`'s `completed_at` to the
second.

Measured 2026-10-08 over 30 merge-group builds (2026-10-06 → 10-08, n=484
jobs after filtering): **p50 173s, p90 1386s (23.1 min), max 3215s
(53.6 min)** — minutes to tens of minutes, not seconds. The margin against
step 3's 150 min threshold is **~2.8×**, not the ~180× an earlier revision
claimed off the min-of-N method, and not the 1.3× the revision before that
claimed off `run_started_at`.

⚠ **The floor for a row here is a whole run sitting `queued` ≥ 10 min with
no job started at all.** Read it as "nothing has started", not "something is
slow" — p90 per-job wait is 23 min, so 10 min of *job* wait is ordinary and
the old "far outside anything observed" justification no longer applies.

☠️ **150 min is a dequeue-decision threshold and is NOT the ARC eviction
threshold.** The two are unrelated numbers and the eviction threshold has
never been measured here. Everything available says there is headroom — 0 of
484 waits came near it — so this is a measurement gap, not a suspected
problem. Do not cite 150 min as evidence about pool eviction.

There is no cheap sweep for this (it is one extra API call per run), which is
fine: the counter takes a row per *incident*, and the cheaper front-line
signal is the one the 2026-08-26 case actually turned on — a `merge_group` run
`queued` with **zero runner pods in its target scale set**.

| date | evidence | runner wait |
|---|---|---|
| 2026-08-26 | [BLO-27641](/BLO/issues/BLO-27641) — zero `arc-merge-queue` pods after a listener restart; merge cadence ~45 min with a 3h20m hole at 14:29Z→17:49Z | genuine supply stall |
| ~~2026-10-05~~ | ~~`pr-2228` + `pr-2224`~~ — **retracted**: both are `run_attempt: 3`; attempt 1 started at `19:07:44Z` with zero wait and the 113.2 min spans two cancellations and a manual re-run by `kkroo` at `21:00:53Z` | not a supply stall |

**As of 2026-10-06 that is one incident on record, ~6 weeks back**, so the
decision does **not** flip. Note this is one *fewer* than the previous
revision counted, and the retraction moves the trailing-month count to
**zero** — the hazard rate is lower than that revision asserted, not higher.

### 2-lane invalidation fan-out (new since BLO-36439 raised `max_entries_to_build` to 2)

An eviction invalidates every lane stacked behind it, so **all lanes re-form
at the same instant** and the builds they were running are cancelled. At
1 lane one eviction cancelled one build; at N lanes it cancels up to N.

Measured 2026-10-05, the `#2214` eviction (`removed_from_merge_queue` by
`github-merge-queue[bot]` at 19:07:40Z): 3 builds cancelled in one 25-min
window (`pr-2214` twice, `pr-2228` once), both lanes re-formed at
19:07:44/45Z, those attempts were cancelled too, and the pair was finally
re-run **manually by `kkroo` at 21:00:53Z** and succeeded.

☠️ **Before reading a cancellation spike as parallelism cost, rule out a red
base.** A red base produces a cancellation spike *as a downstream symptom*:
each entry fails on the base's defect, is evicted, the group re-forms, and the
healthy neighbours' in-flight builds are cancelled. The cancellations are real
and the fan-out mechanism described here is genuinely what produces them — but
the cause is upstream and no amount of parallelism tuning touches it. This
section is the nearest thing a reader will find, which is exactly why it has
misled: see "The base is red" above for the one query that separates them.
2026-10-07 is the worked case — **60% of that day's builds cancelled (54/90)**
against 0–7% every other day in the window, entirely from one red `master`.
([BLO-41267](/BLO/issues/BLO-41267) records 19/44 for the same day; that was a
mid-incident snapshot taken while it was still running, and 54/90 is the
complete day.)

**This is a cost of parallelism, not a regression to back out** — and the
measured cost is modest once the red-base day is set aside. Cancelled share of
`merge_group` `pr.yml` builds, per day (measured 2026-10-08T14:0xZ):

| day | lanes | builds | cancelled | |
|---|---:|---:|---:|---:|
| 2026-09-26 → 10-02 | 1 | 140 | 2 | **1.4%** |
| 2026-10-04 | 2 | 43 | 0 | 0.0% |
| 2026-10-05 | 2 | 43 | 3 | 7.0% |
| 2026-10-06 | 2 | 42 | 0 | 0.0% |
| ~~2026-10-07~~ | 2 | 90 | 54 | *60.0% — red base, not fan-out* |
| 2026-10-08 (partial) | 2 | 34 | 9 | 26.5% |

**1-lane baseline 1.4% (2/140); 2-lane excluding the red-base day 7.4%
(12/162)** — a ~5× rise, well short of the
[BLO-22289](/BLO/issues/BLO-22289) cascade signature the issue asked for.
Net drain went 17.3/day → 40.0/day and depth 108 → 27, so the trade is a good
one at this ratio.

⚠ **Two days get dropped from that figure and only one of them may be.**
Dropping 10-07 is sound — it is a red base, a different mechanism, named above.
Dropping 10-08 is not: its 9 cancellations are at 03:15–04:12Z, **eleven hours
after** [#2290](https://github.com/Blockcast/paperclip/pull/2290) fixed the
base at 16:31Z, so the red-base explanation does not reach them. They are
ordinary fan-out around a single bad entry — `pr-2269` failed at 02:52Z, after
which `pr-2272` re-formed across 4 bases and `pr-2297` across 3, green again by
04:19Z. Bounded re-formation while merges continue (45 in 24h, depth 8), which
is the shape this section describes working as intended. An earlier revision
recorded 2.3% by quoting 10-04→10-06 only; that window ends the day before both
of these and understates the steady state.

**Cancelled builds are wasted runner-seconds, so this is a capacity cost as
well as a latency one.** A 7.4% cancel rate is a plausible contributor to the
p90 23-minute per-job runner wait measured in the stall counter above — the two
sections are measuring opposite ends of the same pool. Neither figure is near a
threshold today; they are worth watching together rather than separately.

⚠ **An earlier revision of this section reported that both lanes "waited
113.2 min for a runner" and recommended raising `arc-merge-queue`'s minimum
warm pool. The 113.2 min figure is retracted.** The two runs are
`run_attempt: 3`; attempt 1 started at 19:07:44Z with
`run_started_at == created_at`, i.e. **zero** recorded wait, and the 113.2 min
is the span from that first dispatch to the manual re-run. That retraction
rests on the attempt evidence alone and is unaffected by anything below.

**The warm-pool recommendation is withdrawn as unsupported, which is not the
same as refuted.** A revision between the two cited p50 12s / max 50s against
it; those figures came from the min-of-N method and are themselves corrected
above to **p50 173s, p90 1386s, max 3215s**. Tens of minutes of per-job wait is
not evidence that the pool is comfortable — it is simply not evidence either
way, because nobody has measured the pool's eviction threshold (see the stall
counter). Do not cite this paragraph as showing the warm pool is fine. The real
exposure from an N-wide re-form is **cancelled build-minutes**, bounded by the
share above; if it becomes expensive, the first lever is reducing invalidations
(fewer evictions, `ALLGREEN` grouping already helps), and the warm pool is a
live second option that needs the threshold measured before anyone sizes it.

### Counting enqueues over a past window

`mergeQueue.entries[].enqueuedAt` exists only for entries **currently** in the
queue, so the obvious query cannot be run backwards and a 7-day enqueue rate is
not recoverable from it after the fact. The workable method is timeline
`added_to_merge_queue` events over (merged-in-window ∪ currently-queued), then
a sweep of open PRs touched in-window to catch enqueue-then-ejected entries
that neither set contains. That last sweep found 2 of 44 on one run — small,
but it biases toward the reassuring answer (fewer enqueues than really
happened), so it is worth the extra pass. Recorded here so the next person does
not rediscover the dead end.

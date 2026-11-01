# Accepted-interaction outcome (PEN-4409)

Covers `PaperclipAcceptedInteractionActionUnobserved`,
`PaperclipAcceptedInteractionUntracked` and
`PaperclipAcceptedInteractionOutcomeMetricsRefreshFailed`.

## What this measures, and what it deliberately does not do

An accepted issue-thread confirmation records that a decision was **made**.
Nothing recorded whether the action it **authorised** happened. The sweep in
`server/src/services/accepted-interaction-outcome-sweep.ts` closes that by
reading an *agent-declared* `payload.expectedOutcome` and checking it against
state this process already holds.

**The sweep reports only. It performs no writes of any kind** — it cannot
resolve, cancel, re-open or wake an interaction, and it must never be given the
ability to. The records it reads are board and operator decisions; a sweep that
could act on one would be executing a decision nobody delegated to it. If you
are extending this module, that is the line.

## The originating instance

Interaction `f2a8595c-6264-4978-8ebd-de2ee02bb1e3` (PEN-4318) was accepted
2026-10-19T07:01:42Z, authorising the merge of `Blockcast/paperclip#2584`. At
2026-10-20T09:4xZ the PR was still `OPEN` at its original head `3ecdf1dd` —
about 26h45m — and the card still read `accepted`, having emitted nothing.

The innocent explanation does not hold. #2584 did lack an approving review
(`reviewDecision: REVIEW_REQUIRED`), but **4 of 6 sampled PRs that merged in the
same window merged with zero approving reviews**, and #2587 merged 59 minutes
after the acceptance in the identical gate state. No gate was holding it. The
action was simply not done, and nothing noticed, because an accepted decision
whose action never happened was byte-identical to one whose action did.

## `PaperclipAcceptedInteractionActionUnobserved`

A declared outcome has not been observed, and the oldest such card is past
`acceptedInteractionUnobservedAgeSeconds` (default 24h).

1. Find the card. The control-plane log line
   `accepted interactions whose authorised action has not been observed`
   carries `unobservedSample` with the interaction id, issue identifier,
   declared outcome kind and age. **If you cannot read that log line, use the
   API reconstruction below — it needs no log access and identifies the same
   card.**
2. **Check the real object before concluding anything.** `unobserved` is not
   proof the action did not happen — see the ambiguity note below.
3. If the action genuinely has not happened: **do it**, or — if it has gone
   moot — **acknowledge it** (below). Nothing automated will clear this.
   Those are the only two exits. A card whose action is still wanted, still
   authorised, and merely blocked on someone is **neither** — leave it alone
   and let it keep firing. Acknowledging it to quiet the alert records
   "nobody is waiting any more" about a decision somebody *is* waiting on,
   which is the precise failure this feature exists to make visible.

   "Leave it alone" is about the **card**, not about the row. Check whether
   anyone is actually due to look: a target that is `blocked`, or `parked`
   with a far-out `parkedUntil`, has no one scheduled to act, so the card
   sits unobserved for the length of the park and the alert reports an age
   nobody is working off. Observed on PEN-2145 (parked 3 weeks out, its
   acceptance the last activity row on the issue 24 h later, despite
   `continuationPolicy: wake_assignee_on_accept`). Leave the card alone and
   go wake the row's owner — on a parked row a comment is usually enough.

### Finding the card without log access

Step 1's log line is frequently unreachable, and not only for agents. It is
emitted **once at process start and thereafter only on change or hourly**
(`LOG_RELOG_INTERVAL_MS`), so on a busy replica it is already thousands of
lines back; `kubectl logs --tail` cannot reach it and the read-only MCP log
tool has no filter. Agent seats additionally get `pods is forbidden` on
`kubectl logs` outright. Reconstruct the card from the API instead — three
reads, no log access, no database access:

1. **Get the acceptance timestamp from the gauge.** Subtract the age from the
   time the gauge was *refreshed*:

   ```
   paperclip_accepted_interaction_outcome_oldest_age_seconds{bucket="unobserved", company_id="<id>"}
   ```

   ⚠ Subtract from the refresh time, **not** the scrape timestamp. This
   refresh runs on its own `minIntervalMs` (5 min) cadence, so the value is
   up to five minutes stale and the timestamp you derive lands a few minutes
   late.

   Nothing exports that refresh time, so **bound it instead of guessing**.
   Each replica refreshes on its own stagger, so query the series *without*
   collapsing the replicas and use the spread:

   - The replica reporting the **largest** age refreshed most recently, so
     `scrape_ts − max(age)` is the tightest **upper** bound on the acceptance
     instant, and one refresh period (300 s) earlier is the lower bound.
   - Then *confirm* a candidate rather than eyeballing it: for a candidate
     acceptance `t`, every replica's implied refresh `t + age_i` must fall in
     `[scrape_ts − 300 s, scrape_ts]`. A wrong candidate pushes at least one
     replica outside that window, so this is a check and not just an estimate.

   Worked example (PEN-4645): ages `87619.094 / 87599.888 / 87452.287 /
   87381.852` at scrape `2026-11-01T15:32:31Z` bound the acceptance to
   `2026-10-31T15:07:12–15:12:12Z`; the candidate `15:11:45.590Z` implies
   stalenesses of `26 / 46 / 193 / 264 s`, all inside the cadence.

   Do this rather than matching by eye. Acceptances are not evenly spaced —
   this same log holds two **2 s** apart — so "close enough" does not always
   identify one card.

2. **Look the acceptance up in the activity log** and find the entry at that
   timestamp:

   ```
   GET /api/companies/:companyId/activity?action=issue.thread_interaction_accepted&limit=30
   ```

   Newest first; `details.interactionId` and `entityId` (the issue) are the
   two fields you want. ⚠ Keep `limit` at or below ~30 — this filter is not
   indexed, and larger pages reliably hit the statement timeout and return
   `503 statement_timeout` / sqlstate `57014`. (PEN-3596 split that code out
   of `transient_db_conflict`: `57014` is a cancelled statement, not lock
   contention, and used to be reported as "Database contention".)

3. **Read the card** with `GET /api/issues/:issueId/interactions` and confirm
   it: `status: "accepted"`, a `resolvedAt` matching step 1, and a
   `payload.expectedOutcome`. That last field is the declared outcome the
   sweep is checking.

The derived timestamp is the identifying evidence, so state it when you report
the card — the acceptance it lands on should be unique, and the acceptances
on either side of it should be visibly the wrong age.

### Clearing a moot card: acknowledge it, you cannot withdraw it

**An accepted interaction cannot be withdrawn.** `withdrawInteraction` refuses
any interaction that is not `pending`
(`server/src/services/issue-thread-interactions.ts`), and `accepted` is
terminal. An earlier version of this runbook told you to withdraw a moot card;
that instruction named an operation the API refuses, and following it left the
card pinned in `unobserved`.

That mattered more than it sounds. **This alert thresholds the OLDEST age in the
bucket**, so one card whose authorised action legitimately never happens — its
PR closed unmerged, or superseded by a different PR — holds the warning on
forever *and masks every newer unobserved card behind it*. An alert with no
clearing path does not stay strict; it gets ignored.

So record the write-off explicitly:

```
POST /issues/:issueId/interactions/:interactionId/acknowledge-outcome
{ "reason": "superseded by #2601; #2584 closed unmerged" }
```

Agents without a dedicated tool can reach it through `paperclipApiRequest`.
`reason` is required — an acknowledgement with no reason is indistinguishable
from a silenced alarm, and an unrecorded decision is the exact failure this
feature exists to make visible.

What it does and does not do:

- The card moves to the `acknowledged` bucket, leaving `unobserved` (or
  `untracked`), so both alerts above can clear.
- The acceptance itself is **unchanged** — still `accepted`, same `resolvedAt`,
  same `resolvedBy`. This is an annotation saying "nobody is waiting any more",
  not a retraction of a decision that genuinely was made.
- It is written by a **person**, through this route. The sweep only reads it.
  The sweep must never gain the ability to acknowledge a card itself: deciding
  that an authorised action is moot is precisely the kind of decision nobody
  delegated to it.
- It is recorded in `activity_log` as
  `issue.thread_interaction_outcome_acknowledged`, with the actor and reason.
  `paperclip_accepted_interaction_outcome_total{bucket="acknowledged"}` is its
  own series — **a rising acknowledgement rate is itself a signal** that asks
  are being filed for actions nobody intends to take.
- A second acknowledgement is refused. The first one is the record of who wrote
  the action off.

### `unobserved` resolves ambiguity toward the alarm, on purpose

| Declared kind | Observed from | Why absence is not proof |
|---|---|---|
| `github_pr_merged` | `issue_pull_requests.mergedAt`, scoped to the interaction's company | The table is webhook-fed on merge and backfilled only for repos that already have at least one forward-captured PR. A merge this installation never recorded reads `unobserved`. |
| `issue_status` | `issues.status` in the same company, compared as "reached at least this far" along `backlog < todo < in_progress < in_review < done` | Fully in-DB; absence really does mean the status was not reached. A target that moved PAST the declared status still counts as observed, so a declared `in_review` that later reached `done` does not revert to unobserved. `blocked` and `cancelled` are off that ladder and never satisfy a declaration — a cancelled target is a moot card, which is a human judgement for the acknowledgement path above, not an inference the sweep may make. |

⚠ **A bare `#N` does not identify a PR in this installation.** The card's
`ref` carries `repoFullName`, so the declaration itself is unambiguous — the
trap is cross-checking it against the issue's prose, which abbreviates. PEN-2145
is the worked example: `#2868` exists in **both** `Blockcast/paperclip` (a docs
PR, merged 10-20) and `Blockcast/penstock-llm-proxy-core` (the actual carrier,
merged 10-28), and fetching the wrong one returns a plausible merge with the
wrong date. Resolve `#N` against the `ref`'s `repoFullName`, or against a head
sha, never against the number alone.

An outcome `kind` this build has no observer for also reads `unobserved`. That
is deliberate: adding a kind without adding its observer fails toward the alarm,
never toward a false clear. A false alarm costs a look; a false clear is
strictly worse than the silence this replaced, because silence at least does not
claim to have checked.

## `PaperclipAcceptedInteractionUntracked`

`info`. Acceptances are sitting with **no** `expectedOutcome` at all, so nothing
can check them. This is an adoption signal, not an incident — the field is
optional on purpose, because requiring it would break every existing caller.

It is surfaced rather than filtered because a report showing only the cards that
volunteered a reference reads clean precisely by excluding the population the
defect was measured on. `f2a8595c` declared nothing; a sweep that dropped this
bucket would have been blind to the very card that motivated the work.

Resolve by having filing agents populate `payload.expectedOutcome` on
confirmations that authorise a concrete action.

### It measures a trailing-window SHARE, not the all-time oldest card

The alert fires when more than
`prometheusRule.acceptedInteractionUntrackedShare` of the acceptances made
inside the sweep's trailing window (7d) declared no outcome, and only once that
window holds at least `acceptedInteractionUntrackedMinSample` acceptances.

That shape is deliberate and was not the first draft. Thresholding the all-time
`oldest_age_seconds{bucket="untracked"}` — which is what shipped first — could
never be cleared by the adoption it asked for: **every acceptance filed before
this feature existed is permanently untracked and cannot acquire a declaration
retroactively**, so the oldest untracked card is already past any age threshold
on the first tick after deploy and only gets older. It measured the deploy date.
The share of recent acceptances is the number adoption actually moves, and it
reaches 0 once filing agents adopt the field.

A card that will never be declared and never acted on can also be moved out of
this bucket with the acknowledgement route above.

### Why this is declared and never extracted from the card's prose

`f2a8595c`'s payload named, in prose: `#2584`, `#2569`, `3ecdf1dd`, `8b14f0e6`,
`PEN-4318`, `PEN-4284`, `ci.yml:578`, `:1380`, `27.7%`, `02:30–03:30Z`. An
extractor picks one of those. The correct answer, `#2584`, is not the first, not
the most frequent, and not distinguishable by shape from `#2569` — the PR the
*decline* path would have acted on.

A wrong pick produces a card reported as **tracked** while observing the wrong
object, and reported green while the real action never happened. Do not add
prose extraction to this module.

## `PaperclipAcceptedInteractionOutcomeMetricsRefreshFailed`

The sweep is erroring. The bucket gauges keep their last values rather than
being zeroed — an all-zero report reads as "every acceptance has been acted on",
the one wrong answer this sweep exists to prevent — so the two alerts above are
gated off by their own freshness check while this fires instead.

The gauge is initialised to 0 at process start, so a replica that has never
completed a sweep also fires this. **Check whether the scrape collector tick is
running at all before assuming a query fault**: the refresh is registered as
`accepted-interaction-outcome` in
`server/src/services/scrape-metrics-collector.ts`.

Note this refresh runs on its OWN cadence (`minIntervalMs`, 5 min) rather than
every 15 s tick, because its CTE scans every accepted confirmation ever filed
and what it measures moves on human timescales against a 24 h threshold. Its
staleness window is scaled off that cadence, so the gap between two successful
runs is normal and does not fire this alert.

## Adding an outcome kind

Two halves, both required:

1. The variant and its zod schema in `packages/shared/src/types/issue.ts` and
   `packages/shared/src/validators/issue.ts`.
2. Its observer arm in the sweep's SQL.

Ship them together. A kind with no observer is admitted at the ask and then
reads `unobserved` forever, which manufactures a permanent false finding.

`github_pr_approved` is deliberately **absent**. The only approval state the
installation persists is `pull_request_review_state`, which covers *open* PRs
and is pruned once a PR leaves the open set — so an approval observed before a
merge becomes unobservable after it, and the card would flip back to
`unobserved` permanently. Add it when an approval record outlives the PR's open
state, not before.

## `paperclip_interaction_payload_unrecognized_key_total` (PEN-4445)

Companion counter, no alert rule attached. It measures the *filing* side of the
same family: how often an interaction payload carried a top-level key this
server did not recognise and therefore dropped.

Interaction payload schemas parse leniently — zod strips an unknown key and the
create still returns `201`. That is deliberate and was ruled on rather than
inherited. "Tool schema ahead of server" is the default state after any
interaction schema change, because the MCP tool schema is vendored into the
agent image while the handler rolls with `paperclip-api`; refusing the create
during that window would mean the human-decision card is never filed at all,
and for a `toolAction` card that card **is** the approval gate in front of a
write/destructive tool call. A dropped annotation loses tracking; a rejected
create loses the decision.

What changed is that the drop is no longer silent:

- `POST /issues/:id/interactions` returns `unrecognizedPayloadKeys` on every
  `201`, `[]` included. An empty array means this server checked and dropped
  nothing; the field being **absent** means the server predates PEN-4445 and
  can tell you nothing either way. Do not collapse the two.
- This counter records the same thing, labelled by `interaction_kind` and
  `payload_key`, so skew is visible here even when no caller reads the list.

Reading it:

- **Non-zero on a key that matches a field in `packages/shared/src/validators/issue.ts`
  on `master`** — deploy skew. Agents are carrying a newer tool schema than this
  deployment. It clears itself on the next `paperclip-api` deploy (07:23 UTC
  daily); nothing to do unless the key is one whose loss matters, in which case
  the affected cards were filed without it and will not acquire it retroactively.
- **Non-zero on a key that matches nothing** — a misspelling in the filing
  agent's call. `expectedOutcom` for `expectedOutcome` is the worked example.
  Fix the caller; the card itself is fine.
- The two are indistinguishable from the metric alone, which is why
  `payload_key` carries the field name: reading it answers the question.
- `payload_key="_malformed"` is a key name that was not identifier-shaped, and
  `"_overflow"` is this process past its 50-distinct-key budget. In both cases
  the count is still exact and only the per-key split is lost. Either value
  appearing at all is worth a look at *who* is calling, not at the schema.

The counter is written only once the card has been created, so a request
refused by authorization or validation contributes nothing.

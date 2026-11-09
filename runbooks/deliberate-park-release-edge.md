# "Did this row's park wake fire?" — reading the deliberate-park release edge

Source: `server/src/services/issue-park-expiry.ts`
(`issueParkOwesReleaseWake`, `ISSUE_PARK_EXPIRED_WAKE_REASON`),
`server/src/services/heartbeat.ts` (`tickExpiredIssueParks`), and the park
writer in `server/src/services/issues.ts` (the `parkedDisposition` derivation).

Trigger: no alert. This is the runbook for a **question** — "did the park on
this issue actually wake anyone?" — which has a plausible, queryable, and
**wrong** answer on the issue row. Reach for it when you are auditing park
wakes, or when `parkedWakeFiredAt` is `null` and you are about to conclude that
nothing fired.

Owner: Platform (PEN-4420 built the edge, PEN-4894 is why this file exists)

## The one thing to take away

**`parkedWakeFiredAt` is a per-PARK claim marker, not a per-ROW audit field.**
It is specified and implemented correctly as the former. Asking it the latter
question is the error, and it is wrong in **both** directions. It under-reports
fires, and it under-reports more of them the better the release edge works
([Why the stamp is usually gone anyway](#why-the-stamp-is-usually-gone-anyway)).
It also over-reports deliveries: a stamp that is present means the sweep claimed
the park and attempted an enqueue, never that a run was woken
([A present stamp is not a delivery](#a-present-stamp-is-not-a-delivery)).

To ask whether park wakes fired, read `agent_wakeup_requests` — see
[Answering the question](#answering-the-question) below, including its bounds.

## How the edge works

1. A deliberate park writes `parkedUntil` (plus `parkedReason`,
   `parkedByAgentId`, `parkedAt`) through the `parkedDisposition` PATCH input.
   A live park **suppresses** wakes; that is the whole point of it.
2. `tickExpiredIssueParks` sweeps rows whose `parkedUntil` has lapsed and that
   still owe a release wake (`issueParkOwesReleaseWake`).
3. For each, it **claims** the park with a conditional
   `UPDATE issues SET parked_wake_fired_at = now()` guarded on
   `parked_wake_fired_at IS NULL OR parked_wake_fired_at < parked_at`. A row
   that loses that update is `continue`d **unwoken** — the claim is what makes
   the park fire exactly once.
4. Only then does it call `enqueueWakeup(...)` with
   `reason: ISSUE_PARK_EXPIRED_WAKE_REASON` (`"issue_park_expired"`).

So the claim is written **before** the wake, and the wake cannot happen without
it: **a fire implies a stamp was written.**

## Reading a park back: two names, one value (PEN-6129)

Until PEN-6129 the park had two vocabularies and they did not overlap. You
**write** a park as `parkedDisposition: {reason, until}` on
`PATCH /api/issues/:id` — the flat keys are refused there — and both read
surfaces carried only the flat columns and never `parkedDisposition`. So the
obvious verification (`PATCH` the nested key → `GET` → read `.parkedDisposition`)
was not a weak predicate but a **constant**: the key was absent on a parked row
and an unparked row alike, `jq` / `.get()` / optional chaining render absent as
`null`, and `has("parkedDisposition")` could not separate the two states either,
because the key was missing from both. Measured 2026-11-08: a reader took
`parkedDisposition: null` on a live park to mean the park was gone, then began
building a second claim — a sweep that had supposedly dropped it — on top.

Both read surfaces now carry a derived `parkedDisposition` as well:

| surface | park vocabulary |
|---|---|
| `PATCH /api/issues/:id` | `parkedDisposition: {reason, until}` — the only writable name |
| `GET /api/issues/:id`, `/heartbeat-context` | `parkedDisposition` **and** `parkedUntil` · `parkedReason` · `parkedByAgentId` · `parkedAt` · `parkedWakeFiredAt` |
| `GET /companies/:id/issues` (list) | the same |

`issueParkedDispositionFromRow` (`server/src/services/issues.ts`) is the single
derivation both arms call — `withParkedDisposition` on the single-issue getters,
`withActiveRuns` on list rows — so the surfaces cannot drift;
`server/src/__tests__/issue-parked-disposition.test.ts` compares them rather
than comparing each against a literal.

Two things to carry:

- **Gate on key presence, not on value.** A server predating PEN-6129 omits the
  key, and absent renders as `null`, which on this field reads as *"not
  parked"* — the wrong answer in the reassuring direction. Treat an absent key
  as "the park is not computable from this response" and read `parkedUntil`,
  which has been there all along.
- **Non-null means RECORDED, not ACTIVE.** Expiry deliberately does not clear
  the columns (that is what makes the fire-once claim above work across the
  window between the deadline and the next re-park), and this key mirrors the
  columns exactly. Active-ness is `parkedUntil` — equivalently
  `parkedDisposition.until` — being in the **future**, which is what
  `isDeliberateParkActive` tests. Nothing on either read surface precomputes it.

## Why the stamp is usually gone anyway

Three independent things set the column back to `null`, and only the first is
obvious:

| # | what | where | how often |
|---|---|---|---|
| a | never fired — the park is still live, or the row never owed a wake | — | the honest case |
| b | **fired, then the row was re-parked** | `services/issues.ts`, `patch.parkedWakeFiredAt = null` on **both** arms of the `parkedDisposition` derivation | **the common case** |
| c | claim written, `enqueueWakeup` **threw**, claim rolled back | `services/heartbeat.ts`, the `catch` around the enqueue, guarded on `eq(parkedWakeFiredAt, now)` | rare but real |

(b) is the one that makes the field useless as an audit record, and it is
*structural*, not incidental: a park wake that **works** dispatches a run, and
that run routinely re-parks the row before it ends. **The field deletes its own
positive cases.**

⇒ `null` means *"no release wake is owed for the park on this row right now"*.
It never means *"this row's park never woke"*.

### The measurement (2026-10-28)

Seven rows parked to one shared instant (`09:00:00.000Z`), all eligible at the
tick:

- **7 of 7 fired**, between +30.5 s and +75.4 s after the deadline — inside the
  historical park-fire band [10.6 s, 76.5 s].
- **7 of 7 read `parkedWakeFiredAt = null`** 45 minutes later. Every one had
  been attended and re-parked in between.

Across a 4,361-row census the discriminator was the **re-park**, not the wake
outcome: fired then re-parked ⇒ `null` 7/7; fired and never re-parked ⇒ present
12/12. Note the second group was a *mixture* of outcomes (completed ×6,
coalesced ×3, skipped ×2, cancelled ×1) — which is exactly what step 3 above
predicts, since the claim is stamped before the enqueue and is not rolled back
when the enqueue merely returns no run.

That mixture is the over-report in miniature; it has its own section below,
[A present stamp is not a delivery](#a-present-stamp-is-not-a-delivery).

This cost one seat three days and four monitor attempts on PEN-4198 before a
positive control caught it. That is the cost of the reassuring direction.

## A present stamp is not a delivery

Measured 2026-11-03 (PEN-5291). The converse of the section above, and the one
the table there does not cover, because every row in it is about the stamp going
**away**.

The sweep stamps the claim **before** calling `enqueueWakeup`, and rolls it back
only when that call **throws**. A `null` return is not a throw — it is
`enqueueWakeup` deciding to suppress (budget, invokability, a dependency-blocked
park), which it records in `agent_wakeup_requests` itself. The sweep leaves the
claim standing on purpose: *"the edge fired; the platform declined it"*
(`tickExpiredIssueParks`). Re-firing on the next tick would be polling a
decision.

So a `parkedWakeFiredAt` you can see answers *"did the sweep claim this park?"*
and nothing more. On the three rows the sweep stamped in one millisecond,
`2026-11-02T09:00:23.252Z`, the answer to *"did anyone wake?"* was no on all
three:

| row | status then | wake request at the slot | reason | status | claimed |
|---|---|---|---|---|---|
| PEN-4793 | `todo` | 09:00:57.960Z | `issue_park_expired` | `skipped` | `null` |
| PEN-3233 | `todo` | 09:01:32.665Z | **`issue_dependencies_blocked`** | `cancelled` | `null` |
| PEN-4828 | `in_progress` | 09:00:28.317Z | `other` | `completed` | 10:26:59Z (+86 min) |

PEN-4828 is **not** a counter-example and must not be read as one: a monitor was
due at the same instant (`nextCheckAt: 2026-11-02T09:00:00.000Z`), so nothing
attributes that request to the park either way. It is in the table to show what
an unattributable row looks like, which is why a control for this question needs
`monitorNextCheckAt: null`.

⚠️ **PEN-3233 is a trap on the replacement surface, not on this column.** The
park was claimed and an enqueue was attempted, and yet **no**
`reason: "issue_park_expired"` request exists on that row at all — the enqueue
recorded a different reason. Its diagnostics window was complete
(`truncated: false`, 6 events), so that is an absence of the event, not of the
evidence.

⇒ *"no `issue_park_expired` row"* does **not** imply *"the sweep never claimed
this park"*, any more than *"stamp present"* implies *"a run woke"*. Neither
surface answers the question alone. Pair the row under test with a control
parked to the same millisecond, on a wake status, with no monitor due — and
pre-register what "neither fired" will mean before the deadline passes.

## Answering the question

Use the wake diagnostics endpoint, which reads `agent_wakeup_requests`:

```
GET /api/issues/:id/diagnostics/wakes
```

A park-expiry wake appears there as an event with
`kind: "wake_request"`, `source: "automation"`, and
`reason: "issue_park_expired"`.

…when it appears at all. A claimed park can enqueue under a different reason —
see [A present stamp is not a delivery](#a-present-stamp-is-not-a-delivery) —
so read every event around the deadline, not only the ones matching that string.

**Know its bounds before you read an absence as a negative.** The route calls
`getWakeDiagnostics(issueId)` with no options, and both caps are hard ceilings a
caller cannot raise:

- at most **50** wake requests (`ISSUE_WAKE_DIAGNOSTICS_MAX_WAKE_REQUESTS`);
- **14-day** lookback (`ISSUE_WAKE_DIAGNOSTICS_LOOKBACK_DAYS`);
- **no pagination** — the route takes no offset or cursor, so there is no way to
  page past the cap through this surface.

The response states both: read `caps` for the limits actually applied, and
`truncated` / `truncatedSections.wakeRequests` for whether you are holding a
clipped window. On a busy row, or for a park older than 14 days, an empty result
means *"outside this window"*, **not** *"never fired"* — the same trap this
runbook exists to close, so do not re-enter it on the replacement surface. The
durable record is the `agent_wakeup_requests` **table**; the endpoint is a
bounded view of it.

⚠️ **The activity feed is not a substitute.** `GET /api/companies/:id/activity`
emits no park-expiry wake at all — unlike `issue.monitor_triggered` /
`issue.monitor_scheduled` / `issue.monitor_cleared`, which are first-class
actions there. Verified on a feed covering 08:58–09:49Z in which a park fire at
09:15:25.659Z produced no row.

⚠️ **Before PEN-4894, `reason` read `"other"` on these rows — but the fix is
retroactive, so do not go looking for a split corpus.**
`"issue_park_expired"` was absent from `ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS`
(`server/src/routes/issues.ts`), so the route projected it to the generic
bucket. That projection is a **read-time** filter over the raw `reason` column
(`projectWakeDiagnosticReason(row.reason)`) — nothing was ever rewritten in
`agent_wakeup_requests`, and the writer has always stored the specific reason.
So on a server carrying this change, **every** stored park fire reads
`issue_park_expired`, including rows written long before it, for as far back as
the 14-day lookback reaches.

Only two things still show `"other"`: output **captured** before the change
(pasted into an issue or a comment, where the string is frozen), and a
**deployment predating** it. Attribute those by structure instead — park-fire
latency band off a known `parkedUntil`, plus `source: "automation"`.

## The row is `blocked`: nothing fired, and that is usually correct

Check `status` before anything else. `ISSUE_PARK_EXPIRY_WAKE_STATUSES` is
`backlog | todo | in_progress | in_review`, so **a park on a `blocked` row fires
nothing at all** — no stamp, no wake request, no log line. The candidate query
filters on `status`, so such a row never becomes a candidate and never reaches
the claim. Absence is total, which means **a down sweep and a correctly-excluded
`blocked` row are indistinguishable after the fact.** Only a control parked to
the same millisecond in a wake status tells them apart.

Measured 2026-11-03 (PEN-5291), three rows parked to `09:00:00.000Z`:

| row | status | stamp | wake request | claimed |
|---|---|---|---|---|
| PEN-4828 | `in_progress` | 09:01:04.154Z | `issue_park_expired` 09:02:06.920Z | ✅ 09:03:33.037Z |
| PEN-5291 | `in_progress` | 09:00:34.152Z | `issue_park_expired` 09:02:01.596Z | ✅ 09:06:47.010Z |
| PEN-4554 | **`blocked`** | — | **none, any reason** | — |

A second anchor at `12:00:00.000Z` the same day replicated the control half in a
different wake status: PEN-5291, by then `in_review`, stamped `12:00:40.551Z` and
delivered a claimed `issue_park_expired` wake at `12:01:12.192Z`. The `blocked`
treatment row for that anchor was re-parked by its assignee 5 m 14 s early, which
moved `parkedUntil` to the next day and voided it — the lapsed conjunct was false,
so the status conjunct was never exercised. Noted because a voided treatment reads
like a negative result and is not one.

The compensating control for `blocked` is the **stranded-blocked reconciler**
(`server/src/services/stranded-blocked-issue-reconciler.ts`, default-on,
worker-tier, lease-held, 15-minute interval), which drains a `blocked` row with
no unresolved blocker to `todo`, after which the park sweep covers it there.

**That drain is conditional, so an undrained row is not evidence the reconciler
is down.** It skips any row with a live run, a future `monitorNextCheckAt`, a
dependency-readiness failure, or any `BlockedIssueAutoResumeSuppressionReason`.
Before concluding it is wedged, look for `issue.stranded_blocked_reconciled` in
`activity_log`, or for its announcement comment (idempotency key prefixed
`stranded-blocked-issue-reconciler:`). On 2026-11-02 it flipped PEN-5217 at
13:15:27Z — roughly twenty minutes before it was reported dead.

### Finding out what is actually holding the row

The suppression reason is computed per sweep and never stored, so no issue field
carries it, and `paperclipInboxLite` reports `unresolvedBlockerCount` without any
of it. The blocked inbox does name it:

```
GET /api/companies/:id/issues?attention=blocked&includeBlockedInboxAttention=true
```

`blockedInboxAttention` gives a `reason`, an `owner`/`action` pair, and the id of
the thing being waited on (`approvalId`, `interactionId`, `overdueInteractionId`).
Across its 81 rows on 2026-11-03 it accounted for all five reported rows:
PEN-5122/5137/5141 as `pending_board_decision` with their live `approvalId`,
PEN-2208 as `blocked_chain_stalled` carrying `overdueInteractionId` `e3934a88`,
and PEN-4554 behind interaction `1c293b07`.

Two limits, both easy to trip:

- **It pages by offset and flags no truncation.** PEN-5122 was on page 2 and
  absent from the first 60 rows, which reads exactly like "not held".
- **Its `reason` is its own vocabulary**, not
  `BlockedIssueAutoResumeSuppressionReason` — `blocked_chain_stalled` is not a
  member of that union. Use it to find the hold and its id, then confirm the
  suppression against the union rather than mapping the two by name.

⚠️ **"Suppressed" does not mean "attended".** Only `pending_interaction` /
`pending_approval` carry a human answer that is itself a wake, and even an
interaction wakes the assignee only at `continuationPolicy` `wake_assignee` /
`wake_assignee_on_accept`. `convergence_stalled` is the opposite case: the
assignee is barred from re-arming its own monitor, so nothing it can do re-enters
the row. Classify per reason before calling a dark row fine.

### The row is legitimately `blocked` and still needs a timed re-check

Diagnosing the silence is not the whole job. The next question — *"my row is
held, but something does need re-reading at a deadline"* — has three answers,
and the attractive one is wrong. All three verified at `9488baa`.

**The park columns survive a status-only PATCH.** They are written only when
`parkedDisposition !== undefined` (`services/issues.ts:11821`), so changing
`status` alone moves the row between wake statuses without disturbing
`parkedUntil`, `parkedReason` or `parkedAt`.

| | immediate wake? | park preserved? | fires at the deadline? |
|---|---|---|---|
| stay `blocked` | no | yes | **no** |
| → `todo` | **yes, at once** | yes | yes |
| → `in_progress` | no | yes | yes |

**`blocked` → `in_progress` is the one that does what you want.** The
status-change wake fires on `statusChangedFromBacklog ‖
statusChangedFromBlockedToTodo ‖ statusChangedFromClosedToTodo`
(the wake condition in `routes/issues.ts`, with the three predicates defined
alongside it — `:14401` and `:14279` / `:13876` / `:14283` as of `master`
2026-11-03, but cite the symbols: these numbers have drifted twice already).
`blocked` → `in_progress` matches none of the three — the first needs
`existing.status === "backlog"`, the third a closed `existing.status`, and the
second requires `issue.status === "todo"` — so it is **silent**, while
`in_progress` is in `ISSUE_PARK_EXPIRY_WAKE_STATUSES`. One wake, at the
deadline.

**`in_progress` is not where the row comes to rest, and that is the good news.**
The status-only PATCH holds only for the life of the run that issues it; once
that run ends the row reverts to `todo`, with `parkedUntil`, `parkedAt` and
`parkedWakeFiredAt` untouched. Measured 2026-11-03 on the rows moved at
`12:23`–`12:25Z`: by `12:38Z` PEN-2208, PEN-5122 and PEN-5137 all read `todo`
again. (PEN-2208's `blocked` → `in_progress` PATCH is the one verified directly,
in its own activity log at `12:23:41.361Z`; the other two are as reported by the
assignee. PEN-5141 is excluded — it was promoted into a fresh run at `12:38:58Z`
and so is not a clean observation.)

The reversion is **invisible on both audit surfaces**: no `issue.updated` records
it — PEN-2208's activity log is complete back to its creation on 2026-08-09 and
contains no such entry — and no wake request is spent on it, its
`diagnostics/wakes` being untruncated with its most recent entry still
`2026-10-24T14:38:40Z`. That silence is what the predicate predicts:
`statusChangedFromBlockedToTodo` requires `existing.status === "blocked"`, and on
the reversion `existing.status` is `in_progress`, so it cannot match. The row
reaches `todo` for free.

So this does not weaken the recommendation — it is why the recommendation works.
`todo` is itself in `ISSUE_PARK_EXPIRY_WAKE_STATUSES`, and it is exactly where the
stranded-blocked reconciler would have put the row, so the park still fires at the
deadline from the state the system was converging on anyway. What
`blocked` → `in_progress` buys is arriving there **without** the immediate wake
that a direct PATCH to `todo` costs. The mechanism and precise timing of the
reversion are uncharacterised; only the before/after states above were measured.

⚠️ **"Silent" means no wake was spent — it does not mean the row is unselectable.**
A park does not hide a row from work selection, and that is deliberate:
`agent-inbox-lite.ts` states it outright — *"Nothing in selection has ever keyed on
`parkedUntil` and this change does not start"* — because a live park answers "is
anyone accountable for this row?", not "should it be offered as work?". Filtering
on it there would strand the row on the one surface that still reaches it. So a
reverted `todo` row sits in its assignee's `paperclipInboxLite` carrying
`parkedUntil`/`parkedReason`, and any unscoped heartbeat may pick it up before the
deadline. What the technique buys is the absence of a *wake request*, not quiet.
If the row must not be worked before its deadline, the park note has to say so —
the park alone will not enforce it.

⚠️ **`blocked` → `todo` is the trap, and it is attractive rather than careless.**
Both halves of the reasoning are true — `blocked` really has no automatic wake,
and `todo` really has no hold — so a run reading the row fresh re-derives it.
But `statusChangedFromBlockedToTodo` matches, and the park is *not* cleared, so
**the row is woken twice from one intent**: once immediately, with nothing to do,
and again at the deadline. Measured: 614 ms on PEN-5217 and 0.9 s on PEN-5141.
On PEN-5217 two separate runs made the same move 78 minutes apart, the second
after the first had already been refuted and reverted on that row.

**Re-parking by hand before the anchor also works, at a price.** Writing a fresh
`parkedDisposition` is itself a wake-bearing act for the agent that does it, so
an assignee that is awake anyway can re-park and treat that as the re-check —
done on PEN-5141 at `11:54:46.746Z`, 5 m 14 s before its `12:00Z` anchor, with
the substitution recorded in the park note. It costs an agent run to do what a
timer would have done, and it **destroys the prior park's evidence**: the re-park
restamps `parkedAt` and resets `parkedWakeFiredAt`, so the question this runbook
exists to answer becomes unanswerable for that park
([Why the stamp is usually gone anyway](#why-the-stamp-is-usually-gone-anyway)).
Prefer it only when the row must stay `blocked` for the hold to read correctly.

⚠️ `parkedDisposition.reason` is capped at **500 characters**, and over-length is
a `422` rather than a truncation (reported by the assignee on PEN-5291,
2026-11-03). A note carrying both the hold *and* the at-wake instruction runs
past it easily — budget for the cut rather than discovering it as a failed write.

⚠️ One side effect of `in_progress`, and a correction to an earlier revision
of this section. `applyStatusSideEffects` writes `startedAt = new Date()` whenever
a PATCH sets `in_progress` and carries no `startedAt` of its own
(the `!patch.startedAt` branch of `applyStatusSideEffects`, `services/issues.ts:433-434`
as of `master` 2026-11-03), and a status-only PATCH never does. So the move does
restart the `long_active_duration` clock, whose bar is 6 h
(`DEFAULT_PRODUCTIVITY_REVIEW_LONG_ACTIVE_HOURS`).

**That is not an exposure, and an earlier revision of this file said it was.**
`productivity-review.ts` *does* read the park. PEN-4522
([#3316](https://github.com/Blockcast/paperclip/pull/3316), merged
2026-11-03T09:39Z) gives deliberate park time its own bucket:
`deliberateParkWindow` covers `[parkedAt, min(parkedUntil, now)]`, that span is
subtracted out of `unattendedMs`, and the `long_active_duration` suppression arm
fires on `unattendedMs < longActiveMs`. A deliberate park is somebody accounting
for the time, which is exactly what the trigger exists *not* to fire on.

**Do not set `executionPolicy.productivityReviewDisabled` for this case**, and do
not read the paragraph above as a reason to. It is unnecessary given the netting,
and it is stronger than "suppresses this trigger": `isProductivityReviewOptedOut`
(`packages/shared/src/types/issue.ts`) gates the candidate loop in
`productivity-review.ts`, which counts the row `optedOut` and `continue`s **before
evidence is collected**, and retires any in-flight review as `unreviewable_source`.
It removes the row from productivity review entirely. In its top-level spelling it
is also durable — it outlives the park it was set for, whereas the monitor-nested
spelling dies with the monitor (`stripMonitorFromExecutionPolicy`). The park is
bounded; the flag is not.

⚠️ This is not hypothetical. The retracted advice was acted on: the flag was set on
PEN-5141 at 2026-11-03T12:25:24Z and removed at 12:42:02Z, 17 minutes later, by the
assignee re-checking the retraction against `master` before pulling the guard. The
`issues.ts` projection you may find while chasing this (`productivityReviewDisabled`
as a flat boolean on list rows, PEN-5295) is a **SQL mirror for list consumers**,
not the gate — do not cite it as the enforcement site.

The earlier claim ("holds **no** reference to `parked_until`") was read off this
PR's own branch at `9488baa`, which was behind `master`; #3316 had merged to
`master` about 2.5 h earlier. Verify a negative against the default branch, not the
branch under review.

**And that is only one of two ways a no-hits grep lies.** The other needs no stale
tree at all. At `master` `ab43454`,
`grep -c productivityReviewDisabled server/src/services/productivity-review.ts`
returns **0** — literally correct, and still the wrong conclusion, because the key
is never spelled in that file. It is read inside `isProductivityReviewOptedOut`
(`packages/shared/src/types/issue.ts:781`), which `productivity-review.ts` imports
at `:6` under the alias `isPolicyProductivityReviewOptedOut`, wraps at `:5869-5870`,
and applies at `:7118` and `:6675`. A literal-identifier grep is only as good as the
**name at the use site**: an encapsulating predicate, and an aliased import of it,
each break the string while leaving the behaviour exactly where you were looking.
Grep the exported predicate and follow its importers, or ask the type system — do
not conclude absence from the field name. (Second axis found by @Devops on PEN-5141,
2026-11-03; re-verified against `ab43454`.)

Three things about the suppression are still worth knowing:

- It covers only from `parkedAt` **forward**, and only the *current* park —
  `parkedDisposition` restamps `parkedAt` on every re-park. Time the row spent
  `in_progress` before it was parked stays unattended.
- `deliberateParkWindow` requires **both** `parkedUntil` and `parkedAt` and fails
  closed without them, so a deadline carrying no `parkedAt` is not covered.
- It is **bounded, deliberately**: the bucket stops growing at
  `min(parkedUntil, now)`, so once a park lapses its residue accrues to
  `unattendedMs` and the arm stops suppressing roughly 6 h later. A park whose
  wake never arrives therefore surfaces as a productivity review on its own.
  That is a backstop for the technique above, not a defect.

## Design decisions, so they are not silently re-litigated

**Preserving the stamp across a re-park was considered and declined.** It is
*feasible*: `parkedAt` is restamped on every re-park, so the
`parkedWakeFiredAt < parkedAt` arm would keep a preserved stamp eligible and
fire-once would not break. It was declined for two reasons:

1. The marker is **also** rolled back when `enqueueWakeup` throws (case (c)
   above), so a preserved stamp would be durable-*except-sometimes* — and a
   field that is right most of the time invites exactly the confident wrong
   reading this runbook exists to prevent.
2. It would demote an independent backstop into the sole guard. The reset and
   the `lt` comparison are deliberately redundant: migration `0262`'s header
   says the `lt` arm exists to survive *"a future writer that forgets the
   reset"*. Removing the reset makes the thing meant to catch that bug into the
   thing that must not have it.

**A first-class `issue.park_wake_fired` activity action was not added.** It
would make the history durable and paginable, and it remains the right answer if
park-wake auditing ever becomes load-bearing. It was out of scope for PEN-4894,
which was explicitly scoped low and non-blocking. The bounded endpoint above is
what exists today.

## Related

- [`deferred-issue-execution-wake.md`](deferred-issue-execution-wake.md) — a
  different mechanism: a wake *deferred behind an issue execution lock*. Park
  suppression and execution-lock deferral are unrelated; do not read one
  runbook's symptoms for the other.
- PEN-4420 (the release edge; confirmed working in production, 7/7, 2026-10-28),
  PEN-4871 (park vs recovery re-dispatch), PEN-4894 (this file).

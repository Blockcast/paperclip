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
question is the error, and it is wrong in the **reassuring** direction: it
under-reports fires, and it under-reports more of them the better the release
edge works.

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

This cost one seat three days and four monitor attempts on PEN-4198 before a
positive control caught it. That is the cost of the reassuring direction.

## Answering the question

Use the wake diagnostics endpoint, which reads `agent_wakeup_requests`:

```
GET /api/issues/:id/diagnostics/wakes
```

A park-expiry wake appears there as an event with
`kind: "wake_request"`, `source: "automation"`, and
`reason: "issue_park_expired"`.

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

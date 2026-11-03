# An alert row's `status` disagrees between two agents, or its armed monitor vanished

Source: `packages/plugins/paperclip-plugin-alertmanager/src/webhook-handler.ts` (`handleResolved`, `decideRefire`, `ensureCancelWithheldComment`), `server/src/services/heartbeat.ts` (`reconcileUndeliverableIssueMonitors`), `server/src/services/issue-execution-policy.ts` (`buildIssueMonitorEligibilityPatch`, `buildClearedMonitorState`)
Trigger: two agents report contradictory `status` for the same alert-backed issue; or an alert row you armed a monitor on produced no wake and now reads `monitorNextCheckAt: null` with `monitorAttemptCount` unmoved.
Owner: Platform / DevOps (PEN-5343)

## The hazard in one line

**An alert row is a recycled row, not a durable one.** `paperclip-plugin-alertmanager`
cancels it when its alert resolves and reopens it when the alert re-fires, so its
`status` is a sample of a value that changes on its own — and each cancel takes
the assignee's armed monitor with it.

Read `status` on one of these rows and you have measured an instant, not a fact.
Nothing in the response says so.

## How to recognise an alert row

- `originKind` is the alertmanager bridge, the title matches
  `[<severity>] <AlertName> · <service>`, and the creating activity event is
  `Alertmanager: created issue for firing alert "<name>"`.
- Its `issue.updated` events carry `actorType: "plugin"`,
  `actorId: 0e522725-548b-4ff4-9e8c-72fe4ae59aaa`.

## Measured rates (2026-10-19 → 2026-11-02, 14 days)

| | PEN-4365 | PEN-4261 |
|---|---|---|
| plugin-authored status transitions | 64 | 22 |
| transitions to `cancelled` | 32 | 11 |
| shortest resolved interval | 14 min | 8 min |
| median resolved interval | 41 min | ~226 min |
| `issue.monitor_cleared_undeliverable` / `clearReason: "cancelled"` | 9 | 4 |
| of those, paired with a plugin cancel | **9 / 9** | **4 / 4** |
| pairing lag | 3–22 s | 11–26 s |
| monitors that ever fired | 1 of 14 armed | — |

**13 of 13 monitor destructions across both rows paired with a plugin cancel.**
Every one was destroyed before its due time — between 1 h 01 m and 14 h 43 m
early. Eight of the nine on PEN-4365 were at `attemptCount: 0`.

## Rule 1 — never conclude from a single `status` read

A disagreement between two agents about one of these rows is the expected
outcome of two correct reads, not evidence that either measured badly. On
2026-11-02 this cost two runs: a sweep read `cancelled` at 23:17:07Z (correct —
the row had been `cancelled` since 21:46:42Z), the plugin reopened it to `todo`
at 23:20:41Z, and a second agent read `todo` at 23:32:09Z and filed a
refutation (also correct). Both were right about different instants 3 m 28 s
apart, and each concluded the other had failed to measure.

**Before you route, escalate, or refute anything on an alert row, read its
transition history, not its current status:**

```
GET /api/issues/{issueId}/activity
```

Filter `action == "issue.updated"` and keep the events whose
`details.patch` contains `status`. If the row has flipped within the window you
are reasoning about, say so explicitly in whatever you file — and quote the
timestamp of your read beside the value.

A single read is still fine for anything that does not survive the read: acting
on the row right now, in this run. It is reading a status *and carrying it into
a later conclusion* that is unsound.

## Rule 2 — an armed monitor on an alert row is not a durable observer

The cancel is a plain `status: "cancelled"` write. `reconcileUndeliverableIssueMonitors`
then finds a row carrying `monitorNextCheckAt` in a status that cannot deliver a
wake, and clears the monitor — correctly: a cancelled row genuinely cannot fire.
The loss is silent by construction. It consumes no attempt, so
`monitorAttemptCount` does not move and no budget signal is raised.

The plugin **does** protect a row held by a live execution run — it pins
`expectedCurrentCheckoutRunId`/`expectedCurrentExecutionRunId` to `null`, so the
cancel fails its precondition and posts an `auto-cancel withheld` comment
instead (BLO-29908, verified working on 2026-11-02 at 23:30:41Z). That withhold
is keyed on a live holder, so it is inert in exactly the window — **between
runs** — where the monitor is the row's only observer.

So: **do not park multi-run investigation context on an alert row's monitor.**
If the follow-up outlives the alert, give it its own issue and arm the monitor
there; link the alert row to it. The alert row can then be cancelled and
recycled without taking your wake with it.

## Rule 3 — to tell "monitor destroyed" from "never armed", read the nested state

The top-level columns cannot distinguish them. After a clear,
`monitorNextCheckAt` and `monitorNotes` are `null` and `monitorAttemptCount`
is unchanged — identical to a row that never armed anything.

`executionState.monitor` does distinguish them, and nothing that sweeps
alert rows reads it:

```jsonc
"executionState": {
  "monitor": {
    "status": "cleared",
    "clearReason": "cancelled",      // the plugin's cancel destroyed it
    "clearedAt": "2026-11-02T21:47:03.771Z",
    "clearedNextCheckAt": "2026-11-03T12:30:00Z",  // the wake that was owed (PEN-5343)
    "notes": "...",                  // the armed monitor's notes survive here
    "attemptCount": 1
  }
}
```

- `clearReason: "cancelled"` + `clearedAt` — an armed monitor was destroyed.
- `clearedNextCheckAt` — **when it was due.** Added by PEN-5343; before that
  the due time was recoverable only by diffing the activity feed.
- `monitor: null` or absent — no monitor was ever armed.
- `clearedNextCheckAt` absent on a `cleared` monitor — the row was cleared
  before PEN-5343 shipped. That means **not recorded**, not "no wake was owed".
  The two are kept apart on purpose: the validator leaves the key optional
  rather than defaulting it to `null`, so parsing and re-persisting an old row
  cannot quietly turn "we never recorded this" into "nothing was owed".
- `clearedNextCheckAt: null` on a `cleared` monitor — a clear ran and found no
  due time. Distinct from absent, above.
- On a row cleared more than once, `clearedNextCheckAt` belongs to the **first**
  clear, not to the `clearReason`/`clearedAt` printed next to it: a re-clear
  carries the original forward instead of overwriting it, so a wake destroyed
  by a `cancelled` clear and later re-cleared as `done` still shows the
  `cancelled` clear's due time. Read it as *the earliest wake this row is known
  to have lost*; attributing a loss to a specific clear still needs the
  activity feed.

Re-arming after a destroyed wake is a normal recovery; note in the new
monitor's `notes` that the previous one was lost, so the next reader does not
count the gap as idleness.

## What this runbook deliberately does not do

It does not stop the monitor being destroyed. Damping the flap was evaluated
against the measured intervals and **rejected as the primary fix**: a 60-minute
hold-down would have suppressed 21 of 32 cancels on PEN-4365 but only 5 of the
13 monitor destructions across both rows (4/9 and 1/4), because most losses
follow a genuine multi-hour resolve rather than a short flap. Preserving the
monitor across the plugin's cancel/reopen recycle is tracked separately; this
runbook is what protects a reader until that lands.

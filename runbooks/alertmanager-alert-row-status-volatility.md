# An alert row is machine-owned: its `status` flips, its `description` is replaced, and the monitor / park you left on it vanishes

Source: `packages/plugins/paperclip-plugin-alertmanager/src/webhook-handler.ts` (`handleResolved`, `decideRefire`, `describeAggregate`, `ensureCancelWithheldComment`), `packages/plugins/paperclip-plugin-alertmanager/src/issue-mapping.ts` (`buildIssueDescription`), `server/src/services/heartbeat.ts` (`reconcileUndeliverableIssueMonitors`), `server/src/services/issue-execution-policy.ts` (`buildIssueMonitorEligibilityPatch`, `buildClearedMonitorState`), `server/src/services/issue-park-expiry.ts` (`issueParkOwesReleaseWake`, `ISSUE_PARK_EXPIRY_WAKE_STATUSES`)
Trigger: two agents report contradictory `status` for the same alert-backed issue; or text you wrote into an alert row's `description` is not there any more; or an alert row you armed a monitor on produced no wake and now reads `monitorNextCheckAt: null` with `monitorAttemptCount` unmoved; or an alert row you parked produced no wake at its due time and still reads `parkedWakeFiredAt: null`.
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

PEN-5346 puts a net under this, but it is a net and not a licence: a destroyed
wake now reappears as a `stranded_issue_recovery` row assigned to you (see the
last section). That costs you a round trip and the recovery row carries the
monitor's `notes` rather than its schedule, so the wake arrives when the sweep
runs — not at the due time you armed. Arming on a row of your own is still
strictly better; the carrier exists for the case where you did not.

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
    "recoveryEmittedAt": null,       // the handoff is still owed (PEN-5346)
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
- `recoveryEmittedAt` on a `cancelled` clear — `null` means the handoff has not
  been emitted yet and the sweep will retry it; a timestamp means a recovery
  issue exists and carries this row's obligation. Find it with
  `originId == <this row>` and `originFingerprint == "issue_monitor:cancelled"`.
  It is never carried forward from an earlier clear, so it always refers to the
  clear printed beside it.
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

## Rule 4 — a `parkedUntil` on an alert row is not attendance either, and unlike a monitor nothing hands it back

A park is the *other* attendance mechanism an agent can leave on a row, and the
cancel destroys it by the same route: `issueParkOwesReleaseWake`
(`server/src/services/issue-park-expiry.ts`) opens with
`if (!isIssueParkExpiryWakeStatus(issue.status)) return false`, and
`ISSUE_PARK_EXPIRY_WAKE_STATUSES` is `["backlog", "todo", "in_progress",
"in_review"]`. `cancelled` and `done` are both outside it. So from the instant
the plugin cancels, the park owes no wake — whatever its due time says.

**The park is the dominant attendance mechanism on exactly these rows.** The
plugin's own escalation ladder records it: of the six open alertmanager-origin
rows measured 2026-11-07, five were attended *solely* by a park
(`attendance-read.ts`, `SUMMARY_CAVEATS`).

### Why this is worse than the monitor case, not the same

Rule 2's loss is silent but it leaves forensics and, since PEN-5346, a carrier:
the monitor is **cleared**, stamped `clearReason: "cancelled"`, and handed to a
recovery row. The park gets none of those three. Nothing clears it, nothing
stamps it, nothing hands it back — and because nothing clears it, **all four
park fields survive intact**. `parkedUntil`, `parkedReason`, `parkedAt` and
`parkedByAgentId` on a dead park are byte-identical to a healthy one.

A cleared monitor at least reads as cleared. A dead park reads as attended on
every surface there is.

**PEN-4729 is the whole asymmetry on one row, from one cancel.** Cancelled
2026-10-26T01:26:13Z, 7 h 34 m *before* its park was due:

- its **monitor** was cleared `clearReason: "cancelled"`, stamped
  `recoveryEmittedAt: 2026-11-11T22:07:39Z`, `recoveryDisposition:
  "recovery_issue"`, and carried to PEN-6538 — which was worked and closed;
- its **park** (`parkedUntil: 2026-10-26T09:00:00Z`, `parkedWakeFiredAt:
  null`) is still sitting there untouched, **16.9 days overdue**, and no sweep
  has ever looked at it.

Same row, same cancel, same instant. One obligation recovered, one dropped.

### The wake you eventually get is coupled to the alert, not to your due time

A lapsed park is not discarded — it is suspended. The moment the plugin
reopens the row to `todo`, the status conjunct passes and the long-expired park
fires within seconds. On PEN-4881 that was **15 s after the reopen and 12 d
21 h after the due time**.

So the delay is bounded by the alert's own re-fire schedule and by nothing
else, and it is **unbounded in the one case that matters**: a subject that is
genuinely broken but has stopped being noisy produces no re-fire, so the park
never fires at all. PEN-4881 was parked explicitly to outlast a node that had
gone quiet *without* recovering — the park was killed by the quiet it was set
to see through.

### Measured incidence (2026-11-12, all 94 alertmanager-origin rows in PEN)

| | |
|---|---|
| rows carrying a park (`parkedUntil` non-null) | 22 |
| of those, in a terminal status — park cannot fire | 13 |
| of those, lapsed, agent-assigned, and never fired for this park | **6** |
| oldest | PEN-4729, **16.9 days** overdue |

The 6 apply every conjunct of `issueParkOwesReleaseWake`, so they are blocked
by the status term alone. PEN-5719 is the discriminating control: lapsed and
never fired, but `todo`, so it will fire — the count separates "dead" from
"owed for some other reason" rather than counting all lapsed parks.

### To tell a dead park from a healthy one

There is no nested state to read, as there is for a monitor in Rule 3 — the
columns are all you get, and they look fine. The test is the conjunction:

```
status NOT IN (backlog, todo, in_progress, in_review)
  AND parkedUntil IS NOT NULL
  AND assigneeAgentId IS NOT NULL AND assigneeUserId IS NULL
  AND (parkedWakeFiredAt IS NULL OR parkedWakeFiredAt < parkedAt)
```

`parkedWakeFiredAt` is per-PARK, not per-row, which is why the comparison is
against `parkedAt` and not a null check alone.

### So: do not use a park as the only observer on an alert row

Same remedy as Rule 2, and for the same reason. If the follow-up outlives the
alert, give it its own issue and park *that*; link the alert row to it. A park
is safe on an alert row only for something you are also holding open some other
way — a live `blockedBy` edge, a pending card, or a row of your own.

If you park one anyway, say so in the `parkedReason`, because the next reader
cannot tell from the fields.

### What is NOT yet built

**There is no park equivalent of PEN-5346.** No sweep selects a parked
terminal row, nothing stamps the obligation as owed, and no carrier is emitted.
The six rows above are owed wakes that nothing will ever deliver.

One note for whoever builds it: the park needs no PEN-5343-equivalent first.
The due time a monitor loses on clear is exactly what PEN-5343 had to start
recording — but `parkedUntil` *survives the cancel*, so the park's own due time
and its `parkedReason` are already persisted and already readable. What is
missing is only the sweep and a place to stamp "handed off", so that it is
re-drivable and does not re-emit.

Carried on PEN-6556.

## Rule 5 — the `description` is machine-owned ABOVE the notes marker; record below it, or in a comment

**The firing path re-renders this column on every delivery of a still-firing
alert.** `decideRefire` returns `{kind: "refresh"}` for *every* non-terminal row
— there is no has-it-changed test and no diff — and the `refresh` branch writes a
`description`, where the rendered half comes from `describeAggregate`: a pure
render off the `aggregate_members` table. The terminal and reopen/rebind branches
write it the same way.

⛔ **AMENDED 2026-11-11 (PEN-6218), and the amendment reverses this rule's
strongest claim.** Until PEN-6218 this section read *"replaces this column
wholesale … and never reads what it replaces"* and *"the row's current body is
never an input"*. **Both are now false.** Every description write in
`webhook-handler.ts` goes through `composeDescription(rendered, current)`
(`description-notes.ts`), which **takes the current body as an input**, carries
forward verbatim everything below `AGENT_NOTES_MARKER`
(`<!-- paperclip-plugin-alertmanager:notes-below -->`), and renders a banner
immediately above the marker telling the reader so.

✅ **Deployed, and dated first-party rather than assumed** — a merge is not a
deploy. On PEN-6292's own field revisions the step is exact: rev 32
(`2026-11-11T07:42:00Z`, 10,305 B, **no** marker) → rev 33 (`08:47:03Z`,
10,688 B, **marker present**), **+383 bytes**, and the marker persists on 4 of 4
revisions since. ⇒ PEN-6218 went live between **07:42:00Z and 08:47:03Z on
2026-11-11**.

⭐⭐⭐ **Read the correction for what it changes and what it does NOT.** The
measurement below is untouched and still correct: the column is still written by
a machine on every delivery, and the authorship signature is identical before and
after PEN-6218 — **12 of 12 null-authored revisions straddle the deploy**. That is
the trap worth carrying: **machine-AUTHORSHIP and total REPLACEMENT are different
properties, and a revisions census only sees the first.** A detector that returns
the same answer on both sides of a content-policy change cannot, by itself,
license *"never record anything there"*. ⇒ establish the writer's content policy —
here, read the body for the marker — before concluding depth 0 is refused.

Measured on PEN-6292, 2026-11-10 (`paperclipListIssueFieldRevisions`):

| | |
|---|---|
| field revisions in one day | 10 |
| distinct `description` sha256 across them | **1** |
| spacing | 65 min × 6, plus one 55 and one 40 — every delta within 3 s of a multiple of 5 min |
| revisions with `createdByAgentId` AND `createdByRunId` null | **10 / 10** |

**The cadence is Alertmanager's, not the plugin's — nothing in this plugin
polls.** Read the spacing as a bound, not a period: the only claim the code
supports is *one write per delivery of a still-firing alert*, and how often
that is depends entirely on the route's `group_interval` / `repeat_interval`.
The 5-minute quantum above is consistent with a `5m` group tick and a `1h`
repeat, which would put the mode at 65 min and make the shorter gaps extra
deliveries after a membership change — but that is **inferred from the
spacing**; the Alertmanager route config was not read (`AlertmanagerConfig` is
forbidden to the read-only service account, and
`Blockcast/onprem-k8s:monitoring/alertmanager-configmap.yaml` was not fetched
before the GitHub `core` budget ran out). Do not quote 65 min as a property of
anything; quote *every delivery*.

**Why the usual care does not help.** PEN-6292's assignee recorded an operator
procedure at depth 0, re-read it on an independent GET, and said so in writing.
It was gone by morning. The write succeeds, the same-run verification succeeds,
and a third party destroys the content after the run has ended — so there is no
check available *inside* the writing run that can detect this. It is the same
shape as an ephemeral-storage bug, and the note left behind is worse than
silence: it tells the next run a record exists, so nobody re-derives it.

**Establish the carrier before you trust depth 0, on any row you did not
create.** `paperclipListIssueFieldRevisions(<row>)`; a run of revisions
carrying **both** `createdByAgentId` and `createdByRunId` null, at a regular
cadence, is a machine-owned field. That read is the only instrument that
settles it, and it settles it for any writer rather than for a list of plugins
somebody has to keep current.

⛔ **If you record below the marker, APPEND — do not PREPEND.** The generated
*Recording a constraint* directive says *"PREPEND your constraint block and keep
every existing byte"*, which is right on a row an agent owns and is the one act
that loses the write here: `composeDescription` returns
`<render>` + `<banner>` + `<marker>` + `<notes>`, so position 0 is inside the
re-rendered half and the durable half is at the **foot** of the body. The two
instructions are reachable in either order and each is correct about its own
case, which is why the directive's machine-owned clause now names the inversion
explicitly.

⚠️ **Which rows have the marker, and why that matters for a legacy body.** A row
acquires the marker on its next delivery and keeps it; until then its body is
legacy, and `preservedNotes` can only rescue an append on it through the
`current.startsWith(<render>)` prefix match. That match is sensitive to **any**
change in the rendered text, so a renderer change silently retires the rescue
for exactly the rows it exists for. Measured 2026-11-11T13:2xZ, the day PEN-6218
deployed, across all **107** alertmanager-owned rows in this company:

| | |
|---|---|
| carrying the marker | **17** |
| no marker (legacy) | **90** — 71 `cancelled`, 16 `done`, 3 `todo` |

⇒ the legacy population was **84%** of the estate at that instant, so this is a
live concern and not a theoretical one. `legacyRenderHeads` in
`description-notes.ts` buys back exactly one renderer change — the
machine-rendered notice — and is not a general solution, because there is none.

**Where to put it instead**, in order:

1. **below the notes marker** on this row — carried forward verbatim across
   every sync, and the half the row's own banner points at (append, never
   prepend);
2. the **artifact's own durable text** — a PR body is not regenerated, and is
   usually also the surface the human actor reads;
3. a **comment** on the alert row — append-only, and it survives every rewrite
   above;
4. **`monitorNotes` on a monitor armed on a row of your OWN** — 500 chars,
   and it is what the next woken run reads first.

⛔ **Not this row's monitor.** `monitorNotes` here survives the description
rewrite and *not* the cancel: when the alert resolves the plugin cancels the
row, the monitor is cleared as undeliverable, and the notes are nulled with it
— 13 of 13 destructions above, each paired with the plugin's own cancel, every
one before its due time. So on the alert row it is a within-incident
scratchpad, never the durable carrier. This is Rule 2 restated for the carrier
question, and the two have to be read together: a list that offers
`monitorNotes` as somewhere safe routes the record straight back into the
carrier Rule 2 forbids, one silent destroyer over.

Say in the comment that depth 0 was refused and why. Absent that, the next
reader has no way to tell a carrier that was ruled out from one nobody tried.

The generated *Recording a constraint* directive carries this carve-out
(`server/src/services/heartbeat.ts`), and the rendered body carries a notice of
its own at the top (`MACHINE_RENDERED_NOTICE` in `issue-mapping.ts`) for the
readers a directive cannot reach. Neither is a fix: the column is still
replaced. See PEN-6404.

## What this runbook deliberately does not do

**It does not stop the monitor being destroyed, and neither does PEN-5346.**
The cancel is still a plain `status: "cancelled"` write, the eligibility
reconciler still clears the monitor, and the wake is still gone. What PEN-5346
added is a *carrier*: the obligation that monitor represented is handed to a
row that survives the cancel, instead of being dropped.

`reconcileCancelledIssueMonitorRecoveries` sweeps for cleared monitors whose
`clearReason` is `"cancelled"` and whose `recoveryEmittedAt` is still null. For
each one whose obligation can still be live — see the horizon below — it opens a
recovery issue:

- title `Carry forward the wake cancelled on <source identifier>`, falling back
  to the source's title when it has no identifier;
- `originKind: "stranded_issue_recovery"`, `originId` the cancelled row,
  `originFingerprint: "issue_monitor:cancelled"`;
- `status: "todo"`, `priority: "high"`, assigned to the **source row's
  assignee**;
- body carrying the dead monitor's `notes`, its `gateSignals`, its
  `attemptCount`, and an explicit instruction to check whether the cancelled
  row solely owns an open work product.

Four things follow that a reader should not have to rediscover:

- **A long-dead obligation is discharged without a carrier.** The carrier is
  not free: it is a `high`-priority row with an assignee, so it becomes a full
  agent run that queues *ahead of* real remediation. Measured in BLO on
  2026-11-05, the first deployed passes created 291 carriers in six hours; of 24
  closed ones sampled evenly across the 221 then done, **24/24 closed as
  "obligation discharged" carrying no live work**, their gates naming runner
  pods, alerts and PRs from August to October that no longer exist. At the same
  time PlatformSRE held 92 queued runs, 46 of them carriers, with 89 blocked
  rows waiting behind them.

  So when the obligation has been moot for longer than
  `CANCELLED_MONITOR_HANDOFF_HORIZON_MS` (7 days), the sweep stamps
  `recoveryEmittedAt` with
  `recoveryDisposition: "auto_discharged_past_horizon"` and builds nothing. The
  deadline is the destroyed monitor's **own due time** (`clearedNextCheckAt`)
  when one was recorded, falling back to `clearedAt` — so an ancient clear whose
  destroyed wake is *still ahead of us* is carried normally, and so is one whose
  source still owns an open work product. A carrier that was built stamps
  `recoveryDisposition: "recovery_issue"`; the field is absent on rows stamped
  before it existed, which is not the same claim as either. If you are auditing
  the backfill, that field — not `recoveryEmittedAt` — is what separates "a
  carrier owns this" from "nothing ever will".
- **The recovery policy is forced, not honoured.** Across the 21 rows carrying
  this residue in PEN, `recoveryPolicy` was `null` on 12, `wake_owner` on 5 and
  `create_recovery_issue` on **none** — so honouring the configured policy
  emits nothing on 12 and posts a comment to the cancelled row itself on the
  other 5. Forcing `create_recovery_issue` is the only setting that emits
  anything, and a row is the only carrier that outlives its source.
- **It covers the terminal branch too.** The sweep keys on the *cancel*, which
  always happens, not on the *reopen*, which may not. A row cancelled because
  the alert genuinely cleared — the case that orphaned
  [onprem-k8s#7360](https://github.com/Blockcast/onprem-k8s/pull/7360) off
  PEN-4835 — gets a carrier even though it is never reopened.
- **An unassigned source gets no carrier — but it is not owed forever.** A
  carrier inherits its source's assignee, so an unassigned source would mint an
  ownerless `todo` that no wake can reach. Within the horizon the sweep
  therefore logs
  `cancelled-monitor recoveries left owed: the source has no agent to hand the
  obligation to (PEN-5346)` with the issue ids and leaves `recoveryEmittedAt`
  null, so the row is retried rather than silently marked discharged. If you
  are chasing a wake that never arrived on an unassigned alert row, that log
  line is where it went.

  **Past** the horizon it is discharged like any other moot obligation. The
  horizon is evaluated *before* the unassigned check for exactly this reason:
  nothing assigns a cancelled row, so an unowned past-horizon row would
  otherwise be re-reported `unowned` on every tick for the life of the
  deployment, and that inert backfill would dominate the one aggregate this
  log line exists to make actionable. The open-work-product carve-out still
  applies first, so an unassigned source that still owns a live PR stays
  visibly owed rather than being written off for want of an assignee.

**Damping the flap is still not done, and is still not this fix.** It was
evaluated against the measured intervals and **rejected as the primary fix**: a
60-minute hold-down would have suppressed 21 of 32 cancels on PEN-4365 but only
5 of the 13 monitor destructions across both rows (4/9 and 1/4), because most
losses follow a genuine multi-hour resolve rather than a short flap. The
status-volatility harm that Rule 1 exists for is therefore unchanged, and
damping remains open on PEN-5343. Rules 1 and 2 above stand as written.

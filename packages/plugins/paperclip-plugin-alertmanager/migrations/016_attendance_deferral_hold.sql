-- PEN-6719 (2026-11-15) -- a capacity deferral now HOLDS the rung WITHOUT
-- re-waking, and `015` says the opposite.
--
-- `015` closes with: "The rung is still HELD for a delivery retry, unchanged.
-- ... Whether it should instead hold without re-attempting is a separate
-- decision, deliberately not taken here." That decision has now been taken,
-- the other way, and the sentence is false in the direction that matters to a
-- reader of this table: it tells them a `deferred` row is followed by a RETRY,
-- when what follows is a deliberate NON-attempt.
--
-- WHY THE HOLD. The host answers `queued = false` for a provider-capacity
-- deferral having ALREADY COMMITTED a `scheduled_retry` run, and reports that
-- on a separate `deferredForCapacity` field. Re-sending the wake on the next
-- sweep stacks a second wake on top of a run the owner already has queued --
-- and does so most readily when provider capacity is scarce, which is the one
-- condition under which it is reached. The core server calls this exact shape
-- a double-wake bug in its own words and excludes the same condition from its
-- own quota-recovery retry for the same reason
-- (`QUOTA_RECOVERY_SCOPE_ATTRIBUTABLE_SKIP_REASONS` and the scoped-wake retry,
-- both in server/src/services/heartbeat.ts). `providerCapacityDeferred` exists
-- on that reply precisely so a caller can decline to re-wake; this ladder was
-- the one caller that read it and re-woke anyway.
--
-- WHAT CHANGES IN THIS TABLE. Nothing in the schema, and one thing in how the
-- rows read. A `deferred` row is now followed by up to
-- `MAX_WAKE_DELIVERY_RETRIES` rows carrying:
--
--     disposition  = unattended_rung
--     wake_outcome = not_attempted
--     wake_cause   = provider_capacity_deferred
--
-- Those are HELD sweeps. `not_attempted` is the literal truth -- no wake was
-- attempted -- and it is outside UNDELIVERED_WAKE_OUTCOMES and outside the
-- partial `..._undelivered_idx`, so a hold cannot inflate the undelivered
-- count. Before PEN-6719 that triple could not occur: `not_attempted` on an
-- `unattended_rung` row was unreachable, because the three rung branches were
-- exhaustive once the attended and cover guards had been passed. The
-- `wake_cause` is what makes such a row triageable, and it is the reason this
-- migration exists rather than leaving the column comments to be read against
-- the old behaviour: a reader meeting `not_attempted` with no cause reads the
-- ladder as having failed to do its job, when it is the ladder doing its job.
--
-- The rung is HELD, not spent: the ladder does not climb past the owner while
-- the hold stands. The hold is BOUNDED by the same counter and the same bound
-- the delivery retries used, so a `scheduled_retry` that never fires -- because
-- capacity never returns, or the run is cancelled -- cannot pin the ladder on
-- one rung forever. The blast radius is therefore unchanged at two extra rung
-- intervals; only the per-sweep action changes from RE-WAKE to WAIT, and the
-- last held sweep posts one comment saying the hold is spent.
--
-- Rows already written are correct as records of what was determined, and are
-- NOT backfilled. There are none of the new shape to backfill, and a
-- historical `deferred` row remains an accurate record of the sweep that wrote
-- it.
--
-- COMMENT REFRESH ONLY. No column is altered, no constraint added, no index
-- changed, nothing backfilled. A NEW migration rather than an edit to `015`,
-- because plugin migrations are sha256-checksummed and editing an applied one
-- is a hard `Plugin migration checksum mismatch` at plugin load; `008`, `010`,
-- `014` and `015` are the precedent for a note-only migration. The false
-- sentence in the `015` header therefore STAYS THERE, unreachable by any edit,
-- which is why it is named at the top of this file and again in the README --
-- a reader of the table arrives at one of those two, not at a superseded
-- header.
--
-- EDITOR NOTE (PEN-5951): keep an EVEN number of apostrophes in this header, or
-- avoid them here entirely as this file does. The host validator strips quoted
-- literals BEFORE it strips `--` comments (`stripSqlForKeywordScan` in
-- server/src/services/plugin-database.ts), so an unpaired apostrophe in this
-- prose pairs forward with the opening quote of a body literal and swallows the
-- COMMENT keyword with it. The statement then normalises to the empty string
-- and the migration is refused at plugin load with a message about DDL that
-- says nothing about quoting.

COMMENT ON COLUMN plugin_alertmanager_184163d1ba.alert_attendance_observations.wake_outcome IS
  'PEN-2918, extended PEN-6704 and PEN-6719 2026-11-15. One of: enqueued (the '
  'host accepted the request and queued a run -- NOT evidence a run started, '
  'still less acknowledgement); refused (issues.requestWakeup threw); declined '
  '(it resolved queued=false and the wake was DROPPED -- '
  'heartbeat.wakeOnDemand.disabled, heartbeat.cooldown, company.inactive, '
  'heartbeat.scheduling_suppressed, worktree_execution_cutoff); deferred '
  '(it resolved queued=false and deferredForCapacity=true -- the provider '
  'capacity gate, which POSTPONES the wake and commits a scheduled_retry run '
  'the scheduler re-drives when capacity returns); not_attempted (the branch '
  'raised no wake). UNDELIVERED means refused or declined ONLY. deferred is '
  'deliberately excluded, here and from the undelivered partial index, because '
  'the wake is late rather than lost -- counting it would put a postponement '
  'in the numerator of wakes this platform believed it had delivered and had '
  'not. Not a CHECK constraint and not an enum, deliberately, so a future '
  'ladder branch can record a determination this schema did not anticipate; '
  'deferred is the first token to use that allowance. PEN-6719: not_attempted '
  'now has a SECOND meaning on an unattended_rung row, and it is the ladder '
  'working rather than failing. The sweeps after a deferral HOLD the rung '
  'without re-waking, because the host has already committed a scheduled_retry '
  'run and re-sending would double-wake the owner; such a sweep attempts no '
  'wake and records not_attempted with wake_cause=provider_capacity_deferred '
  'and a wake_detail saying so. Distinguish by disposition and cause: '
  'attended_monitor, attended_blocker, attended_park and unattended_cover also '
  'carry not_attempted and carry no cause. The hold is bounded by the same '
  'budget the delivery retries use, after which the ladder posts one '
  'hold-spent comment and climbs.';

COMMENT ON COLUMN plugin_alertmanager_184163d1ba.alert_attendance_observations.wake_cause IS
  'PEN-6121, extended PEN-6229, corrected PEN-6121 2026-11-13, extended '
  'PEN-6704 and PEN-6719 2026-11-15: the token for why this wake produced no '
  'run, normally the host own machine-readable code. THROWN '
  '(wake_outcome=refused), pre-wake in the plugin host: issue.no_assignee, '
  'issue.not_wakeable, issue.blocked, budget.blocked (a budget hard-stop), '
  'company.inactive (an operator pause -- the one getInvocationBlock branch '
  'that is not a budget condition). THROWN downstream in enqueueWakeup: '
  'budget.blocked, company.inactive, agent.not_invokable. RESOLVED '
  'queued=false (wake_outcome=declined): heartbeat.wakeOnDemand.disabled, '
  'heartbeat.cooldown, company.inactive, heartbeat.scheduling_suppressed, '
  'worktree_execution_cutoff. This list GROWS -- it is documentation, not a '
  'constraint, so do not read it as closed. PEN-6704: the provider-capacity '
  'deferral WAS listed on the declined arm and is no longer; it records '
  'wake_outcome=deferred with wake_cause=provider_capacity_deferred. That '
  'value is the ONE in this column MINTED BY THE LADDER rather than forwarded, '
  'because the host leaves undeliveredReason null on that path by design (no '
  'skipped row is written, so no durableSkipReason is set) and reports the '
  'condition on a separate deferredForCapacity boolean instead. The spelling '
  'matches the token resolveHeartbeatTimerSchedulerExclusionReason returns for '
  'the same condition in the core server. PEN-6719: provider_capacity_deferred '
  'is ALSO written on a not_attempted row, where it names why NO WAKE WAS '
  'ATTEMPTED -- the sweeps after a deferral hold the rung without re-waking, '
  'rather than stacking a second wake on the committed scheduled_retry run. On '
  'those rows this column is the only field that separates a deliberate hold '
  'from the causeless not_attempted written by the attended and cover '
  'branches. NULL means NOT RECORDED. ON A declined ROW that is all it means, '
  'and on a row written before 2026-11-15 it is also consistent with a '
  'capacity deferral, which is not separable after the fact. ON A refused ROW '
  'it ALSO means the refusal is NOT ESTABLISHED: every coded gate refuses '
  'before the run exists and attaches details.code, so an UNCODED rejection '
  'comes from OUTSIDE them: from before heartbeat.wakeup(), where no run '
  'exists, or from after it, where one MAY. Measured once, PEN-5911 '
  '2026-11-13T05:36Z: the run existed and ran to success while this column '
  'read refused with a NULL cause. Settle such a row against a heartbeat run '
  'whose contextSnapshot.source is alertmanager-escalation in the sweep '
  'window, never against the absence of an issue.assignment_wakeup_requested '
  'activity row, which is written AFTER the run and is missing in exactly this '
  'case.';

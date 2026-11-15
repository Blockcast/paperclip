-- PEN-6704 (2026-11-15) -- a provider-capacity deferral is NOT an undelivered
-- wake, and `007` files it under one.
--
-- `007` lists the provider-capacity deferral among the gates behind
-- `wake_outcome = declined`, and `declined` is one of the two tokens the
-- partial `..._undelivered_idx` covers. So a postponement was counted in the
-- numerator of "every escalation this platform believed it had delivered and
-- had not" -- which is the exact claim PEN-6121 built this table to make
-- honest, failing here in the opposite direction: not a delivery asserted that
-- never happened, but a drop asserted that never happened either.
--
-- The mechanism, read first-party at the serving commit e1572753 and
-- re-read at master before this file was written:
--
--   * `wakeupWithDispatchRetry` in server/src/services/heartbeat.ts sets
--     `outcomeSink.skipReason = result ? null : suppression.durableSkipReason`
--     and, separately,
--     `outcomeSink.providerCapacityDeferred = !result && suppression.providerCapacityDeferred`.
--   * `durableSkipReason` is written only by `writeSkippedRequest`, which runs
--     only where a `skipped` row is committed. The capacity gate is the one
--     `return null` that writes none, and says so in its own words: this is
--     the only return-null that leaves durableSkipReason null on purpose,
--     because the wake is not declined, just postponed.
--   * `requestWakeup` in server/src/services/plugin-host-services.ts therefore
--     returns BOTH `undeliveredReason` (null here, by design) and
--     `deferredForCapacity` (true here). The ladder read only the first.
--
-- So `wake_cause` could never be non-null on this gate, however long anyone
-- waited for a specimen. It was not a plumbing gap; it was a field nothing
-- downstream read.
--
-- WHAT CHANGES. The ladder now records a FIFTH `wake_outcome`, `deferred`,
-- when the host answers `queued = false` AND `deferredForCapacity = true`.
--
--   * `deferred` is NOT in `UNDELIVERED_WAKE_OUTCOMES` and NOT in the partial
--     index predicate, so the undelivered query and the undelivered route stop
--     counting postponements. No index is altered: `007` names its two tokens
--     literally, so a new token is excluded automatically -- which is why this
--     migration adds no DDL beyond the comments below, and why the deliberate
--     absence of a CHECK constraint on `wake_outcome` in `007` is what made a
--     new token possible at all. That note was written for exactly this case.
--   * The rung is still HELD for a delivery retry, unchanged. The ladder has
--     no run of its OWN to point at, so climbing past the owner would be
--     premature while their scheduled_retry run is pending. Whether it should
--     instead hold without re-attempting is a separate decision, deliberately
--     not taken here.
--   * `wake_cause` on a `deferred` row is `provider_capacity_deferred`, and it
--     is the one value in that column MINTED BY THE LADDER rather than
--     forwarded from the host, for the reason above: there is no host string
--     to forward. The spelling is byte-identical to the token
--     `resolveHeartbeatTimerSchedulerExclusionReason` already returns for this
--     condition in the core server, so one grep finds both surfaces.
--
-- Rows already written are correct as records of what was determined, and are
-- NOT backfilled. A pre-PEN-6704 `declined` row with a NULL cause remains
-- consistent with a capacity deferral AND with a plain decline, and no field
-- that could separate them was ever stored -- the information was discarded
-- before the row was written. Read the historical undelivered count as an
-- UPPER BOUND on drops for that reason as well as for the one `014` gives.
--
-- A pre-PEN-6704 HOST omits `deferredForCapacity` entirely. The ladder tests
-- it `=== true`, so such a host keeps recording `declined` exactly as before
-- rather than having a deferral read into its silence.
--
-- COMMENT REFRESH ONLY. No column is altered, no constraint added, no index
-- changed, nothing backfilled. A NEW migration rather than an edit to `007`,
-- because plugin migrations are sha256-checksummed and editing an applied one
-- is a hard `Plugin migration checksum mismatch` at plugin load; `008`, `010`
-- and `014` are the precedent for a note-only migration.
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
  'PEN-2918, extended PEN-6704 2026-11-15. One of: enqueued (the host accepted '
  'the request and queued a run -- NOT evidence a run started, still less '
  'acknowledgement); refused (issues.requestWakeup threw); declined (it '
  'resolved queued=false and the wake was DROPPED -- '
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
  'deferred is the first token to use that allowance.';

COMMENT ON COLUMN plugin_alertmanager_184163d1ba.alert_attendance_observations.wake_cause IS
  'PEN-6121, extended PEN-6229, corrected PEN-6121 2026-11-13, extended '
  'PEN-6704 2026-11-15: the token for why this wake produced no run, normally '
  'the host own machine-readable code. THROWN (wake_outcome=refused), pre-wake '
  'in the plugin host: issue.no_assignee, issue.not_wakeable, issue.blocked, '
  'budget.blocked (a budget hard-stop), company.inactive (an operator pause -- '
  'the one getInvocationBlock branch that is not a budget condition). THROWN '
  'downstream in enqueueWakeup: budget.blocked, company.inactive, '
  'agent.not_invokable. RESOLVED queued=false (wake_outcome=declined): '
  'heartbeat.wakeOnDemand.disabled, heartbeat.cooldown, company.inactive, '
  'heartbeat.scheduling_suppressed, worktree_execution_cutoff. This list '
  'GROWS -- it is documentation, not a constraint, so do not read it as '
  'closed. PEN-6704: the provider-capacity deferral WAS listed on the declined '
  'arm and is no longer; it records wake_outcome=deferred with wake_cause='
  'provider_capacity_deferred. That value is the ONE in this column MINTED BY '
  'THE LADDER rather than forwarded, because the host leaves undeliveredReason '
  'null on that path by design (no skipped row is written, so no '
  'durableSkipReason is set) and reports the condition on a separate '
  'deferredForCapacity boolean instead. The spelling matches the token '
  'resolveHeartbeatTimerSchedulerExclusionReason returns for the same '
  'condition in the core server. NULL means NOT RECORDED. ON A declined ROW '
  'that is all it means, and on a row written before 2026-11-15 it is also '
  'consistent with a capacity deferral, which is not separable after the fact. '
  'ON A refused ROW it ALSO means the refusal is NOT ESTABLISHED: every coded '
  'gate refuses before the run exists and attaches details.code, so an UNCODED '
  'rejection comes from OUTSIDE them: from before heartbeat.wakeup(), where no '
  'run exists, or from after it, where one MAY. Measured once, PEN-5911 '
  '2026-11-13T05:36Z: the run existed and ran to success while this column '
  'read refused with a NULL cause. Settle such a row against a heartbeat run '
  'whose contextSnapshot.source is alertmanager-escalation in the sweep '
  'window, never against the absence of an issue.assignment_wakeup_requested '
  'activity row, which is written AFTER the run and is missing in exactly this '
  'case.';

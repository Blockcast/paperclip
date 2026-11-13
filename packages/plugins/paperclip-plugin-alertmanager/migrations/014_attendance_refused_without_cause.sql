-- PEN-6121 (2026-11-13) -- a `refused` row with a NULL cause is NOT established
-- as an undelivered wake, and `010` says the opposite.
--
-- `010` closes with "NULL means NOT RECORDED ... it never means the wake was
-- delivered". The first half stands. The second half was measured FALSE on the
-- `refused` arm, on a live row, and it is the half a reader triaging by cause
-- acts on.
--
-- Measured on PEN-5911 at 2026-11-13T05:36Z, every datum first-party:
--   05:36:17.060Z  the ladder reads Alertmanager liveness; the rung-1 sweep opens
--   05:36:25.568Z  run 651a67f2 is CREATED for the target agent, carrying
--                  contextSnapshot.source = alertmanager-escalation -- a value
--                  with exactly ONE producer in this tree, the ladder wake call
--                  in requestWakeupBestEffort
--   05:36:58.111Z  the escalation comment says "no run was queued for Devops"
--   05:37:03.022Z  this table records wake_outcome=refused, wake_cause=NULL
--   05:37:59.259Z  run 651a67f2 STARTS, and runs to success at 06:32:03.640Z
--
-- The mechanism is an ORDERING in the host handler, not a plugin bug and not a
-- lost row. `issues.requestWakeup` runs heartbeat.wakeup() -- which creates the
-- run -- and only THEN writes the issue.assignment_wakeup_requested activity
-- row and returns. A throw anywhere after the first step leaves the run created
-- while the call rejects, and leaves no activity row, which is why that row is
-- absent for the refused attempt and present for the retry four minutes later.
--
-- What makes the CAUSE the discriminator rather than the outcome: every one of
-- the seven coded gates refuses BEFORE heartbeat.wakeup is reached or inside
-- it, and every one attaches details.code, which workerHostErrorData projects
-- onto the JSON-RPC error data. So a rejection that CARRIES a cause does prove
-- no run was created, and a rejection with NO cause proves nothing either way.
-- The ladder now says so: wake_detail on such a row states that this is not
-- established as a refusal, and the escalation comment says the run could not
-- be confirmed instead of asserting that none was queued.
--
-- Consequence for anyone querying this table, and it is the point of this file:
-- the undelivered query in the README and the /attendance-observations/
-- undelivered route both select wake_outcome IN (refused, declined). That set
-- is an UPPER BOUND on undelivered wakes, not a count of them. To settle one
-- refused row with a NULL cause, look for a heartbeat run whose
-- contextSnapshot.source is alertmanager-escalation created inside the sweep
-- window for that issue. Do NOT settle it on the absence of an
-- issue.assignment_wakeup_requested activity row: that row is written after the
-- run, so it is missing in exactly this case.
--
-- Rows already written are correct and are not backfilled: wake_cause NULL has
-- always meant NOT RECORDED, and this file changes what a reader should
-- conclude from it, not what it says.
--
-- COMMENT REFRESH ONLY. No column is altered, no constraint added, nothing
-- backfilled. A NEW migration rather than an edit to `010`, because plugin
-- migrations are sha256-checksummed and editing an applied one is a hard
-- `Plugin migration checksum mismatch` at plugin load; `008` and `010` are the
-- precedent for a note-only migration.
--
-- EDITOR NOTE (PEN-5951): keep an EVEN number of apostrophes in this header, or
-- avoid them here entirely as this file does. The host validator strips quoted
-- literals BEFORE it strips `--` comments (`stripSqlForKeywordScan` in
-- server/src/services/plugin-database.ts), so an unpaired apostrophe in this
-- prose pairs forward with the opening quote of the body literal below and
-- swallows the COMMENT keyword with it. The statement then normalises to the
-- empty string and the migration is refused at plugin load with a message about
-- DDL that says nothing about quoting.

COMMENT ON COLUMN plugin_alertmanager_184163d1ba.alert_attendance_observations.wake_cause IS
  'PEN-6121, extended PEN-6229, corrected PEN-6121 2026-11-13: the host''s own '
  'token for why this wake produced no run. THROWN (wake_outcome=refused), '
  'pre-wake in the plugin host: issue.no_assignee, issue.not_wakeable, '
  'issue.blocked, budget.blocked (a budget hard-stop), company.inactive (an '
  'operator pause -- the one getInvocationBlock branch that is not a budget '
  'condition). THROWN downstream in enqueueWakeup: budget.blocked, '
  'company.inactive, agent.not_invokable. RESOLVED queued=false '
  '(wake_outcome=declined): heartbeat.wakeOnDemand.disabled, '
  'heartbeat.cooldown, company.inactive, heartbeat.scheduling_suppressed, '
  'worktree_execution_cutoff, and the provider-capacity deferral. This list '
  'GROWS -- it is documentation, not a constraint, so do not read it as '
  'closed. NULL means NOT RECORDED. ON A declined ROW that is all it means. ON '
  'A refused ROW it ALSO means the refusal is NOT ESTABLISHED: every coded gate '
  'refuses before the run exists and attaches details.code, so an UNCODED '
  'rejection comes from OUTSIDE them: from before heartbeat.wakeup(), where no '
  'run exists, or from after it, where one MAY. The run is therefore NOT '
  'ESTABLISHED either way. Measured once, PEN-5911 2026-11-13T05:36Z: the run '
  'existed and ran to success while this column read refused with a NULL '
  'cause. Settle such a row against a heartbeat run whose contextSnapshot.source is '
  'alertmanager-escalation in the sweep window, never against the absence of an '
  'issue.assignment_wakeup_requested activity row, which is written AFTER the '
  'run and is missing in exactly this case.';

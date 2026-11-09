-- PEN-6229 — the `refused` vocabulary is SEVEN gates, not three.
--
-- `009` recorded, correctly for the tree it shipped against, that `refused` is
-- "three gates throw: `budget.blocked`, `company.inactive`, and
-- `agent.not_invokable`". All three live in `enqueueWakeup`, downstream of the
-- plugin host.
--
-- They are not the only ones the ladder can hit. `issues.requestWakeup` — the
-- call the escalation ladder actually makes — runs FOUR refusal pre-checks of
-- its own before `heartbeat.wakeup` is reached, and `requestWakeups` repeats
-- all four. Until PEN-6229 those eight sites threw a bare `Error`, so
-- `workerHostErrorData` had no `details.code` to project, `readWakeCause`
-- resolved `null`, and the observation recorded `wake_cause = NULL`. That is
-- not WRONG — NULL does mean "not recorded" — but it is indistinguishable from
-- a cause nobody coded, which is the exact ambiguity `009` exists to remove.
--
--   refused  — now SEVEN gates throw:
--              pre-wake, in the plugin host (PEN-6229):
--                `issue.no_assignee`    — the issue has no agent assignee;
--                `issue.not_wakeable`   — terminal status (done/cancelled);
--                `issue.blocked`        — an unresolved blocker edge;
--                `budget.blocked`       — an invocation budget block.
--              downstream, in `enqueueWakeup` (PEN-6121):
--                `budget.blocked`, `company.inactive`, `agent.not_invokable`.
--
-- `budget.blocked` deliberately appears on BOTH sides. It is one gate asked
-- twice on one path, and a reader triaging by cause wants the gate, not which
-- layer happened to ask first — so the token is shared rather than split.
--
-- ⛔ This migration is a COMMENT REFRESH ONLY. It alters no column, adds no
-- constraint and backfills nothing: every `wake_cause` row written before it is
-- still correct, and NULL still means "not recorded" exactly as `009` says.
--
-- It is a NEW migration rather than an edit to `009` on purpose. Plugin
-- migrations are sha256-checksummed and a changed checksum on an applied
-- migration is a hard `Plugin migration checksum mismatch` at plugin load — so
-- editing `009` would be inert at best and a load failure at worst, depending
-- on whether it had already been applied. `008` is the precedent for a
-- note-only migration.

COMMENT ON COLUMN plugin_alertmanager_184163d1ba.alert_attendance_observations.wake_cause IS
  'PEN-6121, extended PEN-6229: the host''s own token for why this wake '
  'produced no run. THROWN (wake_outcome=refused), pre-wake in the plugin '
  'host: issue.no_assignee, issue.not_wakeable, issue.blocked, budget.blocked. '
  'THROWN downstream in enqueueWakeup: budget.blocked, company.inactive, '
  'agent.not_invokable. RESOLVED queued=false (wake_outcome=declined): '
  'heartbeat.wakeOnDemand.disabled, heartbeat.cooldown, company.inactive, '
  'heartbeat.scheduling_suppressed, worktree_execution_cutoff, and the '
  'provider-capacity deferral. This list GROWS -- it is documentation, not a '
  'constraint, so do not read it as closed. NULL means NOT RECORDED '
  '(pre-009 row, a branch that attempted no wake, or a host that declined '
  'without a cause); it never means the wake was delivered. Read wake_outcome '
  'for that.';

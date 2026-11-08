-- PEN-6121 — name WHY a rung wake was never delivered.
--
-- `007` gave us `wake_outcome`, which answers "did the wake reach the host's
-- queue?". The first read of that table (PEN-2918 (D), shipped in #3497) found
-- 23 of 29 rung wakes undelivered — 79.3%, over 11 alert rows, every one with
-- the alert still firing, and two rows that ran the full three-rung ladder with
-- not one rung delivered. The outcome column sized the problem and could not
-- triage it: `refused` and `declined` are each a DISJUNCTION, not a diagnosis.
--
--   declined — six gates resolve `{ queued: false }` without throwing:
--              heartbeats disabled, the heartbeat cooldown, `company.inactive`,
--              `heartbeat.scheduling_suppressed`, `worktree_execution_cutoff`,
--              and the provider-capacity deferral.
--   refused  — three gates throw: `budget.blocked`, `company.inactive`, and
--              `agent.not_invokable`, the last of which was 15 of the 23.
--
-- ⛔ AND THE RECORD POINTED AT THE WRONG PLACE. `007`'s `wake_detail` sentence
-- for `refused` reads "the error is in the plugin log". It was not: the ladder
-- logged `String(err)`, which keeps the message and discards `err.details` —
-- and the details are exactly the discriminator. So the one column that claimed
-- to route a reader to the cause routed them to a log that did not contain it.
--
-- The host now stamps a machine-readable token on both halves — `details.code`
-- on the three `conflict(...)` gates in `enqueueWakeup`, and `undeliveredReason`
-- on the resolving path — using ONE vocabulary (the `writeSkippedRequest`
-- tokens), so a single column can record the cause however the wake was lost.
--
-- NULL is a real and expected value: rows written before this migration, every
-- `not_attempted` branch, and a host that declined without recording a cause.
-- ⛔ NULL therefore means "not recorded", never "no cause" and never "delivered"
-- — read `wake_outcome` for that, which is NOT NULL and always has been.
--
-- Deliberately NOT a CHECK constraint or an enum, for the reason `007` gives
-- about `disposition`: the host's token set will grow, plugin migrations may
-- contain no destructive statements, and a too-narrow constraint here could
-- never be dropped.

ALTER TABLE plugin_alertmanager_184163d1ba.alert_attendance_observations
  ADD COLUMN wake_cause text;

COMMENT ON COLUMN plugin_alertmanager_184163d1ba.alert_attendance_observations.wake_cause IS
  'PEN-6121: the host''s own token for why this wake produced no run -- '
  'e.g. agent.not_invokable, budget.blocked, heartbeat.cooldown, '
  'worktree_execution_cutoff. NULL means NOT RECORDED (pre-migration row, a '
  'branch that attempted no wake, or a host that declined without a cause); it '
  'never means the wake was delivered. Read wake_outcome for that.';

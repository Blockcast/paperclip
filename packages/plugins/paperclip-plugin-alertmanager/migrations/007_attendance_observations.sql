-- PEN-2918 — persist the attendance determination the escalation ladder
-- already makes, so that "delivered", "acknowledged" and "executed" stop
-- being three words for one unreadable state.
--
-- WHAT THIS IS NOT. It adds no notification, no channel, no obligation and no
-- second place to look: the record lives in this plugin's own namespace and is
-- read through Paperclip's own API. It makes non-acknowledgement VISIBLE and
-- QUERYABLE. It does not make non-acknowledgement OBLIGE anybody, and a query
-- over this table is not an on-call rota. See the module header in
-- `src/attendance-record.ts`.
--
-- WHY A TABLE AND NOT A LOG LINE. The ladder computes this determination on
-- every pass and then throws it away. `escalation.ts` says so itself, about
-- the deferral branch: "A deferral writes only `nextEscalationAt` into plugin
-- state, which has no read API, emits no metric, and posts no comment; its
-- sole external trace was the ABSENCE of a cover row." An absence is not a
-- record. Nothing can be counted from it, and "the guard held the rung"
-- cannot be told apart from "the guard never ran".
--
-- plugin_alertmanager_184163d1ba = derivePluginDatabaseNamespace(
--   "paperclip-plugin-alertmanager", "alertmanager"
-- ) — deterministic from the plugin id + namespaceSlug in manifest.ts.

CREATE TABLE plugin_alertmanager_184163d1ba.alert_attendance_observations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  alert_issue_id uuid NOT NULL REFERENCES public.issues(id) ON DELETE CASCADE,
  alertname text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),

  -- The determination itself, in the ladder's own vocabulary. One of:
  --   attended_monitor  — PEN-4337: the owner has armed a monitor.
  --   attended_blocker  — BLO-40673: an unresolved `blockedBy` edge.
  --   unattended_rung   — neither held; the ladder advanced a rung.
  --   unattended_cover  — neither held; the agent chain was exhausted.
  --   held_alert_clear  — BLO-40739: Alertmanager says the alert is not firing.
  -- Deliberately NOT a CHECK constraint or an enum: a future ladder branch
  -- must be able to record a determination this migration did not anticipate,
  -- and plugin migrations may not contain destructive statements, so a
  -- too-narrow constraint here could not later be dropped.
  disposition text NOT NULL,

  -- Rung reached on this pass (0 before the first rung). NULL where the
  -- branch has no rung concept.
  escalation_attempt integer,

  -- Who the rung was aimed at, when there was one. Deliberately NOT a foreign
  -- key: this plugin declares `coreReadTables: ["companies", "issues"]`, and
  -- widening that to `agents` to buy referential integrity on an audit column
  -- would widen a capability grant for a convenience. An agent row that is
  -- later deleted leaves a dangling id here, which is the correct outcome for
  -- an append-only record of what was determined at the time.
  notified_agent_id uuid,

  -- PEN-2918 C4 — the cell a three-state model does not have: "never
  -- delivered at all". One of:
  --   enqueued       — `issues.requestWakeup` returned without throwing.
  --   refused        — it threw (paused agent, budget block, unresolved
  --                    blocker). The ladder swallows this by design; before
  --                    this column its only trace was a plugin log line,
  --                    while the issue comment posted immediately beforehand
  --                    said "waking current owner <name>".
  --   not_attempted  — this branch raises no wake (a deferral, a hold).
  -- `enqueued` means the host ACCEPTED the wake, and nothing more. It is not
  -- evidence that a run started, still less that a human read anything.
  wake_outcome text NOT NULL,

  -- Fixed sentence, never raw error text: these rows are operator-readable
  -- and raw errors carry resolved addresses, ports and response bytes. Same
  -- discipline as `readAlertLiveness`'s `reason`.
  wake_detail text,

  -- What Alertmanager said on this pass: firing | not_firing | unknown |
  -- not_read. `not_read` is not a gap — the attendance branches short-circuit
  -- ahead of the liveness read, so it records that the determination was made
  -- without consulting the alert.
  alert_liveness text NOT NULL
);

-- "What did the ladder determine about this alert row, in order?" — the
-- per-issue history read, and the one a reader follows from an issue.
CREATE INDEX alert_attendance_observations_issue_idx
  ON plugin_alertmanager_184163d1ba.alert_attendance_observations (alert_issue_id, observed_at DESC);

-- "Across this company, over this window, how often was an escalation
-- attended / unattended / never delivered?" — the aggregate read, which is
-- the one the three-state question actually asks.
CREATE INDEX alert_attendance_observations_company_window_idx
  ON plugin_alertmanager_184163d1ba.alert_attendance_observations (company_id, observed_at DESC);

-- Partial index for the sharpest query of the set: every pass whose wake was
-- refused, i.e. every escalation this platform believed it had delivered and
-- had not. Expected to stay small, which is exactly why it is worth having.
CREATE INDEX alert_attendance_observations_undelivered_idx
  ON plugin_alertmanager_184163d1ba.alert_attendance_observations (company_id, observed_at DESC)
  WHERE wake_outcome = 'refused';

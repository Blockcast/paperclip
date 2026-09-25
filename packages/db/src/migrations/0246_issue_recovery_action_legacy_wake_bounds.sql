-- BLO-19124: bound the legacy owner-waking recovery actions that predate
-- creation-time bounds.
--
-- `recoveryActionBoundsAtCreation` has bounded every new action since
-- `wakesOwner` was introduced, but the rows minted before it carry
-- `max_attempts IS NULL` and `timeout_at IS NULL` forever. That shape is not
-- merely unbounded, it is unretirable:
--
--   * `strandedRecoveryWakeAttemptsExhausted` short-circuits on
--     `maxAttempts === null` and returns false, so the row never reads as spent;
--   * `escalateExpiredWakeHorizons` — the only sweep that retires a spent
--     action — requires BOTH columns non-null, so it can never select the row.
--
-- So the action stays `active` for life. `active` is the one status in
-- `BLOCKED_AUTO_RESUME_SUPPRESSING_RECOVERY_ACTION_STATUSES`, which pins the
-- source issue `blocked` with zero blockers and no wake path, and it holds
-- `issue_recovery_actions_active_source_uq` so no fresh action can replace it.
-- Measured 2026-09-21 over the 40 oldest active actions: 22 rows in this shape,
-- oldest 2026-06-05, several still being swept (one at 18 non-delivery sweeps)
-- with no possible terminus.
--
-- The predicate is the producer's own, not `max_attempts IS NULL`. A null budget
-- is DELIBERATE for the shapes that wake nobody — `manual_repair_required`
-- (`workspace_validation_failed` / `configuration_incomplete`), `monitor_only`
-- (ownerless `provider_quota`) and `board_escalation` — and 12 such rows are
-- live right now. `wakesOwner` in `recovery/service.ts` decides the budget and
-- the wake policy from one boolean, so `wake_policy->>'type' = 'wake_owner'` is
-- exactly the set that was supposed to carry bounds.
--
-- Values mirror the `recoveryActionMaxAttempts` / `recoveryActionTimeoutMs`
-- fallbacks (5, 6h) and the horizon stays creation-anchored, exactly as
-- `recoveryActionBoundsAtCreation` computes it. Every affected row is months
-- past `created_at + 6h`, so this grants no new wake budget: it makes the row
-- eligible for the existing retirement sweep on its next pass, which escalates
-- it with `retiring_bound = 'timeout_horizon'` and announces it once on the
-- source issue.
--
-- Idempotent by predicate. `status = 'active'` is deliberate: an `escalated` row
-- already got its bound from 0241.
UPDATE "issue_recovery_actions"
   SET "max_attempts" = 5,
       "timeout_at" = "created_at" + interval '6 hours',
       "updated_at" = now()
 WHERE "status" = 'active'
   AND "max_attempts" IS NULL
   AND "wake_policy" ->> 'type' = 'wake_owner';

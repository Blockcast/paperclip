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
-- Measured 2026-09-23, a COMPLETE census rather than a page: 91 active actions
-- returned against a limit of 200, so the short page is the whole set. 34 of
-- them carry `max_attempts IS NULL`, oldest 2026-06-05, several still being
-- swept (one at 18 non-delivery sweeps) with no possible terminus.
--
-- The predicate is the producer's own, not `max_attempts IS NULL`. A null budget
-- is DELIBERATE for the shapes that wake nobody — `manual_repair_required`
-- (`workspace_validation_failed` / `configuration_incomplete`), `monitor_only`
-- (ownerless `provider_quota`) and `board_escalation` — and 12 such rows are
-- live right now. `wakesOwner` in `recovery/service.ts` decides the budget and
-- the wake policy from one boolean, so `wake_policy->>'type' = 'wake_owner'` is
-- exactly the set that was supposed to carry bounds.
--
-- The COMPLEMENT is measured, not assumed: of those 34, the predicate matches 22
-- (21 `stranded_assigned_issue` + 1 `self_review_pr_non_convergence`, every one
-- reading `wake_owner`) and skips exactly 12 `workspace_validation_failed`, every
-- one reading `manual_repair_required`. There is no null-`wake_policy` bucket
-- hiding residual strands behind `NULL = 'wake_owner'`: the column is nullable
-- since 0097 and no migration ever populated it, but both upsert call sites
-- (`recovery/service.ts:5926`, `:14885`) pass it unconditionally and every branch
-- of both ternaries yields a non-null object, so no producer can write one.
--
-- Values mirror the `recoveryActionMaxAttempts` / `recoveryActionTimeoutMs`
-- FALLBACKS (5, 6h) — not this deployment's resolved values, which
-- `RECOVERY_ACTION_MAX_ATTEMPTS` / `RECOVERY_ACTION_TIMEOUT_MS` can override and
-- which a migration cannot read. The horizon stays creation-anchored, exactly as
-- `recoveryActionBoundsAtCreation` computes it. Every affected row is months
-- past `created_at + 6h`, so this grants no new wake budget and the overridable
-- attempt budget is inert: the row retires on `timeout_horizon` on the existing
-- retirement sweep's next pass whatever that budget resolves to, which escalates
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

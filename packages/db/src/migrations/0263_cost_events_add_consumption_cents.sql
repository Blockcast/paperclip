-- PEN-4466: give the budget controls a consumption column that cannot be zeroed.
--
-- `cost_events` has exactly one money column, `cost_cents`, and it is written through
-- `normalizeBilledCostCents()` (server/src/services/heartbeat.ts), which returns 0
-- whenever `billing_type = 'subscription_included'`. Every hard gate in the system then
-- sums that column with NO billing_type filter:
--
--   * `computeObservedAmount`      (services/budgets.ts)   -- all five hardStopEnabled policies
--   * `heartbeat.daily_cost_limit` (services/heartbeat.ts) -- per-agent daily cost cap
--   * `getMonthlySpendTotal`       (services/costs.ts)     -- agents/companies.spent_monthly_cents
--
-- So on the day an adapter starts classifying subscription lanes correctly, every such
-- lane books $0 and all three read 0 forever -- silently, with every dashboard healthy.
-- `consumption_cents` is the list-price quantity those readers move to, computed with no
-- billing_type branch, so correcting classification can no longer disarm a cap.
--
-- NULLABLE ON PURPOSE, and plain `coalesce` rather than `coalesce(nullif(x, 0), ...)`.
-- A NOT NULL DEFAULT 0 column cannot distinguish "0 because this row predates the
-- column" from "0 because this run genuinely cost nothing", which forces readers into
-- `nullif(consumption_cents, 0)` -- and that silently re-reads `cost_cents` for every
-- genuinely-free row, forever. NULL says "not recorded"; 0 says "recorded as zero".
-- Readers therefore use `coalesce(consumption_cents, cost_cents)`, which also covers
-- rows inserted between this migration and the deploy that starts populating it.
--
-- SUBSCRIPTION ROWS ARE LEFT NULL, NOT BACKFILLED (BLO-48352). `normalizeBilledCostCents`
-- already zeroed `cost_cents` on every `subscription_included` row, so copying it would
-- record a false "consumed $0". NULL is the honest value: "not recorded". Readers fall
-- back to `cost_cents` (still 0 for those rows), so this changes nothing they read today,
-- and leaves the rows distinguishable for a later list-price repair. `subscription_overage`
-- is not zeroed, so it is backfilled like any other row.
--
-- This replaces an earlier revision of 0263 (same number, original file name
-- `0263_cost_events_consumption_cents.sql`) that RAISEd when any `subscription_included`
-- row existed. Production held ~4k such runs, so the RAISE crash-looped the worker on the
-- 2026-10-22 deploy and helm rolled back (BLO-48352). That revision never applied to any
-- persistent database; the rename keeps a dev DB that did apply it from silently matching
-- a different file. `IF NOT EXISTS` makes a re-run on such a DB a no-op.
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "consumption_cents" integer;

-- Single-pass backfill. `cost_events` is a medium table (est. ~832k rows; the large-table
-- bucket starts at 1M) with no index on `cost_cents`, so this is one heap rewrite of one
-- int4 column and no index maintenance. The `consumption_cents IS NULL` clause makes it
-- idempotent if the migration is ever re-run against a partly-populated table.
UPDATE "cost_events" SET "consumption_cents" = "cost_cents"
 WHERE "consumption_cents" IS NULL
   AND "billing_type" <> 'subscription_included';

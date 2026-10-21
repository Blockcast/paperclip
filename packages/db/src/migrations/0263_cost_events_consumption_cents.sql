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
-- ORDERING GATE. The backfill below is correct only while no row whose `cost_cents` has
-- been ZEROED exists -- i.e. no `subscription_included` row. `subscription_overage` is
-- deliberately NOT caught here: `normalizeBilledCostCents` does not zero it, so an overage
-- row keeps a correct list-price `cost_cents` and backfilling from it is safe. Catching it
-- would wedge this migration on the first legitimately-classified overage row for no
-- correctness reason. Today every row in the table IS list price, because
-- `/companies/:id/costs/by-biller` reports subscriptionRunCount = 0 on both billers
-- (anthropic 28,627 api runs, openai 328, 28,955 total, 0 subscription -- measured
-- 2026-10-21). If classification landed first, `cost_cents` is already zeroed for those
-- rows and copying it would bake the zeros in permanently. This RAISE is deliberately a
-- migration-time failure rather than a SELECT in a runbook: a pre-flight a human has to
-- remember is the same note that let this decision sit in a comment thread for two days.
DO $$
DECLARE
  misclassified bigint;
BEGIN
  SELECT count(*) INTO misclassified
    FROM cost_events
   WHERE billing_type = 'subscription_included';

  IF misclassified > 0 THEN
    RAISE EXCEPTION
      'PEN-4466: % cost_events rows already carry billing_type = subscription_included. The adapter classification fix landed BEFORE this control, so cost_cents is already zeroed for those rows and backfilling consumption_cents from it would make the zeros permanent. Stop and escalate on PEN-4466 before re-running.',
      misclassified;
  END IF;
END
$$;

ALTER TABLE "cost_events" ADD COLUMN "consumption_cents" integer;

-- Single-pass backfill. `cost_events` is a medium table (est. ~832k rows; the large-table
-- bucket starts at 1M) with no index on `cost_cents`, so this is one heap rewrite of one
-- int4 column and no index maintenance. The guard above is what makes it correct; the
-- WHERE makes it idempotent if the migration is ever re-run against a partly-populated
-- table.
UPDATE "cost_events" SET "consumption_cents" = "cost_cents" WHERE "consumption_cents" IS NULL;

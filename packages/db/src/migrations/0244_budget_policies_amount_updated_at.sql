-- BLO-32796: an amount-specific write time, so "superseded" cannot be inferred
-- from an edit that never touched the amount.
--
-- `approval-enforcement-reconciler.ts` `classifyEnforcementAssertion` has to
-- tell two states apart when an enforced cap matches neither the card's decided
-- figure nor the prior figure the card recorded:
--
--   * a later decision moved the cap  -> `superseded`, correctly NOT drift;
--   * the card's recorded prior was simply wrong and the decision never landed
--     -> `never_applied`, real drift that must be reported and repairable.
--
-- It split them on `updated_at > decided_at`. That column is bumped by every
-- write to the row, and `budgetService.upsertPolicy` is the single edit path for
-- warn percent, hard stop, notification and active state as well as the amount.
-- So an operator toggling warn percent on a policy whose approved raise never
-- landed pushed `updated_at` past `decided_at` and made a real enforcement gap
-- read as a supersession: the reconciler stopped reporting it and the apply
-- route refused to repair it. The suppressing edit need not be related to the
-- decision at all, which is what makes the inference unsound rather than merely
-- imprecise.
--
-- This column is written only when `amount` actually changes, so "something
-- wrote this row after the decision" narrows to "something moved the enforced
-- figure after the decision" — which is the only fact the classifier ever
-- wanted.
--
-- Backfilled from `updated_at` rather than left NULL. NULL would be the honest
-- "unknown", but the classifier maps unknown to `unverifiable_mismatch`, which
-- is reported as drift — so a NULL backfill would raise a fresh drift issue for
-- every already-superseded assertion in production on the first sweep after
-- deploy (approval `6f45844e` alone carries eight). `updated_at` is exactly the
-- estimate the code used until this migration: no row is classified worse than
-- it was yesterday, and every amount write from here on is exact.
ALTER TABLE "budget_policies"
  ADD COLUMN IF NOT EXISTS "amount_updated_at" timestamp with time zone;

UPDATE "budget_policies" SET "amount_updated_at" = "updated_at" WHERE "amount_updated_at" IS NULL;

ALTER TABLE "budget_policies"
  ALTER COLUMN "amount_updated_at" SET DEFAULT now();

ALTER TABLE "budget_policies"
  ALTER COLUMN "amount_updated_at" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_productivity_review_escalation_uq"
  ON "issues" USING btree ("company_id", "origin_kind", "origin_id")
  WHERE "issues"."origin_kind" = 'productivity_review_escalation'
    AND "issues"."origin_id" IS NOT NULL
    AND "issues"."hidden_at" IS NULL
    AND "issues"."status" NOT IN ('done', 'cancelled');

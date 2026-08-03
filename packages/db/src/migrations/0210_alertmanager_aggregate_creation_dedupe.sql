CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_alertmanager_aggregate_creation_uq"
  ON "issues" USING btree ("company_id", "origin_kind", "origin_fingerprint")
  WHERE "origin_kind" = 'plugin:paperclip-plugin-alertmanager'
    AND "origin_fingerprint" <> 'default'
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');

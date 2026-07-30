CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_alert_escalation_cover_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_fingerprint")
  WHERE "origin_kind" = 'plugin:paperclip-plugin-alertmanager:escalation'
    AND "origin_fingerprint" <> 'default'
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');

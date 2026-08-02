LOCK TABLE issues IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY company_id, origin_kind, origin_id
           ORDER BY created_at, id
         ) AS duplicate_number
    FROM issues
   WHERE origin_kind = 'plugin:paperclip-plugin-alertmanager'
     AND origin_id IS NOT NULL
     AND hidden_at IS NULL
)
UPDATE issues
   SET origin_id = origin_id || ':legacy-duplicate:' || id::text
 WHERE id IN (SELECT id FROM ranked WHERE duplicate_number > 1);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_alertmanager_aggregate_uq"
  ON "issues" USING btree ("company_id", "origin_kind", "origin_id")
  WHERE "origin_kind" = 'plugin:paperclip-plugin-alertmanager'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL;

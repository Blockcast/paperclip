-- BLO-19566 AC4. The GitHub webhook now upserts a `pull_request` work product
-- for every issue a PR references, on open/reopen/ready_for_review/draft/push/
-- close. GitHub can deliver `synchronize` events for one PR concurrently, and
-- a select-then-insert has no row to lock when the row does not exist yet, so
-- two deliveries would each insert and leave duplicate rows for one PR.
--
-- This unique index gives the upsert a real conflict target. It is scoped to
-- rows that carry an external identity (external_id NOT NULL); hand-created
-- work products from the REST route normally leave external_id null and are
-- unaffected. Some pre-index rows can still collide if a prior webhook retry or
-- manual import wrote the same external identity more than once, so reconcile
-- deterministically before the index is created.
--
-- Keyed on (company_id, issue_id, provider, type, external_id) rather than the
-- narrower (company_id, provider, external_id): one PR legitimately maps to
-- several issues when its branch/title/body reference more than one, and each
-- of those issues needs its own row.
WITH ranked AS (
  SELECT
    "id",
    "external_id",
    row_number() OVER (
      PARTITION BY "company_id", "issue_id", "provider", "type", "external_id"
      ORDER BY "updated_at" DESC NULLS LAST, "created_at" DESC NULLS LAST, "id" DESC
    ) AS "external_identity_rank"
  FROM "issue_work_products"
  WHERE "external_id" IS NOT NULL
)
UPDATE "issue_work_products" AS wp
SET
  "external_id" = NULL,
  "metadata" = coalesce(wp."metadata", '{}'::jsonb) || jsonb_build_object(
    'dedupedExternalId', ranked."external_id",
    'dedupedByMigration', '0208_issue_work_products_external_identity'
  ),
  "updated_at" = now()
FROM ranked
WHERE wp."id" = ranked."id"
  AND ranked."external_identity_rank" > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "issue_work_products_issue_provider_type_external_id_uniq"
  ON "issue_work_products" USING btree (
    "company_id",
    "issue_id",
    "provider",
    "type",
    "external_id"
  )
  WHERE "external_id" IS NOT NULL;

-- BLO-19566 AC4. The GitHub webhook now upserts a `pull_request` work product
-- for every issue a PR references, on open/reopen/ready_for_review/draft/push/
-- close. GitHub can deliver `synchronize` events for one PR concurrently, and
-- a select-then-insert has no row to lock when the row does not exist yet, so
-- two deliveries would each insert and leave duplicate rows for one PR.
--
-- This unique index gives the upsert a real conflict target. It is scoped to
-- rows that carry an external identity (external_id NOT NULL); hand-created
-- work products from the REST route leave external_id null and are unaffected,
-- so no existing row can violate it.
--
-- Keyed on (company_id, issue_id, provider, type, external_id) rather than the
-- narrower (company_id, provider, external_id): one PR legitimately maps to
-- several issues when its branch/title/body reference more than one, and each
-- of those issues needs its own row.
CREATE UNIQUE INDEX IF NOT EXISTS "issue_work_products_issue_provider_type_external_id_uniq"
  ON "issue_work_products" USING btree (
    "company_id",
    "issue_id",
    "provider",
    "type",
    "external_id"
  )
  WHERE "external_id" IS NOT NULL;

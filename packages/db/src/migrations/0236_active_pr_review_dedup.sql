-- Drizzle migrations are transactional, so production must precreate this exact
-- unique index online. Empty databases can create it safely during bootstrap.
-- Mirrors 0233, which builds the same index shape on this same table.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: guarded below so non-empty databases must precreate the index concurrently.
DO $$
DECLARE
  normalized_predicate text;
  duplicate_sample text;
  index_is_correct boolean := false;
  expected_predicate constant text :=
    'origin_kind = ''pr_review''::text AND origin_fingerprint <> ''default''::text AND hidden_at IS NULL AND (status <> ALL (ARRAY[''done''::text, ''cancelled''::text]))';
BEGIN
  IF to_regclass('public.issues_active_pr_review_uq') IS NOT NULL THEN
    SELECT trim(regexp_replace(
             coalesce(pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE), ''),
             '\s+', ' ', 'g'))
      INTO normalized_predicate
      FROM pg_index AS index_metadata
     WHERE index_metadata.indexrelid = to_regclass('public.issues_active_pr_review_uq');

    SELECT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.issues_active_pr_review_uq')
        AND index_metadata.indrelid = 'public.issues'::regclass
        AND index_metadata.indisvalid
        AND index_metadata.indisunique
        AND access_method.amname = 'btree'
        AND index_metadata.indnkeyatts = 3
        AND index_metadata.indnatts = 3
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['company_id', 'origin_kind', 'origin_fingerprint']
        AND index_metadata.indoption = '0 0 0'::int2vector
        AND normalized_predicate = expected_predicate
    ) INTO index_is_correct;

    -- The index already enforces uniqueness, so no collision can exist and the
    -- scan below would be wasted work on the one path that is already correct.
    IF index_is_correct THEN
      RETURN;
    END IF;
  END IF;

  -- Every remaining path either builds the index or demands the operator build
  -- it. A pre-existing collision makes each of those fail with a raw 23505 and
  -- an INVALID leftover index, whose retry then reports a malformed index --
  -- a loop that never once names the rows that are the actual cause. Name them.
  SELECT string_agg(
           format('(company_id=%s, origin_fingerprint=%s, active_rows=%s)',
                  duplicates.company_id, duplicates.origin_fingerprint, duplicates.active_rows),
           ', ' ORDER BY duplicates.origin_fingerprint)
    INTO duplicate_sample
    FROM (
      SELECT company_id, origin_fingerprint, count(*) AS active_rows
        FROM "issues"
       WHERE "origin_kind" = 'pr_review'
         AND "origin_fingerprint" <> 'default'
         AND "hidden_at" IS NULL
         AND "status" NOT IN ('done', 'cancelled')
       GROUP BY company_id, origin_fingerprint
      HAVING count(*) > 1
       LIMIT 10
    ) AS duplicates;

  IF duplicate_sample IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 0236 found duplicate active pr_review issues',
      HINT = 'The unique index cannot be built while these collide: ' || duplicate_sample ||
             '. Resolve all but one row per group (set status to ''done'' or ''cancelled'', or set hidden_at) and retry migrations. List them with: SELECT id, company_id, origin_fingerprint, status FROM issues WHERE origin_kind = ''pr_review'' AND origin_fingerprint <> ''default'' AND hidden_at IS NULL AND status NOT IN (''done'', ''cancelled'') ORDER BY company_id, origin_fingerprint, created_at;';
  END IF;

  IF to_regclass('public.issues_active_pr_review_uq') IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 0236 found an invalid or incorrectly defined prerequisite index',
      HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS issues_active_pr_review_uq; then CREATE UNIQUE INDEX CONCURRENTLY issues_active_pr_review_uq ON issues USING btree (company_id, origin_kind, origin_fingerprint) WHERE origin_kind = ''pr_review'' AND origin_fingerprint <> ''default'' AND hidden_at IS NULL AND status NOT IN (''done'', ''cancelled''); then retry migrations.';
  END IF;

  IF EXISTS (SELECT 1 FROM "issues" LIMIT 1) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 0236 requires online index precreation',
      HINT = 'Run CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS issues_active_pr_review_uq ON issues USING btree (company_id, origin_kind, origin_fingerprint) WHERE origin_kind = ''pr_review'' AND origin_fingerprint <> ''default'' AND hidden_at IS NULL AND status NOT IN (''done'', ''cancelled''), then retry migrations.';
  END IF;

  LOCK TABLE "issues" IN SHARE MODE;
  IF EXISTS (SELECT 1 FROM "issues" LIMIT 1) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 0236 requires online index precreation',
      HINT = 'Run CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS issues_active_pr_review_uq ON issues USING btree (company_id, origin_kind, origin_fingerprint) WHERE origin_kind = ''pr_review'' AND origin_fingerprint <> ''default'' AND hidden_at IS NULL AND status NOT IN (''done'', ''cancelled''), then retry migrations.';
  END IF;

  CREATE UNIQUE INDEX "issues_active_pr_review_uq"
    ON "issues" USING btree ("company_id", "origin_kind", "origin_fingerprint")
    WHERE "origin_kind" = 'pr_review'
      AND "origin_fingerprint" <> 'default'
      AND "hidden_at" IS NULL
      AND "status" NOT IN ('done', 'cancelled');
END
$$;

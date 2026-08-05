-- Drizzle migrations are transactional, so production must precreate this exact
-- unique index online. Empty databases can create it safely during bootstrap.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: guarded below so non-empty databases must precreate the index concurrently.
DO $$
DECLARE
  normalized_predicate text;
  expected_predicate constant text :=
    'origin_kind = ''plugin:paperclip-plugin-alertmanager''::text AND origin_fingerprint <> ''default''::text AND hidden_at IS NULL AND (status <> ALL (ARRAY[''done''::text, ''cancelled''::text]))';
BEGIN
  IF to_regclass('public.issues_active_alertmanager_aggregate_creation_uq') IS NOT NULL THEN
    SELECT trim(regexp_replace(
             coalesce(pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE), ''),
             '\s+', ' ', 'g'))
      INTO normalized_predicate
      FROM pg_index AS index_metadata
     WHERE index_metadata.indexrelid = to_regclass('public.issues_active_alertmanager_aggregate_creation_uq');

    IF NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.issues_active_alertmanager_aggregate_creation_uq')
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
    )
    THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0211 found an invalid or incorrectly defined prerequisite index',
        HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS issues_active_alertmanager_aggregate_creation_uq; then CREATE UNIQUE INDEX CONCURRENTLY issues_active_alertmanager_aggregate_creation_uq ON issues USING btree (company_id, origin_kind, origin_fingerprint) WHERE origin_kind = ''plugin:paperclip-plugin-alertmanager'' AND origin_fingerprint <> ''default'' AND hidden_at IS NULL AND status NOT IN (''done'', ''cancelled''); then retry migrations.';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "issues" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0211 requires online index precreation',
        HINT = 'Run CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS issues_active_alertmanager_aggregate_creation_uq ON issues USING btree (company_id, origin_kind, origin_fingerprint) WHERE origin_kind = ''plugin:paperclip-plugin-alertmanager'' AND origin_fingerprint <> ''default'' AND hidden_at IS NULL AND status NOT IN (''done'', ''cancelled''), then retry migrations.';
    END IF;

    LOCK TABLE "issues" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "issues" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0211 requires online index precreation',
        HINT = 'Run CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS issues_active_alertmanager_aggregate_creation_uq ON issues USING btree (company_id, origin_kind, origin_fingerprint) WHERE origin_kind = ''plugin:paperclip-plugin-alertmanager'' AND origin_fingerprint <> ''default'' AND hidden_at IS NULL AND status NOT IN (''done'', ''cancelled''), then retry migrations.';
    END IF;

    CREATE UNIQUE INDEX "issues_active_alertmanager_aggregate_creation_uq"
      ON "issues" USING btree ("company_id", "origin_kind", "origin_fingerprint")
      WHERE "origin_kind" = 'plugin:paperclip-plugin-alertmanager'
        AND "origin_fingerprint" <> 'default'
        AND "hidden_at" IS NULL
        AND "status" NOT IN ('done', 'cancelled');
  END IF;
END
$$;

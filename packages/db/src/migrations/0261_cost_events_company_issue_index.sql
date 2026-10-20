-- BLO-47753: index the per-issue cost rollup.
--
--   SELECT coalesce(sum(cost_cents), $3)::int FROM cost_events
--   WHERE company_id = $1 AND issue_id = $2
--
-- (plus its `issue_id = ANY(...)` and join variants) is the top query by DB
-- time in production: 8.48M calls / 595k s since 2026-08-20, 117 ms mean.
-- Every cost_events index leads with company_id and none contains issue_id.
-- Measured with EXPLAIN (ANALYZE, BUFFERS) at 431k rows, 11 matching:
--
--   custom plan:   Seq Scan, 163 ms, 14k buffers
--   generic plan:  Index Scan on cost_events_company_heartbeat_run_idx,
--                  filtering issue_id (395k rows removed), 2163 ms,
--                  256k buffers hit + 2.2k read
--
-- The generic plan is estimated CHEAPER (17146 vs 20250), so long-lived
-- prepared statements settle on it. With (company_id, issue_id) both plans
-- become an index lookup proportional to the issue's own cost rows.
--
-- Built online exactly like 0259: the index is registered in
-- PENDING_CONCURRENT_INDEXES, so the migration runner builds it CONCURRENTLY
-- outside a transaction immediately before applying this file, and
-- `pending-migration-preflight` reports an absent one before `helm upgrade`.
-- The guard below is the backstop: a populated table with no index fails the
-- migration carrying the exact command, and a precreated index that does not
-- match this definition is rejected. Empty databases build it inline.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: the populated-table path fails closed and supplies the concurrent command.
DO $$
BEGIN
  IF to_regclass('public.cost_events_company_issue_idx') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.cost_events_company_issue_idx')
        AND index_metadata.indrelid = 'public.cost_events'::regclass
        AND index_metadata.indisvalid
        AND index_metadata.indisready
        AND access_method.amname = 'btree'
        AND index_metadata.indnkeyatts = 2
        AND index_metadata.indnatts = 2
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['company_id', 'issue_id']
        AND index_metadata.indoption = '0 0'::int2vector
        AND index_metadata.indpred IS NULL
    )
    THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0261 found an invalid or incorrectly defined cost_events_company_issue_idx',
        HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS cost_events_company_issue_idx; then CREATE INDEX CONCURRENTLY cost_events_company_issue_idx ON cost_events USING btree (company_id, issue_id); then retry migrations.';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "cost_events" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0261 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS cost_events_company_issue_idx ON cost_events USING btree (company_id, issue_id); then retry migrations.';
    END IF;

    -- Close the gap between the empty-table check and CREATE INDEX without
    -- taking this lock on a populated production table.
    LOCK TABLE "cost_events" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "cost_events" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0261 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS cost_events_company_issue_idx ON cost_events USING btree (company_id, issue_id); then retry migrations.';
    END IF;

    CREATE INDEX "cost_events_company_issue_idx"
      ON "cost_events" USING btree ("company_id", "issue_id");
  END IF;
END
$$;

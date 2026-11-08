-- PEN-6104: index the wake-payload MEMBERSHIP disjunction.
--
-- `agent_wakeup_requests.payload` carried no index of any kind -- not btree,
-- not GIN, not an expression index -- while five subsystems read the same
-- four-arm predicate off it:
--
--   payload ->> 'issueId' = $1
--   or payload ->> 'taskId' = $1
--   or payload -> '_paperclipWakeContext' ->> 'issueId' = $1
--   or payload -> '_paperclipWakeContext' ->> 'taskId' = $1
--
--   services/issues.ts (GET /issues/:id/diagnostics/wakes)
--   services/heartbeat.ts (wake resolution)
--   services/recovery/service.ts (recovery sweep)
--   services/task-watchdogs.ts (subtree scan, and the per-issue probe)
--
-- The planner's only option was `agent_wakeup_requests_company_requested_idx`
-- with all four arms as a per-row recheck, each needing a heap fetch and a
-- `jsonb` detoast. The `LIMIT` on those reads does NOT bound it: it
-- short-circuits only while matches are DENSE near the top of the range, so a
-- row whose wakes are sparse in the window -- most rows, and every row an
-- operator is likely to be investigating -- is answered only after the whole
-- window has been walked. Measured in production between two rows of this
-- table: a 2,664-wake issue answered in 5.4 ms after rejecting 3,086 rows; a
-- 6-wake issue took 237.6 ms and rejected all 158,651 rows. ~9% of
-- `/diagnostics/wakes` calls sat in the 30-60 s bucket, against a 30 s
-- statement_timeout.
--
-- WHY FOUR PARTIAL BTREES AND NOT ONE OBJECT. All four alternatives were built
-- and measured at 2M seeded rows
-- (packages/db/src/agent-wakeup-payload-index-shape.bench.ts):
--
--   GIN jsonb_path_ops on payload ... 151 MB. Carries neither company_id nor
--     requested_at, so it cannot supply the ordering the LIMIT needs: the
--     COMMON dense path went 42x WORSE (5.4 -> 226.2 ms). A btree_gin
--     composite fixes only the reachability half and is still 7x baseline.
--   stored generated scalar column ... cheapest object, serves ordering, and
--     DISQUALIFIED twice over: `ADD COLUMN ... GENERATED ... STORED` rewrites
--     the table under ACCESS EXCLUSIVE (74.9 s at 2M, linear -- minutes at
--     production size, on the table every heartbeat writes to), and its
--     natural `coalesce(...)` definition models ATTRIBUTION, not MEMBERSHIP:
--     on a row whose nested context names a different issue from its top
--     level, the disjunction finds 1 and the coalesce finds 0 (measured, not
--     asserted -- agent-wakeup-payload-target-semantics.test.ts).
--   generated text[] + GIN ... exact membership in ONE object and the
--     smallest index measured (14 MB), but still takes the rewrite (66.8 s)
--     and still loses the ordering (dense 107.9 ms).
--
-- These four are the only shape that is simultaneously exact on membership,
-- orders by requested_at so the LIMIT becomes real, and needs no table
-- rewrite. Sparse probe 237.6 -> 0.2 ms (1,188x). Price: 124 MB total (~20% of
-- this table's heap) and ~35% of insert throughput here. That price is
-- deliberate and was approved as a capacity call on PEN-6104: the status quo
-- degrades LINEARLY with the retained window while this cost does not, and
-- the read I/O removed lands on the same device as the writes.
--
-- ⛔ THE READER MUST CARRY THE `?` GUARD OR THESE FOUR OBJECTS ARE DEAD WEIGHT.
-- A partial index is usable only where the planner can PROVE the query implies
-- its predicate, and `payload ->> 'issueId' = $1` does not imply
-- `payload ? 'issueId'` -- it entails it semantically, which is not the same
-- thing. Built against the UNGUARDED reader these indexes measured 253.8 ms:
-- the unindexed plan, unchanged, now carrying 124 MB. The guarded form
--
--   (payload ? 'issueId' and payload ->> 'issueId' = $1) or ...
--
-- is logically identical and is what every reader now issues, via
-- `wakeRequestTargetsIssueCondition` /
-- `wakeRequestTargetsAnyIssueCondition` in
-- server/src/services/agent-wakeup-target.ts. ⚠️ This migration is therefore
-- COUPLED to that application version in one direction: rolling the code back
-- without rolling this back leaves correct results and no speedup. It is not
-- coupled the other way -- the guarded predicate is correct with or without
-- the indexes.
--
-- ⚠️ DEPLOY NOTE. Registered in PENDING_CONCURRENT_INDEXES, so all four are
-- built CONCURRENTLY and ONE AT A TIME by the deploy-time precreation step and
-- again by the migration runner immediately before this file; the statements
-- below then only validate them. That is not optional:
-- `agent_wakeup_requests` is in the `large` bucket, is described in its own
-- schema comment as "the largest table in the schema, pruned only to a 14-day
-- retention window", and takes a write on every wake. A plain transactional
-- build would hold a SHARE lock across all four. One at a time matters for a
-- second reason: each CONCURRENTLY build holds back the xmin horizon for its
-- duration -- watch `pg_paperclip_mvcc_xid_horizon_span` and
-- `pg_paperclip_table_mvcc_n_dead_tup` across the window.
--
-- A populated table with no index fails closed carrying the exact command; a
-- precreated index whose definition does not match is rejected rather than
-- tolerated; only an empty table (fresh database, CI) builds inline, behind a
-- SHARE lock that closes the gap between the emptiness check and the build.
--
-- The manual opt-out, if an operator wants this off the migration path:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_payload_issue_idx
--     ON agent_wakeup_requests USING btree (company_id, (payload ->> 'issueId'), requested_at DESC)
--     WHERE payload ? 'issueId';
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_payload_task_idx
--     ON agent_wakeup_requests USING btree (company_id, (payload ->> 'taskId'), requested_at DESC)
--     WHERE payload ? 'taskId';
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_payload_context_issue_idx
--     ON agent_wakeup_requests USING btree (company_id, ((payload -> '_paperclipWakeContext') ->> 'issueId'), requested_at DESC)
--     WHERE payload -> '_paperclipWakeContext' ? 'issueId';
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_payload_context_task_idx
--     ON agent_wakeup_requests USING btree (company_id, ((payload -> '_paperclipWakeContext') ->> 'taskId'), requested_at DESC)
--     WHERE payload -> '_paperclipWakeContext' ? 'taskId';
--
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: the populated-table path fails closed and supplies the concurrent command.
DO $$
BEGIN
  IF to_regclass('public.agent_wakeup_requests_payload_issue_idx') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.agent_wakeup_requests_payload_issue_idx')
        AND index_metadata.indrelid = 'public.agent_wakeup_requests'::regclass
        AND index_metadata.indisvalid
        AND index_metadata.indisready
        AND access_method.amname = 'btree'
        AND index_metadata.indnkeyatts = 3
        AND index_metadata.indnatts = 3
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['company_id', '(payload ->> ''issueId''::text)', 'requested_at']
        -- 0 = ASC NULLS LAST, 3 = DESC NULLS FIRST. The trailing DESC is what
        -- lets `ORDER BY requested_at DESC ... LIMIT` come back ordered rather
        -- than sorted -- the half no GIN candidate could supply. A precreate
        -- built ASC indexes the same rows and loses that, so it is rejected.
        AND index_metadata.indoption = '0 0 3'::int2vector
        -- The partial predicate is the whole reason the guarded reader exists;
        -- a precreate built WITHOUT it (or with a different key) is a
        -- different index that the guarded arms cannot reach.
        AND trim(regexp_replace(
              coalesce(pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE), ''),
              '\s+', ' ', 'g'))
            = 'payload ? ''issueId''::text'
    )
    THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0278 found an invalid or incorrectly defined agent_wakeup_requests_payload_issue_idx',
        HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS agent_wakeup_requests_payload_issue_idx; then CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_payload_issue_idx ON agent_wakeup_requests USING btree (company_id, (payload ->> ''issueId''), requested_at DESC) WHERE payload ? ''issueId''; then retry migrations.';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "agent_wakeup_requests" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0278 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_payload_issue_idx ON agent_wakeup_requests USING btree (company_id, (payload ->> ''issueId''), requested_at DESC) WHERE payload ? ''issueId''; then retry migrations.';
    END IF;

    -- Close the gap between the empty-table check and CREATE INDEX without
    -- taking this lock on a populated production table.
    LOCK TABLE "agent_wakeup_requests" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "agent_wakeup_requests" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0278 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_payload_issue_idx ON agent_wakeup_requests USING btree (company_id, (payload ->> ''issueId''), requested_at DESC) WHERE payload ? ''issueId''; then retry migrations.';
    END IF;

    CREATE INDEX "agent_wakeup_requests_payload_issue_idx"
      ON "agent_wakeup_requests" USING btree ("company_id", (("payload" ->> 'issueId')), "requested_at" DESC)
      WHERE "payload" ? 'issueId';
  END IF;
END
$$;
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: the populated-table path fails closed and supplies the concurrent command.
DO $$
BEGIN
  IF to_regclass('public.agent_wakeup_requests_payload_task_idx') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.agent_wakeup_requests_payload_task_idx')
        AND index_metadata.indrelid = 'public.agent_wakeup_requests'::regclass
        AND index_metadata.indisvalid
        AND index_metadata.indisready
        AND access_method.amname = 'btree'
        AND index_metadata.indnkeyatts = 3
        AND index_metadata.indnatts = 3
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['company_id', '(payload ->> ''taskId''::text)', 'requested_at']
        -- 0 = ASC NULLS LAST, 3 = DESC NULLS FIRST. The trailing DESC is what
        -- lets `ORDER BY requested_at DESC ... LIMIT` come back ordered rather
        -- than sorted -- the half no GIN candidate could supply. A precreate
        -- built ASC indexes the same rows and loses that, so it is rejected.
        AND index_metadata.indoption = '0 0 3'::int2vector
        -- The partial predicate is the whole reason the guarded reader exists;
        -- a precreate built WITHOUT it (or with a different key) is a
        -- different index that the guarded arms cannot reach.
        AND trim(regexp_replace(
              coalesce(pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE), ''),
              '\s+', ' ', 'g'))
            = 'payload ? ''taskId''::text'
    )
    THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0278 found an invalid or incorrectly defined agent_wakeup_requests_payload_task_idx',
        HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS agent_wakeup_requests_payload_task_idx; then CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_payload_task_idx ON agent_wakeup_requests USING btree (company_id, (payload ->> ''taskId''), requested_at DESC) WHERE payload ? ''taskId''; then retry migrations.';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "agent_wakeup_requests" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0278 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_payload_task_idx ON agent_wakeup_requests USING btree (company_id, (payload ->> ''taskId''), requested_at DESC) WHERE payload ? ''taskId''; then retry migrations.';
    END IF;

    -- Close the gap between the empty-table check and CREATE INDEX without
    -- taking this lock on a populated production table.
    LOCK TABLE "agent_wakeup_requests" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "agent_wakeup_requests" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0278 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_payload_task_idx ON agent_wakeup_requests USING btree (company_id, (payload ->> ''taskId''), requested_at DESC) WHERE payload ? ''taskId''; then retry migrations.';
    END IF;

    CREATE INDEX "agent_wakeup_requests_payload_task_idx"
      ON "agent_wakeup_requests" USING btree ("company_id", (("payload" ->> 'taskId')), "requested_at" DESC)
      WHERE "payload" ? 'taskId';
  END IF;
END
$$;
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: the populated-table path fails closed and supplies the concurrent command.
DO $$
BEGIN
  IF to_regclass('public.agent_wakeup_requests_payload_context_issue_idx') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.agent_wakeup_requests_payload_context_issue_idx')
        AND index_metadata.indrelid = 'public.agent_wakeup_requests'::regclass
        AND index_metadata.indisvalid
        AND index_metadata.indisready
        AND access_method.amname = 'btree'
        AND index_metadata.indnkeyatts = 3
        AND index_metadata.indnatts = 3
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['company_id', '((payload -> ''_paperclipWakeContext''::text) ->> ''issueId''::text)', 'requested_at']
        -- 0 = ASC NULLS LAST, 3 = DESC NULLS FIRST. The trailing DESC is what
        -- lets `ORDER BY requested_at DESC ... LIMIT` come back ordered rather
        -- than sorted -- the half no GIN candidate could supply. A precreate
        -- built ASC indexes the same rows and loses that, so it is rejected.
        AND index_metadata.indoption = '0 0 3'::int2vector
        -- The partial predicate is the whole reason the guarded reader exists;
        -- a precreate built WITHOUT it (or with a different key) is a
        -- different index that the guarded arms cannot reach.
        AND trim(regexp_replace(
              coalesce(pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE), ''),
              '\s+', ' ', 'g'))
            = '(payload -> ''_paperclipWakeContext''::text) ? ''issueId''::text'
    )
    THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0278 found an invalid or incorrectly defined agent_wakeup_requests_payload_context_issue_idx',
        HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS agent_wakeup_requests_payload_context_issue_idx; then CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_payload_context_issue_idx ON agent_wakeup_requests USING btree (company_id, ((payload -> ''_paperclipWakeContext'') ->> ''issueId''), requested_at DESC) WHERE payload -> ''_paperclipWakeContext'' ? ''issueId''; then retry migrations.';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "agent_wakeup_requests" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0278 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_payload_context_issue_idx ON agent_wakeup_requests USING btree (company_id, ((payload -> ''_paperclipWakeContext'') ->> ''issueId''), requested_at DESC) WHERE payload -> ''_paperclipWakeContext'' ? ''issueId''; then retry migrations.';
    END IF;

    -- Close the gap between the empty-table check and CREATE INDEX without
    -- taking this lock on a populated production table.
    LOCK TABLE "agent_wakeup_requests" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "agent_wakeup_requests" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0278 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_payload_context_issue_idx ON agent_wakeup_requests USING btree (company_id, ((payload -> ''_paperclipWakeContext'') ->> ''issueId''), requested_at DESC) WHERE payload -> ''_paperclipWakeContext'' ? ''issueId''; then retry migrations.';
    END IF;

    CREATE INDEX "agent_wakeup_requests_payload_context_issue_idx"
      ON "agent_wakeup_requests" USING btree ("company_id", ((("payload" -> '_paperclipWakeContext') ->> 'issueId')), "requested_at" DESC)
      WHERE "payload" -> '_paperclipWakeContext' ? 'issueId';
  END IF;
END
$$;
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: the populated-table path fails closed and supplies the concurrent command.
DO $$
BEGIN
  IF to_regclass('public.agent_wakeup_requests_payload_context_task_idx') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.agent_wakeup_requests_payload_context_task_idx')
        AND index_metadata.indrelid = 'public.agent_wakeup_requests'::regclass
        AND index_metadata.indisvalid
        AND index_metadata.indisready
        AND access_method.amname = 'btree'
        AND index_metadata.indnkeyatts = 3
        AND index_metadata.indnatts = 3
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['company_id', '((payload -> ''_paperclipWakeContext''::text) ->> ''taskId''::text)', 'requested_at']
        -- 0 = ASC NULLS LAST, 3 = DESC NULLS FIRST. The trailing DESC is what
        -- lets `ORDER BY requested_at DESC ... LIMIT` come back ordered rather
        -- than sorted -- the half no GIN candidate could supply. A precreate
        -- built ASC indexes the same rows and loses that, so it is rejected.
        AND index_metadata.indoption = '0 0 3'::int2vector
        -- The partial predicate is the whole reason the guarded reader exists;
        -- a precreate built WITHOUT it (or with a different key) is a
        -- different index that the guarded arms cannot reach.
        AND trim(regexp_replace(
              coalesce(pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE), ''),
              '\s+', ' ', 'g'))
            = '(payload -> ''_paperclipWakeContext''::text) ? ''taskId''::text'
    )
    THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0278 found an invalid or incorrectly defined agent_wakeup_requests_payload_context_task_idx',
        HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS agent_wakeup_requests_payload_context_task_idx; then CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_payload_context_task_idx ON agent_wakeup_requests USING btree (company_id, ((payload -> ''_paperclipWakeContext'') ->> ''taskId''), requested_at DESC) WHERE payload -> ''_paperclipWakeContext'' ? ''taskId''; then retry migrations.';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "agent_wakeup_requests" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0278 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_payload_context_task_idx ON agent_wakeup_requests USING btree (company_id, ((payload -> ''_paperclipWakeContext'') ->> ''taskId''), requested_at DESC) WHERE payload -> ''_paperclipWakeContext'' ? ''taskId''; then retry migrations.';
    END IF;

    -- Close the gap between the empty-table check and CREATE INDEX without
    -- taking this lock on a populated production table.
    LOCK TABLE "agent_wakeup_requests" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "agent_wakeup_requests" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0278 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_payload_context_task_idx ON agent_wakeup_requests USING btree (company_id, ((payload -> ''_paperclipWakeContext'') ->> ''taskId''), requested_at DESC) WHERE payload -> ''_paperclipWakeContext'' ? ''taskId''; then retry migrations.';
    END IF;

    CREATE INDEX "agent_wakeup_requests_payload_context_task_idx"
      ON "agent_wakeup_requests" USING btree ("company_id", ((("payload" -> '_paperclipWakeContext') ->> 'taskId')), "requested_at" DESC)
      WHERE "payload" -> '_paperclipWakeContext' ? 'taskId';
  END IF;
END
$$;

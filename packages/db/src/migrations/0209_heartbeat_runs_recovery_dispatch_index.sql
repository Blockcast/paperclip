-- BLO-20396 (review follow-up): index the recovery dispatch lane.
--
-- Migration 0208 gave the dispatcher's main keyset scan an index. It did not
-- help priority lane B, which selects recovery-action wakes:
--
--   SELECT * FROM heartbeat_runs
--    WHERE agent_id = $1 AND status = 'queued' [AND created_at >= $cutoff]
--      AND context_snapshot ->> 'source' = 'issue_recovery_action'
--      AND context_snapshot ->> 'recoveryActionId' IS NOT NULL
--    ORDER BY created_at ASC, id ASC
--    LIMIT $scanLimit
--
-- Both JSON predicates are unindexed expressions, so 0208's index supplies the
-- agent's queued rows in dispatch order and the executor filters them one by
-- one. When the agent has NO recovery work — the overwhelmingly common case —
-- there is nothing for the LIMIT to stop early on, so PostgreSQL walks the
-- agent's entire queued set to return zero rows, and it does that while the
-- strict per-agent start lock is held. Ally reached 339 queued rows during the
-- incident this ticket came from; the cost is O(agent queue depth) on every
-- dispatch pass, which is the same defect shape as the company-wide issue scan
-- 0208's lane split removed, one level down.
--
-- A partial index on the lane's own predicate makes the zero-match case O(1):
-- the index contains only recovery rows, so "this agent has no recovery work"
-- is answered by an empty index range rather than by a filtered walk. It is
-- also very small — recovery wakes are a thin slice of a queue that is itself a
-- thin slice of the table (~850 dispatchable rows out of ~219k).
--
-- Only `queued` is included, unlike 0208's `('queued','scheduled_retry')`: this
-- lane never reads scheduled_retry, and a tighter predicate keeps the index
-- smaller. `status` is consequently NOT a key column — it is constant across
-- every entry — so the keys are exactly the columns the lane orders and seeks
-- on. Both recovery markers belong in the predicate. Keeping malformed source-only
-- rows out of the index means the lane's LIMIT bounds index work as well as
-- output; otherwise an arbitrarily large malformed backlog can still be walked
-- before the first valid recovery wake is found.
--
-- `context_snapshot` is jsonb, so `->>` is IMMUTABLE and legal in an index
-- predicate. (Were it json, `->>` would be merely STABLE and this would be
-- rejected. Migration 0079 relies on the same property for its generated
-- columns.) A generated stored column plus a plain index would be the other
-- option and is how 0079 handles hot keys, but adding one now would rewrite a
-- 1.8 GB hot table under AccessExclusive; a partial index can be built
-- concurrently instead, so it is the cheaper route to the same plan.
--
-- Drizzle migrations are transactional, so CONCURRENTLY is unavailable here and
-- a plain CREATE INDEX would hold a SHARE lock on that hot table for the whole
-- build. The guard below therefore makes online precreation a required and
-- verified prerequisite, exactly as 0208 does: a populated database fails with
-- the command to run, and a precreated index that does not match this
-- definition is rejected rather than silently accepted. Empty databases (tests,
-- bootstrap) build it inline, where there is nothing to block.
--
-- Predicate guard: fail closed. Earlier versions checked three independent
-- LIKE tokens, which accepted broader/wrong predicates such as
-- `status = 'queued' OR source = 'issue_recovery_action'` or
-- `source <> 'issue_recovery_action'`. Either shape restores the scan this
-- index exists to remove, so the precreated index must match PostgreSQL's
-- measured canonical predicate exactly.
--
-- `pg_get_expr(indpred, indrelid, TRUE)` was MEASURED on a real PostgreSQL
-- after this migration ran (not assumed) as:
--
--   status = 'queued'::text AND (context_snapshot ->> 'source'::text) = 'issue_recovery_action'::text AND (context_snapshot ->> 'recoveryActionId'::text) IS NOT NULL
--
-- Note it parenthesizes the second operand but not the first, and annotates
-- both the operator's argument and its result with ::text — which is exactly
-- the kind of detail a hand-written expected string tends to get wrong.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: guarded below so non-empty databases must precreate the index concurrently.
DO $$
DECLARE
  normalized_predicate text;
  expected_predicate constant text :=
    'status = ''queued''::text AND (context_snapshot ->> ''source''::text) = ''issue_recovery_action''::text AND (context_snapshot ->> ''recoveryActionId''::text) IS NOT NULL';
BEGIN
  IF to_regclass('public.heartbeat_runs_recovery_dispatch_idx') IS NOT NULL THEN
    SELECT trim(regexp_replace(
             coalesce(pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE), ''),
             '\s+', ' ', 'g'))
      INTO normalized_predicate
      FROM pg_index AS index_metadata
     WHERE index_metadata.indexrelid = to_regclass('public.heartbeat_runs_recovery_dispatch_idx');

    IF NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.heartbeat_runs_recovery_dispatch_idx')
        AND index_metadata.indrelid = 'public.heartbeat_runs'::regclass
        AND index_metadata.indisvalid
        AND access_method.amname = 'btree'
        AND index_metadata.indnkeyatts = 3
        AND index_metadata.indnatts = 3
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['agent_id', 'created_at', 'id']
        AND index_metadata.indoption = '0 0 0'::int2vector
        AND normalized_predicate = expected_predicate
    )
    THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0209 found an invalid or incorrectly defined prerequisite index',
        HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_recovery_dispatch_idx; then CREATE INDEX CONCURRENTLY heartbeat_runs_recovery_dispatch_idx ON heartbeat_runs USING btree (agent_id, created_at, id) WHERE status = ''queued'' AND (context_snapshot ->> ''source'') = ''issue_recovery_action'' AND (context_snapshot ->> ''recoveryActionId'') IS NOT NULL; then retry migrations.';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0209 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_recovery_dispatch_idx ON heartbeat_runs USING btree (agent_id, created_at, id) WHERE status = ''queued'' AND (context_snapshot ->> ''source'') = ''issue_recovery_action'' AND (context_snapshot ->> ''recoveryActionId'') IS NOT NULL, then retry migrations.';
    END IF;

    -- Close the gap between the empty-table check and CREATE INDEX without
    -- taking this lock on populated production tables.
    LOCK TABLE "heartbeat_runs" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0209 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_recovery_dispatch_idx ON heartbeat_runs USING btree (agent_id, created_at, id) WHERE status = ''queued'' AND (context_snapshot ->> ''source'') = ''issue_recovery_action'' AND (context_snapshot ->> ''recoveryActionId'') IS NOT NULL, then retry migrations.';
    END IF;

    CREATE INDEX "heartbeat_runs_recovery_dispatch_idx"
      ON "heartbeat_runs" USING btree (
        "agent_id",
        "created_at",
        "id"
      )
      WHERE "status" = 'queued'
        AND ("context_snapshot" ->> 'source') = 'issue_recovery_action'
        AND ("context_snapshot" ->> 'recoveryActionId') IS NOT NULL;
  END IF;
END
$$;

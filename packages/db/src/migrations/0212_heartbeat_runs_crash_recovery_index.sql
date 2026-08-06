-- BLO-19722 / BLO-20822 — Phase B of three: supporting index for the startup
-- crash-recovery candidate scan.
--
-- Serves `reconcileWorkerCrashedRuns`, which scans oldest-first
-- (`finished_at, id`) for crash-marked runs whose recovery has not completed.
-- The partial predicate keeps the index near-empty: only unrecovered
-- crash-marked runs are members, and stamping `crash_recovery_completed_at`
-- removes a row from it, so the steady-state start is an empty index probe.
--
-- THIS FILE MUST NEVER `RAISE` BECAUSE THE INDEX IS ABSENT.
--
-- drizzle wraps *all* pending migration files in a single transaction (see the
-- header of 0211). Raising here would roll back 0211's `ADD COLUMN`, so the
-- `CREATE INDEX CONCURRENTLY` this file would be asking the operator to run
-- could never succeed — its predicate references a column the rollback just
-- removed. That is precisely the unbreakable loop this three-way split exists
-- to eliminate, and it is why this file deliberately departs from the
-- raise-and-stall pattern in 0205. 0205 can raise safely only because its index
-- predicate references columns that already existed before it ran.
--
-- The index is a performance optimisation, not a correctness requirement: with
-- it absent, the candidate scan degrades to a sequential scan that still finds
-- every candidate. Recovery is correct either way, so a missing index is an
-- acceptable intermediate state and the right response is a NOTICE, not a
-- failed deploy.
--
-- On a populated database the index is therefore left to the documented online
-- predeploy step, which is safe to run at any time after 0211 has committed:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_crash_recovery_pending_idx
--     ON heartbeat_runs USING btree (finished_at, id)
--     WHERE error_code = 'worker_crashed' AND crash_recovery_completed_at IS NULL;
--
-- `CREATE INDEX CONCURRENTLY` cannot appear in a migration file at all — it is
-- rejected inside a transaction block — so out-of-band is the only place it can
-- ever live.
--
-- An index that exists but is *wrongly defined* is a different case and does
-- raise: the fix (`DROP INDEX CONCURRENTLY`) needs nothing from this batch, so
-- there is no loop, and silently trusting a mis-defined index would be worse.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: only created inline on an empty table; populated databases use the documented CONCURRENTLY predeploy step.
DO $$
BEGIN
  IF to_regclass('public.heartbeat_runs_crash_recovery_pending_idx') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.heartbeat_runs_crash_recovery_pending_idx')
        AND index_metadata.indrelid = 'public.heartbeat_runs'::regclass
        AND index_metadata.indisvalid
        AND access_method.amname = 'btree'
        AND index_metadata.indnkeyatts = 2
        AND index_metadata.indnatts = 2
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['finished_at', 'id']
        AND index_metadata.indoption = '0 0'::int2vector
        -- Compare the predicate paren- and whitespace-insensitively.
        -- `pg_get_expr` renders a two-conjunct predicate without redundant
        -- parentheses on current PostgreSQL but brackets the conjuncts on older
        -- majors, so pinning the literal exactly would fail on a version
        -- difference alone. Neither rendering changes meaning; the operand text
        -- is still compared strictly.
        AND regexp_replace(
              translate(pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE), '()', ''),
              '\s+', ' ', 'g'
            ) = 'error_code = ''worker_crashed''::text AND crash_recovery_completed_at IS NULL'
    ) THEN
      -- Safe to raise, and the hint is followable as written: this repo's
      -- runner (`applyPendingMigrations` -> `applyPendingMigrationsManually`,
      -- packages/db/src/client.ts) wraps each migration FILE in its own
      -- transaction and commits its history row before starting the next, so
      -- phase A's columns are already durable by the time this raises. The
      -- `crash_recovery_completed_at` the recreate below references therefore
      -- exists. Pinned by the "phase A survives a phase B raise" migration test --
      -- if the runner is ever switched to drizzle's batch migrator (which does
      -- wrap all pending files in ONE transaction), that test fails and this
      -- hint must be reordered to drop -> rerun migrations -> create index.
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0212 found an invalid or incorrectly defined heartbeat_runs_crash_recovery_pending_idx',
        HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_crash_recovery_pending_idx; then recreate it with CREATE INDEX CONCURRENTLY heartbeat_runs_crash_recovery_pending_idx ON heartbeat_runs USING btree (finished_at, id) WHERE error_code = ''worker_crashed'' AND crash_recovery_completed_at IS NULL; then retry migrations.';
    END IF;

    RETURN;
  END IF;

  -- Index absent. Create it inline only when the table is empty — bootstrap and
  -- test databases, where a non-concurrent build is instantaneous and takes no
  -- meaningful lock. `SHARE MODE` closes the gap between this check and the
  -- CREATE without ever being taken on a populated production table.
  IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
    RAISE NOTICE 'migration 0212: heartbeat_runs is populated; skipping inline index build. Create heartbeat_runs_crash_recovery_pending_idx online with CREATE INDEX CONCURRENTLY (see this migration''s header). Recovery is correct without it — the candidate scan degrades to a sequential scan.';
    RETURN;
  END IF;

  LOCK TABLE "heartbeat_runs" IN SHARE MODE;
  IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
    RAISE NOTICE 'migration 0212: heartbeat_runs became non-empty while acquiring SHARE; skipping inline index build. Create heartbeat_runs_crash_recovery_pending_idx online with CREATE INDEX CONCURRENTLY (see this migration''s header).';
    RETURN;
  END IF;

  CREATE INDEX "heartbeat_runs_crash_recovery_pending_idx"
    ON "heartbeat_runs" USING btree (
      "finished_at",
      "id"
    )
    WHERE "error_code" = 'worker_crashed' AND "crash_recovery_completed_at" IS NULL;
END
$$;

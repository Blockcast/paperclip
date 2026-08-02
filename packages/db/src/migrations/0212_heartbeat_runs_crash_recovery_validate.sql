-- BLO-19722 / BLO-20822 — Phase C of three: validate that crash-recovery state
-- landed, and report (never require) the supporting index.
--
-- Split rationale in the header of 0210. In short: drizzle runs every pending
-- migration file inside one transaction, so anything that raises here rolls
-- back Phase A's columns too. This file therefore validates only what recovery
-- is actually *correct* against — the columns — and treats the index as
-- reportable, not required.
--
-- Validating the columns is worth a transactional check because every one of
-- them is load-bearing: `crash_recovery_completed_at` is the durable completion
-- marker the startup reconciler selects on, and the three backoff columns are
-- what stop a permanently-failing row from starving the oldest-first batch. If
-- 0210 were ever edited into a form that silently no-ops (an `IF NOT EXISTS`
-- against a pre-existing column of the wrong type, say), recovery would compile
-- and then misbehave at runtime. Failing the deploy is the right response, and
-- unlike a missing index it is a real, operator-fixable defect rather than a
-- deliberate intermediate state.
DO $$
DECLARE
  missing_columns text;
  index_present boolean;
BEGIN
  SELECT string_agg(required.column_name || ' ' || required.data_type, ', ' ORDER BY required.column_name)
  INTO missing_columns
  FROM (
    VALUES
      ('crash_recovery_completed_at', 'timestamp with time zone'),
      ('crash_recovery_attempts', 'integer'),
      ('crash_recovery_next_attempt_at', 'timestamp with time zone'),
      ('crash_recovery_last_error', 'text')
  ) AS required(column_name, data_type)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns AS actual
    WHERE actual.table_schema = 'public'
      AND actual.table_name = 'heartbeat_runs'
      AND actual.column_name = required.column_name
      AND actual.data_type = required.data_type
  );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 0212: heartbeat_runs is missing crash-recovery columns after 0210: ' || missing_columns,
      HINT = 'Phase A (0210) did not apply cleanly. Inspect heartbeat_runs for pre-existing columns of a conflicting type, drop or fix them, then retry migrations.';
  END IF;

  -- Reported, never required. On a populated database the index is created by
  -- the documented online `CREATE INDEX CONCURRENTLY` predeploy step, which can
  -- only run once 0210 has committed — i.e. potentially after this migration.
  -- Raising here would roll 0210 back and make that step impossible.
  index_present := to_regclass('public.heartbeat_runs_crash_recovery_pending_idx') IS NOT NULL;
  IF NOT index_present THEN
    RAISE NOTICE 'migration 0212: heartbeat_runs_crash_recovery_pending_idx is absent. Crash recovery is correct without it (the candidate scan degrades to a sequential scan); create it online when convenient — see 0211.';
  END IF;
END
$$;

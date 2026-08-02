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
--
-- WHY THIS CHECKS NULLABILITY AND DEFAULTS, NOT JUST TYPE.
--
-- Phase A adds every column with `ADD COLUMN IF NOT EXISTS`, so a pre-existing
-- column of the *same type* silently survives with whatever nullability and
-- default it already carried. Type equality alone therefore does not establish
-- the contract recovery depends on, and the failure it lets through is silent
-- rather than loud:
--
--   * `crash_recovery_completed_at timestamptz DEFAULT now()` type-matches, but
--     every newly crash-marked run is then born already "completed", and the
--     `crash_recovery_completed_at IS NULL` scan in `reconcileWorkerCrashedRuns`
--     matches nothing. Crash recovery would be a no-op on every run, forever,
--     with no error anywhere — precisely the class of defect this file exists
--     to turn into a failed deploy.
--   * `NOT NULL` type-matches too, but the completion marker and the backoff
--     columns are all read as "absent" via NULL (`crash_recovery_attempts` is
--     consumed as `?? 0`), and the completion stamp writes NULL back into
--     `crash_recovery_next_attempt_at`/`crash_recovery_last_error` — which a
--     NOT NULL column rejects at runtime.
--
-- So the required shape is: exact type, nullable, and no default. All three are
-- asserted below.
DO $$
DECLARE
  invalid_columns text;
  index_present boolean;
BEGIN
  SELECT string_agg(
           required.column_name || ' ' || required.data_type || ' (nullable, no default)',
           ', ' ORDER BY required.column_name)
  INTO invalid_columns
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
      AND actual.is_nullable = 'YES'
      AND actual.column_default IS NULL
  );

  IF invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 0212: heartbeat_runs crash-recovery columns are missing or do not match the required shape after 0210: ' || invalid_columns,
      HINT = 'Phase A (0210) did not apply cleanly, or a pre-existing column survived its ADD COLUMN IF NOT EXISTS. Each column must have the stated type, be nullable, and carry no default; a default on crash_recovery_completed_at silently excludes every crash-marked run from recovery. Inspect heartbeat_runs, drop or ALTER the offending columns, then retry migrations.';
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

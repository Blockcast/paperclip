-- BLO-19722 / BLO-20822 — Phase C: validate crash-recovery state.
--
-- Every column is required to be nullable, defaultless, and precisely typed.
-- A default on crash_recovery_completed_at would silently exclude all newly
-- crash-marked rows from recovery; a NOT NULL backoff field would fail recovery
-- writes. The index remains optional because populated databases build it online.
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
      MESSAGE = 'migration 0214: heartbeat_runs crash-recovery columns are missing or do not match the required shape after 0212: ' || invalid_columns,
      HINT = 'Phase A (0212) did not apply cleanly, or a pre-existing column survived its ADD COLUMN IF NOT EXISTS. Each column must have the stated type, be nullable, and carry no default; a default on crash_recovery_completed_at silently excludes every crash-marked run from recovery. Inspect heartbeat_runs, drop or ALTER the offending columns, then retry migrations.';
  END IF;

  index_present := to_regclass('public.heartbeat_runs_crash_recovery_pending_idx') IS NOT NULL;
  IF NOT index_present THEN
    RAISE NOTICE 'migration 0214: heartbeat_runs_crash_recovery_pending_idx is absent. Crash recovery is correct without it (the candidate scan degrades to a sequential scan); create it online when convenient — see 0213.';
  END IF;
END
$$;

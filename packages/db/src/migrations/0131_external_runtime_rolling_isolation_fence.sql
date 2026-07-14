ALTER TABLE "external_runtime_reservations"
  DROP CONSTRAINT "external_runtime_reservations_isolation_mode_check";

UPDATE "external_runtime_reservations"
SET "isolation_mode" = 'legacy',
    "isolation_key" = 'legacy:' || "run_id"::text,
    "isolation_bound_at" = COALESCE("reserved_at", now())
WHERE "released_at" IS NULL
  AND "isolation_mode" IS NULL;

ALTER TABLE "external_runtime_reservations"
  ADD CONSTRAINT "external_runtime_reservations_isolation_mode_check"
  CHECK ("isolation_mode" IS NULL OR "isolation_mode" IN ('legacy', 'pending', 'shared', 'run', 'workspace'));

CREATE OR REPLACE FUNCTION default_legacy_external_runtime_isolation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.released_at IS NULL AND NEW.isolation_mode IS NULL THEN
    PERFORM pg_advisory_xact_lock(748293011);
    IF EXISTS (
      SELECT 1
      FROM external_runtime_reservations
      WHERE released_at IS NULL
        AND isolation_mode IN ('shared', 'workspace')
        AND id IS DISTINCT FROM NEW.id
    ) THEN
      RAISE EXCEPTION 'legacy external-runtime dispatch blocked while an isolation writer is active'
        USING ERRCODE = '23505',
              CONSTRAINT = 'external_runtime_reservations_active_isolation_writer_idx';
    END IF;
    NEW.isolation_mode := 'legacy';
    NEW.isolation_key := 'legacy:' || NEW.run_id::text;
    NEW.isolation_bound_at := COALESCE(NEW.reserved_at, now());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER external_runtime_reservations_default_legacy_isolation
BEFORE INSERT OR UPDATE OF released_at, isolation_mode, isolation_key, isolation_bound_at
ON "external_runtime_reservations"
FOR EACH ROW
EXECUTE FUNCTION default_legacy_external_runtime_isolation();

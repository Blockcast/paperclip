CREATE TABLE "external_runtime_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "run_id" uuid NOT NULL REFERENCES "heartbeat_runs"("id") ON DELETE CASCADE,
  "slot_id" integer NOT NULL,
  "state" text DEFAULT 'reserved' NOT NULL,
  "expected_job_name" text,
  "job_name" text,
  "job_uid" text,
  "reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
  "launching_at" timestamp with time zone,
  "launched_at" timestamp with time zone,
  "released_at" timestamp with time zone,
  "release_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "external_runtime_reservations_state_check"
    CHECK ("state" IN ('reserved', 'launching', 'launched', 'release_pending', 'released'))
);

CREATE UNIQUE INDEX "external_runtime_reservations_run_idx"
  ON "external_runtime_reservations" ("run_id");
CREATE UNIQUE INDEX "external_runtime_reservations_active_slot_idx"
  ON "external_runtime_reservations" ("agent_id", "slot_id")
  WHERE "released_at" IS NULL;
CREATE INDEX "external_runtime_reservations_active_age_idx"
  ON "external_runtime_reservations" ("reserved_at")
  WHERE "released_at" IS NULL;
CREATE INDEX "external_runtime_reservations_active_state_idx"
  ON "external_runtime_reservations" ("state")
  WHERE "released_at" IS NULL;

-- Preserve capacity ownership across a rolling upgrade. Existing external
-- Jobs predate reservation callbacks, so assign every running run a stable
-- drain slot before new dispatchers can claim slot 0. Multiple rows per agent
-- are tolerated here because older releases could briefly over-admit runs;
-- the new dispatcher still admits only slot 0 after these rows drain.
WITH running_external_runs AS (
  SELECT
    runs.company_id,
    runs.agent_id,
    runs.id AS run_id,
    (row_number() OVER (
      PARTITION BY runs.agent_id
      ORDER BY COALESCE(runs.started_at, runs.created_at), runs.id
    ) - 1)::integer AS slot_id,
    runs.external_run_id,
    COALESCE(runs.started_at, runs.created_at, now()) AS reserved_at
  FROM heartbeat_runs AS runs
  INNER JOIN agents ON agents.id = runs.agent_id
  WHERE runs.status = 'running'
    AND agents.adapter_type IN ('claude_k8s', 'opencode_k8s')
)
INSERT INTO external_runtime_reservations (
  company_id,
  agent_id,
  run_id,
  slot_id,
  state,
  expected_job_name,
  job_name,
  reserved_at,
  launching_at,
  launched_at,
  created_at,
  updated_at
)
SELECT
  company_id,
  agent_id,
  run_id,
  slot_id,
  CASE WHEN external_run_id IS NULL THEN 'launching' ELSE 'launched' END,
  external_run_id,
  external_run_id,
  reserved_at,
  reserved_at,
  CASE WHEN external_run_id IS NULL THEN NULL ELSE reserved_at END,
  now(),
  now()
FROM running_external_runs
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION release_external_runtime_reservation_for_terminal_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE external_runtime_reservations
    SET state = CASE WHEN state = 'reserved' THEN 'released' ELSE 'release_pending' END,
        released_at = CASE
          WHEN state = 'reserved' THEN COALESCE(released_at, NEW.finished_at, now())
          ELSE released_at
        END,
        release_reason = COALESCE(release_reason, NEW.error_code, NEW.status),
        updated_at = now()
    WHERE run_id = NEW.id AND released_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER heartbeat_runs_release_external_runtime_reservation
AFTER UPDATE OF status ON heartbeat_runs
FOR EACH ROW
EXECUTE FUNCTION release_external_runtime_reservation_for_terminal_run();

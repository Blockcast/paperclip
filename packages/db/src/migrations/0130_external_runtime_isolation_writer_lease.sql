ALTER TABLE "external_runtime_reservations"
  ADD COLUMN "isolation_mode" text,
  ADD COLUMN "isolation_key" text,
  ADD COLUMN "isolation_bound_at" timestamp with time zone;

ALTER TABLE "external_runtime_reservations"
  ADD CONSTRAINT "external_runtime_reservations_isolation_mode_check"
  CHECK ("isolation_mode" IS NULL OR "isolation_mode" IN ('shared', 'run', 'workspace')),
  ADD CONSTRAINT "external_runtime_reservations_isolation_binding_check"
  CHECK (
    ("isolation_mode" IS NULL AND "isolation_key" IS NULL AND "isolation_bound_at" IS NULL)
    OR
    ("isolation_mode" IS NOT NULL AND "isolation_key" IS NOT NULL AND "isolation_bound_at" IS NOT NULL)
  );

CREATE UNIQUE INDEX "external_runtime_reservations_active_isolation_writer_idx"
  ON "external_runtime_reservations" ("isolation_key")
  WHERE "released_at" IS NULL AND "isolation_key" IS NOT NULL;

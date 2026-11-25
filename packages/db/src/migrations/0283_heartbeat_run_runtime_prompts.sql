-- Keep rendered startup prompts private to their exact heartbeat run.
CREATE TABLE IF NOT EXISTS "heartbeat_run_runtime_prompts" (
  "run_id" uuid PRIMARY KEY NOT NULL,
  "prompt" bytea NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "heartbeat_run_runtime_prompts_run_id_heartbeat_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "heartbeat_runs"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_run_runtime_prompts_expires_at_idx"
  ON "heartbeat_run_runtime_prompts" USING btree ("expires_at");

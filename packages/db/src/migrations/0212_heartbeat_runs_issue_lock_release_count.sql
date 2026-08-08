-- A stale-lock sweep releases issue ownership without cancelling the run.
-- Persist the release on the run so legacy wake adoption cannot renew the
-- same stale holder indefinitely.
ALTER TABLE "heartbeat_runs" ADD COLUMN "issue_lock_release_count" integer DEFAULT 0 NOT NULL;

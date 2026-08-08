-- BLO-19722 / BLO-20822 — Phase A: durable state for worker-crash recovery.
--
-- Recovery records its completion explicitly because a retry child alone cannot
-- distinguish a deliberately suppressed retry from a partially completed
-- recovery. The nullable, defaultless additions below are catalog-only and
-- safe on a large heartbeat_runs table.
--
-- Production commits migration files independently. Phase B (0213) can therefore
-- validate a pre-existing index without rolling back these columns; Phase C
-- (0214) validates the required column shape.
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "crash_recovery_completed_at" timestamp with time zone;
--> statement-breakpoint
-- Backoff state prevents a permanently failing oldest row from starving the
-- bounded oldest-first recovery scan.
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "crash_recovery_attempts" integer;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "crash_recovery_next_attempt_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "crash_recovery_last_error" text;

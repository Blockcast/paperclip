-- BLO-27912: the liveness sweep accepts six satisfiers for "someone owns the next
-- action on this issue" (`hasExplicitWaitingPath`), and NONE of them is reachable by an
-- actor other than the row's own assignee. So a row that is *deliberately* parked —
-- correctly not being worked, pending an upstream event no timer owns — has no way to
-- say so, and the invariant re-fires against it on every sweep. The only agent who
-- could silence it is the assignee, who by construction is not working on it.
--
-- Record the park as an explicit, attributed, TIME-BOUNDED disposition instead:
--
--   parked_until      the re-examination deadline. Suppression is derived from this
--                     being in the future, so it expires on its own. This is what keeps
--                     the park from trading a noisy failure for a silent one — a park
--                     cannot become permanent silence by being forgotten.
--   parked_reason     the stated reason / the upstream event being awaited. Required
--                     with the park, so the disposition always carries why.
--   parked_by_agent_id  who parked it. A non-assignee may set this (creator or the
--                     assignee's manager chain), so attribution is load-bearing.
--   parked_at         when it was parked.
--
-- All four are NULL together (not parked) or set together. Nullable, no default and no
-- backfill: `issues` is a known-large table, and an unparked row is exactly the
-- pre-existing behaviour.
ALTER TABLE "issues" ADD COLUMN "parked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "parked_reason" text;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "parked_by_agent_id" uuid REFERENCES "agents"("id");
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "parked_at" timestamp with time zone;

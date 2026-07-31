ALTER TABLE "approvals" ADD COLUMN "linked_agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_linked_agent_id_agents_id_fk" FOREIGN KEY ("linked_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
UPDATE "approvals" AS approval
SET "linked_agent_id" = agent."id"
FROM "activity_log" AS activity
INNER JOIN "agents" AS agent
  ON agent."company_id" = activity."company_id"
  AND agent."id"::text = (activity."details" ->> 'linkedAgentId')
WHERE approval."id"::text = activity."entity_id"
  AND approval."company_id" = activity."company_id"
  AND approval."type" = 'hire_agent'
  AND approval."linked_agent_id" IS NULL
  AND activity."action" = 'approval.created'
  AND activity."entity_type" = 'approval';
--> statement-breakpoint
UPDATE "approvals" AS approval
SET "linked_agent_id" = agent."id"
FROM "activity_log" AS activity, "agents" AS agent
WHERE approval."id"::text = activity."entity_id"
  AND approval."id"::text = (activity."details" ->> 'approvalId')
  AND approval."company_id" = activity."company_id"
  AND approval."company_id" = agent."company_id"
  AND approval."type" = 'hire_agent'
  AND approval."status" IN ('pending', 'revision_requested')
  AND approval."linked_agent_id" IS NULL
  AND activity."action" = 'approval.created'
  AND activity."entity_type" = 'approval'
  AND (approval."payload" ->> 'sourceBuiltInAgentKey') = (activity."details" ->> 'key')
  AND (approval."payload" ->> 'agentId') = agent."id"::text
  AND agent."status" = 'pending_approval'
  AND (agent."metadata" -> 'paperclipBuiltInAgent' ->> 'key') = (activity."details" ->> 'key');
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally and this nullable lookup column is backfilled only for pending hire approvals.
CREATE INDEX "approvals_linked_agent_idx" ON "approvals" USING btree ("linked_agent_id");

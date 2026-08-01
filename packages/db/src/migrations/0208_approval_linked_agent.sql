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
-- Hire approvals filed through the generic POST /api/approvals route log
-- `approval.created` without `linkedAgentId` and carry no `sourceBuiltInAgentKey`,
-- so neither backfill above matches them. Bind those straight from
-- `payload.agentId` whenever it still resolves to a pending hire in the same
-- company: that preserves the pre-column behaviour (approve activates the agent,
-- reject terminates it) and makes the row withdrawable. A row whose agent is
-- already claimed by another approval is left unbound rather than encoding an
-- ambiguous many-to-one binding.
UPDATE "approvals" AS approval
SET "linked_agent_id" = agent."id"
FROM "agents" AS agent
WHERE approval."type" = 'hire_agent'
  AND approval."linked_agent_id" IS NULL
  AND approval."status" IN ('pending', 'revision_requested')
  AND approval."company_id" = agent."company_id"
  AND (approval."payload" ->> 'agentId') = agent."id"::text
  AND agent."status" = 'pending_approval'
  AND NOT EXISTS (
    SELECT 1
    FROM "approvals" AS other
    WHERE other."id" <> approval."id"
      AND (
        other."linked_agent_id" = agent."id"
        OR (
          other."type" = 'hire_agent'
          AND other."company_id" = approval."company_id"
          AND other."status" IN ('pending', 'revision_requested')
          AND (other."payload" ->> 'agentId') = agent."id"::text
        )
      )
  );
--> statement-breakpoint
-- Whatever is still unbound but carries a `payload.agentId` points at an agent
-- that is gone, already activated or terminated, or claimed by another approval,
-- so there is no pending hire left to clean up. Drop the stale reference: it
-- leaves withdrawal on the clean no-cleanup path instead of failing 409 forever,
-- and approval falls through to creating the agent the row describes rather than
-- silently activating nothing. Only undecided rows are rewritten; decided rows
-- keep the reference as history.
UPDATE "approvals"
SET "payload" = "payload" - 'agentId'
WHERE "type" = 'hire_agent'
  AND "linked_agent_id" IS NULL
  AND "status" IN ('pending', 'revision_requested')
  AND ("payload" ->> 'agentId') IS NOT NULL;
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally and this nullable lookup column is backfilled only for pending hire approvals.
CREATE INDEX "approvals_linked_agent_idx" ON "approvals" USING btree ("linked_agent_id");

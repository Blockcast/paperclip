ALTER TABLE "approvals" ADD COLUMN "linked_agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_linked_agent_id_agents_id_fk" FOREIGN KEY ("linked_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
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
-- so neither backfill above matches them. They are deliberately LEFT UNBOUND.
--
-- `payload` is caller-controlled: `createApprovalSchema` accepts `hire_agent` with
-- a free-form payload, so a historical row's `payload.agentId` is an unverified
-- claim, not server-attested evidence of what this approval created. Promoting it
-- into `linked_agent_id` would launder that claim into the one field the service
-- treats as trusted -- and withdrawal, which is requester-scoped by design, uses
-- exactly that field to decide which agent to terminate and revoke keys for. A
-- requester who once filed a hire approval naming somebody else's pending agent
-- would be handed destructive control over it by this migration. Only the two
-- backfills above bind, because both corroborate against server-written
-- `activity_log` evidence.
--
-- Unbound payload-only rows fall through to the neutralisation below, which is
-- the non-destructive reconciliation: they lose the stale reference and become
-- withdrawable with no cleanup. The cost is that approving such a row creates the
-- agent it describes rather than activating a pre-existing pending one, leaving
-- that agent orphaned in `pending_approval`. That is recoverable by hand; wrongly
-- terminating a live agent is not, so this fails safe in the recoverable
-- direction.
--
-- So: drop the stale reference from anything still unbound. Withdrawal then takes
-- the clean no-cleanup path instead of failing 409 forever, and approval falls
-- through to creating the agent the row describes rather than silently activating
-- nothing. Only undecided rows are rewritten; decided rows keep the reference as
-- history.
UPDATE "approvals"
SET "payload" = "payload" - 'agentId'
WHERE "type" = 'hire_agent'
  AND "linked_agent_id" IS NULL
  AND "status" IN ('pending', 'revision_requested')
  AND ("payload" ->> 'agentId') IS NOT NULL;
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally and this nullable lookup column is backfilled only for pending hire approvals.
CREATE INDEX "approvals_linked_agent_idx" ON "approvals" USING btree ("linked_agent_id");

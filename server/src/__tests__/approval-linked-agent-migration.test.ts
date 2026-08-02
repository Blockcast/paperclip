import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  applyPendingMigrations,
  approvals,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { approvalService } from "../services/approvals.js";

const MIGRATION_FILE = "0208_approval_linked_agent.sql";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("approval linked-agent migration", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-link-migration-");
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("binds only server-attested legacy hire rows and neutralises the rest", async () => {
    const connectionString = tempDb!.connectionString;
    const legacyDb = createDb(connectionString);
    const companyId = randomUUID();

    // One case per row class the migration has to reason about. `bind` is the
    // expectation for `linked_agent_id` once the migration has run.
    const builtIn = ["approve", "reject", "withdraw"].map((action, index) => ({
      kind: "builtIn" as const,
      action,
      key: ["briefs", "learning", "reflection-coach"][index]!,
      agentId: randomUUID(),
      approvalId: randomUUID(),
      agentStatus: "pending_approval",
      bind: true,
    }));
    // Backfill #1: the /api/agents and plugin-managed routes record the binding
    // on the `approval.created` activity instead of a built-in key.
    const activityLinked = {
      kind: "activityLinked" as const,
      agentId: randomUUID(),
      approvalId: randomUUID(),
      agentStatus: "pending_approval",
      bind: true,
    };
    // The generic POST /api/approvals route records neither a built-in key nor an
    // activity binding, so `payload.agentId` is the only reference -- and it is
    // caller-supplied, so the migration deliberately refuses to bind from it.
    // The row is neutralised instead: withdrawable, but with no cleanup.
    const genericPending = {
      kind: "genericPending" as const,
      agentId: randomUUID(),
      approvalId: randomUUID(),
      agentStatus: "pending_approval",
      bind: false,
    };
    // The attack the refusal above exists to stop: a requester crafts a hire
    // approval whose payload names somebody else's pending agent. If the
    // migration promoted that claim into `linked_agent_id`, the requester could
    // withdraw its own approval and terminate an agent it never created.
    const craftedVictimAgentId = randomUUID();
    const craftedTarget = {
      kind: "craftedTarget" as const,
      agentId: craftedVictimAgentId,
      approvalId: randomUUID(),
      agentStatus: "pending_approval",
      bind: false,
    };
    // Unbindable: the referenced agent is no longer a pending hire, so there is
    // nothing to clean up and the stale reference has to be dropped instead.
    const genericStale = {
      kind: "genericStale" as const,
      agentId: randomUUID(),
      approvalId: randomUUID(),
      agentStatus: "idle",
      bind: false,
    };
    // Ambiguous: two undecided approvals claim one pending agent, so neither may
    // bind it -- a many-to-one binding would let one withdrawal strand the other.
    const ambiguousAgentId = randomUUID();
    const ambiguous = ["a", "b"].map(() => ({
      kind: "ambiguous" as const,
      agentId: ambiguousAgentId,
      approvalId: randomUUID(),
      agentStatus: "pending_approval",
      bind: false,
    }));

    const migration = await fs.promises.readFile(
      new URL(`../../../packages/db/src/migrations/${MIGRATION_FILE}`, import.meta.url),
      "utf8",
    );
    const migrationHash = createHash("sha256").update(migration).digest("hex");
    await legacyDb.execute(sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${migrationHash}`);
    await legacyDb.execute(sql`DROP INDEX "approvals_linked_agent_idx"`);
    await legacyDb.execute(sql`ALTER TABLE "approvals" DROP CONSTRAINT "approvals_linked_agent_id_agents_id_fk"`);
    await legacyDb.execute(sql`ALTER TABLE "approvals" DROP COLUMN "linked_agent_id"`);

    await legacyDb.execute(sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, 'Legacy hire company', 'LHC')
      `);

    const seedAgent = async (id: string, status: string, metadata: Record<string, unknown> | null) => {
      await legacyDb.execute(sql`
          INSERT INTO "agents" ("id", "company_id", "name", "role", "status", "metadata")
          VALUES (
            ${id},
            ${companyId},
            ${`Legacy ${id.slice(0, 8)}`},
            'general',
            ${status},
            ${metadata ? JSON.stringify(metadata) : null}::jsonb
          )
          ON CONFLICT ("id") DO NOTHING
        `);
    };
    const seedApproval = async (
      approvalId: string,
      payload: Record<string, unknown>,
      activityDetails: Record<string, unknown>,
    ) => {
      await legacyDb.execute(sql`
          INSERT INTO "approvals" ("id", "company_id", "type", "status", "payload")
          VALUES (${approvalId}, ${companyId}, 'hire_agent', 'pending', ${JSON.stringify(payload)}::jsonb)
        `);
      await legacyDb.execute(sql`
          INSERT INTO "activity_log" (
            "company_id", "actor_type", "actor_id", "action", "entity_type", "entity_id", "details"
          )
          VALUES (
            ${companyId}, 'user', 'board-user', 'approval.created', 'approval',
            ${approvalId}, ${JSON.stringify(activityDetails)}::jsonb
          )
        `);
    };

    for (const testCase of builtIn) {
      const metadata = { paperclipBuiltInAgent: { key: testCase.key, featureKeys: [testCase.key] } };
      await seedAgent(testCase.agentId, testCase.agentStatus, metadata);
      await seedApproval(
        testCase.approvalId,
        {
          name: `Legacy ${testCase.action}`,
          role: "general",
          agentId: testCase.agentId,
          sourceBuiltInAgentKey: testCase.key,
          metadata,
        },
        { key: testCase.key, status: "pending", approvalId: testCase.approvalId },
      );
    }

    await seedAgent(activityLinked.agentId, activityLinked.agentStatus, null);
    await seedApproval(
      activityLinked.approvalId,
      { name: "Legacy activity-linked", role: "general", agentId: activityLinked.agentId },
      { status: "pending", approvalId: activityLinked.approvalId, linkedAgentId: activityLinked.agentId },
    );

    for (const testCase of [genericPending, genericStale, craftedTarget, ...ambiguous]) {
      await seedAgent(testCase.agentId, testCase.agentStatus, null);
      await seedApproval(
        testCase.approvalId,
        { name: `Legacy ${testCase.kind}`, role: "general", agentId: testCase.agentId },
        { status: "pending", approvalId: testCase.approvalId },
      );
    }

    await applyPendingMigrations(connectionString);
    const db = createDb(connectionString);
    const migrated = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    const byId = new Map(migrated.map((approval) => [approval.id, approval]));

    const allCases = [...builtIn, activityLinked, genericPending, genericStale, craftedTarget, ...ambiguous];
    expect(
      allCases.map((testCase) => {
        const row = byId.get(testCase.approvalId);
        return {
          kind: testCase.kind,
          linkedAgentId: row?.linkedAgentId ?? null,
          // A row the migration refuses to bind must not keep a reference that
          // would make it permanently un-withdrawable.
          payloadAgentId: (row?.payload as Record<string, unknown> | undefined)?.agentId ?? null,
        };
      }),
    ).toEqual(
      allCases.map((testCase) => ({
        kind: testCase.kind,
        linkedAgentId: testCase.bind ? testCase.agentId : null,
        payloadAgentId: testCase.bind ? testCase.agentId : null,
      })),
    );

    const svc = approvalService(db);
    const withdrawActor = {
      userId: "board-user",
      activity: { actorType: "user" as const, actorId: "board-user", agentId: null },
    };
    await svc.approve(builtIn[0]!.approvalId, "board-user", "approved");
    await svc.reject(builtIn[1]!.approvalId, "board-user", "rejected");
    await svc.withdraw(builtIn[2]!.approvalId, "withdrawn", withdrawActor);
    // The classes the prior test never exercised: bound rows must reach the same
    // terminate-on-withdraw behaviour as the built-in rows.
    await svc.withdraw(activityLinked.approvalId, "withdrawn", withdrawActor);
    // Unbound rows must withdraw cleanly rather than throwing 409, and must not
    // terminate the agent they used to point at. `craftedTarget` is the security
    // case: its victim must survive the requester withdrawing its own approval.
    await svc.withdraw(genericPending.approvalId, "withdrawn", withdrawActor);
    await svc.withdraw(genericStale.approvalId, "withdrawn", withdrawActor);
    await svc.withdraw(craftedTarget.approvalId, "withdrawn", withdrawActor);
    await svc.withdraw(ambiguous[0]!.approvalId, "withdrawn", withdrawActor);

    const resultingAgents = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(resultingAgents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: builtIn[0]!.agentId, status: "idle" }),
        expect.objectContaining({ id: builtIn[1]!.agentId, status: "terminated" }),
        expect.objectContaining({ id: builtIn[2]!.agentId, status: "terminated" }),
        expect.objectContaining({ id: activityLinked.agentId, status: "terminated" }),
        // Never bound, so withdrawal had nothing to clean up: still pending.
        expect.objectContaining({ id: genericPending.agentId, status: "pending_approval" }),
        expect.objectContaining({ id: genericStale.agentId, status: "idle" }),
        // The whole point: a crafted payload cannot terminate its target.
        expect.objectContaining({ id: craftedVictimAgentId, status: "pending_approval" }),
        expect.objectContaining({ id: ambiguousAgentId, status: "pending_approval" }),
      ]),
    );
  }, 120_000);
});

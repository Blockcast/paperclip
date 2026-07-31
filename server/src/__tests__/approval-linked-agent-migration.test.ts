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

const MIGRATION_FILE = "0207_approval_linked_agent.sql";
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

  it("backfills legacy built-in approvals for approve, reject, and withdraw", async () => {
    const connectionString = tempDb!.connectionString;
    const legacyDb = createDb(connectionString);
    const companyId = randomUUID();
    const cases = [
      { action: "approve", key: "briefs" },
      { action: "reject", key: "learning" },
      { action: "withdraw", key: "reflection-coach" },
    ].map(({ action, key }) => ({
      action,
      agentId: randomUUID(),
      approvalId: randomUUID(),
      key,
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
        VALUES (${companyId}, 'Legacy built-in company', 'LBI')
      `);
    for (const testCase of cases) {
      const metadata = {
        paperclipBuiltInAgent: { key: testCase.key, featureKeys: [testCase.key] },
      };
      const payload = {
        name: `Legacy ${testCase.action}`,
        role: "general",
        agentId: testCase.agentId,
        sourceBuiltInAgentKey: testCase.key,
        metadata,
      };
      await legacyDb.execute(sql`
          INSERT INTO "agents" ("id", "company_id", "name", "role", "status", "metadata")
          VALUES (
            ${testCase.agentId},
            ${companyId},
            ${`Legacy ${testCase.action}`},
            'general',
            'pending_approval',
            ${JSON.stringify(metadata)}::jsonb
          )
        `);
      await legacyDb.execute(sql`
          INSERT INTO "approvals" ("id", "company_id", "type", "status", "payload")
          VALUES (${testCase.approvalId}, ${companyId}, 'hire_agent', 'pending', ${JSON.stringify(payload)}::jsonb)
        `);
      await legacyDb.execute(sql`
          INSERT INTO "activity_log" (
            "company_id",
            "actor_type",
            "actor_id",
            "action",
            "entity_type",
            "entity_id",
            "details"
          )
          VALUES (
            ${companyId},
            'user',
            'board-user',
            'approval.created',
            'approval',
            ${testCase.approvalId},
            ${JSON.stringify({
              key: testCase.key,
              status: "pending",
              approvalId: testCase.approvalId,
            })}::jsonb
          )
        `);
    }

    await applyPendingMigrations(connectionString);
    const db = createDb(connectionString);
    const migrated = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(
      migrated.map((approval) => ({ id: approval.id, linkedAgentId: approval.linkedAgentId })),
    ).toEqual(
      expect.arrayContaining(
        cases.map((testCase) => ({
          id: testCase.approvalId,
          linkedAgentId: testCase.agentId,
        })),
      ),
    );

    const svc = approvalService(db);
    await svc.approve(cases[0]!.approvalId, "board-user", "approved");
    await svc.reject(cases[1]!.approvalId, "board-user", "rejected");
    await svc.withdraw(cases[2]!.approvalId, "withdrawn", {
      userId: "board-user",
      activity: { actorType: "user", actorId: "board-user", agentId: null },
    });

    const resultingAgents = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(resultingAgents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: cases[0]!.agentId, status: "idle" }),
        expect.objectContaining({ id: cases[1]!.agentId, status: "terminated" }),
        expect.objectContaining({ id: cases[2]!.agentId, status: "terminated" }),
      ]),
    );
  }, 120_000);
});

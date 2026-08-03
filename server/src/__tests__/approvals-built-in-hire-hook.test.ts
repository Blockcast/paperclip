import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { approvalService } from "../services/approvals.ts";

const mockEnsureBuiltInAgent = vi.hoisted(() => vi.fn());
const mockOnHireApproved = vi.hoisted(() => vi.fn());

vi.mock("../services/built-in-agents.js", () => ({
  builtInAgentService: () => ({ ensure: mockEnsureBuiltInAgent }),
}));

vi.mock("../adapters/registry.js", () => ({
  findActiveServerAdapter: vi.fn((type: string) => ({ type, onHireApproved: mockOnHireApproved })),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres built-in hire hook tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("built-in hire hook delivery", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("built-in-hire-hook");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 120_000);

  beforeEach(() => {
    mockEnsureBuiltInAgent.mockResolvedValue(undefined);
    mockOnHireApproved.mockResolvedValue({ ok: true });
  });

  afterEach(async () => {
    mockEnsureBuiltInAgent.mockReset();
    mockOnHireApproved.mockReset();
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("does not reinvoke the real hook after success when terminal markers fail", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();
    const approvalId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Built-in Real Hook Marker Failure",
      role: "engineer",
      status: "pending_approval",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "hire_agent",
      status: "pending",
      requestedByUserId: "requester",
      payload: {
        agentId,
        name: "Built-in Real Hook Marker Failure",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        budgetMonthlyCents: 0,
        sourceBuiltInAgentKey: "briefs",
      },
      updatedAt: new Date(),
    });

    await db.execute(sql`
      alter table activity_log
      add constraint test_reject_built_in_hire_terminal_markers
      check (action not in ('approval.hire_notification_delivered', 'approval.hire_post_commit_completed'))
    `);

    try {
      await expect(
        approvalService(db).approve(approvalId, "board-user", "Approved"),
      ).rejects.toThrow();
      expect(mockEnsureBuiltInAgent).toHaveBeenCalledTimes(1);
      expect(mockOnHireApproved).toHaveBeenCalledTimes(1);

      await expect(
        db
          .select({ id: activityLog.id })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, companyId),
              eq(activityLog.action, "hire_hook.succeeded"),
              eq(activityLog.entityType, "agent"),
              eq(activityLog.entityId, agentId),
              sql`${activityLog.details} ->> 'source' = 'approval'`,
              sql`${activityLog.details} ->> 'sourceId' = ${approvalId}`,
            ),
          ),
      ).resolves.toHaveLength(1);
      await expect(
        db
          .select({ id: activityLog.id })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, companyId),
              eq(activityLog.action, "approval.hire_notification_succeeded"),
              eq(activityLog.entityType, "approval"),
              eq(activityLog.entityId, approvalId),
            ),
          ),
      ).resolves.toHaveLength(1);
    } finally {
      await db.execute(sql`
        alter table activity_log
        drop constraint test_reject_built_in_hire_terminal_markers
      `);
    }

    await expect(
      approvalService(db).approve(approvalId, "board-user", "Approved"),
    ).resolves.toMatchObject({ applied: false });
    expect(mockEnsureBuiltInAgent).toHaveBeenCalledTimes(1);
    expect(mockOnHireApproved).toHaveBeenCalledTimes(1);
    await expect(
      db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.action, "approval.hire_notification_delivered"),
            eq(activityLog.entityType, "approval"),
            eq(activityLog.entityId, approvalId),
          ),
        ),
    ).resolves.toHaveLength(1);
  });
});

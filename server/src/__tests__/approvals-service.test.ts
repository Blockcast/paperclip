import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, approvals, companies, createDb } from "@paperclipai/db";
import { approvalService } from "../services/approvals.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    linkedAgentId: "agent-1",
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
  };
}

function createDbStub(selectResults: Array<Array<Record<string, unknown>>>, updateResults: ApprovalRecord[]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const innerJoin = vi.fn(() => ({ where: selectWhere }));
  const from = vi.fn(() => ({ where: selectWhere, innerJoin }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  const db = { select, update } as Record<string, unknown>;
  const transaction = vi.fn(async (callback: (tx: unknown) => unknown) => callback(db));
  db.transaction = transaction;

  return {
    db,
    selectWhere,
    returning,
    transaction,
  };
}

const withdrawalActor = {
  userId: null,
  activity: {
    actorType: "agent" as const,
    actorId: "requester-1",
    agentId: "requester-1",
  },
};

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue({ agent: { id: "agent-1" }, activated: true });
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);
  });

  it("treats repeated approve retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("treats repeated reject retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("rejected")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "not now");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")], [{ id: "agent-1" }]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1", approved.payload);
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it("activates a legacy payload-bound pending agent when linkedAgentId is absent", async () => {
    const approved = {
      ...createApproval("approved"),
      linkedAgentId: null,
      payload: { agentId: "agent-1", name: "Legacy pending agent" },
    };
    const dbStub = createDbStub(
      [[{ ...createApproval("pending"), linkedAgentId: null, payload: approved.payload }], [{ id: "agent-1" }]],
      [approved],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1", approved.payload);
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it("creates the agent from payload when approval does not reference a pending agent", async () => {
    const approved = {
      ...createApproval("approved"),
      linkedAgentId: null,
      payload: {
        name: "New Agent",
        adapterConfig: {
          env: {
            API_KEY: {
              type: "secret_ref",
              secretId: "secret-1",
              version: "latest",
            },
          },
        },
      },
    };
    const dbStub = createDbStub([[{ ...createApproval("pending"), payload: approved.payload }]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: approved.payload.adapterConfig,
      }),
    );
  });
});

describe("approvalService.findOpenHireApprovalForAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the open hire approval the company/type/status/agentId filter yields", async () => {
    const match = {
      ...createApproval("pending"),
      id: "approval-match",
      payload: { agentId: "agent-1" },
    };
    // The company, type, open-status and payload->>'agentId' predicates run in
    // SQL, so the DB hands back only the matching row.
    const dbStub = createDbStub([[match]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.findOpenHireApprovalForAgent("company-1", "agent-1");

    expect(result?.id).toBe("approval-match");
    expect(dbStub.selectWhere).toHaveBeenCalledTimes(1);
  });

  it("returns null when no open approval matches the agent", async () => {
    const dbStub = createDbStub([[]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.findOpenHireApprovalForAgent("company-1", "agent-1");

    expect(result).toBeNull();
  });
});

describe("approvalService.withdraw", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.terminate.mockResolvedValue(undefined);
  });

  it("marks a pending approval withdrawn and stores the reason", async () => {
    const withdrawn = {
      ...createApproval("withdrawn"),
      type: "budget_override_required",
      decisionNote: "cap already raised past the ask",
    };
    const dbStub = createDbStub([[createApproval("pending")]], [withdrawn]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.withdraw("approval-1", "cap already raised past the ask", withdrawalActor);

    expect(result.status).toBe("withdrawn");
    expect(result.decisionNote).toBe("cap already raised past the ask");
  });

  it("uses a terminal status distinct from rejected", async () => {
    const withdrawn = { ...createApproval("withdrawn"), type: "budget_override_required" };
    const dbStub = createDbStub([[createApproval("pending")]], [withdrawn]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.withdraw("approval-1", "moot", withdrawalActor);

    expect(result.status).toBe("withdrawn");
    expect(result.status).not.toBe("rejected");
  });

  it("throws 409 for an already-decided approval without mutating it", async () => {
    const dbStub = createDbStub([[createApproval("approved")]], []);

    const svc = approvalService(dbStub.db as any);
    await expect(svc.withdraw("approval-1", "too late", withdrawalActor)).rejects.toMatchObject({
      status: 409,
    });
    // Guard runs before any UPDATE is issued.
    expect(dbStub.returning).not.toHaveBeenCalled();
  });

  it("throws 409 when a concurrent decision wins the status-guarded update", async () => {
    // First select sees pending; the guarded UPDATE matches no row because
    // another worker already decided it; the re-read reports the real status.
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    await expect(svc.withdraw("approval-1", "racing", withdrawalActor)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("terminates the pending agent when a hire_agent approval is withdrawn", async () => {
    // Otherwise the agent is stranded in pending_approval with no approval left to decide it.
    const dbStub = createDbStub(
      [[createApproval("pending")], [{ id: "agent-1" }]],
      [createApproval("withdrawn")],
    );

    const svc = approvalService(dbStub.db as any);
    await svc.withdraw("approval-1", "hire no longer needed", withdrawalActor);

    expect(mockAgentService.terminate).toHaveBeenCalledWith("agent-1");
  });

  it("does not terminate an agent for non-hire approval types", async () => {
    const withdrawn = { ...createApproval("withdrawn"), type: "budget_override_required" };
    const dbStub = createDbStub([[createApproval("pending")]], [withdrawn]);

    const svc = approvalService(dbStub.db as any);
    await svc.withdraw("approval-1", "moot", withdrawalActor);

    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("rolls back the withdrawal when pending-agent termination fails", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [{ id: "agent-1" }]],
      [createApproval("withdrawn")],
    );
    mockAgentService.terminate.mockRejectedValue(new Error("api-key revocation failed"));

    const svc = approvalService(dbStub.db as any);
    await expect(svc.withdraw("approval-1", "hire no longer needed", withdrawalActor)).rejects.toThrow(
      "api-key revocation failed",
    );

    expect(dbStub.transaction).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rolls back the withdrawal and agent cleanup when audit persistence fails", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [{ id: "agent-1" }]],
      [createApproval("withdrawn")],
    );
    mockLogActivity.mockRejectedValue(new Error("activity insert failed"));

    const svc = approvalService(dbStub.db as any);
    await expect(svc.withdraw("approval-1", "hire no longer needed", withdrawalActor)).rejects.toThrow(
      "activity insert failed",
    );

    expect(dbStub.transaction).toHaveBeenCalledTimes(1);
    expect(mockAgentService.terminate).toHaveBeenCalledWith("agent-1");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("approvalService.withdraw adversarial hire targets", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-withdraw-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string) {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name,
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return id;
  }

  async function seedCraftedApproval(companyId: string, targetAgentId: string) {
    const id = randomUUID();
    await db.insert(approvals).values({
      id,
      companyId,
      type: "hire_agent",
      status: "pending",
      payload: { agentId: targetAgentId },
      linkedAgentId: null,
    });
    return id;
  }

  async function expectRejectedWithoutMutation(approvalId: string, targetAgentId: string) {
    await expect(
      approvalService(db).withdraw(approvalId, "crafted target", withdrawalActor),
    ).rejects.toMatchObject({
      status: 409,
      message: "Hire approval is not bound to a pending agent",
    });

    const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    const [agent] = await db.select().from(agents).where(eq(agents.id, targetAgentId));
    expect(approval.status).toBe("pending");
    expect(agent.status).not.toBe("terminated");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  }

  it("does not terminate a crafted active-agent target", async () => {
    const companyId = await seedCompany("Active target company");
    const targetAgentId = randomUUID();
    await db.insert(agents).values({
      id: targetAgentId,
      companyId,
      name: "Active target",
      role: "engineer",
      status: "idle",
    });
    const approvalId = await seedCraftedApproval(companyId, targetAgentId);

    await expectRejectedWithoutMutation(approvalId, targetAgentId);
  });

  it("does not terminate or reveal a crafted cross-company target", async () => {
    const approvalCompanyId = await seedCompany("Approval company");
    const targetCompanyId = await seedCompany("Target company");
    const targetAgentId = randomUUID();
    await db.insert(agents).values({
      id: targetAgentId,
      companyId: targetCompanyId,
      name: "Cross-company target",
      role: "engineer",
      status: "pending_approval",
    });
    const approvalId = await seedCraftedApproval(approvalCompanyId, targetAgentId);

    await expectRejectedWithoutMutation(approvalId, targetAgentId);
  });

  it("withdraws and terminates the exact linked pending agent", async () => {
    const companyId = await seedCompany("Bound pending agent company");
    const targetAgentId = randomUUID();
    await db.insert(agents).values({
      id: targetAgentId,
      companyId,
      name: "Bound pending agent",
      role: "engineer",
      status: "pending_approval",
    });
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "hire_agent",
      status: "pending",
      payload: { agentId: targetAgentId },
      linkedAgentId: targetAgentId,
    });

    const result = await approvalService(db).withdraw(
      approvalId,
      "hire no longer needed",
      withdrawalActor,
    );

    expect(result.status).toBe("withdrawn");
    expect(mockAgentService.terminate).toHaveBeenCalledWith(targetAgentId);
  });
});

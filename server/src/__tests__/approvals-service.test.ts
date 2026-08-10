import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, approvals, companies, createDb } from "@paperclipai/db";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { APPROVAL_UNDECIDED_STATUSES } from "@paperclipai/shared";
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
  requestedByUserId: string | null;
  idempotencyKey?: string | null;
  createdAt?: Date;
  decidedAt?: Date | null;
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
    requestedByUserId: null,
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

describe("approvalService.requestRevision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.terminate.mockResolvedValue(undefined);
  });

  it("moves a pending approval to revision_requested", async () => {
    const revisionRequested = { ...createApproval("revision_requested") };
    const dbStub = createDbStub([[createApproval("pending")]], [revisionRequested]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.requestRevision("approval-1", "board-user", "needs a tighter scope");

    expect(result.status).toBe("revision_requested");
  });

  it("does not resurrect an approval that was withdrawn mid-flight", async () => {
    // The interleaving that matters: the pending check above passes, a
    // withdrawal commits (terminating the linked hire agent), and only then does
    // this UPDATE run. Without the status guard it would overwrite `withdrawn`
    // back to `revision_requested`, leaving an approval that reads as open but
    // whose agent has already been terminated and its API keys revoked.
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("withdrawn")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    await expect(
      svc.requestRevision("approval-1", "board-user", "needs a tighter scope"),
    ).rejects.toMatchObject({ status: 422 });
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

// ---------------------------------------------------------------------------
// BLO-19132: create-side dedupe. Two creates with the same key from the same
// requester, while the first is still undecided, must yield ONE approval.
// ---------------------------------------------------------------------------

/**
 * Transaction stub modelling the real table: an insert appends a row, a select
 * returns whatever the pre-seeded lookup result is. `inserts` is the assertion
 * surface — the whole claim is "one row, not two".
 */
function createTxStub(existingRows: ApprovalRecord[][]) {
  const pending = [...existingRows];
  const inserts: Record<string, unknown>[] = [];

  const tx = {
    execute: vi.fn(async () => undefined),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => pending.shift() ?? []),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => {
        inserts.push(row);
        return {
          returning: vi.fn(() => ({
            then: (resolve: (rows: unknown[]) => unknown) =>
              resolve([{ ...row, id: `approval-${inserts.length}` }]),
          })),
        };
      }),
    })),
  };

  const db = {
    transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    insert: tx.insert,
  };

  return { db, tx, inserts };
}

describe("approvalService createWithIdempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseInput = {
    type: "request_board_approval",
    payload: { title: "Trigger exact-head human review for MOQtail PR #312" },
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    status: "pending",
    idempotencyKey: "moqtail-312-exact-head-review",
  };

  it("inserts on the first call and replays on the second — one approval, not two", async () => {
    // First call: no existing row. Second call: the row the first one created.
    const stub = createTxStub([[], []]);
    const svc = approvalService(stub.db as any);

    const first = await svc.createWithIdempotency("company-1", baseInput as any);
    expect(first.deduplicated).toBe(false);
    expect(stub.inserts).toHaveLength(1);

    // Re-seed the lookup with the row that now exists, then retry the same ask.
    const stub2 = createTxStub([[{ ...first.approval } as any]]);
    const svc2 = approvalService(stub2.db as any);
    const second = await svc2.createWithIdempotency("company-1", baseInput as any);

    expect(second.deduplicated).toBe(true);
    expect(second.approval.id).toBe(first.approval.id);
    // The claim that matters: the retry inserted nothing.
    expect(stub2.inserts).toHaveLength(0);
  });

  it("takes an advisory lock before the lookup so concurrent retries cannot both insert", async () => {
    const stub = createTxStub([[]]);
    const svc = approvalService(stub.db as any);

    await svc.createWithIdempotency("company-1", baseInput as any);

    // Without the lock, two simultaneous first-filings both read "not found" and
    // both insert; the partial unique index would then reject one with a raw 500
    // rather than replaying it.
    expect(stub.tx.execute).toHaveBeenCalledTimes(1);
    const lockCall = stub.tx.execute.mock.calls[0]?.[0] as { queryChunks?: unknown[] } | undefined;
    expect(JSON.stringify(lockCall)).toContain("pg_advisory_xact_lock");
  });

  it("rejects an idempotent create with both requester identities set", async () => {
    const stub = createTxStub([[]]);
    const svc = approvalService(stub.db as any);

    await expect(
      svc.createWithIdempotency("company-1", {
        ...baseInput,
        requestedByUserId: "user-1",
      } as any),
    ).rejects.toThrow("either an agent or a user");

    expect(stub.db.transaction).not.toHaveBeenCalled();
    expect(stub.inserts).toHaveLength(0);
  });

  it("runs first-filing side effects inside the idempotent create transaction", async () => {
    const stub = createTxStub([[]]);
    const svc = approvalService(stub.db as any);
    const afterCreate = vi.fn(async () => undefined);

    await svc.createWithIdempotency("company-1", baseInput as any, { afterCreate });

    expect(afterCreate).toHaveBeenCalledWith(
      stub.tx,
      expect.objectContaining({ id: "approval-1" }),
    );
  });

  it("does not rerun first-filing side effects when an idempotent create replays", async () => {
    const existing = { ...baseInput, id: "approval-original", companyId: "company-1" };
    const stub = createTxStub([[existing as any]]);
    const svc = approvalService(stub.db as any);
    const afterCreate = vi.fn(async () => undefined);

    const result = await svc.createWithIdempotency("company-1", baseInput as any, { afterCreate });

    expect(result.deduplicated).toBe(true);
    expect(afterCreate).not.toHaveBeenCalled();
    expect(stub.inserts).toHaveLength(0);
  });

  it("does not dedupe when no idempotency key is supplied", async () => {
    const stub = createTxStub([[]]);
    const svc = approvalService(stub.db as any);

    const res = await svc.createWithIdempotency("company-1", {
      ...baseInput,
      idempotencyKey: null,
    } as any);

    expect(res.deduplicated).toBe(false);
    expect(stub.inserts).toHaveLength(1);
    expect(stub.inserts[0]?.idempotencyKey).toBeNull();
    // No key means no lock and no lookup — the unkeyed path stays exactly as it was.
    expect(stub.db.transaction).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only key as absent rather than as a dedupe token", async () => {
    const stub = createTxStub([[]]);
    const svc = approvalService(stub.db as any);

    const res = await svc.createWithIdempotency("company-1", {
      ...baseInput,
      idempotencyKey: "   ",
    } as any);

    expect(res.deduplicated).toBe(false);
    expect(stub.inserts[0]?.idempotencyKey).toBeNull();
  });
});

describe("approvalService listSummary", () => {
  it("derives labels from redacted payload snippets instead of raw payload text", async () => {
    const row = {
      id: "approval-secret",
      type: "request_board_approval",
      status: "pending",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      idempotencyKey: "rotate-creds",
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
      decidedAt: null,
      title: "aaa.bbb.ccc",
      summary: "Rotate credentials",
      description: "fallback",
    };
    const orderBy = vi.fn(async () => [row]);
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const svc = approvalService({ select } as any);

    const result = await svc.listSummary("company-1", {
      status: "pending",
      idempotencyKey: "rotate-creds",
    });

    expect(result).toEqual([
      {
        id: "approval-secret",
        type: "request_board_approval",
        status: "pending",
        requestedByAgentId: "agent-1",
        requestedByUserId: null,
        idempotencyKey: "rotate-creds",
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
        decidedAt: null,
        label: "Rotate credentials",
      },
    ]);
    expect(result[0]).not.toHaveProperty("title");
    expect(result[0]?.label).not.toBe("aaa.bbb.ccc");
  });
});

describe("approval undecided-status scope stays bound across all three sites", () => {
  // The migration is frozen history and the drizzle schema must mirror it verbatim,
  // so neither can import the constant — an eager cross-package import at schema
  // module scope would also take the whole db schema down if it ever failed to
  // resolve, which is a worse failure than the drift it prevents. So the binding is
  // asserted here instead: if someone widens APPROVAL_UNDECIDED_STATUSES without a
  // follow-up migration, the partial index scope and the create-side dedupe lookup
  // silently diverge, and a replay that should return the original becomes a raw
  // unique-violation 500.
  function repoFile(relative: string) {
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    return fs.readFileSync(path.resolve(here, "../../..", relative), "utf8");
  }

  function normalize(clause: string) {
    return (clause.match(/'[^']+'/g) ?? []).sort().join(",");
  }

  const expected = [...APPROVAL_UNDECIDED_STATUSES].map((s) => `'${s}'`).sort().join(",");

  it("matches the status set hardcoded in migration 0212", () => {
    const migration = repoFile("packages/db/src/migrations/0212_approval_create_idempotency.sql");
    const clauses = migration.match(/"status" IN \(([^)]*)\)/g) ?? [];
    expect(clauses.length, "migration 0212 no longer scopes its indexes by status").toBe(2);
    for (const clause of clauses) {
      expect(normalize(clause), `migration clause drifted: ${clause}`).toBe(expected);
    }
  });

  it("matches the status set hardcoded in the drizzle schema indexes", () => {
    const schema = repoFile("packages/db/src/schema/approvals.ts");
    const clauses = schema.match(/\$\{table\.status\} IN \(([^)]*)\)/g) ?? [];
    expect(clauses.length, "approvals schema no longer scopes its indexes by status").toBe(2);
    for (const clause of clauses) {
      expect(normalize(clause), `schema clause drifted: ${clause}`).toBe(expected);
    }
  });
});

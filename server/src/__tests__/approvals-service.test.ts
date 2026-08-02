import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { APPROVAL_UNDECIDED_STATUSES } from "@paperclipai/shared";
import { approvalService } from "../services/approvals.js";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
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
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
  };
}

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { select, update },
    selectWhere,
    returning,
  };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue({ agent: { id: "agent-1" }, activated: true });
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
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
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1", approved.payload);
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it("creates the agent from payload when approval does not reference a pending agent", async () => {
    const approved = {
      ...createApproval("approved"),
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

  it("matches the status set hardcoded in migration 0208", () => {
    const migration = repoFile("packages/db/src/migrations/0208_approval_create_idempotency.sql");
    const clauses = migration.match(/"status" IN \(([^)]*)\)/g) ?? [];
    expect(clauses.length, "migration 0208 no longer scopes its indexes by status").toBe(2);
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

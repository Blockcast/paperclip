/**
 * BLO-34008 — a `budget_override_required` card must declare a machine-checkable
 * target at creation.
 *
 * Approving this type writes nothing to `budget_policies`, so the enforcement
 * reconciler (BLO-24631) is the only thing that can notice an approved decision
 * that never reached the object enforcing it — and it can only see a card whose
 * figures are declared. Card `304ea443` carried its eight decided figures as
 * prose in `payload.raises`/`payload.cuts`, keyed by agent display name; it was
 * approved on 2026-08-04, all eight changes were still unapplied on 2026-08-09,
 * and nothing in the system was able to say so. These tests pin the refusal that
 * stops another card being filed in that shape.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  listSummary: vi.fn(),
  countBy: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  createWithIdempotency: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));
const mockDeferredActivityPublish = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
}

function createRouteDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) =>
            resolve([{ id: "run-1", companyId: "company-1", agentId: "agent-1", contextSnapshot: {} }]),
        })),
      })),
    })),
  } as any;
}

async function createAgentApp() {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb()));
  app.use(errorHandler);
  return app;
}

function postApproval(app: express.Express, body: Record<string, unknown>) {
  return request(app).post("/api/companies/company-1/approvals").send(body);
}

/** A real `budget_policies.id`-shaped uuid. */
const POLICY_ID = "a894e681-9691-4678-88ad-063059210a14";

/**
 * The `304ea443` payload shape, reduced to its load-bearing parts: figures as
 * prose, keyed by agent display name, with no policy id anywhere.
 */
const PROSE_ONLY_PAYLOAD = {
  title: "REVISED (net-zero): reallocate $29,132 of dead cap to CTO + Ally",
  raises: {
    CTO: "19,000 -> 32,000 (+13,000) | $1,692/day, 29.0% used, stops Aug 12",
    Ally: "25,000 -> 38,000 (+13,000)",
  },
  cuts: { UXDesigner: "30,011.40 -> 10,000 (-20,011.40)" },
};

describe("budget_override_required requires an enforcement assertion (BLO-34008)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    registerModuleMocks();
    vi.clearAllMocks();

    mockApprovalService.createWithIdempotency.mockImplementation(
      async (
        companyId: string,
        data: Record<string, unknown>,
        options?: { afterCreate?: (txDb: unknown, approval: Record<string, unknown>) => Promise<void> },
      ) => {
        const approval = await mockApprovalService.create(companyId, data);
        await options?.afterCreate?.({ tx: true }, approval);
        return { approval, deduplicated: false };
      },
    );
    mockApprovalService.create.mockImplementation(async (companyId: string, data: Record<string, unknown>) => ({
      id: "approval-1",
      companyId,
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-09-14T00:00:00.000Z"),
      updatedAt: new Date("2026-09-14T00:00:00.000Z"),
      ...data,
    }));
    mockLogActivity.mockResolvedValue(mockDeferredActivityPublish);
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
  });

  it("refuses a card whose figures are only prose, and never files it", async () => {
    const res = await postApproval(await createAgentApp(), {
      type: "budget_override_required",
      payload: PROSE_ONLY_PAYLOAD,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details.code).toBe("budget_approval_missing_enforcement_assertion");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("names the required shape concretely enough to fix in one retry", async () => {
    const app = await createAgentApp();

    // A budget card is filed when a cap is about to stop an agent, so the refusal
    // has to be self-describing: the requester must not need a second round trip,
    // a doc lookup or a guess to satisfy it. Assert the error carries a payload
    // that can be copied straight back, not just a complaint.
    const refused = await postApproval(app, {
      type: "budget_override_required",
      payload: PROSE_ONLY_PAYLOAD,
    });
    expect(refused.status).toBe(422);

    const [example] = refused.body.details.example.enforcement_assertions;
    expect(example).toMatchObject({
      kind: "budget_policy_amount",
      policyId: expect.any(String),
      label: expect.any(String),
    });
    // Both the target and the figure it starts from, per BLO-32796's classifier.
    expect(example.expected_usd).toEqual(expect.any(Number));
    expect(example.from_usd).toEqual(expect.any(Number));
    expect(refused.body.details.remediation).toContain("budget_policies.id");

    const accepted = await postApproval(app, {
      type: "budget_override_required",
      payload: {
        ...PROSE_ONLY_PAYLOAD,
        enforcement_assertions: [
          { ...example, policyId: POLICY_ID, expected_usd: 32000, from_usd: 19000 },
        ],
      },
    });

    expect([200, 201], JSON.stringify(accepted.body)).toContain(accepted.status);
    expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
  });

  it("accepts the legacy exact_changes shape already in production on card 6f45844e", async () => {
    const res = await postApproval(await createAgentApp(), {
      type: "budget_override_required",
      payload: {
        title: "APPLY the reallocation approved on 2026-08-04",
        exact_changes: [{ agent: "CTO", policyId: POLICY_ID, from_usd: 19000, to_usd: 32000 }],
      },
    });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  });

  it("refuses an assertion the reconciler could not act on", async () => {
    const app = await createAgentApp();

    // A declared-but-unparseable entry is the dangerous near-miss: it reads as
    // compliance and is skipped by the extractor exactly like prose, so the card
    // would be filed looking covered while being invisible. Both of these are
    // dropped by `extractEnforcementAssertions`, so both must be refused here.
    for (const broken of [
      { kind: "budget_policy_amount", policyId: "CTO", expected_usd: 32000 }, // agent name, not a policy uuid
      { kind: "budget_policy_amount", policyId: POLICY_ID, expected_usd: "thirty-two thousand" },
    ]) {
      const res = await postApproval(app, {
        type: "budget_override_required",
        payload: { title: "Raise the CTO cap", enforcement_assertions: [broken] },
      });
      expect(res.status, JSON.stringify(broken)).toBe(422);
    }
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("does not accept a figure stated anywhere but the assertion", async () => {
    // Pins the negative half of the fix. Every one of these fields carries a real
    // figure a human can read, and none may satisfy the guard: parsing a number
    // out of free-form prose in a path that writes money is exactly what
    // BLO-32796's first guardrail refuses. If this test ever goes green with a
    // parser added, that parser is the bug.
    const res = await postApproval(await createAgentApp(), {
      type: "budget_override_required",
      payload: {
        title: "Raise the CTO cap from $19,000 to $32,000",
        summary: "CTO: $19,000 -> $32,000",
        decisionNote: `- CTO: $19,000 → $32,000 (policy ${POLICY_ID})`,
        recommendedAction: `set budget_policies ${POLICY_ID} amount to 3200000 cents`,
      },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("leaves every other approval type alone", async () => {
    const res = await postApproval(await createAgentApp(), {
      type: "request_board_approval",
      payload: { title: "Approve hosting spend" },
    });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  });
});

describe("the budget watcher's own threshold cards are exempt by construction (BLO-34008)", () => {
  it("records that a server threshold payload declares no target, and why that is correct", async () => {
    const { extractEnforcementAssertions } = await import(
      "../services/approval-enforcement-reconciler.js"
    );

    // `buildApprovalPayload` (services/budgets.ts) output, abridged. It knows the
    // policy id and the cap that was crossed, but NOT what the cap should become:
    // the card asks the board to raise it or accept the pause, and the target only
    // exists once the board writes one at /costs. So there is no honest assertion
    // to emit here, and the route guard above must never see this payload.
    //
    // It does not: these cards are filed through insertApproval() rather than
    // POST /companies/:id/approvals, which `approval-payload-title-guard.test.ts`
    // pins structurally for every `db.insert(approvals)` call site.
    const watcherPayload = {
      title: "Budget override: Ally exceeded billed_cents hard cap ($38000.96 of $38000.00)",
      policyId: POLICY_ID,
      budgetAmount: 3800000,
      observedAmount: 3800096,
      thresholdType: "hard",
      guidance: "Raise the budget and resume the scope, or keep the scope paused.",
    };

    expect(extractEnforcementAssertions(watcherPayload)).toEqual([]);
  });
});

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
// `approvalRoutes` builds `issueService(db)` for the approval-link evaluator
// (`assertIssueLinksAllowed`); no case here links an issue, so the stub only
// needs to exist. Same shape as approval-create-issue-link-authorization.test.ts.
const mockIssueService = vi.hoisted(() => ({ getById: vi.fn() }));
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
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
}

/**
 * Two readers reach `select()` on these routes: the run-context lookup, and
 * `loadEnforcedBudgetPolicies` (BLO-34008). They are told apart by the projection,
 * because that is the only thing this stub sees — distinguishing on the table
 * would mean reimplementing enough of drizzle to read `.from()`. `policyId` is
 * the discriminator rather than `amount`: `amount` is a plausible column for any
 * future select on these routes to project, and a misroute would surface as a
 * confusing run-context failure instead of a clear one.
 *
 * The `where` clause is ignored, so the company/policy filter inside
 * `loadEnforcedBudgetPolicies` is not exercised here — these cases are about the
 * routes' stamping behaviour, and that filter is covered where the function is
 * tested directly.
 */
function createRouteDb(policyRows: Array<Record<string, unknown>> = []) {
  const runContextRow = { id: "run-1", companyId: "company-1", agentId: "agent-1", contextSnapshot: {} };
  return {
    select: vi.fn((projection?: Record<string, unknown>) => {
      const rows = projection && "policyId" in projection ? policyRows : [runContextRow];
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            then: async (resolve: (rows: unknown[]) => unknown) => resolve(rows),
          })),
        })),
      };
    }),
  } as any;
}

async function createAgentApp(policyRows: Array<Record<string, unknown>> = []) {
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
  app.use("/api", approvalRoutes(createRouteDb(policyRows)));
  app.use(errorHandler);
  return app;
}

function postApproval(app: express.Express, body: Record<string, unknown>) {
  return request(app).post("/api/companies/company-1/approvals").send(body);
}

/**
 * A board operator. Needed for the watcher-card cases: those have no
 * `requestedByAgentId`, and the resubmit route's ownership check 403s any agent
 * on a card it did not file, so a human is the only actor that reaches them.
 */
async function createUserApp() {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "user",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb()));
  app.use(errorHandler);
  return app;
}

/** A real `budget_policies.id`-shaped uuid. */
const POLICY_ID = "a894e681-9691-4678-88ad-063059210a14";

/** The extractor the guard delegates to, for asserting what it does *not* accept. */
async function extractAssertions(payload: unknown) {
  const { extractEnforcementAssertions } = await import("../services/approval-enforcement-reconciler.js");
  return extractEnforcementAssertions(payload);
}

/** A valid declared assertion — the shape the guard demands. */
const VALID_ASSERTION = {
  kind: "budget_policy_amount",
  policyId: POLICY_ID,
  expected_usd: 32000,
  from_usd: 19000,
  label: "CTO",
};

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
    // a doc lookup or a guess to satisfy it. Assert the error carries an assertion
    // fragment that can be copied straight back, not just a complaint.
    const refused = await postApproval(app, {
      type: "budget_override_required",
      payload: PROSE_ONLY_PAYLOAD,
    });
    expect(refused.status).toBe(422);

    const [example] = refused.body.details.example_assertions;
    expect(example).toMatchObject({
      kind: "budget_policy_amount",
      policyId: expect.any(String),
      label: expect.any(String),
    });
    expect(example.expected_usd).toEqual(expect.any(Number));
    expect(refused.body.details.remediation).toContain("budget_policies.id");

    // `policyId` is the one field the server cannot know, so the fragment must not
    // ship a plausible-looking one: copied verbatim it would pass this guard and
    // then be refused by the reconciler as `missing_policy`, which is exactly the
    // "covered but unverifiable" state the guard exists to prevent.
    expect(await extractAssertions({ enforcement_assertions: [example] })).toEqual([]);

    // `label` needs the same treatment for a different reason: it is not inert.
    // extractEnforcementAssertions() reads it and describeDrift() prints it at the
    // head of the raised issue, so a real-looking name here survives the copy and
    // attributes one agent's budget drift to whichever agent the example named.
    // Pin it as a visibly-unfilled placeholder rather than merely "a string".
    expect(example.label).toMatch(/^<.+>$/);

    // No starting figure: the remediation tells the caller never to invent one, and
    // an example carrying a concrete `from_usd` is an invitation to do exactly that
    // in a path that writes money.
    expect(example).not.toHaveProperty("from_usd");
    expect(example).not.toHaveProperty("from_amount_cents");

    const accepted = await postApproval(app, {
      type: "budget_override_required",
      payload: {
        ...PROSE_ONLY_PAYLOAD,
        enforcement_assertions: [
          {
            ...example,
            policyId: POLICY_ID,
            expected_usd: 32000,
            label: "PlayersEngineer",
            from_usd: 19000,
          },
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

  // ---------------------------------------------------------------------------
  // Resubmit is the second door into `pending`, and guarding only creation left it
  // open. `svc.resubmit()` writes `payload ?? existing.payload` and flips the card
  // back to `pending` with no type-specific validation, so the whole failure mode
  // was reachable in two calls: file a compliant card, have the board send it back
  // as `revision_requested`, resubmit it prose-only, have it approved. The
  // reconciler then sees zero assertions and BLO-34008 is live again.
  // ---------------------------------------------------------------------------

  function revisionRequestedBudgetCard(payload: Record<string, unknown>) {
    return {
      id: "approval-budget-1",
      companyId: "company-1",
      type: "budget_override_required",
      status: "revision_requested",
      payload,
      requestedByAgentId: "agent-1",
    };
  }

  function resubmit(app: express.Express, body: Record<string, unknown>) {
    return request(app).post("/api/approvals/approval-budget-1/resubmit").send(body);
  }

  it("refuses a prose-only replacement payload on resubmit", async () => {
    mockApprovalService.getById.mockResolvedValue(
      revisionRequestedBudgetCard({ title: "Raise the CTO cap", enforcement_assertions: [VALID_ASSERTION] }),
    );

    const res = await resubmit(await createAgentApp(), { payload: PROSE_ONLY_PAYLOAD });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details.code).toBe("budget_approval_missing_enforcement_assertion");
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });

  it("refuses an empty resubmit that would restore a prose-only payload", async () => {
    // The dangerous half: `resubmit` falls back to the stored payload when the
    // caller sends none, so a card filed before this guard existed — every one of
    // them, `304ea443` included — reaches `pending` again on an empty body, having
    // passed through no check at all.
    mockApprovalService.getById.mockResolvedValue(revisionRequestedBudgetCard(PROSE_ONLY_PAYLOAD));

    const res = await resubmit(await createAgentApp(), {});

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details.code).toBe("budget_approval_missing_enforcement_assertion");
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });

  it("accepts a resubmit that declares its figures, and does not deadlock the card", async () => {
    mockApprovalService.getById.mockResolvedValue(revisionRequestedBudgetCard(PROSE_ONLY_PAYLOAD));
    mockApprovalService.resubmit.mockImplementation(async (id: string, payload?: Record<string, unknown>) => ({
      ...revisionRequestedBudgetCard(payload ?? {}),
      id,
      status: "pending",
    }));

    const res = await resubmit(await createAgentApp(), {
      payload: { ...PROSE_ONLY_PAYLOAD, enforcement_assertions: [VALID_ASSERTION] },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockApprovalService.resubmit).toHaveBeenCalledTimes(1);
  });

  // The cohort the creation stamp cannot reach: a card filed before it existed
  // carries an assertion with no prior. It passes the refusal above — that asks
  // for *an* assertion, not a prior — so stamping only the supplied payload let
  // it return to `pending` classifying as `unverifiable_mismatch` forever, which
  // is the state BLO-34008 exists to eliminate. Ally's review of `b8d4f5e`.
  const RESUBMIT_POLICY_AT_19K = {
    policyId: POLICY_ID,
    amount: 1900000,
    isActive: true,
    amountUpdatedAt: new Date("2026-08-01T00:00:00.000Z"),
  };

  it("stamps the stored payload on an empty resubmit when the card predates the creation stamp", async () => {
    const priorless = { kind: "budget_policy_amount", policyId: POLICY_ID, expected_usd: 32000, label: "CTO" };
    mockApprovalService.getById.mockResolvedValue(
      revisionRequestedBudgetCard({ title: "Raise the CTO cap", enforcement_assertions: [priorless] }),
    );
    mockApprovalService.resubmit.mockImplementation(async (id: string, payload?: Record<string, unknown>) => ({
      ...revisionRequestedBudgetCard(payload ?? {}),
      id,
      status: "pending",
    }));

    const res = await resubmit(await createAgentApp([RESUBMIT_POLICY_AT_19K]), {});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [, written] = mockApprovalService.resubmit.mock.calls.at(-1) ?? [];
    expect((written as any)?.enforcement_assertions?.[0]).toMatchObject({
      from_amount_cents: 1900000,
      from_source: "server_policy_read",
    });
  });

  it("still keeps the stored payload on an empty resubmit when there is no prior to add", async () => {
    // The other half of the same branch: stamping must not turn every empty
    // resubmit into an explicit payload write. `stampAssertionPriors` returns its
    // argument by reference when it changes nothing, and that is what the route
    // tests to decide whether to send one at all.
    mockApprovalService.getById.mockResolvedValue(
      revisionRequestedBudgetCard({ title: "Raise the CTO cap", enforcement_assertions: [VALID_ASSERTION] }),
    );
    mockApprovalService.resubmit.mockImplementation(async (id: string, payload?: Record<string, unknown>) => ({
      ...revisionRequestedBudgetCard(payload ?? {}),
      id,
      status: "pending",
    }));

    const res = await resubmit(await createAgentApp([RESUBMIT_POLICY_AT_19K]), {});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockApprovalService.resubmit).toHaveBeenCalledWith("approval-budget-1", undefined);
  });

  it("leaves resubmit of every other approval type alone", async () => {    mockApprovalService.getById.mockResolvedValue({
      ...revisionRequestedBudgetCard({ title: "Approve hosting spend" }),
      type: "request_board_approval",
    });
    mockApprovalService.resubmit.mockResolvedValue({
      id: "approval-budget-1",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: { title: "Approve hosting spend" },
      requestedByAgentId: "agent-1",
    });

    const res = await resubmit(await createAgentApp(), { payload: { title: "Approve hosting spend" } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockApprovalService.resubmit).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Ally's review of `ee43166`: the stored-payload half of the guard reached the
  // budget watcher's own threshold cards, which is the one card class that
  // cannot satisfy it. Such a card records that a cap was *crossed*, not a
  // figure to raise it *to*, so it has no target to declare — the same reason
  // creation exempts it. The board UI's only resubmit affordance sends no
  // payload, so the refusal left a legacy watcher card recoverable by API only.
  // Both `budget_override_required` cards in `revision_requested` when this was
  // written (`29015e50`, `170097eb`) are watcher cards.
  // -------------------------------------------------------------------------

  /** Filed by insertApproval(): both requester columns null. Unforgeable via the route. */
  function watcherThresholdCard(overrides: Record<string, unknown> = {}) {
    return {
      id: "approval-budget-1",
      companyId: "company-1",
      type: "budget_override_required",
      status: "revision_requested",
      // `29015e50`, trimmed: a policyId and a crossed threshold, no target.
      payload: {
        title: "Budget override: Players Engineer crossed billed_cents warn threshold",
        policyId: "bd555693-cb3f-4f4d-9e18-51ad1dc44068",
        thresholdType: "soft",
        budgetAmount: 430000,
        observedAmount: 344480,
      },
      requestedByAgentId: null,
      requestedByUserId: null,
      ...overrides,
    };
  }

  it("lets the board resubmit a watcher threshold card it sent back", async () => {
    const card = watcherThresholdCard();
    mockApprovalService.getById.mockResolvedValue(card);
    mockApprovalService.resubmit.mockResolvedValue({ ...card, status: "pending" });

    // The empty body the board UI actually sends. Before this carve-out it was a
    // 422 demanding a payload no UI surface can supply and no figure exists for.
    const res = await resubmit(await createUserApp(), {});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockApprovalService.resubmit).toHaveBeenCalledTimes(1);
  });

  it("still checks a payload the board supplies on a watcher card", async () => {
    mockApprovalService.getById.mockResolvedValue(watcherThresholdCard());

    // The exemption is for having no figure, not for stating an uncheckable one:
    // an operator who writes a target has written one that must be verifiable.
    const res = await resubmit(await createUserApp(), { payload: PROSE_ONLY_PAYLOAD });

    expect(res.status).toBe(422);
    expect(res.body.details.code).toBe("budget_approval_missing_enforcement_assertion");
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });

  it("answers a wrong-status resubmit on status, not on the missing assertion", async () => {
    // The guard used to precede svc.resubmit()'s status check, so an already-
    // approved prose card was told to declare an assertion when its actual
    // problem is that it cannot be resubmitted at all.
    mockApprovalService.getById.mockResolvedValue({
      ...revisionRequestedBudgetCard(PROSE_ONLY_PAYLOAD),
      status: "approved",
    });
    const { unprocessable } = await import("../errors.js");
    mockApprovalService.resubmit.mockRejectedValue(
      unprocessable("Only revision requested approvals can be resubmitted", {
        approvalId: "approval-budget-1",
        status: "approved",
      }),
    );

    const res = await resubmit(await createAgentApp(), {});

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).not.toContain("budget_approval_missing_enforcement_assertion");
    expect(mockApprovalService.resubmit).toHaveBeenCalledTimes(1);
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

/**
 * BLO-34008 — the server records the figure the change starts from.
 *
 * `classifyEnforcementAssertion` needs three numbers (prior, decided, enforced)
 * to tell a decision that never landed from one a later decision superseded.
 * With only two it answers `unverifiable_mismatch` for every disagreement:
 * still reported as drift, but not auto-appliable, and it cannot distinguish the
 * real gap from the false-positive class that filed BLO-33160, BLO-33397,
 * BLO-33416 and BLO-33772.
 *
 * Requiring the caller to supply it is not available: the refusal's own
 * remediation says never to invent a starting figure, and its example payload
 * deliberately omits one. So the server reads it from the policy the assertion
 * already names. That is a database read, not a guess — the distinction the
 * whole refusal exists to protect.
 */
describe("the starting figure is stamped from the enforcing policy (BLO-34008)", () => {
  const POLICY_AT_19K = { policyId: POLICY_ID, amount: 1900000, isActive: true, amountUpdatedAt: new Date("2026-08-01T00:00:00.000Z") };

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    registerModuleMocks();
    vi.clearAllMocks();

    mockApprovalService.createWithIdempotency.mockImplementation(
      async (companyId: string, data: Record<string, unknown>) => ({
        approval: { id: "approval-1", companyId, status: "pending", ...data },
        deduplicated: false,
      }),
    );
    mockLogActivity.mockResolvedValue(mockDeferredActivityPublish);
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
  });

  /** The `enforcement_assertions` array as it was actually persisted. */
  function persistedAssertions() {
    const [, data] = mockApprovalService.createWithIdempotency.mock.calls.at(-1) ?? [];
    return (data as any)?.payload?.enforcement_assertions ?? [];
  }

  function fileCard(app: express.Express, assertion: Record<string, unknown>) {
    return postApproval(app, {
      type: "budget_override_required",
      payload: { title: "Raise the CTO cap", enforcement_assertions: [assertion] },
    });
  }

  it("fills the prior from the policy when the caller states none", async () => {
    const app = await createAgentApp([POLICY_AT_19K]);

    const res = await fileCard(app, { kind: "budget_policy_amount", policyId: POLICY_ID, expected_usd: 32000, label: "CTO" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(persistedAssertions()[0]).toMatchObject({
      from_amount_cents: 1900000,
      from_source: "server_policy_read",
    });
  });

  it("does not overwrite a prior the caller stated", async () => {
    // The caller may know a pre-decision figure the current row no longer shows
    // (a card filed after a manual edit). Silently replacing it would also hide
    // a wrong one, which `policyAmountChangedAfterDecision` is there to catch.
    const app = await createAgentApp([{ ...POLICY_AT_19K, amount: 2500000 }]);

    await fileCard(app, { kind: "budget_policy_amount", policyId: POLICY_ID, expected_usd: 32000, from_usd: 19000 });

    expect(persistedAssertions()[0]).toMatchObject({ from_usd: 19000 });
    expect(persistedAssertions()[0]).not.toHaveProperty("from_source");
  });

  it("leaves an unresolvable policy unstamped so it still reports as missing_policy", async () => {
    // Stamping nothing is the point: a card naming a policy that does not exist
    // in this company must keep reading as broken, not acquire a figure that
    // makes it look serviceable.
    const app = await createAgentApp([]);

    await fileCard(app, { kind: "budget_policy_amount", policyId: POLICY_ID, expected_usd: 32000 });

    expect(persistedAssertions()[0]).not.toHaveProperty("from_amount_cents");
    expect(persistedAssertions()[0]).not.toHaveProperty("from_source");
  });

  it("turns the 0-of-8 shape from unverifiable_mismatch into never_applied", async () => {
    // The whole reason the stamp exists, asserted end to end rather than on the
    // field: file the card, take the payload that was actually persisted, and
    // classify it against a policy still sitting at the pre-approval amount.
    // That is card 304ea443's shape — approved, never applied.
    const app = await createAgentApp([POLICY_AT_19K]);
    await fileCard(app, { kind: "budget_policy_amount", policyId: POLICY_ID, expected_usd: 32000, label: "CTO" });

    const { extractEnforcementAssertions, classifyEnforcementAssertion } = await import(
      "../services/approval-enforcement-reconciler.js"
    );
    const [, data] = mockApprovalService.createWithIdempotency.mock.calls.at(-1) ?? [];
    const [assertion] = extractEnforcementAssertions((data as any).payload);
    const decidedAt = new Date("2026-08-04T10:04:45.877Z");

    expect(assertion?.priorAmountCents).toBe(1900000);
    expect(classifyEnforcementAssertion(assertion!, POLICY_AT_19K, decidedAt)).toBe("never_applied");
  });

  it("still classifies a genuine supersession as superseded, not drift", async () => {
    // The other half: the stamp must not convert the legitimate case into a
    // false positive. Enforced figure is neither prior nor decided, and the
    // amount moved after the decision.
    const app = await createAgentApp([POLICY_AT_19K]);
    await fileCard(app, { kind: "budget_policy_amount", policyId: POLICY_ID, expected_usd: 32000 });

    const { extractEnforcementAssertions, classifyEnforcementAssertion } = await import(
      "../services/approval-enforcement-reconciler.js"
    );
    const [, data] = mockApprovalService.createWithIdempotency.mock.calls.at(-1) ?? [];
    const [assertion] = extractEnforcementAssertions((data as any).payload);

    const movedLater = { ...POLICY_AT_19K, amount: 2500000, amountUpdatedAt: new Date("2026-08-20T00:00:00.000Z") };
    expect(classifyEnforcementAssertion(assertion!, movedLater, new Date("2026-08-04T10:04:45.877Z"))).toBe("superseded");
  });

  it("writes the stamp back to the key it read, not the key that merely exists", async () => {
    // `??` falls through a present-but-null `enforcement_assertions` to the
    // camelCase array. Choosing the write key with `in` would then stamp the
    // snake_case key and leave the camelCase array this actually read in place
    // unstamped — two divergent assertion arrays on one money payload.
    const { stampAssertionPriors } = await import("../services/approval-enforcement-reconciler.js");
    const payload = {
      enforcement_assertions: null,
      enforcementAssertions: [{ kind: "budget_policy_amount", policyId: POLICY_ID, expected_usd: 32000 }],
    };

    const out = stampAssertionPriors(payload, new Map([[POLICY_ID, POLICY_AT_19K]])) as any;

    expect(out.enforcementAssertions[0]).toMatchObject({ from_amount_cents: 1900000 });
    expect(out.enforcement_assertions).toBeNull();
  });
});

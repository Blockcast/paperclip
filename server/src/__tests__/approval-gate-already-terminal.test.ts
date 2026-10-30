/**
 * PEN-5103 — a card may not be filed against an Actions run that is already over.
 *
 * `payload.gate` means one thing: "the ask IS a human clicking this Actions gate".
 * The approval-gate reconciler (BLO-29359) then closes the card as soon as that run
 * terminates. That is correct when the gate IS the ask, and silently wrong when it
 * is not — the card is retired by an event with no bearing on what was asked.
 *
 * Measured twice in eight days by two different agents, same shape both times: the
 * ask was "a human must put an approving review on PR #N", the gate named an
 * ordinary CI run on that PR, and CI went green.
 *
 *   c60dacd5 (devops, 2026-10-30)   filed 08:41:46Z, closed 08:48:23Z — 6m37s
 *   e0fba0c6 (security, 2026-10-23) filed 15:30:07Z, closed 15:37:38Z — 7m31s
 *
 * The sweep runs every 10 minutes, so both were closed on the FIRST sweep after
 * filing: the run was already terminal when the card was filed, and the card was
 * dead on arrival. That is what these tests pin — and why the refusal is synchronous
 * rather than a documented rule. Each card outlived its own filing run by under
 * eight minutes, so its author never observed the cancellation and had nothing to
 * learn from.
 *
 * The guard is deliberately narrow: it refuses an ALREADY-TERMINAL gate, which can
 * never be clicked by anyone. It does not judge whether a live gate "relates to" a
 * free-text ask — that is not mechanisable, and attempting it is how a guard starts
 * refusing legitimate escalations.
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
const mockIssueService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockDeferredActivityPublish = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
/** The one GitHub call the guard makes. Every case here drives it from this stub. */
const mockGetWorkflowRun = vi.hoisted(() => vi.fn());

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
  // Partial-mock so `classifyGateLookup` — which the guard delegates its verdict to —
  // stays the real implementation. Stubbing the classifier too would let these tests
  // pass against a guard that had stopped agreeing with the reconciler, which is the
  // one invariant worth holding: the thing that refuses at the door and the thing
  // that closes the card must read a run the same way.
  vi.doMock("../services/github-app-auth.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../services/github-app-auth.js")>()),
    githubGetWorkflowRun: mockGetWorkflowRun,
  }));
}

function createRouteDb() {
  const runContextRow = { id: "run-1", companyId: "company-1", agentId: "agent-1", contextSnapshot: {} };
  return {
    select: vi.fn((projection?: Record<string, unknown>) => {
      const rows = projection && "policyId" in projection ? [] : [runContextRow];
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

/** The gate `c60dacd5` carried: a CI run on the PR it asked a human to review. */
const MISMATCHED_GATE = {
  kind: "github_actions_run" as const,
  repoFullName: "Blockcast/onprem-k8s",
  runId: 40434542378,
  url: "https://github.com/Blockcast/onprem-k8s/actions/runs/40434542378",
};

const REVIEW_ASK_PAYLOAD = {
  title: "PEN-4831 · onprem-k8s#6864 has sat 3 days on a human-review gate",
  ask: "Either (a) have someone put one approving review on onprem-k8s#6864, or (b) tell me to close the PR.",
  gate: MISMATCHED_GATE,
};

const found = (status: string, conclusion: string | null) => ({
  outcome: "found" as const,
  status,
  conclusion,
  htmlUrl: MISMATCHED_GATE.url,
});

describe("a card may not be filed against an already-finished gate (PEN-5103)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/github-app-auth.js");
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
      createdAt: new Date("2026-10-30T08:41:46.000Z"),
      updatedAt: new Date("2026-10-30T08:41:46.000Z"),
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

  it("refuses the exact card that died in 6m37s, and never files it", async () => {
    mockGetWorkflowRun.mockResolvedValue(found("completed", "success"));

    const res = await postApproval(await createAgentApp(), {
      type: "request_board_approval",
      payload: REVIEW_ASK_PAYLOAD,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details.code).toBe("approval_gate_already_terminal");
    expect(res.body.details.gate).toEqual({
      repoFullName: "Blockcast/onprem-k8s",
      runId: 40434542378,
    });
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("refuses a gate naming a run that no longer exists", async () => {
    // `not_found` is the reconciler's one non-2xx terminal outcome, and it is only
    // returned once the repo itself has been confirmed readable — so it is positive
    // evidence the run is gone, not an access failure.
    mockGetWorkflowRun.mockResolvedValue({ outcome: "not_found" });

    const res = await postApproval(await createAgentApp(), {
      type: "request_board_approval",
      payload: REVIEW_ASK_PAYLOAD,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details.code).toBe("approval_gate_already_terminal");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("tells the caller the rule, not just that it was refused", async () => {
    // The two measured misuses were not typos — both authors believed `payload.gate`
    // was a place to record a related run. A refusal that only says "already
    // finished" leaves that belief intact and the next card repeats it, so the
    // remediation has to carry the rule itself and name the asks it excludes.
    mockGetWorkflowRun.mockResolvedValue(found("completed", "success"));

    const res = await postApproval(await createAgentApp(), {
      type: "request_board_approval",
      payload: REVIEW_ASK_PAYLOAD,
    });

    const remediation: string = res.body.details.remediation;
    expect(remediation).toContain("PR review");
    expect(remediation).toContain("do not set `payload.gate` at all");
    expect(remediation).toMatch(/not a general .related link. field/i);
  });

  it.each([
    ["queued", null],
    ["waiting", null],
    ["in_progress", null],
  ])("files a card whose gate is still live (status=%s)", async (status, conclusion) => {
    // The legitimate case the feature exists for: a deploy run parked on a human
    // reviewer. A guard that caught these would block the escalations BLO-29359 was
    // built to keep alive.
    mockGetWorkflowRun.mockResolvedValue(found(status, conclusion));

    const res = await postApproval(await createAgentApp(), {
      type: "request_board_approval",
      payload: { title: "Approve the paperclip-production gate", gate: MISMATCHED_GATE },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledOnce();
  });

  it.each([
    ["a retryable lookup error", { outcome: "error" as const, retryable: true, reason: "rate_limited" }],
    ["a permanent lookup error", { outcome: "error" as const, retryable: false, reason: "forbidden" }],
  ])("fails OPEN on %s", async (_label, lookup) => {
    // Same direction the reconciler takes when it declines to retire gates it cannot
    // read: a throttled or unreachable GitHub must never become a way to block
    // escalations in bulk. Refusing here would make the board queue unreachable
    // exactly when something is already wrong.
    mockGetWorkflowRun.mockResolvedValue(lookup);

    const res = await postApproval(await createAgentApp(), {
      type: "request_board_approval",
      payload: REVIEW_ASK_PAYLOAD,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledOnce();
  });

  it("fails OPEN when the lookup throws", async () => {
    mockGetWorkflowRun.mockRejectedValue(new Error("socket hang up"));

    const res = await postApproval(await createAgentApp(), {
      type: "request_board_approval",
      payload: REVIEW_ASK_PAYLOAD,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledOnce();
  });

  it("costs nothing for the cards that carry no gate", async () => {
    // 11 of 11 cards pending on the measured board carried no `payload.gate`, so
    // this is the overwhelmingly common path. It must not reach GitHub at all.
    const res = await postApproval(await createAgentApp(), {
      type: "request_board_approval",
      payload: { title: "@kkroo — one approving review on penstock-llm-proxy-core#2965" },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockGetWorkflowRun).not.toHaveBeenCalled();
  });

  it("leaves a malformed gate to schema validation, and still never calls GitHub", async () => {
    // `createApprovalSchema` validates `payload.gate` at the HTTP layer, so a
    // malformed gate is a 400 before this guard is reached. Pinned because the guard
    // reads as though it handles the case — `parseApprovalGate` is total and returns
    // null on junk — and that path is in fact unreachable from this route. The part
    // that matters either way is the second assertion: a gate the server cannot even
    // parse must not cost a GitHub round trip.
    const res = await postApproval(await createAgentApp(), {
      type: "request_board_approval",
      payload: { title: "Card with a junk gate", gate: { kind: "something_else", runId: "not-a-number" } },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.details.map((d: { path: string[] }) => d.path.join("."))).toEqual(
      expect.arrayContaining(["payload.gate.kind", "payload.gate.repoFullName", "payload.gate.runId"]),
    );
    expect(mockGetWorkflowRun).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Resubmit is the second door into `pending`. `svc.resubmit()` writes
  // `payload ?? existing.payload` with no type-specific validation, so a
  // create-only guard leaves the failure reachable in two calls — the same gap the
  // budget guard above this one documents for itself.
  // ---------------------------------------------------------------------------

  function revisionRequestedCard(payload: Record<string, unknown>) {
    return {
      id: "approval-gate-1",
      companyId: "company-1",
      type: "request_board_approval",
      status: "revision_requested",
      payload,
      requestedByAgentId: "agent-1",
    };
  }

  function resubmit(app: express.Express, body: Record<string, unknown>) {
    return request(app).post("/api/approvals/approval-gate-1/resubmit").send(body);
  }

  it("refuses a resubmit that attaches an already-finished gate", async () => {
    mockGetWorkflowRun.mockResolvedValue(found("completed", "success"));
    mockApprovalService.getById.mockResolvedValue(
      revisionRequestedCard({ title: "Escalation the board sent back" }),
    );

    const res = await resubmit(await createAgentApp(), { payload: REVIEW_ASK_PAYLOAD });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details.code).toBe("approval_gate_already_terminal");
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });

  it("does not re-check a stored gate on an empty resubmit", async () => {
    // Deliberately unlike the budget guard, which DOES re-check the stored payload.
    // The two differ because the facts they check differ: a prose-only budget card
    // is permanently unverifiable, so restoring it is always the same defect. A
    // stored gate, by contrast, terminates with time — so re-checking here would
    // refuse a card the board explicitly asked to see again, purely because its run
    // has since ended. That is not the mistake this guard is about, and refusing it
    // would strand a card with no way back to `pending`.
    mockGetWorkflowRun.mockResolvedValue(found("completed", "success"));
    mockApprovalService.getById.mockResolvedValue(revisionRequestedCard(REVIEW_ASK_PAYLOAD));
    mockApprovalService.resubmit.mockResolvedValue({ ...revisionRequestedCard(REVIEW_ASK_PAYLOAD), status: "pending" });

    const res = await resubmit(await createAgentApp(), {});

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockGetWorkflowRun).not.toHaveBeenCalled();
  });

  it("answers a non-revision_requested card with the status error, not a gate complaint", async () => {
    // Ordering, not behaviour: only a `revision_requested` card can reach `pending`,
    // so a card in any other status is going to fail in `svc.resubmit()` on status no
    // matter what its payload says. Checking the gate first would answer "your gate is
    // dead" to a caller whose actual problem is that the card was never sent back for
    // revision — pointing them at the wrong thing, and at a field they may not even
    // have set deliberately. The budget guard directly above makes the same choice for
    // the same reason. Raised by Ally reviewing `3105e66`.
    mockGetWorkflowRun.mockResolvedValue(found("completed", "success"));
    mockApprovalService.getById.mockResolvedValue({
      ...revisionRequestedCard({ title: "Escalation nobody sent back" }),
      status: "pending",
    });
    // Dynamic import, like the sibling budget suite does for the same assertion:
    // the route graph is imported inside `createAgentApp()` after the mocks are
    // registered, so a static top-level import here yields a DIFFERENT module
    // instance and `err instanceof HttpError` fails in the error handler — the
    // thrown status error would surface as a 500 and the test would pin nothing.
    const { unprocessable } = await import("../errors.js");
    mockApprovalService.resubmit.mockRejectedValue(
      unprocessable("Only revision requested approvals can be resubmitted", {
        approvalId: "approval-gate-1",
        status: "pending",
      }),
    );

    const res = await resubmit(await createAgentApp(), { payload: REVIEW_ASK_PAYLOAD });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toBe("Only revision requested approvals can be resubmitted");
    expect(JSON.stringify(res.body)).not.toContain("approval_gate_already_terminal");
    expect(mockApprovalService.resubmit).toHaveBeenCalledTimes(1);
    // The guard is skipped outright rather than merely losing a race, so the dead gate
    // costs no GitHub round trip on a request that was always going to fail on status.
    expect(mockGetWorkflowRun).not.toHaveBeenCalled();
  });
});

/**
 * PEN-5766 — `PATCH /approvals/:id`: a requester may correct a PENDING card's
 * payload in place, and that edit must not move the card in the board queue.
 *
 * ## What was broken
 *
 * A pending card's payload was immutable to the agent that filed it. `resubmit` is
 * gated on `revision_requested`; nothing else writes `payload`. So a filer whose
 * evidence had gone stale had two moves, and both were bad: leave false evidence in
 * front of a human decider, or `withdraw` and re-file.
 *
 * Re-filing mints a new row with a new `createdAt`, and board service is measurably
 * recency-skewed — PEN-3918 cmt `d00b4081` §4, on the full approvals corpus: the
 * 2026-11-03 burst decided 17 cards, 16 of them created LATER than the oldest card
 * it left pending. So re-filing for accuracy takes queue position from specific,
 * older cards belonging to other filers. **Correcting your evidence and jumping the
 * queue were the same keystroke.**
 *
 * The live specimen: card `70d198e9`, filed "Fully green, open 6 days", while the
 * PR it named had since gone `statusCheckRollup.state=FAILURE` and moved its head
 * past the attestation the card cited. Its text could not be brought into line with
 * what the decider saw by any route the filer held.
 *
 * ## What these tests pin
 *
 * The refusals, narrowest first, and the fact that an accepted edit reaches the
 * service with the payload the caller sent and nothing else. The `createdAt` and
 * queue-position guarantees are pinned against a real database in
 * `approval-payload-edit-service.test.ts` — a mocked service cannot witness them.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asStoredGate, LIVE_GATE } from "./helpers/approval-gate-fixtures.js";

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
  withdraw: vi.fn(),
  updatePayload: vi.fn(),
  listPayloadRevisions: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));
const mockIssueService = vi.hoisted(() => ({ getById: vi.fn(async () => null) }));
const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockGetWorkflowRun = vi.hoisted(() => vi.fn());
const mockGetPullRequestGate = vi.hoisted(() => vi.fn());

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
  // Partial-mock, for the reason `approval-gate-already-terminal.test.ts` gives:
  // `classifyGateLookup` stays real, so these tests cannot pass against an edit
  // guard that had stopped reading a run the same way the reconciler does.
  vi.doMock("../services/github-app-auth.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../services/github-app-auth.js")>()),
    githubGetWorkflowRun: mockGetWorkflowRun,
    githubGetPullRequestGate: mockGetPullRequestGate,
  }));
}

function createRouteDb() {
  const runContextRow = { id: "run-1", companyId: "company-1", agentId: REQUESTER_AGENT_ID, contextSnapshot: {} };
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

const REQUESTER_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT_ID = "22222222-2222-4222-8222-222222222222";

const agentActor = (agentId: string) => ({
  type: "agent",
  agentId,
  companyId: "company-1",
  runId: "run-1",
  source: "api_key",
  isInstanceAdmin: false,
});

const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
};

async function createAppWithActor(actor: Record<string, unknown>) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb()));
  app.use(errorHandler);
  return app;
}


function pendingApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    status: "pending",
    payload: { title: "ONE approving review on #2958. Fully green, open 6 days" },
    requestedByAgentId: REQUESTER_AGENT_ID,
    payloadRevision: 0,
    payloadEditedAt: null,
    createdAt: new Date("2026-11-04T09:36:00.000Z"),
    ...overrides,
  };
}

function patchPayload(app: express.Express, payload: Record<string, unknown>) {
  return request(app).patch("/api/approvals/approval-1").send({ payload });
}

describe("PATCH /approvals/:id", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockLogActivity.mockResolvedValue(undefined);
    // Default: the gate the specimen card carries is still live, so a gate that is
    // merely RESENT unchanged never trips the already-terminal guard.
    mockGetPullRequestGate.mockResolvedValue({ state: "open", merged: false });
  });

  it("lets the requesting agent correct its own pending card, and sends the service exactly the submitted payload", async () => {
    const corrected = {
      title: "ONE approving review on #2958. 5 red checks are the legacy refused arm; open 8 days",
    };
    mockApprovalService.getById.mockResolvedValue(pendingApproval());
    mockApprovalService.updatePayload.mockResolvedValue(
      pendingApproval({ payload: corrected, payloadRevision: 1, payloadEditedAt: new Date() }),
    );

    const res = await patchPayload(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)), corrected);

    expect(res.status).toBe(200);
    expect(res.body.payloadRevision).toBe(1);
    expect(res.body.payloadEditedAt).not.toBeNull();
    expect(mockApprovalService.updatePayload).toHaveBeenCalledWith(
      "approval-1",
      corrected,
      { agentId: REQUESTER_AGENT_ID, userId: null },
    );
  }, 15000);

  it("refuses an edit by an agent that did not file the card", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval());

    const res = await patchPayload(await createAppWithActor(agentActor(OTHER_AGENT_ID)), {
      title: "not my card to rewrite",
    });

    expect(res.status).toBe(403);
    expect(res.body.details.code).toBe("approval_payload_edit_forbidden");
    expect(mockApprovalService.updatePayload).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  }, 15000);

  it("refuses an edit by a board actor, pointing at request-revision instead", async () => {
    // Deliberately tighter than withdraw/resubmit, which do admit the board. The
    // board already has a payload-changing path that is VISIBLE to the filer
    // (`requestRevision` → the filer's `resubmit`); a board actor silently
    // rewriting a filer's evidence is a different power than this row asked for.
    mockApprovalService.getById.mockResolvedValue(pendingApproval());

    const res = await patchPayload(await createAppWithActor(boardActor), { title: "board rewrite" });

    expect(res.status).toBe(403);
    expect(res.body.details.remediation).toContain("request-revision");
    expect(mockApprovalService.updatePayload).not.toHaveBeenCalled();
  }, 15000);

  it.each([
    ["approved", "already decided"],
    ["withdrawn", "already decided"],
    ["revision_requested", "resubmit"],
  ])("refuses an edit when the card is %s", async (status) => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval({ status }));

    const res = await patchPayload(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)), {
      title: "too late",
    });

    expect(res.status).toBe(409);
    expect(res.body.details.code).toBe("approval_payload_edit_status");
    expect(res.body.details.allowedStatuses).toEqual(["pending"]);
    expect(mockApprovalService.updatePayload).not.toHaveBeenCalled();
  }, 15000);

  it("refuses an edit that CHANGES the gate, because the gate is the retirement contract", async () => {
    mockApprovalService.getById.mockResolvedValue(
      pendingApproval({ payload: { title: "merge #2958", gate: asStoredGate(LIVE_GATE) } }),
    );

    const res = await patchPayload(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)), {
      title: "merge #2958",
      gate: { ...LIVE_GATE, prNumber: 9999 },
    });

    expect(res.status).toBe(422);
    expect(res.body.details.code).toBe("approval_payload_gate_immutable");
    expect(mockApprovalService.updatePayload).not.toHaveBeenCalled();
  }, 15000);

  it("refuses an edit that DROPS the gate by omission rather than silently keeping it", async () => {
    // The dangerous direction: a caller that believes it just removed a gate must
    // not get a 200 for an operation that did not happen. That is the same class of
    // correct-looking-but-wrong artifact this whole row exists to remove.
    mockApprovalService.getById.mockResolvedValue(
      pendingApproval({ payload: { title: "merge #2958", gate: asStoredGate(LIVE_GATE) } }),
    );

    const res = await patchPayload(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)), {
      title: "merge #2958 — gate deliberately omitted",
    });

    expect(res.status).toBe(422);
    expect(res.body.details.code).toBe("approval_payload_gate_immutable");
    expect(res.body.details.storedGate).toMatchObject({ prNumber: 2958 });
    expect(mockApprovalService.updatePayload).not.toHaveBeenCalled();
  }, 15000);

  it("⭐ accepts an edit that resends the stored gate, which jsonb hands back REORDERED", async () => {
    // Not "byte-identically", which is what this case used to claim and why it
    // passed against a guard that refused every real edit to a gated card. The
    // stored side goes through `asStoredGate` because `payload` is jsonb and
    // Postgres sorts jsonb keys shortest-first, so no stored gate is ever in the
    // shape order zod emits. The guard must compare STRUCTURE (Ally, PR 3456);
    // `approval-payload-edit-service.test.ts` pins that key order against a real
    // database, so this fixture cannot drift away from what a card actually holds.
    const stored = { title: "merge #2958", gate: asStoredGate(LIVE_GATE) };
    mockApprovalService.getById.mockResolvedValue(pendingApproval({ payload: stored }));
    mockApprovalService.updatePayload.mockResolvedValue(
      pendingApproval({ payload: { ...stored, title: "merge #2958 (rebased)" }, payloadRevision: 1 }),
    );

    const res = await patchPayload(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)), {
      title: "merge #2958 (rebased)",
      gate: LIVE_GATE,
    });

    expect(res.status).toBe(200);
    expect(mockApprovalService.updatePayload).toHaveBeenCalled();
  }, 15000);

  it("refuses at edit a payload that `budgetAssertionRefusal` would refuse at create", async () => {
    // BLO-34008 the other way round: a budget card must not be able to shed the
    // machine-checkable assertion it was obliged to carry by editing it away.
    mockApprovalService.getById.mockResolvedValue(
      pendingApproval({
        type: "budget_override_required",
        payload: {
          title: "raise the CTO cap to $32k",
          enforcement_assertions: [
            {
              kind: "budget_policy_amount",
              policyId: "33333333-3333-4333-8333-333333333333",
              expected_usd: 32000,
              label: "CTO seat",
            },
          ],
        },
      }),
    );

    const res = await patchPayload(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)), {
      title: "raise the CTO cap to $32k — trust me",
    });

    expect(res.status).toBe(422);
    expect(res.body.details.code).toBe("budget_approval_missing_enforcement_assertion");
    expect(mockApprovalService.updatePayload).not.toHaveBeenCalled();
  }, 15000);

  it("refuses at edit a gate that `gateAlreadyTerminalRefusal` would refuse at create", async () => {
    // A card filed against a live PR whose PR has since merged cannot be edited to
    // keep pointing at it: an edit must not be able to land a payload a create
    // would have turned away.
    mockApprovalService.getById.mockResolvedValue(
      pendingApproval({ payload: { title: "merge #2958", gate: asStoredGate(LIVE_GATE) } }),
    );
    mockGetPullRequestGate.mockResolvedValue({ state: "closed", merged: true });

    const res = await patchPayload(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)), {
      title: "merge #2958 — still waiting",
      gate: LIVE_GATE,
    });

    expect(res.status).toBe(422);
    expect(res.body.details.code).toBe("approval_gate_already_terminal");
    expect(mockApprovalService.updatePayload).not.toHaveBeenCalled();
  }, 15000);

  it("re-stamps a hire card's agent binding onto an edit that omits it", async () => {
    // `payload` REPLACES the stored payload wholesale, so an edit that merely omits
    // `agentId` passes the binding guard (which only refuses a MOVED binding) and
    // then drops the binding out of the persisted payload — `agentService` reads
    // `payload.agentId` as a fallback. `resubmit` already re-stamps it; an edit is
    // no different (Ally, PR 3456).
    const LINKED_AGENT_ID = "33333333-3333-4333-8333-333333333333";
    mockApprovalService.getById.mockResolvedValue(
      pendingApproval({
        type: "hire_agent",
        linkedAgentId: LINKED_AGENT_ID,
        payload: { title: "hire a platform engineer", agentId: LINKED_AGENT_ID },
      }),
    );
    // The secrets normalizer is a pass-through here: what is under test is the
    // re-stamp that runs after it, not the normalization itself.
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockImplementation(
      async (_companyId: string, payload: Record<string, unknown>) => payload,
    );
    mockApprovalService.updatePayload.mockResolvedValue(
      pendingApproval({ type: "hire_agent", payloadRevision: 1 }),
    );

    const res = await patchPayload(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)), {
      title: "hire a platform engineer — scope narrowed to the approvals surface",
    });

    expect(res.status).toBe(200);
    expect(mockApprovalService.updatePayload).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({ agentId: LINKED_AGENT_ID }),
      { agentId: REQUESTER_AGENT_ID, userId: null },
    );
  }, 15000);

  it("still refuses a hire edit that re-points the agent binding", async () => {
    const LINKED_AGENT_ID = "33333333-3333-4333-8333-333333333333";
    mockApprovalService.getById.mockResolvedValue(
      pendingApproval({
        type: "hire_agent",
        linkedAgentId: LINKED_AGENT_ID,
        payload: { title: "hire a platform engineer", agentId: LINKED_AGENT_ID },
      }),
    );
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockImplementation(
      async (_companyId: string, payload: Record<string, unknown>) => payload,
    );

    const res = await patchPayload(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)), {
      title: "hire a platform engineer",
      agentId: "44444444-4444-4444-8444-444444444444",
    });

    expect(res.status).toBe(422);
    expect(mockApprovalService.updatePayload).not.toHaveBeenCalled();
  }, 15000);

  it("rejects a body with no payload at all rather than clearing the card", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval());

    const res = await request(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)))
      .patch("/api/approvals/approval-1")
      .send({});

    expect(res.status).toBe(400);
    expect(mockApprovalService.updatePayload).not.toHaveBeenCalled();
  }, 15000);

  it("rejects a payload with a blank title, exactly as create does", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval());

    const res = await patchPayload(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)), {
      title: "   ",
    });

    expect(res.status).toBe(400);
    expect(mockApprovalService.updatePayload).not.toHaveBeenCalled();
  }, 15000);
});

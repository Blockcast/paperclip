import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, approvalComments, approvals, companies, createDb } from "@paperclipai/db";
import { approvalService } from "../services/approvals.js";
import { resolveApprovalWithSideEffects } from "../services/approval-resolution.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockWakeup = vi.hoisted(() => vi.fn());
const mockListIssuesForApproval = vi.hoisted(() => vi.fn());
const mockApprovalService = vi.hoisted(() => ({
  requestRevision: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
}));

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: vi.fn(),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

// `approval-resolution` pulls its collaborators from the services barrel, so the
// barrel is the seam that lets these tests observe the wake without a database.
vi.mock("../services/index.js", () => ({
  approvalService: vi.fn(() => mockApprovalService),
  heartbeatService: vi.fn(() => ({ wakeup: mockWakeup })),
  issueApprovalService: vi.fn(() => ({ listIssuesForApproval: mockListIssuesForApproval })),
  logActivity: mockLogActivity,
}));

const BOARD_NOTE = [
  "Not while the DCO signing identity is unsettled.",
  "",
  "Re-file once the bot identity question in BLO-22323 has a written ruling.",
].join("\n");

const withdrawalActor = {
  userId: null,
  activity: {
    actorType: "agent" as const,
    actorId: "requester-1",
    agentId: "requester-1",
  },
};

const resolutionActor = {
  activityActorType: "user" as const,
  activityActorId: "board-user",
  requesterWakeActorType: "user" as const,
  requesterWakeActorId: "board-user",
};

function decidedApproval(status: string) {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    status,
    decisionNote: BOARD_NOTE,
    requestedByAgentId: "requester-1",
  };
}

describe("board decision wakes the requesting agent on every decided state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
    mockWakeup.mockResolvedValue({ id: "wake-run-1" });
    mockListIssuesForApproval.mockResolvedValue([{ id: "issue-1" }, { id: "issue-2" }]);
  });

  // The defect this pins: only `approve` woke the requester, so a `rejected` or
  // `revision_requested` card was answered into silence. `rejected` is the worse
  // half — it *looks* answered, so nothing ever re-examines it (BLO-27036 measured
  // 4 cards unread for 10-11 days and 9 of 10 rejections with no note at all).
  const cases = [
    { decision: "reject" as const, status: "rejected", reason: "approval_rejected" },
    { decision: "revise" as const, status: "revision_requested", reason: "approval_revision_requested" },
    { decision: "approve" as const, status: "approved", reason: "approval_approved" },
  ];

  for (const { decision, status, reason } of cases) {
    it(`queues a requester wake carrying the decision note for ${status}`, async () => {
      const approval = decidedApproval(status);
      mockApprovalService.requestRevision.mockResolvedValue(approval);
      mockApprovalService.approve.mockResolvedValue({ approval, applied: true });
      mockApprovalService.reject.mockResolvedValue({ approval, applied: true });

      await resolveApprovalWithSideEffects({} as any, {}, {
        approvalId: "approval-1",
        decision,
        decidedByUserId: "board-user",
        decisionNote: BOARD_NOTE,
        actor: resolutionActor,
      });

      expect(mockWakeup).toHaveBeenCalledTimes(1);
      const [agentId, options] = mockWakeup.mock.calls[0];
      expect(agentId).toBe("requester-1");
      expect(options.reason).toBe(reason);
      // The whole point of the wake is that the woken run can act on the board's
      // reasoning without a second fetch, so the note must ride along.
      expect(options.payload.decisionNote).toBe(BOARD_NOTE);
      expect(options.contextSnapshot.decisionNote).toBe(BOARD_NOTE);
      expect(options.payload.approvalId).toBe("approval-1");
      expect(options.contextSnapshot.wakeReason).toBe(reason);
      expect(options.contextSnapshot.issueIds).toEqual(["issue-1", "issue-2"]);
    });
  }

  it("does not wake when the approval carries no requesting agent", async () => {
    const approval = { ...decidedApproval("rejected"), requestedByAgentId: null };
    mockApprovalService.reject.mockResolvedValue({ approval, applied: true });

    await resolveApprovalWithSideEffects({} as any, {}, {
      approvalId: "approval-1",
      decision: "reject",
      decidedByUserId: "board-user",
      actor: resolutionActor,
    });

    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("does not wake on a decision another worker already applied", async () => {
    const approval = decidedApproval("rejected");
    mockApprovalService.reject.mockResolvedValue({ approval, applied: false });

    await resolveApprovalWithSideEffects({} as any, {}, {
      approvalId: "approval-1",
      decision: "reject",
      decidedByUserId: "board-user",
      actor: resolutionActor,
    });

    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("still returns the decision when the wake itself fails", async () => {
    const approval = decidedApproval("rejected");
    mockApprovalService.reject.mockResolvedValue({ approval, applied: true });
    mockWakeup.mockRejectedValue(new Error("scheduler unavailable"));

    const result = await resolveApprovalWithSideEffects({} as any, {}, {
      approvalId: "approval-1",
      decision: "reject",
      decidedByUserId: "board-user",
      actor: resolutionActor,
    });

    expect(result.applied).toBe(true);
    expect(
      mockLogActivity.mock.calls.some(([, entry]) => entry?.action === "approval.requester_wakeup_failed"),
    ).toBe(true);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("a requester-initiated exit never destroys the board's decision note", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  // `approval_comments.author_agent_id` carries a real FK to `agents`, so the
  // withdrawing agent has to exist for the comment write inside the transaction.
  let requesterAgentId!: string;
  let dbWithdrawalActor!: typeof withdrawalActor;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-revision-exit-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Revision exit company",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    requesterAgentId = randomUUID();
    await db.insert(agents).values({
      id: requesterAgentId,
      companyId,
      name: "Requesting agent",
      role: "engineer",
      status: "idle",
    });
    dbWithdrawalActor = {
      userId: null,
      activity: {
        actorType: "agent" as const,
        actorId: requesterAgentId,
        agentId: requesterAgentId,
      },
    };
  }, 120_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRevisionRequested() {
    const id = randomUUID();
    const decidedAt = new Date("2026-08-04T20:00:46.452Z");
    await db.insert(approvals).values({
      id,
      companyId,
      type: "request_board_approval",
      status: "revision_requested",
      payload: { title: "Sign the DCO under a distinct identity" },
      requestedByAgentId: null,
      decisionNote: BOARD_NOTE,
      decidedByUserId: "board-user",
      decidedAt,
    });
    return { id, decidedAt };
  }

  it("withdraws straight out of revision_requested, leaving the note byte-identical", async () => {
    const { id, decidedAt } = await seedRevisionRequested();

    const withdrawn = await approvalService(db).withdraw(
      id,
      "Superseded: the ruling landed on BLO-22323, so this ask is moot.",
      dbWithdrawalActor,
    );

    expect(withdrawn.status).toBe("withdrawn");
    // Byte-identical, and still attributed to the board actor that wrote it —
    // re-stamping `decidedByUserId` would leave the note readable but misattributed.
    expect(withdrawn.decisionNote).toBe(BOARD_NOTE);
    expect(withdrawn.decidedByUserId).toBe("board-user");
    expect(withdrawn.decidedAt?.toISOString()).toBe(decidedAt.toISOString());

    const [persisted] = await db.select().from(approvals).where(eq(approvals.id, id));
    expect(persisted.decisionNote).toBe(BOARD_NOTE);

    // The withdrawal reason is not lost either — it goes where it cannot overwrite
    // anything, which is the point of the split.
    const comments = await db
      .select()
      .from(approvalComments)
      .where(eq(approvalComments.approvalId, id));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Superseded: the ruling landed on BLO-22323");
    expect(comments[0].body).toContain("revision_requested");
  });

  it("archives the note as a comment before resubmit clears the decision fields", async () => {
    const { id } = await seedRevisionRequested();

    const resubmitted = await approvalService(db).resubmit(id);

    // Clearing is correct for a card that is genuinely undecided again; losing the
    // reasoning is not. This is the exact operation that silently destroyed the
    // note on approval f946c9b3.
    expect(resubmitted.status).toBe("pending");
    expect(resubmitted.decisionNote).toBeNull();

    const comments = await db
      .select()
      .from(approvalComments)
      .where(eq(approvalComments.approvalId, id));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(BOARD_NOTE);
    expect(comments[0].authorUserId).toBe("board-user");
  });

  it("still records the reason in the note when the board never wrote one", async () => {
    const id = randomUUID();
    await db.insert(approvals).values({
      id,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { title: "Ordinary pending ask" },
    });

    const withdrawn = await approvalService(db).withdraw(id, "no longer needed", dbWithdrawalActor);

    // Unchanged pre-existing behaviour: with nothing to protect, the reason keeps
    // its home in `decisionNote` and no comment is manufactured.
    expect(withdrawn.decisionNote).toBe("no longer needed");
    const comments = await db
      .select()
      .from(approvalComments)
      .where(eq(approvalComments.approvalId, id));
    expect(comments).toHaveLength(0);
  });

  it("refuses to withdraw an already-decided approval", async () => {
    const id = randomUUID();
    await db.insert(approvals).values({
      id,
      companyId,
      type: "request_board_approval",
      status: "rejected",
      payload: { title: "Already decided" },
      decisionNote: BOARD_NOTE,
    });

    await expect(
      approvalService(db).withdraw(id, "too late", dbWithdrawalActor),
    ).rejects.toMatchObject({ status: 409 });

    const [persisted] = await db.select().from(approvals).where(eq(approvals.id, id));
    expect(persisted.status).toBe("rejected");
    expect(persisted.decisionNote).toBe(BOARD_NOTE);
  });
});

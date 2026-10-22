import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, approvals, companies, createDb } from "@paperclipai/db";
import { APPROVAL_TYPES } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  __resetMetricsForTest,
  APPROVAL_LAST_DECISION_TIMESTAMP_METRIC,
  APPROVAL_OLDEST_PENDING_AGE_METRIC,
  APPROVAL_QUEUE_METRICS_REFRESH_SUCCESS_METRIC,
  APPROVALS_PENDING_METRIC,
  renderMetrics,
} from "../services/metrics.js";
import { refreshApprovalQueueMetrics } from "../services/approval-queue-metrics.js";
import { approvalService } from "../services/approvals.js";
import { resolveApprovalWithSideEffects } from "../services/approval-resolution.js";

/**
 * Value of the one series of `name` whose labels include `labels`, or null when
 * absent. Label order in the exposition is not part of the contract.
 */
function series(body: string, name: string, labels: Record<string, string>): number | null {
  const hits = body
    .split("\n")
    .filter((line) => line.startsWith(`${name}{`))
    .filter((line) => Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`)));
  if (hits.length > 1) throw new Error(`ambiguous ${name} ${JSON.stringify(labels)}: ${hits.join(" | ")}`);
  return hits.length ? Number(hits[0]!.split(" ").pop()) : null;
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("refreshApprovalQueueMetrics (BLO-29850)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-queue-metrics-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE activity_log, approvals, agents, companies CASCADE`);
    __resetMetricsForTest();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const NOW = new Date("2026-08-23T01:57:00.000Z");
  const board = { requester: "board" } as const;
  const agent = { requester: "agent" } as const;

  async function insertCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Approval Queue Co",
      issuePrefix: `AQC${companyId.slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function insertAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Requester",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
    });
    return agentId;
  }

  async function insertApproval(input: {
    companyId: string;
    status: string;
    type?: string;
    createdAt: Date;
    decidedAt?: Date | null;
    requestedByAgentId?: string;
  }) {
    await db.insert(approvals).values({
      companyId: input.companyId,
      requestedByAgentId: input.requestedByAgentId ?? null,
      type: input.type ?? "request_board_approval",
      status: input.status,
      payload: {},
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      decidedAt: input.decidedAt ?? null,
    });
  }

  it("counts pending by type and ages the oldest off createdAt", async () => {
    const companyId = await insertCompany();
    await insertApproval({
      companyId,
      status: "pending",
      type: "request_board_approval",
      createdAt: new Date(NOW.getTime() - 600_000),
    });
    await insertApproval({
      companyId,
      status: "pending",
      type: "request_board_approval",
      createdAt: new Date(NOW.getTime() - 60_000),
    });
    await insertApproval({
      companyId,
      status: "pending",
      type: "hire_agent",
      createdAt: new Date(NOW.getTime() - 120_000),
    });

    await refreshApprovalQueueMetrics(db, NOW);
    const { body } = await renderMetrics();

    expect(series(body, APPROVALS_PENDING_METRIC, { ...board, type: "request_board_approval" })).toBe(2);
    expect(series(body, APPROVALS_PENDING_METRIC, { ...board, type: "hire_agent" })).toBe(1);
    // Oldest of the two, not the newest and not their sum.
    expect(series(body, APPROVAL_OLDEST_PENDING_AGE_METRIC, { ...board, type: "request_board_approval" })).toBe(600);
    expect(body).toContain(`${APPROVAL_QUEUE_METRICS_REFRESH_SUCCESS_METRIC} 1`);
  });

  // THE LOAD-BEARING CASE. This is the defect the issue was filed on: the 8 most
  // recent transitions before filing were all `withdrawn` -- agents retiring their
  // own moot cards -- which a depth-only metric scores as the board serving the
  // queue. If a withdrawal advances the last-decision timestamp, the staleness
  // alert silently resets itself every time the backlog self-cleans, and the
  // stopped queue is never detected. Deleting the BOARD_DECISION_STATUSES filter
  // must turn this test red.
  it("does NOT advance the last-decision timestamp on withdrawn or cancelled cards", async () => {
    const companyId = await insertCompany();
    const boardDecidedAt = new Date("2026-08-19T20:52:50.000Z");
    const withdrawnAt = new Date("2026-08-22T23:00:00.000Z");

    await insertApproval({
      companyId,
      status: "approved",
      createdAt: new Date(boardDecidedAt.getTime() - 3_600_000),
      decidedAt: boardDecidedAt,
    });
    // Agent-side cleanup, much more recent than the real board decision.
    await insertApproval({
      companyId,
      status: "withdrawn",
      createdAt: new Date(withdrawnAt.getTime() - 3_600_000),
      decidedAt: withdrawnAt,
    });
    await insertApproval({
      companyId,
      status: "cancelled",
      createdAt: new Date(withdrawnAt.getTime() - 3_600_000),
      decidedAt: withdrawnAt,
    });
    await insertApproval({
      companyId,
      status: "pending",
      createdAt: new Date(NOW.getTime() - 86_400_000),
    });

    await refreshApprovalQueueMetrics(db, NOW);
    const { body } = await renderMetrics();

    expect(series(body, APPROVAL_LAST_DECISION_TIMESTAMP_METRIC, board)).toBe(boardDecidedAt.getTime() / 1000);
    // Backtest assertion from the issue's acceptance criteria: against this
    // recorded history the alert's staleness expression is far past its 6h
    // threshold while pending > 0, i.e. it would have paged at 2026-08-20T02:52Z.
    const stalenessSeconds = NOW.getTime() / 1000 - boardDecidedAt.getTime() / 1000;
    expect(stalenessSeconds).toBeGreaterThan(21_600);
    expect(series(body, APPROVALS_PENDING_METRIC, { ...board, type: "request_board_approval" })).toBe(1);
  });

  it("treats revision_requested as a board decision but not as pending", async () => {
    const companyId = await insertCompany();
    const decidedAt = new Date("2026-08-22T12:00:00.000Z");
    await insertApproval({
      companyId,
      status: "revision_requested",
      createdAt: new Date(decidedAt.getTime() - 3_600_000),
      decidedAt,
    });

    await refreshApprovalQueueMetrics(db, NOW);
    const { body } = await renderMetrics();

    expect(series(body, APPROVAL_LAST_DECISION_TIMESTAMP_METRIC, board)).toBe(decidedAt.getTime() / 1000);
    // The card is back in the requester's court, so it must not hold the
    // board-unresponsiveness alert's pending>0 gate open.
    expect(series(body, APPROVALS_PENDING_METRIC, { ...board, type: "request_board_approval" })).toBe(0);
  });

  it("resets a drained type to an explicit 0 rather than leaving a stale series", async () => {
    const companyId = await insertCompany();
    await insertApproval({
      companyId,
      status: "pending",
      createdAt: new Date(NOW.getTime() - 600_000),
    });
    await refreshApprovalQueueMetrics(db, NOW);
    expect(
      series((await renderMetrics()).body, APPROVALS_PENDING_METRIC, { ...board, type: "request_board_approval" }),
    ).toBe(1);

    await db.execute(sql`UPDATE approvals SET status = 'approved', decided_at = now()`);
    await refreshApprovalQueueMetrics(db, NOW);
    const { body } = await renderMetrics();

    // An absent series is what "never exported" looks like, so drained must be a
    // real 0 -- for the drained type and for every type the queue could hold.
    for (const type of APPROVAL_TYPES) {
      expect(series(body, APPROVALS_PENDING_METRIC, { ...board, type })).toBe(0);
    }
    // No pending card means no oldest card: absent, not a misleading 0.
    expect(body).not.toContain(`${APPROVAL_OLDEST_PENDING_AGE_METRIC}{`);
  });

  // A board `revision_requested` is a real board decision, but the requester's
  // cleanup erases it from the approval row: `withdraw` moves it to `withdrawn`
  // (and, with no board note, overwrites `decided_at`), `resubmit` nulls
  // `decided_at`. Each exit runs through the real service, so this pins that the
  // decision survives on the path that actually records it.
  it.each([
    ["withdrawn with the board note preserved", "Needs a rollback plan.", "withdraw"],
    ["withdrawn when the board left no note", null, "withdraw"],
    ["resubmitted back to pending", "Needs a rollback plan.", "resubmit"],
  ] as const)(
    "keeps a revision request as the last board decision after it is %s",
    async (_label, decisionNote, exit) => {
      const companyId = await insertCompany();
      // An older real decision: the value a row-only MAX falls back to.
      const olderDecisionAt = new Date("2026-08-19T20:52:50.000Z");
      await insertApproval({
        companyId,
        status: "approved",
        createdAt: new Date(olderDecisionAt.getTime() - 3_600_000),
        decidedAt: olderDecisionAt,
      });
      const [card] = await db
        .insert(approvals)
        .values({ companyId, type: "request_board_approval", status: "pending", payload: {} })
        .returning();

      await resolveApprovalWithSideEffects(db, {}, {
        approvalId: card!.id,
        decision: "revise",
        decidedByUserId: "board-user",
        decisionNote,
        actor: {
          activityActorType: "user",
          activityActorId: "board-user",
          requesterWakeActorType: "user",
          requesterWakeActorId: "board-user",
        },
      });
      const [revisionEvent] = await db
        .select({ createdAt: activityLog.createdAt })
        .from(activityLog)
        .where(and(eq(activityLog.entityId, card!.id), eq(activityLog.action, "approval.revision_requested")));
      expect(revisionEvent).toBeDefined();

      const svc = approvalService(db);
      if (exit === "withdraw") {
        await svc.withdraw(card!.id, "superseded", {
          userId: null,
          activity: { actorType: "agent", actorId: "requester-1", agentId: null },
        });
      } else {
        await svc.resubmit(card!.id);
      }

      await refreshApprovalQueueMetrics(db, NOW);
      const { body } = await renderMetrics();

      expect(series(body, APPROVAL_LAST_DECISION_TIMESTAMP_METRIC, board)).toBe(
        revisionEvent!.createdAt.getTime() / 1000,
      );
    },
  );

  // BLO-48410 / PEN-3652: the rules join on(company_id), so each company's
  // channel must carry its own decision clock. A board decision in one company,
  // or a board-filed decision in the same company, must never read as the
  // agent channel being served.
  it("splits last decision and pending by company and by requester", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    const agentA = await insertAgent(companyA);
    const agentB = await insertAgent(companyB);
    const agentDecidedA = new Date("2026-08-19T20:52:50.000Z");
    const boardDecidedA = new Date("2026-08-22T10:00:00.000Z");
    const boardDecidedB = new Date("2026-08-22T20:00:00.000Z");

    await insertApproval({
      companyId: companyA,
      requestedByAgentId: agentA,
      status: "approved",
      createdAt: new Date(agentDecidedA.getTime() - 3_600_000),
      decidedAt: agentDecidedA,
    });
    await insertApproval({
      companyId: companyA,
      status: "rejected",
      createdAt: new Date(boardDecidedA.getTime() - 3_600_000),
      decidedAt: boardDecidedA,
    });
    await insertApproval({
      companyId: companyA,
      requestedByAgentId: agentA,
      status: "pending",
      createdAt: new Date(NOW.getTime() - 600_000),
    });
    await insertApproval({
      companyId: companyB,
      status: "approved",
      createdAt: new Date(boardDecidedB.getTime() - 3_600_000),
      decidedAt: boardDecidedB,
    });
    await insertApproval({
      companyId: companyB,
      requestedByAgentId: agentB,
      status: "pending",
      type: "hire_agent",
      createdAt: new Date(NOW.getTime() - 120_000),
    });

    await refreshApprovalQueueMetrics(db, NOW);
    const { body } = await renderMetrics();
    const last = (companyId: string, requester: typeof agent | typeof board) =>
      series(body, APPROVAL_LAST_DECISION_TIMESTAMP_METRIC, { company_id: companyId, ...requester });

    expect(last(companyA, agent)).toBe(agentDecidedA.getTime() / 1000);
    expect(last(companyA, board)).toBe(boardDecidedA.getTime() / 1000);
    expect(last(companyB, board)).toBe(boardDecidedB.getTime() / 1000);
    // THE RULE CONTRACT: agent-filed history but never an agent decision is a
    // series at 0 (maximally stale), not an absent one that drops out of `and`.
    expect(last(companyB, agent)).toBe(0);
    // No unlabelled series left over from the old seed.
    expect(body).not.toMatch(new RegExp(`^${APPROVAL_LAST_DECISION_TIMESTAMP_METRIC} `, "m"));

    const pending = (companyId: string, requester: typeof agent | typeof board, type: string) =>
      series(body, APPROVALS_PENDING_METRIC, { company_id: companyId, ...requester, type });
    expect(pending(companyA, agent, "request_board_approval")).toBe(1);
    expect(pending(companyA, board, "request_board_approval")).toBe(0);
    expect(pending(companyB, agent, "hire_agent")).toBe(1);
    expect(pending(companyB, agent, "request_board_approval")).toBe(0);
    expect(
      series(body, APPROVAL_OLDEST_PENDING_AGE_METRIC, { company_id: companyB, ...agent, type: "hire_agent" }),
    ).toBe(120);
  });

  it("keeps an agent card's revision request on its own company/requester after resubmit", async () => {
    const companyA = await insertCompany();
    const companyB = await insertCompany();
    const agentA = await insertAgent(companyA);
    const revisionAt = new Date("2026-08-21T09:00:00.000Z");
    const [card] = await db
      .insert(approvals)
      .values({
        companyId: companyA,
        requestedByAgentId: agentA,
        type: "request_board_approval",
        status: "revision_requested",
        payload: {},
        createdAt: new Date(revisionAt.getTime() - 3_600_000),
        decidedAt: revisionAt,
      })
      .returning();
    await db.insert(activityLog).values({
      companyId: companyA,
      actorType: "user",
      actorId: "board-user",
      action: "approval.revision_requested",
      entityType: "approval",
      entityId: card!.id,
      createdAt: revisionAt,
    });
    // A later board decision elsewhere must not leak into company A's agent clock.
    await insertApproval({
      companyId: companyB,
      status: "approved",
      createdAt: new Date(NOW.getTime() - 7_200_000),
      decidedAt: new Date(NOW.getTime() - 3_600_000),
    });

    await approvalService(db).resubmit(card!.id);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, card!.id));
    expect(row!.status).toBe("pending");
    expect(row!.decidedAt).toBeNull();

    await refreshApprovalQueueMetrics(db, NOW);
    const { body } = await renderMetrics();

    expect(
      series(body, APPROVAL_LAST_DECISION_TIMESTAMP_METRIC, { company_id: companyA, ...agent }),
    ).toBe(revisionAt.getTime() / 1000);
    expect(series(body, APPROVAL_LAST_DECISION_TIMESTAMP_METRIC, { company_id: companyA, ...board })).toBeNull();
    expect(series(body, APPROVAL_LAST_DECISION_TIMESTAMP_METRIC, { company_id: companyB, ...agent })).toBeNull();
  });

  // Silence is not health: a failed refresh must not publish a healthy-looking
  // empty queue. The gauges keep their last real values and the freshness gate
  // goes to 0, which is what makes the stale sample ineligible for the alert.
  it("flags the refresh as failed without zeroing the last good sample", async () => {
    const companyId = await insertCompany();
    await insertApproval({
      companyId,
      status: "pending",
      createdAt: new Date(NOW.getTime() - 600_000),
    });
    await refreshApprovalQueueMetrics(db, NOW);

    const brokenDb = {
      select: () => {
        throw new Error("connection terminated");
      },
    } as unknown as ReturnType<typeof createDb>;

    await expect(refreshApprovalQueueMetrics(brokenDb, NOW)).rejects.toThrow(
      "connection terminated",
    );
    const { body } = await renderMetrics();

    expect(body).toContain(`${APPROVAL_QUEUE_METRICS_REFRESH_SUCCESS_METRIC} 0`);
    expect(series(body, APPROVALS_PENDING_METRIC, { ...board, type: "request_board_approval" })).toBe(1);
    expect(series(body, APPROVAL_OLDEST_PENDING_AGE_METRIC, { ...board, type: "request_board_approval" })).toBe(600);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { approvals, companies, createDb } from "@paperclipai/db";
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
    await db.execute(sql`TRUNCATE TABLE approvals, companies CASCADE`);
    __resetMetricsForTest();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const NOW = new Date("2026-08-23T01:57:00.000Z");

  async function insertCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Approval Queue Co",
      issuePrefix: "AQC",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function insertApproval(input: {
    companyId: string;
    status: string;
    type?: string;
    createdAt: Date;
    decidedAt?: Date | null;
  }) {
    await db.insert(approvals).values({
      companyId: input.companyId,
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

    expect(body).toContain(`${APPROVALS_PENDING_METRIC}{type="request_board_approval"} 2`);
    expect(body).toContain(`${APPROVALS_PENDING_METRIC}{type="hire_agent"} 1`);
    // Oldest of the two, not the newest and not their sum.
    expect(body).toContain(
      `${APPROVAL_OLDEST_PENDING_AGE_METRIC}{type="request_board_approval"} 600`,
    );
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

    expect(body).toContain(
      `${APPROVAL_LAST_DECISION_TIMESTAMP_METRIC} ${boardDecidedAt.getTime() / 1000}`,
    );
    // Backtest assertion from the issue's acceptance criteria: against this
    // recorded history the alert's staleness expression is far past its 6h
    // threshold while pending > 0, i.e. it would have paged at 2026-08-20T02:52Z.
    const stalenessSeconds = NOW.getTime() / 1000 - boardDecidedAt.getTime() / 1000;
    expect(stalenessSeconds).toBeGreaterThan(21_600);
    expect(body).toContain(`${APPROVALS_PENDING_METRIC}{type="request_board_approval"} 1`);
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

    expect(body).toContain(`${APPROVAL_LAST_DECISION_TIMESTAMP_METRIC} ${decidedAt.getTime() / 1000}`);
    // The card is back in the requester's court, so it must not hold the
    // board-unresponsiveness alert's pending>0 gate open.
    expect(body).not.toContain(`${APPROVALS_PENDING_METRIC}{type="request_board_approval"}`);
  });

  it("resets a drained type to an explicit 0 rather than leaving a stale series", async () => {
    const companyId = await insertCompany();
    await insertApproval({
      companyId,
      status: "pending",
      createdAt: new Date(NOW.getTime() - 600_000),
    });
    await refreshApprovalQueueMetrics(db, NOW);
    expect((await renderMetrics()).body).toContain(
      `${APPROVALS_PENDING_METRIC}{type="request_board_approval"} 1`,
    );

    await db.execute(sql`UPDATE approvals SET status = 'approved', decided_at = now()`);
    await refreshApprovalQueueMetrics(db, NOW);
    const { body } = await renderMetrics();

    expect(body).not.toContain(`${APPROVALS_PENDING_METRIC}{type="request_board_approval"} 1`);
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
    expect(body).toContain(`${APPROVALS_PENDING_METRIC}{type="request_board_approval"} 1`);
    expect(body).toContain(
      `${APPROVAL_OLDEST_PENDING_AGE_METRIC}{type="request_board_approval"} 600`,
    );
  });
});

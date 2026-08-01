/**
 * BLO-20396: a large queued backlog must converge deterministically.
 *
 * Before this fix, invalid queued rows (target issue already terminal,
 * duplicates of an issue already in flight) were pruned only *lazily* — a row
 * was cleaned up when the priority walk happened to reach it. Under backlog the
 * walk stopped as soon as the available slots were filled, so invalid rows
 * accumulated indefinitely: production showed 21 rows targeting `done`/
 * `cancelled` issues sitting queued for a single agent, the oldest for 20h.
 *
 * This fixture builds a backlog of 100+ mixed rows and asserts one dispatch
 * pass removes every invalid row, starts the valid work, and bounds the scan.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import { heartbeatService } from "../services/heartbeat.js";
import { runningProcesses } from "../adapters/index.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null as string | null,
    timedOut: false,
    errorMessage: null as string | null,
    resultJson: { exitCode: 0 },
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

vi.mock("../services/k8s-job-liveness.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/k8s-job-liveness.ts")>();
  return {
    ...actual,
    listLiveAgentJobRunIds: vi.fn(async () => null),
    listAgentJobRunStatuses: vi.fn(async () => null),
    listManagedAgentJobs: vi.fn(async () => null),
    readAgentJobRunStatusByName: vi.fn(async () => null),
    deleteAgentJobsForRun: vi.fn(async () => 1),
    deleteAgentJobExact: vi.fn(async () => "deleted" as const),
    hasActiveJobForAgent: vi.fn(async () => false),
  };
});

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping queued-backlog convergence tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("queued backlog convergence (BLO-20396)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const allowPenstockGate = {
    checkAdapter: async () => ({ allow: true as const }),
    _resetForTesting: () => {},
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-queued-backlog-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { penstockGate: allowPenstockGate });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    await cleanupHeartbeatTestState(db, heartbeat);
  });

  afterAll(async () => {
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  it("prunes every invalid queued row and starts valid work in one pass", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "BacklogAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });

    const baseTime = Date.now() - 6 * 60 * 60 * 1000;
    let issueNumber = 0;
    const issueRows: Array<typeof issues.$inferInsert> = [];
    const wakeRows: Array<typeof agentWakeupRequests.$inferInsert> = [];
    const runRows: Array<typeof heartbeatRuns.$inferInsert> = [];

    const addIssue = (status: string, priority = "medium") => {
      issueNumber += 1;
      const id = randomUUID();
      issueRows.push({
        id,
        companyId,
        title: `Issue ${issueNumber} (${status})`,
        status,
        priority,
        assigneeAgentId: agentId,
        issueNumber,
        identifier: `${issuePrefix}-${issueNumber}`,
        ...(status === "in_progress" ? { startedAt: new Date() } : {}),
      });
      return id;
    };

    const addQueuedRun = (issueId: string | null, ageMs: number) => {
      const runId = randomUUID();
      const wakeId = randomUUID();
      const at = new Date(baseTime + ageMs);
      wakeRows.push({
        id: wakeId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: issueId ? { issueId } : {},
        status: "queued",
        runId,
        requestedAt: at,
        updatedAt: at,
      });
      runRows.push({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wakeId,
        contextSnapshot: issueId
          ? { issueId, wakeReason: "issue_assigned" }
          : { wakeReason: "issue_assigned" },
        createdAt: at,
        updatedAt: at,
      });
      return runId;
    };

    // --- Invalid: 60 rows whose target issue is already terminal. These are
    // the OLDEST rows, i.e. exactly the ones that would be walked first, and
    // under the old lazy prune they would eat the whole pass.
    const terminalRunIds: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const issueId = addIssue(i % 2 === 0 ? "done" : "cancelled");
      terminalRunIds.push(addQueuedRun(issueId, i * 1000));
    }

    // --- Invalid: 30 duplicate rows for a single issue. At most one may be
    // claimed; the rest must be cancelled as duplicate dispatches.
    const duplicateIssueId = addIssue("in_progress", "high");
    const duplicateRunIds: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      duplicateRunIds.push(addQueuedRun(duplicateIssueId, 100_000 + i * 1000));
    }

    // --- Exempt: a terminal-issue row carrying a wake comment id. The
    // claim-time gate deliberately does NOT treat these as stale, so the eager
    // prune must not cancel them either.
    const exemptIssueId = addIssue("done");
    const exemptRunId = randomUUID();
    const exemptWakeId = randomUUID();
    const exemptAt = new Date(baseTime + 150_000);
    wakeRows.push({
      id: exemptWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId: exemptIssueId },
      status: "queued",
      runId: exemptRunId,
      requestedAt: exemptAt,
      updatedAt: exemptAt,
    });
    runRows.push({
      id: exemptRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: exemptWakeId,
      contextSnapshot: {
        issueId: exemptIssueId,
        wakeReason: "issue_comment_mentioned",
        commentId: randomUUID(),
      },
      createdAt: exemptAt,
      updatedAt: exemptAt,
    });

    // --- Valid: 12 distinct live issues that should be eligible to run.
    const validRunIds: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const issueId = addIssue("todo", "high");
      validRunIds.push(addQueuedRun(issueId, 200_000 + i * 1000));
    }

    const totalQueued = terminalRunIds.length + duplicateRunIds.length + validRunIds.length;
    expect(totalQueued).toBeGreaterThanOrEqual(100);

    await db.insert(issues).values(issueRows);
    await db.insert(agentWakeupRequests).values(wakeRows);
    await db.insert(heartbeatRuns).values(runRows);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainInFlightExecutions(30_000);

    // Every terminal-issue row is cancelled with the dedicated code, in ONE pass.
    const terminalAfter = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, terminalRunIds));
    expect(terminalAfter).toHaveLength(60);
    for (const row of terminalAfter) {
      expect(row.status).toBe("cancelled");
      // Reuses the established claim-time gate rather than a parallel rule, so
      // both `done` and `cancelled` report issue_terminal_status — and the
      // gate's exemptions (resumeIntent / wakeCommentId) still apply.
      expect(row.errorCode).toBe("issue_terminal_status");
    }

    // No row targeting a terminal issue is left queued.
    const stillQueuedTerminal = terminalAfter.filter((row) => row.status === "queued");
    expect(stillQueuedTerminal).toHaveLength(0);

    // The duplicate fan-out collapses: at most one of the 30 ever ran.
    const duplicatesAfter = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, duplicateRunIds));
    const duplicatesStillQueued = duplicatesAfter.filter((row) => row.status === "queued");
    expect(duplicatesStillQueued.length).toBeLessThanOrEqual(1);

    // Valid work actually started rather than starving behind the invalid rows.
    const validAfter = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, validRunIds));
    const validStarted = validAfter.filter((row) => row.status !== "queued");
    expect(validStarted.length).toBeGreaterThan(0);

    // The exempt row was NOT cancelled by the eager prune: the claim-time gate
    // spares terminal-issue wakes that carry a comment id, and making the gate
    // eager must not change that.
    const [exemptAfter] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, exemptRunId));
    expect(exemptAfter.errorCode).not.toBe("issue_terminal_status");
  }, 120_000);

  it("reaches runnable work sitting behind a full batch of unclaimable rows", async () => {
    // BLO-20396 (review follow-up). Bounding the scan to a fixed prefix traded
    // one liveness bug for another: if the oldest QUEUED_RUN_DISPATCH_SCAN_LIMIT
    // rows are all unclaimable, every pass ranks the same dead prefix and claims
    // nothing — and because nothing started, nothing will complete to trigger
    // another pass. Runnable work behind the prefix starves forever.
    //
    // Dependency-blocked rows are the sharpest form: unlike terminal-issue rows
    // they are perfectly valid and must NOT be cancelled, so they cannot be
    // pruned out of the way. The dispatcher has to page past them.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "PagingCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "PagingAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });

    const baseTime = Date.now() - 6 * 60 * 60 * 1000;
    let issueNumber = 0;
    const issueRows: Array<typeof issues.$inferInsert> = [];
    const wakeRows: Array<typeof agentWakeupRequests.$inferInsert> = [];
    const runRows: Array<typeof heartbeatRuns.$inferInsert> = [];

    const addIssue = (status: string, priority = "medium") => {
      issueNumber += 1;
      const id = randomUUID();
      issueRows.push({
        id,
        companyId,
        title: `Issue ${issueNumber} (${status})`,
        status,
        priority,
        assigneeAgentId: agentId,
        issueNumber,
        identifier: `${issuePrefix}-${issueNumber}`,
      });
      return id;
    };

    const addQueuedRun = (issueId: string, ageMs: number) => {
      const runId = randomUUID();
      const wakeId = randomUUID();
      const at = new Date(baseTime + ageMs);
      wakeRows.push({
        id: wakeId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        status: "queued",
        runId,
        requestedAt: at,
        updatedAt: at,
      });
      runRows.push({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wakeId,
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        createdAt: at,
        updatedAt: at,
      });
      return runId;
    };

    // One never-done blocker holds every dependent issue below unresolved.
    const blockerIssueId = addIssue("in_progress", "high");

    // --- 210 dependency-blocked rows, older than everything else and more than
    // one full scan batch. These are the sharpest form of an unclaimable
    // prefix: they are perfectly valid work that simply cannot run yet
    // (claimQueuedRun re-checks readiness and refuses them), so — unlike
    // terminal-issue rows — there is nothing to prune and no cleanup pass will
    // ever clear them out of the way. Under a single fixed-size prefix the
    // dispatcher ranks these same 200 rows every pass, claims nothing, and so
    // never completes a run that would trigger another pass. Only paging gets
    // past them.
    const relationRows: Array<typeof issueRelations.$inferInsert> = [];
    const blockedRunIds: string[] = [];
    for (let i = 0; i < 210; i += 1) {
      const dependentIssueId = addIssue("todo", "critical");
      relationRows.push({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: dependentIssueId,
        type: "blocks",
      });
      blockedRunIds.push(addQueuedRun(dependentIssueId, i * 1000));
    }
    expect(blockedRunIds.length).toBeGreaterThan(200);

    // --- The one runnable row, newest of all: unreachable under a single
    // fixed-size prefix, and the whole point of paging.
    const runnableIssueId = addIssue("todo", "high");
    const runnableRunId = addQueuedRun(runnableIssueId, 500_000);

    await db.insert(issues).values(issueRows);
    await db.insert(issueRelations).values(relationRows);
    await db.insert(agentWakeupRequests).values(wakeRows);
    await db.insert(heartbeatRuns).values(runRows);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainInFlightExecutions(30_000);

    // The runnable row was reached and started.
    const [runnableAfter] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runnableRunId));
    expect(runnableAfter.status).not.toBe("queued");

    // Blocked rows are resolved rather than left to rot: the claim gate
    // cancels them with `issue_dependencies_blocked`, which is what releases
    // each issue's execution lock and marks its wakeup skipped. Paperclip
    // re-wakes the assignee when the blockers resolve (see #419).
    const blockedAfter = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, blockedRunIds));
    expect(blockedAfter).toHaveLength(210);
    expect(blockedAfter.every((row) => row.status === "cancelled")).toBe(true);
    expect(
      blockedAfter.every((row) => row.errorCode === "issue_dependencies_blocked"),
    ).toBe(true);
  }, 180_000);

  it("resumes past the hard scan ceiling to reach runnable work behind it", async () => {
    // BLO-20396 (second review follow-up). Paging fixed the fixed-prefix
    // starvation at 200 rows but reintroduced it at the hard ceiling: a pass
    // stops after QUEUED_RUN_DISPATCH_MAX_SCAN_BATCHES batches, and if every
    // one of those 2,000 rows is dependency-blocked it prunes nothing, claims
    // nothing, and schedules nothing — so the next pass rescans the identical
    // prefix forever. The previous test's 210 blocked rows sit *below* the
    // ceiling and so could not catch this; this fixture puts the runnable row
    // past it.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "CeilingCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CeilingAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });

    const baseTime = Date.now() - 12 * 60 * 60 * 1000;
    let issueNumber = 0;
    const issueRows: Array<typeof issues.$inferInsert> = [];
    const wakeRows: Array<typeof agentWakeupRequests.$inferInsert> = [];
    const runRows: Array<typeof heartbeatRuns.$inferInsert> = [];

    const addIssue = (status: string, priority = "medium") => {
      issueNumber += 1;
      const id = randomUUID();
      issueRows.push({
        id,
        companyId,
        title: `Issue ${issueNumber} (${status})`,
        status,
        priority,
        assigneeAgentId: agentId,
        issueNumber,
        identifier: `${issuePrefix}-${issueNumber}`,
      });
      return id;
    };

    const addQueuedRun = (issueId: string, ageMs: number) => {
      const runId = randomUUID();
      const wakeId = randomUUID();
      const at = new Date(baseTime + ageMs);
      wakeRows.push({
        id: wakeId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        status: "queued",
        runId,
        requestedAt: at,
        updatedAt: at,
      });
      runRows.push({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wakeId,
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        createdAt: at,
        updatedAt: at,
      });
      return runId;
    };

    const blockerIssueId = addIssue("in_progress", "high");

    // QUEUED_RUN_DISPATCH_SCAN_LIMIT (200) * QUEUED_RUN_DISPATCH_MAX_SCAN_BATCHES
    // (10) = 2,000 rows is everything one pass may read. Go past it.
    const blockedRunIds: string[] = [];
    const relationRows: Array<typeof issueRelations.$inferInsert> = [];
    for (let i = 0; i < 2_010; i += 1) {
      const dependentIssueId = addIssue("todo", "critical");
      relationRows.push({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: dependentIssueId,
        type: "blocks",
      });
      blockedRunIds.push(addQueuedRun(dependentIssueId, i * 1000));
    }
    expect(blockedRunIds.length).toBeGreaterThan(2_000);

    // The one runnable row, newest of all and beyond the ceiling.
    const runnableIssueId = addIssue("todo", "high");
    const runnableRunId = addQueuedRun(runnableIssueId, 5_000_000);

    // Chunk the inserts: a single statement for thousands of rows would blow
    // past Postgres' 65,535 bind-parameter limit.
    const insertChunked = async <T>(
      rows: T[],
      insert: (chunk: T[]) => Promise<unknown>,
    ) => {
      for (let i = 0; i < rows.length; i += 500) {
        await insert(rows.slice(i, i + 500));
      }
    };
    await insertChunked(issueRows, (chunk) => db.insert(issues).values(chunk));
    await insertChunked(relationRows, (chunk) => db.insert(issueRelations).values(chunk));
    await insertChunked(wakeRows, (chunk) => db.insert(agentWakeupRequests).values(chunk));
    await insertChunked(runRows, (chunk) => db.insert(heartbeatRuns).values(chunk));

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainInFlightExecutions(120_000);

    // Reached via the resumed continuation, not by one pass scanning forever.
    const [runnableAfter] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runnableRunId));
    expect(runnableAfter.status).not.toBe("queued");

    // Blocked rows past the ceiling are resolved too, once a resumed pass
    // reaches them — not silently abandoned beyond the scan bound.
    const blockedStillQueued = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, blockedRunIds.slice(0, 500)));
    expect(blockedStillQueued.every((row) => row.status === "cancelled")).toBe(true);
  }, 600_000);

  it("dispatches a newer critical run ahead of an older low-priority prefix", async () => {
    // BLO-20396 (second review follow-up). Collection walks the queue
    // oldest-first, so capping the candidate pool at the first N runnable rows
    // silently scoped priority to that prefix: a fresh `critical` row sitting
    // behind N older `low` rows was never even ranked. That contradicts the
    // dispatch formula, which deliberately ranks fresh critical (0-1) ahead of
    // aged non-critical (2). Ranking now covers the whole scanned window.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "RankCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RankAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      // One slot: exactly one row is claimed, so the assertion is about which
      // row the ranking picked rather than about how many started.
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const baseTime = Date.now() - 6 * 60 * 60 * 1000;
    let issueNumber = 0;
    const issueRows: Array<typeof issues.$inferInsert> = [];
    const wakeRows: Array<typeof agentWakeupRequests.$inferInsert> = [];
    const runRows: Array<typeof heartbeatRuns.$inferInsert> = [];

    const addIssue = (status: string, priority: string) => {
      issueNumber += 1;
      const id = randomUUID();
      issueRows.push({
        id,
        companyId,
        title: `Issue ${issueNumber} (${priority})`,
        status,
        priority,
        assigneeAgentId: agentId,
        issueNumber,
        identifier: `${issuePrefix}-${issueNumber}`,
      });
      return id;
    };

    const addQueuedRun = (issueId: string, ageMs: number) => {
      const runId = randomUUID();
      const wakeId = randomUUID();
      const at = new Date(baseTime + ageMs);
      wakeRows.push({
        id: wakeId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        status: "queued",
        runId,
        requestedAt: at,
        updatedAt: at,
      });
      runRows.push({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wakeId,
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        createdAt: at,
        updatedAt: at,
      });
      return runId;
    };

    // 210 older, runnable, low-priority rows — past the 200-candidate cap the
    // collection loop used to stop at.
    const lowPriorityRunIds: string[] = [];
    for (let i = 0; i < 210; i += 1) {
      lowPriorityRunIds.push(addQueuedRun(addIssue("todo", "low"), i * 1000));
    }
    expect(lowPriorityRunIds.length).toBeGreaterThan(200);

    // The newest row, and the only critical one.
    const criticalRunId = addQueuedRun(addIssue("todo", "critical"), 500_000);

    await db.insert(issues).values(issueRows);
    await db.insert(agentWakeupRequests).values(wakeRows);
    await db.insert(heartbeatRuns).values(runRows);

    // Hold the first claimed run open so the agent's single slot stays busy.
    // Without this the assertion is toothless: every run completes instantly,
    // each completion re-dispatches, and after ~11 of them the queue is short
    // enough that the critical row falls inside the prefix and starts anyway.
    // "Eventually dispatched" was true even with the bug — the regression is
    // *when*, so the test has to pin the very first claim.
    let releaseFirstRun!: () => void;
    const firstRunGate = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await firstRunGate;
      return {
        exitCode: 0,
        signal: null as string | null,
        timedOut: false,
        errorMessage: null as string | null,
        resultJson: { exitCode: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    try {
      await heartbeat.resumeQueuedRuns();

      // Exactly one slot, so exactly one row may have left `queued` — and it
      // must be the critical one, not the oldest `low` row.
      const started = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), ne(heartbeatRuns.status, "queued")));
      expect(started.map((row) => row.id)).toEqual([criticalRunId]);
    } finally {
      releaseFirstRun();
      await heartbeat.drainInFlightExecutions(60_000);
    }
  }, 300_000);

  it("cancels a queued run for a terminal issue exactly once under concurrent cleanup", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CasAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Already done",
      status: "done",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const runId = randomUUID();
    const wakeId = randomUUID();
    const at = new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      runId,
      requestedAt: at,
      updatedAt: at,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: wakeId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      createdAt: at,
      updatedAt: at,
    });

    // Fire many overlapping dispatch passes at the same agent. The start lock
    // must serialize them, and the CAS cancel must yield exactly one
    // transition — not one per pass.
    await Promise.all(Array.from({ length: 8 }, () => heartbeat.resumeQueuedRuns()));
    await heartbeat.drainInFlightExecutions(30_000);

    const [row] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(row.status).toBe("cancelled");
    expect(row.errorCode).toBe("issue_terminal_status");

    // Exactly one lifecycle cancellation event was recorded for this run —
    // concurrent cleanup attempts must not each emit their own.
    const events = await db
      .select({ eventType: heartbeatRunEvents.eventType, message: heartbeatRunEvents.message })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    const cancellationEvents = events.filter(
      (event) => event.eventType === "lifecycle" && (event.message ?? "").includes("terminal status"),
    );
    expect(cancellationEvents).toHaveLength(1);
  }, 60_000);
});

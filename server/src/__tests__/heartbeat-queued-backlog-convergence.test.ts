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

    // 2,010 older, runnable, low-priority rows — past the 200-candidate cap
    // the collection loop used to stop at, and past the 2,000-row bounded scan
    // window. Priority must not be scoped to whichever old rows the bounded
    // scan happened to see first.
    const lowPriorityRunIds: string[] = [];
    for (let i = 0; i < 2_010; i += 1) {
      lowPriorityRunIds.push(addQueuedRun(addIssue("todo", "low"), i * 1000));
    }
    expect(lowPriorityRunIds.length).toBeGreaterThan(2_000);

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

  /**
   * Shared fixture for the two traversal regressions below.
   *
   * Both need a queue deeper than one pass may read (SCAN_LIMIT *
   * MAX_SCAN_BATCHES = 2,000 rows) whose rows are all *claimable*. The earlier
   * ceiling fixture made its deep prefix dependency-blocked, which is exactly
   * why it could not catch either bug: nothing was ever claimed, so the
   * claim-time cursor handling was never exercised.
   *
   * The head window is issue-less runs — the shape every GitHub PR-review wake
   * has, and the shape of the production backlog this ticket came from. It also
   * keeps the fixture cheap: no issue rows to seed and no dependency-readiness
   * resolution per batch.
   */
  async function seedDeepClaimableBacklog(options: {
    maxConcurrentRuns: number;
    issuelessRows: number;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "DeepCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "DeepAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: options.maxConcurrentRuns },
      },
      permissions: {},
    });

    // Every row is old enough to have passed the starvation escalation floor,
    // so ranking is decided by issue priority rather than by age.
    const baseTime = Date.now() - 12 * 60 * 60 * 1000;
    let issueNumber = 0;

    const addIssueBackedRun = async (priority: string, ageMs: number) => {
      issueNumber += 1;
      const issueId = randomUUID();
      const runId = randomUUID();
      const wakeId = randomUUID();
      const at = new Date(baseTime + ageMs);
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Issue ${issueNumber} (${priority})`,
        status: "todo",
        priority,
        assigneeAgentId: agentId,
        issueNumber,
        identifier: `${issuePrefix}-${issueNumber}`,
      });
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
      return runId;
    };

    const wakeRows: Array<typeof agentWakeupRequests.$inferInsert> = [];
    const runRows: Array<typeof heartbeatRuns.$inferInsert> = [];
    for (let i = 0; i < options.issuelessRows; i += 1) {
      const runId = randomUUID();
      const wakeId = randomUUID();
      const at = new Date(baseTime + i * 1000);
      wakeRows.push({
        id: wakeId,
        companyId,
        agentId,
        source: "timer",
        triggerDetail: "system",
        reason: "heartbeat_timer",
        payload: {},
        status: "queued",
        runId,
        requestedAt: at,
        updatedAt: at,
      });
      runRows.push({
        id: runId,
        companyId,
        agentId,
        invocationSource: "timer",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wakeId,
        contextSnapshot: { wakeReason: "heartbeat_timer" },
        createdAt: at,
        updatedAt: at,
      });
    }
    // Chunked: one statement for thousands of rows would blow past Postgres'
    // 65,535 bind-parameter limit.
    for (let i = 0; i < wakeRows.length; i += 500) {
      await db.insert(agentWakeupRequests).values(wakeRows.slice(i, i + 500));
    }
    for (let i = 0; i < runRows.length; i += 500) {
      await db.insert(heartbeatRuns).values(runRows.slice(i, i + 500));
    }

    return {
      companyId,
      agentId,
      /** Issue-less run ids, oldest first. Index is queue position. */
      issuelessRunIds: runRows.map((row) => row.id as string),
      addIssueBackedRun,
      /** Ages that sort after every issue-less row. */
      pastWindowAgeMs: (n: number) => options.issuelessRows * 1000 + n * 1000,
      /** An age that lands inside the head window, behind a boundary cursor. */
      insideWindowAgeMs: (n: number) => n * 1000 + 500,
    };
  }

  /** Hold every adapter execution open until the test releases it. */
  function gateAdapterExecutions() {
    const result = {
      exitCode: 0,
      signal: null as string | null,
      timedOut: false,
      errorMessage: null as string | null,
      resultJson: { exitCode: 0 },
      provider: "test",
      model: "test-model",
    };
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const releaseAll = () => {
      while (releases.length > 0) releases.shift()!();
    };
    mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
      started.push(args.runId);
      await new Promise<void>((resolve) => releases.push(resolve));
      return result;
    });
    return {
      started,
      releaseAll,
      /** Stop holding executions, so any straggler can finish and the suite can drain. */
      disarm: () => {
        mockAdapterExecute.mockImplementation(async () => result);
        releaseAll();
      },
      waitForStarted: async (count: number, timeoutMs = 60_000) => {
        const deadline = Date.now() + timeoutMs;
        while (started.length < count && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return started.length;
      },
    };
  }

  /** Cancel whatever is still queued so the backlog cannot keep draining. */
  async function stopBacklog(agentId: string) {
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled" })
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")));
  }

  it("ranks a critical row globally, not just within the bounded scan window", async () => {
    // BLO-20396 (fourth review follow-up). Priority must not be scoped to the
    // SCAN_LIMIT * MAX_SCAN_BATCHES rows one pass may read. Collection walks the
    // queue oldest-first, so a `critical` row sitting behind more than that many
    // CLAIMABLE rows was never even ranked against them, and under a replenished
    // backlog it could wait indefinitely.
    const { agentId, addIssueBackedRun, pastWindowAgeMs } = await seedDeepClaimableBacklog({
      maxConcurrentRuns: 1,
      issuelessRows: 2_000,
    });
    const adapter = gateAdapterExecutions();

    for (let i = 0; i < 5; i += 1) await addIssueBackedRun("low", pastWindowAgeMs(i));
    const criticalRunId = await addIssueBackedRun("critical", pastWindowAgeMs(5));

    await heartbeat.resumeQueuedRuns();
    expect(await adapter.waitForStarted(1)).toBe(1);
    expect(adapter.started[0]).toBe(criticalRunId);

    await stopBacklog(agentId);
    adapter.disarm();
    await heartbeat.drainInFlightExecutions(60_000);
  }, 600_000);

  it("resumes forward after a claim instead of restarting the scan at the head", async () => {
    // BLO-20396 (fourth review follow-up). A claim used to clear the resume
    // cursor, so the next pass restarted at the head and re-ranked the same
    // window. The queue then drained one slot at a time from the front and
    // never advanced, which is what kept work behind a deep backlog unreachable
    // even when priority was equal.
    //
    // Every row here is issue-less and equal-ranked: no priority lane, no
    // completion-triggered issue continuation. Position is the only variable,
    // so what the second pass claims says exactly where it started scanning.
    const { agentId, issuelessRunIds } = await seedDeepClaimableBacklog({
      maxConcurrentRuns: 1,
      issuelessRows: 4_100,
    });
    const adapter = gateAdapterExecutions();
    const windowRows = 2_000;

    // The first pass reads the first 2,000 rows and claims the oldest.
    await heartbeat.resumeQueuedRuns();
    expect(await adapter.waitForStarted(1)).toBe(1);
    expect(adapter.started[0]).toBe(issuelessRunIds[0]);

    // Free the slot. The next pass must continue from the scan boundary, so it
    // claims the oldest row PAST the window — not the head's second row.
    adapter.releaseAll();
    expect(await adapter.waitForStarted(2)).toBe(2);
    const claimedPosition = issuelessRunIds.indexOf(adapter.started[1]);
    expect(claimedPosition).toBeGreaterThanOrEqual(windowRows);

    await stopBacklog(agentId);
    adapter.disarm();
    await heartbeat.drainInFlightExecutions(60_000);
  }, 600_000);

  it("reaches a critical row behind the cursor while earlier claims are still executing", async () => {
    // BLO-20396 (fourth review follow-up). The dangerous shape is a row that
    // becomes eligible BEHIND the scan cursor — a deferral or promotion
    // re-queues with its ORIGINAL createdAt — while the runs already claimed
    // are long-running, so no completion is coming to re-enter dispatch at the
    // head. It must still be reached, off the back of a slot freeing up rather
    // than off the back of a completion.
    const { agentId, addIssueBackedRun, pastWindowAgeMs, insideWindowAgeMs } =
      await seedDeepClaimableBacklog({ maxConcurrentRuns: 2, issuelessRows: 2_000 });
    const adapter = gateAdapterExecutions();

    // Fill both slots and install a resume cursor at the window boundary. The
    // claim loop stops at the slot limit, so the rest of the window is left
    // queued and untouched.
    await heartbeat.resumeQueuedRuns();
    expect(await adapter.waitForStarted(2)).toBe(2);

    // A row that becomes eligible behind the cursor, plus one ahead of it for
    // the resumed pass to claim.
    const strandedRunId = await addIssueBackedRun("critical", insideWindowAgeMs(500));
    await addIssueBackedRun("low", pastWindowAgeMs(0));

    // A top-level wake now records head-rescan demand: dispatch is mid-queue,
    // so the pass this wake folds into will not look at the head. Both slots
    // are full, so it claims nothing.
    await heartbeat.resumeQueuedRuns();
    expect(adapter.started).toHaveLength(2);

    // Free both slots WITHOUT completing the runs — they are still executing,
    // which is exactly the "claimed run is long-running" case. Silence past the
    // staleness floor drops them out of the slot gate.
    const longSilence = new Date(Date.now() - 60 * 60 * 1000);
    await db
      .update(heartbeatRuns)
      .set({ startedAt: longSilence, lastOutputAt: longSilence, lastUsefulActionAt: longSilence })
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")));

    await heartbeat.resumeQueuedRuns();

    // That pass resumed past the cursor and claimed the row it found there, and
    // the stranded row is still picked up in the same round — neither of the
    // two long-running claims will ever complete to trigger a pass for it.
    expect(await adapter.waitForStarted(4)).toBe(4);
    expect(adapter.started).toContain(strandedRunId);

    await stopBacklog(agentId);
    adapter.disarm();
    await heartbeat.drainInFlightExecutions(60_000);
  }, 600_000);

  it("honours dispatch demand that arrived before the first pass installed its cursor", async () => {
    // BLO-20396 (fifth review follow-up). `onCoalescedDemand` recorded
    // head-rescan demand only when a resume cursor ALREADY existed. The cursor
    // is installed at the very END of a pass, so every wake that folded into
    // the FIRST bounded pass was dropped on the floor. That pass then installed
    // a cursor and scheduled a resume chain which started PAST the head and ran
    // to exhaustion, so a row at the head was never revisited and sat waiting
    // for an unrelated wake — the starvation class this ticket exists to remove.
    //
    // The shape that isolates it: a queue deeper than one pass, arranged so the
    // pass that finally exhausts the scan prunes NOTHING. That matters — a pass
    // that prunes even one terminal row calls scheduleFollowUpDispatchAfterPrune,
    // which schedules a head-start pass and rescues the stranded row for an
    // unrelated reason. An earlier version of this test put terminal rows in the
    // tail and passed against the bug for exactly that reason.
    //
    //   rows 0..1999   target an already-`done` issue -> pruned by the first
    //                  pass, which therefore claims nothing, installs a cursor
    //                  and schedules the resume chain.
    //   rows 2000..2399 are dependency-blocked -> the claim gate cancels them,
    //                  which is NOT counted as a terminal prune, so the pass
    //                  that exhausts the scan schedules no prune follow-up.
    //                  Cancelling them is also slow, which is what gives the
    //                  insert below a wide margin over the resume chain.
    //
    // A claimable row is then inserted at the HEAD, behind the cursor, WITHOUT
    // a dispatch call of its own — only a head rescan can reach it.
    //
    // Nothing here may call `resumeQueuedRuns` after the coalesced pair: a
    // top-level call re-arms the marker via the entry guard (a cursor exists by
    // then) and would mask the bug entirely.
    const { companyId, agentId, addIssueBackedRun, insideWindowAgeMs, pastWindowAgeMs } =
      await seedDeepClaimableBacklog({ maxConcurrentRuns: 2, issuelessRows: 2_000 });
    const adapter = gateAdapterExecutions();

    const doneIssueId = randomUUID();
    await db.insert(issues).values({
      id: doneIssueId,
      companyId,
      title: "Already-finished issue",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 90_000,
      identifier: `${companyId.slice(0, 4).toUpperCase()}-90000`,
    });
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId: doneIssueId, wakeReason: "issue_assigned" } })
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")));

    // One never-resolving blocker holds every tail row unclaimable.
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Never-done blocker",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 91_000,
      identifier: `${companyId.slice(0, 4).toUpperCase()}-91000`,
      startedAt: new Date(),
    });
    const tailIssues: Array<typeof issues.$inferInsert> = [];
    const tailRelations: Array<typeof issueRelations.$inferInsert> = [];
    const tailWakes: Array<typeof agentWakeupRequests.$inferInsert> = [];
    const tailRuns: Array<typeof heartbeatRuns.$inferInsert> = [];
    for (let i = 0; i < 400; i += 1) {
      const issueId = randomUUID();
      const runId = randomUUID();
      const wakeId = randomUUID();
      const at = new Date(Date.now() - 12 * 60 * 60 * 1000 + pastWindowAgeMs(i));
      tailIssues.push({
        id: issueId,
        companyId,
        title: `Blocked ${i}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 92_000 + i,
        identifier: `${companyId.slice(0, 4).toUpperCase()}-${92_000 + i}`,
      });
      tailRelations.push({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: issueId,
        type: "blocks",
      });
      tailWakes.push({
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
      tailRuns.push({
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
    }
    for (let i = 0; i < tailIssues.length; i += 200) {
      await db.insert(issues).values(tailIssues.slice(i, i + 200));
    }
    for (let i = 0; i < tailRelations.length; i += 200) {
      await db.insert(issueRelations).values(tailRelations.slice(i, i + 200));
    }
    for (let i = 0; i < tailWakes.length; i += 200) {
      await db.insert(agentWakeupRequests).values(tailWakes.slice(i, i + 200));
    }
    for (let i = 0; i < tailRuns.length; i += 200) {
      await db.insert(heartbeatRuns).values(tailRuns.slice(i, i + 200));
    }

    // Both calls in ONE tick. The lock is published before the callback body
    // runs, so the second call finds it held and coalesces while the first pass
    // is still scanning — precisely the window in which no cursor exists yet.
    const firstPass = heartbeat.resumeQueuedRuns();
    const coalescedPass = heartbeat.resumeQueuedRuns();
    await Promise.all([firstPass, coalescedPass]);

    // Lands behind the scan boundary the first pass just installed. Inserting a
    // row does not dispatch, so this is demand-free: the head rescan is the
    // only thing that can pick it up. `medium` keeps it out of the priority
    // lane, which would otherwise reach it regardless of the cursor.
    const headRunId = await addIssueBackedRun("medium", insideWindowAgeMs(0));

    expect(await adapter.waitForStarted(1)).toBe(1);
    expect(adapter.started[0]).toBe(headRunId);

    // Sanity that the fixture did what the scenario needs: the chain really did
    // walk the whole backlog, rather than stalling early for some other reason.
    const stillQueuedTerminal = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.agentId, agentId),
        eq(heartbeatRuns.status, "queued"),
        eq(heartbeatRuns.contextIssueId, doneIssueId),
      ));
    expect(stillQueuedTerminal).toHaveLength(0);

    await stopBacklog(agentId);
    adapter.disarm();
    await heartbeat.drainInFlightExecutions(60_000);
  }, 600_000);

  it("does not re-arm an internally scheduled head rescan when it coalesces", async () => {
    // BLO-20396 (sixth review follow-up). A trailing head rescan is scheduled
    // from inside the currently held agent lock. It can therefore coalesce into
    // that active section before running. That coalescence must NOT be treated
    // as new external demand, or the head pass re-arms itself forever after it
    // exhausts an empty queue.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const terminalIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "HeadRescanLoopCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "HeadRescanLoopAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: terminalIssueId,
      companyId,
      title: "Already done",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const now = Date.now();
    const wakeRows: Array<typeof agentWakeupRequests.$inferInsert> = [];
    const runRows: Array<typeof heartbeatRuns.$inferInsert> = [];
    for (let i = 0; i < 2; i += 1) {
      const runId = randomUUID();
      const wakeId = randomUUID();
      const at = new Date(now + i);
      wakeRows.push({
        id: wakeId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: terminalIssueId },
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
        contextSnapshot: { issueId: terminalIssueId, wakeReason: "issue_assigned" },
        createdAt: at,
        updatedAt: at,
      });
    }
    await db.insert(agentWakeupRequests).values(wakeRows);
    await db.insert(heartbeatRuns).values(runRows);

    let releaseFirstPass!: () => void;
    let firstPassEntered!: () => void;
    let directCoalesced!: () => void;
    const releaseFirstPassPromise = new Promise<void>((resolve) => {
      releaseFirstPass = resolve;
    });
    const firstPassEnteredPromise = new Promise<void>((resolve) => {
      firstPassEntered = resolve;
    });
    const directCoalescedPromise = new Promise<void>((resolve) => {
      directCoalesced = resolve;
    });
    let heldFirstDirectPass = false;
    const passReasons: string[] = [];
    const coalescedReasons: Array<{ reason: string; suppressHeadRescanDemand: boolean }> = [];
    const boundedHeartbeat = heartbeatService(db, {
      penstockGate: allowPenstockGate,
      queuedRunDispatchBounds: { scanLimit: 2, maxScanBatches: 1, maxResumePasses: 4 },
      beforeQueuedDispatchPassForTest: async (event) => {
        passReasons.push(event.reason);
        if (event.reason === "direct" && !heldFirstDirectPass) {
          heldFirstDirectPass = true;
          firstPassEntered();
          await releaseFirstPassPromise;
        }
      },
      onQueuedDispatchCoalescedDemandForTest: (event) => {
        coalescedReasons.push({
          reason: event.reason,
          suppressHeadRescanDemand: event.suppressHeadRescanDemand,
        });
        if (event.reason === "direct") directCoalesced();
      },
    });

    const first = boundedHeartbeat.resumeQueuedRuns();
    await firstPassEnteredPromise;
    const second = boundedHeartbeat.resumeQueuedRuns();
    await directCoalescedPromise;
    releaseFirstPass();
    await Promise.all([first, second]);
    await boundedHeartbeat.drainInFlightExecutions(5_000);

    expect(passReasons.filter((reason) => reason === "resume_head_rescan_after_coalesced_demand"))
      .toHaveLength(1);
    expect(coalescedReasons).toContainEqual({
      reason: "resume_head_rescan_after_coalesced_demand",
      suppressHeadRescanDemand: true,
    });

    const remainingQueued = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")));
    expect(remainingQueued).toHaveLength(0);
  }, 60_000);
});

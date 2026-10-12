/**
 * BLO-20801: `hasActiveJobForAgent` used to be agent-scoped only, so any Job
 * carrying the agent label blocked ALL dispatch for that agent -- even one
 * whose `paperclip.io/run-id` label maps to a heartbeat_runs row that is
 * already terminal in the DB. The consequential case: a worker crash stamps
 * runs terminal while their backing Jobs survive, and the agent stays
 * undispatchable for up to EXTERNAL_LIFECYCLE_HARD_STALE_MS (45 min) even
 * though it is fully recovered at the DB level.
 *
 * This exercises the real dispatch gate in `startNextQueuedRunForAgent`
 * (via the public `resumeQueuedRuns()`) end to end against a real Postgres
 * instance, with only the k8s Job-listing boundary mocked -- proving the
 * `isRunTerminal` callback wired in heartbeat.ts actually reaches
 * `hasActiveJobForAgent` and is honored by the gate.
 *
 * Run against pre-BLO-20801 `master`, "dispatches queued work immediately"
 * below fails: the queued run never leaves `queued` because the mocked
 * `hasActiveJobForAgent` has no `isRunTerminal` option to consult and
 * unconditionally reports the surviving Job as active.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  AGENT_START_LOCK_REAP_DISPOSITION_METRIC,
  __resetMetricsForTest,
  renderMetrics,
} from "../services/metrics.js";
import { runningProcesses } from "../adapters/index.js";
import { logger } from "../middleware/logger.js";
import {
  _resetAgentStartLocksForTesting,
  currentAgentStartLockSignal,
  describeAgentStartLockDispatchHealth,
  LOCK_HELD_WARN_MS,
} from "../services/agent-start-lock.js";

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
const mockHasActiveJobForAgent = vi.hoisted(() => vi.fn(async () => false));
/** When set, replaces the roster read `noteDispatchDeclined` makes (BLO-42493). */
const rosterFault = vi.hoisted(() => ({ next: null as null | (() => Promise<never>) }));

vi.mock("../services/agent-roster.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agent-roster.ts")>();
  return {
    ...actual,
    getActiveAgentIds: (...args: Parameters<typeof actual.getActiveAgentIds>) =>
      rosterFault.next ? rosterFault.next() : actual.getActiveAgentIds(...args),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      type: "claude_k8s",
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
    hasActiveJobForAgent: mockHasActiveJobForAgent,
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
    `Skipping run-scoped job-liveness dispatch tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describeEmbeddedPostgres("startNextQueuedRunForAgent run-id-aware job liveness (BLO-20801)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const allowPenstockGate = {
    checkAdapter: async () => ({ allow: true as const }),
    _resetForTesting: () => {},
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("blo-20801-run-scoped-liveness-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { penstockGate: allowPenstockGate });
  }, 120_000);

  afterEach(async () => {
    vi.clearAllMocks();
    mockHasActiveJobForAgent.mockReset().mockResolvedValue(false);
    runningProcesses.clear();
    await cleanupHeartbeatTestState(db, heartbeat);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedExternalLifecycleAgentWithTerminalRuns() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "RunScopedLivenessCo",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ExternalLifecycleAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    // Two runs already recovered/terminal at the DB layer (e.g. process_lost
    // after a worker crash), matching BLO-20801's crash-recovery scenario.
    // No "running" row exists, so runningCount === 0 for the gate.
    const terminalRunIdA = randomUUID();
    const terminalRunIdB = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: terminalRunIdA,
        companyId,
        agentId,
        invocationSource: "heartbeat",
        triggerDetail: "timer",
        status: "failed",
        errorCode: "process_lost",
        contextSnapshot: {},
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
        finishedAt: new Date(Date.now() - 50 * 60 * 1000),
      },
      {
        id: terminalRunIdB,
        companyId,
        agentId,
        invocationSource: "heartbeat",
        triggerDetail: "timer",
        status: "failed",
        errorCode: "process_lost",
        contextSnapshot: {},
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
        finishedAt: new Date(Date.now() - 50 * 60 * 1000),
      },
    ]);

    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: {},
    });

    return { companyId, agentId, terminalRunIdA, terminalRunIdB, queuedRunId };
  }

  it("dispatches queued work immediately when the only surviving Job's run-id maps to a terminal DB run", async () => {
    const { agentId, terminalRunIdA, queuedRunId } = await seedExternalLifecycleAgentWithTerminalRuns();

    // Simulates a k8s Job that survived a worker crash, still carrying the
    // paperclip.io/run-id label for terminalRunIdA. The production
    // hasActiveJobForAgent(agentId, { isRunTerminal }) wiring is what this
    // test verifies -- the mock here stands in only for the k8s Job list
    // itself, not for the run-id-vs-DB decision.
    mockHasActiveJobForAgent.mockImplementation(async (_agentId: string, options?: {
      isRunTerminal?: (runIds: readonly string[]) => Promise<ReadonlySet<string>>;
    }) => {
      const terminal = options?.isRunTerminal ? await options.isRunTerminal([terminalRunIdA]) : new Set<string>();
      return !terminal.has(terminalRunIdA);
    });

    await heartbeat.resumeQueuedRuns();

    const dispatched = await waitUntil(async () => {
      const [row] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedRunId));
      return row?.status !== "queued";
    });

    expect(dispatched).toBe(true);
    expect(mockHasActiveJobForAgent).toHaveBeenCalledWith(agentId, expect.objectContaining({
      isRunTerminal: expect.any(Function),
    }));
  });

  it("counts the start-lock reap disposition on a real external-lifecycle dispatch pass (BLO-42010)", async () => {
    // The disposition counter's only production increment is the call in
    // `startNextQueuedRunForAgent`'s reap `finally`; the metric's own suite
    // drives the helper directly and cannot see that call deleted. Absent
    // series read as "no bails occurred", so a lost increment is silent.
    // Default TTL is 0 and this agent is the only dispatcher, so every pass
    // sweeps fresh and must land under `ran`, and nothing else.
    __resetMetricsForTest();
    const { queuedRunId } = await seedExternalLifecycleAgentWithTerminalRuns();

    await heartbeat.resumeQueuedRuns();
    const dispatched = await waitUntil(async () => {
      const [row] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedRunId));
      return row?.status !== "queued";
    });
    expect(dispatched).toBe(true);

    const { body } = await renderMetrics();
    const series = body
      .split("\n")
      .filter((line) => line.startsWith(`${AGENT_START_LOCK_REAP_DISPOSITION_METRIC}{`));
    expect(series.map((line) => /disposition="([^"]+)"/.exec(line)?.[1])).toEqual(["ran"]);
    expect(Number(series[0].trim().split(/\s+/).pop())).toBeGreaterThanOrEqual(1);
  });

  it("still blocks dispatch when the surviving Job's run-id maps to a live (non-terminal) run", async () => {
    const { queuedRunId } = await seedExternalLifecycleAgentWithTerminalRuns();
    const liveRunId = randomUUID(); // not one of the terminal runs seeded above

    mockHasActiveJobForAgent.mockImplementation(async (_agentId: string, options?: {
      isRunTerminal?: (runIds: readonly string[]) => Promise<ReadonlySet<string>>;
    }) => {
      const terminal = options?.isRunTerminal ? await options.isRunTerminal([liveRunId]) : new Set<string>();
      return !terminal.has(liveRunId);
    });

    await heartbeat.resumeQueuedRuns();
    // Give the async dispatch path a moment to (not) act.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const [row] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId));

    expect(row?.status).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("still blocks dispatch when a Job's run-id label belongs to a DIFFERENT agent's terminal run (identity fence)", async () => {
    // PR #946 review: findTerminalHeartbeatRunIds must not treat a run-id as
    // terminal-and-safe-to-waive just because the UUID matches some row in
    // the table -- it must also belong to the agent whose Jobs are being
    // evaluated. A stale/corrupt/misconfigured Job carrying agent A's
    // agent-id label but agent B's (terminal) run-id must stay blocking for
    // agent A.
    const { queuedRunId } = await seedExternalLifecycleAgentWithTerminalRuns();

    // A second, unrelated agent+company with its own terminal run.
    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();
    const otherAgentTerminalRunId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "OtherCo",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: otherCompanyId,
      name: "OtherAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: otherAgentTerminalRunId,
      companyId: otherCompanyId,
      agentId: otherAgentId,
      invocationSource: "heartbeat",
      triggerDetail: "timer",
      status: "failed",
      errorCode: "process_lost",
      contextSnapshot: {},
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
      finishedAt: new Date(Date.now() - 50 * 60 * 1000),
    });

    // Simulates a mislabeled/stale Job on the first agent carrying the
    // OTHER agent's terminal run-id.
    mockHasActiveJobForAgent.mockImplementation(async (_agentId: string, options?: {
      isRunTerminal?: (runIds: readonly string[]) => Promise<ReadonlySet<string>>;
    }) => {
      const terminal = options?.isRunTerminal
        ? await options.isRunTerminal([otherAgentTerminalRunId])
        : new Set<string>();
      return !terminal.has(otherAgentTerminalRunId);
    });

    await heartbeat.resumeQueuedRuns();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const [row] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId));

    expect(row?.status).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("propagates the section's abort out of noteDispatchDeclined instead of swallowing it (BLO-42493)", async () => {
    // "Instrumentation must never fail dispatch" is right for a roster-read
    // fault and wrong for the section's own abort: the lock is released only
    // when the section settles, so a swallowed abort keeps the agent's start
    // lock held. Drives the real decline path — a live untracked Job declines
    // the pass as `untracked_external_job` — with the roster read cancelled
    // the way postgres.js `Query#cancel()` cancels it (`57014`).
    const { agentId, queuedRunId } = await seedExternalLifecycleAgentWithTerminalRuns();
    mockHasActiveJobForAgent.mockResolvedValue(true);
    let rosterReadInSection!: () => void;
    const rosterRead = new Promise<void>((resolve) => {
      rosterReadInSection = resolve;
    });
    rosterFault.next = () => {
      const signal = currentAgentStartLockSignal();
      expect(signal, "the decline's roster read must run inside the start-lock section").toBeDefined();
      rosterReadInSection();
      return new Promise<never>((_resolve, reject) => {
        signal!.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("canceling statement due to user request"), { code: "57014" })),
          { once: true },
        );
      });
    };
    // The lock logs a line per tick across the simulated four hours.
    const quiet = [
      vi.spyOn(logger, "warn").mockImplementation(() => logger),
      vi.spyOn(logger, "error").mockImplementation(() => logger),
    ];
    // Only the lock's escalation/abort clock is faked; DB I/O keeps real timers.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const pass = heartbeat.resumeQueuedRuns().then(
        () => ({ resolved: true as const }),
        (error: unknown) => ({ error }),
      );
      await rosterRead;
      // Hand-copied LOCK_ABORT_MS (4 h, not exported from agent-start-lock.ts).
      await vi.advanceTimersByTimeAsync(4 * 60 * 60_000 + LOCK_HELD_WARN_MS);
      // Fails fast, instead of hanging on `pass`, if the abort never fired.
      expect(describeAgentStartLockDispatchHealth(agentId)).not.toBeNull();

      expect(await pass).toEqual({ error: expect.objectContaining({ code: "57014" }) });
      // Released by the section settling, not left `stalled` behind a swallow.
      expect(describeAgentStartLockDispatchHealth(agentId)?.status).toBe("aborted");
    } finally {
      vi.useRealTimers();
      for (const spy of quiet) spy.mockRestore();
      rosterFault.next = null;
      _resetAgentStartLocksForTesting();
    }

    const [row] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId));
    expect(row?.status).toBe("queued");
  });
});

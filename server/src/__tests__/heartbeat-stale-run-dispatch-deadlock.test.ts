/**
 * Dispatch must not deadlock when every running row is alive-but-quiet.
 *
 * Two guards in `startNextQueuedRunForAgent` interact badly:
 *
 *   1. BLO-12990 excludes a run silent for >EXTERNAL_LIFECYCLE_STALE_MS (15 min)
 *      from `runningCount`, so a quiet run cannot starve new work.
 *   2. The orphan guard refuses to dispatch while a live Job exists and there is
 *      no corresponding running row.
 *
 * If guard 2 keys off `runningCount` (non-stale) rather than the tracked rows,
 * then an agent whose runs are ALL silent has `runningCount === 0` while its
 * Jobs are still active — so guard 2 blocks every dispatch. That is guard 1's
 * starvation, made total. Nothing breaks the cycle either: the destructive
 * force-kill is keyed to EXTERNAL_LIFECYCLE_HARD_STALE_MS (45 min), leaving a
 * 30-minute window where a run is uncounted, unkillable, and Job-alive.
 *
 * Observed in production 2026-08-08: Ally held 9 running rows, every one
 * exactly 20 min silent, 12 live pods, ~80 queued runs, zero dispatches for
 * over an hour. Company-wide, eight agents were in the same state.
 *
 * The run below is seeded at 20 minutes of silence *deliberately* — inside the
 * dead zone, past the 15 min soft floor and short of the 45 min kill.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import { heartbeatService } from "../services/heartbeat.js";
import { runningProcesses } from "../adapters/index.js";
import { hasActiveJobForAgent } from "../services/k8s-job-liveness.js";

const SOFT_STALE_MS = 15 * 60 * 1000;
const HARD_STALE_MS = 45 * 60 * 1000;
/** Inside the dead zone: uncounted by guard 1, untouched by the 45 min kill. */
const SILENT_MS = 20 * 60 * 1000;

// Run ids whose k8s Job is alive. The reaper must see the quiet run's Job as
// live, otherwise it finalizes it as process_lost and the fixture degrades into
// the true-orphan case instead of the live-but-quiet one under test.
const liveJobRunIds = vi.hoisted(() => ({ current: [] as string[] }));

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
    listLiveAgentJobRunIds: vi.fn(async () => new Set(liveJobRunIds.current)),
    listAgentJobRunStatuses: vi.fn(async () => null),
    listManagedAgentJobs: vi.fn(async () => null),
    readAgentJobRunStatusByName: vi.fn(async () => null),
    deleteAgentJobsForRun: vi.fn(async () => 1),
    deleteAgentJobExact: vi.fn(async () => "deleted" as const),
    // The agent's pods are alive. This is what makes the orphan guard relevant.
    hasActiveJobForAgent: vi.fn(async () => true),
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
    `Skipping stale-run dispatch deadlock tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("dispatch is not deadlocked by alive-but-quiet runs", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-deadlock-");
    db = createDb(tempDb.connectionString);
    // No penstockAvailabilityGate: it gates claude_k8s agents only, and the
    // agent under test is opencode_k8s. (Note the neighbouring backlog test
    // passes `penstockGate`, which is not a field on HeartbeatServiceOptions —
    // TypeScript drops it as an excess property, so that gate is never actually
    // injected there. Not copied here.)
    heartbeat = heartbeatService(db);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.mocked(hasActiveJobForAgent).mockImplementation(async () => true);
    liveJobRunIds.current = [];
    runningProcesses.clear();
    await cleanupHeartbeatTestState(db, heartbeat);
  });

  afterAll(async () => {
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedAgentWithQuietRunAndBacklog() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runningRunId = randomUUID();
    const queuedRunId = randomUUID();
    const wakeId = randomUUID();
    const silentSince = new Date(Date.now() - SILENT_MS);

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QuietRunAgent",
      role: "engineer",
      status: "running",
      // External lifecycle: the guard under test only applies to these.
      adapterType: "opencode_k8s",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, concurrencyEnabled: true, maxConcurrentRuns: 5 },
      },
      permissions: {},
    });

    // A tracked, live, quiet run. lastUsefulActionAt is intentionally null:
    // opencode_k8s never writes it in production, so silence is measured from
    // lastOutputAt and accrues on any long run.
    await db.insert(heartbeatRuns).values({
      id: runningRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: silentSince,
      lastOutputAt: silentSince,
      lastUsefulActionAt: null,
      createdAt: silentSince,
      updatedAt: silentSince,
    });

    // The run must look STARTED, not pre-adapter. Without an `adapter.invoke`
    // event the reaper classifies it as "process lost before external adapter
    // invocation" and finalizes it past the 5-minute pre-adapter grace — which
    // would delete the very condition under test and make this fixture model a
    // true orphan instead of a live-but-quiet run.
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId: runningRunId,
      agentId,
      seq: 1,
      eventType: "adapter.invoke",
      payload: {},
      createdAt: silentSince,
    });

    liveJobRunIds.current = [runningRunId];

    const queuedAt = new Date(Date.now() - 60_000);
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {},
      status: "queued",
      runId: queuedRunId,
      requestedAt: queuedAt,
      updatedAt: queuedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: wakeId,
      createdAt: queuedAt,
      updatedAt: queuedAt,
    });

    return { agentId, runningRunId, queuedRunId };
  }

  it("dispatches queued work while every tracked run is silent and its Jobs are live", async () => {
    const { queuedRunId, runningRunId } = await seedAgentWithQuietRunAndBacklog();

    // Sanity-check the fixture actually sits in the dead zone, so a future
    // change to either threshold fails loudly here instead of silently making
    // this test vacuous.
    expect(SILENT_MS).toBeGreaterThan(SOFT_STALE_MS);
    expect(SILENT_MS).toBeLessThan(HARD_STALE_MS);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainInFlightExecutions(60_000);

    const [queued] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId));

    // Before the fix this stayed "queued" forever: runningCount collapsed to 0
    // because the only running row was stale, hasActiveJobForAgent returned
    // true, and the orphan guard returned [] on every pass.
    expect(queued?.status).not.toBe("queued");

    // The quiet run must be left alone. It is inside the dead zone, so the
    // 45-minute force-kill has no business touching it — asserting this keeps
    // the fix from being "solved" by prematurely reaping live work, which is
    // the failure mode BLO-13176 warns about.
    const [stillRunning] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId));
    expect(stillRunning?.status).toBe("running");
  });

  it("still refuses to dispatch when a live Job has no tracked run at all", async () => {
    // The orphan guard's real purpose, which the fix must preserve: a Job with
    // no running row is an orphan or a terminating pod, and allocating a slot
    // against it double-books the agent.
    const { queuedRunId, runningRunId } = await seedAgentWithQuietRunAndBacklog();
    // Events reference the run, so they must go first or the delete violates FK.
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runningRunId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runningRunId));

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainInFlightExecutions(60_000);

    const [queued] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId));
    expect(queued?.status).toBe("queued");
  });
});

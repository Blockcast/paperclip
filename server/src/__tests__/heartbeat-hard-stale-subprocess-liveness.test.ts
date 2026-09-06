/**
 * BLO-20251 — the hard-stale reaper must not kill a run that is correctly
 * blocked on a long, silent subprocess.
 *
 * The reaper's silence signal is adapter stdout. The claude_k8s Job pipes only
 * the agent CLI's own stdout to the pod log, and while the agent sits inside a
 * Bash tool call the CLI emits nothing between tool_use and tool_result. So a
 * legitimate `pnpm install` / test suite / docker build is byte-for-byte
 * indistinguishable from a wedged pod, and both trip
 * EXTERNAL_LIFECYCLE_HARD_STALE_MS (45 min).
 *
 * Production incident: run cf7f812b on BLO-20088 was force-killed
 * `external_lifecycle_stale_killed` mid-`pnpm install` on 2026-08-01, throwing
 * away ~30 min of completed work on the fleet's top-priority reliability fix.
 *
 * The fix corroborates silence with pod CPU (probeAgentPodActivity). These
 * tests pin all four arms of that decision, and in particular that the
 * BLO-12996 force-reap still fires everywhere it used to.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  externalRuntimeReservations,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";

const HARD_STALE_MS = 45 * 60 * 1000;
/** Default ceiling on busy-pod deferral: 4x the hard-stale floor (3h). */
const BUSY_POD_MAX_STALE_MS = 4 * HARD_STALE_MS;

const mockListAgentJobRunStatuses = vi.hoisted(() => vi.fn(async () => null as unknown));
const mockListLiveAgentJobRunIds = vi.hoisted(() => vi.fn(async () => null as unknown));
const mockListManagedAgentJobs = vi.hoisted(() => vi.fn(async () => null as unknown));
const mockReadAgentJobRunStatusByName = vi.hoisted(() => vi.fn(async () => null as unknown));
const mockDeleteAgentJobsForRun = vi.hoisted(() => vi.fn(async () => 1));
const mockDeleteAgentJobExact = vi.hoisted(() => vi.fn(async () => "deleted" as const));
const mockHasActiveJobForAgent = vi.hoisted(() => vi.fn(async () => false));
const mockProbeAgentPodActivity = vi.hoisted(() => vi.fn(async () => "unknown" as string));

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../services/k8s-job-liveness.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/k8s-job-liveness.ts")>();
  return {
    ...actual,
    listAgentJobRunStatuses: mockListAgentJobRunStatuses,
    listLiveAgentJobRunIds: mockListLiveAgentJobRunIds,
    listManagedAgentJobs: mockListManagedAgentJobs,
    readAgentJobRunStatusByName: mockReadAgentJobRunStatusByName,
    deleteAgentJobsForRun: mockDeleteAgentJobsForRun,
    deleteAgentJobExact: mockDeleteAgentJobExact,
    hasActiveJobForAgent: mockHasActiveJobForAgent,
    probeAgentPodActivity: mockProbeAgentPodActivity,
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      type: "claude_k8s",
      supportsLocalAgentJwt: false,
      execute: vi.fn(),
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping hard-stale subprocess-liveness tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Pure — no database, so this arm runs on every host.
describe("parseCpuQuantityToMillicores", () => {
  it("normalises every unit metrics-server actually emits", async () => {
    const { parseCpuQuantityToMillicores } = await import("../services/k8s-job-liveness.js");
    // Whole cores, millicores, micro- and nanocores all reach the same scale.
    expect(parseCpuQuantityToMillicores("2")).toBe(2000);
    expect(parseCpuQuantityToMillicores("2734m")).toBe(2734);
    expect(parseCpuQuantityToMillicores("1500u")).toBe(1.5);
    expect(parseCpuQuantityToMillicores("46000000n")).toBe(46);
    expect(parseCpuQuantityToMillicores("0")).toBe(0);
    expect(parseCpuQuantityToMillicores("0.5")).toBe(500);
  });

  it("returns null rather than 0 for anything it cannot parse", async () => {
    const { parseCpuQuantityToMillicores } = await import("../services/k8s-job-liveness.js");
    // 0 would read as idle and license a kill, so unparseable must stay null.
    for (const bad of [undefined, null, "", "  ", "abc", "12x", "1e3", 42]) {
      expect(parseCpuQuantityToMillicores(bad)).toBeNull();
    }
  });
});

// Pure — no database, so this arm runs on every host.
describe("numberFromEnv (liveness tunable parsing)", () => {
  const ENV_NAME = "PAPERCLIP_K8S_AGENT_POD_BUSY_CPU_MILLICORES";

  afterEach(() => {
    delete process.env[ENV_NAME];
  });

  it("falls back to the default instead of producing NaN from a malformed value", async () => {
    const { numberFromEnv } = await import("../services/k8s-job-liveness.js");
    // The regression: `Math.max(1, Number("abc"))` is NaN, so every
    // `millicores >= threshold` test would be false, every pod would classify
    // "idle", and the reaper would kill live subprocesses — the exact failure
    // this module exists to prevent. A bad value must never disarm the probe.
    for (const bad of ["abc", "", "   ", "12x", "NaN", "Infinity", "-5", "0"]) {
      process.env[ENV_NAME] = bad;
      const threshold = numberFromEnv(ENV_NAME, 100, 1);
      expect(threshold).toBe(100);
      expect(Number.isFinite(threshold)).toBe(true);
      // A busy pod must still read as busy under a rejected override.
      expect(500 >= threshold).toBe(true);
    }
  });

  it("honours a valid override and an unset variable", async () => {
    const { numberFromEnv } = await import("../services/k8s-job-liveness.js");
    delete process.env[ENV_NAME];
    expect(numberFromEnv(ENV_NAME, 100, 1)).toBe(100);
    process.env[ENV_NAME] = "250";
    expect(numberFromEnv(ENV_NAME, 100, 1)).toBe(250);
    process.env[ENV_NAME] = " 250 ";
    expect(numberFromEnv(ENV_NAME, 100, 1)).toBe(250);
  });

  it("accepts 0 only where 0 is meaningful, via the minimum argument", async () => {
    const { numberFromEnv } = await import("../services/k8s-job-liveness.js");
    process.env[ENV_NAME] = "0";
    // Cache TTL: 0 legitimately disables caching, so minimum 0 keeps it.
    expect(numberFromEnv(ENV_NAME, 10_000, 0)).toBe(0);
    // CPU threshold: 0m would classify every pod busy forever, so minimum 1
    // rejects it back to the default.
    expect(numberFromEnv(ENV_NAME, 100, 1)).toBe(100);
  });
});

describeEmbeddedPostgres("hard-stale reaper respects live subprocesses (BLO-20251)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-subprocess-liveness-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: {
        checkAdapter: async () => ({ allow: true }),
        _resetForTesting() {},
      },
    });
  }, 120_000);

  afterEach(async () => {
    mockListAgentJobRunStatuses.mockReset().mockResolvedValue(null);
    mockListLiveAgentJobRunIds.mockReset().mockResolvedValue(null);
    mockListManagedAgentJobs.mockReset().mockResolvedValue(null);
    mockReadAgentJobRunStatusByName.mockReset().mockResolvedValue(null);
    mockDeleteAgentJobsForRun.mockReset().mockResolvedValue(1);
    mockDeleteAgentJobExact.mockReset().mockResolvedValue("deleted");
    mockHasActiveJobForAgent.mockReset().mockResolvedValue(false);
    mockProbeAgentPodActivity.mockReset().mockResolvedValue("unknown");
    await cleanupHeartbeatTestState(db, heartbeat);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Seeds a claude_k8s run that has been silent for `silentMs` with its backing
   * Job still `phase: active` — i.e. exactly the shape the hard-stale reaper
   * force-kills. Every activity stamp is aged together, because
   * externalLifecycleRecentRefTime takes the MAX across all of them.
   *
   * The run carries an `adapter.invoke` event and a launched reservation so it
   * takes the STARTED external-lifecycle path — the shape of the cf7f812b
   * incident (the agent was mid-work inside a Bash tool call), not the
   * pre-adapter provisioning path. Without the reservation and a Job uid the
   * reaper classifies the run "ambiguous" and skips it entirely, which silently
   * makes every assertion below vacuous.
   */
  async function seedSilentRunWithLiveJob(silentMs: number) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const jobName = `agent-claude-blo20251-${runId.slice(0, 8)}`;
    const jobUid = `uid-${runId.slice(0, 8)}`;
    const silentSince = new Date(Date.now() - silentMs);

    await db.insert(companies).values({
      id: companyId,
      name: "SubprocessLivenessCo",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SubprocessLivenessAgent",
      role: "engineer",
      status: "running",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 5, concurrencyEnabled: true },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      externalRunId: jobName,
      startedAt: silentSince,
      lastOutputAt: silentSince,
      lastUsefulActionAt: silentSince,
      contextSnapshot: {},
      createdAt: silentSince,
      updatedAt: new Date(),
    });

    // Past the pre-adapter phase: the agent is running and has gone quiet
    // inside a tool call.
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "adapter.invoke",
      stream: "system",
      level: "info",
      message: "adapter invoked",
      createdAt: silentSince,
    });

    // The reservation is the sole authority for which Job drives a run; without
    // it the identity-reconciliation pass marks the run ambiguous.
    await db.insert(externalRuntimeReservations).values({
      id: randomUUID(),
      companyId,
      agentId,
      runId,
      slotId: 1,
      state: "launched",
      expectedJobName: jobName,
      jobName,
      jobUid,
      reservedAt: silentSince,
      launchedAt: silentSince,
      releasedAt: null,
      isolationMode: "run",
      isolationKey: `run:${runId}`,
      isolationBoundAt: silentSince,
    });

    // The rich-status path: the Job is present and still active.
    mockListAgentJobRunStatuses.mockResolvedValue(
      new Map([
        [
          runId,
          { phase: "active" as const, reason: null, message: null, name: jobName, uid: jobUid },
        ],
      ]),
    );

    return { companyId, agentId, runId, jobName, jobUid };
  }

  async function readRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]!);
  }

  it("spares a run whose pod is burning CPU on a long silent subprocess", async () => {
    const { runId } = await seedSilentRunWithLiveJob(HARD_STALE_MS + 15 * 60 * 1000);
    // `pnpm install` in flight: no tool calls, no stdout, but the pod is working.
    mockProbeAgentPodActivity.mockResolvedValue("busy");

    await heartbeat.reapOrphanedRuns();

    const run = await readRun(runId);
    expect(run.status).toBe("running");
    expect(run.errorCode).toBeNull();
    expect(run.finishedAt).toBeNull();
    // The Job must be left alone entirely — a delete here is the data loss.
    expect(mockDeleteAgentJobsForRun).not.toHaveBeenCalled();
    expect(mockProbeAgentPodActivity).toHaveBeenCalledWith(runId);
  }, 120_000);

  it("still reaps a wedged run with no subprocess activity (BLO-12996 regression guard)", async () => {
    const { runId } = await seedSilentRunWithLiveJob(HARD_STALE_MS + 15 * 60 * 1000);
    // Genuinely wedged: metrics available, pod idle.
    mockProbeAgentPodActivity.mockResolvedValue("idle");

    await heartbeat.reapOrphanedRuns();

    const run = await readRun(runId);
    expect(run.status).not.toBe("running");
    expect(run.errorCode).toBe("external_lifecycle_stale_killed");
    expect(run.finishedAt).not.toBeNull();
  }, 120_000);

  it("still reaps when pod metrics are unavailable, so a cluster without metrics-server is unchanged", async () => {
    const { runId } = await seedSilentRunWithLiveJob(HARD_STALE_MS + 15 * 60 * 1000);
    // No metrics-server / RBAC denied / pod not yet scraped.
    mockProbeAgentPodActivity.mockResolvedValue("unknown");

    await heartbeat.reapOrphanedRuns();

    const run = await readRun(runId);
    expect(run.errorCode).toBe("external_lifecycle_stale_killed");
  }, 120_000);

  it("reaps a busy-looking pod once it passes the absolute ceiling, so a CPU-burning zombie cannot hold the slot forever", async () => {
    const { runId } = await seedSilentRunWithLiveJob(BUSY_POD_MAX_STALE_MS + 10 * 60 * 1000);
    // Still "busy" — a spin loop looks identical to real work to a CPU probe.
    mockProbeAgentPodActivity.mockResolvedValue("busy");

    await heartbeat.reapOrphanedRuns();

    const run = await readRun(runId);
    expect(run.errorCode).toBe("external_lifecycle_stale_killed");
  }, 120_000);
});

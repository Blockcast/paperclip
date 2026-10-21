/**
 * BLO-42411: a pending image bump used to make `startNextQueuedRunForAgent`
 * decline ALL dispatch (`pending_image_bump`) until the agent's running count
 * reached zero, so one long run froze every free slot of a multi-slot agent.
 * The dispatcher now applies the bump under the start lock and keeps
 * dispatching: in-flight Jobs keep their image, new Jobs get the new one.
 *
 * Against the pre-fix gate, the queued run below never leaves `queued` and the
 * agent image stays on `:old`.
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
import { runningProcesses } from "../adapters/index.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_ctx: unknown) => ({
    exitCode: 0,
    signal: null as string | null,
    timedOut: false,
    errorMessage: null as string | null,
    resultJson: { exitCode: 0 },
    provider: "test",
    model: "test-model",
  })),
);
// The running run's Job is live.
const mockHasActiveJobForAgent = vi.hoisted(() => vi.fn(async () => true));

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

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describeEmbeddedPostgres("startNextQueuedRunForAgent with a pending image bump (BLO-42411)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("blo-42411-pending-bump-dispatch-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: { checkAdapter: async () => ({ allow: true as const }), _resetForTesting: () => {} },
    });
  }, 120_000);

  afterEach(async () => {
    vi.clearAllMocks();
    mockHasActiveJobForAgent.mockReset().mockResolvedValue(true);
    runningProcesses.clear();
    await cleanupHeartbeatTestState(db, heartbeat);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("applies the bump and dispatches queued work while another run is still executing", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "PendingBumpDispatchCo",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "MultiSlotAgent",
      role: "engineer",
      status: "running",
      adapterType: "claude_k8s",
      adapterConfig: { image: "harbor.example/a:old" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, concurrencyEnabled: true, maxConcurrentRuns: 3 } },
      permissions: {},
      pendingImageBump: "harbor.example/a:new",
    });
    const runningRunId = randomUUID();
    const queuedRunId = randomUUID();
    const now = new Date();
    await db.insert(heartbeatRuns).values([
      {
        id: runningRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: {},
        startedAt: now,
        lastOutputAt: now,
      },
      {
        id: queuedRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: {},
      },
    ]);

    await heartbeat.resumeQueuedRuns();

    const dispatched = await waitUntil(async () => {
      const [row] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedRunId));
      return row?.status !== "queued";
    });
    expect(dispatched).toBe(true);

    // The in-flight run is untouched.
    const [inFlight] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId));
    expect(inFlight?.status).toBe("running");

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect((agent!.adapterConfig as Record<string, unknown>).image).toBe("harbor.example/a:new");
    expect(agent!.pendingImageBump).toBeNull();

    // The new run's Job is built from the new image.
    await waitUntil(async () => mockAdapterExecute.mock.calls.length > 0);
    expect(JSON.stringify(mockAdapterExecute.mock.calls[0]![0])).toContain("harbor.example/a:new");
    expect(JSON.stringify(mockAdapterExecute.mock.calls[0]![0])).not.toContain("harbor.example/a:old");
  });
});

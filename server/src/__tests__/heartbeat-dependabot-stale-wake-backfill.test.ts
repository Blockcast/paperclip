/**
 * BLO-16446: a large backlog of dependabot_alert wakes was enqueued before the
 * BLO-16319 scoping fix shipped. Each queued heartbeatRuns row's contextSnapshot
 * was frozen at enqueue time — `{ taskKey, wakeReason, wakeSource,
 * wakeTriggerDetail }` only, no issueId — so redeploying the webhook route's
 * fix never touched them: each launches an unscoped agent run (no
 * PAPERCLIP_TASK_ID, no alert payload) the moment the heartbeat scheduler
 * finally dispatches it, no matter how long after the fix that dispatch
 * happens. This covers the dispatch-time backfill in heartbeat.ts that
 * resolves (or creates) a real issue from the stale taskKey before launch.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
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

vi.mock("../services/k8s-job-liveness.ts", () => ({
  listLiveAgentJobRunIds: vi.fn(async () => null),
  listAgentJobRunStatuses: vi.fn(async () => null),
  readAgentJobRunStatusByName: vi.fn(async () => null),
  deleteAgentJobsForRun: vi.fn(async () => 1),
  hasActiveJobForAgent: vi.fn(async () => false),
  captureAgentJobFailureDiagnostics: vi.fn(async () => null),
}));

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
    `Skipping dependabot stale-wake backfill tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToSettle(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) {
      await heartbeat.drainInFlightExecutions(timeoutMs);
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat dependabot stale-wake backfill (BLO-16446)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const allowPenstockGate = {
    checkAdapter: async () => ({ allow: true as const }),
    _resetForTesting: () => {},
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dependabot-stale-wake-");
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

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Stale Wake Co",
      issuePrefix: `SW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Release Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedStaleQueuedRun(input: { companyId: string; agentId: string; taskKey: string }) {
    const wakeupId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "github_dependabot_alert",
      status: "queued",
      runId,
      requestedByActorType: "system",
      requestedByActorId: null,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: wakeupId,
      // Exactly the pre-BLO-16319-fix shape: taskKey survives, nothing else.
      contextSnapshot: {
        taskKey: input.taskKey,
        wakeReason: "github_dependabot_alert",
        wakeSource: "automation",
        wakeTriggerDetail: "system",
      },
    });
    return runId;
  }

  it("backfills a durable diagnostic issue and sets PAPERCLIP_TASK_ID instead of launching unscoped", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const taskKey = "github-dependabot:Blockcast/magma#1538";
    const runId = await seedStaleQueuedRun({ companyId, agentId, taskKey });

    let capturedContext: Record<string, unknown> | undefined;
    mockAdapterExecute.mockImplementation(async (args: { context: Record<string, unknown> }) => {
      capturedContext = args.context;
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

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId);

    // The adapter must have been launched with a real issueId in context —
    // this is what packages/adapters/*/src/server/execute.ts turns into
    // env.PAPERCLIP_TASK_ID.
    expect(capturedContext).toBeDefined();
    const issueId = capturedContext?.issueId as string | undefined;
    expect(typeof issueId).toBe("string");

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId!));
    expect(issue).toBeTruthy();
    expect(issue!.companyId).toBe(companyId);
    expect(issue!.assigneeAgentId).toBe(agentId);
    expect(issue!.originKind).toBe("github_dependabot_webhook_diagnostic");
    expect(issue!.title).toContain("Blockcast/magma");
    expect(issue!.description).toContain("github-dependabot:Blockcast/magma#1538");
    expect(issue!.description).toContain("https://github.com/Blockcast/magma/security/dependabot/1538");

    // The run row itself must be patched so a retry/resume also carries it.
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect((run!.contextSnapshot as Record<string, unknown>).issueId).toBe(issueId);
  });

  it("reuses a real alert issue over a diagnostic when a fresh redelivery already scoped it", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const taskKey = "github-dependabot:Blockcast/magma#1538";

    // Simulate: after the BLO-16319 fix shipped, a `reintroduced` redelivery
    // for this exact alert already created the real, fully-detailed issue.
    const realIssueId = randomUUID();
    await db.insert(issues).values({
      id: realIssueId,
      companyId,
      title: "Dependabot high alert: vitest in Blockcast/magma#1538",
      description: "Full alert body from the live webhook payload.",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: "SW-1",
      originKind: "github_dependabot_alert",
      originId: taskKey,
      originFingerprint: taskKey,
    });

    const runId = await seedStaleQueuedRun({ companyId, agentId, taskKey });

    let capturedContext: Record<string, unknown> | undefined;
    mockAdapterExecute.mockImplementation(async (args: { context: Record<string, unknown> }) => {
      capturedContext = args.context;
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

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId);

    expect(capturedContext?.issueId).toBe(realIssueId);

    // No diagnostic stand-in should have been created alongside the real issue.
    const diagnostics = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "github_dependabot_webhook_diagnostic"));
    expect(diagnostics).toHaveLength(0);
  });
});

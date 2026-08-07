import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

const FALSE_TIMEOUT_ADAPTER = "false_timeout_persistence_test";
const EMPTY_RESULT_ADAPTER = "empty_result_persistence_test";
const EMPTY_RESULT_MESSAGE = "Agent exited successfully but produced no result";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat timeout outcome persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-timeout-outcome-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);

    const testEnvironment = (adapterType: string) => async () => ({
      adapterType,
      status: "pass" as const,
      checks: [],
      testedAt: new Date().toISOString(),
    });

    registerServerAdapter({
      type: FALSE_TIMEOUT_ADAPTER,
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: true,
        errorMessage: "Timed out after 300s",
        errorCode: "timeout",
        resultJson: null,
      }),
      testEnvironment: testEnvironment(FALSE_TIMEOUT_ADAPTER),
    });
    registerServerAdapter({
      type: EMPTY_RESULT_ADAPTER,
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        resultJson: null,
      }),
      testEnvironment: testEnvironment(EMPTY_RESULT_ADAPTER),
    });
  }, 120_000);

  afterAll(async () => {
    unregisterServerAdapter(FALSE_TIMEOUT_ADAPTER);
    unregisterServerAdapter(EMPTY_RESULT_ADAPTER);
    await cleanupHeartbeatTestState(db, heartbeat, {
      errorLabel: "timeout outcome persistence cleanup",
      drainTimeoutMs: 30_000,
    });
    await tempDb?.cleanup();
  });

  async function seedAgent(adapterType: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Timeout outcome test",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Timeout outcome ${agentId.slice(0, 8)}`,
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: { timeoutSec: 300 },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  async function getWake(wakeupRequestId: string | null) {
    expect(wakeupRequestId).not.toBeNull();
    return await db
      .select({
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId!))
      .then((rows) => rows[0] ?? null);
  }

  it("persists the exact exit-zero timeout contradiction as success", async () => {
    const agentId = await seedAgent(FALSE_TIMEOUT_ADAPTER);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const persistedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(persistedRun).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      error: null,
      errorCode: null,
    });
    expect(persistedRun?.resultJson).toMatchObject({
      stopReason: "completed",
      timeoutFired: false,
      timeoutConfigured: true,
      effectiveTimeoutSec: 300,
    });
    await expect(getWake(persistedRun?.wakeupRequestId ?? null)).resolves.toEqual({
      status: "completed",
      error: null,
    });
  });

  it("derives empty-result status and error fields before persistence", async () => {
    const agentId = await seedAgent(EMPTY_RESULT_ADAPTER);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const persistedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(persistedRun).toMatchObject({
      status: "failed",
      exitCode: 0,
      error: EMPTY_RESULT_MESSAGE,
      errorCode: "EMPTY_RESULT",
    });
    expect(persistedRun?.resultJson).toMatchObject({
      stopReason: "adapter_failed",
      timeoutFired: false,
      errorCode: "EMPTY_RESULT",
      errorMessage: EMPTY_RESULT_MESSAGE,
    });
    await expect(getWake(persistedRun?.wakeupRequestId ?? null)).resolves.toEqual({
      status: "failed",
      error: EMPTY_RESULT_MESSAGE,
    });
  });
});

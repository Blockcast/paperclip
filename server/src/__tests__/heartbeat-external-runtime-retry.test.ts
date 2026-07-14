import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  externalRuntimeReservations,
  heartbeatRuns,
} from "@paperclipai/db";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { heartbeatService } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";

const mockAdapterExecute = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres external-runtime retry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat external-runtime retry ownership", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-external-runtime-retry-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: {
        checkAdapter: async () => ({ allow: true }),
        _resetForTesting() {},
      },
    });
  }, 30_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    await cleanupHeartbeatTestState(db, heartbeat);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("re-arms ownership and persists metadata for a replacement Job after ccrotate throttle", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const jobName = "agent-claude-external-runtime-retry";

    await db.insert(companies).values({
      id: companyId,
      name: "External Runtime Retry Co",
      issuePrefix: "ERR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Claude K8s",
      role: "engineer",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: {},
    });

    mockAdapterExecute.mockImplementation(async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      const attempt = mockAdapterExecute.mock.calls.length;
      await ctx.onMeta?.({
        adapterType: "claude_k8s",
        command: `kubectl job/${jobName}`,
      });
      await ctx.onExternalRuntimeLaunched?.({
        jobName,
        jobUid: `job-uid-${attempt}`,
      });

      if (attempt === 1) {
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          errorMessage: null,
          summary: "provider throttled before progress",
          resultJson: { api_error_status: 429, retry_after_seconds: 0 },
          usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
          provider: "test",
          model: "test-model",
        };
      }

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "replacement Job completed",
        resultJson: { ok: true },
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    await heartbeat.__test_executeRunForTesting(runId);

    const run = await db
      .select({ status: heartbeatRuns.status, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    const reservation = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, runId))
      .then((rows) => rows[0]);

    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
    expect(run).toMatchObject({ status: "succeeded", error: null });
    expect(reservation).toMatchObject({
      expectedJobName: jobName,
      jobName,
      jobUid: "job-uid-2",
    });
    const reservationIds = mockAdapterExecute.mock.calls.map(
      ([ctx]) => (ctx as AdapterExecutionContext).externalRuntime?.reservationId,
    );
    expect(new Set(reservationIds)).toEqual(new Set([reservation.id]));
  }, 30_000);
});

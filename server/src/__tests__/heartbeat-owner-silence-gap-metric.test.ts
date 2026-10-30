// BLO-49987 / BLO-50192: since #3092 the run's owner, not the reconciler,
// finalizes a succeeded external-lifecycle Job inside the stale window. The
// silence-gap histogram was observed only on the reconciler and cancel paths,
// so its `succeeded` population went to zero fleet-wide on rollout and
// `PaperclipReaperSignalMissing` fired. This drives the REAL owner finalization
// through `invoke` and pins that it observes exactly once.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import * as metricsModule from "../services/metrics.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { waitForRunToFinish } from "./helpers/wait-for-run-to-finish.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("../services/metrics.js", async () => {
  const actual = await vi.importActual<typeof import("../services/metrics.js")>("../services/metrics.js");
  return {
    ...actual,
    recordExternalLifecycleRunSilenceGap: vi.fn(actual.recordExternalLifecycleRunSilenceGap),
  };
});

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
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "ok",
        resultJson: { result: "done" },
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres owner silence-gap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("owner finalization observes the silence-gap histogram (BLO-50192)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const spy = vi.mocked(metricsModule.recordExternalLifecycleRunSilenceGap);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-owner-silence-gap-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    spy.mockClear();
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function runOnce(adapterType: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SilenceGap",
      role: "engineer",
      status: "active",
      adapterType,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: { async checkAdapter() { return { allow: true }; }, _resetForTesting() {} },
    });
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    return waitForRunToFinish(heartbeat, run!.id);
  }

  it("records one succeeded observation for an external-lifecycle run", async () => {
    const finished = await runOnce("claude_k8s");
    expect(finished?.status).toBe("succeeded");
    const calls = spy.mock.calls.filter(([input]) => (input.run as { id?: string }).id === finished!.id);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ adapter: "claude_k8s", status: "succeeded" });
  }, 60_000);

  // Control: the guard discriminates. A local adapter has no external lifecycle.
  it("records nothing for a local adapter", async () => {
    const finished = await runOnce("claude_local");
    expect(finished?.status).toBe("succeeded");
    expect(spy).not.toHaveBeenCalled();
  }, 60_000);
});

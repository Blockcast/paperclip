// BLO-49987 / BLO-50192: since #3092 the run's owner, not the reconciler,
// finalizes a succeeded external-lifecycle Job inside the stale window. The
// silence-gap histogram was observed only on the reconciler and cancel paths,
// so its `succeeded` population went to zero fleet-wide on rollout and
// `PaperclipReaperSignalMissing` fired. This drives the REAL owner finalization
// through `invoke` and pins that it observes exactly once.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import * as metricsModule from "../services/metrics.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
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
  // `runOnce` mints a service per case, so cleanup has no single handle to
  // drain. Collect them (as heartbeat-workspace-finalize-branch does).
  const heartbeatServices = new Set<ReturnType<typeof heartbeatService>>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-owner-silence-gap-");
    db = createDb(tempDb.connectionString);
  });

  // PEN-5300: this suite used to `spy.mockClear()` and then issue a bare
  // `TRUNCATE TABLE "companies" CASCADE` directly. Both halves were racy
  // against the fire-and-forget `executeRun` tail this suite deliberately
  // drives, and the two halves produced two different red shards:
  //
  //  - TRUNCATE takes AccessExclusiveLock on the whole cascade while a
  //    still-finalizing run holds RowShareLock on a child table -> 40P01
  //    deadlock (run 41421341606). This is the v513 saga exactly; see the
  //    `inFlightExecutions` comment in heartbeat.ts.
  //  - `mockClear()` before the tail had landed let the PREVIOUS case's
  //    observation arrive afterwards and count against the NEXT case's spy
  //    (run 41446392171: "records nothing for a local adapter" saw one call
  //    carrying `adapter: "claude_k8s"`).
  //
  // `cleanupHeartbeatTestState` is the canonical sequence for any suite that
  // exercises heartbeatService: cancel active runs, await
  // `drainInFlightExecutions`, then TRUNCATE under a transaction-scoped
  // advisory lock. Clearing the spy after the drain closes the second half.
  afterEach(async () => {
    const servicesToDrain = [...heartbeatServices];
    heartbeatServices.clear();
    await cleanupHeartbeatTestState(db, {
      async drainInFlightExecutions(timeoutMs) {
        await Promise.all(servicesToDrain.map((service) => service.drainInFlightExecutions(timeoutMs)));
      },
    }, { errorLabel: "owner silence-gap cleanup", drainTimeoutMs: 30_000 });
    spy.mockClear();
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
    heartbeatServices.add(heartbeat);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    // PEN-5300: explicit, generous budget. The default is 5s, but this suite
    // drives a REAL finalization whose tail alone measured 1-3s locally, so on
    // a loaded 6-way-sharded runner the default is marginal and times out --
    // a third way for this file to red-light a shard it has nothing to do
    // with. Per BLO-33449 this budget is wall-clock, not a behavioural
    // assertion, so widening it hides no regression; the `it` timeout below
    // remains the real bound.
    const finished = await waitForRunToFinish(heartbeat, run!.id, 25_000);
    // PEN-5300: `waitForRunToFinish` polls run STATUS, and status is written by
    // the `setRunStatusIfRunning` CAS that elects the single finalizer -- the
    // whole finalization tail, including this suite's
    // `recordExternalLifecycleRunSilenceGap` call, runs AFTER that write. So a
    // terminal status is not evidence the observation has happened, and
    // asserting on the spy here is a race the test loses under load
    // ("expected [] to have a length of 1"). The helper cannot close this gap:
    // the status write has to come first for the election to work. Draining the
    // fire-and-forget `executeRun` promise is what makes the tail observable.
    await heartbeat.drainInFlightExecutions(30_000);
    return finished;
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

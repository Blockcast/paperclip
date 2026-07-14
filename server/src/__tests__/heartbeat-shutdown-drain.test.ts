import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat shutdown-drain tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// BLO-12563: on a worker-pod roll (SIGTERM) the shutdown handler calls
// stopDispatch() then drainInFlightRunSetup(). The drain must block ONLY on the
// runs that would otherwise be minted `process_lost` by the next pod's reaper:
// an external-lifecycle (k8s Job) run that has been claimed (`status: running`)
// but has not yet persisted its Job identity (`externalRunId` still NULL). Once
// the launching adapter calls back to record the Job identity, the run is
// re-adoptable and the drain completes. These tests pin that contract: the
// drain blocks on exactly the setup-window runs and nothing else.
describeEmbeddedPostgres("heartbeat shutdown drain (BLO-12563)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-drain-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    // FK order: runs reference agents reference companies.
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRun(input: {
    adapterType: string;
    status?: "running" | "queued" | "succeeded";
    externalRunId?: string | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "DrainTest Co",
      issuePrefix: `DR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "DrainTestAgent",
      role: "engineer",
      status: "active",
      adapterType: input.adapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: input.status ?? "running",
        externalRunId: input.externalRunId ?? null,
        contextSnapshot: {},
      })
      .returning();
    return { companyId, agentId, runId: run!.id };
  }

  it("blocks while an external-lifecycle run is mid-setup, then drains once its Job identity persists", async () => {
    const heartbeat = heartbeatService(db);
    // A claude_k8s run claimed (running) but not yet past Job launch: this is
    // the exact row the next pod's reaper would mint `process_lost`.
    const { runId } = await seedRun({ adapterType: "claude_k8s", externalRunId: null });

    // With a short budget the drain gives up rather than blocking forever, and
    // reports the run still mid-setup.
    const timedOut = await heartbeat.drainInFlightRunSetup(50);
    expect(timedOut).toEqual({ drained: false, remaining: 1 });

    // The launching adapter records the Job identity (externalRunId) — the run
    // is now re-adoptable by the next pod, so the drain completes cleanly.
    await db
      .update(heartbeatRuns)
      .set({ externalRunId: `paperclip-run-${runId.slice(0, 8)}` })
      .where(eq(heartbeatRuns.id, runId));

    const drained = await heartbeat.drainInFlightRunSetup(50);
    expect(drained).toEqual({ drained: true, remaining: 0 });
  });

  it("does not block on a local (non-external-lifecycle) run that is mid-setup", async () => {
    const heartbeat = heartbeatService(db);
    // A codex_local run has no k8s Job; the reaper recovers it by process
    // liveness, not Job re-adoption, so it is not part of the setup-window drain.
    await seedRun({ adapterType: "codex_local", status: "running", externalRunId: null });

    const result = await heartbeat.drainInFlightRunSetup(50);
    expect(result).toEqual({ drained: true, remaining: 0 });
  });

  it("does not block on a queued external-lifecycle run (only claimed runs are the setup window)", async () => {
    const heartbeat = heartbeatService(db);
    // A queued run has not been claimed; it carries a durable row the next pod
    // dispatches fresh. Only `status: running` rows are the setup window.
    await seedRun({ adapterType: "claude_k8s", status: "queued", externalRunId: null });

    const result = await heartbeat.drainInFlightRunSetup(50);
    expect(result).toEqual({ drained: true, remaining: 0 });
  });

  it("stopDispatch is idempotent and drain returns immediately when nothing is mid-setup", async () => {
    const heartbeat = heartbeatService(db);
    // Idempotent: calling stopDispatch twice must not throw.
    heartbeat.stopDispatch();
    heartbeat.stopDispatch();

    const result = await heartbeat.drainInFlightRunSetup(50);
    expect(result).toEqual({ drained: true, remaining: 0 });
  });
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

/**
 * BLO-19085: an agent must never be latched into `status: "error"` carrying
 * `errorReason: null`.
 *
 * That pairing is the worst state this service can produce — the agent stops
 * working and the record says nothing about why, so no dashboard surfaces it
 * and no operator can act. OCMBackendEngineer sat that way for ~15h on
 * 2026-07-30: its run recorded "External lifecycle Job is missing while
 * heartbeat run is still running" (`job_missing`), and the very next frame
 * `finalizeAgentStatus` was called without that reason and wrote null over it.
 *
 * Two guarantees are covered here:
 *   1. The reaper propagates the reason it already computed.
 *   2. Even with no reason at all, the write synthesizes one naming the run —
 *      so a future caller that forgets still leaves a trail.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-error-reason tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent error status always carries a reason", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-agent-error-reason-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Seed a run that the reaper will classify as process_lost: status `running`,
   * a start time well past the stale threshold, and no live process to reattach.
   */
  async function seedStaleRunningRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Stranded",
      role: "engineer",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      status: "running",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      startedAt: longAgo,
      processStartedAt: longAgo,
      createdAt: longAgo,
      // The reaper's staleness gate keys on `updatedAt` for local-child
      // adapters (external-lifecycle runs use activity time instead), so this
      // has to be backdated too or the run is never considered stale.
      updatedAt: longAgo,
      contextSnapshot: { wakeReason: "heartbeat_timer" },
    });

    return { companyId, agentId, runId };
  }

  const readAgent = async (agentId: string) =>
    db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);

  it("records a non-null errorReason when the reaper latches an agent into error", async () => {
    const { agentId, runId } = await seedStaleRunningRun();
    const heartbeat = heartbeatService(db);

    await heartbeat.reapOrphanedRuns({
      staleThresholdMs: 1_000,
      suppressDispatchAfterReap: true,
    });

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    const agent = await readAgent(agentId);

    // Guard the premise: if the reaper did not actually finalize this run into
    // a failed terminal state, the assertion below would pass vacuously.
    expect(run?.status).toBe("failed");
    expect(run?.error).toBeTruthy();

    expect(agent?.status).toBe("error");
    // The core invariant.
    expect(agent?.errorReason).not.toBeNull();
    expect((agent?.errorReason ?? "").trim()).not.toBe("");
    // Stronger than non-null: it must be the diagnosis the run already held,
    // not a synthesized placeholder. Before the fix this call site passed no
    // reason at all and the column was written null.
    expect(agent?.errorReason).toContain("Process lost");
    expect(run?.error).toContain("Process lost");
    expect(agent?.errorReason).not.toContain("supplied no reason");
  });

  it("never leaves status=error paired with errorReason=null for any reaped run", async () => {
    // Broader sweep: whatever terminal classification the reaper picks, the
    // pairing under test must not occur.
    const seeded = await Promise.all([seedStaleRunningRun(), seedStaleRunningRun()]);
    const heartbeat = heartbeatService(db);

    await heartbeat.reapOrphanedRuns({
      staleThresholdMs: 1_000,
      suppressDispatchAfterReap: true,
    });

    const observed = await Promise.all(seeded.map(({ agentId }) => readAgent(agentId)));

    // Guard the premise: without this, an assertion loop over zero
    // error-status agents would pass while proving nothing.
    expect(
      observed.filter((agent) => agent?.status === "error").length,
      "expected the reaper to latch both seeded agents into error",
    ).toBe(seeded.length);

    for (const agent of observed) {
      expect(agent?.errorReason, `agent ${agent?.id} is in error with no reason`).toBeTruthy();
    }
  });
});

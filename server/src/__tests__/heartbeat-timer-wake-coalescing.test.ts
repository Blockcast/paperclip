import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres timer wake coalescing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const allowPenstockGate = {
  checkAdapter: async () => ({ allow: true as const }),
  _resetForTesting: () => {},
};

describeEmbeddedPostgres("heartbeat timer wake coalescing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-timer-wake-coalescing-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("coalesces timer wakes into an existing heartbeat task row", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const existingRunId = randomUUID();
    const existingWakeupId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Timer Co",
      status: "active",
      issuePrefix: "TIM",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timer Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: existingWakeupId,
      companyId,
      agentId,
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
    });
    await db.insert(heartbeatRuns).values({
      id: existingRunId,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: existingWakeupId,
      contextSnapshot: {
        wakeReason: "heartbeat_timer",
        wakeSource: "timer",
        taskKey: "__heartbeat__",
      },
    });

    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowPenstockGate,
      skipQueuedRunDispatch: true,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
      contextSnapshot: {
        source: "scheduler",
        reason: "interval_elapsed",
        now: "2026-06-12T20:00:00.000Z",
      },
    });

    expect(run?.id).toBe(existingRunId);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.contextSnapshot).toMatchObject({
      taskKey: "__heartbeat__",
      wakeReason: "heartbeat_timer",
      wakeSource: "timer",
    });

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups.map((wakeup) => wakeup.status).sort()).toEqual(["coalesced", "queued"]);
  });

  // -------------------------------------------------------------------------
  // PEN-1995: a running run that has overrun its heartbeat interval must stop
  // speaking for later timer wakes.
  //
  // These two cases pin the boundary from both sides. The run is deliberately
  // registered via `__test_unsafelyTrackActiveRunExecution` so it is NOT a
  // zombie — otherwise `filterZombieCoalesceTarget` would null it first and
  // the assertion would pass for a reason that has nothing to do with this fix.
  // -------------------------------------------------------------------------
  async function seedAgentWithRunningRun(input: {
    intervalSec: number;
    runStartedAt: Date;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runningRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Overrun Co",
      status: "active",
      issuePrefix: "OVR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Overrun Agent",
      role: "engineer",
      status: "running",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: input.intervalSec, wakeOnDemand: true },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runningRunId,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "running",
      startedAt: input.runStartedAt,
      // The signature of the stall this fix exists for: registered in
      // activeRunExecutions before the adapter invoke, so it never produced
      // output and never advanced past the pre-exec prefix.
      lastOutputSeq: 1,
      contextSnapshot: {
        wakeReason: "heartbeat_timer",
        wakeSource: "timer",
        taskKey: "__heartbeat__",
      },
    });

    return { companyId, agentId, runningRunId };
  }

  async function fireTimerWake(heartbeat: ReturnType<typeof heartbeatService>, agentId: string) {
    return heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
      contextSnapshot: {
        source: "scheduler",
        reason: "interval_elapsed",
        // Only consulted on the mint path (resolveResponsibleUserIdForRunSeed
        // reads it first). The coalesce path never reaches it, so this does
        // not influence the branch under test — it just lets the fallthrough
        // actually produce a run instead of 422-ing on an unseeded fixture.
        responsibleUserId: "overrun-test-user",
      },
    });
  }

  it("mints a new run instead of coalescing into a tracked run that has overrun its interval", async () => {
    // 3600s interval => 90 min budget (the floor). Started 4 h ago, so it has
    // already swallowed roughly three wakes it never serviced.
    const { agentId, runningRunId } = await seedAgentWithRunningRun({
      intervalSec: 3600,
      runStartedAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowPenstockGate,
      skipQueuedRunDispatch: true,
    });
    // Not a zombie: this is what makes the assertion attributable to this fix.
    heartbeat.__test_unsafelyTrackActiveRunExecution(runningRunId);

    const run = await fireTimerWake(heartbeat, agentId);

    expect(run).not.toBeNull();
    expect(run?.id).not.toBe(runningRunId);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    // Non-terminating: the overrunning run is untouched and still free to
    // finish and deliver. This fix only removes it as a coalesce target.
    const stalled = runs.find((candidate) => candidate.id === runningRunId);
    expect(stalled?.status).toBe("running");
  });

  it("still coalesces into a tracked running run that is within its interval budget", async () => {
    // Control for the case above: same setup, same tracking, only the age
    // differs. Without this, the test above would also pass if the filter
    // fired unconditionally on every running run.
    const { agentId, runningRunId } = await seedAgentWithRunningRun({
      intervalSec: 3600,
      runStartedAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowPenstockGate,
      skipQueuedRunDispatch: true,
    });
    heartbeat.__test_unsafelyTrackActiveRunExecution(runningRunId);

    const run = await fireTimerWake(heartbeat, agentId);

    expect(run?.id).toBe(runningRunId);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
  });

  it("holds a fast-cadence agent to the 90 min floor rather than 1.5x its interval", async () => {
    // 30s interval * 1.5 = 45s, which is below the measured p50 run duration.
    // Without the floor this run (20 min old) would be filtered and the agent
    // would mint a fresh run on nearly every wake.
    const { agentId, runningRunId } = await seedAgentWithRunningRun({
      intervalSec: 30,
      runStartedAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowPenstockGate,
      skipQueuedRunDispatch: true,
    });
    heartbeat.__test_unsafelyTrackActiveRunExecution(runningRunId);

    const run = await fireTimerWake(heartbeat, agentId);

    expect(run?.id).toBe(runningRunId);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  filterLaunchStalledCoalesceTarget,
  heartbeatService,
  isLaunchStalledRun,
} from "../services/heartbeat.ts";

// ---------------------------------------------------------------------------
// PEN-1995 — a claude_local run that stalls between claim and adapter spawn
// takes its agent's whole heartbeat cadence down with it.
//
// `executeRun` adds the run to `activeRunExecutions` at claim, before the
// adapter invoke. A run that wedges in that window is therefore tracked in
// memory (so `isZombieRun` says "live") while having flushed at most the
// pre-exec prefix. It is excluded from the reaper at any age, and every later
// `__heartbeat__` timer wake coalesces into it — a bare UPDATE that mints no
// run, stamps no `lastHeartbeatAt`, and refreshes `updatedAt`, which re-arms
// the shield. Measured on Summarizer `9d5bc03e`: 11.87 h wedged, zero runs
// started behind it, cadence restored one interval after a worker restart.
//
// The fix filters such a target out of the coalesce decision only. The stalled
// run is not killed, not finalized, not touched.
// ---------------------------------------------------------------------------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres launch-stall coalescing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const allowPenstockGate = {
  checkAdapter: async () => ({ allow: true as const }),
  _resetForTesting: () => {},
};

const HOUR_MS = 60 * 60 * 1000;

describe("isLaunchStalledRun", () => {
  const NOW = Date.parse("2026-08-22T06:00:00.000Z");
  const stalled = {
    status: "running",
    lastOutputSeq: 1,
    lastOutputAt: new Date(NOW - 2 * HOUR_MS),
    lastUsefulActionAt: null,
    startedAt: new Date(NOW - 2 * HOUR_MS),
  };

  it("flags a running run frozen at the pre-exec prefix past the stale floor", () => {
    expect(isLaunchStalledRun(stalled, NOW)).toBe(true);
  });

  it("does NOT flag a run that emitted past the pre-exec prefix, however quiet", () => {
    // The 45-minute hard-stale floor exists to protect long, quiet, productive
    // runs. Silence alone must never be enough.
    expect(isLaunchStalledRun({ ...stalled, lastOutputSeq: 12 }, NOW)).toBe(false);
  });

  it("does NOT flag a run still inside the launch window", () => {
    const young = new Date(NOW - 2 * 60 * 1000);
    expect(
      isLaunchStalledRun({ ...stalled, lastOutputAt: young, startedAt: young }, NOW),
    ).toBe(false);
  });

  it("uses the newest stamp, not the first non-null (BLO-20775)", () => {
    // lastUsefulActionAt is present but stale while lastOutputAt is fresh; a
    // first-non-null chain would wrongly call this stalled.
    expect(
      isLaunchStalledRun(
        {
          ...stalled,
          lastUsefulActionAt: new Date(NOW - 3 * HOUR_MS),
          lastOutputAt: new Date(NOW - 60 * 1000),
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("ignores non-running rows", () => {
    for (const status of ["queued", "scheduled_retry", "failed", "completed"]) {
      expect(isLaunchStalledRun({ ...stalled, status }, NOW)).toBe(false);
    }
  });

  it("treats seq 0 (nothing written at all) as stalled once past the floor", () => {
    expect(isLaunchStalledRun({ ...stalled, lastOutputSeq: 0 }, NOW)).toBe(true);
  });

  it("filterLaunchStalledCoalesceTarget nulls a stalled target and passes others", () => {
    expect(filterLaunchStalledCoalesceTarget(stalled, NOW)).toBeNull();
    expect(filterLaunchStalledCoalesceTarget(null, NOW)).toBeNull();
    const queued = { ...stalled, status: "queued" };
    expect(filterLaunchStalledCoalesceTarget(queued, NOW)).toBe(queued);
  });
});

describeEmbeddedPostgres("heartbeat launch-stalled coalescing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-launch-stalled-coalesce-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentWithRunningHeartbeatRun(input: {
    lastOutputSeq: number;
    silentForMs: number;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runningRunId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    const signalAt = new Date(Date.now() - input.silentForMs);

    await db.insert(companies).values({
      id: companyId,
      name: "Stall Co",
      status: "active",
      issuePrefix: "STL",
      requireBoardApprovalForNewAgents: false,
      // Minting a run (rather than coalescing) resolves a responsible user, so
      // the fixture needs an owner the seed can land on.
      defaultResponsibleUserId: ownerUserId,
    });

    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Stall Agent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true },
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
      startedAt: signalAt,
      lastOutputAt: signalAt,
      lastOutputSeq: input.lastOutputSeq,
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

    // The whole point: `executeRun` tracks the run at claim, so the existing
    // zombie filter sees a live execution and passes the target through. Without
    // this the test would exercise the zombie path and pass unfixed.
    heartbeat.__test_unsafelyTrackActiveRunExecution(runningRunId);

    return { agentId, runningRunId, heartbeat };
  }

  function fireTimerWake(heartbeat: ReturnType<typeof heartbeatService>, agentId: string) {
    return heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
      contextSnapshot: {
        source: "scheduler",
        reason: "interval_elapsed",
      },
    });
  }

  it("mints a new run instead of absorbing the timer wake into a launch-stalled run", async () => {
    const { agentId, runningRunId, heartbeat } = await seedAgentWithRunningHeartbeatRun({
      lastOutputSeq: 1,
      silentForMs: 2 * HOUR_MS,
    });

    const run = await fireTimerWake(heartbeat, agentId);

    expect(run?.id).not.toBe(runningRunId);
    expect(run?.status).toBe("queued");

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    // The stalled run is left strictly alone — this is not a kill path.
    const stalledAfter = runs.find((row) => row.id === runningRunId);
    expect(stalledAfter?.status).toBe("running");

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups.every((wakeup) => wakeup.status !== "coalesced")).toBe(true);
  });

  it("still coalesces into a quiet run that got past the pre-exec prefix", async () => {
    const { agentId, runningRunId, heartbeat } = await seedAgentWithRunningHeartbeatRun({
      lastOutputSeq: 12,
      silentForMs: 2 * HOUR_MS,
    });

    const run = await fireTimerWake(heartbeat, agentId);

    expect(run?.id).toBe(runningRunId);
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
  });

  it("still coalesces into a run that is only just launching", async () => {
    const { agentId, runningRunId, heartbeat } = await seedAgentWithRunningHeartbeatRun({
      lastOutputSeq: 1,
      silentForMs: 2 * 60 * 1000,
    });

    const run = await fireTimerWake(heartbeat, agentId);

    expect(run?.id).toBe(runningRunId);
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
  });
});

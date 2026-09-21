import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
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
import { heartbeatService } from "../services/heartbeat.js";
import type {
  PenstockAvailabilityGate,
  PenstockAvailabilityGateCheckInput,
  PenstockAvailabilityGateResult,
} from "../services/penstock-availability-gate.js";

/**
 * Capacity unavailable — the shape that POSTPONES a wake behind a committed
 * `scheduled_retry` run rather than declining it, which is why that path
 * deliberately writes no `durableSkipReason` and used to write no timer row
 * either.
 */
function capacityDenyingGate(): PenstockAvailabilityGate {
  return {
    async checkAdapter(_input: PenstockAvailabilityGateCheckInput): Promise<PenstockAvailabilityGateResult> {
      return {
        allow: false,
        provider: "anthropic",
        reason: "penstock.model_capacity_unavailable",
        model: "claude-test",
        resumeAt: new Date("2026-09-19T11:15:00.000Z"),
        retryAfterSeconds: 900,
      };
    },
    _resetForTesting() {},
  };
}

/**
 * BLO-34578 — the interval timer must be reachable for an agent that is busy
 * with event-driven work.
 *
 * The timer loop used to take its baseline from `agents.lastHeartbeatAt`, which
 * is stamped by EVERY run's status transition (`finalizeAgentStatus`), not only
 * by timer ticks. So `now - lastHeartbeatAt >= intervalSec` was really asking
 * "has this agent had NO run of ANY KIND for intervalSec?", and any agent whose
 * event-driven inter-run gap was shorter than its interval could never satisfy
 * it. Measured on production 2026-09-19: the PR reviewer took a run every 2-5
 * minutes and logged ZERO timer wakes in 9h at intervalSec=3600, while its
 * oldest assigned `todo` aged to 12 days. The timer is the only path that
 * sweeps an agent's already-assigned backlog, so the effect ran backwards --
 * the busier an agent was, the less its own queue was ever swept.
 *
 * The four cases below are the whole contract: the timer fires off its own
 * history, it does not re-fire off that same history, an agent with no timer
 * history fires once and thereby acquires one, and the provider-capacity gate —
 * the one timer exit that used to write no history at all — records its tick so
 * a capacity outage cannot make the scheduler re-enter it every 30 seconds.
 */

const INTERVAL_SEC = 600;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres timer-baseline tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("timer baseline is the last timer tick, not the last run of any kind", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-timer-baseline-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedTimerAgent(input: {
    companyId: string;
    agentId: string;
    /**
     * Stands in for the event-driven churn: a webhook wake landing seconds ago
     * leaves this column fresh even though no timer tick has run for hours.
     */
    lastHeartbeatAt: Date;
    createdAt: Date;
  }) {
    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: "PR Reviewer",
      role: "engineer",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: INTERVAL_SEC,
          wakeOnDemand: true,
          maxConcurrentRuns: 4,
        },
      },
      permissions: {},
      lastHeartbeatAt: input.lastHeartbeatAt,
      createdAt: input.createdAt,
      updatedAt: input.lastHeartbeatAt,
    });
  }

  /**
   * Seeds the record a timer tick leaves behind. Every timer tick writes one of
   * these -- dispatched, skipped by a circuit breaker, blocked by the daily cap,
   * or deferred by the provider-capacity gate -- which is what makes this table
   * an exact record of when the timer last ran, with no extra write site to keep
   * in sync.
   */
  async function seedTimerWakeupRequest(input: { companyId: string; agentId: string; requestedAt: Date }) {
    await db.insert(agentWakeupRequests).values({
      companyId: input.companyId,
      agentId: input.agentId,
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      status: "completed",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
      requestedAt: input.requestedAt,
      finishedAt: input.requestedAt,
      createdAt: input.requestedAt,
      updatedAt: input.requestedAt,
    });
  }

  async function countTimerWakeups(agentId: string) {
    const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    return rows.filter((row) => row.source === "timer").length;
  }

  async function countScheduledRetryRuns(agentId: string) {
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    return rows.filter((row) => row.status === "scheduled_retry").length;
  }

  it("fires when the last TIMER tick is older than the interval, even though lastHeartbeatAt is seconds old", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-09-19T11:00:00.000Z");

    await seedTimerAgent({
      companyId,
      agentId,
      // 30s ago: an ordinary webhook wake just finished.
      lastHeartbeatAt: new Date("2026-09-19T10:59:30.000Z"),
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    // 2h ago: the timer itself has not run since.
    await seedTimerWakeupRequest({
      companyId,
      agentId,
      requestedAt: new Date("2026-09-19T09:00:00.000Z"),
    });

    // This is the only case here that actually enqueues, so it is the only one
    // whose dispatch would keep writing heartbeat_run_events after the body
    // returns and race afterEach. The assertion below never depended on the
    // run being dispatched -- only on the scheduling decision.
    const result = await heartbeatService(db, { skipQueuedRunDispatch: true }).tickTimers(now);

    // Pre-fix this read `{ checked: 1, enqueued: 0 }` -- the fresh
    // `lastHeartbeatAt` swallowed the tick. Deleting the baseline change must
    // turn this assertion red.
    expect(result).toMatchObject({ checked: 1, enqueued: 1 });
    expect(await countTimerWakeups(agentId)).toBe(2);
  });

  it("does NOT re-fire while the last timer tick is inside the interval, however stale lastHeartbeatAt is", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-09-19T11:00:00.000Z");

    await seedTimerAgent({
      companyId,
      agentId,
      // Deliberately ancient: if the fix read this column at all it would fire.
      lastHeartbeatAt: new Date("2026-09-10T00:00:00.000Z"),
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    // 60s ago, well inside INTERVAL_SEC.
    await seedTimerWakeupRequest({
      companyId,
      agentId,
      requestedAt: new Date("2026-09-19T10:59:00.000Z"),
    });

    const result = await heartbeatService(db, { skipQueuedRunDispatch: true }).tickTimers(now);

    expect(result).toMatchObject({ enqueued: 0 });
    expect(await countTimerWakeups(agentId)).toBe(1);
  });

  it("fires for an agent that has never had a timer tick, however fresh lastHeartbeatAt is", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-09-19T11:00:00.000Z");

    await seedTimerAgent({
      companyId,
      agentId,
      lastHeartbeatAt: new Date("2026-09-19T10:59:30.000Z"),
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    // No timer wakeup rows at all. Falling back to `lastHeartbeatAt` here would
    // reproduce the original bug permanently: an agent busy from creation keeps
    // that column fresh forever, so it never fires, so it never writes the first
    // timer row, so the fallback never stops applying. `createdAt` fires once and
    // that tick's own row moves the agent into the timer-row regime for good.
    const result = await heartbeatService(db, { skipQueuedRunDispatch: true }).tickTimers(now);

    expect(result).toMatchObject({ checked: 1, enqueued: 1 });
    expect(await countTimerWakeups(agentId)).toBe(1);
  });

  it("records a timer tick that the provider-capacity gate defers, so it does not re-enter every pass", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const firstPass = new Date("2026-09-19T11:00:00.000Z");
    // Well inside INTERVAL_SEC of the first pass: the only thing that can stop a
    // second tick is the first one having moved the baseline.
    const secondPass = new Date("2026-09-19T11:01:00.000Z");

    await seedTimerAgent({
      companyId,
      agentId,
      lastHeartbeatAt: new Date("2026-09-19T10:59:30.000Z"),
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    await seedTimerWakeupRequest({
      companyId,
      agentId,
      requestedAt: new Date("2026-09-19T09:00:00.000Z"),
    });

    const service = heartbeatService(db, {
      skipQueuedRunDispatch: true,
      penstockAvailabilityGate: capacityDenyingGate(),
    });

    // The capacity gate postpones rather than declines: it commits a
    // `scheduled_retry` run and returns null, so the tick is not an enqueue.
    const first = await service.tickTimers(firstPass);
    expect(first).toMatchObject({ checked: 1, enqueued: 0 });
    // Deleting `writeTimerProviderCapacityDeferred` turns this red: the capacity
    // path is the one timer exit that writes no wakeup row of its own.
    expect(await countTimerWakeups(agentId)).toBe(2);

    const second = await service.tickTimers(secondPass);
    expect(second).toMatchObject({ checked: 1, enqueued: 0 });
    expect(await countTimerWakeups(agentId)).toBe(2);
    // The real cost of an un-advanced baseline: the scheduler re-enters the
    // capacity path every pass (30s in production) and each pass commits another
    // parked run, because a bare timer wake has no task key and cannot coalesce.
    expect(await countScheduledRetryRuns(agentId)).toBe(1);
  });
});

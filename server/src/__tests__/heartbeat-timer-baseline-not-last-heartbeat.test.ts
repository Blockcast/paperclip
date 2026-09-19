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
 * The three cases below are the whole contract: the timer fires off its own
 * history, it does not re-fire off that same history, and an agent with no
 * timer history still behaves exactly as it did before.
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
   * these -- dispatched, skipped by a circuit breaker, or blocked by the daily
   * cap -- which is what makes this table an exact record of when the timer
   * last ran, with no extra write site to keep in sync.
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

  it("falls back to lastHeartbeatAt for an agent that has never had a timer tick", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-09-19T11:00:00.000Z");

    await seedTimerAgent({
      companyId,
      agentId,
      lastHeartbeatAt: new Date("2026-09-19T10:59:30.000Z"),
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    // No timer wakeup rows at all -- a brand-new agent, or one whose history
    // has been pruned. Old behaviour must be preserved rather than firing
    // immediately on an empty history.

    const result = await heartbeatService(db, { skipQueuedRunDispatch: true }).tickTimers(now);

    expect(result).toMatchObject({ enqueued: 0 });
    expect(await countTimerWakeups(agentId)).toBe(0);
  });
});

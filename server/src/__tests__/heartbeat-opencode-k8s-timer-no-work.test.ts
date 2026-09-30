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
import {
  HEARTBEAT_TIMER_CHECKED_METRIC,
  HEARTBEAT_TIMER_ENQUEUED_METRIC,
  HEARTBEAT_TIMER_SCHEDULER_EXCLUSION_METRIC,
  renderMetrics,
} from "../services/metrics.js";

/**
 * Reads the unlabeled timer-loop counters (BLO-32269). Absolute values are
 * shared across tests in this file, so callers compare deltas around a single
 * `tickTimers` call rather than asserting a total.
 */
async function readTimerTickCounters(): Promise<{ checked: number; enqueued: number }> {
  const { body } = await renderMetrics();
  const read = (name: string) => {
    const match = new RegExp(`^${name} (\\S+)$`, "m").exec(body);
    if (!match) throw new Error(`${name} is absent from the exposition output`);
    return Number(match[1]);
  };
  return {
    checked: read(HEARTBEAT_TIMER_CHECKED_METRIC),
    enqueued: read(HEARTBEAT_TIMER_ENQUEUED_METRIC),
  };
}

/**
 * Sums every labeled series of the exclusion counter. Used to pin the negative
 * half of the BLO-32269 documented semantics: the exclusion counter cannot
 * explain a zero `checked`, because it is only ever incremented after it.
 */
async function readSchedulerExclusionTotal(): Promise<number> {
  const { body } = await renderMetrics();
  const pattern = new RegExp(`^${HEARTBEAT_TIMER_SCHEDULER_EXCLUSION_METRIC}\\{[^}]*\\} (\\S+)$`, "gm");
  let total = 0;
  for (const match of body.matchAll(pattern)) total += Number(match[1]);
  return total;
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres opencode_k8s timer no-work tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("opencode_k8s timer no-work suppression", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-opencode-k8s-timer-no-work-");
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

  async function seedOpencodeK8sTimerAgent(input: {
    companyId: string;
    agentId: string;
    lastHeartbeatAt: Date;
  }) {
    const issuePrefix = `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: "Staff Engineer",
      role: "engineer",
      status: "active",
      adapterType: "opencode_k8s",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
      lastHeartbeatAt: input.lastHeartbeatAt,
      createdAt: input.lastHeartbeatAt,
      updatedAt: input.lastHeartbeatAt,
    });

    return { issuePrefix };
  }

  async function saturateAgentConcurrency(input: {
    companyId: string;
    agentId: string;
    now: Date;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      lastOutputAt: new Date(),
      contextSnapshot: {
        taskKey: `issue:${randomUUID()}`,
        wakeReason: "test_busy_slot",
      },
      startedAt: input.now,
      updatedAt: input.now,
      createdAt: input.now,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId: input.companyId,
      agentId: input.agentId,
      runId,
      seq: 1,
      eventType: "adapter.invoke",
      stream: "system",
      level: "info",
      message: "adapter invocation",
      payload: {},
    });
  }

  it("skips opencode_k8s timer ticks when the agent has no assigned live work", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-05-25T20:30:00.000Z");
    const heartbeat = heartbeatService(db);

    await seedOpencodeK8sTimerAgent({
      companyId,
      agentId,
      lastHeartbeatAt: new Date("2026-05-25T20:28:00.000Z"),
    });
    await saturateAgentConcurrency({ companyId, agentId, now });

    const before = await readTimerTickCounters();
    const result = await heartbeat.tickTimers(now);

    expect(result).toMatchObject({ checked: 1, enqueued: 0, skipped: 1 });

    // BLO-32269 wiring check: the exported counters must advance by this very
    // pass's own numbers. This pass is the healthy-idle shape the pair exists
    // to name -- it examined a candidate and deliberately enqueued nothing, so
    // `checked` must move while `enqueued` stays put. Asserted against the real
    // tickTimers path rather than the recorder in isolation, because the
    // failure mode being guarded is the call sitting in the wrong place (e.g.
    // behind the `enqueued > 0` log gate, which would pin `checked` at zero).
    const after = await readTimerTickCounters();
    expect(after.checked - before.checked).toBe(result.checked);
    expect(after.enqueued - before.enqueued).toBe(result.enqueued);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.contextSnapshot).toMatchObject({ wakeReason: "test_busy_slot" });

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      source: "timer",
      triggerDetail: "system",
      reason: "no_in_flight_work",
      status: "skipped",
    });
    expect((await renderMetrics()).body).toContain(
      `${HEARTBEAT_TIMER_SCHEDULER_EXCLUSION_METRIC}{reason="no_in_flight_work"}`,
    );

    const agent = await db
      .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]);
    expect(agent?.lastHeartbeatAt?.toISOString()).toBe(now.toISOString());

    const immediateRetry = await heartbeat.tickTimers(new Date("2026-05-25T20:30:10.000Z"));
    expect(immediateRetry).toMatchObject({ checked: 1, enqueued: 0, skipped: 0 });

    const wakeupsAfterImmediateRetry = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeupsAfterImmediateRetry).toHaveLength(1);
  });

  it.each([
    ["idle_circuit_breaker", "consecutiveTimerIdleRuns", "idleAutoPauseAfter"],
    ["adapter_failed_circuit_breaker", "consecutiveAdapterFailedRuns", "adapterFailedAutoPauseAfter"],
  ] as const)("persists and counts the %s exclusion", async (reason, stateKey, policyKey) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-05-25T20:30:00.000Z");
    const heartbeat = heartbeatService(db);

    await seedOpencodeK8sTimerAgent({
      companyId,
      agentId,
      lastHeartbeatAt: new Date("2026-05-25T20:28:00.000Z"),
    });
    await db
      .update(agents)
      .set({ runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, [policyKey]: 2 } } })
      .where(eq(agents.id, agentId));
    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "opencode_k8s",
      stateJson: { [stateKey]: 2 },
    });

    expect(await heartbeat.tickTimers(now)).toMatchObject({ checked: 1, enqueued: 0, skipped: 1 });
    const [skip] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(skip).toMatchObject({ reason, status: "skipped" });
    expect(skip?.payload).toMatchObject({
      heartbeatSkip: { reason, threshold: 2 },
    });
    expect((await renderMetrics()).body).toContain(
      `${HEARTBEAT_TIMER_SCHEDULER_EXCLUSION_METRIC}{reason="${reason}"}`,
    );

    expect(await heartbeat.tickTimers(new Date("2026-05-25T20:30:10.000Z"))).toMatchObject({
      checked: 1,
      enqueued: 0,
      skipped: 0,
    });
    const skipsAfterImmediateRetry = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(skipsAfterImmediateRetry).toHaveLength(1);
  });

  it("records neither counter when scheduling is globally suppressed", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-05-25T20:30:00.000Z");
    // BLO-32269 design decision #3: the suppressed early return is deliberately
    // NOT recorded as a tick, so a suppressed fleet reads dispatch-dark rather
    // than healthy-idle. That decision had no regression guard; this is it.
    const heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "1" },
    });

    await seedOpencodeK8sTimerAgent({
      companyId,
      agentId,
      lastHeartbeatAt: new Date("2026-05-25T20:28:00.000Z"),
    });

    const before = await readTimerTickCounters();
    const exclusionsBefore = await readSchedulerExclusionTotal();
    const result = await heartbeat.tickTimers(now);

    // The suppressed return omits `idleSkipped`, which every completed pass
    // carries -- that is what proves this took the early return rather than
    // running the body and finding nothing.
    expect(result).toMatchObject({ checked: 0, enqueued: 0, skipped: 0 });
    expect(result).not.toHaveProperty("idleSkipped");

    const after = await readTimerTickCounters();
    expect(after.checked - before.checked).toBe(0);
    expect(after.enqueued - before.enqueued).toBe(0);

    // Pins the negative half of cause (3) in the documented cause list: the
    // exclusion counter is silent here too, because this return is above all
    // four of its call sites. Any comment or help text claiming global
    // suppression is observable through that counter is wrong, and this is
    // what says so mechanically.
    expect(await readSchedulerExclusionTotal()).toBe(exclusionsBefore);
  });

  it("completes a pass with checked=0 when every agent is filtered before the counter", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-05-25T20:30:00.000Z");
    const heartbeat = heartbeatService(db);

    await seedOpencodeK8sTimerAgent({
      companyId,
      agentId,
      lastHeartbeatAt: new Date("2026-05-25T20:28:00.000Z"),
    });
    // `!policy.enabled` is one of three `continue`s that sit ABOVE `checked += 1`.
    // Override only `enabled` -- replacing `runtimeConfig` wholesale would drop
    // the seeded `wakeOnDemand`/`maxConcurrentRuns` and let a different
    // pre-counter filter satisfy the `checked === 0` assertion, so the test
    // would stay green even if `enabled` stopped being honored.
    const [seeded] = await db
      .select({ runtimeConfig: agents.runtimeConfig })
      .from(agents)
      .where(eq(agents.id, agentId));
    const seededHeartbeat = (seeded?.runtimeConfig as { heartbeat?: Record<string, unknown> })
      ?.heartbeat;
    expect(seededHeartbeat).toMatchObject({ wakeOnDemand: true, maxConcurrentRuns: 1 });
    await db
      .update(agents)
      .set({
        runtimeConfig: {
          ...(seeded?.runtimeConfig as Record<string, unknown>),
          heartbeat: { ...seededHeartbeat, enabled: false },
        },
      })
      .where(eq(agents.id, agentId));

    const before = await readTimerTickCounters();
    const exclusionsBefore = await readSchedulerExclusionTotal();
    const result = await heartbeat.tickTimers(now);

    // The load-bearing assertion for the metric's documented semantics: this
    // pass DID complete (it carries `idleSkipped`, unlike the suppressed early
    // return) and still recorded `checked = 0`. So `checked = 0` must be read
    // as "no candidate examined", NOT as "no tick completed" / "loop dead".
    expect(result).toMatchObject({ checked: 0, enqueued: 0 });
    expect(result).toHaveProperty("idleSkipped");

    const after = await readTimerTickCounters();
    expect(after.checked - before.checked).toBe(0);
    expect(after.enqueued - before.enqueued).toBe(0);

    // And the exclusion counter cannot explain the gap: every one of its
    // increments happens after `checked += 1`, so it is silent here. This is
    // why the help text must not send an operator there to corroborate a zero.
    expect(await readSchedulerExclusionTotal()).toBe(exclusionsBefore);
  });

  it("queues opencode_k8s timer ticks when the agent has assigned live work", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-05-25T20:30:00.000Z");
    const heartbeat = heartbeatService(db);
    const { issuePrefix } = await seedOpencodeK8sTimerAgent({
      companyId,
      agentId,
      lastHeartbeatAt: new Date("2026-05-25T20:28:00.000Z"),
    });
    await saturateAgentConcurrency({ companyId, agentId, now });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Actionable work",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const before = await readTimerTickCounters();
    const result = await heartbeat.tickTimers(now);

    expect(result).toMatchObject({ checked: 1, enqueued: 1, skipped: 0 });

    // BLO-32269: complement of the healthy-idle assertion in the sibling test
    // above -- here the pass did enqueue, so both halves must advance together.
    const after = await readTimerTickCounters();
    expect(after.checked - before.checked).toBe(result.checked);
    expect(after.enqueued - before.enqueued).toBe(result.enqueued);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    const timerRun = runs.find((run) => run.invocationSource === "timer");
    expect(timerRun).toMatchObject({
      invocationSource: "timer",
      triggerDetail: "system",
      status: "queued",
    });

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      source: "timer",
      reason: "heartbeat_timer",
      status: "queued",
    });
  });
});

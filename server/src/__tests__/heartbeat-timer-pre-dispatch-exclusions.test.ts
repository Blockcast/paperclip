import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { HEARTBEAT_POLICY_INTERVAL_MIN_SEC } from "@paperclipai/shared/validators/agent";
import {
  TIMER_PRE_DISPATCH_EXCLUSION_INTERVAL_MS,
  TIMER_PRE_DISPATCH_EXCLUSION_SOURCE,
  heartbeatService,
  resolveHeartbeatPolicyForRuntimeConfig,
} from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  HEARTBEAT_TIMER_SCHEDULER_EXCLUSION_METRIC,
  renderMetrics,
} from "../services/metrics.js";

/**
 * PEN-4737 / PEN-2130 AC3.
 *
 * `tickTimers` has three `continue`s above `checked += 1` — agent not
 * invokable, heartbeat disabled or `intervalSec <= 0`, and a worktree
 * execution cutoff with no eligible issue behind it. PEN-2190 instrumented the
 * four exclusions BELOW that line and left these three recording nothing at
 * all, so an agent caught by one of them produced no runs and left no trace in
 * scheduler telemetry. These tests are the regression guard for the counter,
 * the durable row, and the rate limit that keeps the row from being written on
 * every 30s scheduler pass.
 */

/** Reads one labeled series of the exclusion counter, 0 when absent. */
async function readExclusion(reason: string): Promise<number> {
  const { body } = await renderMetrics();
  const match = new RegExp(
    `^${HEARTBEAT_TIMER_SCHEDULER_EXCLUSION_METRIC}\\{reason="${reason.replace(/\./g, "\\.")}"\\} (\\S+)$`,
    "m",
  ).exec(body);
  return match ? Number(match[1]) : 0;
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pre-dispatch timer exclusion tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("timer exclusions recorded before checked += 1", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-timer-pre-dispatch-exclusions-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(input: {
    companyId: string;
    agentId: string;
    status?: string;
    heartbeat?: Record<string, unknown>;
  }) {
    const createdAt = new Date("2026-05-25T18:00:00.000Z");
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
      name: "Summarizer",
      role: "engineer",
      status: input.status ?? "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
          ...(input.heartbeat ?? {}),
        },
      },
      permissions: {},
      lastHeartbeatAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    });
  }

  /** The ledger rows this change writes, for one agent. */
  function readLedger(agentId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
  }

  it("records agent.not_invokable for an agent filtered before the counter", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-05-25T20:30:00.000Z");
    const heartbeat = heartbeatService(db);
    await seedAgent({ companyId, agentId, status: "paused" });

    const before = await readExclusion("agent.not_invokable");
    const result = await heartbeat.tickTimers(now);

    // The agent was filtered above `checked += 1`, so the tick ledger is
    // untouched -- that is deliberate, and BLO-32269's dispatch-dark rule still
    // reads `checked` with exactly its documented meaning.
    expect(result).toMatchObject({ checked: 0, enqueued: 0, skipped: 0 });
    expect(await readExclusion("agent.not_invokable")).toBe(before + 1);

    const rows = await readLedger(agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: TIMER_PRE_DISPATCH_EXCLUSION_SOURCE,
      triggerDetail: "system",
      reason: "agent.not_invokable",
      status: "skipped",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
    });
    expect(rows[0]?.payload).toEqual({
      heartbeatSkip: {
        reason: "agent.not_invokable",
        blockReason: "paused",
        invalidOrgChain: false,
      },
    });
    // Value-safety: counters and bounded enums only. `invokability.message`
    // and `.details` (agent ids, the whole reporting chain) must not leak in.
    expect(JSON.stringify(rows[0]?.payload)).not.toContain(agentId);
  });

  it("records agent.not_invokable with the org-chain classification, not the chain itself", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const managerId = randomUUID();
    const now = new Date("2026-05-25T20:30:00.000Z");
    const heartbeat = heartbeatService(db);
    await seedAgent({ companyId, agentId });
    // PEN-2130 names org-chain invalidity explicitly as one of the silent
    // starvation gates, and it is the arm whose `invokability.details` carries
    // the manager id and the whole reporting chain -- so it is the arm that
    // proves the payload is classed rather than a dump of that object.
    const createdAt = new Date("2026-05-25T18:00:00.000Z");
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "Retired Manager",
      role: "cto",
      status: "terminated",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false } },
      permissions: {},
      createdAt,
      updatedAt: createdAt,
    });
    await db.update(agents).set({ reportsTo: managerId }).where(eq(agents.id, agentId));

    const result = await heartbeat.tickTimers(now);
    expect(result).toMatchObject({ checked: 0 });

    const rows = await readLedger(agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({
      heartbeatSkip: {
        reason: "agent.not_invokable",
        blockReason: "manager_terminated",
        invalidOrgChain: true,
      },
    });
    expect(JSON.stringify(rows[0]?.payload)).not.toContain(managerId);
  });

  it("records heartbeat.disabled when the policy is off", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-05-25T20:30:00.000Z");
    const heartbeat = heartbeatService(db);
    await seedAgent({ companyId, agentId, heartbeat: { enabled: false } });

    const before = await readExclusion("heartbeat.disabled");
    expect(await heartbeat.tickTimers(now)).toMatchObject({ checked: 0 });
    expect(await readExclusion("heartbeat.disabled")).toBe(before + 1);

    const rows = await readLedger(agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: TIMER_PRE_DISPATCH_EXCLUSION_SOURCE,
      reason: "heartbeat.disabled",
      status: "skipped",
    });
    expect(rows[0]?.payload).toEqual({
      heartbeatSkip: { reason: "heartbeat.disabled", enabled: false, intervalSec: 60 },
    });
  });

  // The `heartbeat.disabled` branch is `!policy.enabled || policy.intervalSec <= 0`,
  // and PEN-4737 flags the second arm as the hard case for cadence ("`intervalSec
  // <= 0` leaves no interval to gate on"). It has no integration test above
  // because it is UNREACHABLE through runtimeConfig: `parseHeartbeatPolicy` ->
  // `normalizeHeartbeatIntervalSec` clamps into
  // [HEARTBEAT_POLICY_INTERVAL_MIN_SEC, HEARTBEAT_POLICY_INTERVAL_MAX_SEC], so a
  // configured 0 or negative arrives as 30. The guard is kept (cheap, defensive)
  // and the fixed-window cadence covers it regardless of policy -- which is the
  // reason the window is NOT derived from `intervalSec`. This pins the clamp, so
  // that if it is ever relaxed the branch stops being dead silently.
  it("cannot reach the non-positive-interval arm, because the policy clamps the interval", async () => {
    expect(
      resolveHeartbeatPolicyForRuntimeConfig({ heartbeat: { enabled: true, intervalSec: 0 } }),
    ).toMatchObject({ enabled: true, intervalSec: HEARTBEAT_POLICY_INTERVAL_MIN_SEC });
    expect(
      resolveHeartbeatPolicyForRuntimeConfig({ heartbeat: { enabled: true, intervalSec: -1 } }),
    ).toMatchObject({ enabled: true, intervalSec: HEARTBEAT_POLICY_INTERVAL_MIN_SEC });
  });

  it("records heartbeat.worktree_execution_cutoff when no issue survives the cutoff", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const cutoff = new Date("2026-05-25T20:00:00.000Z");
    const now = new Date("2026-05-25T20:30:00.000Z");
    const runtimeEnv = {
      ...process.env,
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_INSTANCE_ID: "test-worktree",
    };
    await seedAgent({ companyId, agentId });
    // Assigned work exists but predates the cutoff, so the loop's eligibility
    // probe finds nothing -- the real shape of this exclusion, as opposed to an
    // agent that simply has no work.
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Pre-cutoff work",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: "TCUT-1",
      createdAt: new Date("2026-05-25T19:00:00.000Z"),
    });
    await instanceSettingsService(db, { runtimeEnv, now: () => cutoff })
      .updateExperimental({ enableWorktreeRunExecution: true });
    const heartbeat = heartbeatService(db, { runtimeEnv });

    const before = await readExclusion("heartbeat.worktree_execution_cutoff");
    expect(await heartbeat.tickTimers(now)).toMatchObject({ checked: 0 });
    expect(await readExclusion("heartbeat.worktree_execution_cutoff")).toBe(before + 1);

    const rows = await readLedger(agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: TIMER_PRE_DISPATCH_EXCLUSION_SOURCE,
      reason: "heartbeat.worktree_execution_cutoff",
      status: "skipped",
    });
    expect(rows[0]?.payload).toEqual({
      heartbeatSkip: {
        reason: "heartbeat.worktree_execution_cutoff",
        eligibleIssueCount: 0,
        cutoff: cutoff.toISOString(),
      },
    });
  });

  it("writes one row for two passes inside the cadence window, and a second past it", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const first = new Date("2026-05-25T20:30:00.000Z");
    const heartbeat = heartbeatService(db);
    await seedAgent({ companyId, agentId, heartbeat: { enabled: false } });

    const before = await readExclusion("heartbeat.disabled");
    await heartbeat.tickTimers(first);
    expect(await readLedger(agentId)).toHaveLength(1);

    // `heartbeatSchedulerIntervalMs` defaults to 30s, and these three branches
    // sit above the dueness gate, so without a gate of their own every pass
    // would write. This is the defect Ally caught on #1196 and `0d31bfcd`
    // fixed for the circuit breakers.
    await heartbeat.tickTimers(new Date(first.getTime() + 30_000));
    await heartbeat.tickTimers(new Date(first.getTime() + TIMER_PRE_DISPATCH_EXCLUSION_INTERVAL_MS - 1_000));
    expect(await readLedger(agentId)).toHaveLength(1);
    // Counter and row move together, so the metric's standing promise that
    // every increment has durable evidence survives the rate limit.
    expect(await readExclusion("heartbeat.disabled")).toBe(before + 1);

    // The gate is a window, not a latch: the exclusion is still reported once
    // the window elapses, which is what keeps an ongoing starvation visible.
    await heartbeat.tickTimers(new Date(first.getTime() + TIMER_PRE_DISPATCH_EXCLUSION_INTERVAL_MS + 1_000));
    expect(await readLedger(agentId)).toHaveLength(2);
    expect(await readExclusion("heartbeat.disabled")).toBe(before + 2);
  });

  it("gates per reason, so a second exclusion class is not masked by the first", async () => {
    const companyId = randomUUID();
    const invokableAgentId = randomUUID();
    const disabledAgentId = randomUUID();
    const now = new Date("2026-05-25T20:30:00.000Z");
    const heartbeat = heartbeatService(db);
    await seedAgent({ companyId, agentId: invokableAgentId, status: "paused" });
    const createdAt = new Date("2026-05-25T18:00:00.000Z");
    await db.insert(agents).values({
      id: disabledAgentId,
      companyId,
      name: "Reflection Coach",
      role: "engineer",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, intervalSec: 60 } },
      permissions: {},
      lastHeartbeatAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    });

    await heartbeat.tickTimers(now);

    expect(await readLedger(invokableAgentId)).toHaveLength(1);
    expect(await readLedger(disabledAgentId)).toHaveLength(1);
  });

  it("does not advance the BLO-34578 timer baseline", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-05-25T20:30:00.000Z");
    const heartbeat = heartbeatService(db);
    // Disabled for the excluded pass, then enabled. Since BLO-34578 the latest
    // `source: "timer"` row IS the timer baseline, so filing exclusion rows
    // under that source would push the baseline forward for an agent the loop
    // never ticked -- and the agent would then wait a further full
    // `intervalSec` after recovering. That delay would land on exactly the
    // starved agents PEN-2130 is about, which is why these rows carry their own
    // source. `maxDailyRuns: 0` makes the discriminator dispatch-free: if the
    // interval gate is passed, `enqueueWakeup` reaches the daily cap and writes
    // a `heartbeat.daily_run_limit` row without creating any run; if the
    // baseline had been advanced, the loop would `continue` before that and
    // write nothing.
    await seedAgent({
      companyId,
      agentId,
      heartbeat: { enabled: false, maxDailyRuns: 0 },
    });

    await heartbeat.tickTimers(now);
    const ledger = await readLedger(agentId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      source: TIMER_PRE_DISPATCH_EXCLUSION_SOURCE,
      reason: "heartbeat.disabled",
    });
    // The structural half: nothing this change writes is visible to the
    // baseline read, which filters on `source = 'timer'`.
    expect(ledger.filter((row) => row.source === "timer")).toHaveLength(0);

    await db
      .update(agents)
      .set({
        runtimeConfig: {
          heartbeat: { enabled: true, intervalSec: 60, maxDailyRuns: 0 },
        },
      })
      .where(eq(agents.id, agentId));

    // One second later: far inside `intervalSec`, so the gate is only passed if
    // the baseline is still the agent's `createdAt`.
    const result = await heartbeat.tickTimers(new Date(now.getTime() + 1_000));
    expect(result).toMatchObject({ checked: 1, enqueued: 0, skipped: 1 });
    const after = await readLedger(agentId);
    expect(after.map((row) => row.reason).sort()).toEqual([
      "heartbeat.daily_run_limit",
      "heartbeat.disabled",
    ]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(0);
  });
});

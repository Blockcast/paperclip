// BLO-23413: every prior agent alert watched the CAUSE (a K8s Job/pod
// failing), not the OUTCOME (an agent that has simply stopped executing) --
// a cause-side alert clears once the Job is reaped, so a dead agent stays
// dark indefinitely with nothing firing (the 2026-08-08 UXDesigner incident:
// 12.5h undetected). These tests pin `publishAgentLivenessGauges`, the
// reconcile pass that closes that gap:
//   - heartbeat age/interval are published ONLY for heartbeat.enabled agents,
//   - a never-heartbeated agent anchors its age on createdAt rather than
//     being invisible,
//   - error duration is published for every agent, 0 unless status='error',
//   - the "must-trip control": a healthy, freshly-heartbeated agent reads a
//     LOW age, not merely "some value" -- the alert's own threshold logic
//     depends on that distinction, not just presence of the series.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import {
  AGENT_ERROR_DURATION_SECONDS_METRIC,
  AGENT_HEARTBEAT_AGE_SECONDS_METRIC,
  AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC,
  __resetMetricsForTest,
  getMetricsRegistry,
} from "../services/metrics.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-liveness-gauge tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent-liveness gauges (BLO-23413)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-liveness-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  beforeEach(async () => {
    __resetMetricsForTest();
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test",
      issuePrefix: "BLO",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(overrides: {
    status?: string;
    runtimeConfig?: Record<string, unknown>;
    lastHeartbeatAt?: Date | null;
    createdAt?: Date;
    updatedAt?: Date;
    reportsTo?: string | null;
    companyId?: string;
    name?: string;
  }) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: overrides.companyId ?? companyId,
      name: overrides.name ?? "Test agent",
      role: "engineer",
      status: overrides.status ?? "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: overrides.runtimeConfig ?? {},
      permissions: {},
      reportsTo: overrides.reportsTo ?? null,
      lastHeartbeatAt: overrides.lastHeartbeatAt ?? null,
      createdAt: overrides.createdAt,
      updatedAt: overrides.updatedAt,
    });
    return agentId;
  }

  async function gaugeValue(metricName: string, agentId: string): Promise<number | undefined> {
    const metric = getMetricsRegistry().getSingleMetric(metricName);
    expect(metric, `${metricName} must be registered`).toBeTruthy();
    const data = (await metric!.get()) as {
      values: Array<{ labels: Record<string, string>; value: number }>;
    };
    return data.values.find((entry) => entry.labels.agent_id === agentId)?.value;
  }

  it("publishes age+interval only for heartbeat-enabled agents, error duration for every agent", async () => {
    const now = new Date("2026-08-11T12:00:00Z");

    const freshEnabled = await seedAgent({
      status: "idle",
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 1800 } },
      lastHeartbeatAt: new Date(now.getTime() - 60_000), // 60s old, well under 3x1800
      updatedAt: now,
    });
    const staleEnabled = await seedAgent({
      status: "idle",
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 1800 } },
      lastHeartbeatAt: new Date(now.getTime() - 7200_000), // 7200s old, > 3x1800
      updatedAt: now,
    });
    const disabled = await seedAgent({
      status: "idle",
      runtimeConfig: { heartbeat: { enabled: false } },
      lastHeartbeatAt: new Date(now.getTime() - 999_000),
      updatedAt: now,
    });
    const erroredAgent = await seedAgent({
      status: "error",
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 3600 } },
      lastHeartbeatAt: new Date(now.getTime() - 30_000),
      updatedAt: new Date(now.getTime() - 300_000), // entered error 300s ago
    });
    const neverHeartbeated = await seedAgent({
      status: "idle",
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 1800 } },
      lastHeartbeatAt: null,
      createdAt: new Date(now.getTime() - 500_000),
      updatedAt: now,
    });

    await heartbeat.reconcileFailedWakeDispatches(now);

    // Must-trip control: a genuinely fresh, healthy agent reads a LOW age
    // (not just "present"), so `age > 3*interval` correctly stays false.
    expect(await gaugeValue(AGENT_HEARTBEAT_AGE_SECONDS_METRIC, freshEnabled)).toBe(60);
    expect(await gaugeValue(AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC, freshEnabled)).toBe(1800);

    // Stale agent's age clears the 3x-interval alert threshold.
    const staleAge = await gaugeValue(AGENT_HEARTBEAT_AGE_SECONDS_METRIC, staleEnabled);
    expect(staleAge).toBe(7200);
    expect(staleAge!).toBeGreaterThan(3 * 1800);

    // heartbeat-disabled agent must not appear on age/interval at all.
    expect(await gaugeValue(AGENT_HEARTBEAT_AGE_SECONDS_METRIC, disabled)).toBeUndefined();
    expect(await gaugeValue(AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC, disabled)).toBeUndefined();

    // error duration: 0 for every non-error agent, real age for the errored one.
    expect(await gaugeValue(AGENT_ERROR_DURATION_SECONDS_METRIC, freshEnabled)).toBe(0);
    expect(await gaugeValue(AGENT_ERROR_DURATION_SECONDS_METRIC, disabled)).toBe(0);
    expect(await gaugeValue(AGENT_ERROR_DURATION_SECONDS_METRIC, erroredAgent)).toBe(300);

    // Never-heartbeated agent anchors its age on createdAt, not omitted.
    expect(await gaugeValue(AGENT_HEARTBEAT_AGE_SECONDS_METRIC, neverHeartbeated)).toBe(500);
  });

  it("reset-then-sets: a deleted/disabled agent drops off the gauge on the next pass rather than freezing stale", async () => {
    const now = new Date("2026-08-11T12:00:00Z");
    const agentId = await seedAgent({
      status: "idle",
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 1800 } },
      lastHeartbeatAt: new Date(now.getTime() - 100_000),
      updatedAt: now,
    });

    await heartbeat.reconcileFailedWakeDispatches(now);
    expect(await gaugeValue(AGENT_HEARTBEAT_AGE_SECONDS_METRIC, agentId)).toBe(100);

    await db.delete(agents).where(sql`${agents.id} = ${agentId}`);
    await heartbeat.reconcileFailedWakeDispatches(now);
    expect(await gaugeValue(AGENT_HEARTBEAT_AGE_SECONDS_METRIC, agentId)).toBeUndefined();
  });

  // BLO-28861: `heartbeat.enabled` is never cleared on termination, so gating
  // on config alone exported an unbounded, permanently-over-threshold age for
  // every agent the scheduler will never wake again. Measured against live
  // Prometheus before the fix: 19 of 36 series cleared `age > 3*interval`, 18
  // of them permanently false. The predicate below is the SAME
  // `evaluateAgentInvokability` gate the timer scheduler uses, so "expected to
  // heartbeat" and "would actually be woken" cannot drift apart.
  describe("only publishes age/interval for agents the scheduler would wake", () => {
    const now = new Date("2026-08-21T12:00:00Z");
    // Old enough to be over 3x interval for every interval used here, so a
    // series appearing at all is a false page -- not merely a present series.
    const ancient = new Date(now.getTime() - 90 * 24 * 3600 * 1000);
    const enabled30s = { heartbeat: { enabled: true, intervalSec: 30 } };
    const enabled1800s = { heartbeat: { enabled: true, intervalSec: 1800 } };

    async function ageOf(agentId: string) {
      return gaugeValue(AGENT_HEARTBEAT_AGE_SECONDS_METRIC, agentId);
    }
    async function intervalOf(agentId: string) {
      return gaugeValue(AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC, agentId);
    }

    it("(a) excludes a terminated agent with heartbeat.enabled and a stale lastHeartbeatAt, but keeps its error duration", async () => {
      // Jimmy `d5977650` in production: terminated, enabled:true, intervalSec
      // 30, lastHeartbeatAt 2026-04-27 -> 114d of age against a 90s threshold.
      const terminated = await seedAgent({
        status: "terminated",
        runtimeConfig: enabled30s,
        lastHeartbeatAt: ancient,
        updatedAt: now,
      });

      await heartbeat.reconcileFailedWakeDispatches(now);

      expect(await ageOf(terminated)).toBeUndefined();
      expect(await intervalOf(terminated)).toBeUndefined();
      // The gate is age/interval-only: AC #4 keeps error-duration series intact.
      expect(await gaugeValue(AGENT_ERROR_DURATION_SECONDS_METRIC, terminated)).toBe(0);
    });

    it("(a') excludes a terminated agent that never heartbeated at all", async () => {
      // Ally 2 `69b4c2f9`: terminated, enabled:true, lastHeartbeatAt NULL, so
      // the createdAt anchor made its age grow forever from 2026-05-16.
      const terminatedNeverRan = await seedAgent({
        status: "terminated",
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 86400 } },
        lastHeartbeatAt: null,
        createdAt: ancient,
        updatedAt: now,
      });

      await heartbeat.reconcileFailedWakeDispatches(now);

      expect(await ageOf(terminatedNeverRan)).toBeUndefined();
    });

    it("(b) excludes a pending_approval agent", async () => {
      const pending = await seedAgent({
        status: "pending_approval",
        runtimeConfig: enabled1800s,
        lastHeartbeatAt: ancient,
        updatedAt: now,
      });

      await heartbeat.reconcileFailedWakeDispatches(now);

      expect(await ageOf(pending)).toBeUndefined();
      expect(await intervalOf(pending)).toBeUndefined();
    });

    it("(c) STILL publishes for a heartbeat-enabled agent in status=error", async () => {
      // The regression guard the acceptance criteria call out: an errored
      // agent is invokable, and a dark errored agent is the original
      // 2026-08-08 incident. Written as an allow-list of only `running`, the
      // filter would break exactly here.
      const errored = await seedAgent({
        status: "error",
        runtimeConfig: enabled1800s,
        lastHeartbeatAt: new Date(now.getTime() - 7200_000),
        updatedAt: new Date(now.getTime() - 300_000),
      });

      await heartbeat.reconcileFailedWakeDispatches(now);

      const age = await ageOf(errored);
      expect(age).toBe(7200);
      // Still clears the alert threshold -- the agent stays alertable.
      expect(age!).toBeGreaterThan(3 * 1800);
      expect(await intervalOf(errored)).toBe(1800);
      expect(await gaugeValue(AGENT_ERROR_DURATION_SECONDS_METRIC, errored)).toBe(300);
    });

    it("(d) STILL publishes for a live idle agent that has never heartbeated, anchored on createdAt", async () => {
      const neverRan = await seedAgent({
        status: "idle",
        runtimeConfig: enabled1800s,
        lastHeartbeatAt: null,
        createdAt: new Date(now.getTime() - 500_000),
        updatedAt: now,
      });
      const running = await seedAgent({
        status: "running",
        runtimeConfig: enabled1800s,
        lastHeartbeatAt: new Date(now.getTime() - 60_000),
        updatedAt: now,
      });

      await heartbeat.reconcileFailedWakeDispatches(now);

      expect(await ageOf(neverRan)).toBe(500);
      expect(await intervalOf(neverRan)).toBe(1800);
      expect(await ageOf(running)).toBe(60);
    });

    it("(e) excludes a paused agent and an agent reporting through a terminated manager", async () => {
      // Both are skipped by the scheduler's own `!invokability.invokable`
      // gate, so both are dark by construction rather than by fault.
      const paused = await seedAgent({
        status: "paused",
        runtimeConfig: enabled1800s,
        lastHeartbeatAt: ancient,
        updatedAt: now,
      });
      const deadManager = await seedAgent({
        status: "terminated",
        name: "Dead manager",
        runtimeConfig: { heartbeat: { enabled: false } },
        updatedAt: now,
      });
      const orphan = await seedAgent({
        status: "idle",
        name: "Orphan",
        reportsTo: deadManager,
        runtimeConfig: enabled1800s,
        lastHeartbeatAt: ancient,
        updatedAt: now,
      });

      await heartbeat.reconcileFailedWakeDispatches(now);

      expect(await ageOf(paused)).toBeUndefined();
      expect(await ageOf(orphan)).toBeUndefined();
      // Still counted for error duration, so neither vanishes from the fleet.
      expect(await gaugeValue(AGENT_ERROR_DURATION_SECONDS_METRIC, orphan)).toBe(0);
    });

    it("(f) excludes an otherwise-healthy agent whose company is not active", async () => {
      // The scheduler's agent query inner-joins `companies` on
      // status='active', so an agent in a paused company is never woken.
      const inactiveCompanyId = randomUUID();
      await db.insert(companies).values({
        id: inactiveCompanyId,
        name: "Paused co",
        issuePrefix: "PAU",
        status: "paused",
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      const dormant = await seedAgent({
        companyId: inactiveCompanyId,
        status: "idle",
        runtimeConfig: enabled1800s,
        lastHeartbeatAt: ancient,
        updatedAt: now,
      });

      await heartbeat.reconcileFailedWakeDispatches(now);

      expect(await ageOf(dormant)).toBeUndefined();
      expect(await gaugeValue(AGENT_ERROR_DURATION_SECONDS_METRIC, dormant)).toBe(0);
    });

    it("must-trip control: the whole cohort together fires 1 of 6, not 6 of 6", async () => {
      // The end-to-end shape of the production defect. Without the filter all
      // six of these publish an age over 3x interval and the alert can never
      // clear; with it, only the genuinely-dark live agent does.
      await seedAgent({ status: "terminated", runtimeConfig: enabled30s, lastHeartbeatAt: ancient, updatedAt: now });
      await seedAgent({ status: "terminated", runtimeConfig: enabled30s, lastHeartbeatAt: null, createdAt: ancient, updatedAt: now });
      await seedAgent({ status: "pending_approval", runtimeConfig: enabled1800s, lastHeartbeatAt: ancient, updatedAt: now });
      await seedAgent({ status: "paused", runtimeConfig: enabled1800s, lastHeartbeatAt: ancient, updatedAt: now });
      await seedAgent({ status: "idle", runtimeConfig: enabled1800s, lastHeartbeatAt: new Date(now.getTime() - 60_000), updatedAt: now });
      const genuinelyDark = await seedAgent({
        status: "idle",
        runtimeConfig: enabled1800s,
        lastHeartbeatAt: ancient,
        updatedAt: now,
      });

      await heartbeat.reconcileFailedWakeDispatches(now);

      const ages = (await (getMetricsRegistry().getSingleMetric(AGENT_HEARTBEAT_AGE_SECONDS_METRIC))!.get()) as {
        values: Array<{ labels: Record<string, string>; value: number }>;
      };
      const intervals = (await (getMetricsRegistry().getSingleMetric(AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC))!.get()) as {
        values: Array<{ labels: Record<string, string>; value: number }>;
      };
      const intervalById = new Map(intervals.values.map((v) => [v.labels.agent_id, v.value]));
      const firing = ages.values.filter((v) => v.value > 3 * (intervalById.get(v.labels.agent_id) ?? Infinity));

      expect(firing.map((v) => v.labels.agent_id)).toEqual([genuinelyDark]);
      // Six seeded, only the two live agents are even eligible to be judged.
      expect(ages.values).toHaveLength(2);
    });
  });
});

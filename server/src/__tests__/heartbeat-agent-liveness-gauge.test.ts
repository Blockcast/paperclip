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
  }) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Test agent",
      role: "engineer",
      status: overrides.status ?? "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: overrides.runtimeConfig ?? {},
      permissions: {},
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
});

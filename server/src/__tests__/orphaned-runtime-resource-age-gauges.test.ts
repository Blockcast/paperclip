// BLO-32052: the two BLO-21460 "oldest age" gauges must measure how long a
// resource has been RELEASABLE, not how long it has existed. Before this, the
// lease gauge read lease lifetime (acquired_at) and the reservation gauge read
// launch time for a reservation still `launched` under a terminal run, so a
// long run that had just finished read as a long-stuck resource and the gauges
// could not gate the PaperclipRuntimeResourceReconciliationStuck alert.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  externalRuntimeReservations,
  heartbeatRuns,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import {
  ENVIRONMENT_LEASES_ORPHANED_OLDEST_AGE_METRIC,
  EXTERNAL_RUNTIME_RESERVATION_RELEASE_PENDING_OLDEST_AGE_METRIC,
  __resetMetricsForTest,
  getMetricsRegistry,
} from "../services/metrics.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = new Date("2026-11-08T06:00:00.000Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

describeEmbeddedPostgres("orphaned runtime resource age gauges (BLO-32052)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orphan-age-gauges-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
  });

  beforeEach(() => {
    __resetMetricsForTest();
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies", "environments" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFinishedRun(finishedAt: Date | null) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test", issuePrefix: `T${companyId.slice(0, 4)}` });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", startedAt: ago(7200), finishedAt });
    return { companyId, agentId, runId };
  }

  async function gauge(name: string) {
    const metric = getMetricsRegistry().getSingleMetric(name);
    expect(metric, `${name} must be registered`).toBeTruthy();
    const data = (await metric!.get()) as { values: Array<{ value: number }> };
    return data.values[0]?.value ?? 0;
  }

  async function seedLease(acquiredAt: Date, finishedAt: Date | null) {
    const { companyId, runId } = await seedFinishedRun(finishedAt);
    const environmentId = randomUUID();
    await db.insert(environments).values({ id: environmentId, name: "env", driver: "sandbox", status: "active", config: {} });
    await db.insert(environmentLeases).values({ companyId, environmentId, heartbeatRunId: runId, status: "active", acquiredAt });
  }

  it("ages an orphaned lease from its run's finish, not its acquisition", async () => {
    await seedLease(ago(7200), ago(60));
    await heartbeat.refreshOrphanedRuntimeResourceMetrics(NOW);
    expect(await gauge(ENVIRONMENT_LEASES_ORPHANED_OLDEST_AGE_METRIC)).toBe(60);
  });

  it("falls back to acquisition time when the terminal run has no finish time", async () => {
    await seedLease(ago(7200), null);
    await heartbeat.refreshOrphanedRuntimeResourceMetrics(NOW);
    expect(await gauge(ENVIRONMENT_LEASES_ORPHANED_OLDEST_AGE_METRIC)).toBe(7200);
  });

  it("ages a still-launched reservation under a terminal run from the run's finish", async () => {
    const { companyId, agentId, runId } = await seedFinishedRun(ago(90));
    await db.insert(externalRuntimeReservations).values({
      companyId, agentId, runId, slotId: 1, state: "launched", updatedAt: ago(7000),
    });
    await heartbeat.refreshOrphanedRuntimeResourceMetrics(NOW);
    expect(await gauge(EXTERNAL_RUNTIME_RESERVATION_RELEASE_PENDING_OLDEST_AGE_METRIC)).toBe(90);
  });

  it("ages a release_pending reservation from its transition, which postdates the run's finish", async () => {
    const { companyId, agentId, runId } = await seedFinishedRun(ago(3000));
    await db.insert(externalRuntimeReservations).values({
      companyId, agentId, runId, slotId: 1, state: "release_pending", updatedAt: ago(2600),
    });
    await heartbeat.refreshOrphanedRuntimeResourceMetrics(NOW);
    expect(await gauge(EXTERNAL_RUNTIME_RESERVATION_RELEASE_PENDING_OLDEST_AGE_METRIC)).toBe(2600);
  });
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CCROTATE_CAPACITY_MAX_PARK_MS,
  jitterTransientRetryFloor,
  MAX_TRANSIENT_RETRY_HORIZON_MS,
  resolveCcrotateCapacityRetry,
} from "../services/ccrotate-capacity-retry.js";
import {
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS,
  computeBoundedTransientHeartbeatRetrySchedule,
  DEP_BLOCKED_MAX_DELAY_MS,
  MAX_TURN_CONTINUATION_MAX_DELAY_MS,
} from "../services/heartbeat.js";
import {
  __resetMetricsForTest,
  renderMetrics,
  SCHEDULED_RETRY_PARK_HORIZON_METRIC,
  SCHEDULED_RETRY_PARK_HORIZON_REFRESH_SUCCESS_METRIC,
} from "../services/metrics.js";
import {
  refreshOverdueScheduledRetryAgeMetrics,
  refreshQueuedRunAgeMetrics,
  refreshScheduledRetryParkHorizonMetrics,
} from "../services/queued-run-age-metrics.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("refreshOverdueScheduledRetryAgeMetrics (BLO-22094)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-overdue-scheduled-retry-metrics-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    __resetMetricsForTest();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Overdue Scheduled Retry Co",
      issuePrefix: "OSR",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Test Agent",
      role: "engineer",
      status: "running",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("ages an overdue parked retry off scheduledRetryAt, the due time it missed", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-08-07T12:00:00.000Z");
    const createdAt = new Date(now.getTime() - 3_600_000); // 1h ago, irrelevant to this gauge
    const scheduledRetryAt = new Date(now.getTime() - 90_000); // due 90s ago, never promoted

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "scheduled_retry",
      contextSnapshot: {},
      createdAt,
      updatedAt: createdAt,
      scheduledRetryAt,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
    });

    await refreshOverdueScheduledRetryAgeMetrics(db, now);
    const { body } = await renderMetrics();
    expect(body).toContain(`paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 90`);
  });

  it("is silent (reads explicit 0) for a parked retry whose due time is still in the future", async () => {
    // A run merely backing off toward a future scheduledRetryAt is working as
    // designed and must not contribute any age -- this gauge only measures
    // overshoot past due time, not time-since-park.
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-08-07T12:00:00.000Z");
    const createdAt = new Date(now.getTime() - 60_000);
    const scheduledRetryAt = new Date(now.getTime() + 300_000); // due in 5 minutes

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "scheduled_retry",
      contextSnapshot: {},
      createdAt,
      updatedAt: createdAt,
      scheduledRetryAt,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "ccrotate_capacity",
    });

    await refreshOverdueScheduledRetryAgeMetrics(db, now);
    const { body } = await renderMetrics();
    expect(body).toContain(`paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 0`);
  });

  it("is silent for a capacity-clamped park whose advertised resume instant is still in the future (BLO-34782)", async () => {
    // The clamp working as designed, not a wedge. `CCROTATE_CAPACITY_MAX_PARK_MS`
    // caps the booked horizon at 15 minutes, so a pool that will not serve for 3.5
    // days is booked to re-probe in ~15 minutes. Fifteen minutes later the bare
    // `scheduled_retry_at < now` predicate is satisfied and stays satisfied for
    // the whole quota window, while the run is still correctly backing off --
    // and because the quota bucket is shared, every agent does this at once.
    // Measured 2026-09-20: 13 of 16 capacity parks "overdue", 10-14 agents over
    // threshold in each of five episodes.
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-09-20T00:18:00.000Z");
    const parkedAt = new Date(now.getTime() - 1_800_000);
    const scheduledRetryAt = new Date(now.getTime() - 560_000); // clamped, ~9m past due
    const advertisedResumeAt = new Date(now.getTime() + 302_810_000); // provider: 3.5 days out

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "scheduled_retry",
      contextSnapshot: {},
      createdAt: parkedAt,
      updatedAt: parkedAt,
      scheduledRetryAt,
      scheduledRetryAttempt: 3,
      scheduledRetryReason: "ccrotate_capacity",
      resultJson: {
        errorFamily: "rate_limit_exhausted",
        penstockAdvertisedResumeAt: advertisedResumeAt.toISOString(),
        penstockCapacityParkClampedFrom: advertisedResumeAt.toISOString(),
      },
    });

    await refreshOverdueScheduledRetryAgeMetrics(db, now);
    const { body } = await renderMetrics();
    expect(body).toContain(`paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 0`);
  });

  it("still ages a capacity park that has run past the resume instant the provider itself advertised (BLO-34782)", async () => {
    // The exclusion is bounded, not a blanket amnesty for `ccrotate_capacity`.
    // Once the advertised instant passes and the row is *still* parked, the
    // promotion path is wedged -- exactly what this gauge exists to catch.
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-09-20T00:18:00.000Z");
    const parkedAt = new Date(now.getTime() - 10_000_000);
    const scheduledRetryAt = new Date(now.getTime() - 9_000_000);
    const advertisedResumeAt = new Date(now.getTime() - 240_000); // provider said: 4m ago

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "scheduled_retry",
      contextSnapshot: {},
      createdAt: parkedAt,
      updatedAt: parkedAt,
      scheduledRetryAt,
      scheduledRetryAttempt: 7,
      scheduledRetryReason: "ccrotate_capacity",
      resultJson: {
        errorFamily: "rate_limit_exhausted",
        penstockAdvertisedResumeAt: advertisedResumeAt.toISOString(),
        penstockCapacityParkClampedFrom: advertisedResumeAt.toISOString(),
      },
    });

    await refreshOverdueScheduledRetryAgeMetrics(db, now);
    const { body } = await renderMetrics();
    // Aged off the advertised instant (240s), not the clamped booking (9000s).
    expect(body).toContain(`paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 240`);
  });

  it("ignores an unparseable advertised resume instant rather than going silent (BLO-34782)", async () => {
    // Fail loud, not quiet. A corrupt value degrades to the pre-BLO-34782
    // reading and may page; treating it as "still backing off" would hide a
    // real strand behind a malformed string.
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-09-20T00:18:00.000Z");
    const parkedAt = new Date(now.getTime() - 600_000);
    const scheduledRetryAt = new Date(now.getTime() - 90_000);

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "scheduled_retry",
      contextSnapshot: {},
      createdAt: parkedAt,
      updatedAt: parkedAt,
      scheduledRetryAt,
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "ccrotate_capacity",
      resultJson: { penstockAdvertisedResumeAt: "not-a-timestamp" },
    });

    await refreshOverdueScheduledRetryAgeMetrics(db, now);
    const { body } = await renderMetrics();
    expect(body).toContain(`paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 90`);
  });

  it("is silent for a parked row with no due time at all, even when its advertised resume has passed (BLO-34782)", async () => {
    // Pins the explicit `isNotNull(scheduledRetryAt)` guard, which sits beside
    // a `greatest` whose documented property is that it ignores NULLs -- so
    // "redundant, the greatest handles it" is the natural and wrong reading.
    // Without the guard `greatest` collapses to the advertised instant alone
    // and this row starts contributing, where the pre-BLO-34782
    // `scheduled_retry_at < now` excluded it.
    //
    // Reachability, stated honestly: all three `scheduled_retry` insert sites
    // set the column today (heartbeat.ts:20557, :34415, :35352). This pins a
    // schema-representable state against a future writer, not one produced now.
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-09-20T00:18:00.000Z");
    const parkedAt = new Date(now.getTime() - 600_000);

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "scheduled_retry",
      contextSnapshot: {},
      createdAt: parkedAt,
      updatedAt: parkedAt,
      scheduledRetryAt: null,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "ccrotate_capacity",
      resultJson: {
        penstockAdvertisedResumeAt: new Date(now.getTime() - 240_000).toISOString(),
      },
    });

    await refreshOverdueScheduledRetryAgeMetrics(db, now);
    const { body } = await renderMetrics();
    expect(body).toContain(`paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 0`);
  });

  it("reads an explicit 0, not an absent series, for an agent with no scheduled_retry rows at all", async () => {
    const { agentId } = await insertCompanyAndAgent();

    await refreshOverdueScheduledRetryAgeMetrics(db, new Date("2026-08-07T12:00:00.000Z"));
    const { body } = await renderMetrics();
    expect(body).toContain(`paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 0`);
  });

  it("is silent for a run already promoted back to queued, even though scheduledRetryAt/scheduledRetryAttempt survive the promotion unchanged", async () => {
    // promoteScheduledRetryRun (heartbeat.ts) flips status to "queued" and
    // resets queuedAt, but does NOT clear scheduledRetryAt/scheduledRetryAttempt
    // on the row. This gauge must key off status='scheduled_retry', not off
    // the mere presence of a past scheduledRetryAt, or every promoted run
    // would falsely read as still overdue-parked forever.
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-08-07T12:00:00.000Z");
    const scheduledRetryAt = new Date(now.getTime() - 3_600_000); // due 1h ago
    const queuedAt = new Date(now.getTime() - 5_000); // promoted 5s ago

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "queued",
      contextSnapshot: {},
      createdAt: scheduledRetryAt,
      updatedAt: queuedAt,
      queuedAt,
      scheduledRetryAt,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
    });

    await refreshOverdueScheduledRetryAgeMetrics(db, now);
    const { body } = await renderMetrics();
    expect(body).toContain(`paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 0`);
  });

  it("reports the OLDEST overdue row per agent when several are parked past due", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-08-07T12:00:00.000Z");

    await db.insert(heartbeatRuns).values([
      {
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "scheduled_retry",
        contextSnapshot: {},
        createdAt: new Date(now.getTime() - 10_000),
        updatedAt: new Date(now.getTime() - 10_000),
        scheduledRetryAt: new Date(now.getTime() - 10_000), // due 10s ago
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "transient_failure",
      },
      {
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "scheduled_retry",
        contextSnapshot: {},
        createdAt: new Date(now.getTime() - 7_200_000),
        updatedAt: new Date(now.getTime() - 7_200_000),
        scheduledRetryAt: new Date(now.getTime() - 7_200_000), // due 2h ago -- the oldest
        scheduledRetryAttempt: 3,
        scheduledRetryReason: "ccrotate_capacity",
      },
    ]);

    await refreshOverdueScheduledRetryAgeMetrics(db, now);
    const { body } = await renderMetrics();
    expect(body).toContain(`paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 7200`);
  });

  it("resets a previously-overdue agent back to 0 once its parked row clears (reset-then-set, not a frozen stale value)", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const firstNow = new Date("2026-08-07T12:00:00.000Z");

    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "scheduled_retry",
        contextSnapshot: {},
        createdAt: new Date(firstNow.getTime() - 120_000),
        updatedAt: new Date(firstNow.getTime() - 120_000),
        scheduledRetryAt: new Date(firstNow.getTime() - 120_000),
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "transient_failure",
      })
      .returning();

    await refreshOverdueScheduledRetryAgeMetrics(db, firstNow);
    expect((await renderMetrics()).body).toContain(
      `paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 120`,
    );

    // Promotion: status flips away from scheduled_retry.
    await db
      .update(heartbeatRuns)
      .set({ status: "queued", queuedAt: firstNow, updatedAt: firstNow })
      .where(eq(heartbeatRuns.id, run.id));

    const secondNow = new Date(firstNow.getTime() + 60_000);
    await refreshOverdueScheduledRetryAgeMetrics(db, secondNow);
    expect((await renderMetrics()).body).toContain(
      `paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 0`,
    );
  });

  it("marks the overdue snapshot stale after a refresh failure without publishing a false zero", async () => {
    // The reset-then-set only runs on the success path, so a throw leaves the
    // last per-agent values frozen while /metrics still returns 200. Because
    // the frozen value is usually 0 -- the HEALTHY reading -- a dead refresh
    // is otherwise indistinguishable from a quiet fleet. The freshness gauge
    // is what makes that distinguishable, and the alert is gated on it.
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-08-07T12:00:00.000Z");
    const scheduledRetryAt = new Date(now.getTime() - 600_000);

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "scheduled_retry",
      contextSnapshot: {},
      createdAt: scheduledRetryAt,
      updatedAt: scheduledRetryAt,
      scheduledRetryAt,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
    });
    await refreshOverdueScheduledRetryAgeMetrics(db, now);
    expect((await renderMetrics()).body).toContain(
      "paperclip_overdue_scheduled_retry_age_metrics_refresh_success 1",
    );

    const failingDb = {
      select: () => {
        throw new Error("simulated overdue-scheduled-retry metric refresh outage");
      },
    } as unknown as typeof db;
    await expect(refreshOverdueScheduledRetryAgeMetrics(failingDb, now)).rejects.toThrow(
      "simulated overdue-scheduled-retry metric refresh outage",
    );

    const { body } = await renderMetrics();
    // Last good age survives -- not overwritten with a synthetic zero.
    expect(body).toContain(
      `paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 600`,
    );
    expect(body).toContain("paperclip_overdue_scheduled_retry_age_metrics_refresh_success 0");
  });

  it("tracks freshness independently of the sibling queued-run-age refresh", async () => {
    // The two refreshes run different aggregates behind different indexes
    // (0217 for status='queued', 0224 for the overdue-parked predicate), so a
    // statement timeout or plan regression can hit one alone. A shared
    // freshness signal would let a healthy sibling vouch for a dead detector,
    // which is why these are separate gauges and separate alerts.
    await insertCompanyAndAgent();
    const now = new Date("2026-08-07T12:00:00.000Z");

    await refreshQueuedRunAgeMetrics(db, now);

    const failingDb = {
      select: () => {
        throw new Error("simulated overdue-only outage");
      },
    } as unknown as typeof db;
    await expect(refreshOverdueScheduledRetryAgeMetrics(failingDb, now)).rejects.toThrow(
      "simulated overdue-only outage",
    );

    const { body } = await renderMetrics();
    expect(body).toContain("paperclip_queued_run_age_metrics_refresh_success 1");
    expect(body).toContain("paperclip_overdue_scheduled_retry_age_metrics_refresh_success 0");
  });

  it("reports a future-due park horizon without making it overdue", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-08-07T12:00:00.000Z");
    const createdAt = new Date(now.getTime() - 60_000);

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "scheduled_retry",
      contextSnapshot: {},
      createdAt,
      updatedAt: createdAt,
      scheduledRetryAt: new Date(createdAt.getTime() + 1_594_000),
      scheduledRetryAttempt: 1,
    });

    await refreshScheduledRetryParkHorizonMetrics(db);
    const { body } = await renderMetrics();
    expect(body).toContain(`${SCHEDULED_RETRY_PARK_HORIZON_METRIC}{agent_id="${agentId}",reason="other"} 1594`);
    expect(body).toContain(`${SCHEDULED_RETRY_PARK_HORIZON_REFRESH_SUCCESS_METRIC} 1`);
  });

  it("reports a future-due outlier horizon while the overdue metric remains zero", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-08-07T12:00:00.000Z");
    const createdAt = new Date(now.getTime() - 60_000);

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "scheduled_retry",
      contextSnapshot: {},
      createdAt,
      updatedAt: createdAt,
      scheduledRetryAt: new Date(createdAt.getTime() + 518_000_000),
      scheduledRetryAttempt: 1,
    });

    await refreshScheduledRetryParkHorizonMetrics(db);
    await refreshOverdueScheduledRetryAgeMetrics(db, now);
    const { body } = await renderMetrics();
    expect(body).toContain(`${SCHEDULED_RETRY_PARK_HORIZON_METRIC}{agent_id="${agentId}",reason="other"} 518000`);
    expect(body).toContain(`paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 0`);
  });

  // BLO-31174 in-range control. The detector shipped with a population baseline
  // but nothing asserting that a HEALTHY re-parking row stays below threshold
  // over time, which is exactly how the created_at formulation reached
  // production: it reads correctly on the single-shot parks the other tests
  // cover, and only diverges once a row is re-decided in place.
  it("reports the booked interval, not cumulative age, for a re-parked row", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    // A dependency_blocked row on its 10th re-park: first parked ~10h ago, and
    // re-decided in place every hour since. `heartbeat.ts` UPDATEs the same row
    // with scheduledRetryAt = now + backoff and updatedAt = now, leaving
    // created_at pinned at the original park.
    const now = new Date("2026-09-03T05:00:00.000Z");
    const createdAt = new Date(now.getTime() - 10 * 3_600_000);
    const backoffMs = 3_600_000; // DEP_BLOCKED_MAX_DELAY_MS ceiling

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "scheduled_retry",
      contextSnapshot: {},
      createdAt,
      updatedAt: now,
      scheduledRetryAt: new Date(now.getTime() + backoffMs),
      scheduledRetryAttempt: 10,
      scheduledRetryReason: "dependency_blocked",
    });

    await refreshScheduledRetryParkHorizonMetrics(db);
    const { body } = await renderMetrics();
    // Each booking chose one hour, so the gauge must read one hour regardless of
    // how long the row has been re-parking. Against created_at this read 39600
    // and breached the 5400s alert threshold ~7x over on a healthy row.
    expect(body).toContain(`${SCHEDULED_RETRY_PARK_HORIZON_METRIC}{agent_id="${agentId}",reason="dependency_blocked"} 3600`);
  });

  it("does not report a negative horizon for a re-touched past-due park", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-09-03T05:00:00.000Z");
    const createdAt = new Date(now.getTime() - 7_200_000);

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "scheduled_retry",
      contextSnapshot: {},
      createdAt,
      // Touched after the due time already passed, as the GitHub review
      // coalescing path can do to a still-parked row.
      updatedAt: now,
      scheduledRetryAt: new Date(now.getTime() - 1_800_000),
      scheduledRetryAttempt: 3,
    });

    await refreshScheduledRetryParkHorizonMetrics(db);
    const { body } = await renderMetrics();
    expect(body).toContain(`${SCHEDULED_RETRY_PARK_HORIZON_METRIC}{agent_id="${agentId}",reason="other"} 0`);
  });

  // BLO-31174 second defect. The guard is the SEPARATION, not the labelling: on
  // one agent, a designed transient park and a clamp-breaching capacity park are
  // indistinguishable to `max by (agent_id)`, which returns the transient value
  // and hides the capacity one entirely. Without the `reason` groupBy this test
  // fails on both counts -- the two rows collapse to a single series carrying
  // 8630, and the 3600 is simply gone.
  it("separates park classes so a clamp breach is not masked by designed backoff", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-09-28T01:16:00.000Z");
    const base = {
      companyId,
      agentId,
      invocationSource: "assignment" as const,
      status: "scheduled_retry" as const,
      contextSnapshot: {},
      createdAt: now,
      updatedAt: now,
    };

    await db.insert(heartbeatRuns).values([
      {
        ...base,
        // The observed 2026-09-28 re-fire: 7200s final ladder hop x 1.1987
        // jitter, inside the designed [7200, 9000] band. Healthy.
        scheduledRetryAt: new Date(now.getTime() + 8_630_000),
        scheduledRetryAttempt: 4,
        scheduledRetryReason: "transient_failure",
      },
      {
        ...base,
        // 3.3x past the 1,080s ccrotate_capacity ceiling (CCROTATE_CAPACITY_MAX_PARK_MS
        // plus 20% jitter on the clamped value). This is the writer bug
        // class BLO-28919 fixed, and it is what the detector exists to catch.
        scheduledRetryAt: new Date(now.getTime() + 3_600_000),
        scheduledRetryAttempt: 2,
        scheduledRetryReason: "ccrotate_capacity",
      },
    ]);

    await refreshScheduledRetryParkHorizonMetrics(db);
    const { body } = await renderMetrics();
    expect(body).toContain(`${SCHEDULED_RETRY_PARK_HORIZON_METRIC}{agent_id="${agentId}",reason="transient_failure"} 8630`);
    expect(body).toContain(`${SCHEDULED_RETRY_PARK_HORIZON_METRIC}{agent_id="${agentId}",reason="ccrotate_capacity"} 3600`);
    // `none` is a per-agent zero floor, not a "drained" marker: a parked agent
    // carries it too, so `{reason="none"}` selects the whole fleet.
    expect(body).toContain(`${SCHEDULED_RETRY_PARK_HORIZON_METRIC}{agent_id="${agentId}",reason="none"} 0`);
  });

  it("zero-fills an agent with no live park without inventing a park class", async () => {
    const { agentId } = await insertCompanyAndAgent();

    await refreshScheduledRetryParkHorizonMetrics(db);
    const { body } = await renderMetrics();
    // The BLO-25036 invariant: a drained agent reads 0 rather than vanishing.
    expect(body).toContain(`${SCHEDULED_RETRY_PARK_HORIZON_METRIC}{agent_id="${agentId}",reason="none"} 0`);
    // `none` is a placeholder, not a class. Nothing may ever bound it above 0,
    // so assert it cannot be confused with a real reason carrying a real value.
    expect(body).not.toMatch(
      new RegExp(`${SCHEDULED_RETRY_PARK_HORIZON_METRIC}\\{agent_id="${agentId}",reason="none"\\} [1-9]`),
    );
  });
});

// Not DB-gated: the help text is the first thing an operator reads out of
// `# HELP`, so its load-bearing ratio must follow from the ceilings it lists,
// and each listed ceiling must follow from the writer that books it. Deriving
// the expected values here from a hardcoded list would pin the help text to
// the list rather than to the source, which cannot catch a missing ceiling.
describe("scheduled-retry park horizon help text (BLO-31174)", () => {
  afterEach(() => __resetMetricsForTest());

  it("lists each class ceiling as its writer books it, and the spread they produce", async () => {
    const { body } = await renderMetrics();
    const help = body.split("\n").find((line) => line.startsWith(`# HELP ${SCHEDULED_RETRY_PARK_HORIZON_METRIC} `));
    expect(help).toBeDefined();

    const now = new Date(0);
    // Final ladder hop at the top of its jitter band.
    const ladderCeilingS = computeBoundedTransientHeartbeatRetrySchedule(
      BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
      now,
      () => 1,
    )!.delayMs / 1000;
    // An upstream floor exactly at the clamp is not clamped, so it still takes
    // the full forward jitter window: the largest floored `transient_failure`
    // park that `scheduleBoundedRetryForRun` can book.
    const flooredCeilingS = jitterTransientRetryFloor({
      dueAt: new Date(now.getTime() + MAX_TRANSIENT_RETRY_HORIZON_MS),
      now,
      random: () => 1,
    }).dueAt.getTime() / 1000;
    // Jitter is added AFTER the clamp, so the constant alone understates the
    // ceiling: a reset advertised at the clamp, at the top of the jitter band.
    const capacityCeilingS = resolveCcrotateCapacityRetry({
      resumeAt: new Date(now.getTime() + CCROTATE_CAPACITY_MAX_PARK_MS),
      now,
      // Required by the input type but never consulted here: `resumeAt` is in
      // the future, so `baseMs` takes it. The ceiling does not depend on this.
      defaultRetryDelayMs: CCROTATE_CAPACITY_MAX_PARK_MS,
      random: () => 1,
    }).retryAt.getTime() / 1000;
    const ceilings: Array<[string, number]> = [
      ["max_turns_continuation", MAX_TURN_CONTINUATION_MAX_DELAY_MS / 1000],
      ["ccrotate_capacity", capacityCeilingS],
      ["dependency_blocked", DEP_BLOCKED_MAX_DELAY_MS / 1000],
      ["transient_failure", ladderCeilingS],
    ];
    for (const [reason, seconds] of ceilings) expect(help).toContain(`${reason} ${seconds}s`);
    expect(help).toContain(`up to ${flooredCeilingS}s when it adopts an upstream retryNotBefore floor`);
    expect(help).toContain("unbounded for a provider_quota floor");

    const finite = [...ceilings.map(([, seconds]) => seconds), flooredCeilingS];
    // No stale ceiling may survive alongside the derived ones.
    expect([...help!.matchAll(/ (\d+)s\b/g)].map((match) => Number(match[1]))).toEqual(finite);
    expect(help).toContain(`span at least ${Math.max(...finite) / Math.min(...finite)}x`);
    // The flat bound the alert shipped with (runbooks/queued-run-stranded.md),
    // over the capacity ceiling: how far past its own ceiling a capacity park
    // can sit before that single threshold notices.
    const flatAlertBoundS = 5400;
    expect(help).toContain(`missing a ${flatAlertBoundS / capacityCeilingS}x clamp breach`);
  });
});

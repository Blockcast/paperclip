// BLO-20255: `agent_wakeup_requests.status='failed'` is terminal and nothing
// re-drives it -- `reconcileFailedWakeDispatches` only ever selects
// `dispatch_failed`. BLO-18030 / PR #900 added a bounded retry for the one
// slice that is provably safe to re-run (a stale-killed `pr_review` whose
// GitHub probe found no review) and deliberately left three cases terminal so
// a review is never double-posted. Those rows were correct to leave alone and
// wrong to leave unmonitored.
//
// These tests pin the gauge that closes the monitoring half:
//   - it counts a committed `failed` row (restart-safe: no process-local
//     increment is involved, the value is re-derived from rows),
//   - it drops that row once a successor wake for the same taskKey exists,
//     which is what keeps a bounded-retried row from ever paging,
//   - it labels by `error_code` joined from `heartbeat_runs` (the wake table
//     has no such column) and by `pr_review` scope,
//   - the full label grid is zero-initialized so a healthy fleet renders 0
//     rather than "No data" (the BLO-18859 lesson).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import {
  AGENT_WAKEUP_TERMINAL_FAILED_UNRESOLVED_METRIC,
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
    `Skipping embedded Postgres terminal-failed-wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const PR_TASK_KEY = "pr_review:Blockcast/paperclip:900";

describeEmbeddedPostgres("terminal-failed wake gauge (BLO-20255)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-terminal-failed-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  beforeEach(() => {
    __resetMetricsForTest();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test",
      issuePrefix: "BLO",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  /**
   * Read the gauge, optionally filtered by label. Reading the raw series
   * (rather than only the sum) is what lets these tests assert the
   * `error_code` join and the `pr_review` scope, which are the two things a
   * naive implementation gets wrong.
   */
  async function gaugeSeries(filter?: { errorCode?: string; scope?: string }) {
    const metric = getMetricsRegistry().getSingleMetric(
      AGENT_WAKEUP_TERMINAL_FAILED_UNRESOLVED_METRIC,
    );
    expect(
      metric,
      `${AGENT_WAKEUP_TERMINAL_FAILED_UNRESOLVED_METRIC} must be registered`,
    ).toBeTruthy();
    const data = (await metric!.get()) as {
      values: Array<{ labels: Record<string, string>; value: number }>;
    };
    return data.values.filter((entry) =>
      (filter?.errorCode === undefined || entry.labels.error_code === filter.errorCode)
      && (filter?.scope === undefined || entry.labels.scope === filter.scope)
    );
  }

  async function gaugeTotal(filter?: { errorCode?: string; scope?: string }) {
    return (await gaugeSeries(filter)).reduce((sum, entry) => sum + entry.value, 0);
  }

  /** Seed a committed terminal `failed` wake row, with an optional run carrying the errorCode. */
  async function seedFailedWake(opts: {
    companyId: string;
    agentId: string;
    finishedAt: Date;
    taskKey?: string | null;
    errorCode?: string | null;
  }) {
    let runId: string | null = null;
    if (opts.errorCode !== undefined && opts.errorCode !== null) {
      runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: opts.companyId,
        agentId: opts.agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "failed",
        errorCode: opts.errorCode,
        finishedAt: opts.finishedAt,
        createdAt: opts.finishedAt,
        ...(opts.taskKey ? { contextSnapshot: { taskKey: opts.taskKey } } : {}),
      });
    }
    const id = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id,
      companyId: opts.companyId,
      agentId: opts.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "github_pr_synchronized",
      status: "failed",
      finishedAt: opts.finishedAt,
      runId,
      ...(opts.taskKey ? { payload: { taskKey: opts.taskKey } } : {}),
    });
    return id;
  }

  it("zero-initializes the full label grid so a healthy fleet renders 0, not No data", async () => {
    // BLO-18859's explicit lesson: prom-client omits a never-set series
    // entirely, and an absent series renders identically to a broken scrape.
    // A 0 here has to be a real 0.
    const series = await gaugeSeries();
    expect(series.length).toBeGreaterThan(0);
    expect(series.every((entry) => entry.value === 0)).toBe(true);
    // Both the codes the alert's description calls out by name must exist as
    // series before anything has ever failed.
    expect(await gaugeSeries({ errorCode: "external_lifecycle_stale_killed" })).not.toHaveLength(0);
    expect(await gaugeSeries({ errorCode: "job_failed" })).not.toHaveLength(0);
  });

  it("counts a committed terminal failed row, labeled by the run's errorCode and pr_review scope", async () => {
    const { agentId, companyId } = await seedCompanyAndAgent();
    const now = new Date();
    // Written by some earlier process -- exactly what a restarted pod
    // inherits, and exactly what a process-local counter can no longer tell
    // you about.
    await seedFailedWake({
      companyId,
      agentId,
      finishedAt: new Date(now.getTime() - 60_000),
      taskKey: PR_TASK_KEY,
      errorCode: "external_lifecycle_stale_killed",
    });

    await heartbeat.reconcileFailedWakeDispatches(now);

    expect(await gaugeTotal()).toBe(1);
    // The errorCode lives on heartbeat_runs, not on the wake row; getting this
    // series right is the whole point of the run_id join.
    expect(
      await gaugeTotal({ errorCode: "external_lifecycle_stale_killed", scope: "pr_review" }),
    ).toBe(1);
  });

  it("drops the row once a successor wake for the same taskKey exists (a retried row must not page)", async () => {
    const { agentId, companyId } = await seedCompanyAndAgent();
    const now = new Date();
    const failedAt = new Date(now.getTime() - 60_000);
    await seedFailedWake({
      companyId,
      agentId,
      finishedAt: failedAt,
      taskKey: PR_TASK_KEY,
      errorCode: "external_lifecycle_stale_killed",
    });

    await heartbeat.reconcileFailedWakeDispatches(now);
    expect(await gaugeTotal()).toBe(1);

    // A fresh webhook push (or a re-request) creates a new wake row carrying
    // the same PR-scoped taskKey. The work has been picked back up, so the
    // terminal row is no longer actionable.
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "github_pr_synchronized",
      status: "queued",
      requestedAt: new Date(failedAt.getTime() + 30_000),
      payload: { taskKey: PR_TASK_KEY },
    });

    __resetMetricsForTest();
    await heartbeat.reconcileFailedWakeDispatches(now);
    expect(await gaugeTotal()).toBe(0);
  });

  it("drops the row when the successor is a bounded-retry RUN carrying the same context taskKey", async () => {
    // This is the BLO-18030 / PR #900 path specifically: the bounded retry
    // schedules a new heartbeat run and never writes a second wakeup row, so a
    // successor check that only looked at agent_wakeup_requests would still
    // page on a row that is actively being retried.
    const { agentId, companyId } = await seedCompanyAndAgent();
    const now = new Date();
    const failedAt = new Date(now.getTime() - 60_000);
    await seedFailedWake({
      companyId,
      agentId,
      finishedAt: failedAt,
      taskKey: PR_TASK_KEY,
      errorCode: "external_lifecycle_stale_killed",
    });

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      createdAt: new Date(failedAt.getTime() + 120_000),
      contextSnapshot: { taskKey: PR_TASK_KEY },
    });

    await heartbeat.reconcileFailedWakeDispatches(now);
    expect(await gaugeTotal()).toBe(0);
  });

  it("counts a failed row with no run under error_code=none rather than dropping it", async () => {
    // The "deferred wake could not be promoted" sites set status='failed' with
    // no companion run at all. A LEFT join keeps them; an inner join would
    // silently erase a whole class of terminal rows.
    const { agentId, companyId } = await seedCompanyAndAgent();
    const now = new Date();
    await seedFailedWake({
      companyId,
      agentId,
      finishedAt: new Date(now.getTime() - 60_000),
      taskKey: PR_TASK_KEY,
      errorCode: null,
    });

    await heartbeat.reconcileFailedWakeDispatches(now);

    expect(await gaugeTotal({ errorCode: "none", scope: "pr_review" })).toBe(1);
  });

  it("scopes a non-PR wake to scope=other so the pr_review alert cannot page on it", async () => {
    const { agentId, companyId } = await seedCompanyAndAgent();
    const now = new Date();
    await seedFailedWake({
      companyId,
      agentId,
      finishedAt: new Date(now.getTime() - 60_000),
      taskKey: "issue:some-issue-id",
      errorCode: "job_failed",
    });

    await heartbeat.reconcileFailedWakeDispatches(now);

    expect(await gaugeTotal({ scope: "pr_review" })).toBe(0);
    expect(await gaugeTotal({ errorCode: "job_failed", scope: "other" })).toBe(1);
  });

  it("collapses an untriaged errorCode to `other` instead of minting a new series", async () => {
    const { agentId, companyId } = await seedCompanyAndAgent();
    const now = new Date();
    const before = (await gaugeSeries()).length;
    await seedFailedWake({
      companyId,
      agentId,
      finishedAt: new Date(now.getTime() - 60_000),
      taskKey: PR_TASK_KEY,
      errorCode: "some_code_nobody_has_triaged_yet",
    });

    await heartbeat.reconcileFailedWakeDispatches(now);

    expect(await gaugeTotal({ errorCode: "other", scope: "pr_review" })).toBe(1);
    // Cardinality stays bounded: an unknown code must not grow the series set.
    expect((await gaugeSeries()).length).toBe(before);
  });

  it("ignores a row that has aged out of the recency window", async () => {
    // A `failed` row is never cleared, so an all-time count would climb
    // monotonically and pin the alert on forever after the first one.
    const { agentId, companyId } = await seedCompanyAndAgent();
    const now = new Date();
    await seedFailedWake({
      companyId,
      agentId,
      finishedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
      taskKey: PR_TASK_KEY,
      errorCode: "external_lifecycle_stale_killed",
    });

    await heartbeat.reconcileFailedWakeDispatches(now);

    expect(await gaugeTotal()).toBe(0);
  });

  it("counts BOTH terminal rows when a taskKey fails twice (a failed row is not its own successor)", async () => {
    // Regression guard for two bugs that cancelled each other out and so were
    // invisible until the successor comparison started working:
    //
    // 1. `max(requestedAt)` comes back from the driver as a STRING. Comparing
    //    it to a Date with `>` coerces both to numbers, the string becomes NaN,
    //    and every successor check answered false -- the exclusion was dead.
    // 2. With that fixed, a candidate matched its OWN successor query:
    //    `requestedAt` (when the wake was asked for) is later than a sibling's
    //    `finishedAt`, so two failures on one taskKey suppressed each other and
    //    the gauge read 0 on a PR-review chain that was failing repeatedly.
    //
    // A repeatedly-failing chain is the single most page-worthy shape this
    // gauge has, so it must count 2 here, not 1 and never 0.
    const { agentId, companyId } = await seedCompanyAndAgent();
    const now = new Date();
    await seedFailedWake({
      companyId,
      agentId,
      finishedAt: new Date(now.getTime() - 600_000),
      taskKey: PR_TASK_KEY,
      errorCode: "external_lifecycle_stale_killed",
    });
    await seedFailedWake({
      companyId,
      agentId,
      finishedAt: new Date(now.getTime() - 60_000),
      taskKey: PR_TASK_KEY,
      errorCode: "external_lifecycle_stale_killed",
    });

    await heartbeat.reconcileFailedWakeDispatches(now);

    expect(
      await gaugeTotal({ errorCode: "external_lifecycle_stale_killed", scope: "pr_review" }),
    ).toBe(2);
  });
});

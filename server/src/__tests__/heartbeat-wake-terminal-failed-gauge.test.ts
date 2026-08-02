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
  AGENT_WAKEUP_TERMINAL_FAILED_OLDEST_AGE_METRIC,
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

  /** Oldest-unresolved-age series for a scope, in seconds. */
  async function oldestAgeSeconds(scope: string) {
    const metric = getMetricsRegistry().getSingleMetric(
      AGENT_WAKEUP_TERMINAL_FAILED_OLDEST_AGE_METRIC,
    );
    expect(
      metric,
      `${AGENT_WAKEUP_TERMINAL_FAILED_OLDEST_AGE_METRIC} must be registered`,
    ).toBeTruthy();
    const data = (await metric!.get()) as {
      values: Array<{ labels: Record<string, string>; value: number }>;
    };
    const match = data.values.find((entry) => entry.labels.scope === scope);
    expect(match, `expected an oldest-age series for scope=${scope}`).toBeTruthy();
    return match!.value;
  }

  /** Seed a successor wake row for PR_TASK_KEY at a given status. */
  async function seedSuccessorWake(opts: {
    companyId: string;
    agentId: string;
    status: string;
    requestedAt: Date;
    taskKey?: string;
  }) {
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId: opts.companyId,
      agentId: opts.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "github_pr_synchronized",
      status: opts.status,
      requestedAt: opts.requestedAt,
      payload: { taskKey: opts.taskKey ?? PR_TASK_KEY },
    });
  }

  /** Seed a successor run row for PR_TASK_KEY at a given status. */
  async function seedSuccessorRun(opts: {
    companyId: string;
    agentId: string;
    status: string;
    createdAt: Date;
  }) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: opts.companyId,
      agentId: opts.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: opts.status,
      createdAt: opts.createdAt,
      contextSnapshot: { taskKey: PR_TASK_KEY },
    });
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

  // ---------------------------------------------------------------------------
  // Successor-status allowlist (BLO-20255 review round 2).
  //
  // The predicate was `ne(status, "failed")`, which treated EVERY other status
  // as proof the review was picked back up. None of the statuses below mean a
  // review ran, and each one carries a newer timestamp than the failure, so
  // each would have silently suppressed the alert forever. These are table-
  // driven so adding a newly-discovered non-coverage status is one line.
  // ---------------------------------------------------------------------------
  const NON_COVERAGE_WAKE_STATUSES = [
    // Written by scheduling suppression or a policy gate. The wake was
    // declined, not run.
    "skipped",
    // A queued retry that was later cancelled -- e.g. its issue went terminal.
    "cancelled",
    // The dispatch chain burned its retry budget. This is MORE broken than the
    // row it would be silencing.
    "dispatch_failed_exhausted",
    // A newer wake replaced this one; the replacement is its own row and is
    // judged on its own status.
    "dispatch_superseded",
    // Folded into another in-flight wake. That other row either matches the
    // allowlist itself or is a candidate in its own right -- letting two rows
    // vouch for each other is exactly the loop to avoid.
    "coalesced",
  ] as const;

  for (const status of NON_COVERAGE_WAKE_STATUSES) {
    it(`keeps the row alertable when the only successor WAKE ended '${status}'`, async () => {
      const { agentId, companyId } = await seedCompanyAndAgent();
      const now = new Date();
      const failedAt = new Date(now.getTime() - 3_600_000);
      await seedFailedWake({
        companyId,
        agentId,
        finishedAt: failedAt,
        taskKey: PR_TASK_KEY,
        errorCode: "external_lifecycle_stale_killed",
      });
      await seedSuccessorWake({
        companyId,
        agentId,
        status,
        requestedAt: new Date(failedAt.getTime() + 30_000),
      });

      await heartbeat.reconcileFailedWakeDispatches(now);

      expect(await gaugeTotal({ scope: "pr_review" })).toBe(1);
      // And the age must still be published, or the alert would read 0 and
      // stay silent even though the count is right.
      expect(await oldestAgeSeconds("pr_review")).toBeGreaterThanOrEqual(3_500);
    });
  }

  const NON_COVERAGE_RUN_STATUSES = ["cancelled", "failed", "timed_out", "interrupted"] as const;

  for (const status of NON_COVERAGE_RUN_STATUSES) {
    it(`keeps the row alertable when the only successor RUN ended '${status}'`, async () => {
      const { agentId, companyId } = await seedCompanyAndAgent();
      const now = new Date();
      const failedAt = new Date(now.getTime() - 3_600_000);
      await seedFailedWake({
        companyId,
        agentId,
        finishedAt: failedAt,
        taskKey: PR_TASK_KEY,
        errorCode: "external_lifecycle_stale_killed",
      });
      await seedSuccessorRun({
        companyId,
        agentId,
        status,
        createdAt: new Date(failedAt.getTime() + 120_000),
      });

      await heartbeat.reconcileFailedWakeDispatches(now);

      expect(await gaugeTotal({ scope: "pr_review" })).toBe(1);
    });
  }

  // The positive half of the same contract: the statuses that DO mean the work
  // was picked back up must still clear the gauge, or tightening the predicate
  // would have traded a false negative for a false positive.
  const COVERAGE_WAKE_STATUSES = [
    "queued",
    "claimed",
    "running",
    "scheduled",
    "deferred_issue_execution",
    "completed",
  ] as const;

  for (const status of COVERAGE_WAKE_STATUSES) {
    it(`drops the row when a successor WAKE is '${status}'`, async () => {
      const { agentId, companyId } = await seedCompanyAndAgent();
      const now = new Date();
      const failedAt = new Date(now.getTime() - 3_600_000);
      await seedFailedWake({
        companyId,
        agentId,
        finishedAt: failedAt,
        taskKey: PR_TASK_KEY,
        errorCode: "external_lifecycle_stale_killed",
      });
      await seedSuccessorWake({
        companyId,
        agentId,
        status,
        requestedAt: new Date(failedAt.getTime() + 30_000),
      });

      await heartbeat.reconcileFailedWakeDispatches(now);

      expect(await gaugeTotal({ scope: "pr_review" })).toBe(0);
      expect(await oldestAgeSeconds("pr_review")).toBe(0);
    });
  }

  const COVERAGE_RUN_STATUSES = ["queued", "running", "scheduled_retry", "succeeded"] as const;

  for (const status of COVERAGE_RUN_STATUSES) {
    it(`drops the row when a successor RUN is '${status}'`, async () => {
      const { agentId, companyId } = await seedCompanyAndAgent();
      const now = new Date();
      const failedAt = new Date(now.getTime() - 3_600_000);
      await seedFailedWake({
        companyId,
        agentId,
        finishedAt: failedAt,
        taskKey: PR_TASK_KEY,
        errorCode: "external_lifecycle_stale_killed",
      });
      await seedSuccessorRun({
        companyId,
        agentId,
        status,
        createdAt: new Date(failedAt.getTime() + 120_000),
      });

      await heartbeat.reconcileFailedWakeDispatches(now);

      expect(await gaugeTotal({ scope: "pr_review" })).toBe(0);
    });
  }

  // ---------------------------------------------------------------------------
  // Per-row ageing (BLO-20255 review round 2).
  // ---------------------------------------------------------------------------

  it("publishes the age of the OLDEST unresolved row, not the newest", async () => {
    const { agentId, companyId } = await seedCompanyAndAgent();
    const now = new Date();
    await seedFailedWake({
      companyId,
      agentId,
      finishedAt: new Date(now.getTime() - 7_200_000),
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

    const age = await oldestAgeSeconds("pr_review");
    expect(age).toBeGreaterThanOrEqual(7_100);
    expect(age).toBeLessThan(7_300);
  });

  it("does not report a stale age once every row is covered (the alert must resolve)", async () => {
    // A gauge that is merely left alone when the last failure clears would
    // freeze above the threshold and page forever. The setter rewrites every
    // scope to 0 precisely so this resolves.
    const { agentId, companyId } = await seedCompanyAndAgent();
    const now = new Date();
    const failedAt = new Date(now.getTime() - 7_200_000);
    await seedFailedWake({
      companyId,
      agentId,
      finishedAt: failedAt,
      taskKey: PR_TASK_KEY,
      errorCode: "external_lifecycle_stale_killed",
    });

    await heartbeat.reconcileFailedWakeDispatches(now);
    expect(await oldestAgeSeconds("pr_review")).toBeGreaterThan(0);

    await seedSuccessorWake({
      companyId,
      agentId,
      status: "queued",
      requestedAt: new Date(failedAt.getTime() + 30_000),
    });

    await heartbeat.reconcileFailedWakeDispatches(now);
    expect(await oldestAgeSeconds("pr_review")).toBe(0);
  });

  it("does not let failure turnover fake a sustained age (the `for:`-continuity bug)", async () => {
    // The exact shape a `for: 30m` over a summed count gets wrong: failure A is
    // old, gets covered, and a BRAND NEW failure B appears in the same pass. A
    // summed-count expression never goes false across the handover, so `for:`
    // treats the pair as one continuously-true 30m episode and pages on B while
    // B is a minute old. The age gauge is per-row, so it must drop to B's real
    // age here.
    const { agentId, companyId } = await seedCompanyAndAgent();
    const now = new Date();
    const oldFailedAt = new Date(now.getTime() - 7_200_000);
    await seedFailedWake({
      companyId,
      agentId,
      finishedAt: oldFailedAt,
      taskKey: PR_TASK_KEY,
      errorCode: "external_lifecycle_stale_killed",
    });

    await heartbeat.reconcileFailedWakeDispatches(now);
    expect(await oldestAgeSeconds("pr_review")).toBeGreaterThan(7_000);

    // A covers; B is a different PR that just failed.
    await seedSuccessorWake({
      companyId,
      agentId,
      status: "queued",
      requestedAt: new Date(oldFailedAt.getTime() + 30_000),
    });
    const otherTaskKey = "pr_review:Blockcast/paperclip:919";
    await seedFailedWake({
      companyId,
      agentId,
      finishedAt: new Date(now.getTime() - 60_000),
      taskKey: otherTaskKey,
      errorCode: "job_failed",
    });

    await heartbeat.reconcileFailedWakeDispatches(now);

    // The count is still 1, which is exactly why a count-plus-`for:` rule
    // cannot tell these two situations apart.
    expect(await gaugeTotal({ scope: "pr_review" })).toBe(1);
    const age = await oldestAgeSeconds("pr_review");
    expect(age).toBeGreaterThanOrEqual(50);
    expect(age).toBeLessThan(120);
  });

  // ---------------------------------------------------------------------------
  // Per-scope scan budget (BLO-20255 review round 2).
  // ---------------------------------------------------------------------------

  it("still counts a failed row with NO taskKey at all, under scope=other", async () => {
    // Splitting the candidate scan into per-scope queries introduced a new way
    // to lose rows: a null taskKey satisfies neither `like 'pr_review:%'` nor a
    // naive negation of it under SQL three-valued logic, so a null-unaware
    // split would drop this whole class from BOTH queries silently. The scope
    // predicate coalesces to false precisely so these land in `other`, which
    // matches terminalFailedWakeScopeForTaskKey(null). A row with no taskKey is
    // the least monitorable row there is -- dropping it is the opposite of what
    // this gauge is for.
    const { agentId, companyId } = await seedCompanyAndAgent();
    const now = new Date();
    await seedFailedWake({
      companyId,
      agentId,
      finishedAt: new Date(now.getTime() - 60_000),
      taskKey: null,
      errorCode: "job_failed",
    });

    await heartbeat.reconcileFailedWakeDispatches(now);

    expect(await gaugeTotal({ errorCode: "job_failed", scope: "other" })).toBe(1);
    expect(await gaugeTotal({ scope: "pr_review" })).toBe(0);
  });

  it("does not let a flood of newer scope=other failures crowd out an older pr_review one", async () => {
    // A single global `limit ... order by finished_at desc` is resolved by
    // Postgres before this code can look at the taskKey, so the scope a row
    // belongs to is unknown at the moment rows are discarded. With one shared
    // budget, enough newer ordinary failures evict the older PR-review row and
    // the alertable series silently reads 0 -- the alert going quiet precisely
    // when the fleet is least healthy. Separate per-scope queries make that
    // impossible.
    //
    // 520 > TERMINAL_FAILED_WAKE_GAUGE_SCAN_LIMIT_OTHER (500), so the flood
    // would consume a shared cap outright.
    const { agentId, companyId } = await seedCompanyAndAgent();
    const now = new Date();
    await seedFailedWake({
      companyId,
      agentId,
      finishedAt: new Date(now.getTime() - 7_200_000),
      taskKey: PR_TASK_KEY,
      errorCode: "external_lifecycle_stale_killed",
    });

    const flood = Array.from({ length: 520 }, (_unused, index) => ({
      id: randomUUID(),
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      status: "failed",
      // All NEWER than the pr_review row, so a desc-ordered shared cap takes
      // them first.
      finishedAt: new Date(now.getTime() - 60_000 + index),
      payload: { taskKey: `issue:crowd-${index}` },
    }));
    for (let offset = 0; offset < flood.length; offset += 100) {
      await db.insert(agentWakeupRequests).values(flood.slice(offset, offset + 100));
    }

    await heartbeat.reconcileFailedWakeDispatches(now);

    expect(await gaugeTotal({ scope: "pr_review" })).toBe(1);
    expect(await oldestAgeSeconds("pr_review")).toBeGreaterThan(7_000);
  });

  it("reports the oldest pr_review age even when newer SAME-scope failures exceed the scan budget", async () => {
    // The same-scope half of the crowd-out problem, and the one that survived
    // the per-scope split. Giving pr_review its own budget stops `other` from
    // consuming it, but does nothing about pr_review failures crowding out
    // each other: the detail scan is ordered `finished_at desc`, so once more
    // than TERMINAL_FAILED_WAKE_GAUGE_SCAN_LIMIT_PR_REVIEW (500) newer
    // PR-review failures exist, every row older than them is discarded before
    // the age is computed. The published age is then permanently young and the
    // alert -- which thresholds age > 30m -- stays silent during exactly the
    // review-wake outage it exists to detect. At the ~17 failures/min that
    // refills a 500-row budget inside 30m, that silence is indefinite.
    //
    // The fix is that the age comes from an uncapped aggregate rather than
    // from the bounded scan. Reverting that makes this assertion read ~60s.
    const { agentId, companyId } = await seedCompanyAndAgent();
    const now = new Date();
    await seedFailedWake({
      companyId,
      agentId,
      finishedAt: new Date(now.getTime() - 7_200_000),
      taskKey: PR_TASK_KEY,
      errorCode: "external_lifecycle_stale_killed",
    });

    // Distinct taskKeys so each flood row is genuinely unresolved rather than
    // vouching for its siblings, and all NEWER than the row above.
    const flood = Array.from({ length: 520 }, (_unused, index) => ({
      id: randomUUID(),
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "github_pr_review_requested",
      status: "failed",
      finishedAt: new Date(now.getTime() - 60_000 + index),
      payload: { taskKey: `pr_review:crowd-${index}` },
    }));
    for (let offset = 0; offset < flood.length; offset += 100) {
      await db.insert(agentWakeupRequests).values(flood.slice(offset, offset + 100));
    }

    await heartbeat.reconcileFailedWakeDispatches(now);

    // The count saturates at the scan budget -- acceptable, because a
    // saturated count is still non-zero and still pages.
    expect(await gaugeTotal({ scope: "pr_review" })).toBeGreaterThanOrEqual(500);
    // The age must be the real oldest row, not the newest 500's floor.
    expect(await oldestAgeSeconds("pr_review")).toBeGreaterThan(7_000);
  });
});

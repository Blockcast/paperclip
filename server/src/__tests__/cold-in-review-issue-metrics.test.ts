/**
 * PEN-4545 — the oldest cold-`in_review` issue age gauge.
 *
 * An `in_review` issue can hold NO waiting path at all: no live run, no future
 * monitor check, no unexpired park, no active recovery action. It is finished
 * work that nothing will ever come back to.
 *
 * The state is already classified — `in_review_without_action_path` in
 * `recovery/issue-graph-liveness.ts`. What was missing is a carrier, and that
 * is what these tests pin. Its only consumer is the blocked-inbox attention
 * projection, reached solely via an explicit `attention=blocked` list filter,
 * so the state renders only when some OTHER blocked row depends on the cold
 * one; and `inboxLite` excludes `in_review` by design, so no heartbeat
 * re-picks it. Measured 2026-10-24 over a complete 63-row population: 25 cold
 * (40%), against exactly one open `harness_liveness_escalation` out of 187
 * ever minted, naming none of them.
 *
 * Each property below would silently reproduce that invisibility if it
 * regressed:
 *   - a LAPSED monitor (next check in the past) counts as cold, not attended —
 *     14 of the 25 measured were exactly this shape, so reading a past
 *     timestamp as attendance blinds the gauge to the half that fails most,
 *   - each of the four live waiting paths individually suppresses the row, so
 *     the gauge cannot cry wolf over genuinely attended work,
 *   - a repaired row resets its agent's series to an explicit 0, so the alert
 *     can clear rather than latching above threshold forever,
 *   - a failed refresh flips the freshness gauge instead of publishing a
 *     healthy-looking synthetic zero.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  __resetMetricsForTest,
  COLD_IN_REVIEW_ISSUE_METRICS_REFRESH_SUCCESS_METRIC,
  COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC,
  renderMetrics,
} from "../services/metrics.js";
import { refreshColdInReviewIssueMetrics } from "../services/queued-run-age-metrics.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres cold-in_review tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NOW = new Date("2026-10-24T09:00:00.000Z");
const ONE_HOUR_MS = 3_600_000;

/**
 * Read one gauge series EXACTLY. `toContain('… 3600')` is substring matching
 * and so also passes on `3600000` — vacuous against the likeliest regression
 * in an age gauge, a dropped unit conversion. The alert thresholds raw
 * seconds, so a 1000x error would page permanently with every test green.
 */
async function gaugeValue(metric: string, agentId: string): Promise<string | undefined> {
  const { body } = await renderMetrics();
  const prefix = `${metric}{agent_id="${agentId}"} `;
  return body.split("\n").find((line) => line.startsWith(prefix))?.slice(prefix.length).trim();
}

async function refreshSuccessValue(): Promise<string | undefined> {
  const { body } = await renderMetrics();
  const prefix = `${COLD_IN_REVIEW_ISSUE_METRICS_REFRESH_SUCCESS_METRIC} `;
  return body.split("\n").find((line) => line.startsWith(prefix))?.slice(prefix.length).trim();
}

describeEmbeddedPostgres("refreshColdInReviewIssueMetrics (PEN-4545)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cold-in-review-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE issue_recovery_actions, heartbeat_runs, issues, agents, companies CASCADE`,
    );
    __resetMetricsForTest();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Cold Review Co",
      issuePrefix: "CIR",
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

  async function insertIssue(opts: {
    companyId: string;
    agentId: string | null;
    updatedAt: Date;
    status?: string;
    monitorNextCheckAt?: Date | null;
    parkedUntil?: Date | null;
    executionRunId?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: opts.companyId,
      title: "Cold review row",
      status: opts.status ?? "in_review",
      assigneeAgentId: opts.agentId,
      monitorNextCheckAt: opts.monitorNextCheckAt ?? null,
      parkedUntil: opts.parkedUntil ?? null,
      executionRunId: opts.executionRunId ?? null,
      createdAt: opts.updatedAt,
      updatedAt: opts.updatedAt,
    });
    return id;
  }

  async function insertRun(opts: { companyId: string; agentId: string; status: string }) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: opts.companyId,
      agentId: opts.agentId,
      status: opts.status,
    });
    return id;
  }

  it("publishes the oldest cold in_review age off updatedAt", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    await insertIssue({ companyId, agentId, updatedAt: new Date(NOW.getTime() - 3 * ONE_HOUR_MS) });
    // A younger sibling must not win: the gauge reports the OLDEST row, which
    // is the one that has been unreachable longest.
    await insertIssue({ companyId, agentId, updatedAt: new Date(NOW.getTime() - ONE_HOUR_MS) });

    await refreshColdInReviewIssueMetrics(db, NOW);

    expect(await gaugeValue(COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC, agentId)).toBe("10800");
    expect(await refreshSuccessValue()).toBe("1");
  });

  it("counts a LAPSED monitor as cold, and a future one as attended", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const lapsed = await insertIssue({
      companyId,
      agentId,
      updatedAt: new Date(NOW.getTime() - 2 * ONE_HOUR_MS),
      monitorNextCheckAt: new Date(NOW.getTime() - ONE_HOUR_MS),
    });
    expect(lapsed).toBeTruthy();

    await refreshColdInReviewIssueMetrics(db, NOW);
    // 14 of the 25 rows measured were exactly this shape — a monitor that
    // fired and was never re-armed. Suppressing them is the regression that
    // would make this gauge useless.
    expect(await gaugeValue(COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC, agentId)).toBe("7200");

    await db.execute(sql`TRUNCATE TABLE issues CASCADE`);
    __resetMetricsForTest();
    await insertIssue({
      companyId,
      agentId,
      updatedAt: new Date(NOW.getTime() - 2 * ONE_HOUR_MS),
      monitorNextCheckAt: new Date(NOW.getTime() + ONE_HOUR_MS),
    });
    await refreshColdInReviewIssueMetrics(db, NOW);
    expect(await gaugeValue(COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC, agentId)).toBe("0");
  });

  it("treats each live waiting path as attendance", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const stale = new Date(NOW.getTime() - 4 * ONE_HOUR_MS);

    // 1. unexpired park
    await insertIssue({ companyId, agentId, updatedAt: stale, parkedUntil: new Date(NOW.getTime() + ONE_HOUR_MS) });
    await refreshColdInReviewIssueMetrics(db, NOW);
    expect(await gaugeValue(COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC, agentId)).toBe("0");

    // 2. live run holding the execution lock
    await db.execute(sql`TRUNCATE TABLE issues CASCADE`);
    __resetMetricsForTest();
    const runId = await insertRun({ companyId, agentId, status: "running" });
    await insertIssue({ companyId, agentId, updatedAt: stale, executionRunId: runId });
    await refreshColdInReviewIssueMetrics(db, NOW);
    expect(await gaugeValue(COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC, agentId)).toBe("0");

    // 3. active recovery action
    await db.execute(sql`TRUNCATE TABLE issues, heartbeat_runs CASCADE`);
    __resetMetricsForTest();
    const issueId = await insertIssue({ companyId, agentId, updatedAt: stale });
    await db.insert(issueRecoveryActions).values({
      id: randomUUID(),
      companyId,
      sourceIssueId: issueId,
      kind: "wake_owner",
      status: "active",
      cause: "test",
      fingerprint: randomUUID(),
      nextAction: "do the thing",
    });
    await refreshColdInReviewIssueMetrics(db, NOW);
    expect(await gaugeValue(COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC, agentId)).toBe("0");
  });

  it("ignores statuses other than in_review, and unassigned rows", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const stale = new Date(NOW.getTime() - 5 * ONE_HOUR_MS);
    for (const status of ["in_progress", "blocked", "done", "todo"]) {
      await insertIssue({ companyId, agentId, updatedAt: stale, status });
    }
    // `in_review` but unassigned: there is no agent to wake, so it cannot be
    // charged to one. It belongs to the unassigned-work problem, not this one.
    await insertIssue({ companyId, agentId: null, updatedAt: stale });

    await refreshColdInReviewIssueMetrics(db, NOW);
    expect(await gaugeValue(COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC, agentId)).toBe("0");
  });

  it("resets a repaired agent to an explicit 0 so the alert can clear", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const issueId = await insertIssue({ companyId, agentId, updatedAt: new Date(NOW.getTime() - ONE_HOUR_MS) });
    await refreshColdInReviewIssueMetrics(db, NOW);
    expect(await gaugeValue(COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC, agentId)).toBe("3600");

    // Arming a monitor is the ordinary repair. The series must fall back to a
    // published 0, not vanish — an absent series and "nothing stuck" render
    // identically on a dashboard.
    await db
      .update(issues)
      .set({ monitorNextCheckAt: new Date(NOW.getTime() + ONE_HOUR_MS) })
      .where(sql`${issues.id} = ${issueId}`);
    await refreshColdInReviewIssueMetrics(db, NOW);
    expect(await gaugeValue(COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC, agentId)).toBe("0");
  });

  it("flips the freshness gauge instead of publishing a synthetic zero when the refresh fails", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    await insertIssue({ companyId, agentId, updatedAt: new Date(NOW.getTime() - 2 * ONE_HOUR_MS) });
    await refreshColdInReviewIssueMetrics(db, NOW);
    expect(await gaugeValue(COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC, agentId)).toBe("7200");

    const broken = { select: () => { throw new Error("db down"); } } as unknown as typeof db;
    await expect(refreshColdInReviewIssueMetrics(broken, NOW)).rejects.toThrow("db down");

    // The last good snapshot survives; only freshness changes. A synthetic 0
    // here would read as "nothing is cold" during an outage.
    expect(await gaugeValue(COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC, agentId)).toBe("7200");
    expect(await refreshSuccessValue()).toBe("0");
  });
});

/**
 * PEN-3734 — the oldest pending `deferred_issue_execution` wake age gauge.
 *
 * A wake is parked in `deferred_issue_execution` while another run holds the
 * issue's execution lock. It is promoted only when a run on that issue
 * finalizes, one per finalization, and the lock is held globally across
 * agents, so one agent's comment-delivery latency is bounded below by every
 * other agent's queue wait on that row. Measured 2026-10-02 on PEN-3164:
 * 10h53m, of which 10h35m was a single foreign run sitting `queued`.
 *
 * The reason that went unnoticed is what these tests pin. Nothing else can
 * see the state: a deferred wake deliberately creates NO `heartbeat_runs`
 * row, so the three run-table refreshes in this same module are structurally
 * blind to it, and the issue's `lastActivityAt` is ADVANCED by each
 * undelivered comment so staleness sweeps read a starving row as healthy.
 *
 * Four properties, each of which would silently reproduce the original
 * invisibility if it regressed:
 *   - the age comes off `requested_at`, which a COALESCING wake does not
 *     reset -- the `lastActivityAt` failure mode one table over,
 *   - a promoted wake resets its agent's series to an explicit 0, so the
 *     alert can clear rather than latching above threshold forever,
 *   - a failed refresh leaves the last snapshot alone and flips the freshness
 *     gauge, rather than publishing a healthy-looking synthetic zero,
 *   - the aggregate runs off migration 0250's partial index, never a scan of
 *     the largest table in the schema, since it runs every 15s forever.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";
import {
  __resetMetricsForTest,
  DEFERRED_ISSUE_EXECUTION_WAKE_AGE_METRICS_REFRESH_SUCCESS_METRIC,
  DEFERRED_ISSUE_EXECUTION_WAKE_OLDEST_AGE_METRIC,
  renderMetrics,
} from "../services/metrics.js";
import { refreshDeferredIssueExecutionWakeAgeMetrics, __resetDeferredWakeDetailLogThrottleForTest } from "../services/queued-run-age-metrics.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres deferred-wake-age tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NOW = new Date("2026-10-02T23:30:00.000Z");

/**
 * Read one gauge series EXACTLY.
 *
 * `expect(body).toContain('…{agent_id="x"} 600')` is substring matching, so it
 * also passes on `600000` — i.e. it is vacuous against the single most likely
 * regression in an age gauge, a dropped `/ 1000`. The alert thresholds raw
 * seconds, so a 1000x unit error would page permanently with every test green.
 * Parse the line and compare the value.
 */
async function gaugeValue(metric: string, agentId: string): Promise<string | undefined> {
  const { body } = await renderMetrics();
  const prefix = `${metric}{agent_id="${agentId}"} `;
  return body.split("\n").find((line) => line.startsWith(prefix))?.slice(prefix.length).trim();
}

describeEmbeddedPostgres("refreshDeferredIssueExecutionWakeAgeMetrics (PEN-3734)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deferred-wake-age-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE agent_wakeup_requests, agents, companies CASCADE`);
    __resetMetricsForTest();
    __resetDeferredWakeDetailLogThrottleForTest();
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
      name: "Deferred Wake Co",
      issuePrefix: "DWA",
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

  async function insertDeferredWake(opts: {
    companyId: string;
    agentId: string;
    issueId?: string;
    requestedAt: Date;
    updatedAt?: Date;
    status?: string;
    coalescedCount?: number;
  }) {
    const id = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id,
      companyId: opts.companyId,
      agentId: opts.agentId,
      source: "issue_comment",
      reason: "issue_commented",
      payload: { issueId: opts.issueId ?? randomUUID() },
      status: opts.status ?? "deferred_issue_execution",
      coalescedCount: opts.coalescedCount ?? 0,
      requestedAt: opts.requestedAt,
      createdAt: opts.requestedAt,
      updatedAt: opts.updatedAt ?? opts.requestedAt,
    });
    return id;
  }

  it("publishes the oldest pending deferred wake age off requestedAt", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    await insertDeferredWake({
      companyId,
      agentId,
      requestedAt: new Date(NOW.getTime() - 600_000),
    });
    // A younger sibling on the same agent must not win: the gauge reports the
    // OLDEST wait, which is the one that costs a day.
    await insertDeferredWake({
      companyId,
      agentId,
      requestedAt: new Date(NOW.getTime() - 60_000),
    });

    await refreshDeferredIssueExecutionWakeAgeMetrics(db, NOW);

    expect(await gaugeValue(DEFERRED_ISSUE_EXECUTION_WAKE_OLDEST_AGE_METRIC, agentId)).toBe("600");
    expect((await renderMetrics()).body).toContain(
      `${DEFERRED_ISSUE_EXECUTION_WAKE_AGE_METRICS_REFRESH_SUCCESS_METRIC} 1`,
    );
  });

  it("keeps the full wait when a later comment coalesces into the pending request", async () => {
    // The defect's signature. Later wakes on the same issue MERGE into the
    // pending request (coalescedCount++) and bump `updated_at` without
    // touching `requested_at`. Ageing off `updated_at` would report a row
    // that has been starving for ~11h as 2 minutes old -- the same thing
    // `issues.lastActivityAt` already does one table over, which is why the
    // row read as freshly healthy to every staleness sweep.
    const { companyId, agentId } = await insertCompanyAndAgent();
    const requestedAt = new Date(NOW.getTime() - 10 * 60 * 60 * 1000 - 53 * 60 * 1000); // 10h53m
    await insertDeferredWake({
      companyId,
      agentId,
      requestedAt,
      updatedAt: new Date(NOW.getTime() - 120_000),
      coalescedCount: 3,
    });

    await refreshDeferredIssueExecutionWakeAgeMetrics(db, NOW);

    // Exact, not substring: `39180` is a prefix of `39180000`, so a dropped
    // `/ 1000` would otherwise sail through this very assertion.
    expect(await gaugeValue(DEFERRED_ISSUE_EXECUTION_WAKE_OLDEST_AGE_METRIC, agentId)).toBe("39180");
  });

  it("resets a promoted agent's series to an explicit 0 so the alert can clear", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const wakeId = await insertDeferredWake({
      companyId,
      agentId,
      requestedAt: new Date(NOW.getTime() - 3_600_000),
    });
    await refreshDeferredIssueExecutionWakeAgeMetrics(db, NOW);
    expect(await gaugeValue(DEFERRED_ISSUE_EXECUTION_WAKE_OLDEST_AGE_METRIC, agentId)).toBe("3600");

    // Promotion moves the row off the deferred status; it does not delete it.
    await db
      .update(agentWakeupRequests)
      .set({ status: "queued" })
      .where(sql`${agentWakeupRequests.id} = ${wakeId}::uuid`);
    await refreshDeferredIssueExecutionWakeAgeMetrics(db, NOW);

    // Exactly "0", not "0.5": a near-zero float would read as cleared on a
    // substring match and the alert would resolve while the wait continued.
    expect(await gaugeValue(DEFERRED_ISSUE_EXECUTION_WAKE_OLDEST_AGE_METRIC, agentId)).toBe("0");
  });

  it("counts an agent with nothing deferred as an explicit 0, not an absent series", async () => {
    const { agentId } = await insertCompanyAndAgent();

    await refreshDeferredIssueExecutionWakeAgeMetrics(db, NOW);

    expect(await gaugeValue(DEFERRED_ISSUE_EXECUTION_WAKE_OLDEST_AGE_METRIC, agentId)).toBe("0");
  });

  it("marks the age snapshot stale after a refresh failure without publishing a false zero", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    await insertDeferredWake({
      companyId,
      agentId,
      requestedAt: new Date(NOW.getTime() - 600_000),
    });
    await refreshDeferredIssueExecutionWakeAgeMetrics(db, NOW);

    const failingDb = {
      select: () => {
        throw new Error("simulated deferred-wake metric refresh outage");
      },
    } as unknown as typeof db;
    await expect(refreshDeferredIssueExecutionWakeAgeMetrics(failingDb, NOW)).rejects.toThrow(
      "simulated deferred-wake metric refresh outage",
    );

    // A synthetic zero here would read as "nothing deferred" -- the healthy
    // state -- and hide the very wait the gauge exists to expose.
    expect(await gaugeValue(DEFERRED_ISSUE_EXECUTION_WAKE_OLDEST_AGE_METRIC, agentId)).toBe("600");
    expect((await renderMetrics()).body).toContain(
      `${DEFERRED_ISSUE_EXECUTION_WAKE_AGE_METRICS_REFRESH_SUCCESS_METRIC} 0`,
    );
  });

  it("logs the issue id of an overdue deferred wake, because the gauge cannot carry it", async () => {
    // `issue_id` is unbounded cardinality and deliberately not a label, so the
    // log is the only bridge from "agent X is waiting" to "on which row".
    // Without it an alert names a starving agent and nothing else.
    const { companyId, agentId } = await insertCompanyAndAgent();
    const issueId = randomUUID();
    const wakeId = await insertDeferredWake({
      companyId,
      agentId,
      issueId,
      requestedAt: new Date(NOW.getTime() - 45 * 60 * 1000),
      coalescedCount: 3,
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    await refreshDeferredIssueExecutionWakeAgeMetrics(db, NOW);

    expect(warn).toHaveBeenCalledTimes(1);
    const [details, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toContain("deferred behind an issue execution lock");
    expect(details.oldestAgeSeconds).toBe(2700);
    expect(details.capped).toBe(false);
    expect(details.wakes).toEqual([
      expect.objectContaining({ wakeId, agentId, companyId, issueId, coalescedCount: 3, ageSeconds: 2700 }),
    ]);
  });

  it("stays quiet below the detail-log threshold", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    await insertDeferredWake({
      companyId,
      agentId,
      requestedAt: new Date(NOW.getTime() - 10 * 60 * 1000),
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    await refreshDeferredIssueExecutionWakeAgeMetrics(db, NOW);

    // The gauge still publishes; only the per-row detail is withheld, so a
    // short deferral (the normal, intended case) costs one query and no log.
    expect(await gaugeValue(DEFERRED_ISSUE_EXECUTION_WAKE_OLDEST_AGE_METRIC, agentId)).toBe("600");
    expect(warn).not.toHaveBeenCalled();
  });

  it("throttles the detail log instead of re-emitting it on every 15s tick", async () => {
    // The collector ticks every 15s and the detail pass fires whenever
    // anything is past 30m, so unthrottled the motivating 10h53m case emits
    // ~2,600 near-identical records -- burying the forensic trail inside
    // copies of itself, in exactly the log the runbook says to grep.
    const { companyId, agentId } = await insertCompanyAndAgent();
    await insertDeferredWake({
      companyId,
      agentId,
      requestedAt: new Date(NOW.getTime() - 45 * 60 * 1000),
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    await refreshDeferredIssueExecutionWakeAgeMetrics(db, NOW);
    await refreshDeferredIssueExecutionWakeAgeMetrics(db, new Date(NOW.getTime() + 15_000));
    await refreshDeferredIssueExecutionWakeAgeMetrics(db, new Date(NOW.getTime() + 30_000));
    expect(warn).toHaveBeenCalledTimes(1);

    // ...and resumes once the interval has elapsed, so a wait that outlives the
    // window still leaves a trail rather than one record at the very start.
    await refreshDeferredIssueExecutionWakeAgeMetrics(db, new Date(NOW.getTime() + 16 * 60 * 1000));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does not let a failing detail query mark the published gauge stale", async () => {
    // The sharp edge: this query runs ONLY when something is already overdue,
    // so its whole failure surface sits on the unhealthy path. If its error
    // reached the refresh's catch, the freshness gauge would go 0, the alert
    // expression would gate itself off, and
    // PaperclipDeferredIssueExecutionWakeOverdue would stay silent on a
    // correct, fresh, above-threshold value. A diagnostic must not be able to
    // disable the detector it is diagnosing.
    const { companyId, agentId } = await insertCompanyAndAgent();
    await insertDeferredWake({
      companyId,
      agentId,
      requestedAt: new Date(NOW.getTime() - 45 * 60 * 1000),
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    let aggregateCalls = 0;    const flakyDetailDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "select") return Reflect.get(target, prop, receiver);
        return (...args: unknown[]) => {
          // The refresh issues the two aggregate selects first, then the
          // detail select; fail only the latter.
          aggregateCalls += 1;
          if (aggregateCalls > 2) throw new Error("simulated detail-query timeout");
          return (target.select as (...a: unknown[]) => unknown)(...args);
        };
      },
    }) as typeof db;

    await expect(refreshDeferredIssueExecutionWakeAgeMetrics(flakyDetailDb, NOW)).resolves.toBeUndefined();

    // Prove the detail query actually threw. Without this the assertions below
    // pass just as happily on a run where it succeeded, which would make the
    // whole test vacuous the day someone reorders the queries.
    expect(aggregateCalls).toBe(3);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      expect.stringContaining("detail log failed"),
    );

    expect(await gaugeValue(DEFERRED_ISSUE_EXECUTION_WAKE_OLDEST_AGE_METRIC, agentId)).toBe("2700");
    expect((await renderMetrics()).body).toContain(
      `${DEFERRED_ISSUE_EXECUTION_WAKE_AGE_METRICS_REFRESH_SUCCESS_METRIC} 1`,
    );
  });

  it("keeps the deferred-wake aggregate off a full wakeup-request history scan", async () => {
    // This runs on the 15s collector tick forever, against the largest table
    // in the schema (~13M rows) that nothing prunes. A seq scan here is not a
    // slow test, it is a production regression.
    const { companyId, agentId } = await insertCompanyAndAgent();
    await db.execute(sql`
      INSERT INTO agent_wakeup_requests (
        company_id,
        agent_id,
        source,
        status,
        payload,
        requested_at,
        created_at,
        updated_at
      )
      SELECT
        ${companyId}::uuid,
        ${agentId}::uuid,
        'timer',
        CASE WHEN series <= 50 THEN 'deferred_issue_execution' ELSE 'completed' END,
        '{}'::jsonb,
        now() - ((series + 1000) || ' seconds')::interval,
        now() - ((series + 1000) || ' seconds')::interval,
        now()
      FROM generate_series(1, 30000) AS series
    `);
    await db.execute(sql`ANALYZE agent_wakeup_requests`);

    // Drop the competing composite so the regression proves the dedicated
    // partial index rather than a planner-version skip-scan heuristic, then
    // restore it so a later test cannot inherit the altered planner surface.
    try {
      await db.execute(sql`DROP INDEX IF EXISTS agent_wakeup_requests_company_agent_status_idx`);

      const rows = await db.execute(sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT agent_id, min(requested_at) AS oldest_requested_at
        FROM agent_wakeup_requests
        WHERE status = 'deferred_issue_execution'
        GROUP BY agent_id
      `);
      const root = ((rows[0] as { "QUERY PLAN": Array<{ Plan: PlanNode }> })["QUERY PLAN"])[0]?.Plan;
      expect(root).toBeDefined();

      const nodes: PlanNode[] = [];
      const visit = (node: PlanNode | undefined) => {
        if (!node) return;
        nodes.push(node);
        for (const child of node.Plans ?? []) visit(child);
      };
      visit(root);

      const wakeScanNodes = nodes.filter((node) => node["Relation Name"] === "agent_wakeup_requests");
      expect(wakeScanNodes).not.toHaveLength(0);
      expect(wakeScanNodes.some((node) => node["Node Type"] === "Seq Scan")).toBe(false);
      expect(
        wakeScanNodes.some((node) =>
          ["Index Scan", "Index Only Scan", "Bitmap Heap Scan"].includes(String(node["Node Type"])),
        ),
      ).toBe(true);
      expect(
        nodes.some((node) => node["Index Name"] === "agent_wakeup_requests_deferred_issue_execution_idx"),
      ).toBe(true);
    } finally {
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS agent_wakeup_requests_company_agent_status_idx
        ON agent_wakeup_requests USING btree (company_id, agent_id, status)
      `);
    }
  });
});

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
};

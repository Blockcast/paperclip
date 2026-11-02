import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildIssueListAnalyzeProbeQuery,
  captureIssueListAnalyzeProbe,
  ISSUE_LIST_ANALYZE_PROBE_FLAG,
  ISSUE_LIST_ANALYZE_PROBE_TIMEOUT_MS,
  resetIssueListAnalyzeProbeBudget,
} from "../lib/issue-list-analyze-probe.js";

/**
 * PEN-5296 — end-to-end proof against a real PostgreSQL that the probe produces
 * the one thing it exists for: **actual** row counts.
 *
 * The sibling unit file pins the policy (separate flag, term-matched, budgeted,
 * never logs bound values, never throws). A mock cannot show any of what
 * follows, because every one of these is a server behaviour:
 *
 *   - that `EXPLAIN (ANALYZE, BUFFERS)` of a parameterised statement is
 *     accepted over the extended protocol *and* carries `actual rows`/`loops`;
 *   - that `ANALYZE` genuinely executes, which is the difference from PEN-5223;
 *   - that `SET LOCAL statement_timeout` WIDENS past a tighter session bound,
 *     which is the property the whole measurement depends on and the one that
 *     inverts the sibling module's;
 *   - that `ANALYZE`'s extra line shapes still redact.
 *
 * If the server rejected the statement, or the widened bound did not apply,
 * every assertion in the unit file would still pass and the probe would be
 * inert in production — discoverable only by its silence, since it is wrapped
 * in a swallow-everything handler.
 */

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { logger } = await import("../middleware/logger.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue-list ANALYZE probe tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("captureIssueListAnalyzeProbe against real PostgreSQL (PEN-5296)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  const PROBE_TERM = "super-secret-search-term";
  const SECRET_PATTERN = `%${PROBE_TERM}%`;
  const env = { [ISSUE_LIST_ANALYZE_PROBE_FLAG]: PROBE_TERM };

  /** The issues-list search shape: description slice plus `ILIKE ... ESCAPE` arms. */
  const searchQuery = (database: ReturnType<typeof createDb> = db) =>
    database
      .select({
        id: issues.id,
        description: sql<string | null>`substring(${issues.description}, 1, 1201)`,
      })
      .from(issues)
      .where(sql`${issues.companyId} = ${companyId}
        AND (${issues.title} ILIKE ${SECRET_PATTERN} ESCAPE '\\'
          OR ${issues.description} ILIKE ${SECRET_PATTERN} ESCAPE '\\')`)
      .limit(50);

  const probe = (overrides?: Record<string, unknown>) =>
    captureIssueListAnalyzeProbe({
      db,
      query: searchQuery(),
      companyId,
      searchTerm: PROBE_TERM,
      rowsReturned: 0,
      env,
      ...overrides,
    } as any);

  const loggedProbe = () =>
    vi.mocked(logger.warn).mock.calls.find(
      ([, message]) => String(message).includes("deliberate EXPLAIN"),
    );

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-analyze-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
  });

  beforeEach(() => {
    resetIssueListAnalyzeProbeBudget();
    vi.mocked(logger.warn).mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("ANALYZE executes the statement and reports ACTUAL rows, loops and buffers", async () => {
    // The entire reason this instrument exists alongside PEN-5223's. That one
    // asserts `not.toContain("actual time=")`; this asserts the opposite, and
    // the pair is what keeps the two paths from drifting into each other.
    const rows = (await db.execute(
      buildIssueListAnalyzeProbeQuery(searchQuery()),
    )) as unknown as Record<string, unknown>[];
    const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(plan).toContain("actual time=");
    // ⚠️ PG18 prints ACTUAL rows to two decimals (`rows=0.00`) while ESTIMATED
    // rows stay integral (`rows=1`) -- they are averaged over `loops`. An
    // integer-only pattern here matches the estimate and silently never checks
    // the actual, which is the only half this instrument adds. Caught by this
    // test against a real server; worth knowing before reading a production
    // plan, where the two sit on the same line.
    expect(plan).toMatch(/actual time=[\d.]+\.\.[\d.]+ rows=[\d.]+ loops=\d+/);
    expect(plan).toContain("Execution Time:");
    // BUFFERS reports nothing without ANALYZE; a plan with actuals but no
    // buffer line would mean the option was silently dropped.
    expect(plan).toContain("Buffers:");
    // ...and the estimates are still there, so actual-vs-estimated is readable
    // off one artifact. That comparison is the whole deliverable.
    expect(plan).toMatch(/\(cost=[\d.]+\.\.[\d.]+ rows=\d+ width=\d+\)/);
  });

  /**
   * ⭐ The property the measurement depends on, and the one that is backwards
   * from the sibling module.
   *
   * The statement under study approaches and sometimes exceeds the 30 s role
   * `statement_timeout`, and `ANALYZE` adds instrumentation on top. If
   * `SET LOCAL` could only tighten — or if it simply did not apply — the probe
   * would be cancelled **exactly in the case of interest** and a cancelled
   * `ANALYZE` returns no plan at all. The failure would be silent: the handler
   * swallows it.
   *
   * Proven behaviourally against a session whose own bound is far tighter than
   * the statement's runtime, on a pinned single connection so the transaction
   * cannot land somewhere the `SET` never reached.
   */
  it("widens statement_timeout past a tighter session bound, rather than only tightening", async () => {
    const pinned = createDb(tempDb!.connectionString, 1);
    try {
      await pinned.execute(sql.raw("SET statement_timeout = '150ms'"));
      // Positive control: without the probe's SET LOCAL, this statement is
      // cancelled. If this does NOT throw, the session bound never applied and
      // the real assertion below would pass for the wrong reason.
      await expect(pinned.execute(sql.raw("SELECT pg_sleep(0.6)"))).rejects.toThrow();

      await captureIssueListAnalyzeProbe({
        db: pinned,
        query: { getSQL: () => sql`SELECT pg_sleep(0.6), ${SECRET_PATTERN}::text` },
        companyId,
        searchTerm: PROBE_TERM,
        rowsReturned: 1,
        env,
      });

      const call = loggedProbe();
      expect(call, "expected the probe to outlive the session's own 150ms bound").toBeDefined();
      expect(String((call![0] as any).plan)).toContain("Execution Time:");
      expect((call![0] as any).probeMs).toBeGreaterThanOrEqual(600);
    } finally {
      await pinned.$client?.end?.({ timeout: 0 });
    }
  });

  it("logs a plan for a matching term and never logs the search pattern", async () => {
    await probe();
    const call = loggedProbe();
    expect(call, "expected a probe plan to be logged").toBeDefined();
    const payload = call![0] as any;
    const plan = String(payload.plan);
    // The leak this guards: PostgreSQL inlines bound values into `Filter` and
    // `Index Cond` lines, and ANALYZE adds further value-bearing lines
    // (`Rows Removed by Filter`), so the statement text having only
    // placeholders is not sufficient.
    expect(JSON.stringify(payload)).not.toContain(PROBE_TERM);
    expect(payload.searchTermLength).toBe(PROBE_TERM.length);
    // ...and redaction must not have destroyed the artifact. An empty plan
    // would satisfy the assertion above for entirely the wrong reason.
    expect(plan).toMatch(/Scan/);
    expect(plan).toContain("Filter:");
    expect(plan).toContain("~~*"); // PG renders ILIKE as ~~* in plan output
    expect(plan).toMatch(/\$\d/);
    expect(plan).toContain("actual time=");
  });

  it("does not touch the database at all for a term the operator did not name", async () => {
    // The gate is the only thing standing between this and arbitrary tenant
    // traffic, so it is asserted against a real connection rather than a spy.
    await probe({ searchTerm: "some-other-term" });
    expect(loggedProbe()).toBeUndefined();
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it("reverts the widened statement_timeout with its transaction", async () => {
    // SET LOCAL, not SET. A 60s bound leaking onto a pooled connection that
    // goes on to serve ordinary traffic would remove the protection the 30s
    // role timeout exists to give — a strictly worse outcome than the defect
    // under investigation.
    await probe();
    expect(loggedProbe()).toBeDefined();
    const after = (await db.execute(sql.raw("SHOW statement_timeout"))) as unknown as Record<
      string,
      unknown
    >[];
    expect(after[0]!.statement_timeout).not.toBe(`${ISSUE_LIST_ANALYZE_PROBE_TIMEOUT_MS}ms`);
  });
});

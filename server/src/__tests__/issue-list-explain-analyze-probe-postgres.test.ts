import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildIssueListExplainAnalyzeQuery,
  captureIssueListExplainAnalyzeProbe,
  ISSUE_LIST_EXPLAIN_ANALYZE_FLAG,
  ISSUE_LIST_EXPLAIN_ANALYZE_TIMEOUT_MS,
  resetIssueListExplainAnalyzeProbeBudget,
} from "../lib/issue-list-explain-analyze-probe.js";

/**
 * PEN-5296 — end-to-end proof against a real PostgreSQL.
 *
 * The sibling unit file pins the policy: default-off, company-scoped,
 * duration-floored, budget-capped, never logging bound values, never throwing.
 * None of that proves what a mock structurally cannot, and this instrument has
 * four such claims, each of which would otherwise be discovered only after a
 * deploy, by silence:
 *
 *   1. **The server accepts the option string.** `TIMING OFF` beside `ANALYZE`
 *      is valid, and `BUFFERS` reports something once `ANALYZE` is present.
 *   2. **`SET TRANSACTION READ ONLY` is accepted as the first statement of a
 *      drizzle transaction, and actually refuses a write.** The whole safety
 *      argument for executing anything here rests on it.
 *   3. **`statement_timeout` can be raised LOCALly above the role default.**
 *      That is the one capability no sibling instrument has — see the module
 *      doc — and it is a GUC-context question, not a string question.
 *   4. **Redaction survives `ANALYZE`.** `ANALYZE` adds counts rather than
 *      literals *in this format*, which is a claim about how PostgreSQL renders
 *      the plan. A canned plan string in a mock agrees with whatever the test
 *      author assumed; only a real server disagrees.
 */

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { logger } = await import("../middleware/logger.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue-list EXPLAIN (ANALYZE) tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("captureIssueListExplainAnalyzeProbe against real PostgreSQL (PEN-5296)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  const SECRET_TERM = "%super-secret-search-term%";
  const enabled = { [ISSUE_LIST_EXPLAIN_ANALYZE_FLAG]: "1" };

  /** The issues-list search shape: description slice plus `ILIKE ... ESCAPE` arms. */
  const searchQuery = () =>
    db
      .select({
        id: issues.id,
        description: sql<string | null>`substring(${issues.description}, 1, 1201)`,
      })
      .from(issues)
      .where(sql`${issues.companyId} = ${companyId}
        AND (${issues.title} ILIKE ${SECRET_TERM} ESCAPE '\\'
          OR ${issues.description} ILIKE ${SECRET_TERM} ESCAPE '\\')`)
      .limit(50);

  /** `read_only_sql_transaction`. */
  const READ_ONLY_SQLSTATE = "25006";

  /** Walk the cause chain for a PostgreSQL SQLSTATE, as `findPgError` does. */
  const findSqlState = (error: unknown): string | undefined => {
    let current: unknown = error;
    for (let depth = 0; current && depth < 10; depth += 1) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
      current = (current as { cause?: unknown }).cause;
    }
    return undefined;
  };

  const loggedProbe = () =>
    vi
      .mocked(logger.warn)
      .mock.calls.find(([, message]) => String(message).includes("measured actual-vs-estimated"));

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-explain-analyze-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
  });

  beforeEach(() => {
    resetIssueListExplainAnalyzeProbeBudget();
    vi.mocked(logger.warn).mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("PostgreSQL accepts the option string and reports MEASURED rows and buffers", async () => {
    const rows = (await db.execute(
      buildIssueListExplainAnalyzeQuery(searchQuery()),
    )) as unknown as Record<string, unknown>[];
    const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
    // The deliverable: actuals beside the estimates, which is exactly what the
    // PEN-5223 capture and `auto_explain`-on-a-cancelled-statement cannot give.
    expect(plan).toMatch(/actual rows=\d/);
    expect(plan).toContain("Buffers:");
    expect(plan).toContain("Execution Time:");
    // TIMING OFF: total execution time survives, per-node timers do not.
    expect(plan).not.toContain("actual time=");
  });

  it("raises statement_timeout LOCALly above the 30s role default, then reverts", async () => {
    // The capability claim. `statement_timeout` is USERSET, so an ordinary role
    // may raise it for its own transaction — asserted rather than assumed,
    // because a server that refused would make this instrument silently blind
    // to exactly the >30s population it exists to reach.
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '30s'"));
      await tx.execute(
        sql.raw(`SET LOCAL statement_timeout = '${ISSUE_LIST_EXPLAIN_ANALYZE_TIMEOUT_MS}ms'`),
      );
      const rows = (await tx.execute(
        sql.raw("SHOW statement_timeout"),
      )) as unknown as Record<string, unknown>[];
      expect(String(rows[0]?.statement_timeout)).toBe("2min");
    });
    const after = (await db.execute(sql.raw("SHOW statement_timeout"))) as unknown as Record<
      string,
      unknown
    >[];
    // SET LOCAL reverted with the transaction, so nothing leaked onto the
    // pooled connection that serves ordinary traffic.
    expect(String(after[0]?.statement_timeout)).not.toBe("2min");
  });

  it("SET TRANSACTION READ ONLY actually refuses a write", async () => {
    // `ANALYZE` executes, so this is the control that makes "the probe cannot
    // write" a server-enforced property rather than an argument about which
    // query the call site happened to pass.
    let writeError: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw("SET TRANSACTION READ ONLY"));
        await tx.execute(sql`INSERT INTO companies (id, name, issue_prefix)
          VALUES (${randomUUID()}, 'nope', 'NOPE01')`);
      });
      expect.unreachable("expected the write to be refused");
    } catch (error) {
      writeError = error;
    }
    // Asserted on the SQLSTATE walked out of the cause chain, not on the
    // top-level message: drizzle rewrites that to "Failed query: ...", which
    // matches whether the write was refused BY READ ONLY or by anything else —
    // a constraint, a typo in the SQL — so a message assertion here would pass
    // for the wrong reason and prove nothing about the safety property.
    expect(findSqlState(writeError)).toBe(READ_ONLY_SQLSTATE);
  });

  it("captures the measured plan and never logs the search term", async () => {
    await captureIssueListExplainAnalyzeProbe({
      db,
      query: searchQuery(),
      companyId,
      hasSearch: true,
      searchTermLength: 11,
      elapsedMs: 24_000,
      env: enabled,
    });

    const call = loggedProbe();
    expect(call, "expected a measured plan to be logged").toBeDefined();
    const [payload] = call!;
    const plan = String((payload as any).plan);
    // The leak this guards is unchanged by ANALYZE: PostgreSQL inlines bound
    // values into `Index Cond` and `Filter` lines even though the statement
    // text carries only placeholders.
    expect(JSON.stringify(payload)).not.toContain("super-secret-search-term");
    expect((payload as any).statement).toContain("ILIKE $");
    // Redaction must not have destroyed the artifact either: the measured
    // counts are the deliverable, so assert they survived rather than only
    // asserting the term is gone (which an empty plan would also satisfy).
    expect(plan).toMatch(/actual rows=\d/);
    expect(plan).toContain("Buffers:");
    expect(plan).toMatch(/\$\d/);
    expect((payload as any).elapsedMs).toBe(24_000);
    expect(typeof (payload as any).probeMs).toBe("number");
  });

  it("holds the budget against a real round trip, not just a mocked one", async () => {
    for (let i = 0; i < 4; i += 1) {
      await captureIssueListExplainAnalyzeProbe({
        db,
        query: searchQuery(),
        companyId,
        hasSearch: true,
        searchTermLength: 11,
        elapsedMs: 24_000,
        env: enabled,
      });
    }
    const captured = vi
      .mocked(logger.warn)
      .mock.calls.filter(([, message]) => String(message).includes("measured actual-vs-estimated"));
    expect(captured).toHaveLength(2);
  });
});

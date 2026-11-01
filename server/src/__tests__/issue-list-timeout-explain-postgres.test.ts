import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildIssueListExplainQuery,
  captureTimedOutIssueListPlan,
  ISSUE_LIST_EXPLAIN_FLAG,
  ISSUE_LIST_EXPLAIN_TIMEOUT_MS,
  isStatementTimeoutError,
  redactBoundValues,
  resetIssueListExplainCaptureBudget,
} from "../lib/issue-list-timeout-explain.js";

/**
 * PEN-5223 — end-to-end proof against a real PostgreSQL that the diagnostic
 * actually produces a plan.
 *
 * The sibling unit file pins the policy: default-off, capped, never `ANALYZE`,
 * never logging bound values, never throwing. None of that proves the one thing
 * a mock structurally cannot — **that PostgreSQL accepts `EXPLAIN` of a
 * parameterised statement sent over the extended protocol with bound values.**
 *
 * That is the whole mechanism. If the server rejected it, every assertion in the
 * unit file would still pass and the feature would be inert in production — a
 * failure discoverable only after a deploy, on an incident, by its silence. The
 * capture is wrapped in a swallow-everything handler precisely so that nothing
 * at runtime would report it.
 */

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { logger } = await import("../middleware/logger.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue-list EXPLAIN tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("captureTimedOutIssueListPlan against real PostgreSQL (PEN-5223)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  const SECRET_TERM = "%super-secret-search-term%";

  /**
   * A parameterised select in the shape that matters: the issues-list
   * description slice plus the `ILIKE ... ESCAPE` search arms. Built through
   * drizzle so the capture composes a real builder, exactly as `list()` does.
   */
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

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-explain-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
  });

  beforeEach(() => {
    resetIssueListExplainCaptureBudget();
    vi.mocked(logger.warn).mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("PostgreSQL accepts EXPLAIN of a parameterised statement and returns a plan", async () => {
    // The mechanism, isolated: bound values travel with the EXPLAIN over the
    // extended protocol and the server plans it rather than rejecting it.
    const rows = (await db.execute(buildIssueListExplainQuery(searchQuery()))) as unknown as Record<
      string,
      unknown
    >[];
    const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(rows.length).toBeGreaterThan(0);
    expect(plan).toMatch(/Scan|Limit/);
  });

  it("EXPLAIN alone does not execute the statement", async () => {
    // The design constraint that makes this safe to run on an error path: the
    // statement already burned the full statement_timeout, so re-running it
    // would double the cost of the incident. `EXPLAIN` without `ANALYZE` plans
    // only — so the plan carries estimates and no measured rows or timings.
    const rows = (await db.execute(buildIssueListExplainQuery(searchQuery()))) as unknown as Record<
      string,
      unknown
    >[];
    const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(plan).toContain("rows=");
    expect(plan).not.toContain("actual time=");
    expect(plan).not.toContain("Execution Time:");
  });

  it("captures and logs a plan for a real 57014, and never logs the search term", async () => {
    // Provoke a genuine statement_timeout rather than synthesising the error,
    // so the SQLSTATE under test is the one PostgreSQL actually emits.
    let timeoutError: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw("SET LOCAL statement_timeout = '50ms'"));
        await tx.execute(sql.raw("SELECT pg_sleep(2)"));
      });
      expect.unreachable("expected a statement_timeout");
    } catch (error) {
      timeoutError = error;
    }
    // Asserted through the production predicate, not by reading `.code` off the
    // top-level error: drizzle wraps the driver error, so the SQLSTATE sits on a
    // nested `cause`. `findPgError` walking that chain is the reason the hook
    // fires at all, and a direct `.code` read here would pass against a shape
    // the real code path never sees.
    expect((timeoutError as { code?: string }).code).toBeUndefined();
    expect(isStatementTimeoutError(timeoutError)).toBe(true);

    await captureTimedOutIssueListPlan({
      db,
      query: searchQuery(),
      error: timeoutError,
      companyId,
      hasSearch: true,
      searchTermLength: 11,
      env: { [ISSUE_LIST_EXPLAIN_FLAG]: "1" },
    });

    const call = vi
      .mocked(logger.warn)
      .mock.calls.find(([, message]) => String(message).includes("captured production query plan"));
    expect(call, "expected a captured plan to be logged").toBeDefined();
    const [payload] = call!;
    const plan = String((payload as any).plan);
    // The leak this guards: PostgreSQL inlines bound values into `Index Cond`
    // and `Filter` lines, so an unredacted plan carries the user's search term
    // verbatim even though the statement text has only placeholders.
    expect(JSON.stringify(payload)).not.toContain("super-secret-search-term");
    expect((payload as any).statement).toContain("ILIKE $");
    // ...and redaction must not have destroyed the artifact. The plan SHAPE —
    // node types, index names, the filter structure — is the whole deliverable,
    // so assert it survived rather than only asserting the term is gone (which
    // an empty string would also satisfy).
    expect(plan).toMatch(/Scan/);
    expect(plan).toContain("Filter:");
    expect(plan).toContain("~~*"); // PG renders ILIKE as ~~* in plan output
    expect(plan).toMatch(/\$\d/);
    expect(plan).toMatch(/rows=\d/);
  });

  it("redacts a search pattern containing escapeLikePattern backslashes", async () => {
    // The production patterns are built by `escapeLikePattern`, which escapes
    // %, _ and \\ — so a user searching `100%` binds `%100\\%%`. Whether a
    // backslash changes how PostgreSQL renders the literal into the plan is a
    // server behaviour, not a string-handling assumption, so it is asserted
    // against a real server rather than reasoned about.
    const pattern = "%100\\%%";
    const query = db
      .select({ id: issues.id })
      .from(issues)
      .where(sql`${issues.companyId} = ${companyId} AND ${issues.title} ILIKE ${pattern} ESCAPE '\\'`);

    await captureTimedOutIssueListPlan({
      db,
      query,
      error: Object.assign(new Error("canceling statement"), { code: "57014" }),
      companyId,
      hasSearch: true,
      searchTermLength: 4,
      env: { [ISSUE_LIST_EXPLAIN_FLAG]: "1" },
    });

    const call = vi
      .mocked(logger.warn)
      .mock.calls.find(([, message]) => String(message).includes("captured production query plan"));
    expect(call, "expected the plan to be logged, not withheld").toBeDefined();
    expect(JSON.stringify(call![0])).not.toContain("100");
  });

  it("the driver never names a prepared statement, so production plans custom", async () => {
    // This is the property that makes the captured plan the plan production
    // CHOSE rather than a proxy for it. PostgreSQL flips a NAMED prepared
    // statement to a generic plan after five executions (`plan_cache_mode =
    // auto`), while a fresh EXPLAIN is always custom — so if this statement
    // were ever named, the capture would show a good plan production never ran.
    // That failure reads identically to the finding this instrument is set up
    // to accept ("plan shape matches the bench"), i.e. it fails toward a
    // confident wrong answer rather than a visible error.
    //
    // The property belongs to the DRIVER PATH, not the query, so nothing in the
    // SQL reveals it: drizzle routes everything through postgres-js
    // `client.unsafe()`, which hardcodes `prepare: false`. Pinned behaviourally
    // rather than by reading node_modules, so a dependency bump or a switch to
    // `.prepare()` fails here instead of silently making the instrument lie.
    //
    // `max: 1` because `pg_prepared_statements` is session-local — on a larger
    // pool the probe could land on a different connection than the queries and
    // read an empty table for the wrong reason.
    const pinned = createDb(tempDb!.connectionString, 1);
    try {
      for (let i = 0; i < 7; i += 1) {
        await pinned.select({ id: issues.id }).from(issues).where(sql`${issues.companyId} = ${companyId}`);
      }
      const prepared = (await pinned.execute(
        sql.raw("SELECT statement FROM pg_prepared_statements"),
      )) as unknown as { statement: string }[];
      // Asserted against APPLICATION statements, not against an empty table:
      // postgres-js names one bootstrap statement per connection for its own
      // array-type discovery (`from pg_catalog.pg_type ... typcategory = 'A'`),
      // so `count(*) = 0` would fail for a reason that has nothing to do with
      // the property under test.
      // Positive control: that bootstrap row must be PRESENT. Without it, an
      // unreadable or always-empty `pg_prepared_statements` would satisfy the
      // real assertion below for entirely the wrong reason.
      expect(prepared.some((row) => /pg_catalog\.pg_type/.test(row.statement))).toBe(true);
      expect(prepared.every((row) => !/\bfrom "issues"/.test(row.statement))).toBe(true);
    } finally {
      await pinned.$client?.end?.({ timeout: 0 });
    }
  });

  it("keeps real EXPLAIN (SETTINGS) values through redaction", async () => {
    // The format of that line is a server behaviour, so it is asserted against
    // a real server rather than against a hand-written sample: PG prints
    // `Settings: work_mem = '64MB', ...` only for GUCs that differ from their
    // built-in default, which is why they are SET here first.
    const pinned = createDb(tempDb!.connectionString, 1);
    try {
      await pinned.execute(sql.raw("SET work_mem = '64MB'"));
      await pinned.execute(sql.raw("SET random_page_cost = 1.1"));
      const rows = (await pinned.execute(buildIssueListExplainQuery(
        pinned.select({ id: issues.id }).from(issues).where(sql`${issues.title} ILIKE ${"%t%"} ESCAPE '\\'`),
      ))) as unknown as Record<string, unknown>[];
      const raw = rows.map((row) => row["QUERY PLAN"]).join("\n");
      // Positive control: the option must actually have emitted the line, or
      // the assertion below passes against a plan that never had one.
      expect(raw).toContain("Settings:");
      const redacted = redactBoundValues(raw, ["%t%"]);
      expect(redacted).toContain("work_mem = '64MB'");
      expect(redacted).toContain("random_page_cost = '1.1'");
      expect(redacted).not.toContain("'%t%'");
    } finally {
      await pinned.$client?.end?.({ timeout: 0 });
    }
  });

  it("reverts the tightened statement_timeout with its transaction", async () => {
    // SET LOCAL, not SET: the diagnostic's own bound must not leak onto a
    // pooled connection that goes on to serve ordinary traffic.
    await captureTimedOutIssueListPlan({
      db,
      query: searchQuery(),
      error: Object.assign(new Error("canceling statement"), { code: "57014" }),
      companyId,
      hasSearch: true,
      searchTermLength: 11,
      env: { [ISSUE_LIST_EXPLAIN_FLAG]: "1" },
    });

    const after = (await db.execute(sql.raw("SHOW statement_timeout"))) as unknown as Record<
      string,
      unknown
    >[];
    expect(after[0]!.statement_timeout).not.toBe(`${ISSUE_LIST_EXPLAIN_TIMEOUT_MS}ms`);
  });
});

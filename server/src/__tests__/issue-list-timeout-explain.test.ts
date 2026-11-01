import { sql } from "drizzle-orm";
import { PgDialect, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildIssueListExplainQuery,
  captureTimedOutIssueListPlan,
  ISSUE_LIST_EXPLAIN_FLAG,
  ISSUE_LIST_EXPLAIN_MAX_CAPTURES,
  ISSUE_LIST_EXPLAIN_OPTIONS,
  ISSUE_LIST_EXPLAIN_TIMEOUT_MS,
  containsBoundValue,
  redactBoundValues,
  issueListExplainCapturesTaken,
  issueListExplainEnabled,
  isStatementTimeoutError,
  resetIssueListExplainCaptureBudget,
  type ExplainCapableDb,
} from "../lib/issue-list-timeout-explain.js";

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { logger } = await import("../middleware/logger.js");

const dialect = new PgDialect();
const render = (query: Parameters<typeof dialect.sqlToQuery>[0]) => dialect.sqlToQuery(query);

const timeoutError = () => Object.assign(new Error("canceling statement"), { code: "57014" });

/**
 * Stand-in for the issues-list builder: the only surface the capture touches is
 * `getSQL()`, which every drizzle query builder implements. Parameterised so the
 * tests can assert that bound values survive composition and never reach a log.
 */
const issues = pgTable("issues", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id"),
  title: text("title"),
  description: text("description"),
});

const SECRET_TERM = "%super-secret-search-term%";

const listQuery = () => ({
  getSQL: () => sql`select ${issues.id}, substring(${issues.description}, 1, 1201) from ${issues}
    where ${issues.companyId} = ${"company-1"}
      and ${issues.title} ILIKE ${SECRET_TERM} ESCAPE '\\'`,
});

type Executed = { query: string; params: unknown[] };

function fakeDb(options?: {
  rows?: unknown;
  failOn?: "transaction" | "explain";
}): ExplainCapableDb & { executed: Executed[] } {
  const executed: Executed[] = [];
  return {
    executed,
    transaction: async (fn: any) => {
      if (options?.failOn === "transaction") throw new Error("could not start transaction");
      return fn({
        execute: async (query: any) => {
          const built = render(query);
          executed.push({ query: built.sql, params: built.params });
          if (built.sql.startsWith("EXPLAIN") && options?.failOn === "explain") {
            throw Object.assign(new Error("canceling statement due to statement timeout"), {
              code: "57014",
            });
          }
          return built.sql.startsWith("EXPLAIN")
            ? (options?.rows ?? [{ "QUERY PLAN": "Limit  (cost=1.2..3.4 rows=50 width=800)" },
                                 { "QUERY PLAN": "  ->  Bitmap Heap Scan on issues" }])
            : [];
        },
      });
    },
  };
}

const capture = (db: ExplainCapableDb, overrides?: Record<string, unknown>) =>
  captureTimedOutIssueListPlan({
    db,
    query: listQuery(),
    error: timeoutError(),
    companyId: "company-1",
    hasSearch: true,
    searchTermLength: 11,
    env: { [ISSUE_LIST_EXPLAIN_FLAG]: "1" },
    ...overrides,
  } as any);

beforeEach(() => {
  resetIssueListExplainCaptureBudget();
  vi.mocked(logger.warn).mockClear();
});

describe("ISSUE_LIST_EXPLAIN_OPTIONS", () => {
  // The whole point of this diagnostic is that it does NOT execute. ANALYZE
  // would re-run a statement that already burned the 30s statement_timeout,
  // doubling the cost of the incident it exists to diagnose.
  it("never requests ANALYZE", () => {
    expect(ISSUE_LIST_EXPLAIN_OPTIONS).not.toMatch(/ANALYZE/i);
    expect(ISSUE_LIST_EXPLAIN_OPTIONS).toBe("FORMAT TEXT, VERBOSE, COSTS, SETTINGS");
  });

  it("bounds the EXPLAIN well under the 30s role statement_timeout it follows", () => {
    expect(ISSUE_LIST_EXPLAIN_TIMEOUT_MS).toBeLessThan(30_000);
    expect(ISSUE_LIST_EXPLAIN_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("buildIssueListExplainQuery", () => {
  it("composes the builder's own SQL, renumbering placeholders and keeping params", () => {
    const built = render(buildIssueListExplainQuery(listQuery()));
    expect(built.sql.startsWith(`EXPLAIN (${ISSUE_LIST_EXPLAIN_OPTIONS}) select `)).toBe(true);
    // Composition, not transcription: the parameters are carried through in
    // order and the placeholders are renumbered from $1.
    expect(built.params).toEqual(["company-1", SECRET_TERM]);
    expect(built.sql).toContain("$1");
    expect(built.sql).toContain("$2");
    expect(built.sql).not.toContain(SECRET_TERM);
  });

  it("explains the statement that was executed, not a transcription of it", () => {
    const query = listQuery();
    const direct = render(query.getSQL());
    const explained = render(buildIssueListExplainQuery(query));
    expect(explained.sql).toBe(`EXPLAIN (${ISSUE_LIST_EXPLAIN_OPTIONS}) ${direct.sql}`);
    expect(explained.params).toEqual(direct.params);
  });
});

describe("issueListExplainEnabled", () => {
  it("defaults off when the flag is unset", () => {
    expect(issueListExplainEnabled({})).toBe(false);
  });

  it.each(["1", "true", "yes", "on", "enabled", "TRUE", " on "])("accepts %j", (value) => {
    expect(issueListExplainEnabled({ [ISSUE_LIST_EXPLAIN_FLAG]: value })).toBe(true);
  });

  it.each(["0", "false", "no", "off", "disabled", ""])("rejects %j", (value) => {
    expect(issueListExplainEnabled({ [ISSUE_LIST_EXPLAIN_FLAG]: value })).toBe(false);
  });

  it("stays off — and says so — on an unrecognized value", () => {
    expect(issueListExplainEnabled({ [ISSUE_LIST_EXPLAIN_FLAG]: "maybe" })).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("isStatementTimeoutError", () => {
  it("recognizes 57014 and nothing else", () => {
    expect(isStatementTimeoutError(timeoutError())).toBe(true);
    expect(isStatementTimeoutError(Object.assign(new Error("deadlock"), { code: "40P01" }))).toBe(false);
    expect(isStatementTimeoutError(new Error("plain"))).toBe(false);
    expect(isStatementTimeoutError(undefined)).toBe(false);
  });
});

describe("captureTimedOutIssueListPlan", () => {
  it("issues SET LOCAL statement_timeout and then the EXPLAIN, in that order", async () => {
    const db = fakeDb();
    await capture(db);
    expect(db.executed).toHaveLength(2);
    expect(db.executed[0]!.query).toBe(
      `SET LOCAL statement_timeout = '${ISSUE_LIST_EXPLAIN_TIMEOUT_MS}ms'`,
    );
    expect(db.executed[1]!.query.startsWith("EXPLAIN (")).toBe(true);
    // SET LOCAL, not SET: the tightened bound must revert with the transaction
    // rather than leak onto a pooled connection serving ordinary traffic.
    expect(db.executed[0]!.query).not.toMatch(/^SET statement_timeout/);
  });

  it("logs the captured plan", async () => {
    const db = fakeDb();
    await capture(db);
    const [payload, message] = vi.mocked(logger.warn).mock.calls.at(-1)!;
    expect(message).toContain("captured production query plan");
    expect((payload as any).plan).toContain("Bitmap Heap Scan on issues");
    expect((payload as any).companyId).toBe("company-1");
  });

  it("logs the statement with placeholders but never the bound search term", async () => {
    const db = fakeDb();
    await capture(db);
    const [payload] = vi.mocked(logger.warn).mock.calls.at(-1)!;
    const serialized = JSON.stringify(payload);
    // The statement text is what identifies the issues-list SEARCH variant...
    expect((payload as any).statement).toContain("ILIKE $2 ESCAPE");
    expect((payload as any).statement).toContain("substring(");
    // ...but the user-entered term must not ride along with it anywhere.
    expect(serialized).not.toContain(SECRET_TERM);
    expect(serialized).not.toContain("super-secret-search-term");
    expect((payload as any).searchTermLength).toBe(11);
  });

  it("does nothing when the flag is unset", async () => {
    const db = fakeDb();
    await capture(db, { env: {} });
    expect(db.executed).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does nothing for an error that is not 57014", async () => {
    const db = fakeDb();
    await capture(db, { error: Object.assign(new Error("deadlock"), { code: "40P01" }) });
    expect(db.executed).toHaveLength(0);
  });

  it("stops after the per-process cap, so a flag left on cannot fire forever", async () => {
    const db = fakeDb();
    for (let i = 0; i < ISSUE_LIST_EXPLAIN_MAX_CAPTURES + 4; i += 1) await capture(db);
    expect(issueListExplainCapturesTaken()).toBe(ISSUE_LIST_EXPLAIN_MAX_CAPTURES);
    expect(db.executed.filter((e) => e.query.startsWith("EXPLAIN"))).toHaveLength(
      ISSUE_LIST_EXPLAIN_MAX_CAPTURES,
    );
  });

  it("does not overshoot the cap when concurrent timeouts race", async () => {
    // The budget slot is claimed before the await; incrementing afterwards would
    // let a whole burst past the check at once, which is exactly the shape a
    // database already shedding load produces.
    const db = fakeDb();
    await Promise.all(
      Array.from({ length: ISSUE_LIST_EXPLAIN_MAX_CAPTURES + 6 }, () => capture(db)),
    );
    expect(db.executed.filter((e) => e.query.startsWith("EXPLAIN"))).toHaveLength(
      ISSUE_LIST_EXPLAIN_MAX_CAPTURES,
    );
  });

  it("swallows a transaction failure", async () => {
    await expect(capture(fakeDb({ failOn: "transaction" }))).resolves.toBeUndefined();
    expect(vi.mocked(logger.warn).mock.calls.at(-1)![1]).toContain("capture failed");
  });

  it("swallows the EXPLAIN itself timing out", async () => {
    await expect(capture(fakeDb({ failOn: "explain" }))).resolves.toBeUndefined();
    expect(vi.mocked(logger.warn).mock.calls.at(-1)![1]).toContain("capture failed");
  });

  it("swallows a result carrying no QUERY PLAN rows", async () => {
    await expect(capture(fakeDb({ rows: [{ unexpected: 1 }] }))).resolves.toBeUndefined();
    expect(vi.mocked(logger.warn).mock.calls.at(-1)![1]).toContain("no QUERY PLAN rows");
  });

  it("never throws even when the query builder itself is broken", async () => {
    const broken = { getSQL: () => { throw new Error("builder exploded"); } };
    await expect(capture(fakeDb(), { query: broken })).resolves.toBeUndefined();
  });
});

describe("redactBoundValues", () => {
  // PostgreSQL inlines bound values into EXPLAIN output, so the plan leaks them
  // even when the rendered statement carries only placeholders. Proven against a
  // real server in `issue-list-timeout-explain-postgres.test.ts`; pinned here.
  // Ally review on #3237: substituting in INDEX order let a short parameter
  // fragment a longer one, after which the whole-parameter fail-closed check
  // passed and the plan was logged with the rest of the user's search term in
  // clear. This is the realistic binding order, not a contrived one.
  it("does not fragment the search pattern with a shorter param bound earlier", () => {
    // `?status=blocked&q=blocked prod deploy` — `eq(issues.status, ...)` is
    // pushed into `conditions` before `issueSearchMatchCondition` in `list()`,
    // so 'blocked' binds as $1 and the pattern as $2.
    const params = ["blocked", "%blocked prod deploy%"];
    const plan = "Filter: ((issues.title ~~* '%blocked prod deploy%'::text))";
    const redacted = redactBoundValues(plan, params);
    expect(redacted).not.toContain("prod deploy");
    expect(containsBoundValue(redacted, params)).toBe(false);
    expect(redacted).toBe("Filter: ((issues.title ~~* '$2'::text))");
  });

  it("blanks a literal it cannot attribute to any parameter", () => {
    // Pass 2 does not depend on knowing the parameters, so a fragment left by
    // ANY mechanism — a future change to pass 1, or a constant the planner
    // inlined from elsewhere — is removed regardless.
    expect(redactBoundValues("Filter: (title ~~* '%unattributed%'::text)", []))
      .toBe("Filter: (title ~~* '?'::text)");
  });

  it("keeps the plan shape while blanking literals", () => {
    const plan = "Index Scan using issues_company_priority_idx on public.issues  (cost=0.14..8.17 rows=1 width=48)\n"
      + "  Output: id, \"substring\"(description, 1, 1201)\n"
      + "  Index Cond: (issues.company_id = 'a-uuid'::uuid)";
    const redacted = redactBoundValues(plan, []);
    // Identifiers are double-quoted and costs/rows are unquoted, so nothing
    // structural is inside a single-quoted literal.
    expect(redacted).toContain("Index Scan using issues_company_priority_idx");
    expect(redacted).toContain("cost=0.14..8.17 rows=1 width=48");
    expect(redacted).toContain('"substring"(description, 1, 1201)');
    expect(redacted).not.toContain("a-uuid");
  });

  it("replaces a bound value with its placeholder wherever it appears", () => {
    const plan = "Filter: ((title ~~* '%term%'::text) OR (description ~~* '%term%'::text))";
    expect(redactBoundValues(plan, ["company-1", "%term%"])).toBe(
      "Filter: ((title ~~* '$2'::text) OR (description ~~* '$2'::text))",
    );
  });

  it("redacts a value the server rendered with doubled quotes", () => {
    expect(redactBoundValues("Filter: (title ~~* '%o''brien%')", ["%o'brien%"])).toBe(
      "Filter: (title ~~* '$1')",
    );
  });

  it("redacts a pattern carrying escapeLikePattern backslashes", () => {
    // `escapeLikePattern` escapes %, _ and \\, so a user searching `100%`
    // becomes the bound pattern `%100\\%%`. That is the real production shape.
    const pattern = "%100\\%%";
    expect(redactBoundValues(`Filter: (title ~~* '${pattern}'::text)`, [pattern]))
      .toBe("Filter: (title ~~* '$1'::text)");
  });

  it("leaves non-string parameters alone so costs and row estimates survive", () => {
    const plan = "Limit  (cost=0.14..8.17 rows=50 width=48)";
    expect(redactBoundValues(plan, [50, 10])).toBe(plan);
  });

  it("preserves the plan shape, which is the whole artifact", () => {
    const plan = "Index Scan using issues_company_priority_idx on issues  (cost=0.14..8.17 rows=1)\n"
      + "  Filter: (title ~~* '%term%'::text)";
    const redacted = redactBoundValues(plan, ["%term%"]);
    expect(redacted).toContain("Index Scan using issues_company_priority_idx");
    expect(redacted).toContain("cost=0.14..8.17 rows=1");
    expect(redacted).not.toContain("%term%");
  });
});

describe("containsBoundValue", () => {
  it("detects a surviving value and ignores non-strings", () => {
    expect(containsBoundValue("Filter: '%term%'", ["%term%"])).toBe(true);
    expect(containsBoundValue("Filter: '$1'", ["%term%"])).toBe(false);
    expect(containsBoundValue("rows=50", [50])).toBe(false);
    expect(containsBoundValue("anything", [""])).toBe(false);
  });
});

describe("captureTimedOutIssueListPlan — fail-closed redaction", () => {
  /**
   * The withhold branch is a guard, not a currently-reachable path, and saying
   * so is more useful than a test that pretends otherwise.
   *
   * `redactBoundValues` replaces exact substrings and `containsBoundValue`
   * looks for exact substrings, so today the check can only fire on a
   * self-referential parameter (a search term that is literally `$1`). It
   * exists because redaction is an assumption about how the server renders a
   * value — add a length threshold, a regex, or a new parameter type and the
   * two stop being symmetric. Then this fires instead of leaking.
   *
   * It is covered at the predicate level by the `containsBoundValue` block
   * above; this asserts the wiring, via that pathological-but-real parameter.
   */
  it("withholds the plan when a bound value survives redaction", async () => {
    const db = fakeDb({ rows: [{ "QUERY PLAN": "Filter: (title ~~* '$1')" }] });
    await captureTimedOutIssueListPlan({
      db,
      query: { getSQL: () => sql`select 1 from ${issues} where ${issues.title} = ${"$1"}` },
      error: timeoutError(),
      companyId: "company-1",
      hasSearch: true,
      searchTermLength: 2,
      env: { [ISSUE_LIST_EXPLAIN_FLAG]: "1" },
    } as any);
    expect(vi.mocked(logger.warn).mock.calls.at(-1)![1]).toContain("withheld");
  });

  it("logs normally when redaction removed every bound value", async () => {
    const db = fakeDb({ rows: [{ "QUERY PLAN": "Filter: (title ~~* 'a-user-term')" }] });
    await captureTimedOutIssueListPlan({
      db,
      query: { getSQL: () => sql`select 1 from ${issues} where ${issues.title} = ${"a-user-term"}` },
      error: timeoutError(),
      companyId: "company-1",
      hasSearch: true,
      searchTermLength: 11,
      env: { [ISSUE_LIST_EXPLAIN_FLAG]: "1" },
    } as any);
    const calls = vi.mocked(logger.warn).mock.calls;
    expect(calls.at(-1)![1]).toContain("captured production query plan");
    expect(JSON.stringify(calls)).not.toContain("a-user-term");
  });
});

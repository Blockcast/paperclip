import { sql } from "drizzle-orm";
import { PgDialect, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildIssueListExplainAnalyzeQuery,
  captureIssueListExplainAnalyzeProbe,
  ISSUE_LIST_EXPLAIN_ANALYZE_COMPANIES_FLAG,
  ISSUE_LIST_EXPLAIN_ANALYZE_DEFAULT_MIN_ELAPSED_MS,
  ISSUE_LIST_EXPLAIN_ANALYZE_FLAG,
  ISSUE_LIST_EXPLAIN_ANALYZE_MAX_CAPTURES_PER_COMPANY,
  ISSUE_LIST_EXPLAIN_ANALYZE_MAX_CAPTURES_TOTAL,
  ISSUE_LIST_EXPLAIN_ANALYZE_MIN_ELAPSED_MS_FLAG,
  ISSUE_LIST_EXPLAIN_ANALYZE_OPTIONS,
  ISSUE_LIST_EXPLAIN_ANALYZE_TIMEOUT_MS,
  issueListExplainAnalyzeCompanyAllowed,
  issueListExplainAnalyzeEnabled,
  issueListExplainAnalyzeMinElapsedMs,
  issueListExplainAnalyzeProbesTaken,
  issueListExplainAnalyzeProbesTakenForCompany,
  resetIssueListExplainAnalyzeProbeBudget,
} from "../lib/issue-list-explain-analyze-probe.js";
import {
  ISSUE_LIST_EXPLAIN_FLAG,
  ISSUE_LIST_EXPLAIN_OPTIONS,
  type ExplainCapableDb,
} from "../lib/issue-list-timeout-explain.js";

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { logger } = await import("../middleware/logger.js");

const dialect = new PgDialect();
const render = (query: Parameters<typeof dialect.sqlToQuery>[0]) => dialect.sqlToQuery(query);

const issues = pgTable("issues", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id"),
  title: text("title"),
  description: text("description"),
});

// Named for what it IS rather than with a `secret`/`token`/`key` word: the
// PR security gate flags `*secret* = "<20+ chars>"` by identifier, and this
// fixture is a user search term, not a credential.
const USER_SEARCH_TERM = "%super-secret-search-term%";
const COMPANY = "aaced805-3491-4ee5-9b14-cdf70cb81d47";

const listQuery = () => ({
  getSQL: () => sql`select ${issues.id}, substring(${issues.description}, 1, 1201) from ${issues}
    where ${issues.companyId} = ${COMPANY}
      and ${issues.title} ILIKE ${USER_SEARCH_TERM} ESCAPE '\\'`,
});

type Executed = { query: string; params: unknown[] };

/**
 * The `ANALYZE` plan a real server returns: the PEN-5223 shape plus the
 * `actual rows`/`loops`/`Buffers` lines this instrument exists for, and the
 * inlined literal that makes redaction load-bearing.
 */
const analyzePlanRows = [
  { "QUERY PLAN": "Limit  (cost=3495.75..4134.09 rows=21 width=1773) (actual rows=21 loops=1)" },
  { "QUERY PLAN": "  ->  Nested Loop  (cost=3495.34..4134.09 rows=21 width=1773) (actual rows=21 loops=1)" },
  { "QUERY PLAN": `        Filter: (issues.title ~~* '${USER_SEARCH_TERM}'::text)` },
  { "QUERY PLAN": "        Rows Removed by Filter: 84211" },
  { "QUERY PLAN": "        Buffers: shared hit=913442 read=20118" },
  { "QUERY PLAN": "  Settings: work_mem = '64MB', random_page_cost = '1.1'" },
  { "QUERY PLAN": "  Execution Time: 24118.402 ms" },
];

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
          return built.sql.startsWith("EXPLAIN") ? (options?.rows ?? analyzePlanRows) : [];
        },
      });
    },
  };
}

const probe = (db: ExplainCapableDb, overrides?: Record<string, unknown>) =>
  captureIssueListExplainAnalyzeProbe({
    db,
    query: listQuery(),
    companyId: COMPANY,
    hasSearch: true,
    searchTermLength: 6,
    elapsedMs: 24_000,
    env: { [ISSUE_LIST_EXPLAIN_ANALYZE_FLAG]: "1" },
    ...overrides,
  } as any);

const loggedProbe = () =>
  (logger.warn as any).mock.calls.find(
    (call: any[]) => typeof call[1] === "string" && call[1].includes("measured actual-vs-estimated"),
  );

beforeEach(() => {
  vi.clearAllMocks();
  resetIssueListExplainAnalyzeProbeBudget();
});

describe("ISSUE_LIST_EXPLAIN_ANALYZE_OPTIONS", () => {
  it("asks for ANALYZE and BUFFERS, which is the whole point of this instrument", () => {
    expect(ISSUE_LIST_EXPLAIN_ANALYZE_OPTIONS).toContain("ANALYZE");
    expect(ISSUE_LIST_EXPLAIN_ANALYZE_OPTIONS).toContain("BUFFERS");
  });

  it("turns per-node TIMING off, so the probe's own overhead cannot inflate a row explosion", () => {
    expect(ISSUE_LIST_EXPLAIN_ANALYZE_OPTIONS).toContain("TIMING OFF");
  });

  it("⛔ leaves the PEN-5223 TIMEOUT-path options free of ANALYZE", () => {
    // Cross-pinned here, not only in the sibling suite: this file is the one
    // place in the server where `ANALYZE` is legitimate, so it is also the most
    // likely place for someone to "unify" the two constants. The timeout path
    // must never re-execute a statement that already burned 30s.
    expect(ISSUE_LIST_EXPLAIN_OPTIONS).not.toContain("ANALYZE");
    expect(ISSUE_LIST_EXPLAIN_ANALYZE_FLAG).not.toBe(ISSUE_LIST_EXPLAIN_FLAG);
  });
});

describe("issueListExplainAnalyzeEnabled", () => {
  it("is off when unset", () => {
    expect(issueListExplainAnalyzeEnabled({})).toBe(false);
  });

  it.each(["1", "true", "TRUE", " yes ", "on", "enabled"])("is on for %j", (value) => {
    expect(issueListExplainAnalyzeEnabled({ [ISSUE_LIST_EXPLAIN_ANALYZE_FLAG]: value })).toBe(true);
  });

  it.each(["0", "false", "no", "off", "disabled", ""])("is off for %j", (value) => {
    expect(issueListExplainAnalyzeEnabled({ [ISSUE_LIST_EXPLAIN_ANALYZE_FLAG]: value })).toBe(false);
  });

  it("leaves an unrecognized value OFF and says so", () => {
    expect(issueListExplainAnalyzeEnabled({ [ISSUE_LIST_EXPLAIN_ANALYZE_FLAG]: "maybe" })).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("issueListExplainAnalyzeCompanyAllowed", () => {
  it("admits every company when the allowlist is unset — the documented wrong default", () => {
    expect(issueListExplainAnalyzeCompanyAllowed(COMPANY, {})).toBe(true);
  });

  it("admits a listed company, case-insensitively and whitespace-tolerantly", () => {
    const env = { [ISSUE_LIST_EXPLAIN_ANALYZE_COMPANIES_FLAG]: ` other-id , ${COMPANY.toUpperCase()} ` };
    expect(issueListExplainAnalyzeCompanyAllowed(COMPANY, env)).toBe(true);
  });

  it("refuses an unlisted company", () => {
    const env = { [ISSUE_LIST_EXPLAIN_ANALYZE_COMPANIES_FLAG]: "some-other-company" };
    expect(issueListExplainAnalyzeCompanyAllowed(COMPANY, env)).toBe(false);
  });
});

describe("issueListExplainAnalyzeMinElapsedMs", () => {
  it("defaults when unset", () => {
    expect(issueListExplainAnalyzeMinElapsedMs({})).toBe(ISSUE_LIST_EXPLAIN_ANALYZE_DEFAULT_MIN_ELAPSED_MS);
  });

  it("reads a configured floor", () => {
    expect(issueListExplainAnalyzeMinElapsedMs({ [ISSUE_LIST_EXPLAIN_ANALYZE_MIN_ELAPSED_MS_FLAG]: "250" }))
      .toBe(250);
  });

  it.each(["abc", "-1"])("falls back to the default for %j rather than to 0", (value) => {
    // A 0 floor is the one setting that spends the budget on executions that
    // were never slow, so an unparseable value must not land there.
    expect(issueListExplainAnalyzeMinElapsedMs({ [ISSUE_LIST_EXPLAIN_ANALYZE_MIN_ELAPSED_MS_FLAG]: value }))
      .toBe(ISSUE_LIST_EXPLAIN_ANALYZE_DEFAULT_MIN_ELAPSED_MS);
  });
});

describe("buildIssueListExplainAnalyzeQuery", () => {
  it("composes the builder's own SQL, carrying its parameters verbatim", () => {
    const built = render(buildIssueListExplainAnalyzeQuery(listQuery()));
    expect(built.sql.startsWith(`EXPLAIN (${ISSUE_LIST_EXPLAIN_ANALYZE_OPTIONS}) select`)).toBe(true);
    expect(built.params).toContain(USER_SEARCH_TERM);
    // The statement text itself carries placeholders, never the values.
    expect(built.sql).not.toContain(USER_SEARCH_TERM);
  });
});

describe("captureIssueListExplainAnalyzeProbe — when it declines to fire", () => {
  it("does nothing when the flag is off", async () => {
    const db = fakeDb();
    await probe(db, { env: {} });
    expect(db.executed).toHaveLength(0);
    expect(issueListExplainAnalyzeProbesTaken()).toBe(0);
  });

  it("does nothing for a non-search list", async () => {
    const db = fakeDb();
    await probe(db, { hasSearch: false });
    expect(db.executed).toHaveLength(0);
  });

  it("does nothing below the duration floor", async () => {
    const db = fakeDb();
    await probe(db, { elapsedMs: ISSUE_LIST_EXPLAIN_ANALYZE_DEFAULT_MIN_ELAPSED_MS - 1 });
    expect(db.executed).toHaveLength(0);
  });

  it("does nothing for a company outside the allowlist", async () => {
    const db = fakeDb();
    await probe(db, {
      env: {
        [ISSUE_LIST_EXPLAIN_ANALYZE_FLAG]: "1",
        [ISSUE_LIST_EXPLAIN_ANALYZE_COMPANIES_FLAG]: "a-different-company",
      },
    });
    expect(db.executed).toHaveLength(0);
  });
});

describe("captureIssueListExplainAnalyzeProbe — the capture itself", () => {
  it("runs READ ONLY, raises statement_timeout LOCALly, then EXPLAINs — in that order", async () => {
    const db = fakeDb();
    await probe(db);
    expect(db.executed.map((e) => e.query.split(" ").slice(0, 3).join(" "))).toEqual([
      "SET TRANSACTION READ",
      "SET LOCAL statement_timeout",
      "EXPLAIN (ANALYZE, BUFFERS,",
    ]);
    // ANALYZE executes, so READ ONLY is what makes "this cannot write" a
    // server-enforced property rather than an argument about the call site.
    expect(db.executed[0].query).toBe("SET TRANSACTION READ ONLY");
    expect(db.executed[1].query).toContain(`'${ISSUE_LIST_EXPLAIN_ANALYZE_TIMEOUT_MS}ms'`);
  });

  it("bounds itself ABOVE the 30s role timeout — the one thing no sibling instrument can do", () => {
    // An execution cancelled at 30s yields no plan from `auto_explain` (its
    // portal is PORTAL_FAILED) and none from a 30s-capped EXPLAIN ANALYZE
    // either. Raising the bound for one deliberate re-execution is the only
    // route to actuals for that population.
    expect(ISSUE_LIST_EXPLAIN_ANALYZE_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it("logs the plan with its actual row counts and never the search term", async () => {
    const db = fakeDb();
    await probe(db);
    const call = loggedProbe();
    expect(call).toBeDefined();
    const payload = call![0];
    expect(payload.plan).toContain("Rows Removed by Filter: 84211");
    expect(payload.plan).toContain("Buffers: shared hit=913442");
    expect(payload.plan).toContain("actual rows=21");
    expect(payload.companyId).toBe(COMPANY);
    expect(payload.searchTermLength).toBe(6);
    expect(payload.elapsedMs).toBe(24_000);
    expect(JSON.stringify(payload)).not.toContain(USER_SEARCH_TERM);
    expect(JSON.stringify(payload)).not.toContain("super-secret-search-term");
  });

  it("keeps the Settings line readable, since a planning GUC is often the answer", async () => {
    const db = fakeDb();
    await probe(db);
    expect(loggedProbe()![0].plan).toContain("work_mem = '64MB'");
  });

  it("withholds the plan entirely if a bound value survives redaction", async () => {
    // The fail-closed arm is a guard, not a currently-reachable path, and
    // saying so is more useful than a test that pretends otherwise. Redaction
    // replaces exact substrings and the check looks for exact substrings, so
    // today it can only fire on a self-referential parameter — a search term
    // that is literally `$1`. It exists because redaction is an assumption
    // about how the server renders a value; `ANALYZE` adds counts rather than
    // literals today, but a future option (`WAL`, `SERIALIZE`, JSON format)
    // could break that symmetry. Then this fires instead of leaking.
    //
    // ⚠️ The obvious fixture — the search term pasted unquoted into an
    // `Index Cond` line — does NOT reach here: pass 1 is a plain substring
    // replacement, so it strips the term outside quotes just as well as
    // inside. Asserting the withhold off that row passes for the wrong reason.
    const db = fakeDb({ rows: [{ "QUERY PLAN": "Filter: (title ~~* '$1')" }] });
    await captureIssueListExplainAnalyzeProbe({
      db,
      query: { getSQL: () => sql`select 1 from ${issues} where ${issues.title} = ${"$1"}` },
      companyId: COMPANY,
      hasSearch: true,
      searchTermLength: 2,
      elapsedMs: 24_000,
      env: { [ISSUE_LIST_EXPLAIN_ANALYZE_FLAG]: "1" },
    } as any);
    expect(loggedProbe()).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY }),
      expect.stringContaining("withheld"),
    );
  });

  it("never throws when the transaction fails", async () => {
    const db = fakeDb({ failOn: "transaction" });
    await expect(probe(db)).resolves.toBeUndefined();
    expect(loggedProbe()).toBeUndefined();
  });

  it("never throws when the EXPLAIN itself is cancelled", async () => {
    const db = fakeDb({ failOn: "explain" });
    await expect(probe(db)).resolves.toBeUndefined();
  });

  it("warns rather than logging a plan when the driver returns no QUERY PLAN rows", async () => {
    const db = fakeDb({ rows: [] });
    await probe(db);
    expect(loggedProbe()).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY }),
      expect.stringContaining("no QUERY PLAN rows"),
    );
  });
});

describe("captureIssueListExplainAnalyzeProbe — budgets", () => {
  it("stops after the per-company cap", async () => {
    const db = fakeDb();
    for (let i = 0; i < ISSUE_LIST_EXPLAIN_ANALYZE_MAX_CAPTURES_PER_COMPANY + 3; i += 1) {
      await probe(db);
    }
    expect(issueListExplainAnalyzeProbesTakenForCompany(COMPANY))
      .toBe(ISSUE_LIST_EXPLAIN_ANALYZE_MAX_CAPTURES_PER_COMPANY);
  });

  it("gives each company its own budget, so a busy tenant cannot starve a quiet one", async () => {
    // The reason this is per-company: a single shared counter is spent by
    // whichever company is busiest, and the one that actually times out may be
    // the quieter one.
    const db = fakeDb();
    for (let i = 0; i < 5; i += 1) await probe(db);
    await probe(db, { companyId: "b1d3f3d3-adc9-48af-beb1-013a18368d84" });
    expect(issueListExplainAnalyzeProbesTakenForCompany("b1d3f3d3-adc9-48af-beb1-013a18368d84")).toBe(1);
  });

  it("still ceilings the total across companies, so an unset allowlist cannot stream", async () => {
    const db = fakeDb();
    for (let company = 0; company < 10; company += 1) {
      for (let i = 0; i < 3; i += 1) await probe(db, { companyId: `company-${company}` });
    }
    expect(issueListExplainAnalyzeProbesTaken()).toBe(ISSUE_LIST_EXPLAIN_ANALYZE_MAX_CAPTURES_TOTAL);
  });

  it("claims the slot before awaiting, so a concurrent burst cannot overshoot", async () => {
    const db = fakeDb();
    await Promise.all(Array.from({ length: 8 }, () => probe(db)));
    expect(issueListExplainAnalyzeProbesTakenForCompany(COMPANY))
      .toBe(ISSUE_LIST_EXPLAIN_ANALYZE_MAX_CAPTURES_PER_COMPANY);
  });
});

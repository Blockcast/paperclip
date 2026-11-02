import { sql } from "drizzle-orm";
import { PgDialect, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildIssueListAnalyzeProbeQuery,
  captureIssueListAnalyzeProbe,
  ISSUE_LIST_ANALYZE_PROBE_FLAG,
  ISSUE_LIST_ANALYZE_PROBE_MAX_CAPTURES,
  ISSUE_LIST_ANALYZE_PROBE_OPTIONS,
  ISSUE_LIST_ANALYZE_PROBE_TIMEOUT_MS,
  issueListAnalyzeProbeCapturesTaken,
  issueListAnalyzeProbeTerm,
  resetIssueListAnalyzeProbeBudget,
  shouldProbeIssueListSearch,
} from "../lib/issue-list-analyze-probe.js";
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

const PROBE_TERM = "the";
const SECRET_TERM = `%${PROBE_TERM}%`;

const listQuery = () => ({
  getSQL: () => sql`select ${issues.id} from ${issues}
    where ${issues.companyId} = ${"company-1"}
      and ${issues.title} ILIKE ${SECRET_TERM} ESCAPE '\\'`,
});

type Executed = { query: string; params: unknown[] };

function fakeDb(options?: { rows?: unknown; failOn?: "transaction" | "explain" }):
  ExplainCapableDb & { executed: Executed[] } {
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
            throw new Error("boom");
          }
          return built.sql.startsWith("EXPLAIN")
            ? (options?.rows ?? [
                { "QUERY PLAN": "Limit  (cost=3495.75..4134.09 rows=21 width=1773) (actual time=24110.2..24110.4 rows=1 loops=1)" },
                { "QUERY PLAN": "  ->  Append  (cost=0..1 rows=70 width=16) (actual rows=4812 loops=1)" },
              ])
            : [];
        },
      });
    },
  };
}

const probe = (db: ExplainCapableDb, overrides?: Record<string, unknown>) =>
  captureIssueListAnalyzeProbe({
    db,
    query: listQuery(),
    companyId: "company-1",
    searchTerm: PROBE_TERM,
    rowsReturned: 1,
    env: { [ISSUE_LIST_ANALYZE_PROBE_FLAG]: PROBE_TERM },
    ...overrides,
  } as any);

const loggedPlan = () => {
  const call = vi.mocked(logger.warn).mock.calls.find(
    ([, message]) => typeof message === "string" && message.includes("deliberate EXPLAIN"),
  );
  return call?.[0] as Record<string, unknown> | undefined;
};

beforeEach(() => {
  resetIssueListAnalyzeProbeBudget();
  vi.mocked(logger.warn).mockClear();
});

describe("ISSUE_LIST_ANALYZE_PROBE_OPTIONS", () => {
  // The inverse of `issue-list-timeout-explain`'s assertion, and the whole
  // reason this is a second instrument: actual-vs-estimated rows exist only
  // under ANALYZE, and BUFFERS reports nothing without it.
  it("requests ANALYZE and BUFFERS", () => {
    expect(ISSUE_LIST_ANALYZE_PROBE_OPTIONS).toMatch(/\bANALYZE\b/);
    expect(ISSUE_LIST_ANALYZE_PROBE_OPTIONS).toMatch(/\bBUFFERS\b/);
  });

  // PEN-5223's prohibition is unchanged by this row existing. If a future edit
  // ever teaches the timeout path to ANALYZE, this fails here as well as there.
  it("leaves the timed-out-statement capture free of ANALYZE", () => {
    expect(ISSUE_LIST_EXPLAIN_OPTIONS).not.toMatch(/ANALYZE/i);
  });

  it("is reached by a different flag than the timeout capture", () => {
    expect(ISSUE_LIST_ANALYZE_PROBE_FLAG).not.toBe(ISSUE_LIST_EXPLAIN_FLAG);
  });

  // Deliberately ABOVE the 30s role statement_timeout. A probe bounded at 30s
  // would be cancelled exactly in the case of interest, and a cancelled ANALYZE
  // returns no plan at all. See the constant's doc comment.
  it("bounds the probe above the 30s role statement_timeout it measures", () => {
    expect(ISSUE_LIST_ANALYZE_PROBE_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it("keeps the probe budget small, because each probe executes the statement", () => {
    expect(ISSUE_LIST_ANALYZE_PROBE_MAX_CAPTURES).toBeGreaterThan(0);
    expect(ISSUE_LIST_ANALYZE_PROBE_MAX_CAPTURES).toBeLessThanOrEqual(3);
  });
});

describe("issueListAnalyzeProbeTerm", () => {
  it("is off when unset, empty, or whitespace-only", () => {
    expect(issueListAnalyzeProbeTerm({})).toBeNull();
    expect(issueListAnalyzeProbeTerm({ [ISSUE_LIST_ANALYZE_PROBE_FLAG]: "" })).toBeNull();
    expect(issueListAnalyzeProbeTerm({ [ISSUE_LIST_ANALYZE_PROBE_FLAG]: "   " })).toBeNull();
  });

  it("trims and lower-cases, matching how list() handles `q`", () => {
    expect(issueListAnalyzeProbeTerm({ [ISSUE_LIST_ANALYZE_PROBE_FLAG]: "  The " })).toBe("the");
  });
});

describe("shouldProbeIssueListSearch", () => {
  const env = { [ISSUE_LIST_ANALYZE_PROBE_FLAG]: "the" };

  it("matches the operator-chosen term regardless of case or surrounding space", () => {
    expect(shouldProbeIssueListSearch("the", env)).toBe(true);
    expect(shouldProbeIssueListSearch(" THE ", env)).toBe(true);
  });

  // This is the whole of what keeps the probe off arbitrary tenant traffic.
  it("does not fire on any other term", () => {
    expect(shouldProbeIssueListSearch("there", env)).toBe(false);
    expect(shouldProbeIssueListSearch("ent", env)).toBe(false);
    expect(shouldProbeIssueListSearch("", env)).toBe(false);
  });

  it("does not fire at all when the flag is unset", () => {
    expect(shouldProbeIssueListSearch("the", {})).toBe(false);
  });
});

describe("buildIssueListAnalyzeProbeQuery", () => {
  it("composes the builder's own SQL, keeping its parameters in order", () => {
    const built = render(buildIssueListAnalyzeProbeQuery(listQuery()));
    expect(built.sql.startsWith(`EXPLAIN (${ISSUE_LIST_ANALYZE_PROBE_OPTIONS}) select `)).toBe(true);
    expect(built.params).toEqual(["company-1", SECRET_TERM]);
  });
});

describe("captureIssueListAnalyzeProbe", () => {
  it("runs the probe and logs the plan when the term matches", async () => {
    const db = fakeDb();
    await probe(db);
    expect(db.executed.some((e) => e.query.startsWith("EXPLAIN (ANALYZE"))).toBe(true);
    expect(loggedPlan()?.plan).toContain("actual rows=4812");
  });

  it("widens statement_timeout with SET LOCAL, inside the probe's own transaction", async () => {
    const db = fakeDb();
    await probe(db);
    expect(db.executed[0]?.query).toBe(
      `SET LOCAL statement_timeout = '${ISSUE_LIST_ANALYZE_PROBE_TIMEOUT_MS}ms'`,
    );
  });

  it("does nothing when the flag is unset", async () => {
    const db = fakeDb();
    await probe(db, { env: {} });
    expect(db.executed).toEqual([]);
    expect(issueListAnalyzeProbeCapturesTaken()).toBe(0);
  });

  it("does nothing for a search term the operator did not name", async () => {
    const db = fakeDb();
    await probe(db, { searchTerm: "something-else" });
    expect(db.executed).toEqual([]);
  });

  it("stops at the budget", async () => {
    const db = fakeDb();
    for (let i = 0; i < ISSUE_LIST_ANALYZE_PROBE_MAX_CAPTURES + 3; i += 1) await probe(db);
    expect(issueListAnalyzeProbeCapturesTaken()).toBe(ISSUE_LIST_ANALYZE_PROBE_MAX_CAPTURES);
  });

  // Each overshoot is ~25s of production database time, so the slot is claimed
  // before the first await rather than after the probe returns.
  it("does not overshoot the budget under a concurrent burst", async () => {
    const db = fakeDb();
    await Promise.all(
      Array.from({ length: ISSUE_LIST_ANALYZE_PROBE_MAX_CAPTURES + 5 }, () => probe(db)),
    );
    expect(issueListAnalyzeProbeCapturesTaken()).toBe(ISSUE_LIST_ANALYZE_PROBE_MAX_CAPTURES);
  });

  it("never logs the bound search pattern, and records only its length", async () => {
    const db = fakeDb({
      rows: [{ "QUERY PLAN": `  Filter: (issues.title ~~* '${SECRET_TERM}'::text)` }],
    });
    await probe(db, { searchTerm: PROBE_TERM });
    const logged = loggedPlan();
    expect(logged?.plan).not.toContain(SECRET_TERM);
    expect(logged?.plan).toContain("$2");
    expect(logged?.searchTermLength).toBe(PROBE_TERM.length);
    expect(JSON.stringify(logged)).not.toContain(SECRET_TERM);
  });

  /**
   * Fail closed: losing a diagnostic is recoverable, logging a user's search
   * term is not. As in the PEN-5223 capture, the withhold branch is a guard
   * rather than a currently-reachable path -- redaction replaces exact
   * substrings and the check looks for exact substrings, so today it can only
   * fire on a self-referential parameter. It exists because redaction is an
   * assumption about how the server renders a value; this asserts the wiring,
   * via that pathological-but-real parameter.
   */
  it("withholds the plan entirely when a bound value survives redaction", async () => {
    const db = fakeDb({ rows: [{ "QUERY PLAN": "Filter: (title ~~* '$1')" }] });
    await probe(db, {
      query: { getSQL: () => sql`select 1 from ${issues} where ${issues.title} = ${"$1"}` },
    });
    expect(vi.mocked(logger.warn).mock.calls.at(-1)![1]).toContain("withheld");
    expect(loggedPlan()).toBeUndefined();
  });

  it("never throws when the transaction fails", async () => {
    await expect(probe(fakeDb({ failOn: "transaction" }))).resolves.toBeUndefined();
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });

  it("never throws when the EXPLAIN itself fails", async () => {
    await expect(probe(fakeDb({ failOn: "explain" }))).resolves.toBeUndefined();
  });

  it("warns rather than logging a plan when the result carries no QUERY PLAN rows", async () => {
    await probe(fakeDb({ rows: [{ other: "column" }] }));
    expect(loggedPlan()).toBeUndefined();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "company-1" }),
      expect.stringContaining("no QUERY PLAN rows"),
    );
  });
});

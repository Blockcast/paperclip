import { sql } from "drizzle-orm";
import { PgDialect, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildWakeDiagnosticsProbeQuery,
  captureWakeDiagnosticsAnalyzeProbe,
  resetWakeDiagnosticsProbeBudget,
  shouldProbeWakeDiagnostics,
  wakeDiagnosticsProbeCapturesTaken,
  wakeDiagnosticsProbeIssueIds,
  WAKE_DIAGNOSTICS_PROBE_FLAG,
  WAKE_DIAGNOSTICS_PROBE_MAX_CAPTURES,
  WAKE_DIAGNOSTICS_PROBE_OPTIONS,
  WAKE_DIAGNOSTICS_PROBE_TIMEOUT_MS,
} from "../lib/issue-wake-diagnostics-analyze-probe.js";
import {
  ISSUE_LIST_EXPLAIN_FLAG,
  ISSUE_LIST_EXPLAIN_OPTIONS,
  type ExplainCapableDb,
} from "../lib/issue-list-timeout-explain.js";
import { ISSUE_LIST_ANALYZE_PROBE_FLAG } from "../lib/issue-list-analyze-probe.js";

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { logger } = await import("../middleware/logger.js");

const dialect = new PgDialect();
const render = (query: Parameters<typeof dialect.sqlToQuery>[0]) => dialect.sqlToQuery(query);

const agentWakeupRequests = pgTable("agent_wakeup_requests", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id"),
  payload: jsonb("payload"),
  requestedAt: timestamp("requested_at"),
});

const ISSUE_ID = "ab382aa7-feb9-4349-90a3-922fabd8a0ed";
const OTHER_ISSUE_ID = "11111111-2222-3333-4444-555555555555";

/** The four-arm membership disjunction, as the diagnostics statement issues it. */
const wakeQuery = () => ({
  getSQL: () => sql`select ${agentWakeupRequests.id} from ${agentWakeupRequests}
    where ${agentWakeupRequests.companyId} = ${"company-1"}
      and (${agentWakeupRequests.payload} ->> 'issueId' = ${ISSUE_ID}
        or ${agentWakeupRequests.payload} ->> 'taskId' = ${ISSUE_ID})`,
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
                { "QUERY PLAN": "Limit  (cost=0..4134.09 rows=21 width=1773) (actual time=237.4..237.6 rows=6 loops=1)" },
                { "QUERY PLAN": "  ->  Index Scan using agent_wakeup_requests_company_requested_idx (actual rows=6 loops=1)" },
                { "QUERY PLAN": "        Rows Removed by Filter: 158651" },
              ])
            : [];
        },
      });
    },
  } as ExplainCapableDb & { executed: Executed[] };
}

const probe = (db: ExplainCapableDb, overrides?: Record<string, unknown>) =>
  captureWakeDiagnosticsAnalyzeProbe({
    db,
    query: wakeQuery(),
    companyId: "company-1",
    issueId: ISSUE_ID,
    rowsReturned: 6,
    statementMs: 238,
    env: { [WAKE_DIAGNOSTICS_PROBE_FLAG]: ISSUE_ID },
    ...overrides,
  } as any);

const loggedPlan = () => {
  const call = vi.mocked(logger.warn).mock.calls.find(
    ([, message]) => typeof message === "string" && message.includes("deliberate EXPLAIN"),
  );
  return call?.[0] as Record<string, unknown> | undefined;
};

beforeEach(() => {
  resetWakeDiagnosticsProbeBudget();
  vi.mocked(logger.warn).mockClear();
});

describe("WAKE_DIAGNOSTICS_PROBE_OPTIONS", () => {
  // Actual-vs-estimated rows and `Rows Removed by Filter` — the two things
  // done-when 1 names — exist only under ANALYZE. BUFFERS reports nothing
  // without it.
  it("requests ANALYZE and BUFFERS", () => {
    expect(WAKE_DIAGNOSTICS_PROBE_OPTIONS).toMatch(/\bANALYZE\b/);
    expect(WAKE_DIAGNOSTICS_PROBE_OPTIONS).toMatch(/\bBUFFERS\b/);
  });

  // PEN-5223's prohibition is unchanged by this instrument existing. If a
  // future edit ever teaches the timeout path to ANALYZE, this fails here too.
  it("leaves the timed-out-statement capture free of ANALYZE", () => {
    expect(ISSUE_LIST_EXPLAIN_OPTIONS).not.toMatch(/ANALYZE/i);
  });

  it("is reached by its own flag, distinct from both issues-list flags", () => {
    expect(WAKE_DIAGNOSTICS_PROBE_FLAG).not.toBe(ISSUE_LIST_EXPLAIN_FLAG);
    expect(WAKE_DIAGNOSTICS_PROBE_FLAG).not.toBe(ISSUE_LIST_ANALYZE_PROBE_FLAG);
  });

  // The deliberate inverse of the issues-list ANALYZE probe, which widens its
  // bound past 30s because the statement it measures approaches 30s. This one
  // measures a statement whose worst production reading is 3.4s, so the tight
  // bound costs nothing and keeps the probe under the role timeout.
  it("bounds the probe under the 30s role statement_timeout", () => {
    expect(WAKE_DIAGNOSTICS_PROBE_TIMEOUT_MS).toBeLessThan(30_000);
    // ...and still comfortably above the slowest end-to-end reading taken.
    expect(WAKE_DIAGNOSTICS_PROBE_TIMEOUT_MS).toBeGreaterThan(3_400);
  });

  it("keeps the probe budget bounded", () => {
    expect(WAKE_DIAGNOSTICS_PROBE_MAX_CAPTURES).toBeGreaterThan(0);
    expect(WAKE_DIAGNOSTICS_PROBE_MAX_CAPTURES).toBeLessThanOrEqual(5);
  });
});

describe("wakeDiagnosticsProbeIssueIds", () => {
  it("is off when unset, empty, or whitespace-only", () => {
    expect(wakeDiagnosticsProbeIssueIds({})).toEqual([]);
    expect(wakeDiagnosticsProbeIssueIds({ [WAKE_DIAGNOSTICS_PROBE_FLAG]: "" })).toEqual([]);
    expect(wakeDiagnosticsProbeIssueIds({ [WAKE_DIAGNOSTICS_PROBE_FLAG]: "  " })).toEqual([]);
  });

  // A SET, not one id: done-when 4 asks for >=2 rows, and the dense/sparse
  // contrast IS the finding. Needing a redeploy between the two halves of one
  // comparison would put a deploy in the middle of the measurement.
  it("reads a comma-separated set, trimming and dropping blanks", () => {
    expect(
      wakeDiagnosticsProbeIssueIds({
        [WAKE_DIAGNOSTICS_PROBE_FLAG]: ` ${ISSUE_ID.toUpperCase()} , ${OTHER_ISSUE_ID},, `,
      }),
    ).toEqual([ISSUE_ID, OTHER_ISSUE_ID]);
  });
});

describe("shouldProbeWakeDiagnostics", () => {
  it("fires only on an operator-named issue", () => {
    const env = { [WAKE_DIAGNOSTICS_PROBE_FLAG]: `${ISSUE_ID},${OTHER_ISSUE_ID}` };
    expect(shouldProbeWakeDiagnostics(ISSUE_ID, env)).toBe(true);
    expect(shouldProbeWakeDiagnostics(OTHER_ISSUE_ID, env)).toBe(true);
    expect(shouldProbeWakeDiagnostics("99999999-0000-0000-0000-000000000000", env)).toBe(false);
  });

  it("never fires with the flag unset", () => {
    expect(shouldProbeWakeDiagnostics(ISSUE_ID, {})).toBe(false);
  });
});

describe("buildWakeDiagnosticsProbeQuery", () => {
  it("prefixes the statement and keeps its bound parameters", () => {
    const built = render(buildWakeDiagnosticsProbeQuery(wakeQuery()));
    expect(built.sql.startsWith(`EXPLAIN (${WAKE_DIAGNOSTICS_PROBE_OPTIONS})`)).toBe(true);
    expect(built.params).toContain(ISSUE_ID);
  });
});

describe("captureWakeDiagnosticsAnalyzeProbe", () => {
  it("does nothing when the flag is unset", async () => {
    const db = fakeDb();
    await probe(db, { env: {} });
    expect(db.executed).toHaveLength(0);
    expect(wakeDiagnosticsProbeCapturesTaken()).toBe(0);
  });

  it("does nothing for an issue the operator did not name", async () => {
    const db = fakeDb();
    await probe(db, { issueId: OTHER_ISSUE_ID });
    expect(db.executed).toHaveLength(0);
  });

  it("bounds itself with SET LOCAL before explaining", async () => {
    const db = fakeDb();
    await probe(db);
    expect(db.executed[0]?.query).toBe(
      `SET LOCAL statement_timeout = '${WAKE_DIAGNOSTICS_PROBE_TIMEOUT_MS}ms'`,
    );
    expect(db.executed[1]?.query.startsWith("EXPLAIN")).toBe(true);
  });

  // The whole point of the instrument: the plan's own execution time and its
  // Rows Removed by Filter, logged beside the wall time of the original await.
  // Without `statementMs` the capture answers only half the (a)-vs-(b) question.
  it("logs the plan beside the original statement's wall time", async () => {
    await probe(fakeDb());
    const logged = loggedPlan();
    expect(logged?.statementMs).toBe(238);
    expect(logged?.rowsReturned).toBe(6);
    expect(logged?.issueId).toBe(ISSUE_ID);
    expect(String(logged?.plan)).toContain("Rows Removed by Filter: 158651");
    expect(typeof logged?.probeMs).toBe("number");
  });

  it("redacts bound values out of the plan text", async () => {
    await probe(fakeDb({
      rows: [{ "QUERY PLAN": `Filter: (payload ->> 'issueId'::text) = '${ISSUE_ID}'::text` }],
    }));
    const logged = loggedPlan();
    expect(logged).toBeDefined();
    expect(String(logged?.plan)).not.toContain(ISSUE_ID);
  });

  /**
   * As in the PEN-5223 capture and the PEN-5296 probe, the withhold branch is a
   * GUARD rather than a currently-reachable path: redaction replaces exact
   * substrings and the check looks for exact substrings, so today it can only
   * fire on a self-referential parameter. It exists because redaction is an
   * assumption about how the server renders a value, and this asserts the
   * wiring via that pathological-but-real parameter.
   *
   * ⚠️ It is NOT reachable by case: `containsBoundValue` is exact and
   * case-sensitive, so an upper-cased echo of a bound UUID is not a leak it
   * models. Asserting otherwise tests the test, not the guard.
   */
  it("withholds the plan entirely when a bound value survives redaction", async () => {
    await probe(fakeDb({ rows: [{ "QUERY PLAN": "Filter: (payload ->> 'issueId') = '$1'" }] }), {
      query: {
        getSQL: () =>
          sql`select ${agentWakeupRequests.id} from ${agentWakeupRequests}
            where ${agentWakeupRequests.payload} ->> 'issueId' = ${"$1"}`,
      },
    });
    expect(loggedPlan()).toBeUndefined();
    expect(vi.mocked(logger.warn).mock.calls.at(-1)![1]).toContain("withheld");
  });

  it("claims its budget slot before awaiting, so a burst cannot overshoot", async () => {
    const db = fakeDb();
    await Promise.all(
      Array.from({ length: WAKE_DIAGNOSTICS_PROBE_MAX_CAPTURES + 4 }, () => probe(db)),
    );
    expect(wakeDiagnosticsProbeCapturesTaken()).toBe(WAKE_DIAGNOSTICS_PROBE_MAX_CAPTURES);
  });

  // Never throws: the caller already has a successful response in hand, and a
  // diagnostic that raised on top of it would convert a working endpoint into a
  // defect.
  it.each(["transaction", "explain"] as const)("swallows a %s failure", async (failOn) => {
    await expect(probe(fakeDb({ failOn }))).resolves.toBeUndefined();
    expect(loggedPlan()).toBeUndefined();
  });

  it("warns rather than logging nothing when the plan comes back empty", async () => {
    await probe(fakeDb({ rows: [] }));
    expect(
      vi.mocked(logger.warn).mock.calls.some(
        ([, message]) => typeof message === "string" && message.includes("no QUERY PLAN rows"),
      ),
    ).toBe(true);
  });

  // A `57014` cancel of the probe is the ONE outcome that says the scan cost
  // more than WAKE_DIAGNOSTICS_PROBE_TIMEOUT_MS, and it is unreadable without
  // the original statement's wall time beside it. Pins that the failure warn
  // carries the correlation fields rather than just the error.
  it("reports the original statement's figures on the failure path", async () => {
    await probe(fakeDb({ failOn: "explain" }));
    const failure = vi.mocked(logger.warn).mock.calls.find(
      ([, message]) => typeof message === "string" && message.includes("ANALYZE probe failed"),
    )?.[0] as Record<string, unknown> | undefined;
    expect(failure).toBeDefined();
    expect(failure).toMatchObject({
      probe: 1,
      companyId: "company-1",
      issueId: ISSUE_ID,
      rowsReturned: 6,
      statementMs: 238,
    });
    expect(typeof failure?.probeMs).toBe("number");
  });

  // The budget and flag gates `return` before the probe starts, so there is no
  // elapsed time to report and `probeMs` must not be a reading off a zero
  // `startedAt`. Nothing is logged at all on those paths.
  it("logs no failure record when the flag gate short-circuits", async () => {
    await probe(fakeDb(), { env: {} });
    expect(
      vi.mocked(logger.warn).mock.calls.some(
        ([, message]) => typeof message === "string" && message.includes("ANALYZE probe failed"),
      ),
    ).toBe(false);
  });
});

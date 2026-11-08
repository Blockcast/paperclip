import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ISSUE_WAKE_DIAGNOSTICS_STATEMENT_TIMEOUT_MS,
  readBoundedWakeDiagnosticsSection,
} from "../services/issues.js";
import { findPgError, STATEMENT_TIMEOUT_SQLSTATE } from "../lib/db-retry.js";
import { buildIssueWakeDiagnosticsResponse } from "../routes/issues.js";

/**
 * PEN-6085: the per-section statement budget behind
 * `GET /api/issues/:id/diagnostics/wakes`.
 *
 * The route returned `503 statement_timeout` on all six attempts three
 * separate seats made over two days, because neither of its two reads can be
 * index-served and the two ran as SEQUENTIAL `await`s under the 30 s role
 * default — so the route's worst case was 2x `statement_timeout` and a caller
 * waited a full minute to be told nothing.
 *
 * ⚠️ It is INTERMITTENT, not dead, and this matters for anyone re-testing it:
 * measured 2026-11-08T11:0x–11:1xZ, PEN-5734 returned `503` and then returned
 * `200` about ten minutes later with no deploy in between, while a light row
 * (12 wake requests) answered fast both times. So a single green probe does
 * NOT show the route is fixed — it is contention-dependent, which is exactly
 * why the remedy here is a bounded partial rather than a faster query.
 *
 * Two properties are asserted here, and the first is the one most likely to
 * break silently: that `SET LOCAL statement_timeout` is actually APPLIED to the
 * statement. A budget that is computed, logged and never reaches Postgres looks
 * identical from outside to one that works, right up until the route times out
 * at 30 s again.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake diagnostics budget tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("wake diagnostics statement budget (PEN-6085)", () => {
  let database: EmbeddedPostgresTestDatabase | null = null;
  let db: Db;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-wake-diagnostics-budget-");
    db = createDb(database.connectionString);
  }, 180_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  it("applies the budget to the statement, as a transaction-local setting", async () => {
    const { rows, degraded } = await readBoundedWakeDiagnosticsSection(
      db,
      "wakeRequests",
      "issue-under-test",
      async (tx) => {
        const result = await tx.execute(sql`SHOW statement_timeout`);
        return Array.from(result as Iterable<{ statement_timeout: string }>);
      },
    );

    expect(degraded).toBe(false);
    // Postgres renders 10000ms as '10s'. Asserting the VALUE rather than merely
    // that the SET ran is what distinguishes "the bound reached the statement"
    // from "the bound was issued against a different connection".
    expect(rows[0]?.statement_timeout).toBe("10s");
    expect(ISSUE_WAKE_DIAGNOSTICS_STATEMENT_TIMEOUT_MS).toBe(10_000);
  });

  it("does not leak the narrowed bound onto the pooled connection", async () => {
    await readBoundedWakeDiagnosticsSection(db, "wakeRequests", "issue-under-test", async (tx) => {
      await tx.execute(sql`SELECT 1`);
      return [];
    });

    // `SET LOCAL` reverts with the transaction. If this ever reads '10s', the
    // diagnostic route has quietly tightened the bound for every other query
    // that later borrows the same pooled connection.
    const after = await db.execute(sql`SHOW statement_timeout`);
    const [row] = Array.from(after as Iterable<{ statement_timeout: string }>);
    expect(row?.statement_timeout).not.toBe("10s");
  });

  it("degrades to an empty section when the statement exceeds the budget", async () => {
    const { rows, degraded } = await readBoundedWakeDiagnosticsSection(
      db,
      "activityRecords",
      "issue-under-test",
      async (tx) => {
        // Narrower than the section budget so the test does not wait out the
        // full 10s budget for a real cancellation. The cancellation itself is
        // genuine: this is Postgres raising 57014, not a stub.
        await tx.execute(sql.raw("SET LOCAL statement_timeout = '50ms'"));
        await tx.execute(sql`SELECT pg_sleep(2)`);
        return [{ unreachable: true }];
      },
    );

    expect(degraded).toBe(true);
    expect(rows).toEqual([]);
  });

  it("rethrows any error that is not a statement timeout", async () => {
    const boom = new Error("not a timeout");

    await expect(
      readBoundedWakeDiagnosticsSection(db, "wakeRequests", "issue-under-test", async () => {
        throw boom;
      }),
    ).rejects.toThrow("not a timeout");
  });

  it("rethrows a database error that is not 57014", async () => {
    // A genuine Postgres error with a different SQLSTATE must still fail the
    // request. Degrading on everything would turn a broken query into a
    // permanently empty — and permanently believable — audit answer.
    await expect(
      readBoundedWakeDiagnosticsSection(db, "wakeRequests", "issue-under-test", async (tx) => {
        await tx.execute(sql`SELECT * FROM a_table_that_does_not_exist`);
        return [];
      }),
    ).rejects.toSatisfy((error: unknown) => {
      // Drizzle WRAPS the driver error, so the SQLSTATE is not on the thrown
      // object -- it is reachable only by walking the cause chain. That is
      // precisely why the production path classifies with `findPgError` rather
      // than reading `error.code`; a direct read would misclassify every real
      // timeout as "not a timeout" and this helper would never degrade at all.
      const pgError = findPgError(error);
      return pgError !== null && pgError.code !== STATEMENT_TIMEOUT_SQLSTATE;
    });
  });
});

describe("wake diagnostics degraded reporting (PEN-6085)", () => {
  const issue = {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    identifier: "PEN-1",
    title: "row under test",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
  };

  const blockerDiagnostics = {
    issue: { ...issue },
    diagnosis: null,
    likelyReason: null,
    blockers: [],
    readiness: null,
    omittedUnauthorizedBlockerCount: null,
    truncated: false,
    caps: { maxBlockers: 100 },
  } as unknown as Parameters<typeof buildIssueWakeDiagnosticsResponse>[0]["blockerDiagnostics"];

  const build = (overrides: Record<string, unknown>) =>
    buildIssueWakeDiagnosticsResponse({
      issue: issue as unknown as Parameters<typeof buildIssueWakeDiagnosticsResponse>[0]["issue"],
      wakeRequests: [],
      activityRecords: [],
      blockerDiagnostics,
      truncatedWakeRequests: false,
      truncatedActivityRecords: false,
      includeInternalIds: false,
      ...overrides,
    });

  it("reports a healthy read as neither truncated nor degraded", () => {
    const response = build({});
    expect(response.degraded).toBe(false);
    expect(response.degradedSections).toEqual({ wakeRequests: false, activityRecords: false });
    expect(response.caps.statementTimeoutMs).toBe(ISSUE_WAKE_DIAGNOSTICS_STATEMENT_TIMEOUT_MS);
  });

  it("marks a degraded section and says the answer is incomplete", () => {
    const response = build({ degradedWakeRequests: true });

    expect(response.degraded).toBe(true);
    expect(response.degradedSections).toEqual({ wakeRequests: true, activityRecords: false });
    expect(response.diagnosis).toContain("INCOMPLETE");
    expect(response.diagnosis).toContain("wake requests");
    // The caller must be told that empty does not mean none. This sentence is
    // the only thing standing between a timed-out read and a reader concluding
    // the row never woke.
    expect(response.diagnosis).toContain("not evidence that none exist");
  });

  it("names both sections when both degrade", () => {
    const response = build({ degradedWakeRequests: true, degradedActivityRecords: true });
    expect(response.diagnosis).toContain("wake requests and activity records");
  });

  it("reports degradation in preference to truncation", () => {
    // Both flags set. Truncation says "correct, but capped"; degradation says
    // "not read at all". Reporting the reassuring one would understate the
    // failure, so degradation has to win.
    const response = build({ degradedWakeRequests: true, truncatedWakeRequests: true });

    expect(response.truncated).toBe(true);
    expect(response.degraded).toBe(true);
    expect(response.diagnosis).toContain("INCOMPLETE");
    expect(response.diagnosis).not.toContain("truncated to");
  });
});

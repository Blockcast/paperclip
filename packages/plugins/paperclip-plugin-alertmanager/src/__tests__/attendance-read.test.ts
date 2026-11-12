/**
 * PEN-2918 (D) — the read path for `alert_attendance_observations`.
 *
 * Two kinds of case here, and the split is deliberate.
 *
 * The **acceptance** cases run the real SQL against a real PostgreSQL (PGlite,
 * in-process WASM) with the schema built from this plugin's actual migration
 * files, the same approach as `aggregate-fence-restart-safety.test.ts` and for
 * the same reason: a hand-written model of the query would pass with the query
 * broken. They are the two questions the CEO made the condition of authorizing
 * this route at all — (a) how many observations exist, by disposition, over a
 * window, and (b) every pass whose wake never reached a run — so they are
 * written as those questions rather than as assertions about columns.
 *
 * The **inertness** cases run against mocks, because what they assert is an
 * absence: that this path writes nothing, notifies nobody and wakes nothing. An
 * absence is only checkable where every other client is observable, which is
 * what the mock context gives.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginApiRequestInput,
  PluginContext,
} from "@paperclipai/plugin-sdk";
import {
  ATTENDANCE_SUMMARY_ROUTE,
  ATTENDANCE_UNDELIVERED_ROUTE,
  DEFAULT_UNDELIVERED_LIMIT,
  MAX_UNDELIVERED_LIMIT,
  MAX_WINDOW_HOURS,
  SUMMARY_CAVEATS,
  handleAttendanceApiRequest,
  isAttendanceRoute,
  listUndeliveredWakes,
  resolveSince,
  summariseAttendance,
  undeliveredWakeOutcomeSqlList,
} from "../attendance-read.js";
import {
  UNDELIVERED_WAKE_OUTCOMES,
  recordAttendanceObservation,
  type AttendanceObservation,
} from "../attendance-record.js";
import manifest from "../manifest.js";

/** Hardcoded in the migration files, so the test schema must match. */
const NAMESPACE = "plugin_alertmanager_184163d1ba";
const TABLE = `${NAMESPACE}.alert_attendance_observations`;
const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const ISSUE_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ISSUE_B = "aaaaaaaa-0000-4000-8000-000000000002";
const ISSUE_OTHER = "aaaaaaaa-0000-4000-8000-000000000003";

let db: PGlite;

async function applyMigrations(pg: PGlite): Promise<void> {
  const dir = path.resolve(__dirname, "../../migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS public.companies (id uuid PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS public.issues (id uuid PRIMARY KEY);
    CREATE SCHEMA IF NOT EXISTS ${NAMESPACE};
  `);
  for (const file of files) {
    await pg.exec(await readFile(path.join(dir, file), "utf8"));
  }
}

function realCtx(pg: PGlite): { ctx: PluginContext; logger: { debug: ReturnType<typeof vi.fn> } } {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    ctx: {
      db: {
        namespace: NAMESPACE,
        query: vi.fn(async (sql: string, params: unknown[] = []) =>
          (await pg.query(sql, params)).rows),
        execute: vi.fn(async (sql: string, params: unknown[] = []) => ({
          rowCount: (await pg.query(sql, params)).affectedRows ?? 0,
        })),
      },
      logger,
    } as unknown as PluginContext,
    logger,
  };
}

const at = (iso: string): Date => new Date(iso);

/** Writes through the production writer, so a schema drift fails here too. */
async function observe(
  ctx: PluginContext,
  pg: PGlite,
  observation: AttendanceObservation,
  observedAt: string,
): Promise<void> {
  await recordAttendanceObservation(ctx, observation);
  await pg.query(
    `UPDATE ${TABLE} SET observed_at = $1
      WHERE id = (SELECT id FROM ${TABLE} ORDER BY observed_at DESC, id DESC LIMIT 1)`,
    [observedAt],
  );
}

const req = (
  routeKey: string,
  query: Record<string, string | string[]>,
  companyId = COMPANY,
): PluginApiRequestInput => ({
  routeKey,
  method: "GET",
  path: "/attendance-observations",
  params: {},
  query,
  body: null,
  actor: { actorType: "agent", actorId: "agent-1", agentId: "agent-1", userId: null, runId: "run-1" },
  companyId,
  headers: {},
});

// ---------------------------------------------------------------------------
// Acceptance — the two questions this route was authorized to answer
// ---------------------------------------------------------------------------

describe("PEN-2918 (D) — acceptance, against real Postgres", () => {
  beforeAll(async () => {
    db = new PGlite();
    await applyMigrations(db);
    await db.query(`INSERT INTO public.companies (id) VALUES ($1), ($2)`, [COMPANY, OTHER_COMPANY]);
    await db.query(`INSERT INTO public.issues (id) VALUES ($1), ($2), ($3)`, [
      ISSUE_A, ISSUE_B, ISSUE_OTHER,
    ]);
  });
  afterAll(async () => { await db?.close(); });

  beforeEach(async () => {
    await db.query(`DELETE FROM ${TABLE}`);
  });

  /**
   * Seeds the shape the estate actually produces: a parked row recorded
   * `unattended_rung` because the ladder cannot see a park, two wakes the host
   * dropped in the two different ways it drops them, and a neighbouring
   * company that must never appear.
   */
  async function seed(ctx: PluginContext): Promise<void> {
    const base = {
      companyId: COMPANY,
      alertname: "LLMProxyHighLatencyP95",
      alertLiveness: "firing",
    } as const;
    await observe(ctx, db, { ...base, alertIssueId: ISSUE_A, disposition: "attended_monitor", wakeOutcome: "not_attempted" }, "2026-11-06T01:00:00Z");
    await observe(ctx, db, { ...base, alertIssueId: ISSUE_A, disposition: "unattended_rung", wakeOutcome: "enqueued", escalationAttempt: 1 }, "2026-11-06T02:00:00Z");
    await observe(ctx, db, { ...base, alertIssueId: ISSUE_A, disposition: "unattended_rung", wakeOutcome: "refused", escalationAttempt: 2, wakeDetail: "wake refused" }, "2026-11-06T03:00:00Z");
    await observe(ctx, db, { ...base, alertIssueId: ISSUE_B, disposition: "unattended_rung", wakeOutcome: "declined", escalationAttempt: 1, wakeDetail: "wake declined" }, "2026-11-06T04:00:00Z");
    await observe(ctx, db, { ...base, alertIssueId: ISSUE_B, disposition: "unattended_cover", wakeOutcome: "not_attempted" }, "2026-11-06T05:00:00Z");
    // Before the window: must be excluded by `since`, not merely sorted late.
    await observe(ctx, db, { ...base, alertIssueId: ISSUE_B, disposition: "unattended_rung", wakeOutcome: "refused", escalationAttempt: 9 }, "2026-11-01T00:00:00Z");
    // Another tenant, same alertname, same window.
    await observe(ctx, db, { ...base, companyId: OTHER_COMPANY, alertIssueId: ISSUE_OTHER, disposition: "unattended_rung", wakeOutcome: "refused", escalationAttempt: 1 }, "2026-11-06T06:00:00Z");
  }

  it("(a) counts observations by disposition since a named instant, company-scoped", async () => {
    const { ctx } = realCtx(db);
    await seed(ctx);

    const res = await handleAttendanceApiRequest(
      ctx,
      req(ATTENDANCE_SUMMARY_ROUTE, { companyId: COMPANY, since: "2026-11-06T00:00:00Z" }),
    );
    const body = res.body as {
      totalObservations: number;
      totalIssues: number;
      byDisposition: Record<string, number>;
      byWakeOutcome: Record<string, number>;
      caveats: string[];
    };

    expect(body.byDisposition).toEqual({
      attended_monitor: 1,
      unattended_rung: 3,
      unattended_cover: 1,
    });
    expect(body.byWakeOutcome).toEqual({
      not_attempted: 2,
      enqueued: 1,
      refused: 1,
      declined: 1,
    });
    expect(body.totalObservations).toBe(5);
    // Distinct issues cannot be summed from the buckets — one issue appears in
    // several — so this is read separately and is asserted separately.
    expect(body.totalIssues).toBe(2);
    // The caveat travels with the number it qualifies.
    expect(body.caveats).toEqual([...SUMMARY_CAVEATS]);
    // PEN-6486: this used to assert only `toContain("parkedUntil")`, back when
    // the caveat said the ladder could not see a park. The ladder now can, so
    // the thing worth pinning is the pair of facts a reader of these counts
    // needs: that the park is a real attendance term, and that it is BOUNDED,
    // which is why a parked row can still read `unattended_*`.
    const caveats = body.caveats.join(" ");
    expect(caveats).toContain("live deliberate park");
    expect(caveats).toContain("BOUNDED");
    // And the window warning, which is what makes a count spanning 2026-11-11
    // readable at all: rows are never rewritten, so a window reaching back
    // past the change still holds determinations the two-term test made.
    expect(caveats).toContain("2026-11-11");
    // Negative control, and the failure mode it guards is a well-meant
    // re-widening: nothing may restate the retired claim as a live one.
    expect(caveats).not.toContain("parkedUntil appears nowhere");
    expect(caveats).not.toContain("parkedUntil is not consulted");
  });

  it("(a) excludes the other tenant even when it is the louder one", async () => {
    const { ctx } = realCtx(db);
    await seed(ctx);
    // Control: the neighbouring row exists and is inside the window.
    const all = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${TABLE} WHERE company_id = $1`, [OTHER_COMPANY]);
    expect(Number(all.rows[0]!.n)).toBe(1);

    const res = await handleAttendanceApiRequest(
      ctx,
      req(ATTENDANCE_SUMMARY_ROUTE, { companyId: COMPANY, since: "2026-11-06T00:00:00Z" }),
    );
    expect((res.body as { totalObservations: number }).totalObservations).toBe(5);
  });

  it("(b) lists every wake that never reached a run — BOTH refused and declined", async () => {
    const { ctx } = realCtx(db);
    await seed(ctx);

    const res = await handleAttendanceApiRequest(
      ctx,
      req(ATTENDANCE_UNDELIVERED_ROUTE, { companyId: COMPANY, since: "2026-11-06T00:00:00Z" }),
    );
    const body = res.body as {
      wakeOutcomes: string[];
      observations: Array<{ wakeOutcome: string; alertIssueId: string; escalationAttempt: number | null }>;
    };

    expect(body.observations.map((o) => o.wakeOutcome).sort()).toEqual(["declined", "refused"]);
    // Newest first.
    expect(body.observations[0]!.wakeOutcome).toBe("declined");
    expect(body.observations[0]!.alertIssueId).toBe(ISSUE_B);
    expect(body.observations[1]!.escalationAttempt).toBe(2);
    expect(body.wakeOutcomes).toEqual([...UNDELIVERED_WAKE_OUTCOMES]);

    // ⛔ The failure this guards is specifically the one that reads CLEAN:
    // querying only `refused` omits the commoner token and reports no dropped
    // wakes while wakes are being dropped.
    expect(body.observations.some((o) => o.wakeOutcome === "declined")).toBe(true);
  });

  it("(b) honours the window and the limit", async () => {
    const { ctx } = realCtx(db);
    await seed(ctx);

    const wide = await handleAttendanceApiRequest(
      ctx, req(ATTENDANCE_UNDELIVERED_ROUTE, { companyId: COMPANY, since: "2026-10-01T00:00:00Z" }));
    expect((wide.body as { observations: unknown[] }).observations).toHaveLength(3);

    const capped = await handleAttendanceApiRequest(
      ctx, req(ATTENDANCE_UNDELIVERED_ROUTE, { companyId: COMPANY, since: "2026-10-01T00:00:00Z", limit: "1" }));
    expect((capped.body as { observations: unknown[] }).observations).toHaveLength(1);
  });

  it("round-trips what the ladder's own writer records", async () => {
    const { ctx } = realCtx(db);
    // No hand-written INSERT: if `recordAttendanceObservation` and this read
    // ever disagree about the schema, that disagreement must fail here.
    await recordAttendanceObservation(ctx, {
      companyId: COMPANY,
      alertIssueId: ISSUE_A,
      alertname: "AlertmanagerWebhookNotificationsFailing",
      disposition: "unattended_rung",
      alertLiveness: "firing",
      wakeOutcome: "declined",
      wakeDetail: "wake declined",
      escalationAttempt: 3,
      subjectAgentId: null,
    });

    const res = await handleAttendanceApiRequest(
      ctx, req(ATTENDANCE_UNDELIVERED_ROUTE, { companyId: COMPANY, sinceHours: "1" }));
    const [row] = (res.body as { observations: Array<Record<string, unknown>> }).observations;
    expect(row).toMatchObject({
      alertname: "AlertmanagerWebhookNotificationsFailing",
      disposition: "unattended_rung",
      wakeOutcome: "declined",
      wakeDetail: "wake declined",
      escalationAttempt: 3,
      alertLiveness: "firing",
      subjectAgentId: null,
    });
  });

  it("corrects the frozen claims in 007 and 008 at the table itself", async () => {
    // `007`'s header says no route or SDK read exists; `008`'s COMMENT says
    // parkedUntil is not consulted. Applied migrations are sha256-checksummed
    // by the host, so neither file can be edited — COMMENT ON is the only
    // channel that reaches a reader of the table, and it is the only one with
    // a successor, which is why `012` could correct `008` the same way `008`
    // corrected `007`.
    const { rows } = await db.query<{ comment: string | null }>(
      `SELECT obj_description($1::regclass, 'pg_class') AS comment`, [TABLE]);
    const comment = rows[0]!.comment ?? "";
    expect(comment).toContain("SUPERSEDES the header of migration 007");
    expect(comment).toContain("per determination over an already-open alert row");
    // PEN-6486 — the live attendance test, and the bound that makes
    // `unattended_*` readable on a parked row.
    expect(comment).toContain("an armed monitor, a live blockedBy edge, or a live deliberate park");
    expect(comment).toContain("BOUNDED");
    expect(comment).toContain("the CAVEAT in migration 008");

    // ⚠️ The retired phrase is still IN this comment, inside the clause that
    // retires it — this package re-quotes a superseded claim so that a grep for
    // it lands on its correction rather than on nothing. That is exactly why
    // `toContain("parkedUntil is not consulted")` is NOT a usable assertion
    // here: it was the old test, it passes against the new comment, and it
    // passes because the text now says the OPPOSITE of what it checked for. A
    // substring test cannot see a negation. Pin the ORDER instead, which is
    // the thing that actually distinguishes the two readings.
    const supersedes = comment.indexOf("SUPERSEDES the header of migration 007");
    const retired = comment.indexOf("parkedUntil is not consulted");
    expect(retired).toBeGreaterThan(supersedes);
  });

  it("names every disposition the ladder can write, including the newest", async () => {
    // `007` left `disposition` unconstrained on purpose, so that a later ladder
    // branch could record a determination it did not anticipate. PEN-6486 is
    // the first use of that allowance, and the column comment is where a reader
    // of the table finds out the vocabulary grew.
    const { rows } = await db.query<{ comment: string | null }>(
      `SELECT col_description($1::regclass, (
         SELECT attnum FROM pg_attribute
         WHERE attrelid = $1::regclass AND attname = 'disposition'
       )) AS comment`, [TABLE]);
    const comment = rows[0]!.comment ?? "";
    for (const token of [
      "attended_monitor", "attended_blocker", "attended_park",
      "unattended_rung", "unattended_cover", "held_alert_clear",
    ]) expect(comment).toContain(token);
    // The ordering property is what stops `attended_park` absorbing either
    // older attended_* bucket, so it is recorded where the counts are read.
    expect(comment).toContain("evaluated LAST");
    // `evaluated LAST` and every token above also hold for the SUPERSEDED `012`
    // comment, so on their own they cannot tell whether `col_description()` is
    // returning `012` or `013` — i.e. whether `013` applied at all. These two
    // are absent from `012` and present only in `013`: the first pins the
    // absorption `013` exists to record, the second pins the correction to it
    // (the two arms differ by the one-time not-firing notice, so `013` must not
    // call them identical).
    expect(comment).toContain("PLUS held_alert_clear");
    expect(comment).toContain("not_read rather than not_firing");
  });
});

// ---------------------------------------------------------------------------
// PEN-6121 — the cause column
// ---------------------------------------------------------------------------

describe("PEN-6121 — an undelivered wake names which gate dropped it", () => {
  let db: PGlite;
  let ctx: PluginContext;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrations(db);
    await db.query(`INSERT INTO public.companies (id) VALUES ($1)`, [COMPANY]);
    await db.query(`INSERT INTO public.issues (id) VALUES ($1)`, [ISSUE_A]);
    ctx = realCtx(db).ctx;
  });
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await db.query(`DELETE FROM ${TABLE}`); });

  const base = {
    companyId: COMPANY,
    alertIssueId: ISSUE_A,
    alertname: "SyntheticAlert",
    disposition: "unattended_rung" as const,
    alertLiveness: "firing" as const,
  };

  it("round-trips the cause through the undelivered route", async () => {
    await observe(ctx, db, { ...base, wakeOutcome: "refused", wakeCause: "agent.not_invokable" }, "2026-11-08T01:00:00Z");

    const rows = await listUndeliveredWakes(ctx, COMPANY, new Date("2026-11-01T00:00:00Z"), 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.wakeCause).toBe("agent.not_invokable");
  });

  /**
   * ⛔ A row written before this column existed, and a host that declined
   * without naming a cause, are both NULL here. NULL means NOT RECORDED — it
   * must never be read as "delivered", which is what `wake_outcome` answers.
   */
  it("reports a null cause as null rather than inventing one", async () => {
    await observe(ctx, db, { ...base, wakeOutcome: "declined" }, "2026-11-08T01:00:00Z");

    const rows = await listUndeliveredWakes(ctx, COMPANY, new Date("2026-11-01T00:00:00Z"), 10);
    expect(rows[0]!.wakeCause).toBeNull();
    expect(rows[0]!.wakeOutcome).toBe("declined");
  });

  /**
   * The triage read: 15 of the 23 undelivered wakes in the founding
   * measurement shared ONE cause, and nothing could say so.
   */
  it("aggregates undelivered wakes by cause, bucketing unrecorded ones separately", async () => {
    await observe(ctx, db, { ...base, wakeOutcome: "refused", wakeCause: "agent.not_invokable" }, "2026-11-08T01:00:00Z");
    await observe(ctx, db, { ...base, wakeOutcome: "refused", wakeCause: "agent.not_invokable" }, "2026-11-08T02:00:00Z");
    await observe(ctx, db, { ...base, wakeOutcome: "declined", wakeCause: "heartbeat.cooldown" }, "2026-11-08T03:00:00Z");
    await observe(ctx, db, { ...base, wakeOutcome: "declined" }, "2026-11-08T04:00:00Z");
    // Delivered and not-attempted rows must not appear: they have no cause, and
    // including them would bury the signal under deferrals.
    await observe(ctx, db, { ...base, wakeOutcome: "enqueued" }, "2026-11-08T05:00:00Z");
    await observe(ctx, db, { ...base, disposition: "attended_monitor", alertLiveness: "not_read", wakeOutcome: "not_attempted" }, "2026-11-08T06:00:00Z");

    const summary = await summariseAttendance(ctx, COMPANY, new Date("2026-11-01T00:00:00Z"), 720);
    expect(summary.byWakeCause).toEqual({
      "agent.not_invokable": 2,
      "heartbeat.cooldown": 1,
      unrecorded: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Drift guard — the migration asks for this one by name
// ---------------------------------------------------------------------------

describe("PEN-2918 (D) — the undelivered predicate cannot drift from its index", () => {
  it("renders exactly the tokens the partial index is built on", async () => {
    const sql = await readFile(
      path.resolve(__dirname, "../../migrations/007_attendance_observations.sql"), "utf8");
    const predicate = /WHERE wake_outcome IN \(([^)]*)\)/.exec(sql);
    expect(predicate, "007 no longer declares the partial index predicate").not.toBeNull();

    const indexTokens = predicate![1]!.split(",").map((t) => t.trim().replace(/'/g, "")).sort();
    const codeTokens = [...UNDELIVERED_WAKE_OUTCOMES].sort();
    // The migration's own instruction: "Keep this list in step with
    // UNDELIVERED_WAKE_OUTCOMES in src/attendance-record.ts." Dropping a token
    // on either side silently stops using the index AND changes the answer.
    expect(codeTokens).toEqual(indexTokens);

    const rendered = undeliveredWakeOutcomeSqlList();
    for (const token of indexTokens) expect(rendered).toContain(`'${token}'`);
  });

  it("refuses to render a token that is not a bare identifier", () => {
    expect(() => undeliveredWakeOutcomeSqlList(["refused'; DELETE FROM x --"]))
      .toThrow(/bare identifier/);
    expect(() => undeliveredWakeOutcomeSqlList([])).toThrow(/must not be empty/);
  });
});

// ---------------------------------------------------------------------------
// Inertness and scope — what this path must NOT do
// ---------------------------------------------------------------------------

describe("PEN-2918 (D) — read-only, company-scoped, inert", () => {
  function mockCtx() {
    const mocks = {
      db: { namespace: NAMESPACE, query: vi.fn(async () => []), execute: vi.fn(async () => ({ rowCount: 0 })) },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      issues: {
        create: vi.fn(), update: vi.fn(), createComment: vi.fn(), requestWakeup: vi.fn(),
        list: vi.fn(), get: vi.fn(), listComments: vi.fn(), relations: { get: vi.fn() },
      },
      events: { emit: vi.fn() },
      metrics: { write: vi.fn(), observe: vi.fn() },
      activity: { log: vi.fn() },
      state: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    };
    return { ctx: mocks as unknown as PluginContext, mocks };
  }

  it("issues SELECTs and nothing else, and touches no other client", async () => {
    const { ctx, mocks } = mockCtx();
    await handleAttendanceApiRequest(ctx, req(ATTENDANCE_SUMMARY_ROUTE, { companyId: COMPANY }));
    await handleAttendanceApiRequest(ctx, req(ATTENDANCE_UNDELIVERED_ROUTE, { companyId: COMPANY }));

    expect(mocks.db.query).toHaveBeenCalled();
    for (const [sql] of mocks.db.query.mock.calls as unknown as Array<[string]>) {
      expect(sql.trimStart().slice(0, 6).toUpperCase()).toBe("SELECT");
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
      // Every read is bound to one company, in the SQL and not only in JS.
      expect(sql).toContain("company_id = $1");
    }
    // Nothing is written, emitted, measured, logged to activity, or woken.
    expect(mocks.db.execute).not.toHaveBeenCalled();
    expect(mocks.events.emit).not.toHaveBeenCalled();
    expect(mocks.metrics.write).not.toHaveBeenCalled();
    expect(mocks.activity.log).not.toHaveBeenCalled();
    expect(mocks.state.set).not.toHaveBeenCalled();
    expect(mocks.issues.requestWakeup).not.toHaveBeenCalled();
    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.issues.update).not.toHaveBeenCalled();
    expect(mocks.issues.createComment).not.toHaveBeenCalled();
  });

  it("refuses a companyId that is not the one the host authorized, before querying", async () => {
    const { ctx, mocks } = mockCtx();
    const res = await handleAttendanceApiRequest(
      ctx, req(ATTENDANCE_SUMMARY_ROUTE, { companyId: OTHER_COMPANY }, COMPANY));
    expect(res.status).toBe(400);
    // The refusal must precede the read: a query issued and then discarded
    // would still have crossed the tenant boundary.
    expect(mocks.db.query).not.toHaveBeenCalled();
  });

  it("refuses a missing companyId", async () => {
    const { ctx, mocks } = mockCtx();
    expect((await handleAttendanceApiRequest(ctx, req(ATTENDANCE_SUMMARY_ROUTE, {}))).status).toBe(400);
    expect(mocks.db.query).not.toHaveBeenCalled();
  });

  it("rejects an unparseable window rather than silently answering a different question", async () => {
    const { ctx, mocks } = mockCtx();
    const bad: Array<Record<string, string>> = [
      { companyId: COMPANY, since: "yesterday" },
      { companyId: COMPANY, sinceHours: "-4" },
      { companyId: COMPANY, sinceHours: "not-a-number" },
      { companyId: COMPANY, sinceHours: String(MAX_WINDOW_HOURS + 1) },
      { companyId: COMPANY, since: "2026-11-06T00:00:00Z", sinceHours: "24" },
    ];
    for (const query of bad) {
      const res = await handleAttendanceApiRequest(ctx, req(ATTENDANCE_SUMMARY_ROUTE, query));
      expect(res.status, JSON.stringify(query)).toBe(400);
    }
    expect(mocks.db.query).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range limit", async () => {
    const { ctx } = mockCtx();
    for (const limit of ["0", "-1", "1.5", String(MAX_UNDELIVERED_LIMIT + 1), "all"]) {
      const res = await handleAttendanceApiRequest(
        ctx, req(ATTENDANCE_UNDELIVERED_ROUTE, { companyId: COMPANY, limit }));
      expect(res.status, limit).toBe(400);
    }
  });

  it("defaults the window and the limit rather than requiring them", () => {
    const now = at("2026-11-07T06:00:00Z");
    const { since, windowHours } = resolveSince({}, now);
    expect(windowHours).toBe(24 * 7);
    expect(since.toISOString()).toBe("2026-10-31T06:00:00.000Z");
    expect(DEFAULT_UNDELIVERED_LIMIT).toBe(100);
  });

  it("never echoes a database error back to the caller", async () => {
    const { ctx, mocks } = mockCtx();
    mocks.db.query.mockRejectedValueOnce(new Error("connection to 10.42.3.7:5432 failed: secret"));
    await expect(handleAttendanceApiRequest(ctx, req(ATTENDANCE_SUMMARY_ROUTE, { companyId: COMPANY })))
      .rejects.toThrow("Alertmanager attendance observation read failed");
  });
});

// ---------------------------------------------------------------------------
// Declared surface
// ---------------------------------------------------------------------------

describe("PEN-2918 (D) — the declared route surface stays read-only", () => {
  it("declares both routes GET, board-or-agent, company-scoped from the query", () => {
    const routes = manifest.apiRoutes ?? [];
    for (const key of [ATTENDANCE_SUMMARY_ROUTE, ATTENDANCE_UNDELIVERED_ROUTE]) {
      const route = routes.find((r) => r.routeKey === key);
      expect(route, `${key} is not declared`).toBeDefined();
      // GET is the authorization, not a style choice: (D) was authorized
      // read-only, and a mutating sibling here would need its own argument.
      expect(route!.method).toBe("GET");
      expect(route!.auth).toBe("board-or-agent");
      expect(route!.companyResolution).toEqual({ from: "query", key: "companyId" });
    }
  });

  it("does not widen the mutation route", () => {
    const recover = (manifest.apiRoutes ?? []).find((r) => r.routeKey === "recover-aggregate-firing");
    expect(recover?.auth).toBe("board");
  });

  it("routes only its own keys", () => {
    expect(isAttendanceRoute(ATTENDANCE_SUMMARY_ROUTE)).toBe(true);
    expect(isAttendanceRoute(ATTENDANCE_UNDELIVERED_ROUTE)).toBe(true);
    expect(isAttendanceRoute("recover-aggregate-firing")).toBe(false);
    expect(isAttendanceRoute("list-aggregate-firing-fences")).toBe(false);
  });
});

/**
 * BLO-42850 — an aggregate row's description must describe the AGGREGATE.
 *
 * A row created by this bridge aggregates N Alertmanager fingerprints and is
 * cancelled only when its last member resolves. Its description rendered
 * exactly one of them — whichever fired last — so three things were false at
 * once: the body named a different alert than the row's `originId`,
 * `**Started**` moved in whichever direction the last writer pointed (measured
 * moving BACKWARDS 10:58:37Z → 08:04:37Z on BLO-41538), and every member other
 * than the one in the body was invisible.
 *
 * The expensive consequence is the third case below. The resolve path never
 * refreshed the body, so a row could keep naming a CLEARED alert while its
 * siblings fired. The documented triage protocol is to falsify the alert named
 * in the body against Alertmanager; on such a row that returns `resolved` while
 * live members fire, so CORRECT protocol produced a WRONG close. BLO-41538 had
 * to be reopened for exactly this.
 *
 * These cases run the **real SQL against a real PostgreSQL** (PGlite, in-process
 * WASM), with the schema built from this plugin's **actual migration files** —
 * same harness as `aggregate-fence-restart-safety.test.ts`, and for the same
 * reason: the member snapshot is a column, its immutability is an `ON CONFLICT`
 * clause, and a JS model of either would assert the model rather than the
 * behaviour.
 *
 * MUTATION MATRIX. Each guard reverted ALONE must turn this suite red. Measured
 * 2026-10-11, one mutation per run because two at once can mask each other:
 *
 *   1. `describeAggregate` neutered at the two FIRING sites (i.e. route (b), or
 *      no fix at all)                          → 5 of 6 fail.
 *   2. `first_seen_starts_at = EXCLUDED.first_seen_starts_at` in
 *      `upsertAggregateMember`'s `DO UPDATE SET` — the COALESCE dropped, so the
 *      anchor is rewritten on every re-fire     → case 5 fails.
 *   3. the `has-unresolved-siblings` refresh block deleted from
 *      `handleResolved`                        → cases 3 and 4 fail.
 *   4. `first_seen_starts_at` omitted from `DO UPDATE SET` altogether (the
 *      write-once-by-omission spelling)        → case 6 fails.
 *   5. `startedAtAnchor` ignored in `buildIssueDescription`
 *                                              → cases 4, 5 and 6 fail.
 *
 * ⚠ Mutation 2 SURVIVED this suite until case 5 grew a THIRD delivery. The body
 * is rendered before `upsertAggregateMember` writes, so a corrupted anchor is
 * invisible on the delivery that corrupts it and only surfaces on the next one
 * — two deliveries pass against an anchor that is rewritten every time. A
 * fixture written for a defect can pass without the fix; re-introduce each
 * guard's defect and confirm the suite notices.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { handleWebhook } from "../webhook-handler.js";
import { DEFAULT_ISSUE_ROUTE_MAP } from "../constants.js";
import type {
  AlertmanagerAlert,
  AlertmanagerPluginConfig,
  AlertmanagerWebhookPayload,
} from "../types.js";

/** Hardcoded in the migration files, so the test schema must match. */
const NAMESPACE = "plugin_alertmanager_184163d1ba";
const MEMBERS = `${NAMESPACE}.alertmanager_aggregate_members`;
// Real UUIDs, not readable placeholders: the escalation-cover tables carry
// `uuid` FKs into `public.issues`/`public.companies`, and the resolve path
// cascades through them — a `company-1` style id fails the cast and surfaces as
// a delivery error rather than as a schema complaint.
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ALERTNAME = "MasterGateRed";

/** Two members of one aggregate: same alertname, different subject. */
const FP_A = "fp-aggregate-member-a";
const FP_B = "fp-aggregate-member-b";
const STARTS_A = "2026-10-10T10:58:37Z";
/** Later than A — the ordinary case. */
const STARTS_B_LATER = "2026-10-10T11:30:00Z";
/** EARLIER than A — the shape that dragged `**Started**` backwards. */
const STARTS_B_EARLIER = "2026-10-10T08:04:37Z";
/** Earlier again, for the third delivery that exposes a lagging anchor. */
const STARTS_C_EARLIER = "2026-10-10T07:15:00Z";

let db: PGlite;

async function applyMigrations(pg: PGlite): Promise<void> {
  const dir = path.resolve(__dirname, "../../migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  // The snapshot columns are what make rendering the members possible at all;
  // without this migration every case below is vacuous.
  expect(files).toContain("006_aggregate_member_subject.sql");
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS public.companies (id uuid PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS public.issues (id uuid PRIMARY KEY);
    CREATE SCHEMA IF NOT EXISTS ${NAMESPACE};
  `);
  for (const file of files) {
    await pg.exec(await readFile(path.join(dir, file), "utf8"));
  }
}

function realDb(pg: PGlite) {
  return {
    namespace: NAMESPACE,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const result = await pg.query(sql, params as unknown[]);
      return result.rows;
    }),
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      const result = await pg.query(sql, params as unknown[]);
      return { rowCount: result.affectedRows ?? 0 };
    }),
  };
}

const baseConfig = (): AlertmanagerPluginConfig => ({
  webhookToken: "token",
  defaultCompanyId: COMPANY_ID,
  autoCloseOnResolve: true,
  issueRouteMap: DEFAULT_ISSUE_ROUTE_MAP,
  fallbackAgentName: "Alert Fallback",
});

function alertFor(
  fingerprint: string,
  workflow: string,
  startsAt: string,
  status: "firing" | "resolved" = "firing",
): AlertmanagerAlert {
  return {
    status,
    fingerprint,
    labels: { alertname: ALERTNAME, severity: "critical", workflow },
    annotations: { summary: `master is red on ${workflow}` },
    startsAt,
    endsAt: status === "resolved" ? "2026-10-10T12:00:00Z" : "0001-01-01T00:00:00Z",
    generatorURL: "http://prometheus/graph",
  };
}

function payloadFor(alert: AlertmanagerAlert): AlertmanagerWebhookPayload {
  return {
    version: "4",
    status: alert.status === "resolved" ? "resolved" : "firing",
    receiver: "paperclip",
    groupLabels: { alertname: ALERTNAME },
    commonLabels: { alertname: ALERTNAME, severity: "critical" },
    commonAnnotations: {},
    externalURL: "http://alertmanager.monitoring.svc:9093",
    alerts: [alert],
  };
}

/**
 * An issue store with just enough behaviour for the aggregate paths: `list`
 * must find the aggregate's active row by `originFingerprint` (that is how a
 * second fingerprint joins rather than creating a second issue), and the body
 * every write leaves behind is what these cases assert on.
 */
function mkIssues() {
  const rows = new Map<
    string,
    {
      id: string;
      originKind?: string;
      originId?: string;
      originFingerprint?: string;
      status: string;
      description: string;
      assigneeAgentId: string | null;
      assigneeUserId: string | null;
    }
  >();
  let next = 0;
  const issueId = () => `2${(++next).toString().padStart(7, "0")}-2222-4222-8222-222222222222`;
  return {
    rows,
    api: {
      list: vi.fn(
        async (filter: {
          originFingerprint?: string;
          originKind?: string;
          status?: string;
        }) =>
          [...rows.values()].filter(
            (row) =>
              (!filter.originKind || row.originKind === filter.originKind) &&
              (!filter.originFingerprint ||
                row.originFingerprint === filter.originFingerprint) &&
              (!filter.status || row.status === filter.status),
          ),
      ),
      get: vi.fn(async (id: string) => rows.get(id) ?? null),
      create: vi.fn(async (input: Record<string, unknown>) => {
        const id = issueId();
        const row = {
          id,
          originKind: input.originKind as string | undefined,
          originId: input.originId as string | undefined,
          originFingerprint: input.originFingerprint as string | undefined,
          status: (input.status as string) ?? "todo",
          description: (input.description as string) ?? "",
          assigneeAgentId: (input.assigneeAgentId as string) ?? null,
          assigneeUserId: (input.assigneeUserId as string) ?? null,
        };
        rows.set(id, row);
        return row;
      }),
      update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        const row = rows.get(id);
        if (!row) return null;
        Object.assign(row, patch);
        return row;
      }),
      listComments: vi.fn(async () => []),
      createComment: vi.fn(async () => ({ id: "comment-1" })),
    },
  };
}

function mkCtx() {
  const issues = mkIssues();
  const state = new Map<string, unknown>();
  const key = (ref: unknown) => JSON.stringify(ref);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const mocks = {
    state: {
      get: vi.fn(async (ref: unknown) => state.get(key(ref)) ?? null),
      set: vi.fn(async (ref: unknown, value: unknown) => {
        state.set(key(ref), value);
      }),
      delete: vi.fn(async (ref: unknown) => {
        state.delete(key(ref));
      }),
    },
    users: { get: vi.fn(async () => null), findByEmail: vi.fn(async () => null) },
    agents: {
      list: vi.fn(async () => [
        { id: "agent-fallback", name: "Alert Fallback", status: "idle" },
      ]),
    },
    issues: issues.api,
    db: realDb(db),
    events: { emit: vi.fn(async (..._args: unknown[]) => {}) },
    metrics: { write: vi.fn(async (..._args: unknown[]) => {}) },
    activity: { log: vi.fn(async () => {}) },
    actions: { register: vi.fn() },
    secrets: {
      resolve: vi.fn(async () => "token"),
      verify: vi.fn(async () => true),
    },
    config: { get: vi.fn(async () => baseConfig()) },
    logger,
  };
  return { ctx: mocks as unknown as PluginContext, issues, logger };
}

const deliver = (ctx: PluginContext, alert: AlertmanagerAlert) =>
  handleWebhook(ctx, baseConfig(), true, {
    companyId: COMPANY_ID,
    endpointKey: "alertmanager",
    headers: { authorization: "Bearer token" },
    rawBody: JSON.stringify(payloadFor(alert)),
    parsedBody: payloadFor(alert),
    requestId: `req-${alert.fingerprint}-${alert.status}-${alert.startsAt}`,
  } as never);

/** The single aggregate row every case here produces. */
function onlyIssue(issues: ReturnType<typeof mkIssues>) {
  const rows = [...issues.rows.values()];
  // Guards the premise of every assertion below: a second fingerprint that
  // created its OWN issue would make "the description omits member B" true for
  // an uninteresting reason.
  expect(rows).toHaveLength(1);
  return rows[0];
}

let truncateAll: string;

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
  const tables = await db.query<{ qualified: string }>(
    `SELECT format('%I.%I', schemaname, tablename) AS qualified
       FROM pg_tables WHERE schemaname = ANY($1)`,
    [[NAMESPACE, "public"]],
  );
  expect(tables.rows.length).toBeGreaterThan(0);
  truncateAll = `TRUNCATE ${tables.rows
    .map((r) => r.qualified)
    .join(", ")} RESTART IDENTITY CASCADE`;
}, 30_000);

beforeEach(async () => {
  await db.query(truncateAll);
});

afterAll(async () => {
  await db.close();
});


describe("BLO-42850 — an aggregate row's body describes every active member", () => {
  it("names both members once a second fingerprint joins, and keeps originId as the representative", async () => {
    const { ctx, issues } = mkCtx();

    await deliver(ctx, alertFor(FP_A, "build", STARTS_A));
    const row = onlyIssue(issues);
    // The creating alert, written once and never revised — the body has to keep
    // agreeing with it.
    expect(row.originId).toBe(FP_A);
    // One member renders exactly as it did before BLO-42850, so this change
    // churns nothing on the overwhelmingly common single-subject row.
    expect(row.description).not.toContain("### Active members");

    await deliver(ctx, alertFor(FP_B, "deploy", STARTS_B_LATER));
    expect(onlyIssue(issues).id).toBe(row.id);

    const body = row.description;
    expect(body).toContain("### Active members (2)");
    // AC1: every active member is identified, by fingerprint and by the label
    // that actually tells them apart.
    expect(body).toContain(FP_A);
    expect(body).toContain(FP_B);
    expect(body).toContain("workflow=build");
    expect(body).toContain("workflow=deploy");
    // The representative block still describes the fingerprint in `originId`,
    // so "falsify the alert named in the body" and "falsify originId" cannot
    // disagree.
    expect(body).toContain("**Summary**: master is red on build");
    expect(body).not.toContain("**Summary**: master is red on deploy");
  });

  it("does not move **Started** backwards when a later member carries an earlier startsAt", async () => {
    const { ctx, issues } = mkCtx();

    await deliver(ctx, alertFor(FP_A, "build", STARTS_A));
    const row = onlyIssue(issues);
    expect(row.description).toContain(`**Started**: ${STARTS_A}`);

    // The measured BLO-41538 shape: the second member's episode began earlier.
    // Before the fix the last writer simply replaced the body, so this dragged
    // **Started** from 10:58:37Z to 08:04:37Z.
    await deliver(ctx, alertFor(FP_B, "deploy", STARTS_B_EARLIER));

    expect(row.description).toContain(`**Started**: ${STARTS_A}`);
    expect(row.description).not.toContain(`**Started**: ${STARTS_B_EARLIER}`);
    // The earlier time is not hidden — it is on B's own row, where moving
    // backwards says something true rather than something misleading.
    expect(row.description).toContain(STARTS_B_EARLIER);
  });

  it("stops naming the creating member once it resolves while a sibling still fires", async () => {
    const { ctx, issues } = mkCtx();

    await deliver(ctx, alertFor(FP_A, "build", STARTS_A));
    await deliver(ctx, alertFor(FP_B, "deploy", STARTS_B_LATER));
    const row = onlyIssue(issues);
    expect(row.description).toContain("**Summary**: master is red on build");

    await deliver(ctx, alertFor(FP_A, "build", STARTS_A, "resolved"));

    // The aggregate is NOT closed — B is still firing — which is the only
    // reason the stale body was ever reachable.
    const unresolved = await db.query<{ fingerprint: string }>(
      `SELECT fingerprint FROM ${MEMBERS}
        WHERE company_id = $1 AND resolved_at IS NULL`,
      [COMPANY_ID],
    );
    expect(unresolved.rows.map((r) => r.fingerprint)).toEqual([FP_B]);
    expect(row.status).not.toBe("cancelled");

    // AC3: triage must not be pointed at the cleared alert. This is the exact
    // read that produced the wrong close on BLO-41538.
    const body = row.description;
    expect(body).not.toContain(FP_A);
    expect(body).not.toContain("master is red on build");
    expect(body).not.toContain("workflow=build");
    expect(body).toContain("**Summary**: master is red on deploy");
  });

  it("keeps **Started** anchored when the founding member resolves and an earlier-started sibling takes over the body", async () => {
    const { ctx, issues } = mkCtx();

    // Deliberately the hard ordering: the survivor's own episode began BEFORE
    // the row did. The previous case cannot catch an unanchored **Started** —
    // its survivor started later, so the move would be forwards, which AC2
    // permits. Here an unanchored field moves backwards, which it does not.
    await deliver(ctx, alertFor(FP_A, "build", STARTS_A));
    await deliver(ctx, alertFor(FP_B, "deploy", STARTS_B_EARLIER));
    const row = onlyIssue(issues);

    await deliver(ctx, alertFor(FP_A, "build", STARTS_A, "resolved"));

    // The representative really did swap — otherwise the anchor is holding for
    // an uninteresting reason.
    expect(row.description).toContain("**Summary**: master is red on deploy");
    // AC2 across a resolve: the anchor is the oldest-JOINED member's row, read
    // whether or not that member is still active.
    expect(row.description).toContain(`**Started**: ${STARTS_A}`);
    expect(row.description).not.toContain(`**Started**: ${STARTS_B_EARLIER}`);
    // The survivor's own episode start stays visible, in the field that is
    // allowed to move in either direction.
    expect(row.description).toContain(`**Latest firing**: ${STARTS_B_EARLIER}`);
  });

  it("keeps **Started** anchored when the founding member itself re-fires with an earlier startsAt", async () => {
    const { ctx, issues } = mkCtx();

    await deliver(ctx, alertFor(FP_A, "build", STARTS_A));
    const row = onlyIssue(issues);

    // Same fingerprint, earlier episode — an Alertmanager re-delivery, or a
    // rule whose `for:` clock restarted. This is the case that requires
    // `first_seen_starts_at` to survive the upsert's `DO UPDATE SET`: the
    // anchor row is this member's OWN row, so nothing else protects it.
    await deliver(ctx, alertFor(FP_A, "build", STARTS_B_EARLIER));

    expect(row.description).toContain(`**Started**: ${STARTS_A}`);
    expect(row.description).toContain(`**Latest firing**: ${STARTS_B_EARLIER}`);

    // A THIRD delivery, and it is the one that does the work. The body is
    // rendered BEFORE `upsertAggregateMember` writes (the read sits ahead of
    // the firing fence's barrier, deliberately), so a corrupted anchor is
    // invisible on the delivery that corrupts it and only shows up on the
    // next one. Two deliveries therefore pass against an anchor rewritten on
    // every re-fire — measured: that mutation survived this case until this
    // third delivery was added.
    await deliver(ctx, alertFor(FP_A, "build", STARTS_C_EARLIER));

    expect(row.description).toContain(`**Started**: ${STARTS_A}`);
    expect(row.description).not.toContain(`**Started**: ${STARTS_B_EARLIER}`);
    expect(row.description).toContain(`**Latest firing**: ${STARTS_C_EARLIER}`);
  });

  it("backfills the anchor on a member row that predates migration 006, then holds it", async () => {
    const { ctx, issues } = mkCtx();

    await deliver(ctx, alertFor(FP_A, "build", STARTS_A));
    const row = onlyIssue(issues);

    // Every member row that existed before migration 006 looks exactly like
    // this: present, attached, and carrying neither column. `ADD COLUMN` does
    // not invent values and there is no backfill job.
    await db.query(
      `UPDATE ${MEMBERS} SET first_seen_starts_at = NULL, alert_snapshot = NULL
        WHERE company_id = $1`,
      [COMPANY_ID],
    );

    // Its next firing delivery — Alertmanager re-sends every member each
    // `repeat_interval`, so this happens on its own within one interval.
    await deliver(ctx, alertFor(FP_A, "build", STARTS_B_LATER));
    const anchored = await db.query<{ first_seen_starts_at: string | null }>(
      `SELECT first_seen_starts_at FROM ${MEMBERS} WHERE company_id = $1`,
      [COMPANY_ID],
    );
    // The original episode is not recoverable, so the anchor is this delivery's
    // own `startsAt`. The point is that it is now SET, not that it is historic.
    expect(anchored.rows[0]?.first_seen_starts_at).toBe(STARTS_B_LATER);
    expect(row.description).toContain(`**Started**: ${STARTS_B_LATER}`);

    // And from here it behaves like any other anchored row. Without the
    // backfill this member stays NULL forever, the anchor falls back to the
    // current firing on every delivery, and **Started** moves backwards here —
    // i.e. a pre-006 aggregate keeps the exact defect this change removes.
    await deliver(ctx, alertFor(FP_A, "build", STARTS_B_EARLIER));
    expect(row.description).toContain(`**Started**: ${STARTS_B_LATER}`);
    expect(row.description).toContain(`**Latest firing**: ${STARTS_B_EARLIER}`);
  });
});

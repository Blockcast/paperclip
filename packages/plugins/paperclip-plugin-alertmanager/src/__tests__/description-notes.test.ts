/**
 * PEN-6218 — an agent's notes must survive the body re-render.
 *
 * Every firing path in this plugin publishes a WHOLESALE `description` PATCH
 * carrying a freshly rendered body. Measured first-party on PEN-4835: 69 such
 * rewrites on one row at a ~65-minute cadence, and an agent's append-only
 * write survived **11 minutes 15 seconds**. The write returns 200 and a
 * same-run read-back verifies byte-exact, so from the writing side the loss is
 * invisible — it lands later, in another actor's transaction, with no comment
 * and no event an agent would think to look for.
 *
 * The rendered half staying authoritative is deliberate and is NOT what these
 * cases change: a stale projection is the wrong-close mechanism BLO-41538 was
 * reopened for. What changes is that the row now carries a split point, and
 * everything below it is carried forward.
 *
 * The delivery cases run the **real SQL against a real PostgreSQL** (PGlite,
 * in-process WASM) with the schema built from this plugin's actual migration
 * files — same harness as `aggregate-description.test.ts`, and for the same
 * reason: the member read that renders the body is SQL, and a JS model of it
 * would assert the model.
 *
 * MUTATION MATRIX. Each guard reverted ALONE must turn this suite red.
 * Measured 2026-11-09, one mutation per run because two at once can mask each
 * other. The counts are what the runs actually printed, not what was predicted:
 *
 *   1. `composeDescription` dropped at the re-fire `refresh` site (i.e. the
 *      pre-PEN-6218 code)                                        → 3 of 9 fail.
 *   2. `composeDescription` dropped at the CREATE site            → 2 of 9 fail.
 *   3. `preservedNotes` returning `""` instead of `"\n"` for an
 *      empty tail                                                → 1 of 9 fails.
 *   4. the no-marker prefix branch of `preservedNotes` deleted    → 2 of 9 fail.
 *   5. `indexOf` → `lastIndexOf` in `preservedNotes`              → 1 of 9 fails.
 *
 * ⚠ Mutation 3 was predicted to fail "re-rendering is a fixed point" and does
 * NOT: `""` is a fixed point too. It fails the markerless case instead, which
 * is the only assertion that pins the value. The newline is a formatting
 * choice, and the comment on `preservedNotes` was corrected to say so — a
 * matrix written from prediction rather than from the run would have left a
 * false justification standing in the source.
 *
 * ⚠ The delivery cases go through `heartbeat`, not a bare second `deliver`: a
 * `repeat_interval` re-send is byte-identical, so the BLO-33168 replay window
 * skips it inside a test's run time and the re-render under test never
 * happens. That is how two cases in `aggregate-description.test.ts` passed
 * vacuously on their first draft.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { __firingReplayCacheForTests, handleWebhook } from "../webhook-handler.js";
import { DEFAULT_ISSUE_ROUTE_MAP } from "../constants.js";
import {
  AGENT_NOTES_MARKER,
  composeDescription,
  preservedNotes,
} from "../description-notes.js";
import { buildIssueDescription } from "../issue-mapping.js";
import type {
  AlertmanagerAlert,
  AlertmanagerPluginConfig,
  AlertmanagerWebhookPayload,
} from "../types.js";

/** Hardcoded in the migration files, so the test schema must match. */
const NAMESPACE = "plugin_alertmanager_184163d1ba";
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ALERTNAME = "MasterGateRed";
const FP_A = "fp-notes-member-a";
const STARTS_A = "2026-10-10T10:58:37Z";

/** What an agent writes into the field, and must still find there afterwards. */
const AGENT_NOTE = [
  "## Devops triage 2026-11-09",
  "",
  "Ungated on the superseding clear test; see PEN-3505.",
].join("\n");

let db: PGlite;

async function applyMigrations(pg: PGlite): Promise<void> {
  const dir = path.resolve(__dirname, "../../migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
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

function alertFor(fingerprint: string, startsAt: string): AlertmanagerAlert {
  return {
    status: "firing",
    fingerprint,
    labels: { alertname: ALERTNAME, severity: "critical", workflow: "build" },
    annotations: { summary: "master is red on build" },
    startsAt,
    endsAt: "0001-01-01T00:00:00Z",
    generatorURL: "http://prometheus/graph",
  };
}

function payloadFor(alert: AlertmanagerAlert): AlertmanagerWebhookPayload {
  return {
    version: "4",
    status: "firing",
    receiver: "paperclip",
    groupLabels: { alertname: ALERTNAME },
    commonLabels: { alertname: ALERTNAME, severity: "critical" },
    commonAnnotations: {},
    externalURL: "http://alertmanager.monitoring.svc:9093",
    alerts: [alert],
  };
}

/** Same shape as `aggregate-description.test.ts`; the body each write leaves is the subject. */
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
          originId?: string;
          status?: string;
        }) =>
          [...rows.values()].filter(
            (row) =>
              (!filter.originKind || row.originKind === filter.originKind) &&
              (!filter.originId || row.originId === filter.originId) &&
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
    metrics: {
      write: vi.fn(async (..._args: unknown[]) => {}),
      observe: vi.fn(async (..._args: unknown[]) => {}),
    },
    activity: { log: vi.fn(async () => {}) },
    actions: { register: vi.fn() },
    secrets: { resolve: vi.fn(async () => "token"), verify: vi.fn(async () => true) },
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
    requestId: `req-${alert.fingerprint}-${alert.startsAt}`,
  } as never);

/** A `repeat_interval` re-send, with the replay window aged out. */
async function heartbeat(
  ctx: PluginContext,
  issues: ReturnType<typeof mkIssues>,
  alert: AlertmanagerAlert,
) {
  __firingReplayCacheForTests(ctx).clear();
  const before = issues.api.update.mock.calls.length;
  await deliver(ctx, alert);
  expect(issues.api.update.mock.calls.length).toBeGreaterThan(before);
}

function onlyIssue(issues: ReturnType<typeof mkIssues>) {
  const rows = [...issues.rows.values()];
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

describe("PEN-6218 — composing a body around the notes marker", () => {
  it("keeps everything below the marker and re-renders everything above it", () => {
    const first = composeDescription("**Summary**: old", null);
    const withNote = `${first}\n${AGENT_NOTE}`;

    const next = composeDescription("**Summary**: new", withNote);

    expect(next).toContain("**Summary**: new");
    expect(next).not.toContain("**Summary**: old");
    expect(next.endsWith(`\n${AGENT_NOTE}`)).toBe(true);
  });

  it("is a fixed point, so an unchanged alert does not grow the body", () => {
    const once = composeDescription("**Summary**: same", null);
    expect(composeDescription("**Summary**: same", once)).toBe(once);

    const withNote = `${once}\n${AGENT_NOTE}`;
    expect(composeDescription("**Summary**: same", withNote)).toBe(withNote);
  });

  it("keeps notes that quote the marker, rather than splitting on their copy", () => {
    const quoting = [
      "Keep this line.",
      "The split point is `<!-- paperclip-plugin-alertmanager:notes-below -->`.",
    ].join("\n");
    const body = `${composeDescription("**Summary**: s", null)}\n${quoting}`;

    const next = composeDescription("**Summary**: s", body);

    expect(next).toContain("Keep this line.");
  });

  it("rescues an append made on a body written before the marker existed", () => {
    const legacy = `**Summary**: s\n\n${AGENT_NOTE}`;
    expect(preservedNotes("**Summary**: s", legacy)).toBe(`\n\n${AGENT_NOTE}`);
  });

  it("preserves nothing when a markerless body does not start with this render", () => {
    // Fails CLOSED: an old render we cannot reproduce is indistinguishable
    // from notes, so this is exactly the pre-PEN-6218 behaviour and can lose
    // nothing that was not already lost.
    expect(preservedNotes("**Summary**: new", "**Summary**: old\n\nnotes")).toBe("\n");
  });
});

describe("PEN-6218 — an agent's notes survive the delivery paths", () => {
  it("files a new row carrying the marker, so the first writer is warned", async () => {
    const { ctx, issues } = mkCtx();

    await deliver(ctx, alertFor(FP_A, STARTS_A));

    const body = onlyIssue(issues).description;
    expect(body).toContain(AGENT_NOTES_MARKER);
    // The warning is rendered ABOVE the marker, i.e. in the half this plugin
    // rewrites — so changing its wording reaches every live row on its next
    // sync rather than only rows filed afterwards.
    expect(body.indexOf("is re-rendered by")).toBeLessThan(body.indexOf(AGENT_NOTES_MARKER));
  });

  it("keeps an agent's notes across a re-fire, and still refreshes the rendered half", async () => {
    const { ctx, issues } = mkCtx();
    await deliver(ctx, alertFor(FP_A, STARTS_A));
    const row = onlyIssue(issues);

    // What an agent's PATCH leaves behind: the body it read, plus its own text
    // below the marker.
    row.description = `${row.description}\n${AGENT_NOTE}`;

    await heartbeat(ctx, issues, alertFor(FP_A, STARTS_A));

    const body = onlyIssue(issues).description;
    expect(body).toContain(AGENT_NOTE);
    expect(body).toContain("**Summary**: master is red on build");
    // Exactly one marker: the re-render composed a new head onto the old
    // notes, it did not staple a second rendered body onto the row.
    expect(body.split(AGENT_NOTES_MARKER)).toHaveLength(2);
  });

  it("re-renders an unchanged alert to the same bytes", async () => {
    const { ctx, issues } = mkCtx();
    await deliver(ctx, alertFor(FP_A, STARTS_A));
    const before = onlyIssue(issues).description;

    await heartbeat(ctx, issues, alertFor(FP_A, STARTS_A));

    expect(onlyIssue(issues).description).toBe(before);
  });

  it("rescues an append on a row written before this shipped", async () => {
    const { ctx, issues } = mkCtx();
    await deliver(ctx, alertFor(FP_A, STARTS_A));
    const row = onlyIssue(issues);

    // A pre-PEN-6218 row is exactly what the old code stored: the rendered
    // body, no banner and no marker. Asserted against the live body rather
    // than assumed, because the whole rescue turns on the two being equal.
    const legacyBody = buildIssueDescription(alertFor(FP_A, STARTS_A));
    expect(row.description.startsWith(legacyBody)).toBe(true);
    row.description = `${legacyBody}\n\n${AGENT_NOTE}`;

    await heartbeat(ctx, issues, alertFor(FP_A, STARTS_A));

    expect(onlyIssue(issues).description).toContain(AGENT_NOTE);
  });
});

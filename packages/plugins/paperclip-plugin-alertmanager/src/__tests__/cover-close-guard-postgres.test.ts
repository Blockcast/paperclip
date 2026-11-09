/**
 * PEN-6236 — the close guard against a REAL PostgreSQL.
 *
 * `cover-pending-guard.test.ts` drives the same decisions through an in-memory
 * model of these two tables. That model is useful and it is not sufficient:
 * this plugin has already been bitten once by exactly that gap — see the
 * header of `aggregate-fence-restart-safety.test.ts`, where 9 of 10 cases
 * passed against a JS model with the fix removed, because they were asserting
 * the model rather than the behaviour.
 *
 * What is only testable here:
 *  - the eligibility and recheck-window predicates as SQL, including
 *    `make_interval(mins => …)` and the interaction of the `$2` hold with the
 *    `$3` hold+limit window;
 *  - that the claim UPDATE really does write the verdict columns migration 010
 *    adds, i.e. that the code and the migration that ships with it agree;
 *  - the backfill regex, which is a Postgres `substring(… from …)` and has no
 *    JS equivalent to model.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { recordSourceResolvedAndCloseCovers, type CoverCloseGuard } from "../escalation.js";
import type { SourceAlertState } from "../prometheus-source-state.js";

const NAMESPACE = "plugin_alertmanager_184163d1ba";
const COVERS = `${NAMESPACE}.alert_escalation_covers`;
const MEMBERS = `${NAMESPACE}.alert_escalation_cover_members`;
const COMPANY = "11111111-1111-4111-8111-111111111111";
const COVER = "22222222-2222-4222-8222-222222222222";
const ALERT = "33333333-3333-4333-8333-333333333333";
const ALERTNAME = "PaperclipApprovalStarved";
const HOLD_MINUTES = 15;

let db: PGlite;

async function applyMigrations(pg: PGlite): Promise<void> {
  const dir = path.resolve(__dirname, "../../migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  // Fail loudly if this migration is renamed or dropped: every assertion below
  // is about columns it adds, and without it they would fail far from the cause.
  expect(files).toContain("011_cover_close_verdict.sql");
  // Two PRs stacked on one base each pick the next free number and each is
  // green on its own tree, so the collision only exists after both land. The
  // runner tolerates it -- it keys on the full filename and sorts by it -- so
  // nothing else in the repo will ever say anything: the numbering guards in
  // packages/db cover packages/db/src/migrations only. This is the one place
  // that reads this directory whole, so the check belongs here.
  const byNumber = new Map<string, string[]>();
  for (const file of files) {
    const number = /^(\d+)_/.exec(file)?.[1];
    expect(number, `${file} does not start with a migration number`).toBeDefined();
    byNumber.set(number!, [...(byNumber.get(number!) ?? []), file]);
  }
  expect([...byNumber.values()].filter((group) => group.length > 1)).toEqual([]);
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS public.companies (id uuid PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS public.issues (id uuid PRIMARY KEY);
    CREATE SCHEMA IF NOT EXISTS ${NAMESPACE};
  `);
  for (const file of files) await pg.exec(await readFile(path.join(dir, file), "utf8"));
}

function realCtx(pg: PGlite) {
  const mocks = {
    db: {
      namespace: NAMESPACE,
      query: vi.fn(async (sql: string, params: unknown[] = []) => (await pg.query(sql, params)).rows),
      execute: vi.fn(async (sql: string, params: unknown[] = []) => {
        const r = await pg.query(sql, params);
        return { rowCount: r.affectedRows ?? 0 };
      }),
    },
    issues: {
      get: vi.fn(async (id: string) => ({ id, identifier: "PEN-6224", status: "todo" })),
      update: vi.fn(async () => ({})),
      createComment: vi.fn(async () => ({})),
      listComments: vi.fn(async () => []),
      list: vi.fn(async () => []),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  return { ctx: mocks as unknown as PluginContext, mocks };
}

const guardOf = (answer: SourceAlertState, recheckLimitMinutes = 240): CoverCloseGuard => ({
  readSourceState: async () => answer,
  recheckLimitMinutes,
  configured: true,
});
const LIVE: SourceAlertState = { state: "live", readAt: "2026-11-09T06:00:00.000Z", detail: "1 series, alertstate=pending" };
const CLEARED: SourceAlertState = { state: "cleared", readAt: "2026-11-09T06:00:00.000Z" };

/** A cover whose only member resolved `minutesAgo` ago. */
async function seed(minutesAgo: number, alertname: string | null = ALERTNAME): Promise<void> {
  await db.query(`INSERT INTO public.companies (id) VALUES ($1) ON CONFLICT DO NOTHING`, [COMPANY]);
  await db.query(`INSERT INTO public.issues (id) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [COVER, ALERT]);
  await db.query(
    `INSERT INTO ${COVERS} (cover_issue_id, company_id, dedup_fingerprint, alertname) VALUES ($1, $2, $3, $4)`,
    [COVER, COMPANY, `cover:${ALERTNAME}:1`, alertname],
  );
  await db.query(
    `INSERT INTO ${MEMBERS} (id, cover_issue_id, alert_issue_id, resolved_at)
     VALUES (gen_random_uuid(), $1, $2, now() - make_interval(mins => $3::int))`,
    [COVER, ALERT, minutesAgo],
  );
}

const coverRow = async () =>
  (await db.query<Record<string, unknown>>(`SELECT * FROM ${COVERS} WHERE cover_issue_id = $1`, [COVER])).rows[0]!;

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
});
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec(`DELETE FROM ${MEMBERS}; DELETE FROM ${COVERS};`);
});

describe("PEN-6236 close guard, real SQL", () => {
  it("refuses the claim and records the deferral while the source is pending past the hold", async () => {
    await seed(20);
    const { ctx, mocks } = realCtx(db);
    await recordSourceResolvedAndCloseCovers(ctx, COMPANY, ALERT, HOLD_MINUTES, guardOf(LIVE));
    const row = await coverRow();
    expect(row.closing_claimed_at).toBeNull();
    expect(row.cancelled_at).toBeNull();
    expect(Number(row.close_deferral_count)).toBe(1);
    expect(row.last_close_deferral_at).not.toBeNull();
    expect(mocks.issues.update).not.toHaveBeenCalled();
  });

  it("claims and stamps source_cleared when the source is not pending", async () => {
    await seed(20);
    const { ctx, mocks } = realCtx(db);
    await recordSourceResolvedAndCloseCovers(ctx, COMPANY, ALERT, HOLD_MINUTES, guardOf(CLEARED));
    const row = await coverRow();
    expect(row.closing_claimed_at).not.toBeNull();
    expect(row.cancelled_at).not.toBeNull();
    expect(row.close_verdict).toBe("source_cleared");
    expect(String(row.close_verdict_detail)).toContain("2026-11-09T06:00:00.000Z");
    expect(mocks.issues.update).toHaveBeenCalledWith(COVER, { status: "cancelled" }, COMPANY);
    expect(mocks.issues.createComment).toHaveBeenCalledWith(COVER, expect.stringContaining("`source_cleared`"), COMPANY);
  });

  it("the recheck window really is hold + limit: 20m resolved defers at limit 240, 300m resolved does not", async () => {
    await seed(20);
    await recordSourceResolvedAndCloseCovers(realCtx(db).ctx, COMPANY, ALERT, HOLD_MINUTES, guardOf(LIVE, 240));
    expect((await coverRow()).close_verdict).toBeNull();

    await db.exec(`DELETE FROM ${MEMBERS}; DELETE FROM ${COVERS};`);
    await seed(300);
    await recordSourceResolvedAndCloseCovers(realCtx(db).ctx, COMPANY, ALERT, HOLD_MINUTES, guardOf(LIVE, 240));
    expect((await coverRow()).close_verdict).toBe("source_live_recheck_expired");
  });

  it("the boundary is the configured limit, not a constant: a short limit expires the same cover", async () => {
    await seed(20);
    // hold 15 + limit 1 = 16m < 20m resolved ⇒ outside the window already.
    await recordSourceResolvedAndCloseCovers(realCtx(db).ctx, COMPANY, ALERT, HOLD_MINUTES, guardOf(LIVE, 1));
    expect((await coverRow()).close_verdict).toBe("source_live_recheck_expired");
  });

  it("an unresolved member blocks the close whatever Prometheus says", async () => {
    await seed(20);
    await db.query(`UPDATE ${MEMBERS} SET resolved_at = NULL`);
    const { ctx, mocks } = realCtx(db);
    await recordSourceResolvedAndCloseCovers(ctx, COMPANY, ALERT, HOLD_MINUTES, guardOf(CLEARED));
    // the resolve cascade re-marks THIS member, but it is the only one, so the
    // close is decided on the hold — not yet elapsed, so nothing is claimed.
    const row = await coverRow();
    expect(row.closing_claimed_at).toBeNull();
    expect(Number(row.close_deferral_count)).toBe(0);
    expect(mocks.issues.update).not.toHaveBeenCalled();
  });

  it("a NULL alertname closes as alertname_unknown and never addresses a read", async () => {
    await seed(20, null);
    const readSourceState = vi.fn(async () => LIVE);
    await recordSourceResolvedAndCloseCovers(realCtx(db).ctx, COMPANY, ALERT, HOLD_MINUTES, { readSourceState, recheckLimitMinutes: 240, configured: true });
    expect((await coverRow()).close_verdict).toBe("alertname_unknown");
    expect(readSourceState).not.toHaveBeenCalled();
  });

  it("migration 010's backfill regex recovers the alertname from every real fingerprint shape", async () => {
    const { rows } = await db.query<{ parsed: string | null }>(
      `SELECT substring(fp from '^cover:(.*):[0-9]+$') AS parsed
         FROM (VALUES ('cover:PaperclipApprovalStarved:1'),
                      ('cover:LLMProxyHighLatencyP95:490123'),
                      ('cover:Weird:Name:With:Colons:7'),
                      ('not-a-cover-fingerprint'),
                      ('cover:TrailingNoBucket:')) AS t(fp)`,
    );
    expect(rows.map((r) => r.parsed)).toEqual([
      "PaperclipApprovalStarved",
      "LLMProxyHighLatencyP95",
      // greedy `.*` with an anchored bucket keeps every colon in the name
      "Weird:Name:With:Colons",
      // unparseable shapes stay NULL rather than being guessed at
      null,
      null,
    ]);
  });

  it("the 010 columns exist with the defaults the code assumes", async () => {
    const { rows } = await db.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'alert_escalation_covers'
          AND column_name IN ('alertname','close_verdict','close_verdict_detail','close_deferral_count','last_close_deferral_at')
        ORDER BY column_name`,
      [NAMESPACE],
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "alertname", "close_deferral_count", "close_verdict", "close_verdict_detail", "last_close_deferral_at",
    ]);
    const count = rows.find((r) => r.column_name === "close_deferral_count")!;
    // NOT NULL DEFAULT 0 — the deferral UPDATE increments in place and would
    // produce NULL on an existing row if either were missing.
    expect(count.is_nullable).toBe("NO");
    expect(count.column_default).toContain("0");
  });
});

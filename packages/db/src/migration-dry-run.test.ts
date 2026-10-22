/**
 * BLO-48353: the deploy pre-flight executes pending migrations against the
 * target database in a rolled-back transaction. The case it exists for is
 * 0263 as shipped at 9ded350: its PEN-4466 guard RAISEd on live
 * `subscription_included` rows during worker boot and crash-looped production
 * for ~30 min, while the catalog-only pre-flight passed.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { dryRunPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0263_cost_events_consumption_cents.sql";
const COMPANY = "11111111-1111-4111-8111-111111111111";
// `git show 9ded350:packages/db/src/migrations/0263_cost_events_consumption_cents.sql`,
// pinned as a fixture so this test keeps exercising the outage after 0263 is fixed.
const PRE_FIX_0263 = fs.readFileSync(
  new URL("./__fixtures__/0263_cost_events_consumption_cents.9ded350.sql", import.meta.url),
  "utf8",
);
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

async function startDatabase() {
  const database = await startEmbeddedPostgresTestDatabase("paperclip-migration-dry-run-");
  cleanups.push(database.cleanup);
  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(async () => sql.end());
  // Rewind to just before 0263 so it is the pending set.
  const current = fs.readFileSync(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  await sql.unsafe(`ALTER TABLE cost_events DROP COLUMN IF EXISTS consumption_cents`);
  await sql`DELETE FROM "drizzle"."__drizzle_migrations"
            WHERE "hash" = ${createHash("sha256").update(current).digest("hex")}`;
  return { url: database.connectionString, sql };
}

async function seed(sql: postgres.Sql, billingType: string) {
  await sql.unsafe(`
    SET session_replication_role = replica;
    INSERT INTO cost_events (company_id, agent_id, provider, model, billing_type, cost_cents, occurred_at)
    VALUES ('${COMPANY}', gen_random_uuid(), 'anthropic', 'claude-opus-5', '${billingType}', 100, now());
    SET session_replication_role = origin;
  `);
}

/** What a rolled-back dry-run must leave behind: the database exactly as found. */
async function untouched(sql: postgres.Sql) {
  const [column] = await sql`SELECT count(*)::int AS n FROM information_schema.columns
                             WHERE table_name = 'cost_events' AND column_name = 'consumption_cents'`;
  const [journal] = await sql`SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"`;
  return { column: column!.n, journal: journal!.n };
}

const preFix = async (file: string) =>
  file === MIGRATION_FILE
    ? PRE_FIX_0263
    : fs.promises.readFile(new URL(`./migrations/${file}`, import.meta.url), "utf8");

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);

describeEmbeddedPostgres("pending-migration dry-run (BLO-48353)", () => {
  it("FAILS on the pre-fix 0263 bytes when a subscription_included row exists, and records nothing", async () => {
    const { url, sql } = await startDatabase();
    await seed(sql, "subscription_included");
    const before = await untouched(sql);

    const result = await dryRunPendingMigrations(url, { readMigration: preFix });

    expect(result.verdict).toBe("fail");
    expect(result.migration).toBe(MIGRATION_FILE);
    expect(result.detail).toMatch(/PEN-4466: 1 cost_events rows already carry billing_type = subscription_included/);
    expect(await untouched(sql)).toEqual({ ...before, column: 0 });
  }, 120_000);

  it("PASSES on the repo's 0263 against a clean ledger, executing it and rolling it back", async () => {
    const { url, sql } = await startDatabase();
    await seed(sql, "metered_api");
    const before = await untouched(sql);

    const result = await dryRunPendingMigrations(url);

    expect(result.verdict).toBe("pass");
    expect(result.executed).toEqual([MIGRATION_FILE]);
    expect(await untouched(sql)).toEqual({ ...before, column: 0 });
  }, 120_000);

  it("is INCONCLUSIVE, not FAIL, when it cannot get the migration's lock in time", async () => {
    const { url, sql } = await startDatabase();
    const holder = postgres(url, { max: 1, onnotice: () => {} });
    cleanups.push(async () => holder.end());
    const release = holder.begin(async (tx) => {
      await tx`LOCK TABLE cost_events IN ACCESS SHARE MODE`;
      await tx`SELECT pg_sleep(3)`;
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await dryRunPendingMigrations(url, { lockTimeoutMs: 200, readMigration: preFix });
    await release;

    expect(result.verdict).toBe("inconclusive");
    expect(result.detail).toMatch(/^55P03/);
    expect((await untouched(sql)).column).toBe(0);
  }, 120_000);

  it("FAILS (25001), not skips, a non-transactional statement the runner would also crash on", async () => {
    const { url, sql } = await startDatabase();
    await seed(sql, "metered_api");
    const before = await untouched(sql);

    const result = await dryRunPendingMigrations(url, {
      readMigration: async () => 'CREATE INDEX CONCURRENTLY "cost_events_dry_run_probe" ON "cost_events" ("id");',
    });

    expect(result.verdict).toBe("fail");
    expect(result.detail).toMatch(/^25001/);
    expect(await untouched(sql)).toEqual(before);
  }, 120_000);
});

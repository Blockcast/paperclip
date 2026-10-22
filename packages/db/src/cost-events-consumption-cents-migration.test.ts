/**
 * PEN-4466: migration 0263 adds the consumption column the budget gates enforce on.
 *
 * `subscription_included` rows already had `cost_cents` zeroed by `normalizeBilledCostCents`,
 * so copying it would record a false $0. They are left NULL ("not recorded") instead. An
 * earlier revision RAISEd on such rows; production held ~4k of them, so the worker
 * crash-looped on deploy and helm rolled back (BLO-48352). The second test pins that the
 * migration now applies on exactly that data.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0263_cost_events_add_consumption_cents.sql";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

async function startDatabase(prefix: string) {
  const database = await startEmbeddedPostgresTestDatabase(prefix);
  cleanups.push(database.cleanup);
  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(async () => sql.end());
  return { database, sql };
}

/**
 * Rewind to just before 0263: drop the column and un-journal the migration, so
 * `applyPendingMigrations` replays it against whatever rows the test seeded.
 */
async function rewindToBeforeMigration(sql: postgres.Sql) {
  await sql.unsafe(`ALTER TABLE cost_events DROP COLUMN IF EXISTS consumption_cents`);
  await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
}

async function seedLedgerRow(sql: postgres.Sql, billingType: string, costCents: number) {
  await sql.unsafe(`
    SET session_replication_role = replica;
    INSERT INTO cost_events (company_id, agent_id, provider, model, billing_type, cost_cents, occurred_at)
    VALUES ('${COMPANY}', gen_random_uuid(), 'anthropic', 'claude-opus-5', '${billingType}', ${costCents}, now());
    SET session_replication_role = origin;
  `);
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);

describeEmbeddedPostgres("cost_events consumption_cents migration", () => {
  it("backfills consumption_cents from cost_cents for rows written before the column", async () => {
    const { database, sql } = await startDatabase("paperclip-consumption-backfill-");
    await rewindToBeforeMigration(sql);
    await seedLedgerRow(sql, "metered_api", 4_271);

    await applyPendingMigrations(database.connectionString);
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");

    const rows = await sql`SELECT cost_cents, consumption_cents FROM cost_events`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.consumption_cents).toBe(4_271);
    expect(rows[0]!.consumption_cents).toBe(rows[0]!.cost_cents);
  }, 120_000);

  it("applies over subscription_included rows, leaving them NULL rather than a baked-in zero", async () => {
    const { database, sql } = await startDatabase("paperclip-consumption-ordering-");
    await rewindToBeforeMigration(sql);
    // What production held on 2026-10-22 (BLO-48352): subscription rows whose cash column
    // normalizeBilledCostCents already zeroed, alongside ordinary metered and overage rows.
    await seedLedgerRow(sql, "subscription_included", 0);
    await seedLedgerRow(sql, "subscription_overage", 900);
    await seedLedgerRow(sql, "metered_api", 4_271);

    await applyPendingMigrations(database.connectionString);
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");

    const rows = await sql`SELECT billing_type, consumption_cents FROM cost_events ORDER BY billing_type`;
    expect(rows.map((r) => [r.billing_type, r.consumption_cents])).toEqual([
      ["metered_api", 4_271],
      ["subscription_included", null],
      ["subscription_overage", 900],
    ]);
  }, 120_000);
});

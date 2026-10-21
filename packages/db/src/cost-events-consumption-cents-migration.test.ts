/**
 * PEN-4466: migration 0263 adds the consumption column the budget gates enforce on.
 *
 * Two properties, and the first one is the point. The backfill
 * `consumption_cents := cost_cents` is correct only while no subscription-typed row has
 * ever been written -- once `normalizeBilledCostCents` has zeroed any, copying `cost_cents`
 * bakes the zeros in permanently. The migration states that as a RAISE rather than as a
 * SELECT in a runbook, so this suite exists to prove the gate actually fires rather than
 * sitting in the file as decoration.
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

const MIGRATION_FILE = "0263_cost_events_consumption_cents.sql";
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

  it("refuses to run if the classification fix landed first, rather than backfilling zeros", async () => {
    const { database, sql } = await startDatabase("paperclip-consumption-ordering-");
    await rewindToBeforeMigration(sql);
    // What a CORRECTLY classifying adapter writes: subscription lane, cash column already
    // zeroed by normalizeBilledCostCents. Backfilling from cost_cents here would make the
    // zero permanent and leave every hard stop unreachable.
    await seedLedgerRow(sql, "subscription_included", 0);

    await expect(applyPendingMigrations(database.connectionString)).rejects.toThrow(
      /PEN-4466: 1 cost_events rows already carry billing_type = subscription_included/,
    );

    // The column must not exist and the migration must still read as pending -- a partial
    // apply that left the column behind would make a re-run look like a clean no-op.
    const columns = await sql`
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'cost_events' AND column_name = 'consumption_cents'
    `;
    expect(columns).toHaveLength(0);
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: expect.arrayContaining([MIGRATION_FILE]),
    });
  }, 120_000);
});

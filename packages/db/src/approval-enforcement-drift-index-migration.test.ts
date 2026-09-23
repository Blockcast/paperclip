/**
 * Verifies the BLO-24631 approval-enforcement drift index migration is applied
 * and replays idempotently.
 *
 * The migration is located by suffix rather than by number: the leading 4-digit
 * number is a rebase coordinate that master reassigns whenever another migration
 * lands first, and hardcoding it here made the number a coordinate held in four
 * places instead of two.
 *
 * The predicate matters as much as the columns: it is scoped to the *open*
 * population (`hidden_at IS NULL`, `status NOT IN ('done','cancelled')`) so a
 * recurrence of the same approval's drift can file a fresh issue after the
 * previous one is closed, rather than being permanently suppressed by it.
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

const MIGRATION_SUFFIX = "_approval_enforcement_drift_index.sql";
const MIGRATION_FILE = resolveMigrationFile();
const INDEX_NAME = "issues_active_approval_enforcement_drift_uq";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function resolveMigrationFile() {
  const matches = fs
    .readdirSync(new URL("./migrations/", import.meta.url))
    .filter((entry) => entry.endsWith(MIGRATION_SUFFIX))
    .sort();
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one migration ending in "${MIGRATION_SUFFIX}", found ${matches.length}${
        matches.length > 0 ? `: ${matches.join(", ")}` : ""
      }`,
    );
  }
  return matches[0]!;
}

async function migrationHash() {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 60_000);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping approval-enforcement drift index migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("approval-enforcement drift index migration", () => {
  it("creates the partial unique index and replays idempotently", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-approval-drift-index-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const readIndexDefinition = async () => {
      const rows = await sql<{ indexdef: string }[]>`
        SELECT "indexdef"
        FROM "pg_indexes"
        WHERE "schemaname" = 'public'
          AND "tablename" = 'issues'
          AND "indexname" = ${INDEX_NAME}
      `;
      return rows[0]?.indexdef ?? null;
    };

    const definition = await readIndexDefinition();
    expect(definition).toContain("CREATE UNIQUE INDEX");
    expect(definition).toContain("(company_id, origin_kind, origin_id)");
    expect(definition).toContain("origin_kind = 'approval_enforcement_drift'");
    expect(definition).toContain("origin_id IS NOT NULL");
    expect(definition).toContain("hidden_at IS NULL");
    expect(definition).toContain("status <> ALL (ARRAY['done'::text, 'cancelled'::text])");

    await sql`
      DELETE FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = ${await migrationHash()}
    `;
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });

    await applyPendingMigrations(database.connectionString);

    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
    expect(await readIndexDefinition()).toBe(definition);
  }, 60_000);
});

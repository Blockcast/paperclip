import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

/**
 * BLO-19722 / BLO-20822 — the three-phase crash-recovery migration.
 *
 * The single-file predecessor was unsatisfiable on any populated database. It
 * added `crash_recovery_completed_at` and then raised, demanding the operator
 * precreate an index whose predicate references that column — but drizzle runs
 * every pending migration file inside ONE transaction, so the raise rolled the
 * `ADD COLUMN` back and the hinted `CREATE INDEX CONCURRENTLY` failed with
 * "column does not exist". Migrations could then never advance.
 *
 * The previous test could not see any of that: it started from a database that
 * was already post-0211 (the column present, only the index dropped), which is
 * a state the loop never reaches. Every case here therefore DROPS
 * `crash_recovery_completed_at` first, so the migration is exercised from a
 * genuinely pre-0211 shape.
 */
const PHASE_A = "0211_heartbeat_runs_crash_recovery_columns.sql";
const PHASE_B = "0212_heartbeat_runs_crash_recovery_index.sql";
const PHASE_C = "0213_heartbeat_runs_crash_recovery_validate.sql";
const INDEX_NAME = "heartbeat_runs_crash_recovery_pending_idx";
const CRASH_COLUMNS = [
  "crash_recovery_completed_at",
  "crash_recovery_attempts",
  "crash_recovery_next_attempt_at",
  "crash_recovery_last_error",
];

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash(file: string) {
  const content = await fs.promises.readFile(new URL(`./migrations/${file}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Rewind the database to the pre-0211 shape: drop the columns and index the
 * three phases install, and forget that they ever ran.
 */
async function rewindToPre0211(sql: postgres.Sql) {
  await sql.unsafe(`
    DROP INDEX IF EXISTS ${INDEX_NAME};
    ${CRASH_COLUMNS.map((column) => `ALTER TABLE heartbeat_runs DROP COLUMN IF EXISTS ${column};`).join("\n")}
  `);
  for (const file of [PHASE_A, PHASE_B, PHASE_C]) {
    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash(file)}`;
  }
}

/** A row, so the table is non-empty and takes the "populated" branch. */
async function seedOneRun(sql: postgres.Sql) {
  await sql.unsafe(`
    SET session_replication_role = replica;
    INSERT INTO heartbeat_runs (company_id, agent_id)
    VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    SET session_replication_role = origin;
  `);
}

async function presentColumns(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'heartbeat_runs'
      and column_name = any(${CRASH_COLUMNS})
    order by column_name
  `;
  return rows.map((row) => row.column_name).sort();
}

async function indexExists(sql: postgres.Sql): Promise<boolean> {
  const [row] = await sql<{ present: boolean }[]>`
    select to_regclass(${`public.${INDEX_NAME}`}) is not null as present
  `;
  return row?.present ?? false;
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);

describeEmbeddedPostgres("heartbeat-run crash-recovery migration phases", () => {
  async function freshDatabase(prefix: string) {
    const database = await startEmbeddedPostgresTestDatabase(prefix);
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());
    return { database, sql };
  }

  it("applies cleanly to a populated pre-0211 database without requiring the index first", async () => {
    // The regression test for the unbreakable loop. Populated table, no column,
    // no index — exactly the production shape the old single-file migration
    // could never get past.
    const { database, sql } = await freshDatabase("paperclip-crash-recovery-populated-");
    await seedOneRun(sql);
    await rewindToPre0211(sql);

    expect(await presentColumns(sql)).toEqual([]);

    // Must NOT throw. A raise here would roll Phase A back, and the operator
    // could never run the CREATE INDEX CONCURRENTLY the raise asked for.
    await applyPendingMigrations(database.connectionString);

    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
    // Phase A landed and is durable — this is what makes the index creatable.
    expect(await presentColumns(sql)).toEqual([...CRASH_COLUMNS].sort());
    // Phase B deliberately skipped the inline build on a populated table.
    // Recovery is correct without it (sequential scan finds every candidate).
    expect(await indexExists(sql)).toBe(false);
  }, 120_000);

  it("lets the operator create the index online afterwards, and stays up to date", async () => {
    // The half the loop made impossible: because Phase A committed, the
    // predicate's column exists, so CREATE INDEX CONCURRENTLY now succeeds.
    const { database, sql } = await freshDatabase("paperclip-crash-recovery-online-");
    await seedOneRun(sql);
    await rewindToPre0211(sql);
    await applyPendingMigrations(database.connectionString);

    await sql.unsafe(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
      ON heartbeat_runs USING btree (finished_at, id)
      WHERE error_code = 'worker_crashed' AND crash_recovery_completed_at IS NULL
    `);

    expect(await indexExists(sql)).toBe(true);
    // Re-running the phases over the now-correct index is a no-op, not a raise.
    for (const file of [PHASE_B, PHASE_C]) {
      await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash(file)}`;
    }
    await applyPendingMigrations(database.connectionString);
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
    expect(await indexExists(sql)).toBe(true);
  }, 120_000);

  it("builds the index inline on an empty database", async () => {
    // Bootstrap and test databases get it for free; the build is instantaneous
    // and takes no meaningful lock on an empty table.
    const { database, sql } = await freshDatabase("paperclip-crash-recovery-empty-");
    await rewindToPre0211(sql);

    await applyPendingMigrations(database.connectionString);

    expect(await presentColumns(sql)).toEqual([...CRASH_COLUMNS].sort());
    expect(await indexExists(sql)).toBe(true);
  }, 120_000);

  it("rejects an incorrectly defined same-name index with a repair hint", async () => {
    // Raising here is safe and does not recreate the loop: `DROP INDEX` needs
    // nothing from this migration batch, so the operator can always act on it.
    const { database, sql } = await freshDatabase("paperclip-crash-recovery-wrong-index-");
    await seedOneRun(sql);
    await rewindToPre0211(sql);
    // The column has to exist for a wrong-but-parseable index to be built at
    // all, so add it the way Phase A would; the migration is still pending.
    await sql.unsafe(`
      ALTER TABLE heartbeat_runs ADD COLUMN crash_recovery_completed_at timestamp with time zone;
      CREATE INDEX ${INDEX_NAME}
      ON heartbeat_runs USING btree (id)
      WHERE error_code = 'worker_crashed' AND crash_recovery_completed_at IS NULL;
    `);

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: `migration 0212 found an invalid or incorrectly defined ${INDEX_NAME}`,
      hint: expect.stringContaining(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`),
    });
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
    });
  }, 120_000);

  it("rejects an index left invalid by a failed concurrent build", async () => {
    const { database, sql } = await freshDatabase("paperclip-crash-recovery-invalid-index-");
    await seedOneRun(sql);
    await rewindToPre0211(sql);
    await sql.unsafe(`
      ALTER TABLE heartbeat_runs ADD COLUMN crash_recovery_completed_at timestamp with time zone;
      CREATE INDEX ${INDEX_NAME}
      ON heartbeat_runs USING btree (finished_at, id)
      WHERE error_code = 'worker_crashed' AND crash_recovery_completed_at IS NULL;
      UPDATE pg_index SET indisvalid = FALSE WHERE indexrelid = '${INDEX_NAME}'::regclass;
    `);

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: `migration 0212 found an invalid or incorrectly defined ${INDEX_NAME}`,
    });
  }, 120_000);

  it("keeps phase A durable when 0212 raises on a genuinely pre-0211 database, so the repair hint is followable", async () => {
    // Review round 3 argued that 0212's malformed-index RAISE rolls phase A
    // back, leaving the hinted `CREATE INDEX CONCURRENTLY` referencing a column
    // that no longer exists — an unfollowable instruction. That is true of
    // drizzle's own migrator, which wraps every pending file in ONE
    // transaction, but it is not the migrator this repo runs. Production goes
    // `pnpm db:migrate` -> packages/db/src/migrate.ts -> applyPendingMigrations
    // -> applyPendingMigrationsManually, which opens a transaction PER FILE and
    // commits that file's history row before starting the next. drizzle's
    // batch migrator is reached only on an empty database with no journal,
    // where this branch cannot fire because the table is empty.
    //
    // This test pins that difference, because the hint's correctness depends on
    // it: if the runner is ever switched to the batch migrator, phase A stops
    // surviving and this fails, which is the signal to reorder the hint.
    //
    // Setup is genuinely pre-0211 — no crash_recovery_* columns at all. The
    // malformed index therefore cannot reference one, so it is a same-name
    // index over a predicate that is buildable without them.
    const { database, sql } = await freshDatabase("paperclip-crash-recovery-pre0211-malformed-");
    await seedOneRun(sql);
    await rewindToPre0211(sql);
    expect(await presentColumns(sql)).toEqual([]);
    await sql.unsafe(`
      CREATE INDEX ${INDEX_NAME}
      ON heartbeat_runs USING btree (id)
      WHERE error_code = 'worker_crashed'
    `);

    // `.then(onFulfilled, onRejected)` rather than `.catch`, so a migration run
    // that wrongly SUCCEEDS is caught by the null assertion below instead of
    // surfacing as a TypeError on a `void` value.
    const failure = await applyPendingMigrations(database.connectionString).then(
      () => null,
      (error: unknown) => error as { message?: string; hint?: string },
    );
    expect(failure, "expected 0212 to reject on the malformed index").not.toBeNull();
    expect(failure?.message).toBe(`migration 0212 found an invalid or incorrectly defined ${INDEX_NAME}`);

    // The load-bearing fact: phase A committed in its own transaction and the
    // 0212 raise did not take it with it.
    expect(await presentColumns(sql)).toEqual([...CRASH_COLUMNS].sort());
    expect(failure?.hint).toContain(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`);

    // So the hint can be followed exactly as written, in its stated order.
    await sql.unsafe(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
    await sql.unsafe(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
      ON heartbeat_runs USING btree (finished_at, id)
      WHERE error_code = 'worker_crashed' AND crash_recovery_completed_at IS NULL
    `);
    await applyPendingMigrations(database.connectionString);

    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
    expect(await indexExists(sql)).toBe(true);
  }, 120_000);

  it("rejects a same-type crash-recovery column that carries a default", async () => {
    // Phase A adds every column with `ADD COLUMN IF NOT EXISTS`, so a
    // pre-existing column of the *same type* survives untouched with whatever
    // default it already had. `crash_recovery_completed_at DEFAULT now()` is the
    // dangerous shape: it type-matches, Phase A no-ops, and then every newly
    // crash-marked run is born already "completed" — so the reconciler's
    // `crash_recovery_completed_at IS NULL` scan matches nothing and crash
    // recovery silently never runs. Validating the type alone let this through.
    const { database, sql } = await freshDatabase("paperclip-crash-recovery-default-column-");
    await seedOneRun(sql);
    await rewindToPre0211(sql);
    await sql.unsafe(`
      ALTER TABLE heartbeat_runs
      ADD COLUMN crash_recovery_completed_at timestamp with time zone DEFAULT now();
    `);

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: expect.stringContaining("migration 0213"),
      hint: expect.stringContaining("carry no default"),
    });
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
    });
  }, 120_000);

  it("rejects a same-type crash-recovery column declared NOT NULL", async () => {
    // The other half of the contract. NOT NULL type-matches too, but every one
    // of these columns encodes "absent" as NULL — `crash_recovery_attempts` is
    // read as `?? 0`, and the completion stamp writes NULL back into
    // `crash_recovery_next_attempt_at` and `crash_recovery_last_error`, which a
    // NOT NULL column rejects at runtime. Left empty here so the column is
    // addable without also needing a default, isolating nullability.
    const { database, sql } = await freshDatabase("paperclip-crash-recovery-notnull-column-");
    await rewindToPre0211(sql);
    await sql.unsafe(`
      ALTER TABLE heartbeat_runs ADD COLUMN crash_recovery_attempts integer NOT NULL;
    `);

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: expect.stringContaining("crash_recovery_attempts"),
    });
  }, 120_000);
});

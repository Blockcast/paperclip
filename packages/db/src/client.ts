import { createHash } from "node:crypto";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema/index.js";
import { registerTrackedClient } from "./embedded-test-client-registry.js";
import { ensureConcurrentIndexesForMigration } from "./concurrent-index-guard.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));
const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";
const MIGRATIONS_JOURNAL_JSON = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));

function createUtilitySql(url: string) {
  return postgres(url, { max: 1, onnotice: () => {} });
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function quoteIdentifier(value: string): string {
  if (!isSafeIdentifier(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function splitMigrationStatements(content: string): string[] {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export type MigrationState =
  | { status: "upToDate"; tableCount: number; availableMigrations: string[]; appliedMigrations: string[] }
  | {
      status: "needsMigrations";
      tableCount: number;
      availableMigrations: string[];
      appliedMigrations: string[];
      pendingMigrations: string[];
      reason: "no-migration-journal-empty-db" | "no-migration-journal-non-empty-db" | "pending-migrations";
    };

export type ApplyPendingMigrationsOptions = {
  /**
   * Prepare guarded `CREATE INDEX CONCURRENTLY` prerequisites immediately
   * before each migration file. This is opt-in so migration tests and callers
   * that intentionally exercise a migration's raw failure remain unchanged.
   */
  readonly prepareOnlineIndexes?: boolean;
  readonly log?: (message: string) => void;
};

/**
 * Connection-pool ceiling for the application client.
 *
 * This was previously postgres.js's implicit default (also 10), which meant
 * callers that must reason about pool capacity had no value to read and could
 * only restate the number in prose. Declaring it here makes it a single source
 * of truth: `PR_REVIEWER_WAKE_MAX_CONCURRENCY` in `routes/github-webhook.ts`
 * derives its bound from this constant so a change here cannot silently
 * reintroduce the connection deadlock that bound exists to prevent (BLO-21995).
 *
 * Passing it explicitly also makes it authoritative: postgres.js resolves
 * `max` as `explicit option > URL query param > PGMAX env > default`, so a
 * `?max=` in the connection string can no longer shrink the pool out from
 * under a caller that derived a bound from it.
 *
 * ## Why this stays at 10 (BLO-35946 AC3)
 *
 * Three incidents now cite this number, and none of them is a sizing problem:
 *
 * - `server/src/index.ts` (BLO-34207) and `services/issues.ts` — 8-9 waiters on
 *   one *company-wide advisory lock*. The holder could not get the second
 *   connection it needed to finish, so the waiters it was blocking were the
 *   reason it stayed blocked. Raising `max` moves that wall without removing
 *   it: N+1 overlapping passes re-create it at any N. Both were fixed with a
 *   latch, not with connections.
 * - This issue — 9 of 10 slots were in postgres.js's `ended` queue and
 *   unreclaimable. A pool of 50 would have leaked to zero the same way, just
 *   more slowly.
 *
 * So the value is deliberate, and the standing rule is the one
 * `derivePrReviewerWakeMaxConcurrency` in `routes/github-webhook.ts` already
 * follows: a path that can run concurrently and needs *two* connections per
 * unit of work bounds itself against this constant. Raising `max` is the wrong
 * lever for every failure recorded against it so far — each connection is a
 * server-side backend, so it trades a client-side queue for server-side memory
 * and buys time rather than correctness.
 */
export const POSTGRES_POOL_MAX = 10;

/**
 * How long a pooled connection that has been asked to end, but still has a
 * query in flight, may wait for that query before it is terminated outright.
 *
 * Without this the wait is unbounded and the connection is lost for the life of
 * the process (BLO-35946). postgres.js's `end()` moves a connection to the
 * pool's `ended` queue *before* it checks whether the connection is quiescent,
 * and `handler()` never draws from `ended`. When a query is in flight it then
 * takes the non-quiescent branch, which deliberately skips `terminate()` and
 * waits for the `ReadyForQuery` that ends the query. If that message never
 * arrives the slot is gone: on 2026-09-24 nine of ten slots left this pool that
 * way and company-wide dispatch ran on the remaining one for 2h15m, recoverable
 * only by `pg_terminate_backend` from an operator session.
 *
 * Terminating is what makes the slot come back. `terminate()` rejects the
 * in-flight query and closes the socket, and the resulting `closed()` lands the
 * connection in the pool's `closed` queue — the one non-`open` queue
 * `handler()` does draw from — so it reconnects on the next query. That is the
 * same recovery the operator achieved from the server side, driven from the
 * client.
 *
 * 120s, matching {@link POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS}, and for a
 * similar reason: it only ever fires when something is already wrong. In the
 * healthy case the in-flight query finishes in milliseconds and `terminate()`
 * happens at `ReadyForQuery`, nowhere near this bound. It is also comfortably
 * above the 30s role-level `statement_timeout` this repo asserts in
 * `routes/plugins.ts` and migration `0098`, so a query that the server would
 * itself have killed is never cut short by this instead.
 *
 * Unlike the other options here this one does not exist upstream — it is added
 * by `patches/postgres@3.4.9.patch` and defaults to `null` (the current,
 * unbounded behaviour) so the patch changes nothing for a caller that does not
 * set it.
 */
export const POSTGRES_CLOSE_TIMEOUT_SECONDS = 120;

/**
 * Bounds on how long a pooled connection lives before it is recycled.
 *
 * These are not a behaviour change: they restate postgres.js's own default
 * (`max_lifetime()` in its `src/index.js`, a fresh `60 * (30 + random * 30)`
 * seconds per connection) so the value is readable here instead of only in the
 * dependency. BLO-35946 AC4 — during that incident `max_lifetime` was the one
 * routine caller of the `end()` path that leaks, and establishing what it was
 * set to meant reading library source mid-incident.
 *
 * The spread is the point, so it is passed as a function rather than a number:
 * postgres.js evaluates `max_lifetime` once per connection, so a plain number
 * would retire all ten together and empty the pool in one tick.
 */
export const POSTGRES_MAX_LIFETIME_MIN_SECONDS = 30 * 60;
export const POSTGRES_MAX_LIFETIME_MAX_SECONDS = 60 * 60;

/**
 * How long a pooled application connection may sit inside an open transaction
 * with no statement running before Postgres terminates it.
 *
 * This is not a new number: it matches `DELIVERY_LOCK_HOLD_TIMEOUT_MS` in
 * `server/src/services/github-status-delivery-outbox.ts`, which already applies
 * exactly this bound — for exactly this reason — to one critical section that
 * performs external I/O while holding a transaction open. This applies the same
 * bound pool-wide so a section nobody thought to guard cannot pin a connection
 * forever.
 *
 * Why it is safe to set unconditionally, unlike `statement_timeout`: Postgres
 * resolves GUCs as `postgresql.conf` < `ALTER DATABASE SET` < `ALTER ROLE SET`
 * < startup-packet parameters < session `SET`, and both settings have context
 * `user` — so a startup-packet value *overrides* a role-level one rather than
 * stacking with it, and can therefore loosen an existing bound as easily as
 * tighten it. That risk is real for `statement_timeout`, where a role-level
 * bound is plausible and would be silently raised. It does not apply here: no
 * healthy workload wants an idle-open transaction, so there is no bound worth
 * preserving. `statement_timeout` is deliberately left unset until
 * {@link readInheritedTimeoutSettings} has reported what is actually in force.
 *
 * A `?idle_in_transaction_session_timeout=` in the connection URL still wins
 * over this, because postgres.js lets URL query parameters override
 * `options.connection`. That is the intended escape hatch for an operator.
 */
export const POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS = 120_000;

export function createDb(url: string) {
  const sql = postgres(url, {
    max: POSTGRES_POOL_MAX,
    // Sent in the startup packet, so it applies to every connection this pool
    // opens — including ones created later to refill the pool. postgres.js
    // filters falsy startup parameters out entirely, so a `0` here would ship
    // no bound at all rather than the "disabled" it reads as; the value must
    // stay positive for this to mean anything.
    connection: {
      idle_in_transaction_session_timeout: POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    },
    // Neither of these is usable through the shipped typings in the shape it is
    // needed: `close_timeout` is added by `patches/postgres@3.4.9.patch` and so
    // appears in no upstream `.d.ts`, and `max_lifetime` is typed `number |
    // null` even though the driver accepts — and this pool requires — a
    // function, evaluated once per connection. Same cast the existing patched
    // `poolStats()` needs at its call sites.
    ...({
      close_timeout: POSTGRES_CLOSE_TIMEOUT_SECONDS,
      max_lifetime: () =>
        POSTGRES_MAX_LIFETIME_MIN_SECONDS +
        Math.random() * (POSTGRES_MAX_LIFETIME_MAX_SECONDS - POSTGRES_MAX_LIFETIME_MIN_SECONDS),
    } as Record<string, unknown>),
  });
  // Inert in production; only embedded test databases register their URL so
  // their pools can be closed before the server stops (see registry module).
  registerTrackedClient(url, sql);
  return createDbFromPostgresClient(sql);
}

/**
 * The three timeouts that decide whether a query can hang forever, as they are
 * inherited from the server environment (`postgresql.conf`, `ALTER DATABASE
 * SET`, `ALTER ROLE SET`) — *before* any client-side override.
 *
 * `valueMs` is `null` when the setting is disabled (Postgres reports `0`),
 * which is the unbounded case and the one worth alerting on.
 */
export type InheritedTimeoutSetting = {
  readonly name: string;
  readonly valueMs: number | null;
  readonly source: string;
};

export type InheritedTimeoutSettings = {
  readonly statementTimeout: InheritedTimeoutSetting;
  readonly idleInTransactionSessionTimeout: InheritedTimeoutSetting;
  readonly lockTimeout: InheritedTimeoutSetting;
};

const TIMEOUT_SETTING_NAMES = [
  "statement_timeout",
  "idle_in_transaction_session_timeout",
  "lock_timeout",
] as const;

/**
 * Read the effective timeout environment on a connection that carries none of
 * this module's own client-side overrides.
 *
 * It deliberately uses {@link createUtilitySql}, not the application pool. The
 * pool sets `idle_in_transaction_session_timeout` in its startup packet, so
 * reading these values there would report our own override back to us and
 * destroy the one piece of evidence this probe exists to collect: whether the
 * *server* already bounds these. `statement_timeout` and `lock_timeout` are not
 * set by the pool, so the values reported here are what the pool inherits too.
 *
 * The repo asserts a role-level 30s `statement_timeout` in two places
 * (`routes/plugins.ts`, migration `0098`) and `lib/db-retry.ts` retries `57014`
 * on that basis, but no `ALTER ROLE` exists in either `Blockcast/paperclip` or
 * `Blockcast/onprem-k8s` — so the assertion is unverified. This answers it from
 * whatever database the process is actually pointed at, with no cluster access.
 */
export async function readInheritedTimeoutSettings(
  url: string,
): Promise<InheritedTimeoutSettings> {
  const sql = createUtilitySql(url);
  try {
    const rows = await sql<{ name: string; setting: string; source: string }[]>`
      SELECT name, setting, source
      FROM pg_settings
      WHERE name IN ${sql(TIMEOUT_SETTING_NAMES)}
    `;
    const byName = new Map(rows.map((row) => [row.name, row]));
    const read = (name: string): InheritedTimeoutSetting => {
      const row = byName.get(name);
      // pg_settings reports these three in milliseconds, and 0 means disabled.
      const parsed = Number(row?.setting ?? Number.NaN);
      const valueMs = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      return { name, valueMs, source: row?.source ?? "unknown" };
    };
    return {
      statementTimeout: read("statement_timeout"),
      idleInTransactionSessionTimeout: read("idle_in_transaction_session_timeout"),
      lockTimeout: read("lock_timeout"),
    };
  } finally {
    await sql.end();
  }
}

/** One-line, log-friendly rendering of {@link readInheritedTimeoutSettings}. */
export function formatInheritedTimeoutSettings(settings: InheritedTimeoutSettings): string {
  return [
    settings.statementTimeout,
    settings.idleInTransactionSessionTimeout,
    settings.lockTimeout,
  ]
    .map(({ name, valueMs, source }) =>
      `${name}=${valueMs === null ? "disabled" : `${valueMs}ms`} (source=${source})`,
    )
    .join(", ");
}

export function createDbFromPostgresClient(sql: Sql) {
  return drizzlePg(sql, { schema });
}

export async function getPostgresDataDirectory(url: string): Promise<string | null> {
  const sql = createUtilitySql(url);
  try {
    const rows = await sql<{ data_directory: string | null }[]>`
      SELECT current_setting('data_directory', true) AS data_directory
    `;
    const actual = rows[0]?.data_directory;
    return typeof actual === "string" && actual.length > 0 ? actual : null;
  } catch {
    return null;
  } finally {
    await sql.end();
  }
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_FOLDER, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

type MigrationJournalFile = {
  entries?: Array<{ idx?: number; tag?: string; when?: number }>;
};

type JournalMigrationEntry = {
  fileName: string;
  folderMillis: number;
  order: number;
};

async function listJournalMigrationEntries(): Promise<JournalMigrationEntry[]> {
  try {
    const raw = await readFile(MIGRATIONS_JOURNAL_JSON, "utf8");
    const parsed = JSON.parse(raw) as MigrationJournalFile;
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .map((entry, entryIndex) => {
        if (typeof entry?.tag !== "string") return null;
        if (typeof entry?.when !== "number" || !Number.isFinite(entry.when)) return null;
        const order = Number.isInteger(entry.idx) ? Number(entry.idx) : entryIndex;
        return { fileName: `${entry.tag}.sql`, folderMillis: entry.when, order };
      })
      .filter((entry): entry is JournalMigrationEntry => entry !== null);
  } catch {
    return [];
  }
}

async function listJournalMigrationFiles(): Promise<string[]> {
  const entries = await listJournalMigrationEntries();
  return entries.map((entry) => entry.fileName);
}

async function readMigrationFileContent(migrationFile: string): Promise<string> {
  return readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
}

async function orderMigrationsByJournal(migrationFiles: string[]): Promise<string[]> {
  const journalEntries = await listJournalMigrationEntries();
  const orderByFileName = new Map(journalEntries.map((entry) => [entry.fileName, entry.order]));
  return [...migrationFiles].sort((left, right) => {
    const leftOrder = orderByFileName.get(left);
    const rightOrder = orderByFileName.get(right);
    if (leftOrder === undefined && rightOrder === undefined) return left.localeCompare(right);
    if (leftOrder === undefined) return 1;
    if (rightOrder === undefined) return -1;
    if (leftOrder === rightOrder) return left.localeCompare(right);
    return leftOrder - rightOrder;
  });
}

type SqlExecutor = Pick<ReturnType<typeof postgres>, "unsafe">;

async function runInTransaction(sql: SqlExecutor, action: () => Promise<void>): Promise<void> {
  await sql.unsafe("BEGIN");
  try {
    await action();
    await sql.unsafe("COMMIT");
  } catch (error) {
    try {
      await sql.unsafe("ROLLBACK");
    } catch {
      // Ignore rollback failures and surface the original error.
    }
    throw error;
  }
}

async function latestMigrationCreatedAt(
  sql: SqlExecutor,
  qualifiedTable: string,
): Promise<number | null> {
  const rows = await sql.unsafe<{ created_at: string | number | null }[]>(
    `SELECT created_at FROM ${qualifiedTable} ORDER BY created_at DESC NULLS LAST LIMIT 1`,
  );
  const value = Number(rows[0]?.created_at ?? Number.NaN);
  return Number.isFinite(value) ? value : null;
}

function normalizeFolderMillis(value: number | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return Date.now();
}

async function ensureMigrationJournalTable(
  sql: ReturnType<typeof postgres>,
): Promise<{ migrationTableSchema: string; columnNames: Set<string> }> {
  let migrationTableSchema = await discoverMigrationTableSchema(sql);
  if (!migrationTableSchema) {
    const drizzleSchema = quoteIdentifier("drizzle");
    const migrationTable = quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE);
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${drizzleSchema}`);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${drizzleSchema}.${migrationTable} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    );
    migrationTableSchema = (await discoverMigrationTableSchema(sql)) ?? "drizzle";
  }

  const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);
  return { migrationTableSchema, columnNames };
}

async function migrationHistoryEntryExists(
  sql: SqlExecutor,
  qualifiedTable: string,
  columnNames: Set<string>,
  migrationFile: string,
  hash: string,
): Promise<boolean> {
  const predicates: string[] = [];
  if (columnNames.has("hash")) predicates.push(`hash = ${quoteLiteral(hash)}`);
  if (columnNames.has("name")) predicates.push(`name = ${quoteLiteral(migrationFile)}`);
  if (predicates.length === 0) return false;

  const rows = await sql.unsafe<{ one: number }[]>(
    `SELECT 1 AS one FROM ${qualifiedTable} WHERE ${predicates.join(" OR ")} LIMIT 1`,
  );
  return rows.length > 0;
}

async function recordMigrationHistoryEntry(
  sql: SqlExecutor,
  qualifiedTable: string,
  columnNames: Set<string>,
  migrationFile: string,
  hash: string,
  folderMillis: number,
): Promise<void> {
  const insertColumns: string[] = [];
  const insertValues: string[] = [];

  if (columnNames.has("hash")) {
    insertColumns.push(quoteIdentifier("hash"));
    insertValues.push(quoteLiteral(hash));
  }
  if (columnNames.has("name")) {
    insertColumns.push(quoteIdentifier("name"));
    insertValues.push(quoteLiteral(migrationFile));
  }
  if (columnNames.has("created_at")) {
    const latestCreatedAt = await latestMigrationCreatedAt(sql, qualifiedTable);
    const createdAt = latestCreatedAt === null
      ? normalizeFolderMillis(folderMillis)
      : Math.max(latestCreatedAt + 1, normalizeFolderMillis(folderMillis));
    insertColumns.push(quoteIdentifier("created_at"));
    insertValues.push(quoteLiteral(String(createdAt)));
  }

  if (insertColumns.length === 0) return;

  await sql.unsafe(
    `INSERT INTO ${qualifiedTable} (${insertColumns.join(", ")}) VALUES (${insertValues.join(", ")})`,
  );
}

async function applyPendingMigrationsManually(
  url: string,
  pendingMigrations: string[],
  options: ApplyPendingMigrationsOptions = {},
): Promise<void> {
  if (pendingMigrations.length === 0) return;

  const orderedPendingMigrations = await orderMigrationsByJournal(pendingMigrations);
  const journalEntries = await listJournalMigrationEntries();
  const folderMillisByFileName = new Map(
    journalEntries.map((entry) => [entry.fileName, normalizeFolderMillis(entry.folderMillis)]),
  );

  const sql = createUtilitySql(url);
  try {
    const { migrationTableSchema, columnNames } = await ensureMigrationJournalTable(sql);
    const qualifiedTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;

    for (const migrationFile of orderedPendingMigrations) {
      const migrationContent = await readMigrationFileContent(migrationFile);
      const hash = createHash("sha256").update(migrationContent).digest("hex");
      const existingEntry = await migrationHistoryEntryExists(
        sql,
        qualifiedTable,
        columnNames,
        migrationFile,
        hash,
      );
      if (existingEntry) continue;

      if (options.prepareOnlineIndexes) {
        await ensureConcurrentIndexesForMigration(url, migrationFile, {
          log: options.log,
        });
      }

      await runInTransaction(sql, async () => {
        for (const statement of splitMigrationStatements(migrationContent)) {
          // Use savepoints so a single "already exists" error doesn't abort the transaction.
          const savepointName = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          await sql.unsafe(`SAVEPOINT ${savepointName}`);
          try {
            await sql.unsafe(statement);
            await sql.unsafe(`RELEASE SAVEPOINT ${savepointName}`);
          } catch (error: unknown) {
            const pgError = error as { code?: string };
            // PostgreSQL error codes for "already applied" scenarios:
            // 42P07 = duplicate_table, 42701 = duplicate_column, 42710 = duplicate_object,
            // 42703 = undefined_column (DROP COLUMN on already-dropped column),
            // 42P01 = undefined_table (operations on already-dropped table)
            if (pgError.code === "42P07" || pgError.code === "42701" || pgError.code === "42710" || pgError.code === "42703" || pgError.code === "42P01") {
              await sql.unsafe(`ROLLBACK TO SAVEPOINT ${savepointName}`);
              await sql.unsafe(`RELEASE SAVEPOINT ${savepointName}`);
              continue;
            }
            throw error;
          }
        }

        await recordMigrationHistoryEntry(
          sql,
          qualifiedTable,
          columnNames,
          migrationFile,
          hash,
          folderMillisByFileName.get(migrationFile) ?? Date.now(),
        );
      });
    }
  } finally {
    await sql.end();
  }
}

async function mapHashesToMigrationFiles(migrationFiles: string[]): Promise<Map<string, string>> {
  const mapped = new Map<string, string>();

  await Promise.all(
    migrationFiles.map(async (migrationFile) => {
      const content = await readMigrationFileContent(migrationFile);
      const hash = createHash("sha256").update(content).digest("hex");
      mapped.set(hash, migrationFile);
    }),
  );

  return mapped;
}

async function getMigrationTableColumnNames(
  sql: ReturnType<typeof postgres>,
  migrationTableSchema: string,
): Promise<Set<string>> {
  const columns = await sql.unsafe<{ column_name: string }[]>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = ${quoteLiteral(migrationTableSchema)}
        AND table_name = ${quoteLiteral(DRIZZLE_MIGRATIONS_TABLE)}
    `,
  );
  return new Set(columns.map((column) => column.column_name));
}

async function tableExists(
  sql: ReturnType<typeof postgres>,
  tableName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function columnExists(
  sql: ReturnType<typeof postgres>,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
        AND column_name = ${columnName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function indexExists(
  sql: ReturnType<typeof postgres>,
  indexName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'i'
        AND c.relname = ${indexName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function constraintExists(
  sql: ReturnType<typeof postgres>,
  constraintName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public'
        AND c.conname = ${constraintName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function migrationStatementAlreadyApplied(
  sql: ReturnType<typeof postgres>,
  statement: string,
): Promise<boolean> {
  const normalized = statement.replace(/\s+/g, " ").trim();

  const createTableMatch = normalized.match(/^CREATE TABLE(?: IF NOT EXISTS)? "([^"]+)"/i);
  if (createTableMatch) {
    return tableExists(sql, createTableMatch[1]);
  }

  const addColumnMatch = normalized.match(
    /^ALTER TABLE "([^"]+)" ADD COLUMN(?: IF NOT EXISTS)? "([^"]+)"/i,
  );
  if (addColumnMatch) {
    return columnExists(sql, addColumnMatch[1], addColumnMatch[2]);
  }

  const createIndexMatch = normalized.match(/^CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? "([^"]+)"/i);
  if (createIndexMatch) {
    return indexExists(sql, createIndexMatch[1]);
  }

  const addConstraintMatch = normalized.match(/^ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)"/i);
  if (addConstraintMatch) {
    return constraintExists(sql, addConstraintMatch[2]);
  }

  // ALTER TABLE ... ALTER COLUMN (SET DEFAULT, SET NOT NULL, DROP NOT NULL, SET DATA TYPE, DROP DEFAULT)
  const alterColumnMatch = normalized.match(/^ALTER TABLE "([^"]+)" ALTER COLUMN "([^"]+)"/i);
  if (alterColumnMatch) {
    return columnExists(sql, alterColumnMatch[1], alterColumnMatch[2]);
  }

  // ALTER TABLE ... DROP COLUMN
  const dropColumnMatch = normalized.match(/^ALTER TABLE "([^"]+)" DROP COLUMN(?: IF EXISTS)? "([^"]+)"/i);
  if (dropColumnMatch) {
    // If the column doesn't exist, the drop was already applied
    const exists = await columnExists(sql, dropColumnMatch[1], dropColumnMatch[2]);
    return !exists;
  }

  // DROP INDEX
  const dropIndexMatch = normalized.match(/^DROP INDEX(?: IF EXISTS)? "([^"]+)"/i);
  if (dropIndexMatch) {
    // If the index doesn't exist, the drop was already applied (or never needed)
    const exists = await indexExists(sql, dropIndexMatch[1]);
    return !exists;
  }

  // If we cannot reason about a statement safely, require manual migration.
  return false;
}

async function migrationContentAlreadyApplied(
  sql: ReturnType<typeof postgres>,
  migrationContent: string,
): Promise<boolean> {
  const statements = splitMigrationStatements(migrationContent);
  if (statements.length === 0) return false;

  for (const statement of statements) {
    const applied = await migrationStatementAlreadyApplied(sql, statement);
    if (!applied) return false;
  }

  return true;
}

async function loadAppliedMigrations(
  sql: ReturnType<typeof postgres>,
  migrationTableSchema: string,
  availableMigrations: string[],
): Promise<string[]> {
  const quotedSchema = quoteIdentifier(migrationTableSchema);
  const qualifiedTable = `${quotedSchema}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;
  const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);

  if (columnNames.has("name")) {
    const rows = await sql.unsafe<{ name: string }[]>(`SELECT name FROM ${qualifiedTable} ORDER BY id`);
    return rows.map((row) => row.name).filter((name): name is string => Boolean(name));
  }

  if (columnNames.has("hash")) {
    const rows = await sql.unsafe<{ hash: string }[]>(`SELECT hash FROM ${qualifiedTable} ORDER BY id`);
    const hashesToMigrationFiles = await mapHashesToMigrationFiles(availableMigrations);
    const appliedFromHashes = rows
      .map((row) => hashesToMigrationFiles.get(row.hash))
      .filter((name): name is string => Boolean(name));

    if (appliedFromHashes.length > 0) {
      // Best-effort: when all hashes resolve, this is authoritative.
      if (appliedFromHashes.length === rows.length) return appliedFromHashes;

      // Partial hash resolution can happen when files have changed; return what we can trust.
      return appliedFromHashes;
    }

    // Fallback only when hashes are unavailable/unresolved.
    if (columnNames.has("created_at")) {
      const journalEntries = await listJournalMigrationEntries();
      if (journalEntries.length > 0) {
        const lastDbRows = await sql.unsafe<{ created_at: string | number | null }[]>(
          `SELECT created_at FROM ${qualifiedTable} ORDER BY created_at DESC LIMIT 1`,
        );
        const lastCreatedAt = Number(lastDbRows[0]?.created_at ?? -1);
        if (Number.isFinite(lastCreatedAt) && lastCreatedAt >= 0) {
          return journalEntries
            .filter((entry) => availableMigrations.includes(entry.fileName))
            .filter((entry) => entry.folderMillis <= lastCreatedAt)
            .map((entry) => entry.fileName)
            .slice(0, rows.length);
        }
      }
    }
  }

  const rows = await sql.unsafe<{ id: number }[]>(`SELECT id FROM ${qualifiedTable} ORDER BY id`);
  const journalMigrationFiles = await listJournalMigrationFiles();
  const appliedFromIds = rows
    .map((row) => journalMigrationFiles[row.id - 1])
    .filter((name): name is string => Boolean(name));
  if (appliedFromIds.length > 0) return appliedFromIds;

  return availableMigrations.slice(0, Math.max(0, rows.length));
}

export type MigrationHistoryReconcileResult = {
  repairedMigrations: string[];
  remainingMigrations: string[];
};

export async function reconcilePendingMigrationHistory(
  url: string,
): Promise<MigrationHistoryReconcileResult> {
  const state = await inspectMigrations(url);
  if (state.status !== "needsMigrations" || state.reason !== "pending-migrations") {
    return { repairedMigrations: [], remainingMigrations: [] };
  }

  const sql = createUtilitySql(url);
  const repairedMigrations: string[] = [];

  try {
    const journalEntries = await listJournalMigrationEntries();
    const folderMillisByFile = new Map(journalEntries.map((entry) => [entry.fileName, entry.folderMillis]));
    const migrationTableSchema = await discoverMigrationTableSchema(sql);
    if (!migrationTableSchema) {
      return { repairedMigrations, remainingMigrations: state.pendingMigrations };
    }

    const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);
    const qualifiedTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;

    for (const migrationFile of state.pendingMigrations) {
      const migrationContent = await readMigrationFileContent(migrationFile);
      const alreadyApplied = await migrationContentAlreadyApplied(sql, migrationContent);
      if (!alreadyApplied) break;

      const hash = createHash("sha256").update(migrationContent).digest("hex");
      const folderMillis = folderMillisByFile.get(migrationFile) ?? Date.now();
      const existingByHash = columnNames.has("hash")
        ? await sql.unsafe<{ created_at: string | number | null }[]>(
            `SELECT created_at FROM ${qualifiedTable} WHERE hash = ${quoteLiteral(hash)} ORDER BY created_at DESC LIMIT 1`,
          )
        : [];
      const existingByName = columnNames.has("name")
        ? await sql.unsafe<{ created_at: string | number | null }[]>(
            `SELECT created_at FROM ${qualifiedTable} WHERE name = ${quoteLiteral(migrationFile)} ORDER BY created_at DESC LIMIT 1`,
          )
        : [];
      if (existingByHash.length > 0 || existingByName.length > 0) {
        if (columnNames.has("created_at")) {
          const existingHashCreatedAt = Number(existingByHash[0]?.created_at ?? -1);
          if (existingByHash.length > 0 && Number.isFinite(existingHashCreatedAt) && existingHashCreatedAt < folderMillis) {
            await sql.unsafe(
              `UPDATE ${qualifiedTable} SET created_at = ${quoteLiteral(String(folderMillis))} WHERE hash = ${quoteLiteral(hash)} AND created_at < ${quoteLiteral(String(folderMillis))}`,
            );
          }

          const existingNameCreatedAt = Number(existingByName[0]?.created_at ?? -1);
          if (existingByName.length > 0 && Number.isFinite(existingNameCreatedAt) && existingNameCreatedAt < folderMillis) {
            await sql.unsafe(
              `UPDATE ${qualifiedTable} SET created_at = ${quoteLiteral(String(folderMillis))} WHERE name = ${quoteLiteral(migrationFile)} AND created_at < ${quoteLiteral(String(folderMillis))}`,
            );
          }
        }

        repairedMigrations.push(migrationFile);
        continue;
      }

      const insertColumns: string[] = [];
      const insertValues: string[] = [];

      if (columnNames.has("hash")) {
        insertColumns.push(quoteIdentifier("hash"));
        insertValues.push(quoteLiteral(hash));
      }
      if (columnNames.has("name")) {
        insertColumns.push(quoteIdentifier("name"));
        insertValues.push(quoteLiteral(migrationFile));
      }
      if (columnNames.has("created_at")) {
        insertColumns.push(quoteIdentifier("created_at"));
        insertValues.push(quoteLiteral(String(folderMillis)));
      }

      if (insertColumns.length === 0) break;

      await sql.unsafe(
        `INSERT INTO ${qualifiedTable} (${insertColumns.join(", ")}) VALUES (${insertValues.join(", ")})`,
      );
      repairedMigrations.push(migrationFile);
    }
  } finally {
    await sql.end();
  }

  const refreshed = await inspectMigrations(url);
  return {
    repairedMigrations,
    remainingMigrations:
      refreshed.status === "needsMigrations" ? refreshed.pendingMigrations : [],
  };
}

async function discoverMigrationTableSchema(sql: ReturnType<typeof postgres>): Promise<string | null> {
  const rows = await sql<{ schemaName: string }[]>`
    SELECT n.nspname AS "schemaName"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = ${DRIZZLE_MIGRATIONS_TABLE} AND c.relkind = 'r'
  `;

  if (rows.length === 0) return null;

  const drizzleSchema = rows.find(({ schemaName }) => schemaName === "drizzle");
  if (drizzleSchema) return drizzleSchema.schemaName;

  const publicSchema = rows.find(({ schemaName }) => schemaName === "public");
  if (publicSchema) return publicSchema.schemaName;

  return rows[0]?.schemaName ?? null;
}

export async function inspectMigrations(url: string): Promise<MigrationState> {
  const sql = createUtilitySql(url);

  try {
    const availableMigrations = await listMigrationFiles();
    const tableCountResult = await sql<{ count: number }[]>`
      select count(*)::int as count
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
    `;
    const tableCount = tableCountResult[0]?.count ?? 0;

    const migrationTableSchema = await discoverMigrationTableSchema(sql);
    if (!migrationTableSchema) {
      if (tableCount > 0) {
        return {
          status: "needsMigrations",
          tableCount,
          availableMigrations,
          appliedMigrations: [],
          pendingMigrations: availableMigrations,
          reason: "no-migration-journal-non-empty-db",
        };
      }

      return {
        status: "needsMigrations",
        tableCount,
        availableMigrations,
        appliedMigrations: [],
        pendingMigrations: availableMigrations,
        reason: "no-migration-journal-empty-db",
      };
    }

    const appliedMigrations = await loadAppliedMigrations(sql, migrationTableSchema, availableMigrations);
    const pendingMigrations = availableMigrations.filter((name) => !appliedMigrations.includes(name));
    if (pendingMigrations.length === 0) {
      return {
        status: "upToDate",
        tableCount,
        availableMigrations,
        appliedMigrations,
      };
    }

    return {
      status: "needsMigrations",
      tableCount,
      availableMigrations,
      appliedMigrations,
      pendingMigrations,
      reason: "pending-migrations",
    };
  } finally {
    await sql.end();
  }
}

export async function applyPendingMigrations(
  url: string,
  options: ApplyPendingMigrationsOptions = {},
): Promise<void> {
  const initialState = await inspectMigrations(url);
  if (initialState.status === "upToDate") return;

  if (initialState.reason === "no-migration-journal-empty-db") {
    const sql = createUtilitySql(url);
    try {
      const db = drizzlePg(sql);
      await migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await sql.end();
    }

    let bootstrappedState = await inspectMigrations(url);
    if (bootstrappedState.status === "upToDate") return;
    if (bootstrappedState.reason === "pending-migrations") {
      const repair = await reconcilePendingMigrationHistory(url);
      if (repair.repairedMigrations.length > 0) {
        bootstrappedState = await inspectMigrations(url);
      }
      if (bootstrappedState.status === "needsMigrations" && bootstrappedState.reason === "pending-migrations") {
        await applyPendingMigrationsManually(url, bootstrappedState.pendingMigrations, options);
        bootstrappedState = await inspectMigrations(url);
      }
    }
    if (bootstrappedState.status === "upToDate") return;
    throw new Error(
      `Failed to bootstrap migrations: ${bootstrappedState.pendingMigrations.join(", ")}`,
    );
  }

  if (initialState.reason === "no-migration-journal-non-empty-db") {
    // Create the migration journal table so reconciliation and migration can proceed.
    const bootstrapSql = createUtilitySql(url);
    try {
      await ensureMigrationJournalTable(bootstrapSql);
    } finally {
      await bootstrapSql.end();
    }
  }

  let state = await inspectMigrations(url);
  if (state.status === "upToDate") return;

  const repair = await reconcilePendingMigrationHistory(url);
  if (repair.repairedMigrations.length > 0) {
    state = await inspectMigrations(url);
    if (state.status === "upToDate") return;
  }

  if (state.status !== "needsMigrations" || state.reason !== "pending-migrations") {
    throw new Error("Migrations are still pending after migration-history reconciliation; run inspectMigrations for details.");
  }

  await applyPendingMigrationsManually(url, state.pendingMigrations, options);

  const finalState = await inspectMigrations(url);
  if (finalState.status !== "upToDate") {
    throw new Error(
      `Failed to apply pending migrations: ${finalState.pendingMigrations.join(", ")}`,
    );
  }
}

export type MigrationBootstrapResult =
  | { migrated: true; reason: "migrated-empty-db"; tableCount: 0 }
  | { migrated: false; reason: "already-migrated"; tableCount: number }
  | { migrated: false; reason: "not-empty-no-migration-journal"; tableCount: number };

export async function migratePostgresIfEmpty(url: string): Promise<MigrationBootstrapResult> {
  const sql = createUtilitySql(url);

  try {
    const migrationTableSchema = await discoverMigrationTableSchema(sql);

    const tableCountResult = await sql<{ count: number }[]>`
      select count(*)::int as count
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
    `;

    const tableCount = tableCountResult[0]?.count ?? 0;

    if (migrationTableSchema) {
      return { migrated: false, reason: "already-migrated", tableCount };
    }

    if (tableCount > 0) {
      return { migrated: false, reason: "not-empty-no-migration-journal", tableCount };
    }

    const db = drizzlePg(sql);
    await migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER });

    return { migrated: true, reason: "migrated-empty-db", tableCount: 0 };
  } finally {
    await sql.end();
  }
}

export async function ensurePostgresDatabase(
  url: string,
  databaseName: string,
): Promise<"created" | "exists"> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(databaseName)) {
    throw new Error(`Unsafe database name: ${databaseName}`);
  }

  const sql = createUtilitySql(url);
  try {
    const existing = await sql<{ one: number }[]>`
      select 1 as one from pg_database where datname = ${databaseName} limit 1
    `;
    if (existing.length > 0) return "exists";

    await sql.unsafe(`create database "${databaseName}" encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0`);
    return "created";
  } finally {
    await sql.end();
  }
}

export async function resetPostgresDatabase(
  url: string,
  databaseName: string,
): Promise<"reset"> {
  const quotedDatabaseName = quoteIdentifier(databaseName);
  const sql = createUtilitySql(url);
  try {
    await sql`
      select pg_terminate_backend(pid)
      from pg_stat_activity
      where datname = ${databaseName}
        and pid <> pg_backend_pid()
    `;
    await sql.unsafe(`drop database if exists ${quotedDatabaseName}`);
    await sql.unsafe(`create database ${quotedDatabaseName} encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0`);
    return "reset";
  } finally {
    await sql.end();
  }
}

export type Db = ReturnType<typeof createDb>;

/**
 * The open transaction handle drizzle hands to a `db.transaction(...)` callback.
 * Split across two aliases so the one-line nested-`Parameters` incantation this
 * type replaces appears nowhere in the tree (BLO-34656).
 */
type DbTransactionCallback = Parameters<Db["transaction"]>[0];
export type DbTransaction = Parameters<DbTransactionCallback>[0];

import postgres from "postgres";

export type ConcurrentIndexSpec = {
  readonly migration: string;
  readonly name: string;
  readonly table: string;
  readonly requiredColumns: readonly string[];
  readonly accessMethod: string;
  /** Values returned by pg_get_indexdef(index_oid, key_position, true). */
  readonly keyColumns: readonly string[];
  /** pg_index.indoption values; 0 = ASC NULLS LAST, 3 = DESC NULLS FIRST. */
  readonly keyOptions: readonly number[];
  /** Value returned by pg_get_expr(indpred, indrelid, true). */
  readonly predicate: string;
  readonly createStatement: string;
  readonly dropStatement: string;
};

export type ConcurrentIndexEnsureAction = "already-valid" | "created" | "rebuilt";

export type ConcurrentIndexEnsureResult = {
  readonly migration: string;
  readonly name: string;
  readonly table: string;
  readonly action: ConcurrentIndexEnsureAction;
};

/**
 * Every migration that requires an online index on a populated heartbeat_runs
 * table. Keep these definitions in sync with the structural guards in the SQL
 * files. The migration runner invokes the matching entry immediately before
 * each file, after earlier files have committed prerequisite columns.
 */
export const PENDING_CONCURRENT_INDEXES: readonly ConcurrentIndexSpec[] = [
  {
    migration: "0205_heartbeat_runs_company_finished_at_index.sql",
    name: "heartbeat_runs_company_finished_at_desc_idx",
    table: "heartbeat_runs",
    requiredColumns: ["company_id", "finished_at", "id"],
    accessMethod: "btree",
    keyColumns: ["company_id", "finished_at", "id"],
    keyOptions: [0, 3, 3],
    predicate: "finished_at IS NOT NULL",
    createStatement:
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_company_finished_at_desc_idx "
      + "ON heartbeat_runs USING btree (company_id, finished_at DESC, id DESC) "
      + "WHERE finished_at IS NOT NULL",
    dropStatement: "DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_company_finished_at_desc_idx",
  },
  {
    migration: "0208_heartbeat_runs_agent_dispatch_index.sql",
    name: "heartbeat_runs_agent_dispatch_idx",
    table: "heartbeat_runs",
    requiredColumns: ["agent_id", "status", "created_at", "id"],
    accessMethod: "btree",
    keyColumns: ["agent_id", "status", "created_at", "id"],
    keyOptions: [0, 0, 0, 0],
    predicate: "status = ANY (ARRAY['queued'::text, 'scheduled_retry'::text])",
    createStatement:
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_agent_dispatch_idx "
      + "ON heartbeat_runs USING btree (agent_id, status, created_at, id) "
      + "WHERE status IN ('queued', 'scheduled_retry')",
    dropStatement: "DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_agent_dispatch_idx",
  },
  {
    migration: "0209_heartbeat_runs_recovery_dispatch_index.sql",
    name: "heartbeat_runs_recovery_dispatch_idx",
    table: "heartbeat_runs",
    requiredColumns: ["agent_id", "created_at", "id", "status", "context_snapshot"],
    accessMethod: "btree",
    keyColumns: ["agent_id", "created_at", "id"],
    keyOptions: [0, 0, 0],
    predicate:
      "status = 'queued'::text AND (context_snapshot ->> 'source'::text) = 'issue_recovery_action'::text "
      + "AND (context_snapshot ->> 'recoveryActionId'::text) IS NOT NULL",
    createStatement:
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_recovery_dispatch_idx "
      + "ON heartbeat_runs USING btree (agent_id, created_at, id) "
      + "WHERE status = 'queued' AND (context_snapshot ->> 'source') = 'issue_recovery_action' "
      + "AND (context_snapshot ->> 'recoveryActionId') IS NOT NULL",
    dropStatement: "DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_recovery_dispatch_idx",
  },
  {
    migration: "0217_heartbeat_runs_queued_age_idx.sql",
    name: "heartbeat_runs_queued_age_idx",
    table: "heartbeat_runs",
    requiredColumns: ["agent_id", "queued_at", "created_at", "status"],
    accessMethod: "btree",
    keyColumns: ["agent_id", "COALESCE(queued_at, created_at)"],
    keyOptions: [0, 0],
    predicate: "status = 'queued'::text",
    createStatement:
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_queued_age_idx "
      + "ON heartbeat_runs USING btree (agent_id, (coalesce(queued_at, created_at))) "
      + "WHERE status = 'queued'",
    dropStatement: "DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_queued_age_idx",
  },
  {
    migration: "0224_heartbeat_runs_overdue_scheduled_retry_index.sql",
    name: "heartbeat_runs_overdue_scheduled_retry_idx",
    table: "heartbeat_runs",
    requiredColumns: ["agent_id", "scheduled_retry_at", "status"],
    accessMethod: "btree",
    keyColumns: ["agent_id", "scheduled_retry_at"],
    keyOptions: [0, 0],
    predicate: "status = 'scheduled_retry'::text",
    createStatement:
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_overdue_scheduled_retry_idx "
      + "ON heartbeat_runs USING btree (agent_id, scheduled_retry_at) "
      + "WHERE status = 'scheduled_retry'",
    dropStatement: "DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_overdue_scheduled_retry_idx",
  },
  {
    migration: "0226_heartbeat_runs_crash_recovery_index.sql",
    name: "heartbeat_runs_crash_recovery_pending_idx",
    table: "heartbeat_runs",
    requiredColumns: ["finished_at", "id", "error_code", "crash_recovery_completed_at"],
    accessMethod: "btree",
    keyColumns: ["finished_at", "id"],
    keyOptions: [0, 0],
    predicate: "error_code = 'worker_crashed'::text AND crash_recovery_completed_at IS NULL",
    createStatement:
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_crash_recovery_pending_idx "
      + "ON heartbeat_runs USING btree (finished_at, id) "
      + "WHERE error_code = 'worker_crashed' AND crash_recovery_completed_at IS NULL",
    dropStatement: "DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_crash_recovery_pending_idx",
  },
  {
    migration: "0230_heartbeat_runs_retry_successor_index.sql",
    name: "heartbeat_runs_retry_successor_idx",
    table: "heartbeat_runs",
    requiredColumns: ["retry_of_run_id", "created_at"],
    accessMethod: "btree",
    keyColumns: ["retry_of_run_id", "created_at"],
    keyOptions: [0, 0],
    predicate: "retry_of_run_id IS NOT NULL",
    createStatement:
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_retry_successor_idx "
      + "ON heartbeat_runs USING btree (retry_of_run_id, created_at) "
      + "WHERE retry_of_run_id IS NOT NULL",
    dropStatement: "DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_retry_successor_idx",
  },
];

const DEFAULT_STATEMENT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_DDL_LOCK_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
const LOCK_POLL_INTERVAL_MS = 250;

export const SERIALIZING_LOCK_KEY = "paperclip:concurrent-index-guard";

export type EnsurePendingConcurrentIndexesOptions = {
  readonly statementTimeoutMs?: number;
  readonly ddlLockTimeoutMs?: number;
  readonly lockWaitTimeoutMs?: number;
  readonly specs?: readonly ConcurrentIndexSpec[];
  readonly skipUnavailable?: boolean;
  readonly log?: (message: string) => void;
};

export type EnsureConcurrentIndexesForMigrationOptions = Omit<
  EnsurePendingConcurrentIndexesOptions,
  "specs"
>;

type IndexState = "absent" | "build-incomplete" | "wrong-definition" | "valid";

type IndexMetadata = {
  indisvalid: boolean;
  indisready: boolean;
  indisunique: boolean;
  indisprimary: boolean;
  table_schema: string;
  table_name: string;
  access_method: string;
  indnkeyatts: number;
  indnatts: number;
  key_columns: string[];
  key_options: string;
  predicate: string | null;
};

function normalizeSql(value: string | null): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function missingPrerequisites(
  sql: ReturnType<typeof postgres>,
  spec: ConcurrentIndexSpec,
): Promise<{ tableMissing: boolean; columns: string[] }> {
  const rows = await sql<{ table_name: string; column_name: string | null }[]>`
    SELECT tables.table_name, columns.column_name
    FROM information_schema.tables AS tables
    LEFT JOIN information_schema.columns AS columns
      ON columns.table_schema = tables.table_schema
     AND columns.table_name = tables.table_name
    WHERE tables.table_schema = 'public'
      AND tables.table_type = 'BASE TABLE'
      AND tables.table_name = ${spec.table}
  `;
  if (rows.length === 0) return { tableMissing: true, columns: [...spec.requiredColumns] };

  const available = new Set(rows.flatMap((row) => row.column_name ? [row.column_name] : []));
  return {
    tableMissing: false,
    columns: spec.requiredColumns.filter((column) => !available.has(column)),
  };
}

async function indexValidity(
  sql: ReturnType<typeof postgres>,
  spec: ConcurrentIndexSpec,
): Promise<IndexState> {
  const rows = await sql<IndexMetadata[]>`
    SELECT
      index_metadata.indisvalid,
      index_metadata.indisready,
      index_metadata.indisunique,
      index_metadata.indisprimary,
      table_namespace.nspname AS table_schema,
      table_relation.relname AS table_name,
      access_method.amname AS access_method,
      index_metadata.indnkeyatts,
      index_metadata.indnatts,
      ARRAY(
        SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
        FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
        ORDER BY key_position
      ) AS key_columns,
      index_metadata.indoption::text AS key_options,
      pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE) AS predicate
    FROM pg_index AS index_metadata
    JOIN pg_class AS index_relation ON index_relation.oid = index_metadata.indexrelid
    JOIN pg_class AS table_relation ON table_relation.oid = index_metadata.indrelid
    JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_relation.relnamespace
    JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
    WHERE index_metadata.indexrelid = to_regclass(${`public.${spec.name}`})
  `;
  if (rows.length === 0) return "absent";

  const row = rows[0]!;
  if (!row.indisvalid || !row.indisready) return "build-incomplete";

  const keyOptions = row.key_options.trim().length === 0
    ? []
    : row.key_options.trim().split(/\s+/).map(Number);
  const structurallyValid =
    !row.indisunique
    && !row.indisprimary
    && row.table_schema === "public"
    && row.table_name === spec.table
    && row.access_method === spec.accessMethod
    && row.indnkeyatts === spec.keyColumns.length
    && row.indnatts === spec.keyColumns.length
    && arraysEqual(row.key_columns.map(normalizeSql), spec.keyColumns.map(normalizeSql))
    && arraysEqual(keyOptions, spec.keyOptions)
    && normalizeSql(row.predicate) === normalizeSql(spec.predicate);
  return structurallyValid ? "valid" : "wrong-definition";
}

async function acquireSerializingLock(sql: ReturnType<typeof postgres>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ locked }] = await sql<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtextextended(${SERIALIZING_LOCK_KEY}, 0)) AS locked
    `;
    if (locked) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for another concurrent-index builder to release `
        + `the advisory lock "${SERIALIZING_LOCK_KEY}".`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
  }
}

async function releaseSerializingLock(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`SELECT pg_advisory_unlock(hashtextextended(${SERIALIZING_LOCK_KEY}, 0))`;
}

/**
 * Ensure each requested index outside a transaction. Complete indexes with a
 * wrong definition fail closed; only absent or incomplete online builds are
 * created/rebuilt automatically.
 */
export async function ensurePendingConcurrentIndexes(
  connectionString: string,
  options: EnsurePendingConcurrentIndexesOptions = {},
): Promise<ConcurrentIndexEnsureResult[]> {
  const specs = options.specs ?? PENDING_CONCURRENT_INDEXES;
  if (specs.length === 0) return [];

  const statementTimeoutMs = Math.max(1, Math.trunc(options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS));
  const ddlLockTimeoutMs = Math.max(1, Math.trunc(options.ddlLockTimeoutMs ?? DEFAULT_DDL_LOCK_TIMEOUT_MS));
  const lockWaitTimeoutMs = Math.max(0, Math.trunc(options.lockWaitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS));
  const log = options.log ?? (() => {});
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  const results: ConcurrentIndexEnsureResult[] = [];
  let lockAcquired = false;

  try {
    await acquireSerializingLock(sql, lockWaitTimeoutMs);
    lockAcquired = true;
    await sql.unsafe(`SET statement_timeout = '${statementTimeoutMs}ms'`);
    await sql.unsafe(`SET lock_timeout = '${ddlLockTimeoutMs}ms'`);

    for (const spec of specs) {
      const missing = await missingPrerequisites(sql, spec);
      if (missing.tableMissing || missing.columns.length > 0) {
        const detail = missing.tableMissing
          ? `table public.${spec.table} does not exist`
          : `required columns are missing: ${missing.columns.join(", ")}`;
        if (options.skipUnavailable) {
          log(`${spec.migration}: skipping ${spec.name}; ${detail}`);
          continue;
        }
        throw new Error(`Cannot prepare ${spec.name} for ${spec.migration}: ${detail}.`);
      }

      const before = await indexValidity(sql, spec);
      if (before === "valid") {
        results.push({ migration: spec.migration, name: spec.name, table: spec.table, action: "already-valid" });
        continue;
      }
      if (before === "wrong-definition") {
        throw new Error(
          `Index ${spec.name} exists and is complete, but does not match ${spec.migration}'s table, access method, `
          + `key columns, sort options, or predicate. Inspect it before running: `
          + `${spec.dropStatement}; ${spec.createStatement}`,
        );
      }

      if (before === "build-incomplete") {
        log(`${spec.migration}: rebuilding incomplete index ${spec.name}`);
        await sql.unsafe(spec.dropStatement);
      } else {
        log(`${spec.migration}: creating ${spec.name} concurrently`);
      }
      await sql.unsafe(spec.createStatement);

      const after = await indexValidity(sql, spec);
      if (after !== "valid") {
        throw new Error(
          `Concurrent index ${spec.name} for ${spec.migration} is ${after} after its build completed.`,
        );
      }
      results.push({
        migration: spec.migration,
        name: spec.name,
        table: spec.table,
        action: before === "build-incomplete" ? "rebuilt" : "created",
      });
    }
  } finally {
    if (lockAcquired) {
      try {
        await sql.unsafe("SET statement_timeout = 0");
        await sql.unsafe("SET lock_timeout = 0");
      } finally {
        await releaseSerializingLock(sql);
      }
    }
    await sql.end();
  }

  return results;
}

export async function ensureConcurrentIndexesForMigration(
  connectionString: string,
  migration: string,
  options: EnsureConcurrentIndexesForMigrationOptions = {},
): Promise<ConcurrentIndexEnsureResult[]> {
  const specs = PENDING_CONCURRENT_INDEXES.filter((spec) => spec.migration === migration);
  return ensurePendingConcurrentIndexes(connectionString, { ...options, specs });
}

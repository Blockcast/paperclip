import postgres from "postgres";

export type ConcurrentIndexSpec = {
  readonly migration: string;
  readonly name: string;
  readonly table: string;
  readonly createStatement: string;
  readonly dropStatement: string;
};

export type ConcurrentIndexEnsureAction = "already-valid" | "created" | "rebuilt";

export type ConcurrentIndexEnsureResult = {
  readonly name: string;
  readonly table: string;
  readonly action: ConcurrentIndexEnsureAction;
};

/**
 * Deferred `CREATE INDEX CONCURRENTLY` migrations that decline to raise when
 * their index is absent on a populated database (BLO-21526). Migration 0212
 * (see its header) chose a `RAISE NOTICE`-and-continue over the raise-and-stall
 * pattern used elsewhere in this directory — deliberately, since raising there
 * would roll back 0211's `ADD COLUMN` in the same migration-file transaction —
 * and the production migration client suppresses notices
 * (`packages/db/src/client.ts`'s `onnotice: () => {}`), so nothing else ever
 * surfaces the gap or closes it. This module is that missing enforcement step:
 * called right after `applyPendingMigrations` succeeds, it builds any listed
 * index that is absent or invalid and throws if the online build itself does
 * not leave a valid index behind, so a skipped or failed build fails the
 * deploy visibly instead of silently.
 *
 * 0205, 0208, and 0209 are deliberately NOT listed here: each of those
 * migrations already RAISEs and stalls the migration itself when its index is
 * missing on a populated table (confirmed by reading each file — they all
 * follow the "IF to_regclass(...) IS NULL THEN ... RAISE EXCEPTION" shape),
 * so deploy-time absence already fails the migration step visibly without
 * this module's help. Add an entry here only for a migration that, like 0212,
 * chooses not to raise.
 */
export const PENDING_CONCURRENT_INDEXES: readonly ConcurrentIndexSpec[] = [
  {
    migration: "0212_heartbeat_runs_crash_recovery_index.sql",
    name: "heartbeat_runs_crash_recovery_pending_idx",
    table: "heartbeat_runs",
    createStatement:
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_crash_recovery_pending_idx " +
      "ON heartbeat_runs USING btree (finished_at, id) " +
      "WHERE error_code = 'worker_crashed' AND crash_recovery_completed_at IS NULL",
    dropStatement: "DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_crash_recovery_pending_idx",
  },
];

// Bounds how long a single online index build may run before this step fails
// the deploy outright. Without a bound, a stuck `CREATE INDEX CONCURRENTLY`
// (e.g. blocked behind a long-held lock) would hang whatever startup or CI
// step called this function with no visible signal at all — replacing one
// silent failure mode with another. 10 minutes is generous for the indexes
// listed above; override per call for a migration with different needs.
const DEFAULT_STATEMENT_TIMEOUT_MS = 10 * 60 * 1000;

export type EnsurePendingConcurrentIndexesOptions = {
  readonly statementTimeoutMs?: number;
  readonly specs?: readonly ConcurrentIndexSpec[];
};

// Mirrors the probe `crashRecoveryCandidateIndexPresent` (server/src/services/
// heartbeat.ts) uses to gate the periodic scan: both `indisvalid` and
// `indisready` are checked, not just existence, so a `CREATE INDEX
// CONCURRENTLY` left in its partially-built state (index created but not yet
// marked ready, or ready but never validated) reads as "invalid" here too and
// gets dropped and rebuilt rather than trusted.
async function indexValidity(
  sql: ReturnType<typeof postgres>,
  name: string,
): Promise<"absent" | "invalid" | "valid"> {
  const rows = await sql<{ indisvalid: boolean; indisready: boolean }[]>`
    select indisvalid, indisready
    from pg_index
    where indexrelid = to_regclass(${`public.${name}`})
  `;
  if (rows.length === 0) return "absent";
  return rows[0].indisvalid && rows[0].indisready ? "valid" : "invalid";
}

/**
 * Builds every listed deferred index that is absent or invalid on the target
 * database, verifying each with a catalog read (`pg_index.indisvalid`)
 * rather than trusting that the `CREATE INDEX CONCURRENTLY` statement ran to
 * completion. Must be called only after `applyPendingMigrations` has
 * succeeded, so the underlying table and predicate columns already exist.
 *
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, so this
 * opens its own single-connection client rather than reusing a pooled or
 * transactional one, and never wraps its statements in `sql.begin`.
 *
 * Idempotent and safe to call on every startup: an already-valid index is a
 * single indexed catalog lookup and nothing else.
 */
export async function ensurePendingConcurrentIndexes(
  connectionString: string,
  options: EnsurePendingConcurrentIndexesOptions = {},
): Promise<ConcurrentIndexEnsureResult[]> {
  const specs = options.specs ?? PENDING_CONCURRENT_INDEXES;
  if (specs.length === 0) return [];

  const timeoutMs = Math.max(0, Math.trunc(options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS));
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  const results: ConcurrentIndexEnsureResult[] = [];

  try {
    await sql.unsafe(`set statement_timeout = ${timeoutMs}`);

    for (const spec of specs) {
      const before = await indexValidity(sql, spec.name);

      if (before === "valid") {
        results.push({ name: spec.name, table: spec.table, action: "already-valid" });
        continue;
      }

      // An invalid index is the leftover of a CONCURRENTLY build that failed
      // partway (e.g. a conflicting constraint violation). Postgres will not
      // repair it in place; the only way forward is to drop and rebuild.
      if (before === "invalid") {
        await sql.unsafe(spec.dropStatement);
      }

      await sql.unsafe(spec.createStatement);

      const after = await indexValidity(sql, spec.name);
      if (after !== "valid") {
        throw new Error(
          `Deferred index ${spec.name} on ${spec.table} (from migration ${spec.migration}) is still ${after} ` +
            `after its online build ran. Investigate before continuing the deploy. Statement run: ${spec.createStatement}`,
        );
      }

      results.push({ name: spec.name, table: spec.table, action: before === "invalid" ? "rebuilt" : "created" });
    }
  } finally {
    await sql.end();
  }

  return results;
}

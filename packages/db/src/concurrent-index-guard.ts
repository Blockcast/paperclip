import postgres from "postgres";

export type ConcurrentIndexSpec = {
  readonly migration: string;
  readonly name: string;
  readonly table: string;
  readonly accessMethod: string;
  readonly keyColumns: readonly string[];
  readonly predicate: string;
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
 * `accessMethod`/`keyColumns`/`predicate` mirror the structural check 0212's
 * own `DO` block runs before trusting a same-named index (BLO-21526 review):
 * a valid, ready index by this name on the wrong table/columns/access
 * method/predicate is not the index this guard exists to guarantee, even
 * though `indisvalid`/`indisready` alone would call it "already-valid".
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
    accessMethod: "btree",
    keyColumns: ["finished_at", "id"],
    // Matches 0212's own paren- and whitespace-insensitive comparison target
    // exactly (see that migration's structural check) so the two validators
    // can't silently drift apart.
    predicate: "error_code = 'worker_crashed'::text AND crash_recovery_completed_at IS NULL",
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

// How long a caller will wait for another concurrent caller's serializing
// lock (below) before giving up. Deliberately larger than
// DEFAULT_STATEMENT_TIMEOUT_MS: a second replica in a healthy rolling deploy
// may have to wait out the *first* replica's full build, and bounding that
// wait by the same value as the build itself would time out the second
// replica just for being unlucky enough to start second.
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
const LOCK_POLL_INTERVAL_MS = 250;

// Session-scoped advisory lock key (`paperclip:` prefix matches the
// hashtextextended(key, 0) convention used elsewhere in this codebase, e.g.
// server/src/services/folders.ts, server/src/services/issues.ts). Deliberately
// a fixed, single key rather than one per spec/table: this guard's whole job
// is a short deploy-time step, not a high-concurrency resource, so
// serializing the entire call is simpler than fine-grained per-index locking
// and gives the same safety.
export const SERIALIZING_LOCK_KEY = "paperclip:concurrent-index-guard";

export type EnsurePendingConcurrentIndexesOptions = {
  readonly statementTimeoutMs?: number;
  readonly lockWaitTimeoutMs?: number;
  readonly specs?: readonly ConcurrentIndexSpec[];
};

type IndexState = "absent" | "build-incomplete" | "wrong-definition" | "valid";

// Mirrors the probe `crashRecoveryCandidateIndexPresent` (server/src/services/
// heartbeat.ts) uses to gate the periodic scan: both `indisvalid` and
// `indisready` are checked, not just existence. A `CREATE INDEX CONCURRENTLY`
// left in its partially-built state (index created but not yet marked ready,
// or ready but never validated) reads as "build-incomplete" here too and gets
// dropped and rebuilt rather than trusted — that state can only be a leftover
// of a build that never finished, since a *finished* build always leaves both
// flags true.
//
// A row with both flags true is structurally checked against `spec` (table,
// access method, key columns, and predicate — same shape 0212's own `DO`
// block checks) before being trusted as "valid": a same-named index on the
// wrong definition is not this guard's index, and unlike a genuine
// build-incomplete leftover it is not safe to silently drop and rebuild (it
// may be a legitimate index this check simply doesn't recognize), so it is
// reported as "wrong-definition" and the caller throws instead of acting on
// it automatically.
async function indexValidity(sql: ReturnType<typeof postgres>, spec: ConcurrentIndexSpec): Promise<IndexState> {
  const indoption = spec.keyColumns.map(() => "0").join(" ");
  const rows = await sql.unsafe<{ indisvalid: boolean; indisready: boolean; structurally_valid: boolean }[]>(`
    select
      index_metadata.indisvalid,
      index_metadata.indisready,
      (
        index_metadata.indrelid = '${spec.table}'::regclass
        and access_method.amname = '${spec.accessMethod}'
        and index_metadata.indnkeyatts = ${spec.keyColumns.length}
        and index_metadata.indnatts = ${spec.keyColumns.length}
        and array(
          select pg_get_indexdef(index_metadata.indexrelid, key_position, true)
          from generate_series(1, index_metadata.indnkeyatts) as key_position
          order by key_position
        ) = array[${spec.keyColumns.map((column) => `'${column}'`).join(", ")}]
        and index_metadata.indoption = '${indoption}'::int2vector
        and regexp_replace(
              translate(pg_get_expr(index_metadata.indpred, index_metadata.indrelid, true), '()', ''),
              '\\s+', ' ', 'g'
            ) = '${spec.predicate.replace(/'/g, "''")}'
      ) as structurally_valid
    from pg_index as index_metadata
    join pg_class as index_relation on index_relation.oid = index_metadata.indexrelid
    join pg_am as access_method on access_method.oid = index_relation.relam
    where index_metadata.indexrelid = to_regclass('public.${spec.name}')
  `);
  if (rows.length === 0) return "absent";
  const [{ indisvalid, indisready, structurally_valid: structurallyValid }] = rows;
  if (!indisvalid || !indisready) return "build-incomplete";
  return structurallyValid ? "valid" : "wrong-definition";
}

async function acquireSerializingLock(sql: ReturnType<typeof postgres>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ locked }] = await sql<{ locked: boolean }[]>`
      select pg_try_advisory_lock(hashtextextended(${SERIALIZING_LOCK_KEY}, 0)) as locked
    `;
    if (locked) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for another ensurePendingConcurrentIndexes caller to finish and ` +
          `release its serializing lock ("${SERIALIZING_LOCK_KEY}"). Another deploy or server startup may be stuck.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
  }
}

async function releaseSerializingLock(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`select pg_advisory_unlock(hashtextextended(${SERIALIZING_LOCK_KEY}, 0))`;
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
 * Serialized across concurrent callers with a session-scoped advisory lock
 * (BLO-21526 review): without it, two replicas of a rolling deploy calling
 * this at the same time can observe each other's in-progress build as a
 * "build-incomplete" leftover — every `CREATE INDEX CONCURRENTLY` is
 * necessarily not-ready/not-valid while it runs — and either attempt to drop
 * the live build out from under it, or check its own `IF NOT EXISTS` create
 * (which no-ops against the first replica's in-flight entry) against a still-
 * incomplete index and throw, failing an otherwise healthy deploy. The lock
 * must be session-scoped (`pg_advisory_lock`, released explicitly), not the
 * transaction-scoped `pg_advisory_xact_lock` used elsewhere in this codebase:
 * `CREATE INDEX CONCURRENTLY` cannot run inside the transaction that would
 * hold an xact-scoped lock.
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
  const lockWaitTimeoutMs = Math.max(0, Math.trunc(options.lockWaitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS));
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  const results: ConcurrentIndexEnsureResult[] = [];
  let lockAcquired = false;

  try {
    // Acquired before `statement_timeout` is set below, and deliberately not
    // itself bound by that timeout — see DEFAULT_LOCK_WAIT_TIMEOUT_MS.
    await acquireSerializingLock(sql, lockWaitTimeoutMs);
    lockAcquired = true;

    await sql.unsafe(`set statement_timeout = ${timeoutMs}`);

    for (const spec of specs) {
      const before = await indexValidity(sql, spec);

      if (before === "valid") {
        results.push({ name: spec.name, table: spec.table, action: "already-valid" });
        continue;
      }

      if (before === "wrong-definition") {
        throw new Error(
          `Index ${spec.name} exists and is fully built, but its table/columns/access method/predicate does not ` +
            `match migration ${spec.migration}'s definition — it is not the index this guard exists to guarantee, ` +
            `and this guard will not drop and rebuild a complete index automatically. Inspect it manually, then run: ` +
            `${spec.dropStatement}; ${spec.createStatement}`,
        );
      }

      // A build-incomplete index is the leftover of a CONCURRENTLY build that
      // failed partway (e.g. a conflicting constraint violation). Postgres
      // will not repair it in place; the only way forward is to drop and
      // rebuild.
      if (before === "build-incomplete") {
        await sql.unsafe(spec.dropStatement);
      }

      await sql.unsafe(spec.createStatement);

      const after = await indexValidity(sql, spec);
      if (after !== "valid") {
        throw new Error(
          `Deferred index ${spec.name} on ${spec.table} (from migration ${spec.migration}) is still ${after} ` +
            `after its online build ran. Investigate before continuing the deploy. Statement run: ${spec.createStatement}`,
        );
      }

      results.push({ name: spec.name, table: spec.table, action: before === "build-incomplete" ? "rebuilt" : "created" });
    }
  } finally {
    if (lockAcquired) await releaseSerializingLock(sql);
    await sql.end();
  }

  return results;
}

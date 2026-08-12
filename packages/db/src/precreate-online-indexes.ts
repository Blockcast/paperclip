import postgres, { type Sql } from "postgres";
import { inspectMigrations } from "./client.js";

export type OnlineIndexPrerequisite = {
  readonly migration: string;
  readonly indexName: string;
  readonly table: string;
  readonly createStatement: string;
  readonly dropStatement: string;
};

/**
 * One entry per migration whose guard (see the migration file itself) refuses
 * to build its index inline on a populated table and instead REQUIRES the
 * exact index to already exist, built online via `CREATE INDEX CONCURRENTLY`.
 * `createStatement`/`dropStatement` are copied verbatim from that migration's
 * own `RAISE EXCEPTION ... HINT` text -- keep them in sync if a migration's
 * guard ever changes; a mismatch here just means this precreation step does
 * nothing useful and the migration's own guard still catches it (it re-verifies
 * columns/predicate/access-method independently, it does not trust this list).
 */
export const ONLINE_INDEX_PREREQUISITES: readonly OnlineIndexPrerequisite[] = [
  {
    migration: "0205_heartbeat_runs_company_finished_at_index.sql",
    indexName: "heartbeat_runs_company_finished_at_desc_idx",
    table: "heartbeat_runs",
    createStatement:
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_runs_company_finished_at_desc_idx" `
      + `ON "heartbeat_runs" USING btree ("company_id", "finished_at" DESC, "id" DESC) `
      + `WHERE "finished_at" IS NOT NULL`,
    dropStatement: `DROP INDEX CONCURRENTLY IF EXISTS "heartbeat_runs_company_finished_at_desc_idx"`,
  },
  {
    migration: "0208_heartbeat_runs_agent_dispatch_index.sql",
    indexName: "heartbeat_runs_agent_dispatch_idx",
    table: "heartbeat_runs",
    createStatement:
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_runs_agent_dispatch_idx" `
      + `ON "heartbeat_runs" USING btree ("agent_id", "status", "created_at", "id") `
      + `WHERE "status" IN ('queued', 'scheduled_retry')`,
    dropStatement: `DROP INDEX CONCURRENTLY IF EXISTS "heartbeat_runs_agent_dispatch_idx"`,
  },
  {
    migration: "0209_heartbeat_runs_recovery_dispatch_index.sql",
    indexName: "heartbeat_runs_recovery_dispatch_idx",
    table: "heartbeat_runs",
    createStatement:
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_runs_recovery_dispatch_idx" `
      + `ON "heartbeat_runs" USING btree ("agent_id", "created_at", "id") `
      + `WHERE "status" = 'queued' AND ("context_snapshot" ->> 'source') = 'issue_recovery_action' `
      + `AND ("context_snapshot" ->> 'recoveryActionId') IS NOT NULL`,
    dropStatement: `DROP INDEX CONCURRENTLY IF EXISTS "heartbeat_runs_recovery_dispatch_idx"`,
  },
];

export type OnlineIndexPrecreationAction = "created" | "already-valid" | "rebuilt-after-invalid";

export type OnlineIndexPrecreationResult = {
  readonly migration: string;
  readonly indexName: string;
  readonly action: OnlineIndexPrecreationAction;
};

/**
 * Deploy-time prerequisite for BLO-20396/BLO-21460-class migrations: guarded
 * DO-block DDL that refuses to build its index inline on a populated
 * `heartbeat_runs` and instead requires an operator to have precreated it
 * online first (see e.g. `migrations/0209_heartbeat_runs_recovery_dispatch_index.sql`).
 * Before this function existed, satisfying that requirement was a manual step
 * someone had to notice *after* the first crash-loop and run by hand -- that
 * gap is exactly what turned a routine migration into the 2026-08-03
 * incident this function follows up (BLO-21460). Call this BEFORE
 * `applyPendingMigrations` in the deploy path (see `migrate.ts`); it is
 * idempotent and rollback-safe:
 *
 *  - `IF NOT EXISTS` makes re-running it after a successful precreation a
 *    no-op, and every statement runs outside a transaction (required for
 *    `CONCURRENTLY`, and safe to interrupt -- a killed run leaves at worst
 *    an `INVALID` index, which the next run detects and rebuilds below).
 *  - a same-named index left `INVALID` by a previously-interrupted
 *    `CONCURRENTLY` build is dropped `CONCURRENTLY` and rebuilt -- exactly
 *    the recovery each migration's own `RAISE EXCEPTION` hint already
 *    prescribes for an operator to do by hand.
 *  - only migrations that are still PENDING get touched, so a fully-migrated
 *    database never re-scans `heartbeat_runs` on every deploy.
 *  - this function never trusts its own copy of the index definition as
 *    correct -- the migration's own DO-block guard independently re-verifies
 *    columns, predicate, and access method before proceeding, so a stale or
 *    wrong entry here just fails open into that guard's normal error path.
 */
export async function ensureOnlineIndexPrerequisites(
  connectionString: string,
  options: { readonly log?: (message: string) => void } = {},
): Promise<OnlineIndexPrecreationResult[]> {
  const log = options.log ?? (() => {});
  const state = await inspectMigrations(connectionString);
  const pendingMigrations = new Set(state.status === "needsMigrations" ? state.pendingMigrations : []);
  const applicable = ONLINE_INDEX_PREREQUISITES.filter((prereq) => pendingMigrations.has(prereq.migration));
  if (applicable.length === 0) return [];

  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  const results: OnlineIndexPrecreationResult[] = [];
  try {
    for (const prereq of applicable) {
      results.push(await ensureOnlineIndex(sql, prereq, log));
    }
  } finally {
    await sql.end();
  }
  return results;
}

async function ensureOnlineIndex(
  sql: Sql,
  prereq: OnlineIndexPrerequisite,
  log: (message: string) => void,
): Promise<OnlineIndexPrecreationResult> {
  const existing = await sql<{ indisvalid: boolean }[]>`
    SELECT indisvalid
    FROM pg_index
    WHERE indexrelid = to_regclass('public.' || ${prereq.indexName})
  `;

  if (existing.length > 0 && existing[0]?.indisvalid === false) {
    log(
      `${prereq.migration}: found an invalid leftover index ${prereq.indexName} `
      + `(a previous CONCURRENTLY build was interrupted) -- dropping and rebuilding concurrently`,
    );
    await sql.unsafe(prereq.dropStatement);
    await sql.unsafe(prereq.createStatement);
    return { migration: prereq.migration, indexName: prereq.indexName, action: "rebuilt-after-invalid" };
  }

  if (existing.length > 0) {
    return { migration: prereq.migration, indexName: prereq.indexName, action: "already-valid" };
  }

  log(`${prereq.migration}: precreating ${prereq.indexName} online (CREATE INDEX CONCURRENTLY)`);
  await sql.unsafe(prereq.createStatement);
  return { migration: prereq.migration, indexName: prereq.indexName, action: "created" };
}

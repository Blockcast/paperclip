import { inspectMigrations } from "./client.js";
import {
  ensurePendingConcurrentIndexes,
  PENDING_CONCURRENT_INDEXES,
  type EnsurePendingConcurrentIndexesOptions,
} from "./concurrent-index-guard.js";

/**
 * Compatibility view for the standalone precreation command. The concurrent
 * index guard is the single source of truth for index definitions; keeping
 * this view derived prevents the CLI and the migration runner from drifting
 * apart when another guarded migration is added.
 */
export type OnlineIndexPrerequisite = {
  readonly migration: string;
  readonly indexName: string;
  readonly table: string;
  readonly createStatement: string;
  readonly dropStatement: string;
};

export const ONLINE_INDEX_PREREQUISITES: readonly OnlineIndexPrerequisite[] =
  PENDING_CONCURRENT_INDEXES.map((spec) => ({
    migration: spec.migration,
    indexName: spec.name,
    table: spec.table,
    createStatement: spec.createStatement,
    dropStatement: spec.dropStatement,
  }));

export type OnlineIndexPrecreationAction = "created" | "already-valid" | "rebuilt-after-invalid";

export type OnlineIndexPrecreationResult = {
  readonly migration: string;
  readonly indexName: string;
  readonly action: OnlineIndexPrecreationAction;
};

export type EnsureOnlineIndexPrerequisitesOptions = Pick<
  EnsurePendingConcurrentIndexesOptions,
  "statementTimeoutMs" | "ddlLockTimeoutMs" | "lockWaitTimeoutMs" | "log"
>;

/**
 * Precreate the indexes belonging to migrations that are still pending.
 *
 * This is intentionally a thin wrapper around `ensurePendingConcurrentIndexes`:
 * it filters by migration journal state for the operator-facing command, then
 * asks the authoritative guard to validate prerequisites, repair interrupted
 * builds, and fail closed on complete wrong definitions. Missing tables or
 * columns are skipped because a multi-version upgrade may not have committed
 * their prerequisite migration yet; the migration runner retries the matching
 * guard immediately before each file.
 */
export async function ensureOnlineIndexPrerequisites(
  connectionString: string,
  options: EnsureOnlineIndexPrerequisitesOptions = {},
): Promise<OnlineIndexPrecreationResult[]> {
  const state = await inspectMigrations(connectionString);
  if (state.status === "upToDate") return [];

  const pendingMigrations = new Set(state.pendingMigrations);
  const specs = PENDING_CONCURRENT_INDEXES.filter((spec) => pendingMigrations.has(spec.migration));
  if (specs.length === 0) return [];

  const results = await ensurePendingConcurrentIndexes(connectionString, {
    ...options,
    specs,
    skipUnavailable: true,
  });

  return results.map((result) => ({
    migration: result.migration,
    indexName: result.name,
    action: result.action === "rebuilt" ? "rebuilt-after-invalid" : result.action,
  }));
}

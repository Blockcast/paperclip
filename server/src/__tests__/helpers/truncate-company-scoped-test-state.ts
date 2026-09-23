import { sql } from "drizzle-orm";
import type { createDb } from "@paperclipai/db";
import { runWithTransientDbRetry } from "../../lib/db-retry.js";

type Db = ReturnType<typeof createDb>;

const TEST_DATABASE_CLEANUP_LOCK_KEY = "paperclip:test-database-cleanup";

export type TruncateCompanyScopedTestStateOptions = {
  /**
   * Tables to TRUNCATE alongside "companies". The companies cascade covers
   * every company-scoped table by FK. Singleton tables that aren't
   * company-scoped (e.g. "instance_settings") must be listed here.
   */
  extraTruncateTables?: readonly string[];
};

/**
 * Wipe all company-scoped state for a test, in one statement.
 *
 * Prefer this over a hand-ordered list of `db.delete(table)` calls. An ordered
 * delete list is only correct while nothing else is writing, and route tests
 * driven by supertest cannot guarantee that: `request(app)` resolves when the
 * response is *flushed*, not when the handler has settled, so a trailing
 * best-effort write can still be in flight when `afterEach` starts. When that
 * straggler lands between the child delete and the parent delete, the parent
 * delete fails:
 *
 *   delete from "heartbeat_runs" violates foreign key constraint
 *   "activity_log_run_id_heartbeat_runs_id_fk" on table "activity_log"
 *
 * `activity_log.run_id` and `heartbeat_run_events.run_id` are the only FKs to
 * `heartbeat_runs` declared without an `onDelete` action, which is why those two
 * constraints are the ones that surface (BLO-22231).
 *
 * A single `TRUNCATE ... CASCADE` removes the failure mode structurally rather
 * than retrying around it. TRUNCATE takes an ACCESS EXCLUSIVE lock on every
 * table in the cascade at once, so a concurrent straggler insert cannot
 * interleave between a child and its parent: it either commits before the
 * truncate (and is truncated with everything else) or blocks until the truncate
 * commits and then fails its own FK check. The writers on this path are
 * best-effort and already swallow their errors (e.g. `recordDeniedIssueWrite`
 * in routes/issues.ts logs and continues), so the second case is a warning
 * rather than a test failure. Either way cleanup itself cannot fail.
 *
 * Ordering was never the bug, so re-ordering was never the fix.
 */
export async function truncateCompanyScopedTestState(
  db: Db,
  options: TruncateCompanyScopedTestStateOptions = {},
): Promise<void> {
  const { extraTruncateTables = [] } = options;
  const truncateList = ['"companies"', ...extraTruncateTables.map((t) => `"${t}"`)].join(", ");
  await runWithTransientDbRetry(
    async () => {
      await db.transaction(async (tx) => {
        // Serializes destructive cleanup across Vitest processes that share a
        // database, so concurrent CASCADE lock walks can't deadlock.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${TEST_DATABASE_CLEANUP_LOCK_KEY}, 0))`,
        );
        await tx.execute(sql.raw(`TRUNCATE TABLE ${truncateList} CASCADE`));
      });
    },
    {
      maxAttempts: 5,
      baseDelayMs: 50,
      jitterMs: 100,
    },
  );
}

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

type AdvisoryLockDb = Pick<Db, "execute">;

const ISSUE_MONITOR_QUEUE_LOCK_KEY = "paperclip:issue-monitor-queue";

export async function lockIssueMonitorQueue(dbClient: AdvisoryLockDb) {
  await dbClient.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${ISSUE_MONITOR_QUEUE_LOCK_KEY}, 0))`,
  );
}

export async function withIssueMonitorQueueLock<T>(
  dbClient: AdvisoryLockDb,
  task: () => Promise<T>,
) {
  await lockIssueMonitorQueue(dbClient);
  return task();
}

export async function tryLockIssueMonitorQueue(dbClient: AdvisoryLockDb) {
  const rows = await dbClient.execute(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${ISSUE_MONITOR_QUEUE_LOCK_KEY}, 0)) as acquired`,
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  return Boolean(
    row &&
      typeof row === "object" &&
      (row as Record<string, unknown>).acquired === true,
  );
}

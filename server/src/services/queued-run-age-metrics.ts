import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import {
  invalidateQueuedRunOldestAgeMetrics,
  setQueuedRunOldestAgeMetrics,
} from "./metrics.js";

/**
 * Rebuild the oldest queued-run age for every agent from durable state before
 * each scrape. `queuedAt` records a requeue transition; a newly inserted run
 * has no transition, so its `createdAt` is its queue-entry time.
 */
export async function refreshQueuedRunAgeMetrics(db: Db, now = new Date()): Promise<void> {
  try {
    const [agentRows, oldestByAgent] = await Promise.all([
      db.select({ id: agents.id }).from(agents),
      db
        .select({
          agentId: heartbeatRuns.agentId,
          oldestQueuedAt: sql<Date | string | null>`min(coalesce(${heartbeatRuns.queuedAt}, ${heartbeatRuns.createdAt}))`,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.status, "queued"))
        .groupBy(heartbeatRuns.agentId),
    ]);

    const knownAgentIds = new Set(agentRows.map((row) => row.id));
    const entries: Array<{ agentId: string; ageSeconds: number }> = [];
    for (const row of oldestByAgent) {
      if (!row.agentId || !row.oldestQueuedAt) continue;
      const queuedAtMs = new Date(row.oldestQueuedAt).getTime();
      if (Number.isNaN(queuedAtMs)) continue;
      entries.push({
        agentId: row.agentId,
        ageSeconds: Math.max(0, (now.getTime() - queuedAtMs) / 1000),
      });
    }
    setQueuedRunOldestAgeMetrics(entries, knownAgentIds);
  } catch (error) {
    // A successful scrape with an old process-local gauge is worse than no
    // sample: it can either suppress a real strand at 0 or retain a cleared
    // strand above the threshold. Withdraw it until a live query succeeds.
    invalidateQueuedRunOldestAgeMetrics();
    throw error;
  }
}

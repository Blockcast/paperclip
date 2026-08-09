import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { setOverdueScheduledRetryAgeMetrics } from "./metrics.js";

/**
 * Refresh the age, past due time, of the oldest parked scheduled retry for
 * each agent. A scheduled retry is expected to be promoted once its due time
 * passes; rows still waiting for a future due time are normal backoff and do
 * not contribute to this gauge.
 */
export async function refreshOverdueScheduledRetryAgeMetrics(db: Db, now = new Date()): Promise<void> {
  const [agentRows, oldestByAgent] = await Promise.all([
    db.select({ id: agents.id }).from(agents),
    db
      .select({
        agentId: heartbeatRuns.agentId,
        oldestDueAt: sql<Date | string | null>`min(${heartbeatRuns.scheduledRetryAt})`,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.status, "scheduled_retry"), lt(heartbeatRuns.scheduledRetryAt, now)))
      .groupBy(heartbeatRuns.agentId),
  ]);

  const knownAgentIds = new Set(agentRows.map((row) => row.id));
  const entries = oldestByAgent
    .filter((row) => row.agentId !== null && row.oldestDueAt)
    .map((row) => ({
      agentId: row.agentId,
      ageSeconds: Math.max(0, (now.getTime() - new Date(row.oldestDueAt as Date | string).getTime()) / 1000),
    }));

  setOverdueScheduledRetryAgeMetrics(entries, knownAgentIds);
}

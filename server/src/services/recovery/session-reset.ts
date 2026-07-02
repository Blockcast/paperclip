import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentTaskSessions } from "@paperclipai/db";

// Deletes the persisted `agentTaskSessions` row(s) for an agent so the next
// dispatch starts a genuinely fresh session instead of resuming whatever was
// last persisted. Shared by heartbeat.ts's `clearTaskSessions` (manual/API
// reset) and the stranded-issue recovery sweep (BLO-10889 / BLO-10866 WS2),
// which resets the session before retrying a run that failed with a
// zero-token startup wedge — a wrapper that just re-invokes the same
// poisoned session reproduces the same failure (BLO-5681).
export async function clearAgentTaskSessions(
  db: Db,
  companyId: string,
  agentId: string,
  opts?: { taskKey?: string | null; adapterType?: string | null },
): Promise<number> {
  const conditions = [
    eq(agentTaskSessions.companyId, companyId),
    eq(agentTaskSessions.agentId, agentId),
  ];
  if (opts?.taskKey) {
    conditions.push(eq(agentTaskSessions.taskKey, opts.taskKey));
  }
  if (opts?.adapterType) {
    conditions.push(eq(agentTaskSessions.adapterType, opts.adapterType));
  }

  return db
    .delete(agentTaskSessions)
    .where(and(...conditions))
    .returning()
    .then((rows) => rows.length);
}

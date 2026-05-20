import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { hasActiveJobForAgent } from "./k8s-job-liveness.js";

export const ELIGIBLE_ADAPTER_TYPES = ["claude_k8s", "opencode_k8s"] as const;

export interface EligibleAgent {
  id: string;
  companyId: string;
  name: string;
  adapterType: string;
  currentImage: string;
}

export async function selectEligibleAgentsForImageBump(
  db: Db,
  input: { companyId: string; targetImage: string },
): Promise<EligibleAgent[]> {
  const { companyId, targetImage } = input;
  return db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      adapterType: agents.adapterType,
      currentImage: sql<string>`${agents.adapterConfig} ->> 'image'`,
    })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        inArray(agents.adapterType, [...ELIGIBLE_ADAPTER_TYPES]),
        sql`${agents.adapterConfig} ->> 'image' IS NOT NULL`,
        sql`${agents.adapterConfig} ->> 'image' != ${targetImage}`,
      ),
    );
}

const IN_FLIGHT_RUN_STATUSES = ["queued", "running"] as const;

export async function isAgentInFlight(db: Db, agentId: string): Promise<boolean> {
  const [dbHit] = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, agentId),
        inArray(heartbeatRuns.status, [...IN_FLIGHT_RUN_STATUSES]),
      ),
    )
    .limit(1);
  if (dbHit) return true;
  return hasActiveJobForAgent(agentId);
}

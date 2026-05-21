import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentConfigRevisions, agents, heartbeatRuns } from "@paperclipai/db";
import { hasActiveJobForAgent } from "./k8s-job-liveness.js";
import { logger } from "../middleware/logger.js";

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

export interface ApplyResult {
  agentId: string;
  outcome: "bumped" | "skipped";
}

/**
 * Bump an agent's container image, or defer if the agent is mid-run.
 *
 * - Idle agent (no queued/running heartbeat_runs, no active k8s Job): PATCH
 *   adapter_config.image in a transaction that also writes an
 *   agent_config_revisions audit row. Clears any prior pending_image_bump.
 * - In-flight agent: stash the target in agents.pending_image_bump (last-write-wins)
 *   and skip the PATCH. The heartbeat run-completion hook in Task 7 picks it
 *   up the next time the agent reaches a terminal run state.
 *
 * Mirrors the partial-patch semantics of PATCH /agents/:id without going
 * through HTTP, so the same audit trail lands either way.
 */
export async function applyImageBumpToAgent(
  db: Db,
  args: {
    agentId: string;
    targetImage: string;
    /** Free-form source tag for the audit log, e.g. "ci:docker-agent.yml" or "auto-retry-on-completion". */
    source: string;
  },
): Promise<ApplyResult> {
  const inFlight = await isAgentInFlight(db, args.agentId);
  if (inFlight) {
    await db
      .update(agents)
      .set({ pendingImageBump: args.targetImage, updatedAt: new Date() })
      .where(eq(agents.id, args.agentId));
    logger.info(
      { agentId: args.agentId, targetImage: args.targetImage, source: args.source },
      "agent in-flight; pending_image_bump set",
    );
    return { outcome: "skipped", agentId: args.agentId };
  }

  await patchAgentImage(db, args.agentId, args.targetImage, args.source);
  return { outcome: "bumped", agentId: args.agentId };
}

async function patchAgentImage(
  db: Db,
  agentId: string,
  targetImage: string,
  source: string,
): Promise<void> {
  const [row] = await db
    .select({ companyId: agents.companyId, adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!row) throw new Error(`agent ${agentId} not found`);
  const existing = (row.adapterConfig as Record<string, unknown>) ?? {};
  const next = { ...existing, image: targetImage };

  await db.transaction(async (tx) => {
    await tx
      .update(agents)
      .set({ adapterConfig: next, pendingImageBump: null, updatedAt: new Date() })
      .where(eq(agents.id, agentId));
    await tx.insert(agentConfigRevisions).values({
      companyId: row.companyId,
      agentId,
      source,
      changedKeys: ["adapterConfig"],
      beforeConfig: { adapter_config: existing },
      afterConfig: { adapter_config: next },
    });
  });

  logger.info({ agentId, targetImage, source }, "agent image PATCHed");
}

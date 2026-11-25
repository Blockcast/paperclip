import { and, eq, gt, lte } from "drizzle-orm";
import {
  heartbeatRunRuntimePrompts,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";

/** Keep prompt handoff bounded even though the transport no longer uses a K8s Secret. */
export const MAX_RUNTIME_PROMPT_BYTES = 16 * 1024 * 1024;
export const RUNTIME_PROMPT_TTL_MS = 15 * 60 * 1000;

const RUNTIME_PROMPT_PATH_PREFIX = "/api/heartbeat-runs/";

export interface RuntimePromptIdentity {
  runId: string;
  companyId: string;
  agentId: string;
}

function runtimePromptPath(runId: string): string {
  return `${RUNTIME_PROMPT_PATH_PREFIX}${encodeURIComponent(runId)}/runtime-prompt`;
}

/**
 * Persist a private prompt for the exact heartbeat run that will consume it.
 * The prompt is deliberately not an asset, event, result, or context snapshot.
 */
export async function stageRuntimePrompt(
  db: Db,
  input: RuntimePromptIdentity & { prompt: string },
): Promise<string> {
  const byteSize = Buffer.byteLength(input.prompt, "utf8");
  if (byteSize > MAX_RUNTIME_PROMPT_BYTES) {
    throw new Error(`Runtime prompt exceeds ${MAX_RUNTIME_PROMPT_BYTES} bytes`);
  }

  const run = await db
    .select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, input.runId))
    .then((rows) => rows[0] ?? null);
  if (
    !run ||
    run.companyId !== input.companyId ||
    run.agentId !== input.agentId ||
    run.status !== "running"
  ) {
    throw new Error("Heartbeat run is not available for a runtime prompt");
  }

  const prompt = Buffer.from(input.prompt, "utf8");
  const expiresAt = new Date(Date.now() + RUNTIME_PROMPT_TTL_MS);
  await db
    .insert(heartbeatRunRuntimePrompts)
    .values({ runId: input.runId, prompt, expiresAt })
    .onConflictDoUpdate({
      target: heartbeatRunRuntimePrompts.runId,
      set: { prompt, expiresAt },
    });

  return runtimePromptPath(input.runId);
}

/**
 * Return a prompt only while its run is running and its short handoff TTL
 * is live. The caller still authenticates the request; these predicates make
 * the data layer fail closed if a route forgets one of the checks.
 */
export async function readRuntimePrompt(
  db: Db,
  input: RuntimePromptIdentity,
  now = new Date(),
): Promise<Buffer | null> {
  const row = await db
    .select({ prompt: heartbeatRunRuntimePrompts.prompt })
    .from(heartbeatRunRuntimePrompts)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, heartbeatRunRuntimePrompts.runId))
    .where(
      and(
        eq(heartbeatRunRuntimePrompts.runId, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        gt(heartbeatRunRuntimePrompts.expiresAt, now),
        eq(heartbeatRuns.status, "running"),
      ),
    )
    .then((rows) => rows[0] ?? null);
  return row ? Buffer.from(row.prompt) : null;
}

/** Remove expired rows during the worker's scheduled cleanup. */
export async function sweepExpiredRuntimePrompts(db: Db, now = new Date()): Promise<number> {
  const expired = await db
    .delete(heartbeatRunRuntimePrompts)
    .where(lte(heartbeatRunRuntimePrompts.expiresAt, now))
    .returning({ runId: heartbeatRunRuntimePrompts.runId });
  return expired.length;
}

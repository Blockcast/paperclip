import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  executionWorkspaces,
  heartbeatRuns,
  projectWorkspaces,
  projects,
  type Db,
} from "@paperclipai/db";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { readExecutionWorkspaceConfig } from "./execution-workspaces.js";
import { workspaceOperationService } from "./workspace-operations.js";
import {
  cleanupExecutionWorkspaceArtifacts,
  stopRuntimeServicesForExecutionWorkspace,
} from "./workspace-runtime.js";

const CLEANUP_CLAIM_MS = 5 * 60 * 1000;
const CLEANUP_RETRY_MS = 60 * 60 * 1000;

export type ExecutionWorkspaceCleanupSweepResult = {
  selected: number;
  claimed: number;
  cleaned: number;
  failed: number;
};

export async function markRunScopedExecutionWorkspaceCleanupEligible(input: {
  db: Db;
  executionWorkspaceId: string;
  runId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return input.db
    .update(executionWorkspaces)
    .set({
      status: "cleanup_pending",
      cleanupEligibleAt: now,
      cleanupReason: `run_completed:${input.runId}`,
      lastUsedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(executionWorkspaces.id, input.executionWorkspaceId),
      sql`${executionWorkspaces.metadata} ->> 'cleanupOwnerRunId' = ${input.runId}`,
      inArray(executionWorkspaces.status, ["active", "idle"]),
      isNull(executionWorkspaces.closedAt),
    ))
    .returning({ id: executionWorkspaces.id })
    .then((rows) => rows[0] ?? null);
}

async function markTerminalRunScopedWorkspacesEligible(input: { db: Db; companyId?: string; now: Date }) {
  const terminalRows = await input.db
    .select({ id: executionWorkspaces.id })
    .from(executionWorkspaces)
    .innerJoin(
      heartbeatRuns,
      sql`${executionWorkspaces.metadata} ->> 'cleanupOwnerRunId' = ${heartbeatRuns.id}::text`,
    )
    .where(and(
      ...(input.companyId ? [eq(executionWorkspaces.companyId, input.companyId)] : []),
      isNull(executionWorkspaces.cleanupEligibleAt),
      isNull(executionWorkspaces.closedAt),
      inArray(executionWorkspaces.status, ["active", "idle"]),
      inArray(heartbeatRuns.status, ["succeeded", "failed", "cancelled", "timed_out", "interrupted"]),
    ));
  if (terminalRows.length === 0) return 0;
  const ids = terminalRows.map((row) => row.id);
  const updated = await input.db
    .update(executionWorkspaces)
    .set({ status: "cleanup_pending", cleanupEligibleAt: input.now, updatedAt: input.now })
    .where(and(
      inArray(executionWorkspaces.id, ids),
      isNull(executionWorkspaces.cleanupEligibleAt),
      isNull(executionWorkspaces.closedAt),
      inArray(executionWorkspaces.status, ["active", "idle"]),
    ))
    .returning({ id: executionWorkspaces.id });
  return updated.length;
}

export async function collectDueExecutionWorkspaces(input: {
  db: Db;
  companyId?: string;
  now?: Date;
  limit?: number;
  claimDurationMs?: number;
}): Promise<ExecutionWorkspaceCleanupSweepResult> {
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const claimDurationMs = Math.max(100, input.claimDurationMs ?? CLEANUP_CLAIM_MS);
  await markTerminalRunScopedWorkspacesEligible({ db: input.db, companyId: input.companyId, now });
  const conditions = [
    lte(executionWorkspaces.cleanupEligibleAt, now),
    isNull(executionWorkspaces.closedAt),
    inArray(executionWorkspaces.status, ["cleanup_pending", "cleanup_failed"]),
  ];
  if (input.companyId) conditions.push(eq(executionWorkspaces.companyId, input.companyId));

  const candidates = await input.db
    .select()
    .from(executionWorkspaces)
    .where(and(...conditions))
    .orderBy(executionWorkspaces.cleanupEligibleAt, executionWorkspaces.id)
    .limit(limit);

  const result: ExecutionWorkspaceCleanupSweepResult = {
    selected: candidates.length,
    claimed: 0,
    cleaned: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    const claimId = randomUUID();
    const claimUntil = new Date(now.getTime() + claimDurationMs);
    const claimed = await input.db
      .update(executionWorkspaces)
      .set({
        cleanupEligibleAt: claimUntil,
        metadata: sql`coalesce(${executionWorkspaces.metadata}, '{}'::jsonb) || jsonb_build_object('cleanupClaimId', ${claimId}::text)`,
        updatedAt: now,
      })
      .where(and(
        eq(executionWorkspaces.id, candidate.id),
        lte(executionWorkspaces.cleanupEligibleAt, now),
        isNull(executionWorkspaces.closedAt),
        inArray(executionWorkspaces.status, ["cleanup_pending", "cleanup_failed"]),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!claimed) continue;
    result.claimed += 1;

    let renewalTimer: ReturnType<typeof setTimeout> | null = null;
    let renewalStopped = false;
    const scheduleRenewal = () => {
      renewalTimer = setTimeout(() => {
        void renewClaim().catch(() => {
          if (!renewalStopped) scheduleRenewal();
        });
      }, Math.max(25, Math.floor(claimDurationMs / 3)));
      renewalTimer.unref();
    };
    const renewClaim = async () => {
      if (renewalStopped) return;
      const renewedAt = new Date();
      const renewed = await input.db
        .update(executionWorkspaces)
        .set({
          cleanupEligibleAt: new Date(renewedAt.getTime() + claimDurationMs),
          updatedAt: renewedAt,
        })
        .where(and(
          eq(executionWorkspaces.id, claimed.id),
          sql`${executionWorkspaces.metadata} ->> 'cleanupClaimId' = ${claimId}`,
          isNull(executionWorkspaces.closedAt),
          inArray(executionWorkspaces.status, ["cleanup_pending", "cleanup_failed"]),
        ))
        .returning({ id: executionWorkspaces.id });
      if (renewed.length > 0 && !renewalStopped) {
        scheduleRenewal();
      }
    };
    scheduleRenewal();

    try {
      await stopRuntimeServicesForExecutionWorkspace({
        db: input.db,
        executionWorkspaceId: claimed.id,
        workspaceCwd: claimed.cwd,
      });
      const [projectWorkspace, projectPolicy] = await Promise.all([
        claimed.projectWorkspaceId
          ? input.db
            .select({ cwd: projectWorkspaces.cwd, cleanupCommand: projectWorkspaces.cleanupCommand })
            .from(projectWorkspaces)
            .where(and(
              eq(projectWorkspaces.id, claimed.projectWorkspaceId),
              eq(projectWorkspaces.companyId, claimed.companyId),
            ))
            .then((rows) => rows[0] ?? null)
          : null,
        input.db
          .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
          .from(projects)
          .where(and(eq(projects.id, claimed.projectId), eq(projects.companyId, claimed.companyId)))
          .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy)),
      ]);
      const config = readExecutionWorkspaceConfig(claimed.metadata);
      const cleanup = await cleanupExecutionWorkspaceArtifacts({
        workspace: claimed,
        projectWorkspace,
        cleanupCommand: config?.cleanupCommand ?? null,
        teardownCommand: config?.teardownCommand ?? projectPolicy?.workspaceStrategy?.teardownCommand ?? null,
        recorder: workspaceOperationService(input.db).createRecorder({
          companyId: claimed.companyId,
          executionWorkspaceId: claimed.id,
        }),
      });
      if (cleanup.cleaned) {
        const archived = await input.db
          .update(executionWorkspaces)
          .set({
            status: "archived",
            closedAt: now,
            cleanupEligibleAt: null,
            cleanupReason: cleanup.warnings.join(" | ") || null,
            metadata: sql`${executionWorkspaces.metadata} - 'cleanupClaimId'`,
            updatedAt: new Date(),
          })
          .where(and(
            eq(executionWorkspaces.id, claimed.id),
            sql`${executionWorkspaces.metadata} ->> 'cleanupClaimId' = ${claimId}`,
          ))
          .returning({ id: executionWorkspaces.id });
        result.cleaned += archived.length;
      } else {
        const failed = await input.db
          .update(executionWorkspaces)
          .set({
            status: "cleanup_failed",
            closedAt: null,
            cleanupEligibleAt: new Date(now.getTime() + CLEANUP_RETRY_MS),
            cleanupReason: cleanup.warnings.join(" | ") || "workspace artifacts remain after cleanup",
            metadata: sql`${executionWorkspaces.metadata} - 'cleanupClaimId'`,
            updatedAt: new Date(),
          })
          .where(and(
            eq(executionWorkspaces.id, claimed.id),
            sql`${executionWorkspaces.metadata} ->> 'cleanupClaimId' = ${claimId}`,
          ))
          .returning({ id: executionWorkspaces.id });
        result.failed += failed.length;
      }
    } catch (error) {
      const failed = await input.db
        .update(executionWorkspaces)
        .set({
          status: "cleanup_failed",
          closedAt: null,
          cleanupEligibleAt: new Date(now.getTime() + CLEANUP_RETRY_MS),
          cleanupReason: error instanceof Error ? error.message : String(error),
          metadata: sql`${executionWorkspaces.metadata} - 'cleanupClaimId'`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(executionWorkspaces.id, claimed.id),
          sql`${executionWorkspaces.metadata} ->> 'cleanupClaimId' = ${claimId}`,
        ))
        .returning({ id: executionWorkspaces.id });
      result.failed += failed.length;
    } finally {
      renewalStopped = true;
      if (renewalTimer) clearTimeout(renewalTimer);
    }
  }

  return result;
}

export async function finalizeRunScopedExecutionWorkspace(input: {
  db: Db;
  companyId: string;
  executionWorkspaceId: string;
  runId: string;
  now?: Date;
}) {
  await markRunScopedExecutionWorkspaceCleanupEligible(input);
  return collectDueExecutionWorkspaces({
    db: input.db,
    companyId: input.companyId,
    now: input.now,
  });
}

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  executionWorkspaces,
  externalRuntimeReservations,
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
// Bounds the stamped-workspace probe so a pathological backlog cannot turn the
// eligibility pass into an unbounded read. Successive sweeps drain the remainder.
const TERMINAL_STAMP_SCAN_LIMIT = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  // Driven from the workspace side on purpose. Joining `heartbeat_runs` on
  // `metadata ->> 'cleanupOwnerRunId' = heartbeat_runs.id::text` casts the uuid PK to
  // text, which makes the PK index unusable and forces a scan of `heartbeat_runs`
  // (a table with no production deletion path) on every call — and this function is
  // awaited unconditionally by `collectDueExecutionWorkspaces`, i.e. on every
  // scheduler tick and at the end of every terminal run. Selecting the stamped
  // workspaces first bounds the work by the number of live run-scoped worktrees, then
  // resolves their owner runs by primary key with real uuids.
  const stampedRows = await input.db
    .select({
      id: executionWorkspaces.id,
      cleanupOwnerRunId: sql<string | null>`${executionWorkspaces.metadata} ->> 'cleanupOwnerRunId'`,
    })
    .from(executionWorkspaces)
    .where(and(
      ...(input.companyId ? [eq(executionWorkspaces.companyId, input.companyId)] : []),
      isNull(executionWorkspaces.cleanupEligibleAt),
      isNull(executionWorkspaces.closedAt),
      inArray(executionWorkspaces.status, ["active", "idle"]),
      sql`${executionWorkspaces.metadata} ->> 'cleanupOwnerRunId' is not null`,
    ))
    .limit(TERMINAL_STAMP_SCAN_LIMIT);
  if (stampedRows.length === 0) return 0;

  // Only well-formed uuids are compared, so a malformed stamp cannot raise
  // `invalid input syntax for type uuid` and abort the whole sweep.
  const ownerRunIds = [...new Set(
    stampedRows
      .map((row) => row.cleanupOwnerRunId)
      .filter((runId): runId is string => typeof runId === "string" && UUID_PATTERN.test(runId)),
  )];
  if (ownerRunIds.length === 0) return 0;

  const terminalOwnerRuns = await input.db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      inArray(heartbeatRuns.id, ownerRunIds),
      inArray(heartbeatRuns.status, ["succeeded", "failed", "cancelled", "timed_out", "interrupted"]),
    ));
  if (terminalOwnerRuns.length === 0) return 0;

  const terminalOwnerRunIds = new Set(terminalOwnerRuns.map((row) => row.id));
  // A terminal DB row is not proof that an external worker has stopped. The
  // reservation is released only after the runtime job is quiescent, so keep
  // its workspace out of the destructive sweep while that reservation lives.
  const activeReservations = await input.db
    .select({ runId: externalRuntimeReservations.runId })
    .from(externalRuntimeReservations)
    .where(and(
      inArray(externalRuntimeReservations.runId, [...terminalOwnerRunIds]),
      isNull(externalRuntimeReservations.releasedAt),
    ));
  const externallyActiveRunIds = new Set(activeReservations.map((row) => row.runId));
  const ids = stampedRows
    .filter((row) => row.cleanupOwnerRunId !== null
      && terminalOwnerRunIds.has(row.cleanupOwnerRunId)
      && !externallyActiveRunIds.has(row.cleanupOwnerRunId))
    .map((row) => row.id);
  if (ids.length === 0) return 0;
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
    await input.db.transaction(async (tx) => {
      const claimId = randomUUID();
      const claimUntil = new Date(now.getTime() + claimDurationMs);
      // Keep the claimed row locked until teardown finishes. A competing sweep
      // may wait, but it cannot acquire the claim and touch the same filesystem.
      // If this worker exits, PostgreSQL rolls the claim back and releases it.
      const claimed = await tx
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
      if (!claimed) return;
      result.claimed += 1;

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
          const archived = await tx
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
          const failed = await tx
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
        const failed = await tx
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
      }
    });
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

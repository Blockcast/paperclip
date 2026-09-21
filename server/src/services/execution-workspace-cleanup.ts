import type { Db } from "@paperclipai/db";
import { companies, executionWorkspaces, projectWorkspaces } from "@paperclipai/db";
import { and, asc, eq, isNull, lte, ne, sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import {
  cleanupExecutionWorkspaceArtifacts,
  inspectWorktreeReclaimSafety,
} from "./workspace-runtime.js";

/**
 * Execution-workspace collector (BLO-22984).
 *
 * Before this existed, `cleanup_eligible_at` was written and read as a field
 * but was not a query predicate anywhere in the server, and the only code that
 * removed a worktree from disk ran from a persist-rollback `catch` and from an
 * operator PATCH. Nothing collected a worktree at the end of a run, so the
 * registry grew monotonically — 366 registrations and 128 ownership locks by
 * 2026-09-20, none of the lock-holding runs alive.
 *
 * The design is deliberately one predicate with two producers:
 *
 *   1. `executeRun`'s teardown stamps `cleanupEligibleAt` when a run goes
 *      terminal, and workspace realization clears it again on reuse. A
 *      run-scoped workspace is never reused, so it is collected one grace
 *      window after its run; a per-issue workspace keeps having its stamp
 *      cleared and is collected only once genuinely idle.
 *   2. `stampIdleLegacyWorkspaces` below backfills rows that predate (1),
 *      which is what makes the pre-existing population reclaimable by the
 *      same mechanism rather than by a one-off script.
 *
 * Reclamation is fail-closed: `inspectWorktreeReclaimSafety` must *prove* a
 * tree holds no uncommitted change and no unpushed commit, and anything it
 * cannot read is skipped rather than removed.
 */

/** How long after a run ends its workspace stays reclaimable-but-not-yet-collected. */
export const EXECUTION_WORKSPACE_IDLE_GRACE_MS = readDurationEnv(
  "PAPERCLIP_EXECUTION_WORKSPACE_IDLE_GRACE_MS",
  24 * 60 * 60 * 1000,
);

/** Rows with no stamp at all are treated as eligible once idle this long. */
export const EXECUTION_WORKSPACE_LEGACY_IDLE_MS = readDurationEnv(
  "PAPERCLIP_EXECUTION_WORKSPACE_LEGACY_IDLE_MS",
  7 * 24 * 60 * 60 * 1000,
);

/**
 * Floor on `lastUsedAt` before anything is collected, independent of the stamp.
 * The stamp is only written after a run reaches a terminal status and is
 * cleared again at realization, so a live run cannot normally be selected —
 * this closes the residual window where a terminal write and the next
 * realization straddle a sweep.
 */
const EXECUTION_WORKSPACE_MIN_IDLE_MS = 10 * 60 * 1000;

function readDurationEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export type ExecutionWorkspaceCleanupResult = {
  /** Rows the backfill newly made eligible this pass. */
  stamped: number;
  /** Eligible rows examined this pass. */
  scanned: number;
  /** Rows whose artifacts were removed and whose row was archived. */
  collected: number;
  /** Eligible rows deliberately left alone (dirty, unpushed, unverifiable). */
  skipped: number;
  failed: number;
};

export function executionWorkspaceCleanupService(db: Db) {
  /**
   * Make long-idle unstamped rows eligible.
   *
   * `archived` is excluded on purpose: the workspace-validation quarantine path
   * archives a row with an explicitly null `cleanupEligibleAt` and a
   * `cleanupReason`, i.e. it is preserved evidence, and backfilling it here
   * would silently discard the artifact somebody archived it to keep.
   */
  async function stampIdleLegacyWorkspaces(now: Date): Promise<number> {
    const idleBefore = new Date(now.getTime() - EXECUTION_WORKSPACE_LEGACY_IDLE_MS);
    const stamped = await db
      .update(executionWorkspaces)
      .set({
        cleanupEligibleAt: now,
        cleanupReason: "idle_backfill",
        updatedAt: now,
      })
      .where(and(
        isNull(executionWorkspaces.cleanupEligibleAt),
        eq(executionWorkspaces.providerType, "git_worktree"),
        ne(executionWorkspaces.status, "archived"),
        lte(executionWorkspaces.lastUsedAt, idleBefore),
      ))
      .returning({ id: executionWorkspaces.id });
    return stamped.length;
  }

  async function selectEligible(now: Date, limit: number, companyId?: string) {
    return db
      .select({
        id: executionWorkspaces.id,
        companyId: executionWorkspaces.companyId,
        cwd: executionWorkspaces.cwd,
        providerType: executionWorkspaces.providerType,
        providerRef: executionWorkspaces.providerRef,
        branchName: executionWorkspaces.branchName,
        repoUrl: executionWorkspaces.repoUrl,
        baseRef: executionWorkspaces.baseRef,
        projectId: executionWorkspaces.projectId,
        projectWorkspaceId: executionWorkspaces.projectWorkspaceId,
        sourceIssueId: executionWorkspaces.sourceIssueId,
        metadata: executionWorkspaces.metadata,
        cleanupEligibleAt: executionWorkspaces.cleanupEligibleAt,
        projectWorkspaceCwd: projectWorkspaces.cwd,
      })
      .from(executionWorkspaces)
      .innerJoin(companies, and(
        eq(companies.id, executionWorkspaces.companyId),
        eq(companies.status, "active"),
      ))
      .leftJoin(projectWorkspaces, eq(projectWorkspaces.id, executionWorkspaces.projectWorkspaceId))
      .where(and(
        sql`${executionWorkspaces.cleanupEligibleAt} is not null`,
        lte(executionWorkspaces.cleanupEligibleAt, now),
        // Scoped to linked git worktrees. A shared `local_fs` row points at the
        // project's own checkout, which is not this collector's to archive.
        eq(executionWorkspaces.providerType, "git_worktree"),
        lte(executionWorkspaces.lastUsedAt, new Date(now.getTime() - EXECUTION_WORKSPACE_MIN_IDLE_MS)),
        companyId ? eq(executionWorkspaces.companyId, companyId) : undefined,
      ))
      .orderBy(asc(executionWorkspaces.cleanupEligibleAt), asc(executionWorkspaces.id))
      .limit(limit);
  }

  /**
   * One sweep: backfill, then collect everything already eligible.
   *
   * Safe to run concurrently with itself only in the sense that a double
   * `git worktree remove` of the same path is idempotent; the sweep is driven
   * from the single scheduler tick, so it is not designed for fan-out.
   */
  async function reconcileExecutionWorkspaceCleanup(opts?: {
    companyId?: string;
    limit?: number;
    now?: Date;
  }): Promise<ExecutionWorkspaceCleanupResult> {
    const now = opts?.now ?? new Date();
    const limit = opts?.limit ?? 50;

    let stamped = 0;
    try {
      // Unbounded on purpose: stamping is one cheap UPDATE, and the collection
      // loop below is what is rate-limited. Making the whole backlog eligible
      // at once lets it drain at `limit` per tick instead of `limit` per tick
      // *after* a second pass has stamped it.
      stamped = await stampIdleLegacyWorkspaces(now);
    } catch (err) {
      logger.warn({ err }, "reconcileExecutionWorkspaceCleanup: idle backfill failed");
    }

    const candidates = await selectEligible(now, limit, opts?.companyId);
    let collected = 0;
    let skipped = 0;
    let failed = 0;

    for (const candidate of candidates) {
      const worktreePath = candidate.providerRef ?? candidate.cwd;
      try {
        if (candidate.providerType === "git_worktree" && worktreePath) {
          const safety = await inspectWorktreeReclaimSafety(worktreePath);
          if (!safety.safe) {
            // Re-check after another grace window rather than clearing the
            // stamp: a tree that is dirty today is usually collectable once
            // its work is pushed, and clearing would drop it back to the
            // backfill's much longer idle window.
            await db
              .update(executionWorkspaces)
              .set({
                cleanupEligibleAt: new Date(now.getTime() + EXECUTION_WORKSPACE_IDLE_GRACE_MS),
                cleanupReason: `retained_${safety.reason}`,
                updatedAt: now,
              })
              .where(eq(executionWorkspaces.id, candidate.id));
            skipped += 1;
            logger.info(
              {
                executionWorkspaceId: candidate.id,
                worktreePath,
                reason: safety.reason,
                detail: safety.detail,
              },
              "reconcileExecutionWorkspaceCleanup: retained worktree with unreclaimable state",
            );
            continue;
          }
        }

        const cleanup = await cleanupExecutionWorkspaceArtifacts({
          workspace: {
            id: candidate.id,
            cwd: candidate.cwd,
            providerType: candidate.providerType,
            providerRef: candidate.providerRef,
            branchName: candidate.branchName,
            repoUrl: candidate.repoUrl,
            baseRef: candidate.baseRef,
            projectId: candidate.projectId,
            projectWorkspaceId: candidate.projectWorkspaceId,
            sourceIssueId: candidate.sourceIssueId,
            metadata: candidate.metadata ?? null,
          },
          projectWorkspace: candidate.projectWorkspaceCwd
            ? { cwd: candidate.projectWorkspaceCwd, cleanupCommand: null }
            : null,
        });

        await db
          .update(executionWorkspaces)
          .set({
            status: "archived",
            closedAt: now,
            cleanupEligibleAt: null,
            cleanupReason: "collected",
            updatedAt: now,
          })
          .where(eq(executionWorkspaces.id, candidate.id));
        collected += 1;
        logger.info(
          {
            executionWorkspaceId: candidate.id,
            worktreePath,
            warnings: cleanup?.warnings ?? [],
          },
          "reconcileExecutionWorkspaceCleanup: collected execution workspace",
        );
      } catch (err) {
        failed += 1;
        logger.warn(
          { err, executionWorkspaceId: candidate.id, worktreePath },
          "reconcileExecutionWorkspaceCleanup: collection failed",
        );
      }
    }

    return { stamped, scanned: candidates.length, collected, skipped, failed };
  }

  return { reconcileExecutionWorkspaceCleanup, stampIdleLegacyWorkspaces };
}

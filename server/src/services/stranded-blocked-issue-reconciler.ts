/**
 * Stranded-blocked-issue reconciler (BLO-21523, phase 1).
 *
 * Clearing an issue's last `blockedBy` entry does not recompute `status` —
 * see BLO-21523 for the full defect writeup. The eager-recompute fix (phase
 * 2: recompute on blocker-transition) is a separate, more invasive change to
 * the write path and is deliberately not part of this file. This sweep only
 * drains the existing population and keeps it drained: `status = 'blocked'`
 * with no unresolved blocker.
 *
 * Two other mechanisms independently leave an issue `blocked` with zero
 * unresolved blockers, and must not be touched by this sweep or they lose
 * their own wake path:
 *   - the convergence-stall guard (`executionState.monitor.clearReason ===
 *     "convergence_stalled"`, or a non-zero `convergenceStallCount`) —
 *     deliberately blocks a monitor that kept re-checking the same gate.
 *   - an active stranded-run recovery action pointing at the issue itself
 *     (`issue_recovery_actions` row with `status in ('active','escalated')`
 *     and `source_issue_id = issue.id`) — deliberately blocks the issue
 *     while ownership transfers to a new owner after a failed run.
 * A third population — issues blocked directly on a monitor watching
 * external gate signals (`executionState.monitor.gateSignals`) that was
 * never re-armed — never had a `blockedBy` edge in the first place, so
 * there is nothing for this fix to act on; it is excluded too.
 *
 * `blocked` -> `todo` is the target status, per BLO-21523's accepted safe
 * default (not the issue's pre-block status).
 */
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logger as defaultLogger } from "../middleware/logger.js";

/** Rows flipped per batch — keeps each UPDATE's lock window bounded. */
const RECONCILE_BATCH_SIZE = 500;

/** Batches per sweep — backstop against an unbounded loop on a huge backlog. */
const MAX_ITERATIONS = 50;

export interface StrandedBlockedIssueReconcileResult {
  reconciled: number;
  iterations: number;
}

/**
 * Flip `status = 'blocked'` -> `'todo'` for issues with zero unresolved
 * blockers, excluding the guard/recovery/monitor-gated populations described
 * above. Idempotent and safe to call on any schedule from any number of
 * replicas: the predicate is re-evaluated inside the `UPDATE ... WHERE`
 * itself, so a row already flipped (or claimed by a concurrent run) simply
 * fails to match on the next pass.
 */
export async function reconcileStrandedBlockedIssues(
  db: Db,
  options: { batchSize?: number; maxIterations?: number; logger?: typeof defaultLogger } = {},
): Promise<StrandedBlockedIssueReconcileResult> {
  const batchSize = options.batchSize ?? RECONCILE_BATCH_SIZE;
  const maxIterations = options.maxIterations ?? MAX_ITERATIONS;
  const log = options.logger ?? defaultLogger;

  let reconciled = 0;
  let iterations = 0;

  while (iterations < maxIterations) {
    const rows = await db.execute(sql<{ id: string; identifier: string | null }>`
      WITH candidates AS (
        SELECT i.id
        FROM issues i
        WHERE i.status = 'blocked'
          AND NOT EXISTS (
            SELECT 1
            FROM issue_relations r
            JOIN issues b ON b.id = r.issue_id
            WHERE r.related_issue_id = i.id
              AND r.type = 'blocks'
              AND r.company_id = i.company_id
              AND b.status <> 'done'
          )
          AND COALESCE(
            CASE
              WHEN jsonb_typeof(i.execution_state -> 'monitor' -> 'gateSignals') = 'array'
                THEN jsonb_array_length(i.execution_state -> 'monitor' -> 'gateSignals')
              ELSE 0
            END,
            0
          ) = 0
          AND COALESCE(i.execution_state -> 'monitor' ->> 'clearReason', '') <> 'convergence_stalled'
          AND COALESCE(
            CASE
              WHEN (i.execution_state -> 'monitor' ->> 'convergenceStallCount') ~ '^-?[0-9]+$'
                THEN (i.execution_state -> 'monitor' ->> 'convergenceStallCount')::int
              ELSE 0
            END,
            0
          ) = 0
          AND (i.execution_state -> 'monitor' ->> 'convergenceStalledAssigneeAgentId') IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM issue_recovery_actions ra
            WHERE ra.source_issue_id = i.id
              AND ra.status IN ('active', 'escalated')
          )
        LIMIT ${batchSize}
      )
      UPDATE issues
      SET status = 'todo', updated_at = now()
      WHERE id IN (SELECT id FROM candidates)
      RETURNING id, identifier
    `);

    const flipped = Array.isArray(rows) ? rows : Array.from(rows as Iterable<{ id: string; identifier: string | null }>);
    reconciled += flipped.length;
    iterations += 1;

    if (flipped.length > 0) {
      log.info(
        { reconciled: flipped.length, sample: flipped.slice(0, 10).map((r) => r.identifier ?? r.id) },
        "stranded-blocked-issue reconciler flipped blocked issues with zero unresolved blockers to todo (BLO-21523)",
      );
    }

    if (flipped.length < batchSize) break;
  }

  if (iterations >= maxIterations) {
    log.warn(
      { reconciled, iterations },
      "stranded-blocked-issue reconciler hit its iteration cap; some stranded issues may remain until the next sweep",
    );
  }

  return { reconciled, iterations };
}

/**
 * Start a periodic sweep. Mirrors `startPluginLogRetention` /
 * `reconcilerSweepTick` (pr-reconciler-sweep.ts): run once immediately so the
 * backlog starts draining without waiting a full interval, then on the
 * configured cadence. Returns a stop function.
 */
export function startStrandedBlockedIssueReconciler(
  db: Db,
  intervalMs: number,
  options: { batchSize?: number; maxIterations?: number } = {},
): () => void {
  const runTick = () =>
    void reconcileStrandedBlockedIssues(db, options).catch((err) => {
      defaultLogger.error({ err }, "stranded-blocked-issue reconciler sweep failed");
    });

  runTick();
  const timer = setInterval(runTick, intervalMs);
  return () => clearInterval(timer);
}

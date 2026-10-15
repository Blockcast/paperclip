import { and, eq, gte, isNotNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  setWorkspaceReuseRefusalMetricsRefreshSuccess,
  setWorkspaceReuseRefusalWindowMetrics,
} from "./metrics.js";
import {
  classifyWorkspaceReuseRefusal,
  WORKSPACE_REUSE_REFUSAL_MARKERS,
  type WorkspaceReuseRefusalClass,
} from "./workspace-reuse-refusal-class.js";

/**
 * PEN-3633 item 3. Window over which refusals are aggregated.
 *
 * Sized off the measured episodes rather than picked round. Episode 2
 * (2026-10-05) ran 33 refusals over 8.6 h -- ~3.8/h -- so a 1 h window would
 * hold ~4 and a threshold set anywhere safely above background noise would
 * have missed it. At 2 h the same episode presents ~7.7, which clears a
 * 3-refusal threshold with margin while a lone transient refusal (the common
 * benign case: one agent, one bad cwd, self-healing) never does.
 *
 * It is a WINDOW, not a rate: the unit of failure is the project checkout and
 * the unit of reporting is the run, so what matters is how many runs one
 * checkout has refused recently, not how fast.
 */
export const WORKSPACE_REUSE_REFUSAL_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Refusals this sweep will read at most, newest first.
 *
 * The limit is applied AFTER the marker prefilter below, so it bounds members
 * of this class rather than failed runs in general. That distinction is the
 * whole safety of the number: applied to all failures it was a silent
 * undercount waiting to happen -- 5000 unrelated failures in one 2h window
 * would have pushed the refusals off the end and walked the count DOWN with no
 * sign of it, which on a `>=` threshold alert reads as recovery. Applied to
 * refusals it is a cardinality bound on a population that measured ~33 over
 * 8.6h at its worst, so reaching it means something unprecedented is happening
 * and the sweep says so rather than quietly truncating. (Ally on #2750.)
 */
const WORKSPACE_REUSE_REFUSAL_SCAN_LIMIT = 5000;

/**
 * SQL-side membership prefilter, built from the classifier's own marker list.
 *
 * `strpos`, not `LIKE`: it is exactly `String.prototype.includes` with no
 * wildcard metacharacters to escape, so the SQL predicate and the TypeScript
 * classifier cannot disagree about what a marker means. The filter is a
 * SUPERSET of what `classifyWorkspaceReuseRefusal` accepts by construction --
 * same list, same test -- so nothing it drops could have been classified.
 */
function errorBodyCarriesRefusalMarker() {
  return or(
    ...WORKSPACE_REUSE_REFUSAL_MARKERS.map(
      (marker) => sql`strpos(${heartbeatRuns.error}, ${marker}) > 0`,
    ),
  );
}

export type WorkspaceReuseRefusalWindowEntry = {
  projectWorkspaceId: string;
  failureClass: WorkspaceReuseRefusalClass;
  count: number;
};

/**
 * Count recent managed-checkout refusals per `project_workspace_id`, bucketed
 * on the error BODY.
 *
 * Why the body and not `error_code`: both measured episodes bucket as
 * `setup_failed`, so `error_code` cannot separate them from each other or from
 * every unrelated setup failure. The classification is therefore done here, in
 * SQL-adjacent TypeScript, against the shared markers the producers themselves
 * build their messages from (`workspace-reuse-refusal-class.ts`).
 *
 * Why a gauge recomputed per tick rather than a counter: a labelled counter
 * created on first increment is born at its first value, which makes
 * `increase(...)` over it permanently silent for the very first episode on a
 * given `project_workspace_id` -- precisely the case this alert exists for. A
 * reset-then-set gauge has no such blind spot, and an absent series is
 * unambiguously "no refusals in the window" because the alert is a `>=`
 * threshold that absence can never satisfy.
 *
 * Why it is cheap enough to run on every tick: migration 0259 adds
 * `heartbeat_runs_failed_finished_at_idx`, a partial index on
 * `(finished_at, id) WHERE status = 'failed'`. Without it no index fits this
 * predicate at all -- every `status`-bearing index on the table leads with
 * `company_id` and this sweep is fleet-wide. The cost of getting that wrong is
 * not local: the collector runs its refreshes in SERIES within a tick and ticks
 * do not overlap, so a slow query here delays every gauge after it and, past
 * 15s, the next tick entirely -- while holding one of ten pool connections for
 * the duration. Pool contention on this path is the exact failure BLO-33243
 * moved off the scrape handler. (Ally on #2750.)
 *
 * Why this does not wait on a dispatch: the sweep reads finished runs on the
 * collector tick. A project whose checkout is broken stops dispatching
 * successfully, so any detector that needed a NEW successful run to report
 * would go quiet exactly when the fault got worse.
 */
export async function refreshWorkspaceReuseRefusalMetrics(
  db: Db,
  now = new Date(),
): Promise<void> {
  try {
    const windowStart = new Date(now.getTime() - WORKSPACE_REUSE_REFUSAL_WINDOW_MS);

    const rows = await db
      .select({
        projectWorkspaceId: issues.projectWorkspaceId,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      // `contextIssueId` is a generated column over `context_snapshot->>'issueId'`
      // and is therefore TEXT, while `issues.id` is UUID. The cast goes on
      // `issues.id` deliberately: casting the run side to uuid would make a
      // single malformed snapshot value abort the whole sweep, which would
      // surface as a refresh failure rather than as the data it is.
      .innerJoin(issues, eq(heartbeatRuns.contextIssueId, sql<string>`${issues.id}::text`))
      .where(
        and(
          eq(heartbeatRuns.status, "failed"),
          gte(heartbeatRuns.finishedAt, windowStart),
          isNotNull(heartbeatRuns.error),
          isNotNull(issues.projectWorkspaceId),
          errorBodyCarriesRefusalMarker(),
        ),
      )
      // `id` breaks the tie so the scan-limit cut is deterministic among
      // same-instant rows rather than arbitrary, and the pair matches
      // `heartbeat_runs_failed_finished_at_idx` exactly, so the whole ORDER BY
      // is a backward index scan with no sort step.
      .orderBy(sql`${heartbeatRuns.finishedAt} desc, ${heartbeatRuns.id} desc`)
      .limit(WORKSPACE_REUSE_REFUSAL_SCAN_LIMIT);

    if (rows.length >= WORKSPACE_REUSE_REFUSAL_SCAN_LIMIT) {
      // Not a sweep failure -- every row read was counted, so the snapshot stays
      // fresh and the alert keeps working. But the counts are now a LOWER bound,
      // and the one thing this sweep must never do is let a count drift down
      // unannounced. Say so where it can be read after the fact.
      logger.warn(
        { scanLimit: WORKSPACE_REUSE_REFUSAL_SCAN_LIMIT, windowMs: WORKSPACE_REUSE_REFUSAL_WINDOW_MS },
        "workspace-reuse refusal sweep hit its scan limit; per-project counts are a lower bound",
      );
    }

    const counts = new Map<string, WorkspaceReuseRefusalWindowEntry>();
    for (const row of rows) {
      const failureClass = classifyWorkspaceReuseRefusal(row.error);
      if (!failureClass) continue;
      const projectWorkspaceId = row.projectWorkspaceId;
      if (!projectWorkspaceId) continue;
      const key = `${projectWorkspaceId}\u0000${failureClass}`;
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { projectWorkspaceId, failureClass, count: 1 });
    }

    setWorkspaceReuseRefusalWindowMetrics([...counts.values()]);
    setWorkspaceReuseRefusalMetricsRefreshSuccess(true);
  } catch (error) {
    // Same contract as refreshExternalRuntimeReservationStrandMetrics: do NOT
    // publish synthetic zeros on failure. Zeroing would read as "this project
    // stopped refusing", which is the one conclusion a failed sweep cannot
    // support. The freshness gauge makes the stale snapshot ineligible for the
    // alert and pages its own failure instead.
    setWorkspaceReuseRefusalMetricsRefreshSuccess(false);
    throw error;
  }
}

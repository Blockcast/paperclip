import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  documentRevisions,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  issueWorkProducts,
  workspaceOperations,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { classifyRunLiveness } from "./run-liveness.js";

export interface ActivityFilters {
  companyId: string;
  agentId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  /** Actions left off the page. The route sets this; see `FEED_EXCLUDED_ACTIONS`. */
  excludeActions?: readonly string[];
  limit?: number;
}

const DEFAULT_ACTIVITY_LIMIT = 100;
const MAX_ACTIVITY_LIMIT = 500;

export function normalizeActivityLimit(limit: number | undefined) {
  if (!Number.isFinite(limit)) return DEFAULT_ACTIVITY_LIMIT;
  return Math.max(1, Math.min(MAX_ACTIVITY_LIMIT, Math.floor(limit ?? DEFAULT_ACTIVITY_LIMIT)));
}

/**
 * Second, independent bound on `runsForIssue` (PEN-6670).
 *
 * The union arms below make the query's cost scale with the ISSUE's run count
 * rather than the COMPANY's, which is the fix. This cap exists so the route
 * degrades — returns a capped page — rather than 503ing, if some row ever
 * accumulates a run history large enough to matter again. It is set well above
 * the observed per-issue maximum on purpose: it is a backstop, not a page size.
 *
 * A caller that gets exactly `limit` rows back may be looking at a capped page;
 * the route echoes the bound actually applied in `X-Applied-Limit`.
 */
export const DEFAULT_ISSUE_RUNS_LIMIT = 500;
export const MAX_ISSUE_RUNS_LIMIT = 1000;

export function normalizeIssueRunsLimit(limit: number | undefined) {
  if (!Number.isFinite(limit)) return DEFAULT_ISSUE_RUNS_LIMIT;
  return Math.max(1, Math.min(MAX_ISSUE_RUNS_LIMIT, Math.floor(limit ?? DEFAULT_ISSUE_RUNS_LIMIT)));
}

/**
 * The set of heartbeat-run ids belonging to one issue, as a UNION of two
 * independently indexable arms (PEN-6670).
 *
 * ⛔ DO NOT COLLAPSE THIS BACK INTO `or(contextSnapshot match, exists(...))`.
 * That shape is what this replaces, and it was 503ing `GET /api/issues/:id/runs`
 * with `57014` at ~85 events/h on 2026-11-14.
 *
 * The mechanism, read off `EXPLAIN (ANALYZE, BUFFERS)` on a 905,300-run seed
 * (`packages/db/src/runs-for-issue-plan-shape.bench.ts`) — and note it is NOT
 * what it looks like. PostgreSQL pulls the correlated `exists(...)` UP into an
 * uncorrelated `hashed SubPlan`, so the subquery runs ONCE, in ~4ms, not once
 * per outer row; de-correlating it by hand buys nothing. The damage is that a
 * semi-join cannot take part in a `BitmapOr`, so the whole disjunction can only
 * be applied as a per-row FILTER — and the only access path left for the outer
 * query is `heartbeat_runs_company_created_at_desc_idx` under
 * `Index Cond: (company_id = ...)` alone. Measured: 904,794 of 905,300 rows
 * read and thrown away by that filter, 48,522 buffers, 1,369.8ms, to return
 * 506 rows. The partial expression index that exists for arm 1
 * (`heartbeat_runs_company_issueid_idx`, migration 0077) is never chosen,
 * because the OR puts it out of reach. Cost scaled with the COMPANY's total
 * run history, a monotonically growing number, which is why this degraded over
 * time rather than being slow from the start.
 *
 * With the arms unioned, both are index-driven — `heartbeat_runs_company_issueid_idx`
 * for arm 1, `activity_log_entity_type_id_idx` for arm 2 — and the outer query
 * becomes a pk lookup per surviving id: 2,603 buffers, 16.3ms, same rows. ~84x.
 *
 * Resolving each arm into its own id set first is the same transformation
 * PEN-3596 applied to the issues-list search (`issueSearchArmsSubquery`), for
 * the same reason. `UNION` (not `UNION ALL`) because the two arms overlap
 * heavily — a run usually both carries the issue in its context snapshot and
 * writes activity rows against it — and the outer `IN` wants distinct ids.
 *
 * ⚠️ The arms re-introduce `heartbeat_runs` and `activity_log` in their own
 * FROM clauses, so every column reference inside binds to the INNER scope and
 * the subquery is uncorrelated. That is load-bearing: a reference that reached
 * the outer `heartbeat_runs` would re-correlate this and restore the defect.
 * `issues-service.test.ts` (PEN-3596) guards the sibling query the same way;
 * `activity-service.test.ts` guards this one.
 */
export function issueRunIdsSubquery(companyId: string, issueId: string) {
  return sql`(
      select ${heartbeatRuns.id} as run_id
      from ${heartbeatRuns}
      where ${heartbeatRuns.companyId} = ${companyId}
        and ${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}
      union
      select ${activityLog.runId} as run_id
      from ${activityLog}
      where ${activityLog.companyId} = ${companyId}
        and ${activityLog.entityType} = 'issue'
        and ${activityLog.entityId} = ${issueId}
        and ${activityLog.runId} is not null
    )`;
}

/** `heartbeat_runs` row belongs to this issue — see `issueRunIdsSubquery`. */
export function runBelongsToIssue(companyId: string, issueId: string) {
  return sql`${heartbeatRuns.id} in ${issueRunIdsSubquery(companyId, issueId)}`;
}

export function activityService(db: Db) {
  const scheduledLivenessBackfills = new Set<string>();
  const issueIdAsText = sql<string>`${issues.id}::text`;
  const summarizedUsageJson = sql<Record<string, unknown> | null>`
    case
      when ${heartbeatRuns.usageJson} is null then null
      else jsonb_strip_nulls(jsonb_build_object(
        'inputTokens', coalesce(${heartbeatRuns.usageJson} -> 'inputTokens', ${heartbeatRuns.usageJson} -> 'input_tokens'),
        'input_tokens', coalesce(${heartbeatRuns.usageJson} -> 'input_tokens', ${heartbeatRuns.usageJson} -> 'inputTokens'),
        'outputTokens', coalesce(${heartbeatRuns.usageJson} -> 'outputTokens', ${heartbeatRuns.usageJson} -> 'output_tokens'),
        'output_tokens', coalesce(${heartbeatRuns.usageJson} -> 'output_tokens', ${heartbeatRuns.usageJson} -> 'outputTokens'),
        'cachedInputTokens', coalesce(
          ${heartbeatRuns.usageJson} -> 'cachedInputTokens',
          ${heartbeatRuns.usageJson} -> 'cached_input_tokens',
          ${heartbeatRuns.usageJson} -> 'cache_read_input_tokens'
        ),
        'cached_input_tokens', coalesce(
          ${heartbeatRuns.usageJson} -> 'cached_input_tokens',
          ${heartbeatRuns.usageJson} -> 'cachedInputTokens',
          ${heartbeatRuns.usageJson} -> 'cache_read_input_tokens'
        ),
        'cache_read_input_tokens', coalesce(
          ${heartbeatRuns.usageJson} -> 'cache_read_input_tokens',
          ${heartbeatRuns.usageJson} -> 'cached_input_tokens',
          ${heartbeatRuns.usageJson} -> 'cachedInputTokens'
        ),
        'cacheCreationInputTokens', coalesce(
          ${heartbeatRuns.usageJson} -> 'cacheCreationInputTokens',
          ${heartbeatRuns.usageJson} -> 'cache_creation_input_tokens'
        ),
        'cache_creation_input_tokens', coalesce(
          ${heartbeatRuns.usageJson} -> 'cache_creation_input_tokens',
          ${heartbeatRuns.usageJson} -> 'cacheCreationInputTokens'
        ),
        'billingType', coalesce(${heartbeatRuns.usageJson} -> 'billingType', ${heartbeatRuns.usageJson} -> 'billing_type'),
        'billing_type', coalesce(${heartbeatRuns.usageJson} -> 'billing_type', ${heartbeatRuns.usageJson} -> 'billingType'),
        'costUsd', coalesce(
          ${heartbeatRuns.usageJson} -> 'costUsd',
          ${heartbeatRuns.usageJson} -> 'cost_usd',
          ${heartbeatRuns.usageJson} -> 'total_cost_usd'
        ),
        'cost_usd', coalesce(
          ${heartbeatRuns.usageJson} -> 'cost_usd',
          ${heartbeatRuns.usageJson} -> 'costUsd',
          ${heartbeatRuns.usageJson} -> 'total_cost_usd'
        ),
        'total_cost_usd', coalesce(
          ${heartbeatRuns.usageJson} -> 'total_cost_usd',
          ${heartbeatRuns.usageJson} -> 'cost_usd',
          ${heartbeatRuns.usageJson} -> 'costUsd'
        )
      ))
    end
  `.as("usageJson");
  const summarizedResultJson = sql<Record<string, unknown> | null>`
    case
      when ${heartbeatRuns.resultJson} is null then null
      else jsonb_strip_nulls(jsonb_build_object(
        'billingType', coalesce(${heartbeatRuns.resultJson} -> 'billingType', ${heartbeatRuns.resultJson} -> 'billing_type'),
        'billing_type', coalesce(${heartbeatRuns.resultJson} -> 'billing_type', ${heartbeatRuns.resultJson} -> 'billingType'),
        'costUsd', coalesce(
          ${heartbeatRuns.resultJson} -> 'costUsd',
          ${heartbeatRuns.resultJson} -> 'cost_usd',
          ${heartbeatRuns.resultJson} -> 'total_cost_usd'
        ),
        'cost_usd', coalesce(
          ${heartbeatRuns.resultJson} -> 'cost_usd',
          ${heartbeatRuns.resultJson} -> 'costUsd',
          ${heartbeatRuns.resultJson} -> 'total_cost_usd'
        ),
        'total_cost_usd', coalesce(
          ${heartbeatRuns.resultJson} -> 'total_cost_usd',
          ${heartbeatRuns.resultJson} -> 'cost_usd',
          ${heartbeatRuns.resultJson} -> 'costUsd'
        ),
        'stopReason', ${heartbeatRuns.resultJson} -> 'stopReason',
        'effectiveTimeoutSec', ${heartbeatRuns.resultJson} -> 'effectiveTimeoutSec',
        'effectiveTimeoutMs', ${heartbeatRuns.resultJson} -> 'effectiveTimeoutMs',
        'timeoutConfigured', ${heartbeatRuns.resultJson} -> 'timeoutConfigured',
        'timeoutSource', ${heartbeatRuns.resultJson} -> 'timeoutSource',
        'timeoutFired', ${heartbeatRuns.resultJson} -> 'timeoutFired'
      ))
    end
  `.as("resultJson");

  function countValue(value: unknown) {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }

  function dateValue(value: unknown) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === "string" || typeof value === "number") {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  }

  function latestDate(...values: unknown[]) {
    let latest: Date | null = null;
    for (const value of values) {
      const parsed = dateValue(value);
      if (!parsed) continue;
      if (!latest || parsed.getTime() > latest.getTime()) latest = parsed;
    }
    return latest;
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  function readNumber(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  async function backfillMissingRunLivenessForIssue(companyId: string, issueId: string) {
    const runs = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        resultJson: heartbeatRuns.resultJson,
        stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
        stderrExcerpt: heartbeatRuns.stderrExcerpt,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        continuationAttempt: heartbeatRuns.continuationAttempt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          isNull(heartbeatRuns.livenessState),
          sql`${heartbeatRuns.status} not in ('queued', 'running')`,
          // ⚠️ PEN-6670 DELIBERATELY LEAVES THIS ONE ALONE, and the reason is a
          // measurement that refuted the obvious guess. This is the same
          // OR-over-a-correlated-EXISTS shape `runsForIssue` had, so it looks
          // like the same defect — it is not, because the predicate ABOVE it is
          // different. `heartbeat_runs_company_liveness_idx` (migration 0058,
          // `(company_id, liveness_state, created_at)`) drives this query off
          // `liveness_state IS NULL`, so the OR never has to be the access path:
          // the EXISTS runs as a cheap point probe on `activity_log_run_id_idx`
          // for each of the few candidate rows, and `limit(20)` is a real bound.
          // Measured on a 905,300-run seed in the steady state (every run already
          // backfilled): 3 buffers, 0.077ms, total cost 18.68. Rewriting it to the
          // union arms made the plan WORSE — a nested loop whose inner side builds
          // the whole issue's id set, total cost 9,545.42, to answer a question one
          // index probe already answers. The control arm is in the bench above.
          or(
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
            sql`exists (
              select 1
              from ${activityLog}
              where ${activityLog.companyId} = ${companyId}
                and ${activityLog.entityType} = 'issue'
                and ${activityLog.entityId} = ${issueId}
                and ${activityLog.runId} = ${heartbeatRuns.id}
            )`,
          ),
        ),
      )
      .limit(20);

    if (runs.length === 0) return;

    const issue = await db
      .select({
        status: issues.status,
        title: issues.title,
        description: issues.description,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
      .then((rows) => rows[0] ?? null);

    for (const run of runs) {
      const context = asRecord(run.contextSnapshot);
      const continuationAttempt =
        readNumber(context?.continuationAttempt) ??
        readNumber(context?.livenessContinuationAttempt) ??
        run.continuationAttempt ??
        0;

      const [commentStats] = await db
        .select({
          count: sql<number>`count(*)::int`,
          latestAt: sql<Date | null>`max(${issueComments.createdAt})`,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            eq(issueComments.issueId, issueId),
            eq(issueComments.createdByRunId, run.id),
          ),
        );

      const [documentStats] = await db
        .select({
          count: sql<number>`count(*)::int`,
          planCount: sql<number>`count(*) filter (where ${issueDocuments.key} = 'plan')::int`,
          latestAt: sql<Date | null>`max(${documentRevisions.createdAt})`,
        })
        .from(documentRevisions)
        .innerJoin(issueDocuments, eq(documentRevisions.documentId, issueDocuments.documentId))
        .where(
          and(
            eq(documentRevisions.companyId, companyId),
            eq(documentRevisions.createdByRunId, run.id),
            eq(issueDocuments.companyId, companyId),
            eq(issueDocuments.issueId, issueId),
            sql`${issueDocuments.key} != ${ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY}`,
          ),
        );

      const [workProductStats] = await db
        .select({
          count: sql<number>`count(*)::int`,
          latestAt: sql<Date | null>`max(${issueWorkProducts.createdAt})`,
        })
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, companyId),
            eq(issueWorkProducts.issueId, issueId),
            eq(issueWorkProducts.createdByRunId, run.id),
          ),
        );

      const [workspaceOperationStats] = await db
        .select({
          count: sql<number>`count(*)::int`,
          latestAt: sql<Date | null>`max(${workspaceOperations.startedAt})`,
        })
        .from(workspaceOperations)
        .where(and(eq(workspaceOperations.companyId, companyId), eq(workspaceOperations.heartbeatRunId, run.id)));

      const [activityStats] = await db
        .select({
          count: sql<number>`count(*)::int`,
          latestAt: sql<Date | null>`max(${activityLog.createdAt})`,
        })
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, run.id)));

      const [eventStats] = await db
        .select({
          count: sql<number>`count(*) filter (where ${heartbeatRunEvents.eventType} not in ('lifecycle', 'adapter.invoke', 'error'))::int`,
          latestAt: sql<Date | null>`max(${heartbeatRunEvents.createdAt}) filter (where ${heartbeatRunEvents.eventType} not in ('lifecycle', 'adapter.invoke', 'error'))`,
        })
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, run.id)));

      const classification = classifyRunLiveness({
        runStatus: run.status,
        issue,
        resultJson: asRecord(run.resultJson),
        stdoutExcerpt: run.stdoutExcerpt,
        stderrExcerpt: run.stderrExcerpt,
        error: run.error,
        errorCode: run.errorCode,
        continuationAttempt,
        evidence: {
          issueCommentsCreated: countValue(commentStats?.count),
          documentRevisionsCreated: countValue(documentStats?.count),
          planDocumentRevisionsCreated: countValue(documentStats?.planCount),
          workProductsCreated: countValue(workProductStats?.count),
          workspaceOperationsCreated: countValue(workspaceOperationStats?.count),
          activityEventsCreated: countValue(activityStats?.count),
          toolOrActionEventsCreated: countValue(eventStats?.count),
          latestEvidenceAt: latestDate(
            commentStats?.latestAt,
            documentStats?.latestAt,
            workProductStats?.latestAt,
            workspaceOperationStats?.latestAt,
            activityStats?.latestAt,
            eventStats?.latestAt,
          ),
        },
      });

      await db
        .update(heartbeatRuns)
        .set({
          livenessState: classification.livenessState,
          livenessReason: classification.livenessReason,
          continuationAttempt: classification.continuationAttempt,
          lastUsefulActionAt: classification.lastUsefulActionAt,
          nextAction: classification.nextAction,
          updatedAt: new Date(),
        })
        .where(and(eq(heartbeatRuns.id, run.id), isNull(heartbeatRuns.livenessState)));
    }
  }

  function scheduleRunLivenessBackfill(companyId: string, issueId: string) {
    const key = `${companyId}:${issueId}`;
    if (scheduledLivenessBackfills.has(key)) return;
    scheduledLivenessBackfills.add(key);
    void backfillMissingRunLivenessForIssue(companyId, issueId)
      .catch((err: unknown) => {
        logger.warn({ err, companyId, issueId }, "run liveness backfill failed");
      })
      .finally(() => {
        scheduledLivenessBackfills.delete(key);
      });
  }

  return {
    list: (filters: ActivityFilters) => {
      const conditions = [eq(activityLog.companyId, filters.companyId)];
      const limit = normalizeActivityLimit(filters.limit);

      // `!== undefined` (not truthiness): an explicitly-passed empty string must still narrow the
      // query to zero rows rather than silently falling through to the unfiltered feed (BLO-21979).
      if (filters.agentId !== undefined) {
        conditions.push(eq(activityLog.agentId, filters.agentId));
      }
      if (filters.entityType !== undefined) {
        conditions.push(eq(activityLog.entityType, filters.entityType));
      }
      if (filters.entityId !== undefined) {
        conditions.push(eq(activityLog.entityId, filters.entityId));
      }
      if (filters.action !== undefined) {
        conditions.push(eq(activityLog.action, filters.action));
      }
      if (filters.excludeActions?.length) {
        conditions.push(notInArray(activityLog.action, [...filters.excludeActions]));
      }

      return db
        .select({ activityLog })
        .from(activityLog)
        .leftJoin(
          issues,
          and(
            eq(activityLog.entityType, sql`'issue'`),
            eq(activityLog.entityId, issueIdAsText),
          ),
        )
        .where(
          and(
            ...conditions,
            or(
              sql`${activityLog.entityType} != 'issue'`,
              visibleIssueCondition(),
            ),
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .limit(limit)
        .then((rows) => rows.map((r) => r.activityLog));
    },

    /**
     * Unlimited, newest-first activity for one issue.
     *
     * Comment coverage here is partial by construction — system-authored
     * comments never produce an `issue.comment_added` row and unkeyed route
     * comments can lose theirs. See the route docblock in
     * `routes/activity.ts` and `docs/api/activity.md` (PEN-5158) before
     * treating an absence as evidence.
     */
    forIssue: (issueId: string) =>
      db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueId),
          ),
        )
        .orderBy(desc(activityLog.createdAt)),

    runsForIssue: async (companyId: string, issueId: string, options?: { limit?: number }) => {
      scheduleRunLivenessBackfill(companyId, issueId);
      const limit = normalizeIssueRunsLimit(options?.limit);
      const runs = await db
        .select({
          runId: heartbeatRuns.id,
          status: heartbeatRuns.status,
          agentId: heartbeatRuns.agentId,
          adapterType: agents.adapterType,
          startedAt: heartbeatRuns.startedAt,
          finishedAt: heartbeatRuns.finishedAt,
          createdAt: heartbeatRuns.createdAt,
          invocationSource: heartbeatRuns.invocationSource,
          responsibleUserId: heartbeatRuns.responsibleUserId,
          errorCode: heartbeatRuns.errorCode,
          usageJson: summarizedUsageJson,
          resultJson: summarizedResultJson,
          logBytes: heartbeatRuns.logBytes,
          retryOfRunId: heartbeatRuns.retryOfRunId,
          scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
          scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
          scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
          livenessState: heartbeatRuns.livenessState,
          livenessReason: heartbeatRuns.livenessReason,
          continuationAttempt: heartbeatRuns.continuationAttempt,
          lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
          nextAction: heartbeatRuns.nextAction,
        })
        .from(heartbeatRuns)
        .innerJoin(
          agents,
          and(
            eq(agents.id, heartbeatRuns.agentId),
            eq(agents.companyId, heartbeatRuns.companyId),
          ),
        )
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            runBelongsToIssue(companyId, issueId),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(limit);

      if (runs.length === 0) return runs;
      const runIds = runs.map((run) => run.runId);
      if (runIds.length === 0) return runs;

      const exhaustionRows = await db
        .select({
          runId: heartbeatRunEvents.runId,
          message: heartbeatRunEvents.message,
        })
        .from(heartbeatRunEvents)
        .where(
          and(
            inArray(heartbeatRunEvents.runId, runIds),
            eq(heartbeatRunEvents.eventType, "lifecycle"),
            sql`${heartbeatRunEvents.message} like 'Bounded retry exhausted%'`,
          ),
        )
        .orderBy(asc(heartbeatRunEvents.runId), desc(heartbeatRunEvents.id));

      const retryExhaustedReasonByRunId = new Map<string, string>();
      for (const row of exhaustionRows) {
        if (!row.message || retryExhaustedReasonByRunId.has(row.runId)) continue;
        retryExhaustedReasonByRunId.set(row.runId, row.message);
      }

      const leaseRows = await db
        .select({
          lease: environmentLeases,
          environment: {
            id: environments.id,
            name: environments.name,
            driver: environments.driver,
          },
        })
        .from(environmentLeases)
        .innerJoin(environments, eq(environmentLeases.environmentId, environments.id))
        .where(
          and(
            eq(environmentLeases.companyId, companyId),
            inArray(environmentLeases.heartbeatRunId, runIds),
          ),
        )
        .orderBy(desc(environmentLeases.lastUsedAt), desc(environmentLeases.createdAt));

      const leaseByRunId = new Map<string, (typeof leaseRows)[number]>();
      for (const row of leaseRows) {
        if (row.lease.heartbeatRunId && !leaseByRunId.has(row.lease.heartbeatRunId)) {
          leaseByRunId.set(row.lease.heartbeatRunId, row);
        }
      }

      return runs.map((run) => {
        const leaseRow = leaseByRunId.get(run.runId);
        const leaseMetadata = leaseRow?.lease.metadata ?? null;
        const workspacePath =
          typeof leaseMetadata?.remoteCwd === "string" && leaseMetadata.remoteCwd.trim().length > 0
            ? leaseMetadata.remoteCwd
            : typeof leaseMetadata?.remoteWorkspacePath === "string" && leaseMetadata.remoteWorkspacePath.trim().length > 0
              ? leaseMetadata.remoteWorkspacePath
              : null;
        return {
          ...run,
          environment: leaseRow
            ? {
                id: leaseRow.environment.id,
                name: leaseRow.environment.name,
                driver: leaseRow.environment.driver,
              }
            : null,
          environmentLease: leaseRow
            ? {
                id: leaseRow.lease.id,
                status: leaseRow.lease.status,
                leasePolicy: leaseRow.lease.leasePolicy,
                provider: leaseRow.lease.provider,
                providerLeaseId: leaseRow.lease.providerLeaseId,
                executionWorkspaceId: leaseRow.lease.executionWorkspaceId,
                workspacePath,
                failureReason: leaseRow.lease.failureReason,
                cleanupStatus: leaseRow.lease.cleanupStatus,
                acquiredAt: leaseRow.lease.acquiredAt,
                releasedAt: leaseRow.lease.releasedAt,
              }
            : null,
          retryExhaustedReason: retryExhaustedReasonByRunId.get(run.runId) ?? null,
        };
      });
    },

    issuesForRun: async (runId: string) => {
      const run = await db
        .select({
          companyId: heartbeatRuns.companyId,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      if (!run) return [];

      const fromActivity = await db
        .selectDistinctOn([issueIdAsText], {
          issueId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
        })
        .from(activityLog)
        .innerJoin(issues, eq(activityLog.entityId, issueIdAsText))
        .where(
          and(
            eq(activityLog.companyId, run.companyId),
            eq(activityLog.runId, runId),
            eq(activityLog.entityType, "issue"),
            visibleIssueCondition(),
          ),
        )
        .orderBy(issueIdAsText);

      const context = run.contextSnapshot;
      const contextIssueId =
        context && typeof context === "object" && typeof (context as Record<string, unknown>).issueId === "string"
          ? ((context as Record<string, unknown>).issueId as string)
          : null;
      if (!contextIssueId) return fromActivity;
      if (fromActivity.some((issue) => issue.issueId === contextIssueId)) return fromActivity;

      const fromContext = await db
        .select({
          issueId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, run.companyId),
            eq(issues.id, contextIssueId),
            visibleIssueCondition(),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!fromContext) return fromActivity;
      return [fromContext, ...fromActivity];
    },

    create: (data: typeof activityLog.$inferInsert) =>
      db
        .insert(activityLog)
        .values(data)
        .returning()
        .then((rows) => rows[0]),
  };
}

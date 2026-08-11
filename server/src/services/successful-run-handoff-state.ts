import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agentWakeupRequests, heartbeatRuns } from "@paperclipai/db";
import type { SuccessfulRunHandoffState } from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";

export const SUCCESSFUL_RUN_HANDOFF_LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
export const SUCCESSFUL_RUN_HANDOFF_LIVE_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed"] as const;

// BLO-24190: how long a run that has never started may still be reported as a
// live continuation.
//
// Membership in SUCCESSFUL_RUN_HANDOFF_LIVE_RUN_STATUSES alone is not evidence
// that anything is carrying the issue forward: `queued` and `scheduled_retry`
// both cover rows with `startedAt: null`, and neither status carries an age. A
// corrective run that is merely enqueued behind a backlog therefore reported
// `hasLiveContinuation: true` indefinitely — on BLO-23010 for 21h, and again
// for a `dependency_blocked` retry that had already been parked past 8h.
//
// Deliberately the same 6h as STALE_PRE_CLAIM_ISSUE_LOCK_MS in
// recovery/service.ts (kept local rather than imported: this is a read-path
// projection and must not pull in the recovery service). That is the point past
// which sweepStaleIssueLocks reaps such a run's issue lock as stale, so a
// longer bound here would have this surface calling a run "live" that the
// platform had already written off — which is exactly the contradiction that
// made this field misleading. A run that HAS started and is parked for retry is
// a genuine continuation and stays live regardless of age.
export const SUCCESSFUL_RUN_HANDOFF_UNSTARTED_RUN_LIVENESS_MS = 6 * 60 * 60 * 1000;

const heartbeatRunIssueId = sql<string>`coalesce(
  ${heartbeatRuns.contextSnapshot} ->> 'issueId',
  ${heartbeatRuns.contextSnapshot} ->> 'taskId'
)`;

const wakeRequestIssueId = sql<string>`coalesce(
  ${agentWakeupRequests.payload} ->> 'issueId',
  ${agentWakeupRequests.payload} ->> 'taskId',
  ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId',
  ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'taskId'
)`;

export async function hydrateSuccessfulRunHandoffLiveness(
  dbOrTx: any,
  companyId: string,
  states: Map<string, SuccessfulRunHandoffState>,
) {
  const requiredIssueIds = [...states.entries()]
    .filter(([, state]) => state.state === "required")
    .map(([issueId]) => issueId);
  if (requiredIssueIds.length === 0) return states;

  const [activeRuns, activeWakes] = await Promise.all([
    dbOrTx
      .select({
        id: heartbeatRuns.id,
        issueId: heartbeatRunIssueId,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, [...SUCCESSFUL_RUN_HANDOFF_LIVE_RUN_STATUSES]),
        inArray(heartbeatRunIssueId, requiredIssueIds),
      )),
    dbOrTx
      .select({ issueId: wakeRequestIssueId })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        inArray(agentWakeupRequests.status, [...SUCCESSFUL_RUN_HANDOFF_LIVE_WAKE_STATUSES]),
        inArray(wakeRequestIssueId, requiredIssueIds),
      )),
  ]);

  type LiveRunRow = {
    id: string;
    issueId: string | null;
    status: string;
    startedAt: Date | null;
    createdAt: Date | null;
  };

  const nowMs = Date.now();
  // A row only counts as a continuation if something is actually carrying it:
  // it is running, or it started and is parked for retry, or it has not yet
  // started but is still inside the unstarted-liveness bound.
  const isLiveRunRow = (row: LiveRunRow) => {
    if (row.status === "running" || row.startedAt) return true;
    if (!row.createdAt) return false;
    return nowMs - row.createdAt.getTime() < SUCCESSFUL_RUN_HANDOFF_UNSTARTED_RUN_LIVENESS_MS;
  };

  // The previous implementation took whichever row Postgres happened to return
  // first for an issue, so `liveRunId` could differ between two reads of
  // unchanged state. Rank explicitly: actually-running beats parked, then
  // newest, then id as a total-order tiebreak.
  const liveRunRank = (row: LiveRunRow) => (row.status === "running" ? 0 : row.startedAt ? 1 : 2);
  const liveRunByIssueId = new Map<string, LiveRunRow>();
  for (const row of (activeRuns as LiveRunRow[]).filter((candidate) => candidate.issueId && isLiveRunRow(candidate))) {
    const current = liveRunByIssueId.get(row.issueId!);
    if (
      !current ||
      liveRunRank(row) < liveRunRank(current) ||
      (liveRunRank(row) === liveRunRank(current) &&
        ((row.createdAt?.getTime() ?? 0) > (current.createdAt?.getTime() ?? 0) ||
          ((row.createdAt?.getTime() ?? 0) === (current.createdAt?.getTime() ?? 0) && row.id < current.id)))
    ) {
      liveRunByIssueId.set(row.issueId!, row);
    }
  }
  const liveWakeIssueIds = new Set(
    (activeWakes as Array<{ issueId: string | null }>)
      .map((row) => row.issueId)
      .filter((issueId): issueId is string => Boolean(issueId)),
  );

  for (const issueId of requiredIssueIds) {
    const state = states.get(issueId);
    if (!state) continue;
    const liveRunId = liveRunByIssueId.get(issueId)?.id ?? null;
    states.set(issueId, {
      ...state,
      hasLiveContinuation: Boolean(liveRunId || liveWakeIssueIds.has(issueId)),
      // Always emit the key once hydrated, so a consumer can tell "hydrated,
      // nothing live" (null) from "never hydrated" (absent) — previously both
      // presented as an absent field.
      liveRunId,
    });
  }

  return states;
}

export async function resolveRequiredSuccessfulRunHandoffOnValidPath(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    issueIdentifier: string | null;
    agentId: string;
    runId: string;
    skipReason: string;
  },
) {
  const latestHandoff = await db
    .select({ action: activityLog.action, runId: activityLog.runId, details: activityLog.details })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, input.companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.issueId),
      inArray(activityLog.action, [
        "issue.successful_run_handoff_required",
        "issue.successful_run_handoff_resolved",
        "issue.successful_run_handoff_escalated",
      ]),
    ))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (latestHandoff?.action !== "issue.successful_run_handoff_required") return false;

  const details = latestHandoff.details && typeof latestHandoff.details === "object"
    ? latestHandoff.details as Record<string, unknown>
    : {};
  const sourceRunId = [details.sourceRunId, details.source_run_id, details.resumeFromRunId]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim() ?? latestHandoff.runId;
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "heartbeat",
    agentId: input.agentId,
    runId: input.runId,
    action: "issue.successful_run_handoff_resolved",
    entityType: "issue",
    entityId: input.issueId,
    details: {
      label: "Successful run handoff continuation confirmed",
      sourceRunId,
      resolvedByRunId: input.runId,
      resolvedBySkipReason: input.skipReason,
      issue: { id: input.issueId, identifier: input.issueIdentifier },
    },
  });
  return true;
}

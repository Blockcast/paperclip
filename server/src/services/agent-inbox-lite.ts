import { issueListProbeLimit, resolveIssueListTruncation } from "../lib/issue-list-query.js";
import type { WorktreeRunExecutionActivationState } from "./instance-settings.js";
import type { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { isIssueHeldByForeignRun, isIssueHeldByForeignScheduledRetry } from "./issue-run-holding.js";
import type { issueService } from "./issues.js";

export const AGENT_INBOX_LITE_STATUS_FILTER = "todo,in_progress,blocked";

type IssuesService = ReturnType<typeof issueService>;
type RecoveryActionsService = ReturnType<typeof issueRecoveryActionService>;
type InboxIssue = Awaited<ReturnType<IssuesService["list"]>>[number];

type AgentInboxLiteInput = {
  issuesSvc: Pick<IssuesService, "list" | "listDependencyReadiness">;
  recoveryActionsSvc: Pick<RecoveryActionsService, "listActiveForIssues">;
  companyId: string;
  agentId: string;
  callerRunId: string | null;
  limit: number;
  offset?: number;
  isWorktreeRuntime: boolean;
  worktreeActivation: WorktreeRunExecutionActivationState;
  nowMs?: number;
  onWithheldForeignRun?: (issue: InboxIssue) => void;
  onWithheldForeignScheduledRetry?: (
    issue: InboxIssue,
    holder: InboxIssue["scheduledRetryParkedRuns"][number],
  ) => void;
};

// Keep the inbox query, worktree gate, and foreign-run suppression together.
// The route supplies the runtime policy and audit logging; this helper keeps
// the offered-work contract independently testable without loading adapters.
export async function loadAgentInboxLite({
  issuesSvc,
  recoveryActionsSvc,
  companyId,
  agentId,
  callerRunId,
  limit,
  offset = 0,
  isWorktreeRuntime,
  worktreeActivation,
  nowMs = Date.now(),
  onWithheldForeignRun,
  onWithheldForeignScheduledRetry,
}: AgentInboxLiteInput) {
  // BLO-39015: this query is capped and ordered `priority` ASC (critical ->
  // low), so on a lane deeper than the cap the cut lands mid-band and EVERY
  // row below it is unreachable — measured on one lane as all 44 `low` rows
  // plus half the `medium` band, 139 of 634. It returned a bare array with no
  // signal, so the page was indistinguishable from the whole population, and
  // the failure direction is the expensive one: the row reads perfectly
  // healthy on every triage surface (`todo`, assigned, dependency-clear) while
  // being unselectable. That falsified BLO-27553's disposition 2 — "leave it
  // `todo`, `todo` keeps the row in inbox-lite and re-dispatchable" — which is
  // the fleet-wide remedy for permanent strands, so complying with the strand
  // rule put rows into a different silent strand.
  //
  // Same fix as BLO-33741 on `GET /companies/:id/issues`, and deliberately the
  // same helpers: over-fetch one row to detect the cut, page the remainder
  // with `offset`. Note the probe runs on the RAW window, BEFORE the
  // eligibility filters below — `truncated` answers "does a matching row exist
  // past this window", which is the question `offset` paging is keyed to.
  // Deriving it from the filtered length instead would read a full window with
  // several withheld rows as complete. It also means a truncated page can
  // return FEWER than `limit` rows (the filters only shorten it); that is why
  // the signal cannot be inferred from the returned count.
  const probed = await issuesSvc.list(companyId, {
    assigneeAgentId: agentId,
    status: AGENT_INBOX_LITE_STATUS_FILTER,
    includeRoutineExecutions: true,
    limit: issueListProbeLimit(limit),
    offset,
  });
  const { rows, truncated } = resolveIssueListTruncation(probed, limit);
  const eligibleRows = !isWorktreeRuntime
    ? rows
    : worktreeActivation.armed
    ? rows.filter((issue) => new Date(issue.createdAt) >= new Date(worktreeActivation.cutoff))
    : [];
  const issueIds = eligibleRows.map((issue) => issue.id);
  const [dependencyReadiness, recoveryActionByIssue] = await Promise.all([
    issuesSvc.listDependencyReadiness(companyId, issueIds),
    recoveryActionsSvc.listActiveForIssues(companyId, issueIds),
  ]);

  return {
    appliedLimit: limit,
    truncated,
    rows: eligibleRows
      .filter((issue) => {
        const held = isIssueHeldByForeignRun({
          activeRun: issue.activeRun,
          callerRunId,
          nowMs,
        });
        if (held) {
          onWithheldForeignRun?.(issue);
          return false;
        }
        // BLO-29965: the row can also be attended by a SIBLING RUN PARKED ON A
        // SCHEDULED RETRY, which holds the execution lock but is absent from
        // `activeRun`. Kept as a separate check with its own audit callback so a
        // withheld row says which of the two liveness paths withheld it — a lost
        // claim must be distinguishable, not merged into the running-run case.
        // Every parked run is checked, not just the earliest-due one the row
        // displays: that one can be a previous assignee's stale retry.
        const retryHolder = issue.scheduledRetryParkedRuns.find((parked) =>
          isIssueHeldByForeignScheduledRetry({
            scheduledRetryAt: parked.scheduledRetryAt,
            scheduledRetryRunId: parked.runId,
            scheduledRetryAgentId: parked.agentId,
            callerRunId,
            callerAgentId: agentId,
            nowMs,
          }),
        );
        if (retryHolder) onWithheldForeignScheduledRetry?.(issue, retryHolder);
        return !retryHolder;
      })
      .map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        projectId: issue.projectId,
        goalId: issue.goalId,
        parentId: issue.parentId,
        updatedAt: issue.updatedAt,
        activeRun: issue.activeRun,
        // BLO-34421: the fleet's attendance predicate is `activeRun` OR a future
        // `monitorNextCheckAt` OR `scheduledRetryAt`. This projection carried only
        // the first, so the other two arms read as ABSENT KEYS — not null — and the
        // predicate collapsed to `attended = 0` for every row. Absence is the
        // expensive direction: it is the input to a demotion pass, so a lane with
        // live monitors and parked retries read as entirely unattended. Same shape
        // as the 86%-false-positive `blocked` detector (BLO-27553): a predicate
        // built from the absence of wake paths, run against a surface that cannot
        // report them. BLO-28843 added these scalars to `issues.list` for exactly
        // this reason; they must not be dropped again on the cheaper call agents
        // reach for first. Explicitly `null` when unset — never absent.
        monitorNextCheckAt: issue.monitorNextCheckAt ?? null,
        scheduledRetryAt: issue.scheduledRetryAt ?? null,
        scheduledRetryReason: issue.scheduledRetryReason ?? null,
        scheduledRetryAttempt: issue.scheduledRetryAttempt ?? null,
        // BLO-27912/BLO-39015: the deliberate park, same present-and-null contract and for
        // the same reason as the four above. `issues.ts`'s column selection already carries
        // all four ("a park has to stay VISIBLE ... by whom, why, and until when") and the
        // rows arrive here holding them; only this projection dropped them, so an agent
        // reading its own inbox could not tell a parked row from an idle one.
        //
        // This is EXPOSURE, not suppression, and the asymmetry is deliberate. A live park is
        // the sweep's seventh waiting path (`hasActiveParkedDisposition`), which answers "is
        // anyone accountable for this row?" — not "should it be offered as work?". Nothing in
        // selection has ever keyed on `parkedUntil` and this change does not start: filtering
        // here would silently remove a row from the only surface BLO-27553 disposition 2
        // leaves it reachable on, which is a strand by another name. Surface it and let the
        // caller decide, exactly as the overdue-monitor case is left to the caller above.
        parkedUntil: issue.parkedUntil ?? null,
        parkedReason: issue.parkedReason ?? null,
        parkedByAgentId: issue.parkedByAgentId ?? null,
        parkedAt: issue.parkedAt ?? null,
        activeRecoveryAction: recoveryActionByIssue.get(issue.id) ?? null,
        dependencyReady: dependencyReadiness.get(issue.id)?.isDependencyReady ?? true,
        unresolvedBlockerCount: dependencyReadiness.get(issue.id)?.unresolvedBlockerCount ?? 0,
        unresolvedBlockerIssueIds: dependencyReadiness.get(issue.id)?.unresolvedBlockerIssueIds ?? [],
      })),
  };
}

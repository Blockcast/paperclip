import type { WorktreeRunExecutionActivationState } from "./instance-settings.js";
import type { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { isIssueHeldByForeignRun } from "./issue-run-holding.js";
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
  isWorktreeRuntime: boolean;
  worktreeActivation: WorktreeRunExecutionActivationState;
  nowMs?: number;
  onWithheldForeignRun?: (issue: InboxIssue) => void;
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
  isWorktreeRuntime,
  worktreeActivation,
  nowMs = Date.now(),
  onWithheldForeignRun,
}: AgentInboxLiteInput) {
  const rows = await issuesSvc.list(companyId, {
    assigneeAgentId: agentId,
    status: AGENT_INBOX_LITE_STATUS_FILTER,
    includeRoutineExecutions: true,
    limit,
  });
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

  return eligibleRows
    .filter((issue) => {
      const held = isIssueHeldByForeignRun({
        activeRun: issue.activeRun,
        callerRunId,
        nowMs,
      });
      if (held) onWithheldForeignRun?.(issue);
      return !held;
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
      activeRecoveryAction: recoveryActionByIssue.get(issue.id) ?? null,
      dependencyReady: dependencyReadiness.get(issue.id)?.isDependencyReady ?? true,
      unresolvedBlockerCount: dependencyReadiness.get(issue.id)?.unresolvedBlockerCount ?? 0,
      unresolvedBlockerIssueIds: dependencyReadiness.get(issue.id)?.unresolvedBlockerIssueIds ?? [],
    }));
}

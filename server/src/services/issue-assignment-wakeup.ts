import { logger } from "../middleware/logger.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

function prReviewTargetFromIssue(issue: {
  originKind?: string | null;
  originFingerprint?: string | null;
}) {
  if (issue.originKind !== "pr_review") return null;
  const match = /^pr_review:(.+\/.+):(\d+)$/.exec(issue.originFingerprint ?? "");
  if (!match) return null;
  return { repoFullName: match[1]!, prNumber: Number(match[2]) };
}

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: {
    id: string;
    assigneeAgentId: string | null;
    status: string;
    originKind?: string | null;
    originFingerprint?: string | null;
  };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  taskKey?: string | null;
  rethrowOnError?: boolean;
}) {
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;
  const prReviewTarget = prReviewTargetFromIssue(input.issue);
  const taskKey = input.taskKey ?? (prReviewTarget
    ? `pr_review:${prReviewTarget.repoFullName}:${prReviewTarget.prNumber}`
    : null);
  const reason = prReviewTarget ? "issue_pr_review_requested" : input.reason;
  const reviewContext = prReviewTarget
    ? {
        reviewKind: "pr_review",
        prRole: "reviewer",
        githubPrNumber: prReviewTarget.prNumber,
        githubRepoFullName: prReviewTarget.repoFullName,
      }
    : {};

  return input.heartbeat
    .wakeup(input.issue.assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason,
      payload: {
        issueId: input.issue.id,
        mutation: input.mutation,
        ...(taskKey ? { taskKey } : {}),
        ...reviewContext,
      },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: {
        issueId: input.issue.id,
        source: input.contextSource,
        wakeReason: reason,
        ...(taskKey ? { taskKey } : {}),
        ...reviewContext,
      },
    })
    .catch((err) => {
      logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
      if (input.rethrowOnError) throw err;
      return null;
    });
}

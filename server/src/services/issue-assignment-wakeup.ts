import { logger } from "../middleware/logger.js";
import { buildPrReviewTaskKey } from "./pr-review-duplicate-issue-guard.js";

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
  // Canonical (normalized) spelling. The webhook's `buildPrReviewerTaskKey` is
  // still on the phase-one legacy mixed-case spelling, but every equality check
  // against a live task key goes through `matchesAnyTaskKey`/`taskKeysMatch`,
  // which treat the two spellings as one scope — so this still coalesces with a
  // webhook-sourced reviewer wake for the same PR.
  const taskKey = input.taskKey ?? (prReviewTarget ? buildPrReviewTaskKey(prReviewTarget) : null);
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
        // NB: no explicit `wakeReason` here. `enrichWakeContextSnapshot` already
        // stamps `contextSnapshot.wakeReason = reason` when it is absent, so
        // setting it here is redundant — and it would widen the snapshot shape
        // for every non-review assignment wake, which callers assert on exactly
        // (see routines-service.test.ts).
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

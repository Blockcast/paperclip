import { ISSUE_STATUS_ADJUDICATION_CARRIER_NOTICE } from "@paperclipai/shared";
import type { ActivityEvent, Issue, SuccessfulRunHandoffState } from "@paperclipai/shared";

export const SUCCESSFUL_RUN_HANDOFF_REQUIRED_ACTION = "issue.successful_run_handoff_required";
export const SUCCESSFUL_RUN_HANDOFF_RESOLVED_ACTION = "issue.successful_run_handoff_resolved";
export const SUCCESSFUL_RUN_HANDOFF_ESCALATED_ACTION = "issue.successful_run_handoff_escalated";
// PEN-7126: mirrors `server/src/services/recovery/successful-run-handoff.ts`.
// The PREFIX is the historical body and the part the matchers below test; the
// BODY appends the shared carrier sentence naming the status-adjudication
// route. Matching on the prefix is what keeps every notice already in the
// database classifying after the body grew.
export const SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_PREFIX =
  "Paperclip needs a disposition before this issue can continue.";
export const SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_PREFIX =
  "Paperclip could not resolve this issue's missing disposition automatically. The issue is blocked on a recovery owner.";
export const SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY =
  `${SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_PREFIX} ${ISSUE_STATUS_ADJUDICATION_CARRIER_NOTICE}`;
export const SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY =
  `${SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_PREFIX} ${ISSUE_STATUS_ADJUDICATION_CARRIER_NOTICE}`;

export function isSuccessfulRunHandoffActivity(action: string) {
  return action === SUCCESSFUL_RUN_HANDOFF_REQUIRED_ACTION
    || action === SUCCESSFUL_RUN_HANDOFF_RESOLVED_ACTION
    || action === SUCCESSFUL_RUN_HANDOFF_ESCALATED_ACTION;
}

export function isSuccessfulRunHandoffRequired(issue: Pick<Issue, "successfulRunHandoff">) {
  return issue.successfulRunHandoff?.required === true;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function successfulRunHandoffFromActivity(event: ActivityEvent): SuccessfulRunHandoffState | null {
  if (!isSuccessfulRunHandoffActivity(event.action)) return null;
  const details = event.details ?? {};
  const state = event.action === SUCCESSFUL_RUN_HANDOFF_REQUIRED_ACTION
    ? "required"
    : event.action === SUCCESSFUL_RUN_HANDOFF_RESOLVED_ACTION
      ? "resolved"
      : "escalated";

  return {
    state,
    required: state === "required",
    hasLiveContinuation: false,
    sourceRunId:
      readString(details.sourceRunId)
      ?? readString(details.source_run_id)
      ?? readString(details.resumeFromRunId)
      ?? event.runId
      ?? null,
    correctiveRunId:
      readString(details.correctiveRunId)
      ?? readString(details.corrective_run_id)
      ?? (state !== "required" ? event.runId : null),
    assigneeAgentId:
      readString(details.assigneeAgentId)
      ?? readString(details.agentId)
      ?? event.agentId
      ?? null,
    detectedProgressSummary:
      readString(details.detectedProgressSummary)
      ?? readString(details.detected_progress_summary)
      ?? null,
    createdAt: event.createdAt,
  };
}

export function isSuccessfulRunHandoffComment(text: string) {
  const trimmed = text.trim();
  return trimmed.startsWith(SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_PREFIX)
    || /^##\s+(This issue still needs a next step|Run finished without a next step|Successful run missing issue disposition)/i.test(trimmed)
    || isSuccessfulRunHandoffEscalationComment(trimmed);
}

export function isSuccessfulRunHandoffEscalationComment(text: string) {
  const trimmed = text.trim();
  return trimmed.startsWith(SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_PREFIX)
    || /^Paperclip exhausted the bounded successful-run handoff correction\b/i.test(trimmed);
}

export function successfulRunHandoffActivityTone(action: string) {
  if (action === SUCCESSFUL_RUN_HANDOFF_ESCALATED_ACTION) {
    return {
      className: "border-red-500/35 bg-red-500/10 text-red-950 dark:text-red-100",
      iconClassName: "text-red-600 dark:text-red-300",
    };
  }
  if (action === SUCCESSFUL_RUN_HANDOFF_REQUIRED_ACTION) {
    return {
      className: "border-amber-300/70 bg-amber-50/90 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
      iconClassName: "text-amber-600 dark:text-amber-300",
    };
  }
  return {
    className: "border-border/60 text-muted-foreground",
    iconClassName: "text-muted-foreground",
  };
}

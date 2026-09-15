import { Eye } from "lucide-react";
import type { IssueProductivityReview, IssueProductivityReviewTrigger } from "@paperclipai/shared";
import { Link } from "../lib/router";
import { cn } from "../lib/utils";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

// BLO-34216: exhaustive by construction — a trigger added to
// `ISSUE_PRODUCTIVITY_REVIEW_TRIGGERS` with no entry here is a typecheck
// failure. The `??` below stays for version skew: a deployed API can send a
// trigger this bundle predates, which is a runtime fact no type can rule out.
const TRIGGER_LABELS: Record<IssueProductivityReviewTrigger, string> = {
  no_comment_streak: "No-comment streak",
  long_active_duration: "Long active duration",
  high_churn: "High churn",
  runtime_failure_streak: "Runtime failure streak",
  runaway_execution: "Runaway execution",
};

const REVIEW_STATUS_LABELS: Record<string, string> = {
  todo: "Open",
  in_progress: "In progress",
  in_review: "In review",
  blocked: "Blocked",
  backlog: "Open",
};

export function productivityReviewTriggerLabel(
  trigger: IssueProductivityReview["trigger"],
): string {
  if (!trigger) return "Productivity review";
  return TRIGGER_LABELS[trigger] ?? "Productivity review";
}

export function ProductivityReviewBadge({
  review,
  className,
  hideLabel = false,
}: {
  review: IssueProductivityReview;
  className?: string;
  hideLabel?: boolean;
}) {
  const label = productivityReviewTriggerLabel(review.trigger);
  const reviewIdentifier = review.reviewIdentifier ?? review.reviewIssueId.slice(0, 8);
  const reviewPath = createIssueDetailPath(review.reviewIdentifier ?? review.reviewIssueId);
  const statusLabel = REVIEW_STATUS_LABELS[review.status] ?? review.status.replace(/_/g, " ");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={reviewPath}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-(length:--text-nano) font-medium text-amber-700 dark:text-amber-300 shrink-0 hover:bg-amber-500/20 transition-colors",
            className,
          )}
          aria-label={`Under review · productivity review ${reviewIdentifier} (${label})`}
        >
          <Eye className="h-3 w-3" aria-hidden />
          {hideLabel ? null : <span>Under review</span>}
        </Link>
      </TooltipTrigger>
      <TooltipContent>
        <div className="space-y-1 text-xs">
          <div className="font-semibold">Productivity review open</div>
          <div>
            <span className="text-muted-foreground">Trigger:</span> {label}
          </div>
          {typeof review.noCommentStreak === "number" && review.noCommentStreak > 0 ? (
            <div>
              <span className="text-muted-foreground">No-comment streak:</span>{" "}
              {review.noCommentStreak} runs
            </div>
          ) : null}
          <div>
            <span className="text-muted-foreground">Review:</span> {reviewIdentifier} ({statusLabel})
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

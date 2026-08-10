import type { Request } from "express";
import type { accessService } from "../services/access.js";
import {
  authorizationBoundaryLabel,
  authorizationDeniedDetails,
  type AuthorizationDecision,
} from "../services/authorization.js";

/**
 * BLO-23763: the single definition of "may this actor attach an approval to this
 * issue".
 *
 * Two routes reach the same end state — a row in `issue_approvals` — by different
 * doors: `POST /issues/:id/approvals` (the dedicated link route) and
 * `POST /companies/:companyId/approvals` with an `issueIds` array. Only the first
 * ran an issue-scoped check, so the boundary was bypassable by picking the other
 * door. Both now decide through this function, so the doors cannot drift.
 *
 * ## Why this is not `assertAgentIssueMutationAllowed`
 *
 * That helper is the right decision but the wrong shape to call from the create
 * route, for three reasons:
 *
 * 1. **It writes.** Its allow path ends in `svc.assertCheckoutOwner`, which issues
 *    up to four `UPDATE issues` (clearing terminal execution/checkout runs, then
 *    adopting an unowned or stale checkout lock) and can log an
 *    `issue.checkout_lock_adopted` activity row. Authorizing a link to N issues
 *    must not take the checkout lock on N issues.
 * 2. **Its denial recorder persists the request body.** `recordDeniedIssueWrite`
 *    serializes `req.body` into the `issue_write_denied` audit row. It was written
 *    against issue-patch bodies; an approval-create body carries `payload`, which
 *    for `hire_agent` is exactly the shape `normalizeHireApprovalPayloadForPersistence`
 *    exists to strip secrets out of. Reusing it here would widen what that audit
 *    row can contain.
 * 3. **It must not short-circuit.** The create route has to report *every* refused
 *    id, so the decision has to be a value it can collect, not a response the first
 *    refusal writes.
 *
 * So this is a side-effect-free evaluator returning a verdict, mirroring the
 * existing `evaluateAgentIssueCommentAuthorization` / `assertAgentIssueCommentAllowed`
 * split in `issues.ts` — which exists for the same reason: "the advertised verdict
 * cannot drift from the enforced one".
 *
 * ## Deliberate differences from the mutation helper's no-options path
 *
 * - **The productivity-review grant is honoured here.** `agentHasProductivityReviewGrantOnIssue`
 *   already returns `allow_productivity_review_grant` for the reviewed source issue,
 *   but `assertAgentIssueMutationAllowed` only acts on it when a route opts in, so a
 *   reviewer is otherwise refused on the very issue it is reviewing. A review whose
 *   verdict is "block with an unblock owner" has to be able to attach the board
 *   escalation carrying that verdict to the issue it is about (BLO-23036), and an
 *   escalation card is inert until a human resolves it. Attaching a card is strictly
 *   weaker than the status transitions that grant already authorizes on `PATCH
 *   /issues/:id`.
 * - **No checkout-lock requirement.** Where the mutation helper would fall through to
 *   `assertCheckoutOwner`, this allows: the actor is the issue's assignee and has
 *   already cleared the boundary, and holding the run-level checkout lock is
 *   bookkeeping about who is *executing* the issue, not about who may annotate it.
 *   Refusing here would strand an agent filing an escalation from a heartbeat run
 *   while its execution run holds the lock.
 *
 * Every other branch is a faithful mirror, and each denial is at least as strict as
 * the link route's.
 */

export type IssueApprovalLinkAuthorizationIssue = {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdByAgentId?: string | null;
  originKind?: string | null;
  originId?: string | null;
  checkoutRunId?: string | null;
  executionRunId?: string | null;
};

export type IssueApprovalLinkVerdict =
  | { allowed: true; reason: string }
  | {
      allowed: false;
      status: 403 | 409;
      error: string;
      reason: string;
      boundary: string | null;
      details: Record<string, unknown>;
    };

/**
 * Structural, so callers can pass the `accessService(db)` they already built
 * (both routes do) without this module reaching for a second instance.
 */
type AccessDecider = Pick<ReturnType<typeof accessService>, "decide">;

/**
 * Mirrors `isCurrentIssueExecutionRun` in `issues.ts`. Duplicated rather than
 * exported from there because importing a route module into another route module
 * to reach one predicate couples two 13k-line factories; the predicate is four
 * lines of pure comparison and is covered by the equivalence tests.
 */
function isCurrentIssueExecutionRun(
  req: Request,
  issue: { checkoutRunId?: string | null; executionRunId?: string | null },
) {
  if (req.actor.type !== "agent") return false;
  const runId = req.actor.runId;
  if (!runId) return false;
  const ownsCheckout = issue.checkoutRunId === runId;
  const ownsExecution = issue.executionRunId === runId;
  return (
    (ownsCheckout || ownsExecution) &&
    (issue.checkoutRunId == null || ownsCheckout) &&
    (issue.executionRunId == null || ownsExecution)
  );
}

function isCreatorOrManagerChainDecision(decision: AuthorizationDecision) {
  return decision.reason === "allow_issue_creator" || decision.reason === "allow_manager_chain";
}

export async function evaluateAgentIssueApprovalLinkAuthorization(
  deps: { access: AccessDecider },
  req: Request,
  issue: IssueApprovalLinkAuthorizationIssue,
): Promise<IssueApprovalLinkVerdict> {
  if (req.actor.type !== "agent") return { allowed: true, reason: "allow_non_agent" };

  const actorAgentId = req.actor.agentId;
  if (!actorAgentId) {
    return {
      allowed: false,
      status: 403,
      error: "Agent authentication required",
      reason: "deny_agent_auth_required",
      boundary: null,
      details: { issueId: issue.id },
    };
  }

  if (isCurrentIssueExecutionRun(req, issue)) {
    return { allowed: true, reason: "allow_current_issue_execution_run" };
  }

  const decision = await deps.access.decide({
    actor: req.actor,
    action: "issue:mutate",
    resource: {
      type: "issue",
      companyId: issue.companyId,
      issueId: issue.id,
      projectId: issue.projectId,
      parentIssueId: issue.parentId,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      createdByAgentId: issue.createdByAgentId ?? null,
      status: issue.status,
      // Deliberately not `?? null` — authorization distinguishes "the caller did
      // not look this up" (undefined, reload the row) from "the row has none"
      // (null, trust it). Matches `decideIssueAccess` in issues.ts.
      originKind: issue.originKind,
      originId: issue.originId ?? null,
    },
    scope: {
      issueId: issue.id,
      projectId: issue.projectId,
      parentIssueId: issue.parentId,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      originKind: issue.originKind ?? null,
      originId: issue.originId ?? null,
    },
  });

  if (!decision.allowed) {
    return {
      allowed: false,
      status: 403,
      error: `Issue is outside this actor's authorization boundary (${authorizationBoundaryLabel(decision.reason)})`,
      reason: decision.reason,
      boundary: authorizationBoundaryLabel(decision.reason),
      details: { issueId: issue.id, ...authorizationDeniedDetails(decision) },
    };
  }

  // Creator and manager-chain grants are comment-only in authorization.ts
  // (BLO-18113 / BLO-18797). The one mutation they carry is a shaped delegate
  // recovery PATCH, which this is not.
  if (isCreatorOrManagerChainDecision(decision)) {
    return {
      allowed: false,
      status: 403,
      error: "Agent cannot link approvals to another agent's issue outside delegate recovery",
      reason: decision.reason,
      boundary: "grant",
      details: {
        issueId: issue.id,
        assigneeAgentId: issue.assigneeAgentId,
        actorAgentId,
        status: issue.status,
      },
    };
  }

  if (issue.assigneeAgentId === null) {
    return { allowed: true, reason: decision.reason };
  }

  if (issue.assigneeAgentId !== actorAgentId) {
    const override = await deps.access.decide({
      actor: { type: "agent", agentId: actorAgentId, companyId: issue.companyId },
      action: "tasks:manage_active_checkouts",
      resource: { type: "issue", companyId: issue.companyId, assigneeAgentId: issue.assigneeAgentId },
    });
    if (override.allowed) return { allowed: true, reason: "allow_active_checkout_management" };

    // See the header note: this is the branch the mutation helper gates behind
    // `options.allowProductivityReviewOwner`, and the branch AC #4 of BLO-23763
    // depends on.
    if (decision.reason === "allow_productivity_review_grant") {
      return { allowed: true, reason: decision.reason };
    }

    if (issue.status === "in_progress") {
      return {
        allowed: false,
        status: 409,
        error: "Issue is checked out by another agent",
        reason: "deny_active_checkout",
        boundary: "checkout",
        details: { issueId: issue.id, assigneeAgentId: issue.assigneeAgentId, actorAgentId },
      };
    }
    return {
      allowed: false,
      status: 403,
      error: "Agent cannot link approvals to another agent's issue",
      reason: "deny_assignee_mismatch",
      boundary: "assignee",
      details: {
        issueId: issue.id,
        assigneeAgentId: issue.assigneeAgentId,
        actorAgentId,
        status: issue.status,
      },
    };
  }

  return { allowed: true, reason: decision.reason };
}

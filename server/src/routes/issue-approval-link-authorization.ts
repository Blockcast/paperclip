import type { Request } from "express";
import { type Db } from "@paperclipai/db";
import type { accessService } from "../services/access.js";
import {
  authorizationBoundaryLabel,
  authorizationDeniedDetails,
  type AuthorizationDecision,
} from "../services/authorization.js";
import * as serviceIndex from "../services/index.js";
import {
  resolveTaskWatchdogMutationScope,
  taskWatchdogScopeAllowsIssueMutation,
  type TaskWatchdogMutationScope,
} from "../services/task-watchdog-scope.js";

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
 * - **No pending-review run-ownership fence.** The mutation helper fences the
 *   issue's own assignee, on a run other than the lock holder, off a live-locked
 *   pending `in_review` stage (`isForeignRunOfLockedPendingReview` →
 *   `assertPendingReviewRunOwnership`, BLO-22666). This does not reproduce it, on
 *   the same grounds as the checkout lock above and reason 1: that fence guards
 *   *stage decisions*, and an inert approval card is not one; and it is not a read,
 *   since the service clears terminal runs' locks before it re-checks ownership,
 *   which an evaluator that authorizes N issues must not do to N rows. So the
 *   assignee's second run may attach an approval to its own pending review. Found
 *   in review of PR #1271.
 *
 * ## The task-watchdog subtree gate, and the one branch this is NOT a mirror of
 *
 * `assertAgentIssueMutationAllowed` runs `assertTaskWatchdogScopedIssueMutationAllowed`
 * *before* its `isCurrentIssueExecutionRun` bypass, and that ordering is load-bearing:
 * see the note at that helper — "resolve that scope before any current-run bypass so
 * stale or forged watchdog context cannot inherit broader execution-lock authority".
 * The first cut of this evaluator dropped that gate entirely, which let a watchdog run
 * attach approvals to any issue its agent would ordinarily pass `issue:mutate` on,
 * escaping the confinement `taskWatchdogScopeAllowsIssueMutation` exists to impose.
 * `services/authorization.ts` has no watchdog concept, so `access.decide` cannot
 * recover it. Found in review of PR #1293.
 *
 * The **subtree confinement** is reproduced here, in the same position, for every
 * door. It needs only `db`, which all three call sites have.
 *
 * The **freshness revalidation** half (`assertFreshTaskWatchdogSourceMutation` →
 * `taskWatchdogsSvc.revalidateMutationScope`, a 409 when the watchdog is no longer
 * live) is reproduced here too, in the same position — after confinement passes,
 * with the same exemption for the watchdog's own issue. An earlier cut of this
 * evaluator claimed that half was unreachable without threading the service
 * through both route factories and `app.ts`. That was wrong: `serviceIndex` is a
 * module namespace import, not an injected registry, and `revalidateMutationScope`
 * reads only `db` (`taskWatchdogService(db, deps = {})` never consults `deps` on
 * that path). So the factory is resolved here exactly as `issues.ts` resolves it —
 * `hasOwnProperty` guard, absent-factory fallback that allows — so a build which
 * omits the service keeps allowing at every door instead of fail-closing at the
 * two this evaluator newly gates. Found in review of PR #1271.
 *
 * Outside the deliberate differences listed above, every branch is now a faithful
 * mirror, and each denial is at least as strict as the link route's.
 *
 * ## The `requested_by_self` relation (PEN-5511)
 *
 * Every relation above answers "what is this actor to the *issue*". None answers
 * "this actor filed the card". So on any row worked by agent A, a card filed by
 * agent B was permanently unlinkable **by B** — who is the only party that knows
 * the card exists at filing time. The live refusal read `deny_missing_grant` /
 * `boundary: grant`, naming
 * `evaluatedRelations: [assignee, unassigned_issue, productivity_review]`.
 *
 * That is not merely inconvenient. `paperclipListApprovals(issueId=…)` returns only
 * *linked* cards, so the rows where it matters most — multi-agent incidents, where
 * two or more seats are each asking the board for something — under-report, and
 * they under-report in the direction that understates board exposure. The response
 * is a clean array with no marker, so a short list is indistinguishable at the call
 * site from a row with fewer asks. Measured on PEN-5379: three linked cards
 * returned against four standing asks.
 *
 * `requestedBySelfOverride` admits a relation the list above has no name for:
 * **the actor filed this card, and the actor is a participant in this row.**
 *
 * Both halves are load-bearing, and the second is what keeps this least-privilege.
 * "I filed it" alone cannot be the whole test, because at the two *create* doors
 * every actor is the filer of the card it is creating — so a filer-only rule
 * authorizes every (actor, issue) pair there and reopens the BLO-23763 hole it took
 * three PRs to close. The participation half is supplied by `issue:comment`, and it
 * is the right half for three reasons:
 *
 * - It is the **system's own model of "who belongs in this row's conversation"**.
 *   `ISSUE_COMMENT_EVALUATED_RELATIONS` is eight relations where
 *   `ISSUE_MUTATE_EVALUATED_RELATIONS` is three: it adds `creator`,
 *   `manager_of_assignee`, `agent_mention`, `recovery_handoff` and
 *   `dependency_edge`. Those are exactly the cross-seat escalation shapes PEN-5511
 *   names — a CTO filing on an engineer's row, a seat mentioned into an incident, a
 *   row reached through a blocker edge — and precisely not "any company member".
 * - **Attaching is weaker than commenting.** A comment wakes an agent; an approval
 *   card is inert until a human decides it. An actor already trusted with the
 *   stronger act on this row is not newly dangerous doing the weaker one.
 * - It is **one rule at all three doors**, so the BLO-24699 equivalence invariant
 *   survives: an actor with no relation at all to the row is refused at the link
 *   door and at both create doors, exactly as before.
 *
 * This mirrors BLO-18996 in `evaluateAgentIssueCommentAuthorization`, which
 * overrides the same `deny_missing_grant` fall-through with one extra relation
 * probe and leaves hard denials terminal. Beyond that:
 *
 * - It is an **override of specific refusals**, evaluated only once a refusal has
 *   been reached, rather than a bypass placed ahead of `access.decide`. Placing it
 *   earlier would have skipped the trust-boundary, company, membership and scope
 *   checks too. The overridable set is enumerated in
 *   `REQUESTED_BY_SELF_OVERRIDABLE_DECISION_REASONS` plus the two assignee branches
 *   below; **every other denial stays terminal**, including both watchdog refusals,
 *   which is why the watchdog gate still runs first and unconditionally.
 * - An actor may attach a card **it filed**; an arbitrary pre-existing card id is
 *   refused exactly as before.
 * - It discloses nothing. `requestedByAgentId` is server-derived from the
 *   authenticated actor at every create door (`routes/approvals.ts`,
 *   `routes/agents.ts`), so a caller cannot nominate someone else as requester; and
 *   the link route's `assertApprovalReadAllowed` gate is unchanged, so the
 *   scoped-key classes (task-bridge keys, skill-test tokens, low-trust presets) are
 *   excluded from this route exactly as before.
 * - The association it permits is **additive and non-destructive**. `DELETE
 *   /issues/:id/approvals/:approvalId` keeps its privileged gate untouched:
 *   curation stays privileged, attaching does not.
 *
 * It overrides the checkout 409 as well as the assignee 403, because those are the
 * same refusal — "you are not the assignee" — in its retryable and permanent forms,
 * and an `in_progress` row under another agent's checkout is precisely the
 * multi-agent incident this exists for. That is consistent with the no-checkout-lock
 * reasoning above: the lock is bookkeeping about who is *executing* the issue, not
 * about who may annotate it.
 */

/**
 * PEN-5511: the card side of the decision — who filed the approval being attached.
 *
 * `approvalId` is `null` at the create doors, where the card does not exist yet and
 * the actor is its requester by construction. Callers must take
 * `requestedByAgentId` from the server-derived requester column (or, on create,
 * from the authenticated actor), never from a request body.
 */
export type IssueApprovalLinkSubject = {
  approvalId: string | null;
  companyId: string;
  requestedByAgentId: string | null;
};

/**
 * The denial reasons `requested_by_self` may override, enumerated rather than
 * inverted so that a new `deny_*` reason added to `AuthorizationDecision` is
 * terminal here by default. Both carry `authorizationBoundaryLabel` "grant", i.e.
 * "this actor holds no relation to this issue" — the refusal the filer relation is
 * meant to answer.
 *
 * `deny_missing_consent` shares that label and is deliberately NOT here: consent is
 * a separate question from relation, and filing a card does not supply it.
 */
const REQUESTED_BY_SELF_OVERRIDABLE_DECISION_REASONS: ReadonlySet<string> = new Set([
  "deny_missing_grant",
  "deny_no_grant",
]);

export const REQUESTED_BY_SELF_REASON = "allow_approval_requested_by_self";

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

/**
 * Mirrors the `taskWatchdogService` resolution in `issues.ts`: the barrel is a
 * module namespace, and a build that omits the service must degrade to "allow"
 * rather than fail closed here while the link route allows. `null` is that
 * degraded case, so no fake classification has to be invented for it.
 */
async function revalidateWatchdogScope(
  db: Db,
  scope: Extract<TaskWatchdogMutationScope, { kind: "watchdog" }>,
) {
  const factory = Object.prototype.hasOwnProperty.call(serviceIndex, "taskWatchdogService")
    ? serviceIndex.taskWatchdogService
    : undefined;
  if (!factory) return null;
  return await factory(db).revalidateMutationScope(scope);
}

/**
 * The side-effect-free half of `assertTaskWatchdogScopedIssueMutationAllowed`:
 * resolve the run's watchdog scope, refuse when the target sits outside the
 * watched subtree, then refuse when the watchdog is no longer live. Returns
 * `null` for a non-watchdog run (the overwhelmingly common case, and one extra
 * indexed read only when the actor is an agent).
 *
 * `allowWatchdogIssue` is left at its default so a watchdog may still annotate
 * its own watchdog issue, matching the mutation helper's `issue:mutate` path.
 */
async function evaluateTaskWatchdogSubtreeScope(
  deps: { db: Db },
  req: Request,
  issue: IssueApprovalLinkAuthorizationIssue,
): Promise<IssueApprovalLinkVerdict & { allowed: false } | null> {
  const scope = await resolveTaskWatchdogMutationScope(deps.db, req.actor);
  if (scope.kind === "none") return null;
  const result = await taskWatchdogScopeAllowsIssueMutation(deps.db, scope, issue);
  if (result.kind === "invalid") {
    return {
      allowed: false,
      status: 403,
      error: result.detail,
      reason: "deny_task_watchdog_scope",
      boundary: "task_watchdog_scope",
      details: { issueId: issue.id },
    };
  }

  // Confinement passed; now the freshness half, in the same order and with the
  // same exemptions as `assertFreshTaskWatchdogSourceMutation`.
  if (scope.kind !== "watchdog") return null;
  if (scope.watchdogIssueId && issue.id === scope.watchdogIssueId) return null;

  const revalidated = await revalidateWatchdogScope(deps.db, scope);
  if (!revalidated || revalidated.allowed) return null;
  return {
    allowed: false,
    status: 409,
    error: revalidated.reason,
    reason: "deny_task_watchdog_stale_source",
    boundary: "task_watchdog_scope",
    details: {
      issueId: issue.id,
      watchedIssueId: scope.watchedIssueId,
      watchdogId: scope.watchdogId,
      runStopFingerprint: scope.stopFingerprint,
      currentState: revalidated.classification?.state ?? null,
      currentStopFingerprint:
        revalidated.classification && "stopFingerprint" in revalidated.classification
          ? revalidated.classification.stopFingerprint
          : null,
    },
  };
}

/**
 * The two halves of the `requested_by_self` relation (PEN-5511). Returns the allow
 * verdict or `null`, so a caller cannot accidentally use a half-satisfied result.
 *
 * The company equality is defence in depth rather than the primary gate — the
 * routes apply `assertCompanyAccess`/`getAccessibleResource` first, and
 * `issueApprovalService.link` refuses a cross-company pair at write time — but this
 * is the predicate that *relaxes* a refusal, so it re-establishes the invariant
 * locally instead of inheriting it.
 *
 * The `issue:comment` probe is made only after a refusal has already been reached
 * AND the filer half holds, so it adds no decide call to any path that was going to
 * allow anyway, and none at all for a third-party card or a non-agent actor.
 */
async function requestedBySelfOverride(
  deps: { access: AccessDecider },
  actorAgentId: string,
  issue: IssueApprovalLinkAuthorizationIssue,
  subject: IssueApprovalLinkSubject | null | undefined,
): Promise<{ allowed: true; reason: string } | null> {
  if (!subject) return null;
  if (subject.companyId !== issue.companyId) return null;
  if (subject.requestedByAgentId === null || subject.requestedByAgentId !== actorAgentId) {
    return null;
  }

  const participation = await deps.access.decide({
    actor: { type: "agent", agentId: actorAgentId, companyId: issue.companyId },
    action: "issue:comment",
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
      // Same undefined-vs-null contract as the `issue:mutate` call below.
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
  if (!participation.allowed) return null;
  return { allowed: true, reason: REQUESTED_BY_SELF_REASON };
}

export async function evaluateAgentIssueApprovalLinkAuthorization(
  deps: { access: AccessDecider; db: Db },
  req: Request,
  issue: IssueApprovalLinkAuthorizationIssue,
  /**
   * PEN-5511. Optional so a caller that cannot identify the card keeps exactly the
   * pre-PEN-5511 verdict: omitting it can only ever make this evaluator stricter,
   * never looser, which is what let the three doors adopt it independently.
   */
  subject?: IssueApprovalLinkSubject | null,
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

  // Ordered before the execution-run bypass on purpose — see the header. A
  // watchdog run that has drifted outside its watched subtree must not be able
  // to reach `isCurrentIssueExecutionRun` and inherit execution-lock authority.
  const watchdogRefusal = await evaluateTaskWatchdogSubtreeScope(deps, req, issue);
  if (watchdogRefusal) return watchdogRefusal;

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
    // PEN-5511: the filer-of-the-card relation, applied only to the "no relation to
    // this issue" refusals. Evaluated here — after the watchdog gate and after
    // `access.decide` has run — so a trust-boundary, company, membership, scope or
    // consent denial stays terminal for a filer. This is the branch the live
    // PEN-5379 refusal fell at.
    if (REQUESTED_BY_SELF_OVERRIDABLE_DECISION_REASONS.has(decision.reason)) {
      const self = await requestedBySelfOverride(deps, actorAgentId, issue, subject);
      if (self) return self;
    }
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
    // PEN-5511: an actor holding only a comment-only grant is refused here, but the
    // filer relation is an independent and stronger basis than the grant being
    // narrowed, so it is honoured rather than shadowed by it. Without this an agent
    // would be refused *because* it also happens to be the issue's creator, which
    // inverts the intent of the narrowing.
    const self = await requestedBySelfOverride(deps, actorAgentId, issue, subject);
    if (self) return self;
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

    // PEN-5511: placed to cover BOTH refusals below, because they are one refusal —
    // "you are not the assignee" — in its retryable (409, row checked out) and
    // permanent (403) forms. Admitting only the 403 would leave the filer unable to
    // link on exactly the `in_progress` multi-agent incident this exists for, and
    // would make the relation's availability depend on the row's status, which the
    // filer neither controls nor can wait out.
    const requestedBySelf = await requestedBySelfOverride(deps, actorAgentId, issue, subject);
    if (requestedBySelf) return requestedBySelf;

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

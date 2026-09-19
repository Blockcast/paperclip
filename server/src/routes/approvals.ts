import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  isUuidLike,
  listApprovalsQuerySchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
  withdrawApprovalSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  approvalService,
  issueApprovalService,
  logActivity,
  secretService,
} from "../services/index.js";
import { actorCanReadAgentConfig, assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo, hasCompanyAccess } from "./authz.js";
import { redactApprovalPayloadForDisplay, withholdAgentConfigFromApprovalPayload } from "../redaction.js";
import {
  BUDGET_POLICY_AMOUNT_ASSERTION,
  extractEnforcementAssertions,
} from "../services/approval-enforcement-reconciler.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { resolveApprovalWithSideEffects } from "../services/approval-resolution.js";
import { STATUS_ONLY_RECOVERY_RESUME_GUIDANCE } from "../services/recovery/model-profile-hint.js";
import {
  buildIssueGraphLivenessBoardEscalationKey,
  parseIssueGraphLivenessIncidentKey,
  RECOVERY_KEY_PREFIXES,
  RECOVERY_ORIGIN_KINDS,
} from "../services/recovery/origins.js";

/**
 * `includeAgentConfig` is the caller's `agent_config:read` verdict, not a
 * formatting preference — see `withholdAgentConfigFromApprovalPayload`. It is a
 * required argument so a new approval-serializing route has to state which side
 * of that gate it is on rather than inheriting a permissive default.
 */
function redactApprovalPayload<T extends { type: string; payload: Record<string, unknown> }>(
  approval: T,
  options: { includeAgentConfig: boolean },
): T & { redactedFields: string[]; withheldFields: string[] } {
  const { payload, redactedFields } = redactApprovalPayloadForDisplay(approval.type, approval.payload);
  if (options.includeAgentConfig) {
    return { ...approval, payload, redactedFields, withheldFields: [] };
  }
  const withheld = withholdAgentConfigFromApprovalPayload(approval.type, payload);
  return {
    ...approval,
    payload: withheld.payload,
    redactedFields,
    withheldFields: withheld.withheldFields,
  };
}

function approvalResolutionResponse<T extends { type: string; payload: Record<string, unknown> }>(
  approval: T,
  applied: boolean,
  options: { includeAgentConfig: boolean },
): T & { redactedFields: string[]; withheldFields: string[]; applied: boolean } {
  return {
    ...redactApprovalPayload(approval, options),
    applied,
  };
}

// A status-only recovery run is barred from approval work because approvals carry expensive or
// destructive side effects once resolved. Filing a board escalation is the one exception: the card
// is inert until a human resolves it, and it is the only channel that reaches a human at all.
//
// A manager delivering the productivity-review verdict "block with an unblock owner" has to be able
// to execute that verdict in the same run that reaches it. Without this escape the review can state
// a gate it cannot escalate, and the natural failure mode — believing the escalation implied by the
// verdict exists — silently reproduces the stall the review was created to catch. See BLO-23036.
//
// Deliberately create-only: resubmit/withdraw/comment never pass a requested type, so they stay
// barred regardless of the target approval's type.
const BOARD_ESCALATION_APPROVAL_TYPE = "request_board_approval";

// BLO-34008: refuse a budget card that declares no machine-checkable target.
//
// Approving this type writes nothing to `budget_policies` — approvalService
// .approve() special-cases only `hire_agent` — so the only thing that can ever
// notice an approved-but-unapplied budget decision is the enforcement reconciler,
// and it can only see a card that declares its figures. Card `304ea443` is the
// cost of accepting one that does not: its eight decided figures went into
// `payload.raises`/`payload.cuts` as prose keyed by agent display name, it was
// approved, and all eight changes were still unapplied five days later with
// nothing able to raise a word. It remains unparseable and always will be.
// Refusing is the only repair that does not reduce to regexing a figure out of
// English, which BLO-32796's first guardrail forbids outright.
//
// Shared by create and resubmit because the guard has to hold on every route that
// can leave a card `pending`, not just the one that files it. Resubmit replaces the
// payload wholesale and returns the card to `pending`, so guarding creation alone
// left the whole failure mode reachable in two calls: file a compliant card, have
// the board send it back, then resubmit it prose-only and have it approved.
//
// Deliberately scoped to caller-supplied payloads. The budget watcher's own
// threshold cards are filed through insertApproval() (services/budgets.ts) and
// reach neither route — correctly, because such a card records that a cap was
// *crossed*, not a decided figure to raise it *to*. There is no target to declare
// until the board writes one at /costs, and inventing one here would be precisely
// the guess this refusal exists to prevent.
function budgetAssertionRefusal(type: string, payload: unknown) {
  if (type !== "budget_override_required") return null;
  if (extractEnforcementAssertions(payload).length > 0) return null;

  return {
    error:
      "`budget_override_required` requires at least one machine-checkable entry in " +
      "`payload.enforcement_assertions`; prose figures cannot be verified against enforcement",
    details: {
      code: "budget_approval_missing_enforcement_assertion",
      // The `enforcement_assertions` fragment to merge into the payload — not a
      // whole card. The refusal has to be fixable in a single retry: these cards
      // are filed when a cap is about to stop an agent, so a guard that costs a
      // round of guesswork is its own outage.
      //
      // Every field here is either forced to be replaced or safe to copy. A
      // fragment built to be copied has to assume it *will* be, verbatim, minus
      // only what the caller is obliged to touch:
      //   - `policyId` — the one field the server cannot supply, so it is spelled
      //     to be unusable rather than plausible: a copied placeholder passes here
      //     and is then refused by the reconciler as `missing_policy`, which is
      //     coverage in name only.
      //   - `label` — same treatment, for the same reason one layer out. It is not
      //     inert: extractEnforcementAssertions() reads it and describeDrift()
      //     prepends it to the raised issue ("- CTO `<id>` — decided ..."), so a
      //     real-looking name that survives the copy misattributes another agent's
      //     drift to whoever the example happened to name.
      //   - `expected_usd` — the figure the caller came to state, so it cannot
      //     survive by accident.
      //   - no `from_usd`: the remediation below says never to invent one, and an
      //     example that ships a concrete starting figure invites exactly that.
      example_assertions: [
        {
          kind: BUDGET_POLICY_AMOUNT_ASSERTION,
          policyId: "<replace with the budget_policies.id uuid>",
          expected_usd: 32000,
          label: "<replace with the agent or scope this policy caps>",
        },
      ],
      remediation:
        "Add one entry per policy this decision changes, under `payload.enforcement_assertions`. " +
        "`policyId` is a `budget_policies.id` uuid — NOT an agent id; read it from the budget " +
        "policy that enforces the cap. Give the target as `expected_usd` (dollars) or " +
        "`expected_amount_cents` (integer cents). `label` is printed into the drift report this " +
        "assertion raises, so set it to the agent or scope this policy actually caps — a label " +
        "left over from the example misattributes the drift. If you have the figure the change " +
        "starts from, record it as `from_usd` / `from_amount_cents`: it is retained on the card " +
        "so a later reader can tell 'never applied' from 'applied and then superseded'. Nothing " +
        "reads it yet, so never invent one — only the target is required. On resubmit, send the " +
        "corrected assertions in the resubmit body: the check runs against the payload that will " +
        "end up pending, and a card filed before this guard existed has none stored.",
    },
  };
}

function statusOnlyEscalationSourceIssueId(contextSnapshot: unknown): string | null {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const sourceIssueId = (contextSnapshot as Record<string, unknown>).sourceIssueId;
  return typeof sourceIssueId === "string" && sourceIssueId.trim() ? sourceIssueId : null;
}

function isStatusOnlyCheapRecoveryContext(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return false;
  const context = contextSnapshot as Record<string, unknown>;
  return context.modelProfile === "cheap" &&
    context.recoveryIntent === "status_only" &&
    context.allowDeliverableWork === false &&
    context.allowDocumentUpdates === false &&
    context.resumeRequiresNormalModel === true;
}

function isPlanningOnlyRecoveryContext(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return false;
  const context = contextSnapshot as Record<string, unknown>;
  return context.recoveryIntent === "planning_only" &&
    context.allowDeliverableWork === false &&
    context.allowDocumentUpdates === true &&
    context.resumeRequiresNormalModel === false;
}

type ApprovalRunContextDecision =
  | { allowed: false }
  | { allowed: true; boardEscalationCoalesceKey?: string };

const ALLOWED: ApprovalRunContextDecision = { allowed: true };

export function approvalRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const svc = approvalService(db);
  const access = accessService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  async function requireApprovalAccess(req: Request, id: string) {
    const approval = await svc.getById(id);
    if (!approval || !hasCompanyAccess(req, approval.companyId)) {
      return null;
    }
    assertCompanyAccess(req, approval.companyId);
    return approval;
  }

  async function assertApprovalAccessAllowed(req: Request, res: any, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Approvals are outside this actor's authorization boundary" });
    return false;
  }

  /**
   * `company_scope:read` gets you the card; it does not get you the hire's
   * embedded agent configuration. Second, narrower verdict resolved per request
   * and threaded into every approval serialization. PEN-2777.
   */
  async function approvalReadOptions(req: Request, companyId: string) {
    return { includeAgentConfig: await actorCanReadAgentConfig(req, access, companyId) };
  }

  async function assertApprovalMutationAllowedByRunContext(
    req: Request,
    res: any,
    companyId: string,
    options: { requestedType?: unknown; requestedIssueIds?: unknown } = {},
  ): Promise<ApprovalRunContextDecision> {
    if (req.actor.type !== "agent") return ALLOWED;
    const runId = req.actor.runId?.trim();
    if (!runId || !req.actor.agentId) return ALLOWED;

    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== companyId || run.agentId !== req.actor.agentId) return ALLOWED;
    const statusOnly = isStatusOnlyCheapRecoveryContext(run.contextSnapshot);
    const planningOnly = isPlanningOnlyRecoveryContext(run.contextSnapshot);
    if (!statusOnly && !planningOnly) return ALLOWED;

    const refuse = (error: string, extra: Record<string, unknown> = {}): ApprovalRunContextDecision => {
      res.status(403).json({
        error,
        details: {
          companyId,
          runId: run.id,
          ...(statusOnly ? {
            modelProfile: "cheap",
            allowedApprovalType: BOARD_ESCALATION_APPROVAL_TYPE,
            ...STATUS_ONLY_RECOVERY_RESUME_GUIDANCE,
          } : {}),
          recoveryIntent: planningOnly ? "planning_only" : "status_only",
          resumeRequiresNormalModel: statusOnly,
          ...extra,
        },
      });
      return { allowed: false };
    };

    if (planningOnly) {
      return refuse("Planning-only recovery runs cannot create or modify approvals");
    }

    if (options.requestedType !== BOARD_ESCALATION_APPROVAL_TYPE) {
      return refuse(
        "Cheap status-only recovery runs can only create `request_board_approval` approvals; " +
        "every other approval create/modify action requires a normal-model run",
      );
    }

    const sourceIssueId = statusOnlyEscalationSourceIssueId(run.contextSnapshot);
    if (!sourceIssueId) {
      return refuse(
        "This status-only run cannot file a board escalation: its run context has no source issue",
      );
    }

    const requestedIssueIds = Array.isArray(options.requestedIssueIds)
      ? Array.from(new Set(options.requestedIssueIds.filter((value): value is string => typeof value === "string")))
      : [];
    if (!requestedIssueIds.includes(sourceIssueId)) {
      return refuse(
        "A status-only run must link its board escalation to the source issue from its run context",
        { sourceIssueId },
      );
    }

    const unrelatedIssueIds = requestedIssueIds.filter((issueId) => issueId !== sourceIssueId);
    if (unrelatedIssueIds.length > 0) {
      return refuse(
        "A status-only run may only link a board escalation to its source issue",
        { sourceIssueId, unrelatedIssueIds },
      );
    }

    // Do not authorize from an ID alone: authorization decisions depend on the source issue's
    // current assignee, origin, and scope. Passing a partial resource would make an assigned source
    // look unassigned and could trigger the generic company-agent allow path. The source is looked
    // up and authorized before the approval is created or linked.
    const sourceIssue = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        projectId: issues.projectId,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        createdByAgentId: issues.createdByAgentId,
        status: issues.status,
        originKind: issues.originKind,
        originId: issues.originId,
      })
      .from(issues)
      .where(and(eq(issues.id, sourceIssueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!sourceIssue) {
      return refuse(
        "This status-only run cannot file a board escalation: its source issue is unavailable in this company",
        { sourceIssueId },
      );
    }

    const sourceAuthorization = await access.decide({
      actor: req.actor,
      action: "issue:mutate",
      resource: {
        type: "issue",
        companyId: sourceIssue.companyId,
        issueId: sourceIssue.id,
        projectId: sourceIssue.projectId,
        parentIssueId: sourceIssue.parentId,
        assigneeAgentId: sourceIssue.assigneeAgentId,
        assigneeUserId: sourceIssue.assigneeUserId,
        createdByAgentId: sourceIssue.createdByAgentId ?? null,
        status: sourceIssue.status,
        originKind: sourceIssue.originKind,
        originId: sourceIssue.originId ?? null,
      },
      scope: {
        issueId: sourceIssue.id,
        projectId: sourceIssue.projectId,
        parentIssueId: sourceIssue.parentId,
        assigneeAgentId: sourceIssue.assigneeAgentId,
        assigneeUserId: sourceIssue.assigneeUserId,
        originKind: sourceIssue.originKind ?? null,
        originId: sourceIssue.originId ?? null,
      },
    });
    if (!sourceAuthorization.allowed) {
      return refuse(
        "This status-only run is not authorized to escalate its source issue",
        { sourceIssueId, authorizationReason: sourceAuthorization.reason },
      );
    }

    const boardEscalationCoalesceKey = await resolveBoardEscalationCoalesceKey(sourceIssue);
    return boardEscalationCoalesceKey ? { allowed: true, boardEscalationCoalesceKey } : ALLOWED;
  }

  /**
   * The key that makes one incident raise one card (BLO-24744).
   *
   * Only liveness escalations get one: they are the run class minted per repair target by a
   * detector, so N of them can be dispatched for one root cause with no filer able to see the
   * others. Every other status-only escalation is filed by an agent that chose to file it and can
   * pass its own `idempotencyKey`.
   *
   * For `blocked_by_uninvokable_assignee` the human decides about the AGENT, so that is the key —
   * one pause, one card, however many of its issues are blocking. The repair-target issue is the
   * fallback: still enough to collapse repeat filings for that one incident across runs.
   */
  async function resolveBoardEscalationCoalesceKey(sourceIssue: {
    companyId: string;
    originKind: string | null;
    originId: string | null;
  }): Promise<string | null> {
    if (sourceIssue.originKind !== RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation) return null;
    const incident = parseIssueGraphLivenessIncidentKey(sourceIssue.originId);
    if (!incident || incident.companyId !== sourceIssue.companyId) return null;

    // The last key component is `blockerIssueId ?? participantAgentId ?? "none"`, so it is an issue
    // id for the blocked_by_* states and an agent id (or the "none" sentinel) for the others. Only
    // look up an id that can be one — `issues.id` is a uuid column and would raise on the sentinel.
    const repairTarget = isUuidLike(incident.leafIssueId)
      ? await db
        .select({ assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(and(eq(issues.id, incident.leafIssueId), eq(issues.companyId, sourceIssue.companyId)))
        .then((rows) => rows[0] ?? null)
      : null;

    return buildIssueGraphLivenessBoardEscalationKey({
      companyId: sourceIssue.companyId,
      state: incident.state,
      rootCauseId: repairTarget?.assigneeAgentId ?? incident.leafIssueId,
    });
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;

    const parsed = listApprovalsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
      return;
    }
    const { view, status, type, issueId, requestedByAgentId, idempotencyKey } = parsed.data;

    // `count` and `summary` exist so that checking whether an ask is already filed is
    // cheaper than filing it again. The default `full` view is unchanged.
    const filters = {
      status,
      type,
      issueId,
      requestedByAgentId,
      idempotencyKey,
    };
    if (view === "count") {
      const count = await svc.countBy(companyId, filters);
      res.json({ count });
      return;
    }

    if (view === "summary") {
      const rows = await svc.listSummary(companyId, filters);
      res.json(rows);
      return;
    }

    const result = await svc.list(companyId, filters);
    const readOptions = await approvalReadOptions(req, companyId);
    res.json(result.map((approval) => redactApprovalPayload(approval, readOptions)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    res.json(redactApprovalPayload(approval, await approvalReadOptions(req, approval.companyId)));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const runContextDecision = await assertApprovalMutationAllowedByRunContext(req, res, companyId, {
      requestedType: req.body.type,
      requestedIssueIds: uniqueIssueIds,
    });
    if (!runContextDecision.allowed) return;
    // The coalescing key below is company-scoped, which means it deliberately ignores who filed the
    // card. That is only safe while the namespace is unforgeable: a caller that could plant a row
    // under `harness_liveness_board:<company>:<state>:<agent>` would have the next genuine
    // escalation for that incident silently replay ITS card instead of raising one. The ids are all
    // guessable by any company agent, so reserve the namespace rather than rely on obscurity.
    if (
      !runContextDecision.boardEscalationCoalesceKey &&
      typeof req.body.idempotencyKey === "string" &&
      req.body.idempotencyKey.startsWith(`${RECOVERY_KEY_PREFIXES.issueGraphLivenessBoardEscalation}:`)
    ) {
      res.status(422).json({
        error: "`idempotencyKey` may not use the server-reserved liveness board-escalation namespace",
        details: {
          reservedPrefix: `${RECOVERY_KEY_PREFIXES.issueGraphLivenessBoardEscalation}:`,
          remediation:
            "Choose your own idempotency key. Paperclip derives this key itself for approvals filed " +
            "from a `harness_liveness_escalation` issue, so that one incident raises one card.",
        },
      });
      return;
    }
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    const normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;
    if (
      approvalInput.type === "hire_agent" &&
      Object.prototype.hasOwnProperty.call(normalizedPayload, "agentId")
    ) {
      res.status(422).json({
        error: "Generic hire approvals cannot bind an existing agent; use the agent hire endpoint",
      });
      return;
    }

    const budgetRefusal = budgetAssertionRefusal(approvalInput.type, normalizedPayload);
    if (budgetRefusal) {
      res.status(422).json(budgetRefusal);
      return;
    }

    const actor = getActorInfo(req);
    const requestedByAgentId = actor.actorType === "agent" ? actor.actorId : null;
    const requestedByUserId = actor.actorType === "user" ? actor.actorId : null;
    const payloadObj =
      typeof normalizedPayload === "object" && normalizedPayload !== null
        ? (normalizedPayload as Record<string, unknown>)
        : {};
    const approvalTitle =
      typeof payloadObj.title === "string" ? payloadObj.title : undefined;
    const approvalDescription =
      typeof payloadObj.description === "string"
        ? payloadObj.description
        : typeof payloadObj.note === "string"
          ? payloadObj.note
          : undefined;

    const publishCreatedActivityRef: { current: (() => void) | null } = { current: null };
    // A liveness escalation's card is the incident's, not the filer's: the detector mints one
    // escalation per repair target, so the run filing this one cannot see its siblings and cannot
    // pick a key that collapses with theirs. The server picks it, and overrides any caller key —
    // deferring to the caller here is exactly how one pause becomes N identical cards (BLO-24744).
    const coalesceKey = runContextDecision.boardEscalationCoalesceKey;
    const { approval, deduplicated } = await svc.createWithIdempotency(companyId, {
      ...approvalInput,
      payload: normalizedPayload,
      // Requester identity is derived only from the authenticated actor, and exactly one
      // requester column is populated. Letting a user also nominate `requestedByAgentId`
      // makes the idempotency key ambiguous because both requester-scoped unique indexes
      // would apply to the same row.
      requestedByAgentId,
      requestedByUserId,
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
      ...(coalesceKey ? { idempotencyKey: coalesceKey } : {}),
    }, {
      ...(coalesceKey ? { dedupeScope: "company" as const } : {}),
      afterCreate: async (txDb, createdApproval) => {
        if (uniqueIssueIds.length > 0) {
          await issueApprovalService(txDb).linkManyForApproval(createdApproval.id, uniqueIssueIds, {
            agentId: actor.agentId,
            userId: actor.actorType === "user" ? actor.actorId : null,
          });
        }

        publishCreatedActivityRef.current = await logActivity(txDb, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "approval.created",
          entityType: "approval",
          entityId: createdApproval.id,
          details: {
            type: createdApproval.type,
            approvalId: createdApproval.id,
            issueIds: uniqueIssueIds,
            ...(approvalTitle !== undefined ? { title: approvalTitle } : {}),
            ...(approvalDescription !== undefined
              ? { description: approvalDescription }
              : {}),
          },
        }, { deferPublish: true });
      },
    });

    // Issue links are applied on both paths. The insert is onConflictDoNothing, so
    // re-linking the same issues is a no-op, and a retry that names a new issue still
    // gets it attached rather than silently losing it. New filings link inside the
    // create transaction above, with the human-facing activity log; replays must not
    // emit another activity card.
    if (deduplicated && uniqueIssueIds.length > 0) {
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    publishCreatedActivityRef.current?.();

    // A replay is not a new filing. Answer with the original plus a readback so the
    // requester learns it is still pending without having to file again to find out —
    // silence is otherwise indistinguishable from "not yet decided", which is what
    // makes retrying the only way to get information, and the queue flood downstream.
    if (deduplicated) {
      const pendingForMs = Date.now() - new Date(approval.createdAt).getTime();
      res.status(200).json({
        ...redactApprovalPayload(approval, await approvalReadOptions(req, companyId)),
        deduplicated: true,
        deduplicationReason: "idempotency_key",
        pendingSince: approval.createdAt,
        pendingForMs,
        statusReadback:
          `Approval ${approval.id} (${approval.type}) is still ${approval.status}, filed ` +
          `${new Date(approval.createdAt).toISOString()} (${Math.floor(pendingForMs / 60000)} min ago). ` +
          `No duplicate was created.`,
      });
      return;
    }

    res.status(201).json(redactApprovalPayload(approval, await approvalReadOptions(req, companyId)));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval, applied } = await resolveApprovalWithSideEffects(db, options, {
      approvalId: id,
      decision: "approve",
      decidedByUserId,
      decisionNote: req.body.decisionNote,
      actor: {
        activityActorType: "user",
        activityActorId: req.actor.userId ?? "board",
        requesterWakeActorType: "user",
        requesterWakeActorId: req.actor.userId ?? "board",
      },
    });

    res.json(approvalResolutionResponse(approval, applied, await approvalReadOptions(req, approval.companyId)));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval, applied } = await resolveApprovalWithSideEffects(db, options, {
      approvalId: id,
      decision: "reject",
      decidedByUserId,
      decisionNote: req.body.decisionNote,
      actor: {
        activityActorType: "user",
        activityActorId: req.actor.userId ?? "board",
        requesterWakeActorType: "user",
        requesterWakeActorId: req.actor.userId ?? "board",
      },
    });

    res.json(approvalResolutionResponse(approval, applied, await approvalReadOptions(req, approval.companyId)));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      if (!(await requireApprovalAccess(req, id))) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
      const decidedByUserId = req.actor.userId ?? "board";
      const { approval, applied } = await resolveApprovalWithSideEffects(db, options, {
        approvalId: id,
        decision: "revise",
        decidedByUserId,
        decisionNote: req.body.decisionNote,
        actor: {
          activityActorType: "user",
          activityActorId: req.actor.userId ?? "board",
          requesterWakeActorType: "user",
          requesterWakeActorId: req.actor.userId ?? "board",
        },
      });

      res.json(approvalResolutionResponse(approval, applied, await approvalReadOptions(req, approval.companyId)));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!existing) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, existing.companyId)).allowed) return;

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }

    let normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            req.body.payload,
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    if (existing.type === "hire_agent" && normalizedPayload) {
      const submittedAgentId = normalizedPayload.agentId;
      if (
        (existing.linkedAgentId && submittedAgentId !== undefined && submittedAgentId !== existing.linkedAgentId) ||
        (!existing.linkedAgentId && Object.prototype.hasOwnProperty.call(normalizedPayload, "agentId"))
      ) {
        res.status(422).json({ error: "Hire approval agent binding cannot be changed" });
        return;
      }
      if (existing.linkedAgentId) {
        normalizedPayload = { ...normalizedPayload, agentId: existing.linkedAgentId };
      }
    }
    // Guard the payload that will actually end up `pending`. `svc.resubmit()` keeps
    // the existing one when the caller supplies none, so checking only the supplied
    // payload would let a card filed before this guard existed — every one of them,
    // including `304ea443` — walk back to `pending` unverifiable on an empty body.
    //
    // Two carve-outs, both from Ally's review of `ee43166`:
    //
    // Status first, because only a `revision_requested` card can reach `pending`.
    // Anything else fails in `svc.resubmit()` on status, and answering that with an
    // assertion complaint points the caller at the wrong problem. The transactional
    // check in the service stays authoritative; this only picks the error.
    //
    // Then: the stored-payload half must not apply to the budget watcher's own
    // threshold cards. Those record that a cap was *crossed*, not a figure to raise
    // it *to*, so they have no target to declare — the same reason creation exempts
    // them (they are filed through insertApproval() and never reach that route).
    // Applying it here refused the board's only resubmit affordance (ApprovalDetail
    // sends no payload) for a card no payload can satisfy, leaving it recoverable
    // only by API — and both `budget_override_required` cards sitting in
    // `revision_requested` today are watcher cards. Server-filed is not forgeable:
    // the create route derives requester identity from the authenticated actor and
    // always populates exactly one of the two columns, so both-null means
    // insertApproval(). A *supplied* payload is still checked — an operator who
    // states a figure has stated one that must be verifiable.
    const serverFiled = !existing.requestedByAgentId && !existing.requestedByUserId;
    const skipBudgetGuard =
      existing.status !== "revision_requested" || (serverFiled && normalizedPayload === undefined);
    const budgetRefusal = skipBudgetGuard
      ? null
      : budgetAssertionRefusal(existing.type, normalizedPayload ?? existing.payload);
    if (budgetRefusal) {
      res.status(422).json(budgetRefusal);
      return;
    }

    const approval = await svc.resubmit(id, normalizedPayload);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(redactApprovalPayload(approval, await approvalReadOptions(req, approval.companyId)));
  });

  router.post("/approvals/:id/withdraw", validate(withdrawApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!existing) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, existing.companyId)).allowed) return;

    // Scoped exactly like resubmit: a requester may rescind its own ask, but
    // never another agent's. Board actors retain full reach.
    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can withdraw this approval" });
      return;
    }

    const actor = getActorInfo(req);
    const reason = req.body.reason as string;
    const approval = await svc.withdraw(id, reason, {
      userId: actor.actorType === "user" ? actor.actorId : null,
      activity: {
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
      },
    });

    res.json(redactApprovalPayload(approval, await approvalReadOptions(req, approval.companyId)));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, approval.companyId)).allowed) return;
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  return router;
}

import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
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
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo, hasCompanyAccess } from "./authz.js";
import { redactApprovalPayloadForDisplay } from "../redaction.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { resolveApprovalWithSideEffects } from "../services/approval-resolution.js";

function redactApprovalPayload<T extends { type: string; payload: Record<string, unknown> }>(
  approval: T,
): T & { redactedFields: string[] } {
  const { payload, redactedFields } = redactApprovalPayloadForDisplay(approval.type, approval.payload);
  return {
    ...approval,
    payload,
    redactedFields,
  };
}

function approvalResolutionResponse<T extends { type: string; payload: Record<string, unknown> }>(
  approval: T,
  applied: boolean,
): T & { redactedFields: string[]; applied: boolean } {
  return {
    ...redactApprovalPayload(approval),
    applied,
  };
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

  async function assertApprovalMutationAllowedByRunContext(req: Request, res: any, companyId: string) {
    if (req.actor.type !== "agent") return true;
    const runId = req.actor.runId?.trim();
    if (!runId || !req.actor.agentId) return true;

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
    if (!run || run.companyId !== companyId || run.agentId !== req.actor.agentId) return true;
    if (!isStatusOnlyCheapRecoveryContext(run.contextSnapshot)) return true;

    res.status(403).json({
      error: "Cheap status-only recovery runs cannot create or modify approvals",
      details: {
        companyId,
        runId: run.id,
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        resumeRequiresNormalModel: true,
      },
    });
    return false;
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
    res.json(result.map((approval) => redactApprovalPayload(approval)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    res.json(redactApprovalPayload(approval));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, companyId))) return;
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
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
    }, {
      afterCreate: async (txDb, createdApproval) => {
        if (uniqueIssueIds.length > 0) {
          await issueApprovalService(txDb).linkManyForApproval(createdApproval.id, uniqueIssueIds, {
            agentId: actor.agentId,
            userId: actor.actorType === "user" ? actor.actorId : null,
          });
        }

        await logActivity(txDb, {
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
        });
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

    // A replay is not a new filing. Answer with the original plus a readback so the
    // requester learns it is still pending without having to file again to find out —
    // silence is otherwise indistinguishable from "not yet decided", which is what
    // makes retrying the only way to get information, and the queue flood downstream.
    if (deduplicated) {
      const pendingForMs = Date.now() - new Date(approval.createdAt).getTime();
      res.status(200).json({
        ...redactApprovalPayload(approval),
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

    res.status(201).json(redactApprovalPayload(approval));
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

    res.json(approvalResolutionResponse(approval, applied));
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

    res.json(approvalResolutionResponse(approval, applied));
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

      res.json(approvalResolutionResponse(approval, applied));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!existing) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, existing.companyId))) return;

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
    res.json(redactApprovalPayload(approval));
  });

  router.post("/approvals/:id/withdraw", validate(withdrawApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!existing) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, existing.companyId))) return;

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

    res.json(redactApprovalPayload(approval));
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
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, approval.companyId))) return;
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

import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import {
  approvalService,
  heartbeatService,
  issueApprovalService,
  logActivity,
} from "./index.js";

export type ApprovalResolutionDecision = "approve" | "reject" | "revise";

const REQUESTER_WAKE_REASONS: Record<ApprovalResolutionDecision, string> = {
  approve: "approval_approved",
  reject: "approval_rejected",
  revise: "approval_revision_requested",
};

const ACTIVITY_SOURCES: Record<ApprovalResolutionDecision, string> = {
  approve: "approval.approved",
  reject: "approval.rejected",
  revise: "approval.revision_requested",
};

export interface ApprovalResolutionActor {
  activityActorType: "agent" | "user" | "system" | "plugin";
  activityActorId: string;
  activityAgentId?: string | null;
  activityRunId?: string | null;
  requesterWakeActorType: "user" | "agent" | "system";
  requesterWakeActorId?: string | null;
}

export interface ResolveApprovalWithSideEffectsInput {
  approvalId: string;
  decision: ApprovalResolutionDecision;
  decidedByUserId: string;
  decisionNote?: string | null;
  actor: ApprovalResolutionActor;
}

export async function resolveApprovalWithSideEffects(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
  input: ResolveApprovalWithSideEffectsInput,
) {
  const svc = approvalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const { approvalId, decision, decidedByUserId, decisionNote, actor } = input;

  // Every decided state wakes the requester, not just `approve`. A silent
  // `rejected` is worse than a silent `revision_requested`: it *looks* answered,
  // so nothing re-examines it, and the board's reasoning sits unread on a card
  // no run ever opens again (BLO-27036 measured 4 cards unread for 10-11 days).
  // The wake carries `decisionNote` so the woken run can act on the reasoning
  // without a second fetch.
  async function queueRequesterWake(
    approval: {
      id: string;
      companyId: string;
      status: string;
      decisionNote: string | null;
      requestedByAgentId: string | null;
    },
    linkedIssueIds: string[],
  ) {
    if (!approval.requestedByAgentId) return;
    const primaryIssueId = linkedIssueIds[0] ?? null;
    const reason = REQUESTER_WAKE_REASONS[decision];
    const activitySource = ACTIVITY_SOURCES[decision];
    try {
      const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason,
        payload: {
          approvalId: approval.id,
          approvalStatus: approval.status,
          decisionNote: approval.decisionNote ?? null,
          issueId: primaryIssueId,
          issueIds: linkedIssueIds,
        },
        requestedByActorType: actor.requesterWakeActorType,
        requestedByActorId: actor.requesterWakeActorId ?? null,
        contextSnapshot: {
          source: activitySource,
          approvalId: approval.id,
          approvalStatus: approval.status,
          decisionNote: approval.decisionNote ?? null,
          issueId: primaryIssueId,
          issueIds: linkedIssueIds,
          taskId: primaryIssueId,
          wakeReason: reason,
        },
      });

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: actor.activityActorType,
        actorId: actor.activityActorId,
        agentId: actor.activityAgentId ?? null,
        runId: actor.activityRunId ?? null,
        action: "approval.requester_wakeup_queued",
        entityType: "approval",
        entityId: approval.id,
        details: {
          requesterAgentId: approval.requestedByAgentId,
          wakeRunId: wakeRun?.id ?? null,
          approvalStatus: approval.status,
          linkedIssueIds,
          decidedByUserId,
        },
      });
    } catch (err) {
      logger.warn(
        {
          err,
          approvalId: approval.id,
          requestedByAgentId: approval.requestedByAgentId,
        },
        "failed to queue requester wakeup after approval",
      );
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: actor.activityActorType,
        actorId: actor.activityActorId,
        agentId: actor.activityAgentId ?? null,
        runId: actor.activityRunId ?? null,
        action: "approval.requester_wakeup_failed",
        entityType: "approval",
        entityId: approval.id,
        details: {
          requesterAgentId: approval.requestedByAgentId,
          approvalStatus: approval.status,
          linkedIssueIds,
          decidedByUserId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  if (decision === "revise") {
    const approval = await svc.requestRevision(approvalId, decidedByUserId, decisionNote);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.activityActorType,
      actorId: actor.activityActorId,
      agentId: actor.activityAgentId ?? null,
      runId: actor.activityRunId ?? null,
      action: "approval.revision_requested",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, decidedByUserId },
    });
    const revisionIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
    await queueRequesterWake(approval, revisionIssues.map((issue) => issue.id));
    return { approval, applied: true };
  }

  const { approval, applied } =
    decision === "approve"
      ? await svc.approve(approvalId, decidedByUserId, decisionNote)
      : await svc.reject(approvalId, decidedByUserId, decisionNote);

  if (!applied) {
    return { approval, applied };
  }

  const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
  const linkedIssueIds = linkedIssues.map((issue) => issue.id);

  await logActivity(db, {
    companyId: approval.companyId,
    actorType: actor.activityActorType,
    actorId: actor.activityActorId,
    agentId: actor.activityAgentId ?? null,
    runId: actor.activityRunId ?? null,
    action: decision === "approve" ? "approval.approved" : "approval.rejected",
    entityType: "approval",
    entityId: approval.id,
    details: {
      type: approval.type,
      requestedByAgentId: approval.requestedByAgentId,
      linkedIssueIds,
      decidedByUserId,
    },
  });

  await queueRequesterWake(approval, linkedIssueIds);

  return { approval, applied };
}

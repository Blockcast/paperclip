import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals, issues } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { projectApprovalPayloadForRead, type AgentWorkspaceCommandViewer } from "../agent-redaction.js";

interface LinkActor {
  agentId?: string | null;
  userId?: string | null;
}

export function issueApprovalService(db: Db) {
  async function getIssue(issueId: string) {
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  async function getApproval(approvalId: string) {
    return db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .then((rows) => rows[0] ?? null);
  }

  async function assertIssueAndApprovalSameCompany(issueId: string, approvalId: string) {
    const issue = await getIssue(issueId);
    if (!issue) throw notFound("Issue not found");

    const approval = await getApproval(approvalId);
    if (!approval) throw notFound("Approval not found");

    if (issue.companyId !== approval.companyId) {
      throw unprocessable("Issue and approval must belong to the same company");
    }

    return { issue, approval };
  }

  return {
    /**
     * This is the THIRD read path to the same `hire_agent` payload, so it applies the same two
     * gates `routes/approvals.ts` does, through the same shared projection:
     *
     *  - `includeAgentConfig` is the caller's `agent_config:read` verdict (PEN-2777).
     *  - `workspaceCommandViewer` is the caller's `workspace_runtime:read` verdict, which decides
     *    the host-executed `workspaceStrategy` command strings inside a config the caller may
     *    otherwise read (PEN-5225).
     *
     * Both default to WITHHOLDING, so a caller that does not resolve a verdict discloses nothing.
     * That default is load-bearing here: two of this method's five callers read only `status` and
     * pass no options at all.
     */
    listApprovalsForIssue: async (
      issueId: string,
      options: {
        includeAgentConfig?: boolean;
        workspaceCommandViewer?: AgentWorkspaceCommandViewer;
      } = {},
    ) => {
      const issue = await getIssue(issueId);
      if (!issue) throw notFound("Issue not found");

      const result = await db
        .select({
          id: approvals.id,
          companyId: approvals.companyId,
          type: approvals.type,
          requestedByAgentId: approvals.requestedByAgentId,
          requestedByUserId: approvals.requestedByUserId,
          status: approvals.status,
          payload: approvals.payload,
          decisionNote: approvals.decisionNote,
          decidedByUserId: approvals.decidedByUserId,
          decidedAt: approvals.decidedAt,
          createdAt: approvals.createdAt,
          updatedAt: approvals.updatedAt,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(eq(issueApprovals.issueId, issueId))
        .orderBy(desc(issueApprovals.createdAt));
      return result.map((approval) => {
        const { payload, redactedFields, withheldFields } = projectApprovalPayloadForRead(
          approval.type,
          approval.payload,
          {
            includeAgentConfig: options.includeAgentConfig ?? false,
            workspaceCommandViewer: options.workspaceCommandViewer,
          },
        );
        return { ...approval, payload, redactedFields, withheldFields };
      });
    },

    listIssuesForApproval: async (approvalId: string) => {
      const approval = await getApproval(approvalId);
      if (!approval) throw notFound("Approval not found");

      return db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          goalId: issues.goalId,
          parentId: issues.parentId,
          title: issues.title,
          description: issues.description,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          createdByAgentId: issues.createdByAgentId,
          createdByUserId: issues.createdByUserId,
          issueNumber: issues.issueNumber,
          identifier: issues.identifier,
          requestDepth: issues.requestDepth,
          billingCode: issues.billingCode,
          startedAt: issues.startedAt,
          completedAt: issues.completedAt,
          cancelledAt: issues.cancelledAt,
          createdAt: issues.createdAt,
          updatedAt: issues.updatedAt,
        })
        .from(issueApprovals)
        .innerJoin(issues, eq(issueApprovals.issueId, issues.id))
        .where(eq(issueApprovals.approvalId, approvalId))
        .orderBy(desc(issueApprovals.createdAt));
    },

    link: async (issueId: string, approvalId: string, actor?: LinkActor) => {
      const { issue } = await assertIssueAndApprovalSameCompany(issueId, approvalId);

      await db
        .insert(issueApprovals)
        .values({
          companyId: issue.companyId,
          issueId,
          approvalId,
          linkedByAgentId: actor?.agentId ?? null,
          linkedByUserId: actor?.userId ?? null,
        })
        .onConflictDoNothing();

      return db
        .select()
        .from(issueApprovals)
        .where(and(eq(issueApprovals.issueId, issueId), eq(issueApprovals.approvalId, approvalId)))
        .then((rows) => rows[0] ?? null);
    },

    unlink: async (issueId: string, approvalId: string) => {
      await assertIssueAndApprovalSameCompany(issueId, approvalId);
      await db
        .delete(issueApprovals)
        .where(and(eq(issueApprovals.issueId, issueId), eq(issueApprovals.approvalId, approvalId)));
    },

    linkManyForApproval: async (approvalId: string, issueIds: string[], actor?: LinkActor) => {
      if (issueIds.length === 0) return;

      const approval = await getApproval(approvalId);
      if (!approval) throw notFound("Approval not found");

      const uniqueIssueIds = Array.from(new Set(issueIds));
      const rows = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
        })
        .from(issues)
        .where(inArray(issues.id, uniqueIssueIds));

      if (rows.length !== uniqueIssueIds.length) {
        throw notFound("One or more issues not found");
      }

      for (const row of rows) {
        if (row.companyId !== approval.companyId) {
          throw unprocessable("Issue and approval must belong to the same company");
        }
      }

      await db
        .insert(issueApprovals)
        .values(
          uniqueIssueIds.map((issueId) => ({
            companyId: approval.companyId,
            issueId,
            approvalId,
            linkedByAgentId: actor?.agentId ?? null,
            linkedByUserId: actor?.userId ?? null,
          })),
        )
        .onConflictDoNothing();
    },
  };
}

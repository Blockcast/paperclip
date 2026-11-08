import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals, issues } from "@paperclipai/db";
import { APPROVAL_UNDECIDED_STATUSES } from "@paperclipai/shared";
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
     *
     * ⚠️ This is a DECISION surface, so the projection below must carry `payloadRevision` and
     * `payloadEditedAt` (PEN-6107). `GET /issues/:id/approvals` is what `ApprovalCard` renders from
     * on `IssueDetail` and in `CommentThread` — the card with the working Approve/Reject buttons —
     * and `paperclipListIssueApprovals` reads the same endpoint. An editable payload (PEN-5766) was
     * accepted on disclosure alone; prevention was deliberately deferred. A column dropped here does
     * not fail loudly: an absent key and an unedited `0` are indistinguishable through JS property
     * access, so an edited card would render as never-edited, and the shared `Approval` type
     * declares `payloadRevision` non-optional, so the compiler cannot flag the omission either.
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
          payloadRevision: approvals.payloadRevision,
          payloadEditedAt: approvals.payloadEditedAt,
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

    /**
     * PEN-5511: the card side of the approval-link authorization decision — who
     * filed this approval, and in which company.
     *
     * Deliberately NOT `getById`: the link routes need the requester and nothing
     * else, and `approvals.payload` for a `hire_agent` card is exactly the body
     * `normalizeHireApprovalPayloadForPersistence` exists to keep out of places it
     * does not need to be. Selecting three columns keeps a payload the caller has
     * no use for out of the authorization frame entirely.
     *
     * Returns `null` for an unknown id, which the evaluator treats as "no subject"
     * and so as the pre-PEN-5511 verdict; `link`/`linkManyForApproval` still raise
     * the 404 for it, so this lookup does not change any route's error semantics.
     */
    getApprovalLinkSubject: async (approvalId: string) => {
      const row = await db
        .select({
          id: approvals.id,
          companyId: approvals.companyId,
          requestedByAgentId: approvals.requestedByAgentId,
        })
        .from(approvals)
        .where(eq(approvals.id, approvalId))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      return {
        approvalId: row.id,
        companyId: row.companyId,
        requestedByAgentId: row.requestedByAgentId ?? null,
      };
    },

    /**
     * PEN-5511: how complete is an `issueId`-filtered approval count?
     *
     * Every issue-scoped approval query answers through the `issue_approvals` join,
     * so it returns LINKED cards and nothing else. Until PEN-5511 a card filed by a
     * non-assignee could not be linked to the row it was about at all, which made
     * that join silently lossy in the direction that UNDERSTATES board exposure —
     * exactly on the multi-agent incidents where two or more seats are each asking
     * the board for something. Measured on PEN-5379: three linked cards returned
     * against four standing asks, with no marker distinguishing that from a row
     * that genuinely had three.
     *
     * This bounds the loss instead of leaving it unstated. A candidate is an
     * UNDECIDED card in the same company that is NOT linked to this issue but whose
     * own payload text names the issue's identifier. That is how a card refers to a
     * row when it could not be linked to one, so it finds the cards the join drops.
     *
     * What it is and is not:
     *
     * - It is a **candidate count, not a claim**. A card may name a row as context
     *   rather than as its subject. The caller is told "this count may be partial
     *   and here is how partial", which is the whole point: a silently partial count
     *   routes a reader to a confident wrong conclusion, and one that reports its own
     *   incompleteness does not.
     * - It is a **lower bound**. A card that is about this row and never names its
     *   identifier is invisible here, and nothing can see it. Do not read
     *   `potentiallyUnlinkedCards: false` as proof of completeness.
     * - It scans only undecided cards, so the set is the live board queue rather than
     *   the whole history of the company.
     *
     * The identifier is matched on a boundary either side so `PEN-55` cannot match
     * `PEN-551`. It is passed as a parameter, never interpolated.
     *
     * ## Why the caller must hand in an approval-read verdict
     *
     * `linkedCount` reads cards that are attached to this row, so any actor that may
     * read the row may have it. The candidate count is a different question: it scans
     * every undecided card in the COMPANY that is *not* linked to this row. That is
     * approval data about other rows, and answering it for an actor that may not read
     * approvals would turn this report into a small cross-row oracle — "how many
     * pending cards elsewhere in this company name your issue" — reachable from a
     * route gated only on reading the issue.
     *
     * So the verdict is a required argument rather than a default: every call site has
     * to state which side of `company_scope:read` its caller is on, and a future one
     * cannot inherit the permissive answer by forgetting to ask. Denied, the probe is
     * not merely hidden but never runs, and the result says `approval_read_unavailable`
     * rather than `false` — same contract as `identifier_unavailable`, for the same
     * reason: "no candidates found" and "no search was permitted" are different
     * answers and only the first is evidence.
     */
    linkCoverageForIssue: async (
      companyId: string,
      issue: { id: string; identifier: string | null },
      options: { approvalReadAllowed: boolean },
    ) => {
      const linkedRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(eq(issueApprovals.issueId, issue.id));
      const linkedCount = linkedRows[0]?.count ?? 0;

      // Ordered BEFORE the identifier check on purpose. Both answers mean "no search
      // ran", but this one is true of the actor rather than of the row: reporting
      // `identifier_unavailable` to an actor that may not read approvals would imply
      // a count was waiting behind a better-identified row, which is not so.
      if (!options.approvalReadAllowed) {
        return {
          linkedCount,
          unlinkedMentionCandidateCount: null,
          potentiallyUnlinkedCards: null,
          basis: "approval_read_unavailable" as const,
        };
      }

      // Without an identifier there is no text to match on, so no candidate can be
      // found. Report that as "unmeasurable" rather than as zero candidates — the
      // two are different answers and only one of them is evidence.
      if (!issue.identifier) {
        return {
          linkedCount,
          unlinkedMentionCandidateCount: null,
          potentiallyUnlinkedCards: null,
          basis: "identifier_unavailable" as const,
        };
      }

      const candidateRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            inArray(approvals.status, [...APPROVAL_UNDECIDED_STATUSES]),
            sql`NOT EXISTS (SELECT 1 FROM ${issueApprovals} WHERE ${issueApprovals.approvalId} = ${approvals.id} AND ${issueApprovals.issueId} = ${issue.id})`,
            sql`${approvals.payload}::text ~* ('(^|[^A-Za-z0-9_-])' || ${issue.identifier} || '([^0-9]|$)')`,
          ),
        );
      const unlinkedMentionCandidateCount = candidateRows[0]?.count ?? 0;

      return {
        linkedCount,
        unlinkedMentionCandidateCount,
        potentiallyUnlinkedCards: unlinkedMentionCandidateCount > 0,
        basis: "undecided_payload_identifier_mention" as const,
      };
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

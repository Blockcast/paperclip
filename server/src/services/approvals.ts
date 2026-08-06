import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvalComments, approvals } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { logger } from "../middleware/logger.js";
import { logActivity, type LogActivityInput } from "./activity-log.js";
import { agentService } from "./agents.js";
import { budgetService } from "./budgets.js";
import { notifyHireApproved } from "./hire-hook.js";
import { instanceSettingsService } from "./instance-settings.js";

export function approvalService(db: Db) {
  const agentsSvc = agentService(db);
  const instanceSettings = instanceSettingsService(db);
  const canResolveStatuses = new Set(["pending", "revision_requested"]);
  const resolvableStatuses = Array.from(canResolveStatuses);
  type ApprovalRecord = typeof approvals.$inferSelect;
  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };

  function redactApprovalComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
    };
  }

  async function reconcileApprovedBuiltInAgent(
    dbClient: Db,
    companyId: string,
    payload: Record<string, unknown>,
  ) {
    const sourceBuiltInAgentKey = typeof payload.sourceBuiltInAgentKey === "string" ? payload.sourceBuiltInAgentKey : null;
    if (!sourceBuiltInAgentKey) return;
    const { builtInAgentService } = await import("./built-in-agents.js");
    await builtInAgentService(dbClient).ensure(companyId, sourceBuiltInAgentKey);
  }

  async function getExistingApproval(id: string, dbClient: Db = db) {
    const existing = await dbClient
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    return existing;
  }

  function payloadAgentId(approval: ApprovalRecord) {
    return typeof approval.payload.agentId === "string" ? approval.payload.agentId : null;
  }

  // Lenient half of the binding lookup: resolves the bound or legacy payload
  // agent only while it is still a pending hire in the approval's own company,
  // and reports "nothing to clean up" as null rather than as an error.
  async function findBoundPendingAgent(
    approval: ApprovalRecord,
    dbOrTx: Db = db,
  ) {
    const agentId = approval.linkedAgentId ?? payloadAgentId(approval);
    if (!agentId) return null;
    return dbOrTx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.companyId, approval.companyId),
          eq(agents.status, "pending_approval"),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  // Strict half: withdrawal must refuse rather than silently strand an agent, so
  // a payload that claims an agent the binding does not corroborate is a 409.
  async function getBoundPendingAgent(
    approval: ApprovalRecord,
    dbOrTx: Db = db,
  ) {
    const legacyPayloadAgentId = payloadAgentId(approval);
    if (!approval.linkedAgentId) {
      if (!legacyPayloadAgentId) return null;
      throw conflict("Hire approval is not bound to a pending agent", { approvalId: approval.id });
    }
    if (legacyPayloadAgentId !== approval.linkedAgentId) {
      throw conflict("Hire approval is not bound to a pending agent", { approvalId: approval.id });
    }
    const boundAgent = await findBoundPendingAgent(approval, dbOrTx);
    if (!boundAgent) {
      throw conflict("Hire approval is not bound to a pending agent", { approvalId: approval.id });
    }
    return boundAgent;
  }

  async function resolveApproval(
    id: string,
    targetStatus: "approved" | "rejected",
    decidedByUserId: string,
    decisionNote: string | null | undefined,
    dbClient: Db = db,
  ): Promise<ResolutionResult> {
    const existing = await getExistingApproval(id, dbClient);
    if (!canResolveStatuses.has(existing.status)) {
      if (existing.status === targetStatus) {
        return { approval: existing, applied: false };
      }
      throw unprocessable(
        `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
      );
    }

    const now = new Date();
    const updated = await dbClient
      .update(approvals)
      .set({
        status: targetStatus,
        decidedByUserId,
        decisionNote: decisionNote ?? null,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      return { approval: updated, applied: true };
    }

    const latest = await getExistingApproval(id, dbClient);
    if (latest.status === targetStatus) {
      return { approval: latest, applied: false };
    }

    throw unprocessable(
      `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
    );
  }

  return {
    list: (companyId: string, status?: string) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (status) conditions.push(eq(approvals.status, status));
      return db.select().from(approvals).where(and(...conditions));
    },

    getById: (id: string) =>
      db
        .select()
        .from(approvals)
        .where(eq(approvals.id, id))
        .then((rows) => rows[0] ?? null),

    findOpenHireApprovalForAgent: async (companyId: string, agentId: string) => {
      const rows = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.type, "hire_agent"),
            inArray(approvals.status, resolvableStatuses),
            eq(approvals.linkedAgentId, agentId),
          ),
        );
      return rows[0] ?? null;
    },

    create: (companyId: string, data: Omit<typeof approvals.$inferInsert, "companyId">) =>
      db
        .insert(approvals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    approve: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const now = new Date();
      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const txAgentsSvc = agentService(txDb);
        const txBudgets = budgetService(txDb);
        const { approval: updated, applied } = await resolveApproval(
          id,
          "approved",
          decidedByUserId,
          decisionNote,
          txDb,
        );

        let approval = updated;
        let hireApprovedAgentId: string | null = null;
        if (applied && updated.type === "hire_agent") {
          const payload = updated.payload as Record<string, unknown>;
          const boundPendingAgent = await findBoundPendingAgent(updated, txDb);
          const explicitAgentId = updated.linkedAgentId ?? payloadAgentId(updated);
          if (boundPendingAgent) {
            const activation = await txAgentsSvc.activatePendingApproval(boundPendingAgent.id, payload);
            if (!activation?.activated) {
              throw conflict("Pending agent could not be activated", {
                code: "pending_approval_agent_not_activatable",
                agentId: boundPendingAgent.id,
              });
            }
            hireApprovedAgentId = boundPendingAgent.id;
          } else if (explicitAgentId) {
            throw conflict("Pending agent could not be activated", {
              code: "pending_approval_agent_not_activatable",
              agentId: explicitAgentId,
            });
          } else {
            const created = await txAgentsSvc.create(updated.companyId, {
              name: String(payload.name ?? "New Agent"),
              role: String(payload.role ?? "general"),
              title: typeof payload.title === "string" ? payload.title : null,
              reportsTo: typeof payload.reportsTo === "string" ? payload.reportsTo : null,
              capabilities: typeof payload.capabilities === "string" ? payload.capabilities : null,
              adapterType: String(payload.adapterType ?? "process"),
              adapterConfig:
                typeof payload.adapterConfig === "object" && payload.adapterConfig !== null
                  ? (payload.adapterConfig as Record<string, unknown>)
                  : {},
              budgetMonthlyCents:
                typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0,
              metadata:
                typeof payload.metadata === "object" && payload.metadata !== null
                  ? (payload.metadata as Record<string, unknown>)
                  : null,
              status: "idle",
              spentMonthlyCents: 0,
              permissions: undefined,
              lastHeartbeatAt: null,
            });
            hireApprovedAgentId = created?.id ?? null;
            if (hireApprovedAgentId) {
              const persistedPayload = { ...payload, agentId: hireApprovedAgentId };
              approval = await txDb
                .update(approvals)
                .set({
                  linkedAgentId: hireApprovedAgentId,
                  payload: persistedPayload,
                  updatedAt: new Date(),
                })
                .where(eq(approvals.id, updated.id))
                .returning()
                .then((rows) => rows[0] ?? { ...updated, payload: persistedPayload });
            }
          }
          if (hireApprovedAgentId) {
            const budgetMonthlyCents =
              typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0;
            if (budgetMonthlyCents > 0) {
              await txBudgets.upsertPolicy(
                updated.companyId,
                {
                  scopeType: "agent",
                  scopeId: hireApprovedAgentId,
                  amount: budgetMonthlyCents,
                  windowKind: "calendar_month_utc",
                },
                decidedByUserId,
              );
            }
          }
        }

        return { approval, applied, hireApprovedAgentId };
      });

      const payload = result.approval.payload as Record<string, unknown>;
      const approvedPayloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
      const approvedAgentId = result.hireApprovedAgentId ?? approvedPayloadAgentId;
      const isBuiltInHire =
        result.approval.type === "hire_agent" &&
        typeof payload.sourceBuiltInAgentKey === "string" &&
        approvedAgentId !== null;

      if (result.applied && isBuiltInHire) {
        await reconcileApprovedBuiltInAgent(db, result.approval.companyId, payload);
      }
      if (result.hireApprovedAgentId) {
        void notifyHireApproved(db, {
          companyId: result.approval.companyId,
          agentId: result.hireApprovedAgentId,
          source: "approval",
          sourceId: id,
          approvedAt: now,
        }).catch(() => {});
      }

      return { approval: result.approval, applied: result.applied };
    },

    reject: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "rejected",
        decidedByUserId,
        decisionNote,
      );

      if (applied && updated.type === "hire_agent") {
        // Scoped through the same helper withdrawal uses so the two cleanup paths
        // cannot drift apart again: only ever terminate an agent that is still a
        // pending hire in this approval's company. This stays on the lenient half
        // deliberately -- a board rejection must not fail because the agent was
        // already activated or terminated out of band.
        const boundPendingAgent = await findBoundPendingAgent(updated);
        if (boundPendingAgent) await agentsSvc.terminate(boundPendingAgent.id);
      }

      return { approval: updated, applied };
    },

    requestRevision: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }

      const now = new Date();
      // Status-guarded for the same reason withdrawal is: the check above is a
      // separate statement, so a withdrawal committing in between would otherwise
      // be overwritten back to `revision_requested` -- and withdrawal has by then
      // already terminated the linked hire agent, leaving an "open" approval whose
      // agent is gone. Losing the race must be a no-op, not a silent resurrection.
      const updated = await db
        .update(approvals)
        .set({
          status: "revision_requested",
          decidedByUserId,
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) {
        const latest = await getExistingApproval(id);
        throw unprocessable("Only pending approvals can request revision", {
          approvalId: id,
          status: latest.status,
        });
      }

      return updated;
    },

    resubmit: async (id: string, payload?: Record<string, unknown>) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "revision_requested") {
        throw unprocessable("Only revision requested approvals can be resubmitted");
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "pending",
          payload: payload ?? existing.payload,
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    withdraw: async (
      id: string,
      reason: string,
      actor: {
        userId?: string | null;
        activity: Pick<LogActivityInput, "actorType" | "actorId" | "agentId">;
      },
    ) => {
      const { updated, publishWithdrawn } = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const existing = await getExistingApproval(id, txDb);
        if (existing.status !== "pending") {
          throw conflict("Only pending approvals can be withdrawn", {
            approvalId: id,
            status: existing.status,
          });
        }

        const now = new Date();
        // Status-guarded so a concurrent board decision wins rather than being
        // silently overwritten by a withdrawal racing it.
        const updated = await txDb
          .update(approvals)
          .set({
            status: "withdrawn",
            decisionNote: reason,
            decidedByUserId: actor.userId ?? null,
            decidedAt: now,
            updatedAt: now,
          })
          .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
          .returning()
          .then((rows) => rows[0] ?? null);

        if (!updated) {
          const latest = await getExistingApproval(id, txDb);
          throw conflict("Only pending approvals can be withdrawn", {
            approvalId: id,
            status: latest.status,
          });
        }

        // A hire_agent approval parks its agent in `pending_approval`. Rejecting
        // terminates it; withdrawing must too, or the agent is stranded frozen
        // with no remaining approval to decide it.
        if (updated.type === "hire_agent") {
          const boundPendingAgent = await getBoundPendingAgent(updated, txDb);
          if (boundPendingAgent) await agentService(txDb).terminate(boundPendingAgent.id);
        }

        const publishWithdrawn = await logActivity(txDb, {
          companyId: updated.companyId,
          ...actor.activity,
          action: "approval.withdrawn",
          entityType: "approval",
          entityId: updated.id,
          details: { type: updated.type, reason },
          // This transaction has already terminated the linked agent by the time
          // we get here. If the commit then fails, the default fire-and-forget
          // outbox write would still have told every plugin the approval was
          // decided -- a durable phantom for an approval that is in fact still
          // pending. Bind the event to this transaction so it retracts too.
          atomicPluginEvent: true,
        }, {
          // ...and defer the in-memory live event past commit, which
          // `atomicPluginEvent` alone does not cover: it binds the outbox row,
          // but `publishLiveEvent` is not transactional and would announce a
          // withdrawal that a failed commit then un-did.
          deferPublish: true,
        });

        return { updated, publishWithdrawn };
      });

      // Reached only on commit; a rollback throws straight past this.
      try {
        await publishWithdrawn();
      } catch (err) {
        // The withdrawal itself is committed and durable -- only its live
        // refresh hint failed. The outbox row committed with the transaction,
        // so plugins are still told.
        logger.warn(
          { err, approvalId: updated.id },
          "withdrew approval but failed to publish its live activity event",
        );
      }

      return updated;
    },

    listComments: async (approvalId: string) => {
      const existing = await getExistingApproval(approvalId);
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return db
        .select()
        .from(approvalComments)
        .where(
          and(
            eq(approvalComments.approvalId, approvalId),
            eq(approvalComments.companyId, existing.companyId),
          ),
        )
        .orderBy(asc(approvalComments.createdAt))
        .then((comments) => comments.map((comment) => redactApprovalComment(comment, censorUsernameInLogs)));
    },

    addComment: async (
      approvalId: string,
      body: string,
      actor: { agentId?: string; userId?: string },
    ) => {
      const existing = await getExistingApproval(approvalId);
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      return db
        .insert(approvalComments)
        .values({
          companyId: existing.companyId,
          approvalId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body: redactedBody,
        })
        .returning()
        .then((rows) => redactApprovalComment(rows[0], currentUserRedactionOptions.enabled));
    },
  };
}

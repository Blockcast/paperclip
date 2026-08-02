import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvalComments, approvals, issueApprovals } from "@paperclipai/db";
import { APPROVAL_UNDECIDED_STATUSES } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { logActivity, type LogActivityInput } from "./activity-log.js";
import { agentService } from "./agents.js";
import { budgetService } from "./budgets.js";
import { notifyHireApproved } from "./hire-hook.js";
import { instanceSettingsService } from "./instance-settings.js";

export function approvalService(db: Db) {
  const agentsSvc = agentService(db);
  const instanceSettings = instanceSettingsService(db);
  // Single source of truth shared with the partial unique indexes on
  // approvals.idempotency_key. If these drift, an idempotent replay becomes a raw
  // unique-violation 500 instead of returning the original.
  const canResolveStatuses = new Set<string>(APPROVAL_UNDECIDED_STATUSES);
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

    /**
     * Existence-check listing. Selects an explicit column set that excludes `payload`
     * — the whole point is that checking for an already-filed ask must cost far less
     * than re-filing it. `label` is derived server-side so the caller still gets
     * something triageable without shipping the payload body.
     *
     * `issueId` filters through the issue_approvals join table.
     */
    listSummary: async (
      companyId: string,
      filters: {
        status?: string;
        type?: string;
        issueId?: string;
        requestedByAgentId?: string;
        idempotencyKey?: string;
      } = {},
    ) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (filters.status) conditions.push(eq(approvals.status, filters.status));
      if (filters.type) conditions.push(eq(approvals.type, filters.type));
      if (filters.requestedByAgentId) {
        conditions.push(eq(approvals.requestedByAgentId, filters.requestedByAgentId));
      }
      if (filters.idempotencyKey) {
        conditions.push(eq(approvals.idempotencyKey, filters.idempotencyKey));
      }
      if (filters.issueId) {
        conditions.push(
          sql`EXISTS (SELECT 1 FROM ${issueApprovals} WHERE ${issueApprovals.approvalId} = ${approvals.id} AND ${issueApprovals.issueId} = ${filters.issueId})`,
        );
      }

      const rows = await db
        .select({
          id: approvals.id,
          type: approvals.type,
          status: approvals.status,
          requestedByAgentId: approvals.requestedByAgentId,
          requestedByUserId: approvals.requestedByUserId,
          idempotencyKey: approvals.idempotencyKey,
          createdAt: approvals.createdAt,
          decidedAt: approvals.decidedAt,
          // Derived label. `payload->>'title'` can be the literal "***REDACTED***"
          // (the field-name redactor, tracked separately on BLO-20810), and it can be
          // absent entirely, so fall back through summary and finally to a synthetic
          // identifier. A human triaging the queue always gets something to read.
          label: sql<string>`COALESCE(
            NULLIF(NULLIF(${approvals.payload} ->> 'title', ''), '***REDACTED***'),
            NULLIF(NULLIF(${approvals.payload} ->> 'summary', ''), '***REDACTED***'),
            NULLIF(NULLIF(${approvals.payload} ->> 'description', ''), '***REDACTED***'),
            ${approvals.type} || ' ' || left(${approvals.id}::text, 8)
          )`,
        })
        .from(approvals)
        .where(and(...conditions))
        .orderBy(asc(approvals.createdAt));

      return rows;
    },

    countBy: async (
      companyId: string,
      filters: { status?: string; type?: string; requestedByAgentId?: string } = {},
    ) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (filters.status) conditions.push(eq(approvals.status, filters.status));
      if (filters.type) conditions.push(eq(approvals.type, filters.type));
      if (filters.requestedByAgentId) {
        conditions.push(eq(approvals.requestedByAgentId, filters.requestedByAgentId));
      }
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(approvals)
        .where(and(...conditions));
      return rows[0]?.count ?? 0;
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

    /**
     * Create, replaying an existing undecided approval when the same requester reuses
     * an idempotency key. Returns `{ approval, deduplicated }` so the route can answer
     * 200-with-readback instead of 201, which is the signal a requester currently
     * lacks — silence today is indistinguishable from "not yet decided", so retrying
     * is the only way to find out, which is exactly what floods the queue.
     *
     * Race safety comes from the advisory lock, matching the issue-create path
     * (server/src/services/issues.ts). The partial unique indexes are the backstop.
     */
    createWithIdempotency: async (
      companyId: string,
      data: Omit<typeof approvals.$inferInsert, "companyId">,
    ): Promise<{ approval: ApprovalRecord; deduplicated: boolean }> => {
      const idempotencyKey = typeof data.idempotencyKey === "string"
        ? data.idempotencyKey.trim() || null
        : null;

      if (!idempotencyKey) {
        const approval = await db
          .insert(approvals)
          .values({ ...data, companyId, idempotencyKey: null })
          .returning()
          .then((rows) => rows[0]);
        return { approval, deduplicated: false };
      }

      // The requester identity that scopes the key. Exactly one of these is set by the
      // route; scoping to the requester means two agents filing similar asks never
      // collide, while one agent retrying always does.
      const requesterColumn = data.requestedByAgentId
        ? approvals.requestedByAgentId
        : approvals.requestedByUserId;
      const requesterValue = data.requestedByAgentId ?? data.requestedByUserId ?? null;

      return db.transaction(async (tx) => {
        const guardKey = `approval-create:idempotency:${companyId}:${requesterValue ?? "anonymous"}:${idempotencyKey}`;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${guardKey}, 0))`);

        if (requesterValue !== null) {
          const existing = await tx
            .select()
            .from(approvals)
            .where(
              and(
                eq(approvals.companyId, companyId),
                eq(approvals.idempotencyKey, idempotencyKey),
                eq(requesterColumn, requesterValue),
                inArray(approvals.status, resolvableStatuses),
              ),
            )
            .limit(1);
          if (existing[0]) return { approval: existing[0], deduplicated: true };
        }

        const approval = await tx
          .insert(approvals)
          .values({ ...data, companyId, idempotencyKey })
          .returning()
          .then((rows) => rows[0]);
        return { approval, deduplicated: false };
      });
    },

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
      return db.transaction(async (tx) => {
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

        await logActivity(txDb, {
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
        });

        return updated;
      });
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

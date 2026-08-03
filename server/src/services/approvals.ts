import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, approvalComments, approvals } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { agentService } from "./agents.js";
import { budgetService } from "./budgets.js";
import { notifyHireApproved } from "./hire-hook.js";
import { instanceSettingsService } from "./instance-settings.js";

const HIRE_RECONCILIATION_CLAIM_LEASE_MS = 5 * 60_000;
const HIRE_NOTIFICATION_CLAIM_LEASE_MS = 5 * 60_000;
const activeBuiltInHireAttemptLocks = new Set<string>();

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

  async function completeApprovedBuiltInHire(
    approval: ApprovalRecord,
    agentId: string,
    approvedAt: Date,
  ) {
    const payload = approval.payload as Record<string, unknown>;
    const reconciliation = await withBuiltInHireAttemptLock(approval, "reconciliation", async () => {
      const reconciliationClaim = await claimBuiltInHireReconciliation(approval, agentId, payload);
      if (!reconciliationClaim) return;
      try {
        await reconcileApprovedBuiltInAgent(db, approval.companyId, payload);
        await completeBuiltInHireReconciliation(approval, agentId, payload, reconciliationClaim.attemptId);
      } catch (error) {
        await releaseBuiltInHireReconciliationClaim(approval, agentId, payload, reconciliationClaim.attemptId);
        throw error;
      }
    });
    if (!reconciliation.locked) {
      return;
    }

    await deliverBuiltInHireNotification(approval, agentId, approvedAt, payload);
  }

  async function lockApproval(dbClient: Db, approvalId: string) {
    await dbClient.execute(
      sql`select ${approvals.id} from ${approvals} where ${approvals.id} = ${approvalId} for update`,
    );
  }

  async function withBuiltInHireAttemptLock<T>(
    approval: ApprovalRecord,
    kind: "reconciliation" | "notification",
    task: () => Promise<T>,
  ): Promise<{ locked: true; value: T } | { locked: false }> {
    const lockKey = `paperclip:approval:${kind}:${approval.id}`;
    if (activeBuiltInHireAttemptLocks.has(lockKey)) return { locked: false };
    activeBuiltInHireAttemptLocks.add(lockKey);
    try {
      return { locked: true as const, value: await task() };
    } finally {
      activeBuiltInHireAttemptLocks.delete(lockKey);
    }
  }

  function activityDetails(details: unknown) {
    return typeof details === "object" && details !== null && !Array.isArray(details)
      ? details as Record<string, unknown>
      : {};
  }

  function activityAttemptId(details: unknown) {
    const attemptId = activityDetails(details).attemptId;
    return typeof attemptId === "string" ? attemptId : null;
  }

  async function hasApprovalActivity(
    dbClient: Db,
    approval: ApprovalRecord,
    action: string,
  ) {
    return dbClient
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, approval.companyId),
          eq(activityLog.action, action),
          eq(activityLog.entityType, "approval"),
          eq(activityLog.entityId, approval.id),
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function latestApprovalActivity(
    dbClient: Db,
    approval: ApprovalRecord,
    actions: string[],
  ) {
    return dbClient
      .select({
        id: activityLog.id,
        action: activityLog.action,
        createdAt: activityLog.createdAt,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, approval.companyId),
          inArray(activityLog.action, actions),
          eq(activityLog.entityType, "approval"),
          eq(activityLog.entityId, approval.id),
        ),
      )
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function latestBuiltInHireReconciliationActivity(
    dbClient: Db,
    approval: ApprovalRecord,
  ) {
    return dbClient
      .select({
        id: activityLog.id,
        action: activityLog.action,
        createdAt: activityLog.createdAt,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, approval.companyId),
          inArray(activityLog.action, [
            "approval.hire_reconciliation_started",
            "approval.hire_reconciliation_failed",
          ]),
          eq(activityLog.entityType, "approval"),
          eq(activityLog.entityId, approval.id),
        ),
      )
      .orderBy(
        desc(activityLog.createdAt),
        desc(sql<number>`case ${activityLog.action}
          when 'approval.hire_reconciliation_failed' then 2
          when 'approval.hire_reconciliation_started' then 1
          else 0
        end`),
        desc(activityLog.id),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function latestBuiltInHireNotificationActivity(
    dbClient: Db,
    approval: ApprovalRecord,
  ) {
    return dbClient
      .select({
        id: activityLog.id,
        action: activityLog.action,
        createdAt: activityLog.createdAt,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, approval.companyId),
          inArray(activityLog.action, [
            "approval.hire_notification_started",
            "approval.hire_notification_succeeded",
            "approval.hire_notification_failed",
          ]),
          eq(activityLog.entityType, "approval"),
          eq(activityLog.entityId, approval.id),
        ),
      )
      .orderBy(
        desc(activityLog.createdAt),
        desc(sql<number>`case ${activityLog.action}
          when 'approval.hire_notification_succeeded' then 3
          when 'approval.hire_notification_failed' then 2
          when 'approval.hire_notification_started' then 1
          else 0
        end`),
        desc(activityLog.id),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function insertApprovalActivityIfMissing(
    dbClient: Db,
    approval: ApprovalRecord,
    action: string,
    agentId: string,
    details: Record<string, unknown>,
  ) {
    if (await hasApprovalActivity(dbClient, approval, action)) return;
    await dbClient.insert(activityLog).values({
      companyId: approval.companyId,
      actorType: "system",
      actorId: "approval_service",
      action,
      entityType: "approval",
      entityId: approval.id,
      agentId,
      details,
      createdAt: new Date(),
    });
  }

  async function hasSuccessfulHireHookActivity(
    dbClient: Db,
    approval: ApprovalRecord,
    agentId: string,
  ) {
    return dbClient
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, approval.companyId),
          eq(activityLog.action, "hire_hook.succeeded"),
          eq(activityLog.entityType, "agent"),
          eq(activityLog.entityId, agentId),
          sql`${activityLog.details} ->> 'source' = 'approval'`,
          sql`${activityLog.details} ->> 'sourceId' = ${approval.id}`,
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function hasBuiltInHireReconciliationCompleted(dbClient: Db, approval: ApprovalRecord) {
    return hasApprovalActivity(dbClient, approval, "approval.hire_reconciliation_completed");
  }

  async function hasBuiltInHireNotificationDelivered(
    dbClient: Db,
    approval: ApprovalRecord,
    agentId: string,
  ) {
    return Boolean(
      await hasApprovalActivity(dbClient, approval, "approval.hire_notification_delivered") ||
        await hasApprovalActivity(dbClient, approval, "approval.hire_post_commit_completed") ||
        await hasSuccessfulHireHookActivity(dbClient, approval, agentId)
    );
  }

  async function markBuiltInHireNotificationDelivered(
    dbClient: Db,
    approval: ApprovalRecord,
    agentId: string,
    payload: Record<string, unknown>,
  ) {
    const details = { sourceBuiltInAgentKey: payload.sourceBuiltInAgentKey };
    await insertApprovalActivityIfMissing(
      dbClient,
      approval,
      "approval.hire_notification_delivered",
      agentId,
      details,
    );
    await insertApprovalActivityIfMissing(
      dbClient,
      approval,
      "approval.hire_post_commit_completed",
      agentId,
      details,
    );
  }

  async function markBuiltInHireNotificationSucceeded(
    dbClient: Db,
    approval: ApprovalRecord,
    agentId: string,
    payload: Record<string, unknown>,
    attemptId: string,
  ) {
    await insertApprovalActivityIfMissing(
      dbClient,
      approval,
      "approval.hire_notification_succeeded",
      agentId,
      { attemptId, sourceBuiltInAgentKey: payload.sourceBuiltInAgentKey },
    );
  }

  async function claimBuiltInHireReconciliation(
    approval: ApprovalRecord,
    agentId: string,
    payload: Record<string, unknown>,
  ) {
    const attemptId = randomUUID();
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockApproval(txDb, approval.id);

      if (await hasBuiltInHireReconciliationCompleted(txDb, approval)) return null;
      const latest = await latestBuiltInHireReconciliationActivity(txDb, approval);
      if (
        latest?.action === "approval.hire_reconciliation_started" &&
        latest.createdAt.getTime() > Date.now() - HIRE_RECONCILIATION_CLAIM_LEASE_MS
      ) {
        return null;
      }

      await txDb.insert(activityLog).values({
        companyId: approval.companyId,
        actorType: "system",
        actorId: "approval_service",
        action: "approval.hire_reconciliation_started",
        entityType: "approval",
        entityId: approval.id,
        agentId,
        details: {
          attemptId,
          leaseMs: HIRE_RECONCILIATION_CLAIM_LEASE_MS,
          sourceBuiltInAgentKey: payload.sourceBuiltInAgentKey,
        },
        createdAt: new Date(),
      });
      return { attemptId };
    });
  }

  async function completeBuiltInHireReconciliation(
    approval: ApprovalRecord,
    agentId: string,
    payload: Record<string, unknown>,
    attemptId: string,
  ) {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockApproval(txDb, approval.id);
      const latest = await latestBuiltInHireReconciliationActivity(txDb, approval);
      if (
        latest?.action !== "approval.hire_reconciliation_started" ||
        activityAttemptId(latest.details) !== attemptId
      ) {
        throw conflict("Built-in hire reconciliation claim was superseded");
      }
      await insertApprovalActivityIfMissing(
        txDb,
        approval,
        "approval.hire_reconciliation_completed",
        agentId,
        { attemptId, sourceBuiltInAgentKey: payload.sourceBuiltInAgentKey },
      );
    });
  }

  async function releaseBuiltInHireReconciliationClaim(
    approval: ApprovalRecord,
    agentId: string,
    payload: Record<string, unknown>,
    attemptId: string,
  ) {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockApproval(txDb, approval.id);
      const latest = await latestBuiltInHireReconciliationActivity(txDb, approval);
      if (
        latest?.action !== "approval.hire_reconciliation_started" ||
        activityAttemptId(latest.details) !== attemptId
      ) {
        return;
      }
      await txDb.insert(activityLog).values({
        companyId: approval.companyId,
        actorType: "system",
        actorId: "approval_service",
        action: "approval.hire_reconciliation_failed",
        entityType: "approval",
        entityId: approval.id,
        agentId,
        details: { attemptId, sourceBuiltInAgentKey: payload.sourceBuiltInAgentKey },
        createdAt: new Date(),
      });
    });
  }

  async function claimBuiltInHireNotification(
    approval: ApprovalRecord,
    agentId: string,
    payload: Record<string, unknown>,
  ) {
    const attemptId = randomUUID();
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockApproval(txDb, approval.id);
      if (!await hasBuiltInHireReconciliationCompleted(txDb, approval)) return null;
      if (await hasBuiltInHireNotificationDelivered(txDb, approval, agentId)) {
        await markBuiltInHireNotificationDelivered(txDb, approval, agentId, payload);
        return null;
      }

      const latest = await latestBuiltInHireNotificationActivity(txDb, approval);
      if (latest?.action === "approval.hire_notification_succeeded") {
        const attemptId = activityAttemptId(latest.details);
        if (attemptId) {
          await markBuiltInHireNotificationDelivered(txDb, approval, agentId, payload);
        }
        return null;
      }
      if (
        latest?.action === "approval.hire_notification_started" &&
        latest.createdAt.getTime() > Date.now() - HIRE_NOTIFICATION_CLAIM_LEASE_MS
      ) {
        return null;
      }

      await txDb.insert(activityLog).values({
        companyId: approval.companyId,
        actorType: "system",
        actorId: "approval_service",
        action: "approval.hire_notification_started",
        entityType: "approval",
        entityId: approval.id,
        agentId,
        details: {
          attemptId,
          leaseMs: HIRE_NOTIFICATION_CLAIM_LEASE_MS,
          sourceBuiltInAgentKey: payload.sourceBuiltInAgentKey,
        },
        createdAt: new Date(),
      });
      return { attemptId };
    });
  }

  async function completeBuiltInHireNotification(
    approval: ApprovalRecord,
    agentId: string,
    payload: Record<string, unknown>,
    attemptId: string,
  ) {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockApproval(txDb, approval.id);
      if (await hasBuiltInHireNotificationDelivered(txDb, approval, agentId)) {
        await markBuiltInHireNotificationDelivered(txDb, approval, agentId, payload);
        return;
      }
      const latest = await latestBuiltInHireNotificationActivity(txDb, approval);
      if (
        (
          latest?.action !== "approval.hire_notification_started" &&
          latest?.action !== "approval.hire_notification_succeeded"
        ) ||
        activityAttemptId(latest.details) !== attemptId
      ) {
        throw conflict("Built-in hire notification claim was superseded");
      }
      await markBuiltInHireNotificationDelivered(txDb, approval, agentId, payload);
    });
  }

  async function releaseBuiltInHireNotificationClaim(
    approval: ApprovalRecord,
    agentId: string,
    payload: Record<string, unknown>,
    attemptId: string,
  ) {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockApproval(txDb, approval.id);
      const latest = await latestBuiltInHireNotificationActivity(txDb, approval);
      if (
        latest?.action !== "approval.hire_notification_started" ||
        activityAttemptId(latest.details) !== attemptId
      ) {
        return;
      }
      await txDb.insert(activityLog).values({
        companyId: approval.companyId,
        actorType: "system",
        actorId: "approval_service",
        action: "approval.hire_notification_failed",
        entityType: "approval",
        entityId: approval.id,
        agentId,
        details: { attemptId, sourceBuiltInAgentKey: payload.sourceBuiltInAgentKey },
        createdAt: new Date(),
      });
    });
  }

  async function deliverBuiltInHireNotification(
    approval: ApprovalRecord,
    agentId: string,
    approvedAt: Date,
    payload: Record<string, unknown>,
  ) {
    await withBuiltInHireAttemptLock(approval, "notification", async () => {
      const claim = await claimBuiltInHireNotification(approval, agentId, payload);
      if (!claim) return;

      let delivered = false;
      try {
        delivered = await notifyHireApproved(db, {
          companyId: approval.companyId,
          agentId,
          source: "approval",
          sourceId: approval.id,
          approvedAt,
        });
      } catch (error) {
        await releaseBuiltInHireNotificationClaim(approval, agentId, payload, claim.attemptId);
        throw error;
      }
      if (!delivered) {
        await releaseBuiltInHireNotificationClaim(approval, agentId, payload, claim.attemptId);
        return;
      }

      await markBuiltInHireNotificationSucceeded(db, approval, agentId, payload, claim.attemptId);
      await completeBuiltInHireNotification(approval, agentId, payload, claim.attemptId);
    });
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
            sql`${approvals.payload} ->> 'agentId' = ${agentId}`,
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
          const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
          if (payloadAgentId) {
            const activation = await txAgentsSvc.activatePendingApproval(payloadAgentId, payload);
            if (!activation?.activated) {
              throw conflict("Pending agent could not be activated", {
                code: "pending_approval_agent_not_activatable",
                agentId: payloadAgentId,
              });
            }
            hireApprovedAgentId = payloadAgentId;
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
                .set({ payload: persistedPayload, updatedAt: new Date() })
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
      const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
      const approvedAgentId = result.hireApprovedAgentId ?? payloadAgentId;
      const isBuiltInHire =
        result.approval.type === "hire_agent" &&
        typeof payload.sourceBuiltInAgentKey === "string" &&
        approvedAgentId !== null;

      if (isBuiltInHire) {
        await completeApprovedBuiltInHire(
          result.approval,
          approvedAgentId,
          result.approval.decidedAt ?? now,
        );
      } else if (result.hireApprovedAgentId) {
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
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.terminate(payloadAgentId);
        }
      }

      return { approval: updated, applied };
    },

    requestRevision: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "revision_requested",
          decidedByUserId,
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
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

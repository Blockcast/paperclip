import { and, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  projects,
} from "@paperclipai/db";
import type {
  BudgetIncident,
  BudgetIncidentResolutionInput,
  BudgetMetric,
  BudgetOverview,
  PauseReason,
  BudgetPolicy,
  BudgetPolicySummary,
  BudgetPolicyUpsertInput,
  BudgetScopeType,
  BudgetThresholdType,
  BudgetWindowKind,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { insertApproval } from "./approval-insert.js";

type ScopeRecord = {
  companyId: string;
  name: string;
  paused: boolean;
  pauseReason: PauseReason | null;
};

type PolicyRow = typeof budgetPolicies.$inferSelect;
type IncidentRow = typeof budgetIncidents.$inferSelect;

export type BudgetEnforcementScope = {
  companyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
};

export type BudgetServiceHooks = {
  cancelWorkForScope?: (scope: BudgetEnforcementScope) => Promise<void>;
};

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  return { start, end };
}

function resolveWindow(windowKind: BudgetWindowKind, now = new Date()) {
  if (windowKind === "lifetime") {
    return {
      start: new Date(Date.UTC(1970, 0, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(9999, 0, 1, 0, 0, 0, 0)),
    };
  }
  return currentUtcMonthWindow(now);
}

function budgetStatusFromObserved(
  observedAmount: number,
  amount: number,
  warnPercent: number,
): BudgetPolicySummary["status"] {
  if (amount <= 0) return "ok";
  if (observedAmount >= amount) return "hard_stop";
  if (observedAmount >= Math.ceil((amount * warnPercent) / 100)) return "warning";
  return "ok";
}

function normalizeScopeName(scopeType: BudgetScopeType, name: string) {
  if (scopeType === "company") return name;
  return name.trim().length > 0 ? name : scopeType;
}

async function resolveScopeRecord(db: Db, scopeType: BudgetScopeType, scopeId: string): Promise<ScopeRecord> {
  if (scopeType === "company") {
    const row = await db
      .select({
        companyId: companies.id,
        name: companies.name,
        status: companies.status,
        pauseReason: companies.pauseReason,
        pausedAt: companies.pausedAt,
      })
      .from(companies)
      .where(eq(companies.id, scopeId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Company not found");
    return {
      companyId: row.companyId,
      name: row.name,
      paused: row.status === "paused" || Boolean(row.pausedAt),
      pauseReason: (row.pauseReason as ScopeRecord["pauseReason"]) ?? null,
    };
  }

  if (scopeType === "agent") {
    const row = await db
      .select({
        companyId: agents.companyId,
        name: agents.name,
        status: agents.status,
        pauseReason: agents.pauseReason,
      })
      .from(agents)
      .where(eq(agents.id, scopeId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Agent not found");
    return {
      companyId: row.companyId,
      name: row.name,
      paused: row.status === "paused",
      pauseReason: (row.pauseReason as ScopeRecord["pauseReason"]) ?? null,
    };
  }

  const row = await db
    .select({
      companyId: projects.companyId,
      name: projects.name,
      pauseReason: projects.pauseReason,
      pausedAt: projects.pausedAt,
    })
    .from(projects)
    .where(eq(projects.id, scopeId))
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Project not found");
  return {
    companyId: row.companyId,
    name: row.name,
    paused: Boolean(row.pausedAt),
    pauseReason: (row.pauseReason as ScopeRecord["pauseReason"]) ?? null,
  };
}

async function computeObservedAmount(
  db: Db,
  policy: Pick<PolicyRow, "companyId" | "scopeType" | "scopeId" | "windowKind" | "metric">,
) {
  if (policy.metric !== "billed_cents") return 0;

  const conditions = [eq(costEvents.companyId, policy.companyId)];
  if (policy.scopeType === "agent") conditions.push(eq(costEvents.agentId, policy.scopeId));
  if (policy.scopeType === "project") conditions.push(eq(costEvents.projectId, policy.scopeId));
  const { start, end } = resolveWindow(policy.windowKind as BudgetWindowKind);
  if (policy.windowKind === "calendar_month_utc") {
    conditions.push(gte(costEvents.occurredAt, start));
    conditions.push(lt(costEvents.occurredAt, end));
  }

  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
    })
    .from(costEvents)
    .where(and(...conditions));

  return Number(row?.total ?? 0);
}

function formatBudgetAmount(metric: BudgetMetric, amount: number): string {
  if (metric === "billed_cents") return `$${(amount / 100).toFixed(2)}`;
  return String(amount);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type BudgetBurnEstimate = {
  /** Spend per day over the measured span, in the policy's metric units. */
  observedDailyBurn: number;
  /** Days of history the burn rate was measured over (floored at 1 -- see below). */
  burnWindowDays: number;
  /** Timestamp of the first cost event counted in this window, if any. */
  firstEventAt: Date | null;
};

/**
 * Burn is measured from the first cost event actually counted in the window, not
 * from `windowStart`. A `lifetime` policy's windowStart is the 1970 epoch, so
 * dividing by the nominal window would spread this month's spend across 56 years
 * and report a burn of ~0 -- an alarm that reads as "decades of runway" on the day
 * before the wall.
 *
 * The span is floored at one day so a scope that burned its warn threshold inside
 * a single hour does not project exhaustion in minutes. That floor makes the
 * estimate conservative in the "less alarming" direction, which is the correct
 * bias for a card whose job is to buy the board lead time: we would rather say
 * "9 days" and be early than say "40 minutes" and be dismissed as noise.
 */
async function computeWindowBurn(
  db: Db,
  policy: Pick<PolicyRow, "companyId" | "scopeType" | "scopeId" | "windowKind" | "metric">,
  observedAmount: number,
  now = new Date(),
): Promise<BudgetBurnEstimate> {
  const empty: BudgetBurnEstimate = { observedDailyBurn: 0, burnWindowDays: 1, firstEventAt: null };
  if (policy.metric !== "billed_cents" || observedAmount <= 0) return empty;

  const conditions = [eq(costEvents.companyId, policy.companyId)];
  if (policy.scopeType === "agent") conditions.push(eq(costEvents.agentId, policy.scopeId));
  if (policy.scopeType === "project") conditions.push(eq(costEvents.projectId, policy.scopeId));
  const { start, end } = resolveWindow(policy.windowKind as BudgetWindowKind, now);
  if (policy.windowKind === "calendar_month_utc") {
    conditions.push(gte(costEvents.occurredAt, start));
    conditions.push(lt(costEvents.occurredAt, end));
  }

  const [row] = await db
    .select({ firstEventAt: sql<Date | null>`min(${costEvents.occurredAt})` })
    .from(costEvents)
    .where(and(...conditions));

  const firstEventAt = row?.firstEventAt ? new Date(row.firstEventAt) : null;
  if (!firstEventAt || Number.isNaN(firstEventAt.getTime())) return empty;

  const elapsedDays = (now.getTime() - firstEventAt.getTime()) / MS_PER_DAY;
  const burnWindowDays = Math.max(1, elapsedDays);
  return {
    observedDailyBurn: observedAmount / burnWindowDays,
    burnWindowDays: Number(burnWindowDays.toFixed(4)),
    firstEventAt,
  };
}

function projectExhaustion(
  remainingAmount: number,
  observedDailyBurn: number,
  now = new Date(),
): { projectedExhaustionAt: string | null; projectedDaysRemaining: number | null } {
  if (observedDailyBurn <= 0 || remainingAmount <= 0) {
    return { projectedExhaustionAt: null, projectedDaysRemaining: null };
  }
  const daysRemaining = remainingAmount / observedDailyBurn;
  return {
    projectedExhaustionAt: new Date(now.getTime() + daysRemaining * MS_PER_DAY).toISOString(),
    projectedDaysRemaining: Number(daysRemaining.toFixed(2)),
  };
}

export function buildApprovalPayload(input: {
  policy: PolicyRow;
  scopeName: string;
  thresholdType: BudgetThresholdType;
  amountObserved: number;
  windowStart: Date;
  windowEnd: Date;
  burn?: BudgetBurnEstimate;
  now?: Date;
}) {
  const metric = input.policy.metric as BudgetMetric;
  const now = input.now ?? new Date();
  const verb = input.thresholdType === "hard" ? "exceeded" : "crossed";
  const capLabel = input.thresholdType === "hard" ? "hard cap" : "warn threshold";
  const title =
    `Budget override: ${input.scopeName} ${verb} ${metric} ${capLabel} `
    + `(${formatBudgetAmount(metric, input.amountObserved)} of ${formatBudgetAmount(metric, input.policy.amount)})`;

  const remainingAmount = Math.max(0, input.policy.amount - input.amountObserved);
  const observedDailyBurn = input.burn?.observedDailyBurn ?? 0;
  const { projectedExhaustionAt, projectedDaysRemaining } = projectExhaustion(
    remainingAmount,
    observedDailyBurn,
    now,
  );

  // The soft card exists to buy the board lead time, so it must say how much
  // lead time there is. Without these three fields the board can see that a cap
  // was approached but not whether that means nine days or nine minutes, and an
  // undecidable card is the same as no card. See BLO-28793.
  const runway = input.thresholdType === "hard"
    ? "The cap is already spent; the scope is paused now."
    : projectedDaysRemaining === null
      ? `${formatBudgetAmount(metric, remainingAmount)} remains; burn rate is not yet measurable.`
      : `${formatBudgetAmount(metric, remainingAmount)} remains at `
        + `${formatBudgetAmount(metric, observedDailyBurn)}/day -- about `
        + `${projectedDaysRemaining} day(s) before the hard stop pauses this scope.`;

  return {
    title,
    scopeType: input.policy.scopeType,
    scopeId: input.policy.scopeId,
    scopeName: input.scopeName,
    metric: input.policy.metric,
    windowKind: input.policy.windowKind,
    thresholdType: input.thresholdType,
    budgetAmount: input.policy.amount,
    observedAmount: input.amountObserved,
    remainingAmount,
    observedDailyBurn: Number(observedDailyBurn.toFixed(4)),
    burnWindowDays: input.burn?.burnWindowDays ?? null,
    projectedExhaustionAt,
    projectedDaysRemaining,
    warnPercent: input.policy.warnPercent,
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    policyId: input.policy.id,
    summary: runway,
    guidance: input.thresholdType === "hard"
      ? "Raise the budget and resume the scope, or keep the scope paused."
      : "Raise the budget now to avoid a hard stop, or accept the pause when the cap is reached.",
  };
}

/**
 * Dedupe token for the auto-filed board card: one card per policy, per window,
 * per threshold. Note that the partial unique indexes on `approvals` only bite
 * when a requester column is set, and these cards are system-filed with both
 * `requestedByAgentId` and `requestedByUserId` null -- so this key is a durable
 * audit/trace handle, and the authoritative suppression is the pre-existing
 * `budget_incidents` row check in `createIncidentIfNeeded`, which is keyed on
 * exactly the same triple.
 *
 * Since BLO-28908 a window can legitimately carry more than one card per
 * threshold -- a cap raise closes the incident and the next crossing files a
 * fresh card -- so this value is deliberately *not* unique per card. Nothing
 * enforces it (see above), and making it unique would have to encode the cap,
 * which changes the key of the first card and breaks its use as a stable handle.
 * Join through `budget_incidents.approval_id` when you need one exact card.
 */
export function budgetApprovalIdempotencyKey(
  policyId: string,
  thresholdType: BudgetThresholdType,
  windowStart: Date,
) {
  return `budget:${policyId}:${thresholdType}:${windowStart.toISOString()}`;
}

async function markApprovalStatus(
  db: Db,
  approvalId: string | null,
  status: "approved" | "rejected",
  decisionNote: string | null | undefined,
  decidedByUserId: string,
) {
  if (!approvalId) return;
  await db
    .update(approvals)
    .set({
      status,
      decisionNote: decisionNote ?? null,
      decidedByUserId,
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    // Guarded on `pending` so an already-decided or withdrawn card cannot be
    // rewritten. `resolveIncident` fetches its incident by id with no status
    // filter, so a stale client can submit against an incident that was already
    // closed -- e.g. the soft incident whose card `resolveOpenSoftIncidents`
    // withdrew when the hard cap was crossed. Without this guard that submission
    // would overwrite the withdrawn card's decisionNote/decidedAt and report a
    // decision that never happened.
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")));
}

export function budgetService(db: Db, hooks: BudgetServiceHooks = {}) {
  async function pauseScopeForBudget(policy: PolicyRow) {
    const now = new Date();
    if (policy.scopeType === "agent") {
      await db
        .update(agents)
        .set({
          status: "paused",
          pauseReason: "budget",
          pausedAt: now,
          updatedAt: now,
        })
        .where(and(eq(agents.id, policy.scopeId), inArray(agents.status, ["active", "idle", "running", "error"])));
      return;
    }

    if (policy.scopeType === "project") {
      await db
        .update(projects)
        .set({
          pauseReason: "budget",
          pausedAt: now,
          updatedAt: now,
        })
        .where(eq(projects.id, policy.scopeId));
      return;
    }

    await db
      .update(companies)
      .set({
        status: "paused",
        pauseReason: "budget",
        pausedAt: now,
        updatedAt: now,
      })
      .where(eq(companies.id, policy.scopeId));
  }

  async function pauseAndCancelScopeForBudget(policy: PolicyRow) {
    await pauseScopeForBudget(policy);
    await hooks.cancelWorkForScope?.({
      companyId: policy.companyId,
      scopeType: policy.scopeType as BudgetScopeType,
      scopeId: policy.scopeId,
    });
  }

  async function resumeScopeFromBudget(policy: PolicyRow) {
    const now = new Date();
    if (policy.scopeType === "agent") {
      await db
        .update(agents)
        .set({
          status: "idle",
          pauseReason: null,
          pausedAt: null,
          updatedAt: now,
        })
        .where(and(eq(agents.id, policy.scopeId), eq(agents.pauseReason, "budget")));
      return;
    }

    if (policy.scopeType === "project") {
      await db
        .update(projects)
        .set({
          pauseReason: null,
          pausedAt: null,
          updatedAt: now,
        })
        .where(and(eq(projects.id, policy.scopeId), eq(projects.pauseReason, "budget")));
      return;
    }

    await db
      .update(companies)
      .set({
        status: "active",
        pauseReason: null,
        pausedAt: null,
        updatedAt: now,
      })
      .where(and(eq(companies.id, policy.scopeId), eq(companies.pauseReason, "budget")));
  }

  async function getPolicyRow(policyId: string) {
    const policy = await db
      .select()
      .from(budgetPolicies)
      .where(eq(budgetPolicies.id, policyId))
      .then((rows) => rows[0] ?? null);
    if (!policy) throw notFound("Budget policy not found");
    return policy;
  }

  async function listPolicyRows(companyId: string) {
    return db
      .select()
      .from(budgetPolicies)
      .where(eq(budgetPolicies.companyId, companyId))
      .orderBy(desc(budgetPolicies.updatedAt));
  }

  async function buildPolicySummary(policy: PolicyRow): Promise<BudgetPolicySummary> {
    const scope = await resolveScopeRecord(db, policy.scopeType as BudgetScopeType, policy.scopeId);
    const observedAmount = await computeObservedAmount(db, policy);
    const { start, end } = resolveWindow(policy.windowKind as BudgetWindowKind);
    const amount = policy.isActive ? policy.amount : 0;
    const utilizationPercent =
      amount > 0 ? Number(((observedAmount / amount) * 100).toFixed(2)) : 0;
    return {
      policyId: policy.id,
      companyId: policy.companyId,
      scopeType: policy.scopeType as BudgetScopeType,
      scopeId: policy.scopeId,
      scopeName: normalizeScopeName(policy.scopeType as BudgetScopeType, scope.name),
      metric: policy.metric as BudgetMetric,
      windowKind: policy.windowKind as BudgetWindowKind,
      amount,
      observedAmount,
      remainingAmount: amount > 0 ? Math.max(0, amount - observedAmount) : 0,
      utilizationPercent,
      warnPercent: policy.warnPercent,
      hardStopEnabled: policy.hardStopEnabled,
      notifyEnabled: policy.notifyEnabled,
      isActive: policy.isActive,
      status: policy.isActive
        ? budgetStatusFromObserved(observedAmount, amount, policy.warnPercent)
        : "ok",
      paused: scope.paused,
      pauseReason: scope.pauseReason,
      windowStart: start,
      windowEnd: end,
    };
  }

  async function createIncidentIfNeeded(
    policy: PolicyRow,
    thresholdType: BudgetThresholdType,
    amountObserved: number,
  ) {
    // One instant for the whole card: the window bounds, the burn measurement and
    // the projected exhaustion date are all relative to `now`, and taking three
    // separate `new Date()` readings would let the payload disagree with itself.
    const now = new Date();
    const { start, end } = resolveWindow(policy.windowKind as BudgetWindowKind, now);
    // Suppress only while an incident for this (policy, window, threshold) is still
    // *open*. Closed rows must not hold the slot: `raise_budget_and_resume` resolves
    // every open incident on the policy, so a `ne(status, "dismissed")` check -- what
    // this was until BLO-28908 -- meant one cap raise silenced the policy for the rest
    // of the window on both thresholds. The hard path made that dangerous rather than
    // merely quiet, because `pauseAndCancelScopeForBudget` is not gated on the card
    // being filed: the next wall in the same window paused the scope with no board
    // card at all. Zero notice, where BLO-28793 was filed over 76 ms of it.
    //
    // `open` is the right key rather than "the cap changed since the last card"
    // (`amountLimit != policy.amount`), which was the first shape considered: a board
    // that raises a cap to clear a burst and later lowers it back would match the
    // earlier row again and re-silence the policy at exactly the cap that already
    // proved too low. What a still-open incident means is "the board has a live card
    // for this and has not acted"; anything closed is a decided crossing, and the next
    // crossing is a new event that deserves its own card.
    //
    // `budget_incidents_policy_window_threshold_idx` carries the same predicate and is
    // the backstop if these two ever drift.
    const existing = await db
      .select()
      .from(budgetIncidents)
      .where(
        and(
          eq(budgetIncidents.policyId, policy.id),
          eq(budgetIncidents.windowStart, start),
          eq(budgetIncidents.thresholdType, thresholdType),
          eq(budgetIncidents.status, "open"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (existing) return { incident: existing, created: false };

    const scope = await resolveScopeRecord(db, policy.scopeType as BudgetScopeType, policy.scopeId);
    const burn = await computeWindowBurn(db, policy, amountObserved, now);
    const payload = buildApprovalPayload({
      policy,
      scopeName: normalizeScopeName(policy.scopeType as BudgetScopeType, scope.name),
      thresholdType,
      amountObserved,
      windowStart: start,
      windowEnd: end,
      burn,
      now,
    });

    // Both thresholds file the card. Before BLO-28793 only `hard` did, which put
    // the board's only actionable notice 76 ms ahead of the pause it was supposed
    // to prevent -- against a measured ~5h board decision latency. The soft card
    // fires at warnPercent, where the same $11,200 of remaining cap is ~9 days of
    // runway at the worst observed burn. The hard card is untouched.
    const approval = await insertApproval(db, {
      companyId: policy.companyId,
      type: "budget_override_required",
      requestedByUserId: null,
      requestedByAgentId: null,
      status: "pending",
      payload,
      idempotencyKey: budgetApprovalIdempotencyKey(policy.id, thresholdType, start),
    })
      .returning()
      .then((rows) => rows[0] ?? null);

    const incident = await db
      .insert(budgetIncidents)
      .values({
        companyId: policy.companyId,
        policyId: policy.id,
        scopeType: policy.scopeType,
        scopeId: policy.scopeId,
        metric: policy.metric,
        windowKind: policy.windowKind,
        windowStart: start,
        windowEnd: end,
        thresholdType,
        amountLimit: policy.amount,
        amountObserved,
        status: "open",
        approvalId: approval?.id ?? null,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    return incident ? { incident, created: true } : null;
  }

  async function resolveOpenSoftIncidents(policyId: string) {
    const openSoftRows = await db
      .select()
      .from(budgetIncidents)
      .where(
        and(
          eq(budgetIncidents.policyId, policyId),
          eq(budgetIncidents.thresholdType, "soft"),
          eq(budgetIncidents.status, "open"),
        ),
      );

    await db
      .update(budgetIncidents)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(budgetIncidents.policyId, policyId),
          eq(budgetIncidents.thresholdType, "soft"),
          eq(budgetIncidents.status, "open"),
        ),
      );

    // The soft incident is closed here rather than by `resolveOpenIncidentsForPolicy`,
    // which only touches *open* incidents -- so once the soft card exists (BLO-28793)
    // its approval would otherwise sit pending forever with nothing left to resolve it.
    // The hard card filed moments later says the same thing more urgently, so withdraw
    // the soft one as superseded instead of leaving an undecidable row on the board.
    for (const row of openSoftRows) {
      await withdrawPendingApproval(
        row.approvalId ?? null,
        row.companyId,
        "Superseded by the hard-cap override request for the same policy.",
        "superseded_by_hard_threshold",
      );
    }
  }

  /**
   * Close out a board card whose incident is being closed without a decision.
   *
   * Every path that closes a `budget_incidents` row must settle the card attached
   * to it. Before BLO-28793 only `hard` incidents carried an `approvalId` and the
   * one open hard incident was always the one being decided, so this could not
   * arise; now that a `soft` incident carries one too, any path that resolves
   * incidents in bulk can strand a `pending` card that no remaining open incident
   * can ever resolve.
   */
  async function withdrawPendingApproval(
    approvalId: string | null,
    companyId: string,
    decisionNote: string,
    reason: string,
  ) {
    if (!approvalId) return;
    const now = new Date();
    // Status-guarded so a board decision that landed first wins rather than being
    // overwritten -- same guard as approvalService.withdraw().
    const updated = await db
      .update(approvals)
      .set({
        status: "withdrawn",
        decisionNote,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) return;

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "budget_service",
      action: "approval.withdrawn",
      entityType: "approval",
      entityId: approvalId,
      details: { type: "budget_override_required", reason },
    });
  }

  async function resolveOpenIncidentsForPolicy(
    policyId: string,
    approvalStatus: "approved" | "rejected" | null,
    decidedByUserId: string | null,
  ) {
    const openRows = await db
      .select()
      .from(budgetIncidents)
      .where(and(eq(budgetIncidents.policyId, policyId), eq(budgetIncidents.status, "open")));

    await db
      .update(budgetIncidents)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(budgetIncidents.policyId, policyId), eq(budgetIncidents.status, "open")));

    if (approvalStatus && decidedByUserId) {
      for (const row of openRows) {
        await markApprovalStatus(db, row.approvalId ?? null, approvalStatus, "Resolved via budget update", decidedByUserId);
      }
      return;
    }

    // No deciding actor. `upsertPolicy` reaches this branch whenever the caller is
    // not the board -- see the `actorUserId ? "approved" : null` call sites below
    // and `server/src/routes/costs.ts`, which passes `null` outright. The incidents
    // were just closed above, so returning here would leave their cards `pending`
    // with nothing left to decide them: exactly the leak resolveOpenSoftIncidents
    // avoids. Withdraw instead of stranding them (BLO-28793).
    for (const row of openRows) {
      await withdrawPendingApproval(
        row.approvalId ?? null,
        row.companyId,
        "Withdrawn automatically: the budget policy was updated and this incident is no longer open.",
        "incident_closed_without_decision",
      );
    }
  }

  async function hydrateIncidentRows(rows: IncidentRow[]): Promise<BudgetIncident[]> {
    const approvalIds = rows.map((row) => row.approvalId).filter((value): value is string => Boolean(value));
    const approvalRows = approvalIds.length > 0
      ? await db
        .select({ id: approvals.id, status: approvals.status })
        .from(approvals)
        .where(inArray(approvals.id, approvalIds))
      : [];
    const approvalStatusById = new Map(approvalRows.map((row) => [row.id, row.status]));

    return Promise.all(
      rows.map(async (row) => {
        const scope = await resolveScopeRecord(db, row.scopeType as BudgetScopeType, row.scopeId);
        return {
          id: row.id,
          companyId: row.companyId,
          policyId: row.policyId,
          scopeType: row.scopeType as BudgetScopeType,
          scopeId: row.scopeId,
          scopeName: normalizeScopeName(row.scopeType as BudgetScopeType, scope.name),
          metric: row.metric as BudgetMetric,
          windowKind: row.windowKind as BudgetWindowKind,
          windowStart: row.windowStart,
          windowEnd: row.windowEnd,
          thresholdType: row.thresholdType as BudgetThresholdType,
          amountLimit: row.amountLimit,
          amountObserved: row.amountObserved,
          status: row.status as BudgetIncident["status"],
          approvalId: row.approvalId ?? null,
          approvalStatus: row.approvalId ? approvalStatusById.get(row.approvalId) ?? null : null,
          resolvedAt: row.resolvedAt ?? null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      }),
    );
  }

  return {
    listPolicies: async (companyId: string): Promise<BudgetPolicy[]> => {
      const rows = await listPolicyRows(companyId);
      return rows.map((row) => ({
        ...row,
        scopeType: row.scopeType as BudgetScopeType,
        metric: row.metric as BudgetMetric,
        windowKind: row.windowKind as BudgetWindowKind,
      }));
    },

    upsertPolicy: async (
      companyId: string,
      input: BudgetPolicyUpsertInput,
      actorUserId: string | null,
    ): Promise<BudgetPolicySummary> => {
      const scope = await resolveScopeRecord(db, input.scopeType, input.scopeId);
      if (scope.companyId !== companyId) {
        throw unprocessable("Budget scope does not belong to company");
      }

      const metric = input.metric ?? "billed_cents";
      const windowKind = input.windowKind ?? (input.scopeType === "project" ? "lifetime" : "calendar_month_utc");
      const amount = Math.max(0, Math.floor(input.amount));
      const nextIsActive = amount > 0 && (input.isActive ?? true);
      const existing = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, input.scopeType),
            eq(budgetPolicies.scopeId, input.scopeId),
            eq(budgetPolicies.metric, metric),
            eq(budgetPolicies.windowKind, windowKind),
          ),
        )
        .then((rows) => rows[0] ?? null);

      const now = new Date();
      const row = existing
        ? await db
          .update(budgetPolicies)
          .set({
            amount,
            warnPercent: input.warnPercent ?? existing.warnPercent,
            hardStopEnabled: input.hardStopEnabled ?? existing.hardStopEnabled,
            notifyEnabled: input.notifyEnabled ?? existing.notifyEnabled,
            isActive: nextIsActive,
            updatedByUserId: actorUserId,
            updatedAt: now,
          })
          .where(eq(budgetPolicies.id, existing.id))
          .returning()
          .then((rows) => rows[0])
        : await db
          .insert(budgetPolicies)
          .values({
            companyId,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
            metric,
            windowKind,
            amount,
            warnPercent: input.warnPercent ?? 80,
            hardStopEnabled: input.hardStopEnabled ?? true,
            notifyEnabled: input.notifyEnabled ?? true,
            isActive: nextIsActive,
            createdByUserId: actorUserId,
            updatedByUserId: actorUserId,
          })
          .returning()
          .then((rows) => rows[0]);

      if (input.scopeType === "company" && windowKind === "calendar_month_utc") {
        await db
          .update(companies)
          .set({
            budgetMonthlyCents: amount,
            updatedAt: now,
          })
          .where(eq(companies.id, input.scopeId));
      }

      if (input.scopeType === "agent" && windowKind === "calendar_month_utc") {
        await db
          .update(agents)
          .set({
            budgetMonthlyCents: amount,
            updatedAt: now,
          })
          .where(eq(agents.id, input.scopeId));
      }

      if (amount > 0) {
        const observedAmount = await computeObservedAmount(db, row);
        if (observedAmount < amount) {
          await resumeScopeFromBudget(row);
          await resolveOpenIncidentsForPolicy(row.id, actorUserId ? "approved" : null, actorUserId);
        } else {
          const softThreshold = Math.ceil((row.amount * row.warnPercent) / 100);
          const hardStopWillFire = row.hardStopEnabled && observedAmount >= row.amount;
          // Same gate as evaluateCostEvent: do not file a warn card the hard
          // branch below is about to withdraw in the same call.
          if (row.notifyEnabled && observedAmount >= softThreshold && !hardStopWillFire) {
            await createIncidentIfNeeded(row, "soft", observedAmount);
          }
          if (hardStopWillFire) {
            await resolveOpenSoftIncidents(row.id);
            await createIncidentIfNeeded(row, "hard", observedAmount);
            await pauseAndCancelScopeForBudget(row);
          }
        }
      } else {
        await resumeScopeFromBudget(row);
        await resolveOpenIncidentsForPolicy(row.id, actorUserId ? "approved" : null, actorUserId);
      }

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId ?? "board",
        action: "budget.policy_upserted",
        entityType: "budget_policy",
        entityId: row.id,
        details: {
          scopeType: row.scopeType,
          scopeId: row.scopeId,
          amount: row.amount,
          windowKind: row.windowKind,
        },
      });

      return buildPolicySummary(row);
    },

    overview: async (companyId: string): Promise<BudgetOverview> => {
      const rows = await listPolicyRows(companyId);
      const policies = await Promise.all(rows.map((row) => buildPolicySummary(row)));
      const activeIncidentRows = await db
        .select()
        .from(budgetIncidents)
        .where(and(eq(budgetIncidents.companyId, companyId), eq(budgetIncidents.status, "open")))
        .orderBy(desc(budgetIncidents.createdAt));
      const activeIncidents = await hydrateIncidentRows(activeIncidentRows);
      return {
        companyId,
        policies,
        activeIncidents,
        pausedAgentCount: policies.filter((policy) => policy.scopeType === "agent" && policy.paused).length,
        pausedProjectCount: policies.filter((policy) => policy.scopeType === "project" && policy.paused).length,
        pendingApprovalCount: activeIncidents.filter((incident) => incident.approvalStatus === "pending").length,
      };
    },

    evaluateCostEvent: async (event: typeof costEvents.$inferSelect) => {
      const candidatePolicies = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, event.companyId),
            eq(budgetPolicies.isActive, true),
            inArray(budgetPolicies.scopeType, ["company", "agent", "project"]),
          ),
        );

      const relevantPolicies = candidatePolicies.filter((policy) => {
        if (policy.scopeType === "company") return policy.scopeId === event.companyId;
        if (policy.scopeType === "agent") return policy.scopeId === event.agentId;
        if (policy.scopeType === "project") return Boolean(event.projectId) && policy.scopeId === event.projectId;
        return false;
      });

      for (const policy of relevantPolicies) {
        if (policy.metric !== "billed_cents" || policy.amount <= 0) continue;
        const observedAmount = await computeObservedAmount(db, policy);
        const softThreshold = Math.ceil((policy.amount * policy.warnPercent) / 100);
        const hardStopWillFire = policy.hardStopEnabled && observedAmount >= policy.amount;

        // Skip the warn card only when the hard branch below is about to run in
        // this same evaluation and immediately withdraw it -- a single cost event
        // can jump from under the warn threshold to over the cap, and filing a
        // card no board member could ever see just to withdraw it two statements
        // later puts a decision in the activity log that never happened. The gate
        // is "the hard path will fire", not "observed >= amount": with
        // `hardStopEnabled: false` nothing else would ever notify, and the warn
        // card is the only signal that scope has blown its cap.
        if (policy.notifyEnabled && observedAmount >= softThreshold && !hardStopWillFire) {
          const softIncident = await createIncidentIfNeeded(policy, "soft", observedAmount);
          if (softIncident?.created) {
            await logActivity(db, {
              companyId: policy.companyId,
              actorType: "system",
              actorId: "budget_service",
              action: "budget.soft_threshold_crossed",
              entityType: "budget_incident",
              entityId: softIncident.incident.id,
              details: {
                scopeType: policy.scopeType,
                scopeId: policy.scopeId,
                amountObserved: observedAmount,
                amountLimit: policy.amount,
                approvalId: softIncident.incident.approvalId ?? null,
              },
            });
          }
        }

        if (policy.hardStopEnabled && observedAmount >= policy.amount) {
          await resolveOpenSoftIncidents(policy.id);
          const hardIncident = await createIncidentIfNeeded(policy, "hard", observedAmount);
          await pauseAndCancelScopeForBudget(policy);
          if (hardIncident?.created) {
            await logActivity(db, {
              companyId: policy.companyId,
              actorType: "system",
              actorId: "budget_service",
              action: "budget.hard_threshold_crossed",
              entityType: "budget_incident",
              entityId: hardIncident.incident.id,
              details: {
                scopeType: policy.scopeType,
                scopeId: policy.scopeId,
                amountObserved: observedAmount,
                amountLimit: policy.amount,
                approvalId: hardIncident.incident.approvalId ?? null,
              },
            });
          }
        }
      }
    },

    getInvocationBlock: async (
      companyId: string,
      agentId: string,
      context?: { issueId?: string | null; projectId?: string | null },
    ) => {
      const agent = await db
        .select({
          status: agents.status,
          pauseReason: agents.pauseReason,
          companyId: agents.companyId,
          name: agents.name,
        })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");

      const company = await db
        .select({
          status: companies.status,
          pauseReason: companies.pauseReason,
          name: companies.name,
        })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");
      if (company.status === "paused") {
        return {
          scopeType: "company" as const,
          scopeId: companyId,
          scopeName: company.name,
          reason:
            company.pauseReason === "budget"
              ? "Company is paused because its budget hard-stop was reached."
              : "Company is paused and cannot start new work.",
        };
      }

      const companyPolicy = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, "company"),
            eq(budgetPolicies.scopeId, companyId),
            eq(budgetPolicies.isActive, true),
            eq(budgetPolicies.metric, "billed_cents"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (companyPolicy && companyPolicy.hardStopEnabled && companyPolicy.amount > 0) {
        const observed = await computeObservedAmount(db, companyPolicy);
        if (observed >= companyPolicy.amount) {
          return {
            scopeType: "company" as const,
            scopeId: companyId,
            scopeName: company.name,
            reason: "Company cannot start new work because its budget hard-stop is exceeded.",
          };
        }
      }

      if (agent.status === "paused" && agent.pauseReason === "budget") {
        return {
          scopeType: "agent" as const,
          scopeId: agentId,
          scopeName: agent.name,
          reason: "Agent is paused because its budget hard-stop was reached.",
        };
      }

      const agentPolicy = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, "agent"),
            eq(budgetPolicies.scopeId, agentId),
            eq(budgetPolicies.isActive, true),
            eq(budgetPolicies.metric, "billed_cents"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (agentPolicy && agentPolicy.hardStopEnabled && agentPolicy.amount > 0) {
        const observed = await computeObservedAmount(db, agentPolicy);
        if (observed >= agentPolicy.amount) {
          return {
            scopeType: "agent" as const,
            scopeId: agentId,
            scopeName: agent.name,
            reason: "Agent cannot start because its budget hard-stop is still exceeded.",
          };
        }
      }

      const candidateProjectId = context?.projectId ?? null;
      if (!candidateProjectId) return null;

      const project = await db
        .select({
          id: projects.id,
          name: projects.name,
          companyId: projects.companyId,
          pauseReason: projects.pauseReason,
          pausedAt: projects.pausedAt,
        })
        .from(projects)
        .where(eq(projects.id, candidateProjectId))
        .then((rows) => rows[0] ?? null);

      if (!project || project.companyId !== companyId) return null;
      const projectPolicy = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, "project"),
            eq(budgetPolicies.scopeId, project.id),
            eq(budgetPolicies.isActive, true),
            eq(budgetPolicies.metric, "billed_cents"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (projectPolicy && projectPolicy.hardStopEnabled && projectPolicy.amount > 0) {
        const observed = await computeObservedAmount(db, projectPolicy);
        if (observed >= projectPolicy.amount) {
          return {
            scopeType: "project" as const,
            scopeId: project.id,
            scopeName: project.name,
            reason: "Project cannot start work because its budget hard-stop is still exceeded.",
          };
        }
      }

      if (!project.pausedAt || project.pauseReason !== "budget") return null;
      return {
        scopeType: "project" as const,
        scopeId: project.id,
        scopeName: project.name,
        reason: "Project is paused because its budget hard-stop was reached.",
      };
    },

    resolveIncident: async (
      companyId: string,
      incidentId: string,
      input: BudgetIncidentResolutionInput,
      actorUserId: string,
    ): Promise<BudgetIncident> => {
      const incident = await db
        .select()
        .from(budgetIncidents)
        .where(eq(budgetIncidents.id, incidentId))
        .then((rows) => rows[0] ?? null);
      if (!incident) throw notFound("Budget incident not found");
      if (incident.companyId !== companyId) throw notFound("Budget incident not found");

      const policy = await getPolicyRow(incident.policyId);
      if (input.action === "raise_budget_and_resume") {
        const nextAmount = Math.max(0, Math.floor(input.amount ?? 0));
        const currentObserved = await computeObservedAmount(db, policy);
        if (nextAmount <= currentObserved) {
          throw unprocessable("New budget must exceed current observed spend");
        }

        const now = new Date();
        await db
          .update(budgetPolicies)
          .set({
            amount: nextAmount,
            isActive: true,
            updatedByUserId: actorUserId,
            updatedAt: now,
          })
          .where(eq(budgetPolicies.id, policy.id));

        if (policy.scopeType === "company" && policy.windowKind === "calendar_month_utc") {
          await db
            .update(companies)
            .set({ budgetMonthlyCents: nextAmount, updatedAt: now })
            .where(eq(companies.id, policy.scopeId));
        }

        if (policy.scopeType === "agent" && policy.windowKind === "calendar_month_utc") {
          await db
            .update(agents)
            .set({ budgetMonthlyCents: nextAmount, updatedAt: now })
            .where(eq(agents.id, policy.scopeId));
        }

        await resumeScopeFromBudget(policy);
        const otherOpenRows = await db
          .select()
          .from(budgetIncidents)
          .where(
            and(
              eq(budgetIncidents.policyId, policy.id),
              eq(budgetIncidents.status, "open"),
              ne(budgetIncidents.id, incident.id),
            ),
          );
        await db
          .update(budgetIncidents)
          .set({
            status: "resolved",
            resolvedAt: now,
            updatedAt: now,
          })
          .where(and(eq(budgetIncidents.policyId, policy.id), eq(budgetIncidents.status, "open")));

        await markApprovalStatus(db, incident.approvalId ?? null, "approved", input.decisionNote, actorUserId);
        // Raising the cap closes *every* open incident for the policy, but only the
        // one the board acted on gets a decision, so the rest must have their cards
        // withdrawn rather than left pending against a resolved incident.
        //
        // `otherOpenRows` is non-empty mainly when the *decided* incident is stale --
        // already resolved or dismissed, so it is not itself in the open set -- while
        // a later incident on the same policy is still open. That is the case the
        // tests pin. Note that soft and hard do NOT normally coexist as open rows:
        // both create sites gate the warn card on `!hardStopWillFire` and call
        // `resolveOpenSoftIncidents` before filing the hard one. The single exception
        // is a policy write that clears `hardStopEnabled` while already over cap,
        // which files a warn card without closing the open hard incident.
        for (const row of otherOpenRows) {
          await withdrawPendingApproval(
            row.approvalId ?? null,
            row.companyId,
            "Withdrawn automatically: the budget was raised in response to another incident on this policy.",
            "incident_closed_without_decision",
          );
        }
      } else {
        await db
          .update(budgetIncidents)
          .set({
            status: "dismissed",
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(budgetIncidents.id, incident.id));
        await markApprovalStatus(db, incident.approvalId ?? null, "rejected", input.decisionNote, actorUserId);
      }

      await logActivity(db, {
        companyId: incident.companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "budget.incident_resolved",
        entityType: "budget_incident",
        entityId: incident.id,
        details: {
          action: input.action,
          amount: input.amount ?? null,
          scopeType: incident.scopeType,
          scopeId: incident.scopeId,
        },
      });

      // Report the row as it actually is now, not as the requested action implies.
      // The raise path closes incidents with a `status = "open"` filter, so a submit
      // against an already-resolved or dismissed incident id leaves that row
      // untouched -- it resolves whatever was open, resumes the scope and withdraws
      // the other cards, all correctly, but the incident named in the request did not
      // change. Echoing the requested outcome back told the caller otherwise
      // (BLO-28908, from the #1415 review). The side effects were always right; the
      // return value was the part that lied.
      const finalRow = await db
        .select()
        .from(budgetIncidents)
        .where(eq(budgetIncidents.id, incident.id))
        .then((rows) => rows[0] ?? null);
      const [updated] = await hydrateIncidentRows([finalRow ?? incident]);
      return updated!;
    },
  };
}

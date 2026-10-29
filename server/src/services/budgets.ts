import { and, desc, eq, gte, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
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
import { consumptionCentsExpr } from "./consumption-metric.js";
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

/**
 * ⚠️ ORDERING CONSTRAINT -- read this before "fixing" adapter billingType classification.
 *
 * This is the sole input to every hardStopEnabled budget policy. Until PEN-4466 it summed
 * costEvents.costCents with NO billingType filter -- and upstream, normalizeBilledCostCents()
 * (services/heartbeat.ts) zeroes costCents at ledger-write time whenever billingType is
 * "subscription_included".
 *
 * Consequence, had this not moved: on the day an adapter starts classifying subscription
 * lanes correctly, every such lane books $0, this function returns 0 forever, and every
 * hard stop becomes silently unreachable while all dashboards read healthy. That is
 * strictly worse than the status quo it would replace, in which billed_cents is a
 * list-price CONSUMPTION figure wearing a cash label -- usable as a throttle because list
 * price is monotone in work and model-weighted, but NOT a cash figure. Recorded cash for
 * this company is $0.00 across 0 events; the marginal cash cost of a run on an
 * already-purchased seat is $0. No cash multiplier is quoted here because none is
 * measurable. See PEN-4463 step 1.
 *
 * Therefore: a billingType classification change must not reach normalizeBilledCostCents
 * until EVERY gate reads a field that function cannot zero. Classification goes LAST.
 *
 * The full reader inventory -- and the reason this expression is a shared constant rather
 * than a local copy in each service -- lives on `consumptionCentsExpr` in
 * `services/consumption-metric.ts`. Audit there, not here: five hand-rolled copies of the
 * list is how a reader gets missed, which is exactly what happened to the two
 * `spentMonthlyCents` hydration paths on the first pass of PEN-4466.
 *
 * Invariant held by `budget-consumption-metric.test.ts`, which fails if a future change
 * repoints this at a zeroable column.
 *
 * Ruling: Penstock PEN-4463 (@Ceo, 2026-10-21). Trace: PEN-4397 doc billing-classification-trace.
 */
async function computeObservedAmount(
  db: Db,
  policy: Pick<PolicyRow, "companyId" | "scopeType" | "scopeId" | "windowKind" | "metric">,
  /**
   * Floor the sum at this instant, on top of the window bounds (PEN-4742).
   *
   * Only `hardStopForgivenSince` passes it, to ask the ENFORCEMENT question
   * "how much has this scope spent since the board adjudicated the crossing?".
   * Every reporting caller omits it and keeps getting the true window total:
   * rebaselining what the dashboard shows would hide the overshoot the board
   * just forgave, which is PEN-1972 defect 3 wearing a different hat.
   */
  since?: Date,
) {
  // NB: the `billed_cents` metric NAME is unchanged and still means consumption -- renaming
  // the BUDGET_METRICS enum needs a budget_policies data migration plus an API/UI contract
  // change, moves no number, and ships independently (PEN-4466, deliberately deferred).
  if (policy.metric !== "billed_cents") return 0;

  const conditions = [eq(costEvents.companyId, policy.companyId)];
  if (policy.scopeType === "agent") conditions.push(eq(costEvents.agentId, policy.scopeId));
  if (policy.scopeType === "project") conditions.push(eq(costEvents.projectId, policy.scopeId));
  const { start, end } = resolveWindow(policy.windowKind as BudgetWindowKind);
  if (policy.windowKind === "calendar_month_utc") {
    conditions.push(gte(costEvents.occurredAt, start));
    conditions.push(lt(costEvents.occurredAt, end));
  }
  // Applied as well as -- never instead of -- the window bounds above, so a
  // forgiveness grant can only ever NARROW the sum. A grant that somehow
  // outlived its window still cannot widen enforcement past the window.
  //
  // BOTH CLOCKS, OR'd: an event counts if it HAPPENED after the decision or if it
  // LANDED after it. Flooring on `occurredAt` alone was fail-open in the one
  // direction a cap must never fail -- spend the board could not have seen when it
  // adjudicated (final usage from the runs cancelled at the pause, batched or
  // back-billed ingestion) carries an `occurredAt` before the grant, and so escaped
  // enforcement for the whole rest of the window while still showing up on every
  // dashboard. What the board forgave is the overshoot visible at that instant; an
  // event that was not yet in the table was not part of it.
  //
  // `createdAt` is insert time, defaulted by the database and never backdated, so
  // the OR can only ever ADD rows to the enforced sum -- it cannot drop one that
  // the `occurredAt` floor would have kept. Reporting is unaffected either way:
  // every reporting caller omits `since` entirely and still sums the true window.
  if (since) {
    conditions.push(or(gte(costEvents.occurredAt, since), gte(costEvents.createdAt, since))!);
  }

  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${consumptionCentsExpr}), 0)::double precision`,
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
    // "Keep the scope paused" is scoped to the condition, not forever: since
    // PEN-1972 a budget pause lifts itself at the next invocation check once the
    // hard stop stops binding, which for a windowed cap means the next window
    // roll. That is the right behaviour -- a latch that outlives its condition
    // is what took a primary implementer offline over $0.25 -- but the board is
    // the party choosing it, so the card has to say so rather than let a
    // "keep paused" click imply a durability it does not have.
    guidance: input.thresholdType === "hard"
      ? "Raise the budget and resume the scope, or keep the scope paused -- a kept "
        + "pause holds only while the cap still binds, and lifts on its own once "
        + "observed spend in the window falls back under it."
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

  /**
   * Addressed by scope rather than by policy row: a budget latch has to be
   * clearable even when the policy that set it has since been deactivated or
   * deleted, which is precisely the state in which nothing else would ever
   * clear it. Every update is guarded on `pauseReason = "budget"`, so this can
   * never lift a manual or operator pause.
   *
   * Returns whether a row actually changed. The guard makes this a no-op in two
   * races -- a concurrent caller resumed first, or a human pause replaced the
   * budget one between the caller's read and this write -- and a caller that
   * attaches side effects to the resume needs to tell those apart from a resume
   * it genuinely performed. See `clearExpiredBudgetPause`.
   */
  async function resumeScopeFromBudget(
    policy: Pick<PolicyRow, "scopeType" | "scopeId">,
  ): Promise<boolean> {
    const now = new Date();
    if (policy.scopeType === "agent") {
      const changed = await db
        .update(agents)
        .set({
          status: "idle",
          pauseReason: null,
          pausedAt: null,
          updatedAt: now,
        })
        .where(and(eq(agents.id, policy.scopeId), eq(agents.pauseReason, "budget")))
        .returning({ id: agents.id });
      return changed.length > 0;
    }

    if (policy.scopeType === "project") {
      const changed = await db
        .update(projects)
        .set({
          pauseReason: null,
          pausedAt: null,
          updatedAt: now,
        })
        .where(and(eq(projects.id, policy.scopeId), eq(projects.pauseReason, "budget")))
        .returning({ id: projects.id });
      return changed.length > 0;
    }

    const changed = await db
      .update(companies)
      .set({
        status: "active",
        pauseReason: null,
        pausedAt: null,
        updatedAt: now,
      })
      .where(and(eq(companies.id, policy.scopeId), eq(companies.pauseReason, "budget")))
      .returning({ id: companies.id });
    return changed.length > 0;
  }

  async function loadActiveBudgetPolicy(
    companyId: string,
    scopeType: BudgetScopeType,
    scopeId: string,
  ): Promise<PolicyRow | null> {
    return db
      .select()
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, companyId),
          eq(budgetPolicies.scopeType, scopeType),
          eq(budgetPolicies.scopeId, scopeId),
          eq(budgetPolicies.isActive, true),
          eq(budgetPolicies.metric, "billed_cents"),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  /**
   * When, in THIS window, did the board adjudicate a hard crossing and resume
   * the scope without lifting the cap clear of observed spend? Null if never
   * (PEN-4742).
   *
   * This is the whole of the forgiveness mechanism's state, and it is derived,
   * not stored: a `budget_incidents` row that is `resolved`, `hard`, carries
   * `resolution_action = "resume_without_raise"`, and whose `window_start` is
   * the window we are enforcing right now. Nothing has to be cleaned up by hand
   * -- at the roll, `resolveWindow` returns the next window's start, the
   * `windowStart` equality stops matching, and the grant is simply gone.
   *
   * WHY A COLUMN RATHER THAN DERIVING IT FROM LIVE STATE. The cheap-looking
   * alternative is "any resolved hard incident in this window", but
   * `raise_budget_and_resume` resolves one too -- so an ordinary raise from
   * $3,000 to $4,000 would also buy a scope immunity at $4,000 for the rest of
   * the month. The next refinement, `policy.amount <= incident.amountObserved`,
   * is retroactively forgeable: raise the cap clear of observed, then let any
   * later `upsertPolicy` lower it again, and the predicate flips to true and
   * confers a grant nobody decided. Lowering a cap would loosen enforcement.
   * The decision has to be written down when it is made.
   *
   * `isNotNull(resolvedAt)` is load-bearing twice over, not defensive noise.
   * The column is nullable; this function's contract is to return the instant
   * the grant starts from, and a null would make `computeObservedAmount` drop
   * its floor silently. It also removes a NULLS-FIRST hazard: Postgres sorts
   * nulls FIRST under `ORDER BY ... DESC`, so without the filter a single
   * malformed row (action stamped, `resolvedAt` absent) would sort ahead of a
   * real grant and hide it. Both writes set the two fields together, so this is
   * about what a hand-edit or an older server could leave behind.
   *
   * `desc(resolvedAt)` because repeated adjudications in one window are
   * legitimate -- each re-latch can be forgiven again -- and only the most
   * recent one bounds the allowance.
   */
  async function hardStopForgivenSince(policy: PolicyRow): Promise<Date | null> {
    // `lifetime` windows never roll, so a grant on one would never expire --
    // permanent state, which is exactly what this design refuses. `resolveIncident`
    // rejects the action for them up front; this is the matching read-side guard,
    // so a row written by an older server or by hand still cannot confer one.
    if (policy.windowKind !== "calendar_month_utc") return null;
    const { start } = resolveWindow(policy.windowKind as BudgetWindowKind);
    const row = await db
      .select({ resolvedAt: budgetIncidents.resolvedAt })
      .from(budgetIncidents)
      .where(
        and(
          eq(budgetIncidents.policyId, policy.id),
          eq(budgetIncidents.thresholdType, "hard"),
          eq(budgetIncidents.status, "resolved"),
          eq(budgetIncidents.resolutionAction, "resume_without_raise"),
          eq(budgetIncidents.windowStart, start),
          isNotNull(budgetIncidents.resolvedAt),
        ),
      )
      .orderBy(desc(budgetIncidents.resolvedAt))
      .then((rows) => rows[0] ?? null);
    return row?.resolvedAt ?? null;
  }

  /**
   * The spend figure the hard stop is enforced against, and the grant (if any)
   * that moved it.
   *
   * Without a grant this is the plain window total and nothing has changed.
   * With one, the cap is measured from the instant the board adjudicated the
   * crossing -- "the cap you chose, applied forward from the moment you forgave
   * the overshoot" -- so the scope gets one cap's worth of runway and then hard
   * stops again. The grant bounds the tail; it does not remove the cap. That
   * distinction is the point: blanket suppression would let a scope resumed at
   * $3,001 against a $3,000 cap burn arbitrarily for the rest of the window,
   * which is worse in the tail than the ratchet it replaces.
   *
   * Every enforcement site reads this. Every reporting site reads
   * `computeObservedAmount` directly and keeps showing true window spend.
   */
  async function enforcedObservedAmount(policy: PolicyRow) {
    const forgivenSince = await hardStopForgivenSince(policy);
    const observed = await computeObservedAmount(db, policy, forgivenSince ?? undefined);
    return { observed, forgivenSince };
  }

  /**
   * Does the hard stop bind *right now*, against the current window? This is the
   * question `getInvocationBlock` has always asked of a running scope, extracted
   * so a paused one can be asked it too.
   */
  async function hardStopStillBinds(policy: PolicyRow | null) {
    if (!policy || !policy.hardStopEnabled || policy.amount <= 0) return false;
    const { observed } = await enforcedObservedAmount(policy);
    return observed >= policy.amount;
  }

  /**
   * Why the pause cleared, in the words that go into the audit trail and the
   * board's withdrawal note.
   *
   * The clear fires whenever `hardStopStillBinds` stops holding, and that has
   * five distinct causes -- a window roll is only one of them. Saying "the
   * budget window rolled" for all five writes a false reason whenever the cause
   * was really a deactivated policy, a cap set to zero, or a disabled hard
   * stop; in that last case spend is typically still over cap, so the note
   * would contradict the scope's own numbers. The order below mirrors
   * `hardStopStillBinds`'s short-circuits, so the reason always names the test
   * that actually failed first.
   *
   * The fifth cause is a live forgiveness grant (PEN-4742): spend SINCE the
   * board adjudicated this window's crossing is below the cap, while total
   * window spend may well still be above it. That is reachable -- a forgiven
   * scope can re-latch on post-grant spend and then be released again by a cap
   * raise -- and reporting it as "observed spend in the current window is below
   * the cap" would state the opposite of what the scope's own dashboard shows.
   */
  async function describeClearedCause(policy: PolicyRow | null) {
    if (!policy) return "no active hard-stop budget policy governs this scope";
    if (!policy.hardStopEnabled) return "the hard stop is disabled on the governing policy";
    if (policy.amount <= 0) return "the governing policy no longer sets a cap";
    const forgivenSince = await hardStopForgivenSince(policy);
    if (forgivenSince) {
      return "spend since the board resumed this scope on "
        + `${forgivenSince.toISOString()} is below the cap`;
    }
    return "observed spend in the current window is below the cap";
  }

  /**
   * Clear a budget pause whose condition has stopped holding.
   *
   * The pause is a sticky flag on the scope row; the condition that set it is
   * window-scoped. `computeObservedAmount` only sums cost events inside the
   * current window, so at the window roll the spend that justified the pause
   * drops out of the sum and the condition evaporates -- but nothing clears the
   * flag. `evaluateCostEvent` cannot do it either: it is driven by cost events,
   * and a paused scope emits none, so a latched scope can never re-trigger its
   * own evaluation. Before this, the only exit was an explicit human resume, and
   * a $0.25 overshoot on a $3,000 cap could hold a scope down indefinitely
   * (Penstock PEN-1972).
   *
   * The still-open *hard* incident is closed and its pending card withdrawn:
   * that card asks the board to choose between raising the budget and staying
   * paused, and neither branch is meaningful once the scope is no longer
   * paused. Leaving it pending would strand a decision against a condition that
   * no longer exists. A still-open *soft* incident is deliberately left alone:
   * it makes a different claim, one that can outlive the pause. See the
   * filter below.
   */
  async function clearExpiredBudgetPause(
    companyId: string,
    scopeType: BudgetScopeType,
    scopeId: string,
    scopeName: string,
    policy: PolicyRow | null,
  ) {
    const resumed = await resumeScopeFromBudget({ scopeType, scopeId });
    // Every update in `resumeScopeFromBudget` is guarded on
    // `pauseReason = "budget"`, so "no row changed" means the scope was not ours
    // to resume by the time the write landed: a concurrent caller got there
    // first, or a human pause replaced the budget one between the read in
    // `getInvocationBlock` and this write. This call resumed nothing, so it must
    // not close the board's incident, withdraw its card, or write an
    // `auto_cleared` row claiming a resume that did not happen here.
    if (!resumed) return;

    const cause = await describeClearedCause(policy);

    if (policy) {
      // Hard only. The hard incident *is* the pause decision, so it dies with
      // the pause. A soft incident is a different claim -- "spend has crossed
      // the warn threshold" -- and that claim can still be true at the moment
      // the pause lifts: clearing `hardStopEnabled` while over cap files a warn
      // card and resumes the scope in the same breath (the coexistence case
      // already documented in `resolveIncident`). Closing it there would delete
      // a live warning and leave the board blind to an overspend it is still
      // carrying.
      const openHard = and(
        eq(budgetIncidents.policyId, policy.id),
        eq(budgetIncidents.status, "open"),
        eq(budgetIncidents.thresholdType, "hard"),
      );
      const openRows = await db.select().from(budgetIncidents).where(openHard);
      if (openRows.length > 0) {
        const now = new Date();
        await db
          .update(budgetIncidents)
          .set({ status: "resolved", resolvedAt: now, updatedAt: now })
          .where(openHard);
        for (const row of openRows) {
          await withdrawPendingApproval(
            row.approvalId ?? null,
            row.companyId,
            `Withdrawn automatically: ${cause}, so this scope resumed on its own `
              + "and there is no longer a pause to decide about.",
            "budget_pause_condition_cleared",
          );
        }
      }
    }

    // A resume is a fiscal event and must leave a trace, the same way a pause
    // does -- otherwise a scope that silently came back is indistinguishable
    // from one that was never stopped.
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "budget_service",
      action: "budget.pause_auto_cleared",
      entityType: "budget_policy",
      entityId: policy?.id ?? scopeId,
      details: {
        scopeType,
        scopeId,
        scopeName,
        policyId: policy?.id ?? null,
        reason: cause,
      },
    });
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
    // TRUE window spend, deliberately not the enforcement figure. A forgiven
    // scope keeps reporting the overshoot the board accepted; rebaselining here
    // would drop it to a healthy-looking number and reproduce PEN-1972 defect 3
    // -- the gauge going quiet at precisely the moment it has something to say.
    // `hardStopForgivenSince` below is what explains an over-cap scope that is
    // nonetheless running, so the card can say so instead of looking broken.
    const observedAmount = await computeObservedAmount(db, policy);
    const forgivenSince = await hardStopForgivenSince(policy);
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
      hardStopForgivenSince: policy.isActive ? forgivenSince : null,
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
    //
    // Claim the incident FIRST, in one transaction, and let the card follow it. The
    // `existing` read above is an unlocked fast path, not a guard, so it cannot stop
    // two watcher passes from both reaching this point; the only serialization either
    // row has is `budget_incidents_policy_window_threshold_idx`, the partial unique
    // index on (policy_id, window_start, threshold_type). Filing the approval first
    // put that index *after* the card, so both passes committed a card and only the
    // loser then collided -- and because a server-filed card has both requester
    // columns null, neither partial index in 0212_approval_create_idempotency.sql
    // covers it (both require a non-null requester) and its `idempotencyKey` is
    // decorative. Withdraw is requester-scoped, so the orphan was board-only to
    // clear and the queue accrued one at every threshold crossing (BLO-37275).
    return db.transaction(async (tx) => {
      const claimed = await tx
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
          approvalId: null,
        })
        // Targeted, not bare: a bare DO NOTHING swallows *any* unique violation on
        // this table, so a second unique index added later would be silently
        // reinterpreted as "lost the race", the winner-select below would find no
        // row, and the card would never be filed -- a silent no-op in the exact path
        // this reorder exists to make reliable. Restating the partial predicate is
        // the cost, and it fails the safe way round: an inference spec that stops
        // matching the index raises 42P10 at query time and reddens the concurrency
        // test below, where a bare DO NOTHING would just stop filing cards.
        //
        // `where`, NOT `targetWhere`: drizzle 0.45.2 only reads `targetWhere` from
        // the onConflictDoUpdate config. onConflictDoNothing takes `{ target, where }`
        // and drops any other key, which emits a bare `on conflict (cols) do nothing`
        // with no predicate -- that matches no partial index and is itself a 42P10.
        .onConflictDoNothing({
          target: [budgetIncidents.policyId, budgetIncidents.windowStart, budgetIncidents.thresholdType],
          where: sql`${budgetIncidents.status} = 'open'`,
        })
        .returning()
        .then((rows) => rows[0] ?? null);

      // Lost the race: a concurrent pass committed this incident, and its card, between
      // our read above and this insert. Return the winner's row rather than filing a
      // second card for one threshold crossing. A *closed* incident is outside the
      // partial index, so re-crossing after a dismissal or a cap raise still claims a
      // fresh row here -- and the predicate below must match the index for the same
      // reason the fast-path read does (BLO-28908).
      if (!claimed) {
        const winner = await tx
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
        // Unreachable under READ COMMITTED, which is what this branch depends on:
        // `ON CONFLICT DO NOTHING` blocks on the concurrent inserter, so by the time
        // it returns zero rows the winner has committed, and this statement takes a
        // fresh snapshot that sees it. Under REPEATABLE READ the select would read
        // this transaction's original snapshot, miss the winner, and return null --
        // no card and no `budget.soft_threshold_crossed` log, indistinguishable from
        // "nothing to do". Raising the isolation level needs this branch reworked.
        return winner ? { incident: winner, created: false } : null;
      }

      const approval = await insertApproval(tx, {
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

      const linked = await tx
        .update(budgetIncidents)
        .set({ approvalId: approval?.id ?? null, updatedAt: new Date() })
        .where(eq(budgetIncidents.id, claimed.id))
        .returning()
        .then((rows) => rows[0] ?? null);

      return { incident: linked ?? claimed, created: true };
    });
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
          resolutionAction: (row.resolutionAction as BudgetIncident["resolutionAction"]) ?? null,
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

    /**
     * LOCK ORDER — read this before adding a caller.
     *
     * A transaction that writes both `budget_policies` and `agents` must take
     * the `budget_policies` rows FIRST:
     *
     *   await txDb.select({ id: budgetPolicies.id }).from(budgetPolicies)
     *     .where(and(eq(budgetPolicies.scopeType, "agent"),
     *                eq(budgetPolicies.scopeId, agentId)))
     *     .for("update");
     *
     * This function's own UPDATE takes the policy row, so a caller that writes
     * the `agents` mirror first has already inverted the order by the time it
     * gets here. Against a concurrent writer going the other way that is an ABBA
     * deadlock: Postgres aborts one side with 40P01, which is not an `HttpError`,
     * so `withRefusalLogged` neither logs nor maps it and the loser gets an
     * unhandled 500 with no retry.
     *
     * The three in-transaction writers that take policies first:
     * `PATCH /agents/:agentId/budgets` (`routes/costs.ts`),
     * `applyApprovalEnforcement` (`approval-enforcement-executor.ts`), and the
     * `hire_agent` decision path (`approvals.ts`, whose
     * `activatePendingApproval` opens with `agents … for update`).
     *
     * The remaining callers and writers are outside the rule and are safe for
     * reasons that do not generalise — do not copy them:
     *  - `POST /companies/:companyId/budgets/policies` and
     *    `PATCH /companies/:companyId/budgets` (`routes/costs.ts`),
     *    `POST /companies` (`routes/companies.ts`),
     *    `POST /companies/:companyId/agents` (`routes/agents.ts`), and
     *    `resolveIncident` (this file, below) run outside any
     *    transaction, so each statement autocommits and no lock is held across
     *    the pair in either order. The agent-creation route is safe for that
     *    reason and not because its row is new — the insert has committed by the
     *    time it calls this, so a concurrent `PATCH /agents/:agentId/budgets` can
     *    already name it. `budgets/policies` takes its scope from the request
     *    body, so it writes agent-scope rows too;
     *  - the non-pending branch of `approvals.approve` writes `agents` first
     *    inside the live transaction, but inserts a brand new row whose id no
     *    concurrent request can name yet — the only caller that reason covers.
     *
     * BLO-32796 introduced the order; BLO-34422 brought the last writer into it.
     */
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
            // Only when the actor is a user. An agent-driven write — the apply
            // route in `approval-enforcement-executor.ts` is the first — passes
            // null here, and overwriting would discard whichever board user
            // last set the cap without recording anything in its place. That
            // write's own attribution lives in the config revision and the
            // `approval.enforcement_applied` activity row (BLO-32796).
            //
            // These two columns are NOT a pair, and nothing should render them
            // as one: `updatedAt` below is a row-touch stamp bumped by every
            // writer, so after an agent write it carries that write's time
            // beside the earlier board user's id. Left that way deliberately —
            // there is no reader of this column today, and making `updatedAt`
            // conditional would make a genuinely changed row look untouched,
            // which is the worse failure. If a "last changed by" surface is
            // ever built, it needs its own stamp, the way `amountUpdatedAt`
            // already does it (BLO-34422).
            ...(actorUserId === null ? {} : { updatedByUserId: actorUserId }),
            updatedAt: now,
            // Only when the enforced figure actually moved. This is the single
            // edit path for warn percent, hard stop, notify and active state as
            // well, and `approval-enforcement-reconciler.ts` reads this column
            // as "a later decision moved the cap" — so stamping it on a metadata
            // toggle would let that toggle hide a real enforcement gap
            // (BLO-32796).
            ...(amount === existing.amount ? {} : { amountUpdatedAt: now }),
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
        // Enforcement figure, exactly as in `evaluateCostEvent`: a policy write
        // is the third site that can pause a scope, and leaving it unaware of a
        // forgiveness grant would make an unrelated edit -- toggling
        // notifications, nudging warnPercent -- silently re-pause a scope the
        // board had just released (PEN-4742).
        //
        // That also means an ordinary policy edit does NOT revoke a grant. The
        // alternative, "a cap change mid-window cancels forgiveness", is a
        // hidden rule that fires on edits nobody connects to it. The explicit
        // way to stop a forgiven scope is the operator pause: it sets a
        // `pauseReason` other than `budget`, and every budget resume path is
        // guarded on `pauseReason = "budget"`, so no budget logic will lift it.
        const { observed: enforcedObserved, forgivenSince } = await enforcedObservedAmount(row);
        // Cards and incidents carry true window spend; only the decision uses
        // the rebaselined figure. See the same split in `evaluateCostEvent`.
        const observedAmount = forgivenSince
          ? await computeObservedAmount(db, row)
          : enforcedObserved;
        if (enforcedObserved < amount) {
          await resumeScopeFromBudget(row);
          await resolveOpenIncidentsForPolicy(row.id, actorUserId ? "approved" : null, actorUserId);
        } else {
          const softThreshold = Math.ceil((row.amount * row.warnPercent) / 100);
          const hardStopWillFire = row.hardStopEnabled && enforcedObserved >= row.amount;
          // Same gate as evaluateCostEvent: do not file a warn card the hard
          // branch below is about to withdraw in the same call.
          if (row.notifyEnabled && enforcedObserved >= softThreshold && !hardStopWillFire) {
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
        // Enforcement figure, not the reporting one: where the board has
        // adjudicated this window's crossing and resumed without raising the
        // cap, both thresholds are measured from that decision for the rest of
        // the window (PEN-4742).
        //
        // The WARN branch has to honour the grant as well as the hard one, and
        // that is not incidental tidiness. Total window spend is by definition
        // still over the cap right after a grant, hence over warnPercent of it
        // too -- so a hard-only fix would file a fresh warn card on the very
        // next cost event, against a crossing the board had just finished
        // deciding. That is the same churn the action exists to prevent, merely
        // relabelled from "re-paused" to "re-carded". Measured from the
        // decision instead, the warn card regains its meaning: it fires when
        // the scope is burning through the allowance the board just granted.
        const { observed: enforcedObserved, forgivenSince } = await enforcedObservedAmount(policy);
        // The card and the activity row get TRUE window spend, never the
        // rebaselined figure. The grant changes what the hard stop is measured
        // against; it does not change what the scope actually spent, and an
        // incident claiming "$3,000 against a limit of $3,000" on a scope that
        // has really burned $6,001 this window would mislead the next board
        // member to read it. The two numbers are only ever different when a
        // grant is live, so the extra read costs nothing on the normal path.
        const observedAmount = forgivenSince
          ? await computeObservedAmount(db, policy)
          : enforcedObserved;
        const softThreshold = Math.ceil((policy.amount * policy.warnPercent) / 100);
        const hardStopWillFire = policy.hardStopEnabled && enforcedObserved >= policy.amount;

        // Skip the warn card only when the hard branch below is about to run in
        // this same evaluation and immediately withdraw it -- a single cost event
        // can jump from under the warn threshold to over the cap, and filing a
        // card no board member could ever see just to withdraw it two statements
        // later puts a decision in the activity log that never happened. The gate
        // is "the hard path will fire", not "observed >= amount": with
        // `hardStopEnabled: false` nothing else would ever notify, and the warn
        // card is the only signal that scope has blown its cap.
        if (policy.notifyEnabled && enforcedObserved >= softThreshold && !hardStopWillFire) {
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
                amountObservedSinceForgiveness: forgivenSince ? enforcedObserved : null,
                hardStopForgivenSince: forgivenSince?.toISOString() ?? null,
                amountLimit: policy.amount,
                approvalId: softIncident.incident.approvalId ?? null,
              },
            });
          }
        }

        if (policy.hardStopEnabled && enforcedObserved >= policy.amount) {
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
                amountObservedSinceForgiveness: forgivenSince ? enforcedObserved : null,
                hardStopForgivenSince: forgivenSince?.toISOString() ?? null,
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

      // The governing policy is loaded *before* the pause check, not after it,
      // so that a scope already carrying the flag can be asked the same live
      // question as one that is still running. Observed spend is computed once
      // and reused by both branches.
      const companyPolicy = await loadActiveBudgetPolicy(companyId, "company", companyId);
      const companyOverCap = await hardStopStillBinds(companyPolicy);

      if (company.status === "paused") {
        if (company.pauseReason !== "budget") {
          return {
            scopeType: "company" as const,
            scopeId: companyId,
            scopeName: company.name,
            reason: "Company is paused and cannot start new work.",
          };
        }
        if (companyOverCap) {
          return {
            scopeType: "company" as const,
            scopeId: companyId,
            scopeName: company.name,
            reason: "Company is paused because its budget hard-stop was reached.",
          };
        }
        await clearExpiredBudgetPause(companyId, "company", companyId, company.name, companyPolicy);
      }

      if (companyOverCap) {
        return {
          scopeType: "company" as const,
          scopeId: companyId,
          scopeName: company.name,
          reason: "Company cannot start new work because its budget hard-stop is exceeded.",
        };
      }

      const agentPolicy = await loadActiveBudgetPolicy(companyId, "agent", agentId);
      const agentOverCap = await hardStopStillBinds(agentPolicy);

      if (agent.status === "paused" && agent.pauseReason === "budget") {
        if (agentOverCap) {
          return {
            scopeType: "agent" as const,
            scopeId: agentId,
            scopeName: agent.name,
            reason: "Agent is paused because its budget hard-stop was reached.",
          };
        }
        await clearExpiredBudgetPause(companyId, "agent", agentId, agent.name, agentPolicy);
      }

      if (agentOverCap) {
        return {
          scopeType: "agent" as const,
          scopeId: agentId,
          scopeName: agent.name,
          reason: "Agent cannot start because its budget hard-stop is still exceeded.",
        };
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
      const projectPolicy = await loadActiveBudgetPolicy(companyId, "project", project.id);
      const projectOverCap = await hardStopStillBinds(projectPolicy);
      if (projectOverCap) {
        return {
          scopeType: "project" as const,
          scopeId: project.id,
          scopeName: project.name,
          reason: "Project cannot start work because its budget hard-stop is still exceeded.",
        };
      }

      if (!project.pausedAt || project.pauseReason !== "budget") return null;
      // Over-cap was ruled out above, so the flag has outlived its condition.
      await clearExpiredBudgetPause(companyId, "project", project.id, project.name, projectPolicy);
      return null;
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
      const isResume = input.action === "raise_budget_and_resume"
        || input.action === "resume_without_raise";
      let resolvedPolicyAmount = policy.amount;
      if (isResume) {
        const raising = input.action === "raise_budget_and_resume";
        // `raise_budget_and_resume` has always required an amount (the zod schema
        // enforces it). `resume_without_raise` does not: omitting it means "keep
        // the cap exactly as it stands", which is the common case and the whole
        // reason the action exists (PEN-4742).
        const writesCap = raising || typeof input.amount === "number";
        const nextAmount = writesCap ? Math.max(0, Math.floor(input.amount ?? 0)) : policy.amount;
        resolvedPolicyAmount = nextAmount;

        if (!raising && policy.windowKind !== "calendar_month_utc") {
          // A `lifetime` window never rolls, so a forgiveness grant on one would
          // never expire -- permanent state, which is what this design refuses.
          // The coherent exits for a blown lifetime cap are raising it, turning
          // the hard stop off, or staying paused.
          throw unprocessable(
            "Resuming without a raise needs a window that rolls; this policy's budget is lifetime-scoped",
          );
        }

        if (raising) {
          const currentObserved = await computeObservedAmount(db, policy);
          // NARROWED, not deleted (PEN-4742). The guard's intent is sound -- resuming
          // under a cap you have already blown re-latches on the next cost event, so
          // churn, a fresh incident, a fresh card. But it only has that effect where
          // the cap can actually bind, and applying it unconditionally is what turned
          // the cap into a function of accrued spend: mid-window it forces
          // observed-plus-epsilon, which ratchets the figure upward permanently for
          // every future window because of one window's overshoot. A $1.63 breach is
          // how a $20,011.63 cap got set.
          //
          // Two cases where it cannot bite and so must not block:
          //   - `hardStopEnabled: false` -- the cap pauses nothing, so there is
          //     nothing to re-latch.
          //   - `nextAmount <= 0` -- zero means "no cap" everywhere else in this file
          //     (`budgetStatusFromObserved`, `hardStopStillBinds`, `getInvocationBlock`
          //     all short-circuit on it), so this rejected the one input that removes
          //     the cap outright, purely because 0 is never greater than observed.
          //
          // The post-roll case needs no code: once observed falls below the cap,
          // keeping the cap already satisfies `nextAmount > currentObserved`.
          //
          // The mid-window case -- the one that actually bites -- is not handled by
          // narrowing at all. It is handled by `resume_without_raise`, which separates
          // "what the cap is" from "may this scope run for the rest of this window".
          const guardCanBite = policy.hardStopEnabled && nextAmount > 0;
          if (guardCanBite && nextAmount <= currentObserved) {
            throw unprocessable("New budget must exceed current observed spend");
          }
        }

        const now = new Date();
        if (writesCap) {
          await db
            .update(budgetPolicies)
            .set({
              amount: nextAmount,
              isActive: true,
              updatedByUserId: actorUserId,
              updatedAt: now,
              ...(nextAmount === policy.amount ? {} : { amountUpdatedAt: now }),
            })
            .where(eq(budgetPolicies.id, policy.id));
        }

        if (writesCap && policy.scopeType === "company" && policy.windowKind === "calendar_month_utc") {
          await db
            .update(companies)
            .set({ budgetMonthlyCents: nextAmount, updatedAt: now })
            .where(eq(companies.id, policy.scopeId));
        }

        if (writesCap && policy.scopeType === "agent" && policy.windowKind === "calendar_month_utc") {
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
        // `resolutionAction` is what `hardStopForgivenSince` reads back later, so
        // this write IS the forgiveness grant -- there is no other state. It is
        // therefore stamped on the decided row ALONE, keyed on `id`, and the other
        // rows this resume closes are closed in a second statement that never
        // touches the column.
        //
        // One statement keyed on `policyId AND status = "open"` is what this was,
        // and it sprayed the action across every open row on the policy. That was
        // wrong in exactly one reachable way, and the way is bad: a replayed
        // `resume_without_raise` against an ALREADY-CLOSED incident A is not itself
        // in the open set, so it stamped whatever else was -- a later, live hard
        // incident B -- and minted a grant from B's `resolvedAt` that no board ever
        // decided against B's numbers. `createIncidentIfNeeded` suppresses only on
        // OPEN rows, so B is routinely creatable the moment A is resolved: grant,
        // re-latch, replay is an ordinary stale-client sequence, not a contrived
        // one. It survived a window roll too, since B carries the CURRENT
        // `windowStart` and the grant is keyed on that.
        //
        // Keyed on `id`, a replay against a closed A now matches nothing, stamps
        // nothing, and confers nothing -- B is still closed by the sweep below, but
        // with `resolutionAction` left null, which `hardStopForgivenSince` cannot
        // read as a grant. The invariant is structural rather than incidental: a
        // grant can only ever come from the row the board actually named, and only
        // if that row was still open when they named it.
        //
        // The sweep deliberately leaves `resolutionAction` null rather than
        // stamping a second action. Those rows were closed as a side effect of a
        // decision about a DIFFERENT crossing; null is the honest record of that,
        // and it is what their withdrawal note already says.
        await db
          .update(budgetIncidents)
          .set({
            status: "resolved",
            resolvedAt: now,
            resolutionAction: input.action,
            updatedAt: now,
          })
          .where(and(eq(budgetIncidents.id, incident.id), eq(budgetIncidents.status, "open")));

        await db
          .update(budgetIncidents)
          .set({ status: "resolved", resolvedAt: now, updatedAt: now })
          .where(
            and(
              eq(budgetIncidents.policyId, policy.id),
              eq(budgetIncidents.status, "open"),
              ne(budgetIncidents.id, incident.id),
            ),
          );

        await markApprovalStatus(db, incident.approvalId ?? null, "approved", input.decisionNote, actorUserId);
        // Resuming closes *every* open incident for the policy, but only the
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
            raising
              ? "Withdrawn automatically: the budget was raised in response to another incident on this policy."
              : "Withdrawn automatically: the scope was resumed in response to another incident on this policy.",
            "incident_closed_without_decision",
          );
        }
      } else {
        await db
          .update(budgetIncidents)
          .set({
            status: "dismissed",
            resolvedAt: new Date(),
            resolutionAction: input.action,
            updatedAt: new Date(),
          })
          // Same `status = "open"` filter the raise branch uses above. Without it a
          // stale `keep_paused` against an already-`resolved` incident rewrites that
          // decided crossing to `dismissed` and overwrites its `resolvedAt`, while
          // `markApprovalStatus`'s `pending` guard leaves the card `approved` -- a
          // dismissed incident carrying an approved card, for a scope that is
          // running, because the dismiss branch never pauses (#2190 review).
          // No legitimate dismissal targets a non-open incident.
          .where(and(eq(budgetIncidents.id, incident.id), eq(budgetIncidents.status, "open")));
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
          // What the board sent, and separately what the cap actually is now.
          // They differ on `resume_without_raise` with no amount -- the case the
          // whole action exists for -- and a log that only carried `null` there
          // could not answer "what was this scope capped at when it resumed?".
          amount: input.amount ?? null,
          effectiveAmount: resolvedPolicyAmount,
          scopeType: incident.scopeType,
          scopeId: incident.scopeId,
        },
      });

      // Report the row as it actually is now, not as the requested action implies.
      // Both branches close incidents under a `status = "open"` filter, so a submit
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

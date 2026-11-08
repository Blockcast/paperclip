import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { budgetPolicies, type Db } from "@paperclipai/db";
import {
  createCostEventSchema,
  createFinanceEventSchema,
  normalizeIssueIdentifier,
  resolveBudgetIncidentSchema,
  updateBudgetSchema,
  upsertBudgetPolicySchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  budgetService,
  costService,
  financeService,
  companyService,
  agentService,
  issueService,
  heartbeatService,
  accessService,
  logActivity,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";
import { fetchAllQuotaWindows } from "../services/quota-windows.js";
import { badRequest } from "../errors.js";
import { redactAgentSecrets } from "../agent-redaction.js";
import { resolveWorkspaceRuntimeViewer } from "./workspace-response.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { BudgetEnforcementScope } from "../services/budgets.js";

export function parseCostDateRange(query: Record<string, unknown>) {
  const fromRaw = query.from as string | undefined;
  const toRaw = query.to as string | undefined;
  const from = fromRaw ? new Date(fromRaw) : undefined;
  const to = toRaw ? new Date(toRaw) : undefined;
  if (from && isNaN(from.getTime())) throw badRequest("invalid 'from' date");
  if (to && isNaN(to.getTime())) throw badRequest("invalid 'to' date");
  return (from || to) ? { from, to } : undefined;
}

/**
 * PEN-5937: raised from 5 to 31 now that `by-project` no longer joins `activity_log`.
 *
 * ## What the 5 was, and why it is gone
 *
 * PEN-5591 set it as a STOPGAP against a fleet-wide shed. `by-project` rebuilt a
 * run->project link table per request from `activity_log` inner joined to `issues` on
 * `issues.id::text`, and measured 2026-11-07 against `cf90ee33` that cost 3 d ~1 s,
 * 5 d ~5 s, 7 d 20-30 s, 10 d `503`. The >20x step between 5 d and 7 d was a plan flip,
 * so the cap was tracking a CLIFF -- and a cliff that marches toward shorter windows as
 * fleet activity accumulates, which is why the constant decayed silently (PEN-5886) and
 * why PEN-5591 wrote that only its successor could lift it.
 *
 * That join is now deleted (services/costs.ts). Attribution is a column read, so this
 * aggregate scans exactly what `byAgent` scans -- and `byAgent` answered 30 days in
 * ~0.1 s for the same company, same window, while this route was being cancelled at 10.
 * There is no cliff left for a cap to track.
 *
 * ## Why 31 and not removal
 *
 * Removal was considered and declined. `byAgent` carries no cap and nobody calls that a
 * defect, so coherence argues for removing this one too -- but the cost model above is
 * reasoned from the shape of the new plan, not measured in production, and this is the
 * one route that has already shed the fleet once. 31 days covers every bounded window
 * the product actually asks for (`30d`, and `mtd` on any calendar month) while leaving
 * a bound on connection-hold time during the first deploy that runs without the join.
 *
 * This number is NOT the old one retuned. The 5 named the longest window that still
 * returned 200; 31 names the widest window the product asks for, and nothing about it
 * decays as the fleet grows -- a month does not get longer. Widen it on evidence from
 * the live route, not on a re-measurement of a cliff that no longer exists.
 *
 * ## An unbounded window is still refused
 *
 * Not for cost symmetry -- because `from` absent is a full-history scan, the incident's
 * worst case (PEN-5585: 191/191 `503`), and no window the product offers needs it. The
 * portal reads this value out of the `400` payload and clamps (PEN-6038, #3520), so
 * `ytd` and `all` degrade to the trailing 31 days rather than erroring.
 *
 * ## The backstop this deliberately does NOT ship
 *
 * A `SET LOCAL statement_timeout` scoped to this one query would bound the quantity that
 * actually harms us -- connection-hold time -- and would not decay. It is recorded on
 * PEN-5937 as a design consideration and explicitly NOT as an accepted remedy: it is
 * untested here, and what would establish it is that a sub-cap `SET LOCAL` survives the
 * pool's startup packet and composes with the inherited-timeout accounting in
 * `db-inherited-timeouts.ts`. Shipping an unmeasured mechanism as the only bound, in the
 * same change that deletes the measured one, would be trading a known bound for a hoped
 * one. The two are complementary; this change keeps the cap and leaves that open.
 */
export const BY_PROJECT_MAX_WINDOW_DAYS = 31;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Reject a `by-project` window wider than the cap, and reject an unbounded one.
 *
 * An absent `from` is NOT lenient -- it is the worst case, the full-history
 * scan that cost 191/191 requests in the incident, so it is refused rather
 * than defaulted. An absent `to` means "now", which is bounded and fine.
 */
export function assertByProjectWindowWithinCap(
  range: { from?: Date; to?: Date } | undefined,
  now: Date = new Date(),
): void {
  const from = range?.from;
  if (!from) {
    throw badRequest(
      `'from' is required on costs/by-project and the window must be at most `
      + `${BY_PROJECT_MAX_WINDOW_DAYS} days. An unbounded window is a full-history scan, `
      + `which is the worst case that shed unrelated routes in the PEN-5585 incident.`,
      { code: "window_unbounded", maxWindowDays: BY_PROJECT_MAX_WINDOW_DAYS, issue: "PEN-5937" },
    );
  }
  const to = range?.to ?? now;
  const spanDays = (to.getTime() - from.getTime()) / MS_PER_DAY;
  // An inverted range yields a NEGATIVE span, which would slip under the cap
  // below and reach the database. It is harmless today -- the window is bounded
  // and the result empty -- but it passes the guard for the wrong reason, and
  // the generic date parser does not reject it either.
  if (spanDays < 0) {
    throw badRequest(
      `costs/by-project 'to' precedes 'from'.`,
      { code: "window_inverted", issue: "PEN-5591" },
    );
  }
  if (spanDays > BY_PROJECT_MAX_WINDOW_DAYS) {
    throw badRequest(
      `costs/by-project window is ${spanDays.toFixed(1)} days; the maximum is `
      + `${BY_PROJECT_MAX_WINDOW_DAYS}. This bounds how long one request may hold a `
      + `database connection. Request a shorter range.`,
      {
        code: "window_too_wide",
        requestedWindowDays: Number(spanDays.toFixed(1)),
        maxWindowDays: BY_PROJECT_MAX_WINDOW_DAYS,
        issue: "PEN-5937",
      },
    );
  }
}

/**
 * PEN-4902: `agentId` on the agent-keyed cost aggregates. Previously accepted
 * and dropped — the route read `companyId` and the date range and nothing
 * else — so a per-seat request answered with all nine seats and a caller
 * taking `rows[0]` got the top spender under the requested seat's name.
 */
export function parseCostAgentId(query: Record<string, unknown>) {
  const raw = Array.isArray(query.agentId) ? query.agentId[0] : query.agentId;
  if (raw == null || raw === "") return undefined;
  if (typeof raw !== "string") throw badRequest("invalid 'agentId' value");
  return raw;
}

export function parseCostLimit(query: Record<string, unknown>) {
  const raw = Array.isArray(query.limit) ? query.limit[0] : query.limit;
  if (raw == null || raw === "") return 100;
  const limit = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(limit) || limit <= 0 || limit > 500) {
    throw badRequest("invalid 'limit' value");
  }
  return limit;
}

export function costRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const budgetHooks = {
    cancelWorkForScope: heartbeat.cancelBudgetScopeWork,
  };
  const costs = costService(db, budgetHooks);
  const finance = financeService(db);
  const budgets = budgetService(db, budgetHooks);
  const companies = companyService(db);
  const agents = agentService(db);
  const issues = issueService(db);
  const access = accessService(db);

  async function resolveIssueByRef(rawId: string) {
    const identifier = normalizeIssueIdentifier(rawId);
    if (identifier) {
      return issues.getByIdentifier(identifier);
    }
    return issues.getById(rawId);
  }

  async function assertCompanyCostReadAllowed(req: Parameters<typeof assertCompanyAccess>[0], res: any, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Costs are outside this actor's authorization boundary" });
    return false;
  }

  async function assertIssueCostReadAllowed(req: Parameters<typeof assertCompanyAccess>[0], res: any, issue: {
    id: string;
    companyId: string;
    projectId: string | null;
    parentId: string | null;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    status: string;
  }) {
    const decision = await access.decide({
      actor: req.actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: issue.companyId,
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        status: issue.status,
      },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Issue costs are outside this actor's authorization boundary" });
    return false;
  }

  router.post("/companies/:companyId/cost-events", validate(createCostEventSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only report its own costs" });
      return;
    }

    const event = await costs.createEvent(companyId, {
      ...req.body,
      occurredAt: new Date(req.body.occurredAt),
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "cost.reported",
      entityType: "cost_event",
      entityId: event.id,
      details: { costCents: event.costCents, model: event.model },
    });

    res.status(201).json(event);
  });

  router.post("/companies/:companyId/finance-events", validate(createFinanceEventSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const event = await finance.createEvent(companyId, {
      ...req.body,
      occurredAt: new Date(req.body.occurredAt),
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "finance_event.reported",
      entityType: "finance_event",
      entityId: event.id,
      details: {
        amountCents: event.amountCents,
        biller: event.biller,
        eventKind: event.eventKind,
        direction: event.direction,
      },
    });

    res.status(201).json(event);
  });

  router.get("/companies/:companyId/costs/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const summary = await costs.summary(companyId, range);
    res.json(summary);
  });

  router.get("/issues/:id/cost-summary", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await getAccessibleResource(req, res, resolveIssueByRef(rawId), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueCostReadAllowed(req, res, issue))) return;
    const excludeRoot = req.query.excludeRoot === "true" || req.query.excludeRoot === "1";
    const summary = await costs.issueTreeSummary(issue.companyId, issue.id, { excludeRoot });
    res.json(summary);
  });

  router.get("/companies/:companyId/costs/by-agent", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await costs.byAgent(companyId, range, { agentId: parseCostAgentId(req.query) });
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-agent-model", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await costs.byAgentModel(companyId, range, { agentId: parseCostAgentId(req.query) });
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-provider", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await costs.byProvider(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-biller", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await costs.byBiller(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const summary = await finance.summary(companyId, range);
    res.json(summary);
  });

  router.get("/companies/:companyId/costs/finance-by-biller", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await finance.byBiller(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-by-kind", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await finance.byKind(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-events", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const limit = parseCostLimit(req.query);
    const rows = await finance.list(companyId, range, limit);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/window-spend", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const rows = await costs.windowSpend(companyId);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/quota-windows", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    // validate companyId resolves to a real company so the "__none__" sentinel
    // and any forged ids are rejected before we touch provider credentials
    const company = await companies.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const results = await fetchAllQuotaWindows();
    res.json(results);
  });

  router.get("/companies/:companyId/budgets/overview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const overview = await budgets.overview(companyId);
    res.json(overview);
  });

  router.post(
    "/companies/:companyId/budgets/policies",
    validate(upsertBudgetPolicySchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const summary = await budgets.upsertPolicy(companyId, req.body, req.actor.userId ?? "board");
      res.json(summary);
    },
  );

  router.post(
    "/companies/:companyId/budget-incidents/:incidentId/resolve",
    validate(resolveBudgetIncidentSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const incidentId = req.params.incidentId as string;
      assertCompanyAccess(req, companyId);
      const incident = await budgets.resolveIncident(companyId, incidentId, req.body, req.actor.userId ?? "board");
      res.json(incident);
    },
  );

  router.get("/companies/:companyId/costs/by-project", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    // PEN-5591: refuse before touching the database -- the cost of this query is
    // paid in full even when it is cancelled, so the cap has to gate the call.
    assertByProjectWindowWithinCap(range);
    const rows = await costs.byProject(companyId, range);
    res.json(rows);
  });

  router.patch("/companies/:companyId/budgets", validate(updateBudgetSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await companies.update(companyId, { budgetMonthlyCents: req.body.budgetMonthlyCents });
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.budget_updated",
      entityType: "company",
      entityId: companyId,
      details: { budgetMonthlyCents: req.body.budgetMonthlyCents },
    });

    await budgets.upsertPolicy(
      companyId,
      {
        scopeType: "company",
        scopeId: companyId,
        amount: req.body.budgetMonthlyCents,
        windowKind: "calendar_month_utc",
      },
      req.actor.userId ?? "board",
    );

    res.json(company);
  });

  router.patch("/agents/:agentId/budgets", validate(updateBudgetSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const agent = await getAccessibleResource(req, res, agents.getById(agentId), "Agent not found");
    if (!agent) return;

    assertBoard(req);

    const actor = getActorInfo(req);
    const deferredCancellations: BudgetEnforcementScope[] = [];
    const updated = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      // Lock the policy rows before anything touches `agents` — the one lock
      // order for this pair, stated in full on `upsertPolicy` in `budgets.ts`.
      // This route used to be the lone inversion: `txAgents.update` first, then
      // the policy lock inside `upsertPolicy`'s UPDATE. Against a concurrent
      // apply on the same agent that is a textbook ABBA deadlock — Postgres
      // aborts one side with 40P01, which is not an `HttpError`, so the caller
      // gets an unhandled 500 with no retry and a board cap change is the losing
      // side as often as the apply is (BLO-32796).
      await txDb
        .select({ id: budgetPolicies.id })
        .from(budgetPolicies)
        .where(
          and(eq(budgetPolicies.scopeType, "agent"), eq(budgetPolicies.scopeId, agentId)),
        )
        .for("update");
      const txAgents = agentService(txDb);
      // Process termination is irreversible and uses the outer DB connection.
      // Defer it until the transaction has committed so a failed policy write
      // cannot leave work cancelled for a cap change that rolled back.
      const txBudgets = budgetService(txDb, {
        cancelWorkForScope: async (scope) => {
          deferredCancellations.push(scope);
        },
      });
      const txUpdated = await txAgents.update(
        agentId,
        { budgetMonthlyCents: req.body.budgetMonthlyCents },
        {
          recordRevision: {
            createdByAgentId: actor.agentId,
            createdByUserId: actor.actorType === "user" ? actor.actorId : null,
            source: "budgets-patch",
          },
        },
      );
      if (!txUpdated) return null;

      await logActivity(txDb, {
        companyId: txUpdated.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "agent.budget_updated",
        entityType: "agent",
        entityId: txUpdated.id,
        details: { budgetMonthlyCents: txUpdated.budgetMonthlyCents },
      });

      await txBudgets.upsertPolicy(
        txUpdated.companyId,
        {
          scopeType: "agent",
          scopeId: txUpdated.id,
          amount: txUpdated.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      );

      return txUpdated;
    });
    for (const scope of deferredCancellations) {
      await budgetHooks.cancelWorkForScope(scope);
    }
    if (!updated) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    // Board-gated, so not agent-visible — but this is the exact shape
    // BLO-18969 fixed on `PATCH /api/agents/:id`: a budget-only write handing
    // back the agent's entire credential set. It was previously left alone
    // because the redactor was closure-private to the `agentRoutes` factory;
    // it is now a leaf import, so there is no reason not to contain it
    // (PEN-3707 §5 / PEN-3726).
    // PEN-5225: this echo carries `adapterConfig`, so it carries the host-executed workspace
    // command strings too. Board-gated is not the same entitlement — `workspace_runtime:read`
    // is, and resolving it here keeps this route's answer identical to the one the agent detail
    // route gives the same caller for the same row (the PEN-4775 consistency rule).
    res.json(redactAgentSecrets(
      updated,
      await resolveWorkspaceRuntimeViewer(access, req, updated.companyId),
    ));
  });

  return router;
}

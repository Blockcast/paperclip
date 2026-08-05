import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { normalizeIssueIdentifier } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { activityService, normalizeActivityLimit } from "../services/activity.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess, getAccessibleResource, hasCompanyAccess } from "./authz.js";
import { accessService, heartbeatService, issueService } from "../services/index.js";
import { sanitizeRecord } from "../redaction.js";

const createActivitySchema = z.object({
  actorType: z.enum(["agent", "user", "system", "plugin"]).optional().default("system"),
  actorId: z.string().min(1),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  agentId: z.string().uuid().optional().nullable(),
  details: z.record(z.unknown()).optional().nullable(),
});

const COMPANY_ACTIVITY_QUERY_PARAMS = new Set(["agentId", "entityType", "entityId", "action", "limit"]);

// A caller who mistypes or invents a filter key on an audit surface must not get a plausible-looking
// unfiltered page back — that reads as "verified absent" instead of "filter never applied" (BLO-21979).
function rejectUnsupportedQueryParams(req: { query: Record<string, unknown> }, res: any, allowed: Set<string>) {
  const unsupported = Object.keys(req.query).filter((key) => !allowed.has(key)).sort();
  if (unsupported.length === 0) return true;
  res.status(400).json({
    error: `Unsupported query parameter${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}`,
    unsupportedParams: unsupported,
  });
  return false;
}

export function activityRoutes(db: Db) {
  const router = Router();
  const svc = activityService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db);
  const issueSvc = issueService(db);

  async function assertCompanyScopeReadAllowed(req: Parameters<typeof assertCompanyAccess>[0], res: any, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Activity is outside this actor's authorization boundary" });
    return false;
  }

  async function assertIssueReadAllowed(req: Parameters<typeof assertCompanyAccess>[0], res: any, issue: {
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
    res.status(403).json({ error: "Issue activity is outside this actor's authorization boundary" });
    return false;
  }

  async function resolveIssueByRef(rawId: string) {
    const identifier = normalizeIssueIdentifier(rawId);
    if (identifier) {
      return issueSvc.getByIdentifier(identifier);
    }
    return issueSvc.getById(rawId);
  }

  router.get("/companies/:companyId/activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyScopeReadAllowed(req, res, companyId))) return;
    if (!rejectUnsupportedQueryParams(req, res, COMPANY_ACTIVITY_QUERY_PARAMS)) return;

    const filters = {
      companyId,
      agentId: req.query.agentId as string | undefined,
      entityType: req.query.entityType as string | undefined,
      entityId: req.query.entityId as string | undefined,
      action: req.query.action as string | undefined,
      limit: normalizeActivityLimit(Number(req.query.limit)),
    };
    const result = await svc.list(filters);
    // Echoes the filter actually applied (as opposed to the query string sent) so a caller can tell
    // "filter applied, zero matches" apart from "filter never applied" without changing the array response shape.
    res.setHeader(
      "X-Applied-Filters",
      JSON.stringify({
        agentId: filters.agentId ?? null,
        entityType: filters.entityType ?? null,
        entityId: filters.entityId ?? null,
        action: filters.action ?? null,
        limit: filters.limit,
      }),
    );
    res.json(result);
  });

  router.post("/companies/:companyId/activity", validate(createActivitySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const event = await svc.create({
      companyId,
      ...req.body,
      details: req.body.details ? sanitizeRecord(req.body.details) : null,
    });
    res.status(201).json(event);
  });

  router.get("/issues/:id/activity", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await getAccessibleResource(req, res, resolveIssueByRef(rawId), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    if (!rejectUnsupportedQueryParams(req, res, new Set())) return;
    const result = await svc.forIssue(issue.id);
    res.json(result);
  });

  router.get("/issues/:id/runs", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await getAccessibleResource(req, res, resolveIssueByRef(rawId), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    if (!rejectUnsupportedQueryParams(req, res, new Set())) return;
    const result = await svc.runsForIssue(issue.companyId, issue.id);
    res.json(result);
  });

  router.get("/heartbeat-runs/:runId/issues", async (req, res) => {
    assertAuthenticated(req);
    const runId = req.params.runId as string;
    if (!rejectUnsupportedQueryParams(req, res, new Set())) return;
    const run = await heartbeat.getRun(runId);
    if (!run || !hasCompanyAccess(req, run.companyId)) {
      // Return `200 []` for both "doesn't exist" and "cross-tenant" — preserves the
      // legacy API contract while keeping the cross-tenant existence oracle closed
      // (both branches yield indistinguishable responses).
      res.json([]);
      return;
    }
    assertCompanyAccess(req, run.companyId);
    if (!(await assertCompanyScopeReadAllowed(req, res, run.companyId))) return;
    const result = await svc.issuesForRun(runId);
    res.json(result);
  });

  return router;
}

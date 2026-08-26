import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
import {
  DEFAULT_RECOVERY_RATE_THRESHOLD_PERCENT,
  MAX_WINDOW_WEEKS,
  recoveryObservabilityService,
} from "../services/recovery-observability.js";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parsePositiveNumber(
  value: unknown,
  fallback: number,
  max?: number,
): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return max != null ? Math.min(parsed, max) : parsed;
}

export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);
  const recoveryObservability = recoveryObservabilityService(db);

  router.get("/companies/:companyId/dashboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const summary = await svc.summary(companyId);
    res.json(summary);
  });

  // Agent scorecards for the monthly staffing routine (BLO-10275). Optional
  // ?windowDays= overrides the default 30-day window; the service clamps it.
  router.get("/companies/:companyId/agent-scorecards", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rawWindow = req.query.windowDays;
    const parsedWindow = typeof rawWindow === "string" ? Number.parseInt(rawWindow, 10) : undefined;
    const windowDays =
      parsedWindow !== undefined && Number.isFinite(parsedWindow) ? parsedWindow : undefined;
    const scorecards = await svc.agentScorecards(companyId, { windowDays });
    res.json(scorecards);
  });

  router.get("/companies/:companyId/recovery-observability", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const weeks = parsePositiveNumber(req.query.weeks, 8, MAX_WINDOW_WEEKS);
    const thresholdPercent = parsePositiveNumber(
      req.query.threshold,
      DEFAULT_RECOVERY_RATE_THRESHOLD_PERCENT,
    );
    const report = await recoveryObservability.report(companyId, {
      weeks,
      thresholdPercent,
    });
    res.json(report);
  });

  router.get("/companies/:companyId/recovery-actions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const ownerAgentId = typeof req.query.ownerAgentId === "string" ? req.query.ownerAgentId : undefined;
    if (ownerAgentId !== undefined && !UUID_REGEX.test(ownerAgentId)) {
      throw badRequest("Query parameter ownerAgentId must be a valid UUID");
    }
    const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const limit = parsePositiveNumber(req.query.limit, 100, 500);
    const actions = await recoveryObservability.listActions(companyId, {
      ownerAgentId,
      kind,
      status,
      limit,
    });
    res.json({ companyId, ownerAgentId: ownerAgentId ?? null, kind: kind ?? null, status: status ?? null, actions });
  });

  return router;
}

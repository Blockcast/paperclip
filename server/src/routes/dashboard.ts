import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
import {
  DEFAULT_RECOVERY_RATE_THRESHOLD_PERCENT,
  MAX_WINDOW_WEEKS,
  recoveryObservabilityService,
} from "../services/recovery-observability.js";
import { assertCompanyAccess } from "./authz.js";
import {
  ISSUE_RECOVERY_ACTION_KINDS,
  ISSUE_RECOVERY_ACTION_OUTCOMES,
  ISSUE_RECOVERY_ACTION_STATUSES,
  isUuidLike,
} from "@paperclipai/shared";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { badRequest } from "../errors.js";

/**
 * Parses a single query value against an allowed set. Returns null when nothing
 * was supplied so the caller can distinguish "no filter" from "filter that
 * matches nothing", and rejects anything supplied but unrecognised for the same
 * reason `parseEnumList` does: a dropped filter does not narrow the result set,
 * it WIDENS it. `?outcome=Expired` silently returning every outcome — and an
 * operator reading that as the expired backlog — is the failure mode.
 */
function parseEnum<T extends string>(value: unknown, allowed: readonly T[], name: string): T | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) throw badRequest(`${name} must be a single value`);
  if (typeof value !== "string") throw badRequest(`${name} must be one of: ${allowed.join(", ")}`);
  const raw = value.trim();
  if (!raw) return null;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw badRequest(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return raw as T;
}

/**
 * Parses a repeated or comma-separated query value against an allowed set.
 * Returns null when nothing was supplied so the caller can distinguish "no
 * filter" from "filter that matches nothing". Rejects unrecognised entries
 * rather than dropping them: silently ignoring `?status=Active` would widen the
 * result set to the whole company history, and an operator sizing a backlog
 * would read those terminal rows as active.
 */
function parseEnumList<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T[] | null {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const entries = raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return null;
  const invalid = entries.filter((entry) => !(allowed as readonly string[]).includes(entry));
  if (invalid.length > 0) {
    throw badRequest(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return [...new Set(entries as T[])];
}

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

function parseOptionalPositiveInteger(
  value: unknown,
  name: string,
  fallback: number,
  max?: number,
): number {
  if (value === undefined) return fallback;
  if (Array.isArray(value)) throw badRequest(`${name} must be a single integer`);
  const raw = typeof value === "string" ? value.trim() : String(value);
  if (!/^\d+$/.test(raw)) throw badRequest(`${name} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw badRequest(`${name} is too large`);
  if (parsed === 0) throw badRequest(`${name} must be a positive integer`);
  return max != null ? Math.min(parsed, max) : parsed;
}

function parseOptionalNonNegativeInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (Array.isArray(value)) throw badRequest(`${name} must be a single integer`);
  const raw = typeof value === "string" ? value.trim() : String(value);
  if (!/^\d+$/.test(raw)) throw badRequest(`${name} must be a non-negative integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw badRequest(`${name} is too large`);
  return parsed;
}

function parseOptionalUuid(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) throw badRequest(`${name} must be a single UUID`);
  const raw = typeof value === "string" ? value.trim() : String(value);
  if (!raw) return null;
  if (!isUuidLike(raw)) throw badRequest(`${name} must be a UUID`);
  return raw;
}

export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);
  const recoveryObservability = recoveryObservabilityService(db);
  const recoveryActions = issueRecoveryActionService(db);

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

    // Terminal rows are the point of this endpoint (BLO-19124): every
    // pre-existing surface is active-only by construction, so the drain rate
    // was only visible as aggregate counts and never as "which actions, whose,
    // how old". Default to no status filter so resolved/cancelled/expired rows
    // are returned unless the caller narrows.
    const statuses = parseEnumList(req.query.status, ISSUE_RECOVERY_ACTION_STATUSES, "status");
    const kind = parseEnum(req.query.kind, ISSUE_RECOVERY_ACTION_KINDS, "kind");
    const outcome = parseEnum(req.query.outcome, ISSUE_RECOVERY_ACTION_OUTCOMES, "outcome");
    const ownerAgentId = parseOptionalUuid(req.query.ownerAgentId, "ownerAgentId");
    const limit = parseOptionalPositiveInteger(req.query.limit, "limit", 50, 200);
    const offset = parseOptionalNonNegativeInteger(req.query.offset, "offset", 0);

    const filters = { companyId, kind, statuses, ownerAgentId, outcome };
    const [actions, total] = await Promise.all([
      recoveryActions.listForCompany({ ...filters, limit, offset }),
      recoveryActions.countForCompany(filters),
    ]);
    res.json({ actions, total, limit, offset });
  });

  return router;
}

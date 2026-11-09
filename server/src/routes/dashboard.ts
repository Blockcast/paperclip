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

/**
 * Every query key `/companies/:companyId/recovery-actions` understands. PEN-5708:
 * anything outside this set is a 400, not a silent drop.
 *
 * The argument is the one already written below about `order`, applied to the key
 * rather than the value. A silently-ignored filter does not return an error page
 * or an empty page — it returns a FULL UNFILTERED PAGE, which is the one response
 * shape a caller reads as "these are the matching rows". Measured on this exact
 * handler: `?sourceIssueId=<uuid>` returned 100 actions across 94 distinct source
 * issues, none of them the one requested, and nothing in the response said so.
 *
 * The breaking-change risk is bounded, and the check behind that is an AUDIT WITH A
 * DATE rather than a standing claim about the repo — audited 2026-11-06 for PEN-5708
 * and re-run 2026-11-09 for PEN-6178. On both dates the only in-repo callers of this
 * route were its own tests (`__tests__/recovery-actions-route-query-params.test.ts`)
 * and the probe documented in `services/recovery/workspace-validation-probe.ts`
 * (`limit`/`offset`/`order` only), both sending supported keys. A caller added after
 * that date makes the audit stale and nothing here re-checks it, so re-run it rather
 * than cite it. A caller that was relying on a dropped key was already getting the
 * wrong rows, so failing it loudly is a strict improvement over failing it silently.
 */
const RECOVERY_ACTION_QUERY_KEYS = new Set([
  "ownerAgentId",
  "sourceIssueId",
  "kind",
  "status",
  "limit",
  "offset",
  "order",
]);

/**
 * Read a query param that must appear at most once.
 *
 * Express parses a repeated key (`?kind=a&kind=b`) into an ARRAY, and the previous
 * `typeof value === "string" ? value : undefined` read turned that into `undefined`
 * — i.e. into no filter at all, which is the same full-unfiltered-page failure as
 * an unknown key, reached by a different route. Rejecting is the only answer that
 * cannot be mistaken for a result.
 *
 * `remedy` exists because on ONE key the refusal is only half an answer. `status` is
 * the sole param here that legitimately takes several values — the service splits it
 * on commas into an `inArray` (`recovery-observability.ts`) — so a caller reaching
 * for the repeated-key form wants something this route supports, and a message that
 * names the constraint without the working form sends them away from it. Every other
 * param is matched with `eq` and takes exactly one value, so there the generic
 * message is the whole truth and a remedy would be a lie. Keep it opt-in per call
 * site for that reason; do not promote it to a default.
 */
function readSingleStringParam(
  value: unknown,
  name: string,
  remedy?: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw badRequest(
      `Query parameter ${name} must be given at most once`
      + (remedy === undefined ? "" : `; ${remedy}`),
    );
  }
  return value;
}

function readUuidParam(value: unknown, name: string): string | undefined {
  const raw = readSingleStringParam(value, name);
  if (raw === undefined) return undefined;
  if (!UUID_REGEX.test(raw)) {
    throw badRequest(`Query parameter ${name} must be a valid UUID`);
  }
  return raw;
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
    // Unknown keys first, so a typo is reported as a typo rather than as whichever
    // supported key happened to be missing. See RECOVERY_ACTION_QUERY_KEYS.
    const unknownKeys = Object.keys(req.query).filter((key) => !RECOVERY_ACTION_QUERY_KEYS.has(key));
    if (unknownKeys.length > 0) {
      throw badRequest(
        `Unsupported query parameter(s): ${unknownKeys.sort().join(", ")}. `
        + `Supported: ${[...RECOVERY_ACTION_QUERY_KEYS].sort().join(", ")}`,
      );
    }
    const ownerAgentId = readUuidParam(req.query.ownerAgentId, "ownerAgentId");
    // PEN-5708: this is the audit filter, and the reason it matters more than a
    // missing filter usually would is that this route is the ONLY read that shows a
    // `resolved` action at all — the issue-scoped read collapses to
    // `{active: null, actions: []}` the moment an action retires, i.e. it goes blind
    // at exactly the moment you want to know how the action ended. Without this key
    // the sole audit surface could not be narrowed to the row being audited.
    const sourceIssueId = readUuidParam(req.query.sourceIssueId, "sourceIssueId");
    const kind = readSingleStringParam(req.query.kind, "kind");
    // The one filter that takes several values, so its repeated-key refusal names the
    // form that works instead of stopping at the constraint. See readSingleStringParam.
    const status = readSingleStringParam(
      req.query.status,
      "status",
      "use a comma-separated list for several values, e.g. status=resolved,cancelled",
    );
    // Routed through the same single-value read as the filters. A repeated `limit`
    // is an array, and `parsePositiveNumber` would quietly fall back to 100 — which
    // is a smaller lie than a dropped filter but still a page the caller did not ask
    // for, and this handler now has no silently-coerced inputs left.
    const limit = parsePositiveNumber(readSingleStringParam(req.query.limit, "limit"), 100, 500);
    const offset = Math.max(
      0,
      Math.floor(parsePositiveNumber(readSingleStringParam(req.query.offset, "offset"), 0)),
    );
    // Rejected rather than coerced: a silently-ignored `order=ascending` returns a
    // newest-first page that the caller reads as a census of the oldest rows.
    const orderParam = readSingleStringParam(req.query.order, "order");
    if (orderParam !== undefined && orderParam !== "asc" && orderParam !== "desc") {
      throw badRequest('Query parameter order must be "asc" or "desc"');
    }
    const order = orderParam === "asc" ? "asc" : "desc";
    const actions = await recoveryObservability.listActions(companyId, {
      ownerAgentId,
      sourceIssueId,
      kind,
      status,
      limit,
      offset,
      order,
    });
    // Echoed back for the same reason the other filters are: a caller comparing the
    // echo against what it sent can tell a filtered page from an unfiltered one
    // without counting rows.
    res.json({
      companyId,
      ownerAgentId: ownerAgentId ?? null,
      sourceIssueId: sourceIssueId ?? null,
      kind: kind ?? null,
      status: status ?? null,
      limit,
      offset,
      order,
      actions,
    });
  });

  return router;
}

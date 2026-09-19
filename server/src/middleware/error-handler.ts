import type { Request, Response, NextFunction } from "express";
import type { Db } from "@paperclipai/db";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { findPgError, TRANSIENT_DB_SQLSTATES } from "../lib/db-retry.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import { COMPANY_IMPORT_API_PATH } from "../routes/company-import-paths.js";
import { logger } from "./logger.js";
import {
  recordResponsibleUserDenialOnActiveRun,
} from "../services/responsible-user-denial-run-outcomes.js";

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

function isRedactedSkillPolicyDenial(details: Record<string, unknown> | null) {
  return details?.code === "skill_policy_denied";
}

function attachErrorContext(
  req: Request,
  res: Response,
  payload: ErrorContext["error"],
  rawError?: Error,
) {
  (res as any).__errorContext = {
    error: payload,
    method: req.method,
    url: req.originalUrl,
    reqBody: req.body,
    reqParams: req.params,
    reqQuery: req.query,
  } satisfies ErrorContext;
  if (rawError) {
    (res as any).err = rawError;
  }
}

function getPaperclipDb(req: Request): Db | null {
  const locals = req.app?.locals as { paperclipDb?: Db; db?: Db } | undefined;
  return locals?.paperclipDb ?? locals?.db ?? null;
}

function recordResponsibleUserDenialFromHttpError(
  req: Request,
  details: Record<string, unknown> | null,
) {
  if (req.actor?.type !== "agent") return;
  const db = getPaperclipDb(req);
  if (!db) return;

  void recordResponsibleUserDenialOnActiveRun(db, {
    runId: req.actor.runId ?? null,
    agentId: req.actor.agentId ?? null,
    companyId: req.actor.companyId ?? null,
    code: details?.code,
  }).catch((recordErr) => {
    logger.warn(
      {
        err: recordErr,
        runId: req.actor?.runId ?? null,
        agentId: req.actor?.type === "agent" ? req.actor.agentId ?? null : null,
      },
      "failed to record responsible-user denial on heartbeat run",
    );
  });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    const details = err.details && typeof err.details === "object" && !Array.isArray(err.details)
      ? err.details as Record<string, unknown>
      : null;
    const redactedSkillPolicyDenial = isRedactedSkillPolicyDenial(details);
    recordResponsibleUserDenialFromHttpError(req, details);
    if (err.status >= 500) {
      attachErrorContext(
        req,
        res,
        { message: err.message, stack: err.stack, name: err.name, details: err.details },
        err,
      );
      const tc = getTelemetryClient();
      if (tc) trackErrorHandlerCrash(tc, { errorCode: err.name });
    }
    if (
      err.status === 422 &&
      err.message === "missing-evidence" &&
      typeof err.details === "object" &&
      err.details !== null &&
      Array.isArray((err.details as { missing?: unknown }).missing)
    ) {
      res.status(422).json({
        error: "missing-evidence",
        missing: (err.details as { missing: unknown[] }).missing,
        // PEN-3255 (#1895 review): this branch answers with a deliberately
        // narrow body and never emits `details`, so the dropped-comment
        // announcement the issues route attaches there — see the `catch`
        // around `svc.update` in `routes/issues.ts` — was built and then
        // thrown away before the caller saw it. That left the silent drop
        // alive on what is plausibly the most-travelled refusal on that route:
        // the documented agent loop is "attach evidence, then move to
        // `in_review`", and bundling the explanation into that same PATCH is
        // the normal shape, so `PATCH { status: "in_review", comment: "…" }`
        // refused by the evidence gate is exactly the request that loses a
        // note. `services/issues.ts` is the only producer of this error and it
        // always writes the two keys together, so they are carried as one
        // announcement rather than independently. Everything else about the
        // `{error, missing}` contract agents read is unchanged, and a refusal
        // that carried no comment still gets neither key.
        ...(details?.commentPersisted === false
          ? { commentPersisted: false, commentHint: details.commentHint }
          : {}),
      });
      return;
    }
    res.status(err.status).json({
      error: err.message,
      ...(typeof details?.code === "string" ? { code: details.code } : {}),
      ...(redactedSkillPolicyDenial && typeof details?.reason === "string" ? { reason: details.reason } : {}),
      ...(typeof details?.remediation === "string" ? { remediation: details.remediation } : {}),
      ...(!redactedSkillPolicyDenial && err.details ? { details: err.details } : {}),
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation error", details: err.errors });
    return;
  }

  const rootError = err instanceof Error ? err : new Error(String(err));
  attachErrorContext(
    req,
    res,
    err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name }
      : { message: String(err), raw: err, stack: rootError.stack, name: rootError.name },
    rootError,
  );

  const tc = getTelemetryClient();
  if (tc) trackErrorHandlerCrash(tc, { errorCode: rootError.name });

  // BLO-33733: a transient PostgreSQL conflict is not a broken server. Reported
  // as a bare 500 it is indistinguishable from a permanent fault, so callers
  // either retry a genuinely broken request forever or abandon a recoverable one.
  //
  // The live instance: PATCH /issues/:id with `blockedByIssueIds` takes a
  // company-scoped advisory lock (`paperclip:issue-parent:<companyId>`) that a
  // status-only patch never takes, so under graph contention that one field
  // 500s while every other field on the same row succeeds.
  //
  // Scope of the claim, deliberately narrow: db-retry.ts's rollback guarantee is
  // per-statement ("a single autocommit UPDATE"), and its contract requires
  // rollback-guaranteed AND idempotent. This boundary is shared by every route
  // and can prove neither for the request as a whole — a handler may have
  // already committed earlier statements. `POST /issues/:id/comments` is the
  // worked case: `svc.addComment` "does not open its own transaction", so the
  // comment INSERT autocommits, and `syncComment` / `svc.update` / `logActivity`
  // run after it. A transient failure in any of those rolls back only itself,
  // and `idempotencyKey` is optional on that route — so a caller told the write
  // "did not apply" would post a duplicate comment on replay. Report the
  // classification, which is provable; leave replay safety to the caller.
  const pgError = findPgError(err);
  if (pgError && TRANSIENT_DB_SQLSTATES.has(pgError.code)) {
    res.status(503).json({
      error:
        "Database contention: the failing statement was rolled back. " +
        "Earlier statements in this request may have applied — replay only if it is idempotent.",
      code: "transient_db_conflict",
      details: { sqlstate: pgError.code },
    });
    return;
  }

  res.status(500).json({
    error: "Internal server error",
    ...(shouldExposeTrustedCloudTenantImportError(req) ? { message: rootError.message } : {}),
  });
}

function shouldExposeTrustedCloudTenantImportError(req: Request) {
  return req.actor?.source === "cloud_tenant"
    && req.method === "POST"
    && req.originalUrl.split("?")[0] === COMPANY_IMPORT_API_PATH;
}

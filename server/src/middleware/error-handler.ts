import type { Request, Response, NextFunction } from "express";
import type { Db } from "@paperclipai/db";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { findPgError, STATEMENT_TIMEOUT_SQLSTATE, TRANSIENT_DB_SQLSTATES } from "../lib/db-retry.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import { COMPANY_IMPORT_API_PATH } from "../routes/company-import-paths.js";
import { logger } from "./logger.js";
import { noteTransientDbResponse } from "./http-metrics.js";
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

/**
 * PEN-5244: what this boundary can and cannot say about the REQUEST.
 *
 * It can speak for one statement: the SQLSTATEs routed here are
 * rollback-guaranteed per statement, so the statement that failed applied
 * nothing. It cannot speak for the request, and the wording it replaces did —
 * "the failing statement was rolled back" led, and callers read it as "my write
 * did not land". Measured 4/4 wrong in that direction (PEN-5244, 2026-11-02),
 * including on the `POST /companies/:id/issues` that filed the row.
 *
 * The mechanism is in this repo, not inferred: `svc.addComment` "does not open
 * its own transaction", so on `POST /issues/:id/comments` the comment INSERT
 * autocommits and `markCommentIdempotencyProcessed` / `syncComment` /
 * `logActivity` each run as separate statements AFTER it. A transient failure
 * in any of those rolls back only itself and arrives here — comment committed,
 * caller told about a rollback.
 *
 * So the advice has to be read-back-then-replay, and it has to name
 * `idempotencyKey`: the two commonest writes behind this response
 * (`paperclipAddComment`, `paperclipCreateIssue`) are not idempotent without
 * one, which makes an unqualified "replay only if it is idempotent" an
 * instruction to double-post.
 */
const REQUEST_OUTCOME_UNKNOWN_ADVICE =
  "This response does NOT establish that your write did not land: it reports one failed "
  + "statement, not the request, and earlier statements in this request may already have "
  + "COMMITTED. Read the resource back before replaying, and replay only with an "
  + "`idempotencyKey` or an otherwise idempotent request.";

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
        // note. Everything else about the `{error, missing}` contract agents
        // read is unchanged, and a refusal that carried no comment still gets
        // neither key.
        //
        // `commentHint` is type-guarded like every sibling spread below, since
        // `details` is a bare `Record<string, unknown>`; `commentPersisted` is
        // deliberately *not* conditioned on it. The two are independent on
        // purpose: `commentPersisted: false` is the announcement, and the hint
        // is a convenience. Gating the pair together would mean a producer that
        // someday omits or mistypes the hint silently deletes the announcement
        // as well — reintroducing precisely the silent drop this branch exists
        // to close, in the one place nobody would look for it.
        ...(details?.commentPersisted === false
          ? {
              commentPersisted: false,
              ...(typeof details.commentHint === "string" ? { commentHint: details.commentHint } : {}),
            }
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
    res.status(400).json({ error: "Validation error", details: err.issues });
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
  //
  // PEN-3596: `57014` is NOT one of the contention states and must not be
  // reported as such. It is `query_canceled` — the statement ran longer than
  // the role's `statement_timeout` (30s, applied 2026-05-13) and the server
  // cancelled it. Reported as "Database contention" it hides the only
  // actionable fact: the query is too expensive for the bound. The three
  // genuine contention states (40P01 deadlock, 40001 serialization failure,
  // 55P03 lock_timeout) keep their own leading sentence and code.
  //
  // PEN-5244: that split used to carry a second sentence — "This is query cost,
  // not lock contention — nothing was waiting on a lock." — which is an
  // over-claim and is removed. `57014` reports that the time bound was
  // exceeded; it does not report what the time was spent on, and a statement
  // CAN spend its whole budget blocked on a lock and then be cancelled by
  // `statement_timeout`. The wording asserted the negative unconditionally, for
  // every 57014 on every route, so it sent readers away from a lock that was
  // in fact there: on the one class-D event traced end to end (PEN-5019,
  // 2026-11-05 04:23:34Z) the request's post-commit
  // `update issue_comments set idempotency_processed_at` was killed TWICE by a
  // lock timeout before its third attempt won.
  //
  // Retry classification is deliberately untouched — `TRANSIENT_DB_SQLSTATES`
  // still carries 57014 for db-retry.ts, because a statement cancelled under a
  // transient load spike can succeed on replay. This splits only what the
  // caller is *told*.
  const pgError = findPgError(err);
  if (pgError && TRANSIENT_DB_SQLSTATES.has(pgError.code)) {
    const isStatementTimeout = pgError.code === STATEMENT_TIMEOUT_SQLSTATE;
    const transientDbCode = isStatementTimeout ? "statement_timeout" : "transient_db_conflict";
    // PEN-3596: the `details.sqlstate` below tells a single caller what
    // happened to its own request; this makes the same fact aggregatable.
    // `paperclip_http_requests_total` carries no sqlstate dimension, so a 503
    // on a route is only a PROXY for 57014 -- the three contention states land
    // in the same bucket. Measured 2026-10-29, that left this row's "no
    // statement timeouts over a representative window" condition readable only
    // as an upper bound (79/24h on the issues-list route). Tag rather than
    // increment: see `noteTransientDbResponse`.
    noteTransientDbResponse(res, { code: transientDbCode, sqlstate: pgError.code });
    res.status(503).json({
      error: (isStatementTimeout
        ? "Database statement timeout: the statement exceeded the server statement_timeout "
          + "and was cancelled, so that statement applied nothing. 57014 reports only that the "
          + "time bound was exceeded — it does not report what the time was spent on, so it is "
          + "not evidence that no lock was involved. "
        : "Database contention: the failing statement was cancelled and applied nothing. ")
        + REQUEST_OUTCOME_UNKNOWN_ADVICE,
      code: transientDbCode,
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

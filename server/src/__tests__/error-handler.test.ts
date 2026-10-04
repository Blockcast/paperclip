import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { TRANSIENT_DB_SQLSTATES } from "../lib/db-retry.js";
import { errorHandler } from "../middleware/error-handler.js";

const recordResponsibleUserDenialOnActiveRunMock = vi.hoisted(() => vi.fn());

vi.mock("../services/responsible-user-denial-run-outcomes.js", () => ({
  recordResponsibleUserDenialOnActiveRun: recordResponsibleUserDenialOnActiveRunMock,
}));

function makeReq(): Request {
  return {
    method: "GET",
    originalUrl: "/api/test",
    body: { a: 1 },
    params: { id: "123" },
    query: { q: "x" },
  } as unknown as Request;
}

function makeRes(): Response {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;
  (res.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe("errorHandler", () => {
  beforeEach(() => {
    recordResponsibleUserDenialOnActiveRunMock.mockReset();
    recordResponsibleUserDenialOnActiveRunMock.mockResolvedValue(null);
  });

  it("attaches the original Error to res.err for 500s", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error("boom");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("boom");
  });

  it("exposes raw 500 messages for trusted Cloud tenant imports", () => {
    const req = {
      ...makeReq(),
      method: "POST",
      originalUrl: "/api/companies/import",
      actor: {
        type: "board",
        userId: "cloud-user",
        source: "cloud_tenant",
      },
    } as unknown as Request;
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error("portable file references missing upload id");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: "Internal server error",
      message: "portable file references missing upload id",
    });
    expect(res.err).toBe(err);
  });

  it("attaches HttpError instances for 500 responses", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(500, "db exploded");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "db exploded" });
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("db exploded");
  });

  it("records responsible-user denial codes on the active agent run", () => {
    const db = { marker: "db" };
    const req = {
      ...makeReq(),
      app: { locals: { paperclipDb: db } },
      actor: {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        runId: "run-1",
        source: "agent_jwt",
      },
    } as unknown as Request;
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(403, "Responsible user is not authorized", {
      code: "RESPONSIBLE_USER_UNAUTHORIZED",
    });

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Responsible user is not authorized",
      code: "RESPONSIBLE_USER_UNAUTHORIZED",
      details: { code: "RESPONSIBLE_USER_UNAUTHORIZED" },
    });
    expect(recordResponsibleUserDenialOnActiveRunMock).toHaveBeenCalledWith(db, {
      runId: "run-1",
      agentId: "agent-1",
      companyId: "company-1",
      code: "RESPONSIBLE_USER_UNAUTHORIZED",
    });
  });

  // BLO-33733: PATCH /issues/:id {blockedByIssueIds} waits on a company-scoped
  // advisory lock; under contention that wait is cancelled with 55P03 and used
  // to surface as a bare 500, indistinguishable from a permanent fault.
  describe("transient database conflicts", () => {
    const TRANSIENT_BODY = {
      error:
        "Database contention: the failing statement was rolled back. " +
        "Earlier statements in this request may have applied — replay only if it is idempotent.",
      code: "transient_db_conflict",
    };

    it("reports every transient SQLSTATE as a typed 503", () => {
      for (const code of TRANSIENT_DB_SQLSTATES) {
        const res = makeRes() as any;
        errorHandler(
          Object.assign(new Error(`pg error ${code}`), { code }),
          makeReq(),
          res,
          vi.fn() as unknown as NextFunction,
        );

        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith({
          ...TRANSIENT_BODY,
          details: { sqlstate: code },
        });
      }
    });

    it("unwraps the drizzle wrapper the lock timeout actually arrives in", () => {
      // Production shape: drizzle throws "Failed query", the SQLSTATE is on .cause.
      const err = Object.assign(
        new Error("Failed query: select pg_advisory_xact_lock(hashtextextended($1, 0))"),
        { cause: Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }) },
      );
      const res = makeRes() as any;

      errorHandler(err, makeReq(), res, vi.fn() as unknown as NextFunction);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json.mock.calls[0][0]).toMatchObject({
        code: "transient_db_conflict",
        details: { sqlstate: "55P03" },
      });
    });

    // This boundary is shared by every route, so it cannot prove the *request*
    // is replay-safe even though the failing *statement* rolled back.
    // `POST /issues/:id/comments` is the worked counterexample: `svc.addComment`
    // "does not open its own transaction", so the comment INSERT autocommits and
    // `syncComment` / `svc.update` / `logActivity` run after it. A transient
    // failure in any of those leaves the comment committed, and `idempotencyKey`
    // is optional on that route — so advertising `retryable` here would tell a
    // caller to post a duplicate comment.
    it("does not advertise retryability on a non-idempotent route", () => {
      const res = makeRes() as any;
      errorHandler(
        Object.assign(new Error("deadlock detected"), { code: "40P01" }),
        { ...makeReq(), method: "POST", originalUrl: "/api/issues/123/comments" } as any,
        res,
        vi.fn() as unknown as NextFunction,
      );

      expect(res.status).toHaveBeenCalledWith(503);
      const body = res.json.mock.calls[0][0];
      expect(body).not.toHaveProperty("retryable");
      // The classification is still there — that is the part this fix delivers.
      expect(body.code).toBe("transient_db_conflict");
      expect(body.details).toEqual({ sqlstate: "40P01" });
    });

    it("finds the SQLSTATE behind a deeper, non-Error cause chain", () => {
      // findPgError walks `.cause` 6 deep and the links need not be Errors.
      const res = makeRes() as any;
      errorHandler(
        { cause: { cause: { code: "57014", message: "canceling statement due to statement timeout" } } },
        makeReq(),
        res,
        vi.fn() as unknown as NextFunction,
      );

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json.mock.calls[0][0].details).toEqual({ sqlstate: "57014" });
    });

    it("still reports a non-transient database error as a bare 500", () => {
      const res = makeRes() as any;
      errorHandler(
        Object.assign(new Error("duplicate key"), { code: "23505" }), // unique_violation
        makeReq(),
        res,
        vi.fn() as unknown as NextFunction,
      );

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    });
  });

  // PEN-3255 (#1895 review, third round). The route-level coverage of this
  // short-circuit lives in `issue-blocked-patch-comment-drop.test.ts`, driven
  // through a real PATCH. These are here instead of there because they pin the
  // handler's contract against shapes the route's sole producer cannot emit —
  // a malformed `commentHint` — so there is no way to stage them end-to-end.
  describe("missing-evidence dropped-comment announcement", () => {
    function refuse(details: unknown) {
      const res = makeRes() as any;
      errorHandler(
        new HttpError(422, "missing-evidence", details),
        makeReq(),
        res,
        vi.fn() as unknown as NextFunction,
      );
      expect(res.status).toHaveBeenCalledWith(422);
      return res.json.mock.calls[0][0];
    }

    it("carries the announcement through the narrow body, which emits no `details`", () => {
      const body = refuse({
        code: "missing-evidence",
        missing: ["screenshot:1440x900"],
        commentPersisted: false,
        commentHint: "Post it with POST /api/issues/:id/comments instead.",
      });

      expect(body.error).toBe("missing-evidence");
      expect(body.missing).toEqual(["screenshot:1440x900"]);
      // The narrow contract this branch exists to serve is intact.
      expect(body).not.toHaveProperty("details");

      expect(body.commentPersisted).toBe(false);
      expect(body.commentHint).toContain("POST /api/issues/:id/comments");
    });

    it("drops a non-string `commentHint` but still announces the drop", () => {
      // The asymmetry is the point, and it is why this is not the reviewer's
      // literal one-clause suggestion: gating the pair together would let a
      // malformed hint delete the announcement too, which is the silent drop
      // this branch was added to close. Guard the convenience, never the
      // announcement.
      const body = refuse({
        missing: ["screenshot:1440x900"],
        commentPersisted: false,
        commentHint: { href: "/api/issues/:id/comments" },
      });

      expect(
        body.commentPersisted,
        `a malformed hint must not suppress the announcement; got ${JSON.stringify(body)}`,
      ).toBe(false);
      expect(body).not.toHaveProperty("commentHint");
    });

    it("says nothing about comments when the refusal carried none", () => {
      const body = refuse({ missing: ["screenshot:1440x900"] });

      expect(body).toEqual({ error: "missing-evidence", missing: ["screenshot:1440x900"] });
    });
  });
});

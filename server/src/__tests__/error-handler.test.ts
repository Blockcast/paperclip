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
    it("reports every transient SQLSTATE as a typed, retryable 503", () => {
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
          error: "Database contention: the write was rolled back and did not apply. Retry.",
          code: "transient_db_conflict",
          retryable: true,
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
        retryable: true,
        details: { sqlstate: "55P03" },
      });
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
});

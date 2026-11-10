import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression suite for PEN-6425.
 *
 * `GET /companies/:companyId/approvals` declared neither `limit` nor `offset`,
 * and `z.object()` STRIPS an undeclared key instead of rejecting it — so
 * `?limit=3` was dropped unread and the route answered with the whole corpus
 * (measured first-party 2026-11-10: 1082 rows for `limit=3`, `limit=1`,
 * `offset=1081` and `offset=99999` alike, byte-identical first and last ids).
 * The query string WAS parsed — `status=pending` cut the same batch to 60 — so
 * this was `limit`/`offset` specifically being dropped, not an unread query.
 *
 * Same shape as BLO-24495/BLO-40145 one route over, and worse: there `limit`
 * binds and only clamps, here it bound at no value at all.
 *
 * The arms below are deliberately split so that each mechanism has its own
 * failing assertion:
 *   - delete the `{ limit, offset }` argument at either `svc` call site -> the
 *     "threads the window" arms red, and nothing else does;
 *   - delete the `view=count` guard -> only the count arms red;
 *   - delete the `parseUnsupportedPaginationParams` block -> only the
 *     page/perPage/per_page arms red;
 *   - drop `limit`/`offset` from `listApprovalsQuerySchema` -> the threading
 *     arms red (the values arrive as `undefined`), which is the original defect.
 */

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  listSummary: vi.fn(),
  countBy: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  createWithIdempotency: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(async () => ({ allowed: true })),
}));

const mockIssueService = vi.hoisted(() => ({ getById: vi.fn(async () => null) }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
  linkCoverageForIssue: vi.fn(async () => ({ potentiallyUnlinkedCards: false })),
}));
const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => mockIssueService,
    logActivity: vi.fn(),
    secretService: () => mockSecretService,
  }));
}

async function createApp() {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const LIST_URL = "/api/companies/company-1/approvals";

describe("GET /companies/:companyId/approvals pagination (PEN-6425)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true } as any);
    mockApprovalService.list.mockResolvedValue([]);
    mockApprovalService.listSummary.mockResolvedValue([]);
    mockApprovalService.countBy.mockResolvedValue(7);
    registerModuleMocks();
  });

  it("threads limit and offset into the summary view", async () => {
    const res = await request(await createApp()).get(`${LIST_URL}?view=summary&limit=3&offset=10`);

    expect(res.status).toBe(200);
    expect(mockApprovalService.listSummary).toHaveBeenCalledWith(
      "company-1",
      expect.anything(),
      { limit: 3, offset: 10 },
    );
  });

  it("threads limit into the default full view", async () => {
    const res = await request(await createApp()).get(`${LIST_URL}?limit=2`);

    expect(res.status).toBe(200);
    expect(mockApprovalService.list).toHaveBeenCalledWith(
      "company-1",
      expect.anything(),
      { limit: 2, offset: undefined },
    );
  });

  /**
   * The compatibility arm, and the reason this change needs no truncation
   * marker: a caller that passes nothing still gets every matching row, so a
   * short array is only ever a window the caller asked for. A default cap would
   * hand back a silent PREFIX, which is PEN-4766's under-reporting direction.
   */
  it("applies no window when the caller asks for none", async () => {
    const res = await request(await createApp()).get(`${LIST_URL}?view=summary&status=pending`);

    expect(res.status).toBe(200);
    expect(mockApprovalService.listSummary).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ status: "pending" }),
      { limit: undefined, offset: undefined },
    );
  });

  it.each([
    ["limit", `${LIST_URL}?view=count&limit=3`, ["limit"]],
    ["offset", `${LIST_URL}?view=count&offset=3`, ["offset"]],
    ["both", `${LIST_URL}?view=count&limit=3&offset=3`, ["limit", "offset"]],
  ])("rejects %s with view=count rather than ignoring it", async (_name, url, expected) => {
    const res = await request(await createApp()).get(url);

    expect(res.status).toBe(400);
    expect(res.body.unsupportedParams).toEqual(expected);
    expect(mockApprovalService.countBy).not.toHaveBeenCalled();
  });

  it("still answers view=count when no window is asked for", async () => {
    const res = await request(await createApp()).get(`${LIST_URL}?view=count`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 7 });
  });

  it.each([
    ["page", `${LIST_URL}?page=2`, ["page"]],
    ["perPage", `${LIST_URL}?perPage=50`, ["perPage"]],
    ["per_page", `${LIST_URL}?per_page=50`, ["per_page"]],
  ])("rejects unimplemented %s pagination with 400", async (_name, url, expected) => {
    const res = await request(await createApp()).get(url);

    expect(res.status).toBe(400);
    expect(res.body.unsupportedParams).toEqual(expected);
    expect(mockApprovalService.list).not.toHaveBeenCalled();
    expect(mockApprovalService.listSummary).not.toHaveBeenCalled();
  });

  it.each(["limit=0", "limit=abc", "limit=-1", "limit=", "offset=-1", "offset=abc"])(
    "rejects an unusable %s with 400 instead of serving an unbounded corpus",
    async (query) => {
      const res = await request(await createApp()).get(`${LIST_URL}?view=summary&${query}`);

      expect(res.status).toBe(400);
      expect(mockApprovalService.listSummary).not.toHaveBeenCalled();
    },
  );

  /**
   * A digit string past `Number.MAX_SAFE_INTEGER` is an integer to
   * `Number.isInteger` but cannot be represented exactly, so it would reach
   * Postgres as a different number than the caller wrote. Same reasoning as
   * `parseOffsetParam` on the issue-list surface.
   */
  it("rejects a limit that cannot be represented exactly", async () => {
    const res = await request(await createApp()).get(`${LIST_URL}?view=summary&limit=99999999999999999999`);

    expect(res.status).toBe(400);
    expect(mockApprovalService.listSummary).not.toHaveBeenCalled();
  });
});

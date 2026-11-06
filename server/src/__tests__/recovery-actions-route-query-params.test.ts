import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PEN-5708. `GET /companies/:companyId/recovery-actions` read exactly six query
 * params and silently ignored everything else, which on a LIST endpoint is the
 * worst available failure: a dropped filter does not return an error and does not
 * return an empty page — it returns a FULL UNFILTERED PAGE, the one response shape
 * a caller reads as "these are the matching rows". Measured live before the fix,
 * `?sourceIssueId=<uuid>` returned 100 actions across 94 distinct source issues,
 * none of them the one requested.
 *
 * These cases are at the ROUTE layer on purpose. The service-level filter is
 * covered in `recovery-observability.test.ts`; what is covered here is the
 * handler's contract — which keys reach the service, and which are refused before
 * they can be mistaken for a result.
 */

const mockRecoveryObservability = vi.hoisted(() => ({
  listActions: vi.fn(),
  report: vi.fn(),
}));

const mockDashboardService = vi.hoisted(() => ({
  summary: vi.fn(),
  agentScorecards: vi.fn(),
}));

vi.mock("../services/recovery-observability.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/recovery-observability.js")>();
  return {
    ...actual,
    recoveryObservabilityService: () => mockRecoveryObservability,
  };
});

vi.mock("../services/dashboard.js", () => ({
  dashboardService: () => mockDashboardService,
}));

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

async function createApp() {
  const [{ errorHandler }, { dashboardRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/dashboard.js") as Promise<typeof import("../routes/dashboard.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: [COMPANY_ID],
      source: "session",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", dashboardRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("GET /companies/:companyId/recovery-actions query params", () => {
  beforeEach(() => {
    mockRecoveryObservability.listActions.mockReset();
    mockRecoveryObservability.listActions.mockResolvedValue([]);
  });

  it("passes sourceIssueId through to the service and echoes it back", async () => {
    const app = await createApp();
    const sourceIssueId = randomUUID();

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/recovery-actions`)
      .query({ sourceIssueId, status: "resolved" });

    expect(res.status).toBe(200);
    expect(mockRecoveryObservability.listActions).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({ sourceIssueId, status: "resolved" }),
    );
    // Echoed so a caller can tell a filtered page from an unfiltered one without
    // counting rows — the check that was impossible while the key was dropped.
    expect(res.body.sourceIssueId).toBe(sourceIssueId);
  });

  it("rejects a malformed sourceIssueId instead of dropping it", async () => {
    const app = await createApp();

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/recovery-actions`)
      .query({ sourceIssueId: "PEN-5708" });

    expect(res.status).toBe(400);
    expect(res.body.error ?? res.body.message).toMatch(/sourceIssueId/);
    // The point of a 400 here: the service is never reached, so there is no page to
    // misread. Matching the `ownerAgentId` arm, not the silent-drop default.
    expect(mockRecoveryObservability.listActions).not.toHaveBeenCalled();
  });

  it("rejects an unknown query parameter rather than ignoring it", async () => {
    const app = await createApp();

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/recovery-actions`)
      .query({ sourceIssue: randomUUID() });

    expect(res.status).toBe(400);
    const message = String(res.body.error ?? res.body.message ?? "");
    // Names the offending key AND the supported set, so a near-miss spelling is
    // self-correcting from the response alone.
    expect(message).toContain("sourceIssue");
    expect(message).toContain("sourceIssueId");
    expect(mockRecoveryObservability.listActions).not.toHaveBeenCalled();
  });

  it("rejects a repeated filter instead of silently returning every row", async () => {
    // Express parses a repeated key into an ARRAY, which the old
    // `typeof value === "string"` read turned into `undefined` — i.e. into no
    // filter. Same full-unfiltered-page failure as an unknown key, reached by a
    // different route, and invisible in exactly the same way.
    const app = await createApp();

    const res = await request(app).get(
      `/api/companies/${COMPANY_ID}/recovery-actions?kind=a&kind=b`,
    );

    expect(res.status).toBe(400);
    expect(String(res.body.error ?? res.body.message ?? "")).toMatch(/kind/);
    expect(mockRecoveryObservability.listActions).not.toHaveBeenCalled();
  });

  it("still accepts every supported key together", async () => {
    const app = await createApp();
    const ownerAgentId = randomUUID();
    const sourceIssueId = randomUUID();

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/recovery-actions`)
      .query({
        ownerAgentId,
        sourceIssueId,
        kind: "stranded_assigned_issue",
        status: "resolved,cancelled",
        limit: "25",
        offset: "50",
        order: "asc",
      });

    expect(res.status).toBe(200);
    expect(mockRecoveryObservability.listActions).toHaveBeenCalledWith(COMPANY_ID, {
      ownerAgentId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      status: "resolved,cancelled",
      limit: 25,
      offset: 50,
      order: "asc",
    });
  });
});

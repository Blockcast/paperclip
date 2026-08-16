import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDashboardService = vi.hoisted(() => ({
  summary: vi.fn(),
  agentScorecards: vi.fn(),
}));

const mockRecoveryObservability = vi.hoisted(() => ({
  report: vi.fn(),
}));

const mockRecoveryActions = vi.hoisted(() => ({
  listForCompany: vi.fn(),
  countForCompany: vi.fn(),
}));

vi.mock("../services/dashboard.js", () => ({
  dashboardService: () => mockDashboardService,
}));

vi.mock("../services/recovery-observability.js", () => ({
  DEFAULT_RECOVERY_RATE_THRESHOLD_PERCENT: 85,
  MAX_WINDOW_WEEKS: 52,
  recoveryObservabilityService: () => mockRecoveryObservability,
}));

vi.mock("../services/issue-recovery-actions.js", () => ({
  issueRecoveryActionService: () => mockRecoveryActions,
}));

import { dashboardRoutes } from "../routes/dashboard.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const ownerAgentId = "22222222-2222-4222-8222-222222222222";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      companyIds: [companyId],
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", dashboardRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("dashboard recovery action routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecoveryActions.listForCompany.mockResolvedValue([]);
    mockRecoveryActions.countForCompany.mockResolvedValue(0);
  });

  it("integer-validates and caps list pagination before querying recovery actions", async () => {
    const res = await request(createApp())
      .get(`/api/companies/${companyId}/recovery-actions`)
      .query({ ownerAgentId, limit: "250", offset: "15" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ actions: [], total: 0, limit: 200, offset: 15 });
    expect(mockRecoveryActions.listForCompany).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId,
        ownerAgentId,
        limit: 200,
        offset: 15,
      }),
    );
    expect(mockRecoveryActions.countForCompany).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, ownerAgentId }),
    );
  });

  it.each([
    ["float limit", { limit: "1.5" }],
    ["zero limit", { limit: "0" }],
    ["float offset", { offset: "1.5" }],
    ["scientific offset", { offset: "1e21" }],
    ["malformed ownerAgentId", { ownerAgentId: "cto-agent" }],
    // Dropping an unrecognised status would silently widen the result set to
    // the whole company history, so an operator sizing a live backlog would
    // count resolved/expired rows as active.
    ["wrong-case status", { status: "Active" }],
    ["unknown status", { status: "active,bogus" }],
    // Same hazard, and it used to read the other way: `kind` and `outcome` were
    // parsed leniently, so an unrecognised value dropped the filter instead of
    // rejecting it. `?outcome=Expired` then returned every outcome — a WIDER
    // result set than asked for, presented as the expired backlog.
    ["wrong-case outcome", { outcome: "Expired" }],
    ["unknown outcome", { outcome: "bogus" }],
    ["wrong-case kind", { kind: "Stranded_assigned_issue" }],
    ["unknown kind", { kind: "bogus_kind" }],
    ["repeated kind", { kind: ["stranded_assigned_issue", "workspace_validation"] }],
  ])("returns 400 for %s", async (_name, query) => {
    const res = await request(createApp())
      .get(`/api/companies/${companyId}/recovery-actions`)
      .query(query);

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(mockRecoveryActions.listForCompany).not.toHaveBeenCalled();
    expect(mockRecoveryActions.countForCompany).not.toHaveBeenCalled();
  });

  it("honours well-formed kind and outcome filters", async () => {
    const res = await request(createApp())
      .get(`/api/companies/${companyId}/recovery-actions`)
      .query({ kind: "stranded_assigned_issue", outcome: "expired" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockRecoveryActions.listForCompany).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "stranded_assigned_issue", outcome: "expired" }),
    );
  });

  it("treats an omitted or empty kind as no filter rather than a rejection", async () => {
    const res = await request(createApp())
      .get(`/api/companies/${companyId}/recovery-actions`)
      .query({ kind: "" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockRecoveryActions.listForCompany).toHaveBeenCalledWith(
      expect.objectContaining({ kind: null, outcome: null }),
    );
  });

  it("honours a well-formed status filter", async () => {
    const res = await request(createApp())
      .get(`/api/companies/${companyId}/recovery-actions`)
      .query({ status: "resolved,cancelled" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockRecoveryActions.listForCompany).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ["resolved", "cancelled"] }),
    );
  });
});

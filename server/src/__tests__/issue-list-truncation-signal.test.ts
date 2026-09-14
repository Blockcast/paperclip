import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISSUE_LIST_APPLIED_LIMIT_HEADER,
  ISSUE_LIST_TRUNCATED_HEADER,
  issueListProbeLimit,
  resolveIssueListTruncation,
} from "../lib/issue-list-query.ts";
import { ISSUE_LIST_MAX_LIMIT } from "../services/issues.ts";

/**
 * Regression test for BLO-33741.
 *
 * Both issue-list surfaces applied a hard server cap and returned the
 * truncated set with no indication that truncation had occurred. A caller
 * asking for more than the cap got exactly the cap back and could not
 * distinguish "that is all of them" from "there are more" — silent, and wrong
 * in the reassuring direction: a sweep reports the cap as the population.
 *
 * Both boundaries are asserted on BOTH surfaces, so a one-surface fix fails
 * this suite:
 *
 *   - cap + 1 rows available -> exactly `cap` rows AND the signal present,
 *     carrying the applied cap;
 *   - cap - 1 rows available -> all rows AND the signal absent.
 *
 * The REST half drives the real route module rather than a stub app, so the
 * over-fetch probe, the pre-ACL truncation split, and the header emission are
 * all exercised as shipped. The MCP half drives the real
 * `applyIssueListTruncationEnvelope` that `paperclipListIssues` calls, fed the
 * headers the REST half actually produced — the two surfaces are joined by the
 * wire contract, not by a copy of it.
 */

const CAP = 50;

const mockIssueService = vi.hoisted(() => ({ list: vi.fn() }));
// Shared so a test can vary the verdict per action/row: the truncation signal
// has to be correct for a restricted actor too, and an always-allow stub can
// never exercise that path.
const mockAccess = vi.hoisted(() => ({ decide: vi.fn() }));

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    accessService: () => ({
      canUser: vi.fn(),
      decide: mockAccess.decide,
      hasPermission: vi.fn(),
    }),
    agentService: () => ({ getById: vi.fn() }),
    companyService: () => ({ getById: vi.fn(), getSettings: vi.fn(async () => ({})) }),
    issueService: () => mockIssueService,
    issueRecoveryActionService: () => ({ listActiveForIssues: vi.fn(async () => new Map()) }),
    documentService: () => ({ getIssueDocumentPayload: vi.fn(async () => ({})) }),
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({ getById: vi.fn(), listByIds: vi.fn(async () => []) }),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
  };
});

function seedIssues(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `issue-${index}`,
    companyId: "company-1",
    projectId: null,
    title: `Seeded issue ${index}`,
    description: null,
    status: "backlog",
    priority: "medium",
    createdAt: new Date("2026-09-13T00:00:00.000Z"),
    updatedAt: new Date("2026-09-13T00:00:00.000Z"),
    lastActivityAt: new Date("2026-09-13T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    activeRun: null,
  }));
}

/**
 * Stand in for the database: honour whatever limit the route asks for. The
 * route must over-fetch for truncation to be detectable at all, so a mock that
 * ignored `limit` (as the pre-BLO-33741 fixtures did) would make this suite
 * pass against a broken route.
 */
function serveFromPopulation(population: number) {
  mockIssueService.list.mockImplementation(async (_companyId: string, filters?: { limit?: number }) => {
    const limit = filters?.limit ?? population;
    return seedIssues(Math.min(population, limit));
  });
}

async function buildApp() {
  const { issueRoutes } = await import("../routes/issues.js");
  const { errorHandler } = await import("../middleware/index.js");
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ orderBy: vi.fn(async () => []) })),
      })),
    })),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    };
    next();
  });
  app.use("/api", issueRoutes(db as never, {} as never));
  app.use(errorHandler);
  return app;
}

/**
 * Company-scope reader: sees every row, never hits `filterIssuesForActor`.
 */
function allowEverything() {
  mockAccess.decide.mockImplementation(async ({ action }: { action: string }) => ({
    allowed: true,
    action,
    reason: "allow_company_agent",
    explanation: "Allowed by test.",
  }));
}

/**
 * A restricted actor: denied company scope, so the route falls through to
 * per-row `issue:read` filtering, and may read only `readableIds`.
 */
function allowOnlyIssues(readableIds: string[]) {
  const readable = new Set(readableIds);
  mockAccess.decide.mockImplementation(
    async ({ action, resource }: { action: string; resource?: { issueId?: string } }) => ({
      allowed: action === "company_scope:read" ? false : readable.has(resource?.issueId ?? ""),
      action,
      reason: "test",
      explanation: "Allowed by test.",
    }),
  );
}

describe("BLO-33741 issue-list truncation signal", () => {
  beforeEach(() => {
    mockIssueService.list.mockReset();
    mockAccess.decide.mockReset();
    allowEverything();
  });

  describe("the over-fetch probe itself", () => {
    it("asks for one row beyond the page so a full page is distinguishable from a capped one", () => {
      expect(issueListProbeLimit(CAP)).toBe(CAP + 1);
    });

    it("reports truncation and trims to the page when the probe row comes back", () => {
      const probed = seedIssues(CAP + 1);
      const { rows, truncated } = resolveIssueListTruncation(probed, CAP);
      expect(truncated).toBe(true);
      expect(rows).toHaveLength(CAP);
      // The emitted page must be byte-identical to the pre-fix response: the
      // probe row is consumed as evidence, never served.
      expect(rows).toEqual(probed.slice(0, CAP));
    });

    it("reports no truncation when the probe row does not come back", () => {
      const probed = seedIssues(CAP - 1);
      const { rows, truncated } = resolveIssueListTruncation(probed, CAP);
      expect(truncated).toBe(false);
      expect(rows).toHaveLength(CAP - 1);
    });
  });

  describe("REST — GET /api/companies/:companyId/issues", () => {
    it("at cap + 1 available rows: returns exactly cap rows and signals truncation with the applied cap", async () => {
      serveFromPopulation(CAP + 1);
      const app = await buildApp();

      const res = await request(app)
        .get("/api/companies/company-1/issues")
        .query({ limit: String(CAP) });

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(CAP);
      expect(res.headers[ISSUE_LIST_TRUNCATED_HEADER.toLowerCase()]).toBe("true");
      expect(res.headers[ISSUE_LIST_APPLIED_LIMIT_HEADER.toLowerCase()]).toBe(String(CAP));
    });

    it("at cap - 1 available rows: returns every row and omits the truncation signal", async () => {
      serveFromPopulation(CAP - 1);
      const app = await buildApp();

      const res = await request(app)
        .get("/api/companies/company-1/issues")
        .query({ limit: String(CAP) });

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(CAP - 1);
      // Absence is the contract: a caller treats "no truncation header" as
      // proof it holds the whole population.
      expect(res.headers[ISSUE_LIST_TRUNCATED_HEADER.toLowerCase()]).toBeUndefined();
      expect(res.headers[ISSUE_LIST_APPLIED_LIMIT_HEADER.toLowerCase()]).toBe(String(CAP));
    });

    it("never serves the probe row — the page is what the caller asked for", async () => {
      serveFromPopulation(CAP + 1);
      const app = await buildApp();

      const res = await request(app)
        .get("/api/companies/company-1/issues")
        .query({ limit: String(CAP) });

      expect(mockIssueService.list).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ limit: CAP + 1 }),
      );
      expect(res.body.map((row: { id: string }) => row.id)).toEqual(
        seedIssues(CAP).map((row) => row.id),
      );
    });

    /**
     * Ally review (#1844): the signal must describe the page the ACTOR got, not
     * the page the database returned. Resolving truncation on unfiltered rows
     * turns the header into an oracle for rows outside the actor's scope.
     */
    it("does not signal truncation to a restricted actor whose visible rows fit the page", async () => {
      serveFromPopulation(CAP + 1);
      allowOnlyIssues(["issue-0", "issue-1", "issue-2"]);
      const app = await buildApp();

      const res = await request(app)
        .get("/api/companies/company-1/issues")
        .query({ limit: String(CAP) });

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(3);
      // The DB had CAP + 1 matching rows. Saying so here would disclose that
      // issues this actor cannot read exist.
      expect(res.headers[ISSUE_LIST_TRUNCATED_HEADER.toLowerCase()]).toBeUndefined();
      expect(res.headers[ISSUE_LIST_APPLIED_LIMIT_HEADER.toLowerCase()]).toBe(String(CAP));
    });

    it("still signals truncation to a restricted actor that really has more readable rows", async () => {
      serveFromPopulation(CAP + 1);
      // Denied company scope (so the per-row filter runs) but permitted every
      // row: suppressing the signal here would reintroduce the silent
      // under-return for exactly the actors the fix above protects.
      allowOnlyIssues(seedIssues(CAP + 1).map((row) => row.id));
      const app = await buildApp();

      const res = await request(app)
        .get("/api/companies/company-1/issues")
        .query({ limit: String(CAP) });

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(CAP);
      expect(res.headers[ISSUE_LIST_TRUNCATED_HEADER.toLowerCase()]).toBe("true");
    });

    /**
     * Ally review (#1844): the CAP=50 cases above never exercise the clamp, so
     * they cannot catch a probe that overflows the real ceiling. Drive the
     * production maximum: an oversized `limit` clamps to ISSUE_LIST_MAX_LIMIT
     * and the probe asks for exactly one row past it.
     */
    it("clamps an oversized limit to the production cap and probes one row past it", async () => {
      serveFromPopulation(ISSUE_LIST_MAX_LIMIT + 1);
      const app = await buildApp();

      const res = await request(app)
        .get("/api/companies/company-1/issues")
        .query({ limit: "3000" });

      expect(res.status).toBe(200);
      expect(mockIssueService.list).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ limit: ISSUE_LIST_MAX_LIMIT + 1 }),
      );
      expect(res.body).toHaveLength(ISSUE_LIST_MAX_LIMIT);
      expect(res.headers[ISSUE_LIST_TRUNCATED_HEADER.toLowerCase()]).toBe("true");
      expect(res.headers[ISSUE_LIST_APPLIED_LIMIT_HEADER.toLowerCase()]).toBe(
        String(ISSUE_LIST_MAX_LIMIT),
      );
    });

    it("at exactly the production cap: returns every row and omits the signal", async () => {
      serveFromPopulation(ISSUE_LIST_MAX_LIMIT);
      const app = await buildApp();

      const res = await request(app)
        .get("/api/companies/company-1/issues")
        .query({ limit: "3000" });

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(ISSUE_LIST_MAX_LIMIT);
      expect(res.headers[ISSUE_LIST_TRUNCATED_HEADER.toLowerCase()]).toBeUndefined();
    });
  });

  describe("MCP — paperclipListIssues", () => {
    /**
     * Drive the REAL registered tool, not the envelope helper in isolation:
     * a fake client hands `paperclipListIssues` exactly the body and headers
     * the REST route emitted above. So this half fails if REST stops sending
     * the headers, if `listIssues` stops reading them, or if the envelope
     * itself regresses — a fix that lands only on REST cannot pass it.
     */
    async function callListIssuesTool(restResponse: { body: unknown; headers: Record<string, string> }) {
      const { createToolDefinitions } = await import("../../../packages/mcp-server/src/tools.ts");
      const tools = createToolDefinitions({
        resolveCompany: async () => "company-1",
        requestJsonWithHeaders: async () => ({
          data: restResponse.body,
          headers: new Headers(restResponse.headers),
        }),
      } as never);
      const listTool = tools.find((tool) => tool.name === "paperclipListIssues")!;
      const result = await listTool.execute({ companyId: "company-1" });
      return JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
    }

    it("at cap + 1 available rows: wraps the page in a truncation envelope carrying the applied cap", async () => {
      serveFromPopulation(CAP + 1);
      const app = await buildApp();
      const res = await request(app)
        .get("/api/companies/company-1/issues")
        .query({ limit: String(CAP) });

      const result = await callListIssuesTool(res);

      expect(Array.isArray(result)).toBe(false);
      expect(result.truncated).toBe(true);
      expect(result.appliedLimit).toBe(CAP);
      expect(result.returnedCount).toBe(CAP);
      expect(result.issues).toHaveLength(CAP);
      expect(result.note).toMatch(/TRUNCATED/);
    });

    it("at cap - 1 available rows: passes the bare array through unchanged", async () => {
      serveFromPopulation(CAP - 1);
      const app = await buildApp();
      const res = await request(app)
        .get("/api/companies/company-1/issues")
        .query({ limit: String(CAP) });

      const result = await callListIssuesTool(res);

      // Identical body, no envelope: every existing MCP caller is unaffected
      // in the case that was already correct.
      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual(res.body);
      expect(result).toHaveLength(CAP - 1);
    });
  });

  describe("MCP — paperclipListIssues schema", () => {
    it("states the cap numerically so an agent learns it without measuring", async () => {
      const { createToolDefinitions } = await import("../../../packages/mcp-server/src/tools.ts");
      const tools = createToolDefinitions({
        resolveCompany: async () => "company-1",
        requestJsonWithHeaders: async () => ({ data: [], headers: new Headers() }),
      } as never);
      const listTool = tools.find((tool) => tool.name === "paperclipListIssues");

      expect(listTool).toBeDefined();
      expect(listTool!.description).toMatch(/500/);
      expect(listTool!.description).toMatch(/1000/);
    });

    /**
     * Ally review (#1844): the description promises an oversized `limit` is
     * clamped, not rejected. A client-side `.max()` would make that promise
     * untestable — the caller never reaches the server to see
     * `appliedLimit: 1000`.
     */
    it("accepts an oversized limit so the server's clamp is observable", async () => {
      const { createToolDefinitions } = await import("../../../packages/mcp-server/src/tools.ts");
      const requestJsonWithHeaders = vi.fn(async () => ({ data: [], headers: new Headers() }));
      const tools = createToolDefinitions({
        resolveCompany: async () => "company-1",
        requestJsonWithHeaders,
      } as never);
      const listTool = tools.find((tool) => tool.name === "paperclipListIssues")!;

      const oversized = ISSUE_LIST_MAX_LIMIT + 2000;
      const result = await listTool.execute({ companyId: "company-1", limit: oversized });

      // A schema `.max()` would short-circuit here: the request would never be
      // issued, and the caller would see a validation error instead of the
      // clamped page the description promises.
      expect((result as { isError?: boolean }).isError).toBeUndefined();
      expect(requestJsonWithHeaders).toHaveBeenCalledTimes(1);
      expect(String(requestJsonWithHeaders.mock.calls[0]?.[1])).toContain(`limit=${oversized}`);
    });

    it("still rejects a non-positive limit", async () => {
      const { createToolDefinitions } = await import("../../../packages/mcp-server/src/tools.ts");
      const requestJsonWithHeaders = vi.fn(async () => ({ data: [], headers: new Headers() }));
      const tools = createToolDefinitions({
        resolveCompany: async () => "company-1",
        requestJsonWithHeaders,
      } as never);
      const listTool = tools.find((tool) => tool.name === "paperclipListIssues")!;

      const result = await listTool.execute({ companyId: "company-1", limit: 0 });

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(requestJsonWithHeaders).not.toHaveBeenCalled();
    });
  });
});

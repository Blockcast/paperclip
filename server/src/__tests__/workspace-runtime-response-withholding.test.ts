import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionWorkspace, ProjectWorkspace, WorkspaceRuntimeService } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { projectRoutes } from "../routes/projects.js";
import {
  publicExecutionWorkspace,
  publicProjectWorkspace,
  WITHHELD_WORKSPACE_RUNTIME_VIEWER,
} from "../routes/workspace-response.js";

/**
 * PEN-2852 (door #13 of the PEN-2370 series) — `workspaceRuntime` reached nine response bodies as
 * part of a raw row, gated only on `company_scope:read`.
 *
 * Every fixture value below is invented. No real credential, command or path is quoted anywhere in
 * this file, per the parent ticket's standing prohibition.
 */

const SECRET_SENTINEL = "sentinel-runtime-value-must-not-egress";
const SECOND_SENTINEL = "sentinel-nested-command-must-not-egress";

/**
 * `close-readiness` answers with `runtimeServices` rows directly, and `command`/`cwd` are the same
 * operator strings promoted onto typed columns when the service started — so they need their own
 * sentinels, distinct from the blob ones above, or a passing assertion cannot tell which exit it
 * closed. Both invented; `command` is shaped like the inline-assignment idiom `sh -c` makes normal.
 */
const SERVICE_COMMAND_SENTINEL = "TOKEN_FIXTURE=sentinel-service-command-not-a-real-credential npm run dev";
const SERVICE_CWD_SENTINEL = "/fixture/sentinel-service-cwd";

function runtimeServiceFixture(overrides: Record<string, unknown> = {}): WorkspaceRuntimeService {
  return {
    id: "runtime-service-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    executionWorkspaceId: "workspace-1",
    issueId: null,
    scopeType: "execution_workspace",
    scopeId: "workspace-1",
    serviceName: "api",
    status: "running",
    lifecycle: "shared",
    reuseKey: "sha256-digest-not-the-env",
    command: SERVICE_COMMAND_SENTINEL,
    cwd: SERVICE_CWD_SENTINEL,
    port: 3000,
    url: "http://127.0.0.1:3000",
    provider: "local_process",
    providerRef: "12345",
    ownerAgentId: "agent-1",
    startedByRunId: null,
    lastUsedAt: new Date("2026-01-01T00:00:00.000Z"),
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    stoppedAt: null,
    stopPolicy: null,
    healthStatus: "healthy",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as WorkspaceRuntimeService;
}

function closeReadinessFixture(runtimeServices = [runtimeServiceFixture()]) {
  return {
    workspaceId: "workspace-1",
    state: "ready",
    blockingReasons: [],
    warnings: [],
    linkedIssues: [],
    plannedActions: [],
    isDestructiveCloseAllowed: true,
    isSharedWorkspace: false,
    isProjectPrimaryWorkspace: false,
    git: null,
    runtimeServices,
  };
}

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
  listOverview: vi.fn(),
  listSummaries: vi.fn(),
  getById: vi.fn(),
  getCloseReadiness: vi.fn(),
  reconcileExecutionWorkspaceBranch: vi.fn(),
  update: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listWorkspaces: vi.fn(),
  // `router.param("id")` normalizes shortnames through this before any handler runs.
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForExecutionWorkspace: vi.fn(),
  createRecorder: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  projectService: () => mockProjectService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

function runtimeBlob(): Record<string, unknown> {
  return {
    services: [{ name: "web", command: SECRET_SENTINEL, env: { TOKEN_FIXTURE: SECOND_SENTINEL } }],
  };
}

function executionWorkspaceFixture(): ExecutionWorkspace {
  const runtime = runtimeBlob();
  return {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: null,
    sourceIssueId: null,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "Alpha",
    status: "active",
    cwd: "/fixture/cwd",
    agentCwd: "/fixture/cwd",
    repoUrl: null,
    baseRef: null,
    branchName: null,
    providerType: "git_worktree",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date("2026-01-01T00:00:00.000Z"),
    openedAt: new Date("2026-01-01T00:00:00.000Z"),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: {
      environmentId: null,
      provisionCommand: null,
      teardownCommand: null,
      cleanupCommand: null,
      workspaceRuntime: runtime,
      desiredState: "running",
      serviceStates: null,
    },
    hasWorkspaceRuntimeConfig: true,
    // The storage layout: `config` is a derived view over `metadata.config`, so the same bytes are
    // reachable through both keys. This fixture reproduces that, which is the point of the test.
    metadata: { config: { workspaceRuntime: runtime } },
    // Populated, not `[]`. The empty array here is what let the ordinary GET/LIST exits go
    // unexamined for a round: `publicExecutionWorkspace` spreads the row, so a field it does not
    // name is disclosed — but a fixture with nothing in it cannot show that.
    runtimeServices: [runtimeServiceFixture()],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function projectWorkspaceFixture(): ProjectWorkspace {
  const runtime = runtimeBlob();
  return {
    id: "project-workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    name: "Primary",
    sourceType: "local_folder",
    cwd: "/fixture/cwd",
    repoUrl: null,
    repoRef: null,
    defaultRef: null,
    visibility: "shared",
    setupCommand: null,
    cleanupCommand: null,
    remoteProvider: null,
    remoteWorkspaceRef: null,
    sharedWorkspaceKey: null,
    metadata: { runtimeConfig: { workspaceRuntime: runtime } },
    runtimeConfig: { workspaceRuntime: runtime, desiredState: "running", serviceStates: null },
    hasWorkspaceRuntimeConfig: true,
    isPrimary: true,
    runtimeServices: [
      runtimeServiceFixture({
        id: "runtime-service-2",
        scopeType: "project_workspace",
        scopeId: "project-workspace-1",
        executionWorkspaceId: null,
        projectWorkspaceId: "project-workspace-1",
        projectId: "project-1",
      }),
    ],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

/**
 * Allows every action EXCEPT `workspace_runtime:read` — the reachability this door describes.
 *
 * Note the mock deliberately still allows `runtime:manage`: that models the real policy, in which
 * a standard same-company agent holds `runtime:manage` (`allow_company_agent`) and so gating on it
 * would disclose. These route-level cases prove the projection is applied when the decision is
 * denied; that the decision actually IS denied for such an agent is proven against the real
 * authorization service in `authorization-service.test.ts` ("PEN-2852 workspace_runtime:read"),
 * because no mock can establish that.
 */
function decideAsUnprivilegedReader() {
  mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
    allowed: input.action !== "workspace_runtime:read",
    action: input.action,
    reason: "test",
    explanation: "Allowed by test mock.",
  }));
}

function decideAsRuntimeManager() {
  mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
    allowed: true,
    action: input.action,
    reason: "test",
    explanation: "Allowed by test mock.",
  }));
}

function createApp(mount: "execution-workspaces" | "projects") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      companyIds: ["company-1"],
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use(
    "/api",
    mount === "execution-workspaces"
      ? executionWorkspaceRoutes({} as any)
      : projectRoutes({} as any),
  );
  app.use(errorHandler);
  return app;
}

describe("workspace runtime withholding boundary (PEN-2852)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decideAsUnprivilegedReader();
    mockExecutionWorkspaceService.getById.mockResolvedValue(executionWorkspaceFixture());
    mockExecutionWorkspaceService.list.mockResolvedValue([executionWorkspaceFixture()]);
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue(closeReadinessFixture());
    mockProjectService.getById.mockResolvedValue({ id: "project-1", companyId: "company-1" });
    mockProjectService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      project: { id: "project-1", companyId: "company-1" },
    });
    mockProjectService.listWorkspaces.mockResolvedValue([projectWorkspaceFixture()]);
  });

  describe("projection helpers", () => {
    it("closes BOTH exits on an execution workspace: the derived config view and raw metadata", () => {
      const withheld = publicExecutionWorkspace(
        executionWorkspaceFixture(),
        WITHHELD_WORKSPACE_RUNTIME_VIEWER,
      );

      expect(withheld.config?.workspaceRuntime).toBeNull();
      // `metadata.config.workspaceRuntime` carries the identical bytes. Withholding only the
      // derived view would be a no-op, which is why this assertion is separate from the one above.
      expect(withheld.metadata).toBeNull();
      expect(JSON.stringify(withheld)).not.toContain(SECRET_SENTINEL);
      expect(JSON.stringify(withheld)).not.toContain(SECOND_SENTINEL);
      // Third exit, same projection: `runtimeServices` rides the spread unless named.
      expect(JSON.stringify(withheld)).not.toContain(SERVICE_COMMAND_SENTINEL);
      expect(JSON.stringify(withheld)).not.toContain(SERVICE_CWD_SENTINEL);
    });

    it("closes BOTH exits on a project workspace", () => {
      const withheld = publicProjectWorkspace(
        projectWorkspaceFixture(),
        WITHHELD_WORKSPACE_RUNTIME_VIEWER,
      );

      expect(withheld.runtimeConfig?.workspaceRuntime).toBeNull();
      expect(withheld.metadata).toBeNull();
      expect(JSON.stringify(withheld)).not.toContain(SECRET_SENTINEL);
      expect(JSON.stringify(withheld)).not.toContain(SECOND_SENTINEL);
      expect(JSON.stringify(withheld)).not.toContain(SERVICE_COMMAND_SENTINEL);
      expect(JSON.stringify(withheld)).not.toContain(SERVICE_CWD_SENTINEL);
    });

    it("keeps the diagnostic fields a withheld reader still needs", () => {
      const withheld = publicExecutionWorkspace(
        executionWorkspaceFixture(),
        WITHHELD_WORKSPACE_RUNTIME_VIEWER,
      );

      // Presence survives so the UI can still say "a runtime config exists here".
      expect(withheld.hasWorkspaceRuntimeConfig).toBe(true);
      // Non-secret siblings inside the same object are not collateral.
      expect(withheld.config?.desiredState).toBe("running");
      expect(withheld.cwd).toBe("/fixture/cwd");
      expect(withheld.status).toBe("active");
    });

    it("does not copy the input when the viewer is entitled", () => {
      const raw = executionWorkspaceFixture();
      expect(publicExecutionWorkspace(raw, { revealRuntimeConfig: true })).toBe(raw);
    });
  });

  describe("GET /execution-workspaces/:id", () => {
    it("withholds the runtime config from a reader without workspace_runtime:read", async () => {
      const res = await request(createApp("execution-workspaces")).get("/api/execution-workspaces/workspace-1");

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(SECRET_SENTINEL);
      expect(res.body.config.workspaceRuntime).toBeNull();
      expect(res.body.metadata).toBeNull();
      expect(res.body.hasWorkspaceRuntimeConfig).toBe(true);
    });

    /**
     * The exit Ally found. `close-readiness` was fixed first and reads as "the route that answers
     * with service rows" — but the ORDINARY read answers with them too, through the same helper,
     * with no route of its own to notice.
     */
    it("masks runtimeServices command/cwd on the ordinary read, not just close-readiness", async () => {
      const res = await request(createApp("execution-workspaces")).get("/api/execution-workspaces/workspace-1");

      expect(JSON.stringify(res.body)).not.toContain(SERVICE_COMMAND_SENTINEL);
      expect(JSON.stringify(res.body)).not.toContain(SERVICE_CWD_SENTINEL);
      // Masked, not dropped: the row still identifies the service it withheld the pair from.
      expect(res.body.runtimeServices).toHaveLength(1);
      expect(res.body.runtimeServices[0].command).toBe(REDACTED_EVENT_VALUE);
      expect(res.body.runtimeServices[0].cwd).toBe(REDACTED_EVENT_VALUE);
      expect(res.body.runtimeServices[0].serviceName).toBe("api");
    });

    it("discloses it to a reader holding workspace_runtime:read", async () => {
      decideAsRuntimeManager();

      const res = await request(createApp("execution-workspaces")).get("/api/execution-workspaces/workspace-1");

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toContain(SECRET_SENTINEL);
    });
  });

  describe("GET /companies/:companyId/execution-workspaces", () => {
    it("withholds on the LIST route, whose blast radius is every workspace in the company", async () => {
      const res = await request(createApp("execution-workspaces")).get(
        "/api/companies/company-1/execution-workspaces",
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(JSON.stringify(res.body)).not.toContain(SECRET_SENTINEL);
      expect(res.body[0].metadata).toBeNull();
      // Widest exit in the file: every workspace in the company, each with its service rows.
      expect(JSON.stringify(res.body)).not.toContain(SERVICE_COMMAND_SENTINEL);
      expect(JSON.stringify(res.body)).not.toContain(SERVICE_CWD_SENTINEL);
    });

    it("leaves summary mode alone — it carries no config or metadata to withhold", async () => {
      mockExecutionWorkspaceService.listSummaries.mockResolvedValue([
        { id: "workspace-1", name: "Alpha", mode: "isolated_workspace", projectWorkspaceId: null },
      ]);

      const res = await request(createApp("execution-workspaces")).get(
        "/api/companies/company-1/execution-workspaces?summary=true",
      );

      expect(res.status).toBe(200);
      expect(res.body[0]).toEqual({
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      });
    });
  });

  describe("GET /execution-workspaces/:id/close-readiness", () => {
    it("masks runtimeServices command/cwd for an ordinary same-company agent", async () => {
      const res = await request(createApp("execution-workspaces")).get(
        "/api/execution-workspaces/workspace-1/close-readiness",
      );

      expect(res.status).toBe(200);
      // The whole-body assertion is the load-bearing one: this route answered with the raw
      // service row, so both sentinels crossed in cleartext to any caller holding only
      // `company_scope:read`.
      expect(JSON.stringify(res.body)).not.toContain(SERVICE_COMMAND_SENTINEL);
      expect(JSON.stringify(res.body)).not.toContain(SERVICE_CWD_SENTINEL);

      const service = res.body.runtimeServices[0];
      expect(service.command).toBe(REDACTED_EVENT_VALUE);
      expect(service.cwd).toBe(REDACTED_EVENT_VALUE);
    });

    it("keeps the readiness fields close-readiness exists to answer", async () => {
      const res = await request(createApp("execution-workspaces")).get(
        "/api/execution-workspaces/workspace-1/close-readiness",
      );

      // Field-level, not `runtimeServices: []` — the route counts running services to decide
      // whether closing is destructive, so emptying the array would break the feature.
      expect(res.body.runtimeServices).toHaveLength(1);
      expect(res.body.runtimeServices[0].serviceName).toBe("api");
      expect(res.body.runtimeServices[0].status).toBe("running");
      // Runtime-generated, not operator free text, and `paperclipWaitForIssueWorkspaceService`
      // returns it to callers — see `publicRuntimeServices`.
      expect(res.body.runtimeServices[0].url).toBe("http://127.0.0.1:3000");
      expect(res.body.state).toBe("ready");
      expect(res.body.isDestructiveCloseAllowed).toBe(true);
    });

    it("discloses to a reader holding workspace_runtime:read", async () => {
      decideAsRuntimeManager();

      const res = await request(createApp("execution-workspaces")).get(
        "/api/execution-workspaces/workspace-1/close-readiness",
      );

      expect(res.status).toBe(200);
      expect(res.body.runtimeServices[0].command).toBe(SERVICE_COMMAND_SENTINEL);
      expect(res.body.runtimeServices[0].cwd).toBe(SERVICE_CWD_SENTINEL);
    });

    it("distinguishes a withheld command from a service that has none", async () => {
      mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue(
        closeReadinessFixture([runtimeServiceFixture({ command: null, cwd: null })]),
      );

      const res = await request(createApp("execution-workspaces")).get(
        "/api/execution-workspaces/workspace-1/close-readiness",
      );

      // withheld-is-not-absent, the same contract as `hasWorkspaceRuntimeConfig`.
      expect(res.body.runtimeServices[0].command).toBeNull();
      expect(res.body.runtimeServices[0].cwd).toBeNull();
    });
  });

  describe("GET /projects/:id/workspaces", () => {
    it("withholds on the project-workspace LIST route", async () => {
      const res = await request(createApp("projects")).get("/api/projects/project-1/workspaces");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(JSON.stringify(res.body)).not.toContain(SECRET_SENTINEL);
      expect(res.body[0].runtimeConfig.workspaceRuntime).toBeNull();
      expect(res.body[0].metadata).toBeNull();
      expect(res.body[0].hasWorkspaceRuntimeConfig).toBe(true);
      // `ProjectWorkspace.runtimeServices` is the same exit on the other row type.
      expect(JSON.stringify(res.body)).not.toContain(SERVICE_COMMAND_SENTINEL);
      expect(JSON.stringify(res.body)).not.toContain(SERVICE_CWD_SENTINEL);
      expect(res.body[0].runtimeServices[0].command).toBe(REDACTED_EVENT_VALUE);
      expect(res.body[0].runtimeServices[0].cwd).toBe(REDACTED_EVENT_VALUE);
    });

    it("discloses it to a reader holding workspace_runtime:read", async () => {
      decideAsRuntimeManager();

      const res = await request(createApp("projects")).get("/api/projects/project-1/workspaces");

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toContain(SECRET_SENTINEL);
    });
  });
});

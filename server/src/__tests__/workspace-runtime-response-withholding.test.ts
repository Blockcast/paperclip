import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExecutionWorkspace,
  ProjectWorkspace,
  WorkspaceOperation,
  WorkspaceRuntimeService,
} from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { projectRoutes } from "../routes/projects.js";
import {
  publicExecutionWorkspace,
  publicExecutionWorkspaceCloseReadiness,
  publicProjectExecutionWorkspacePolicy,
  publicProjectWorkspace,
  publicWorkspaceOperation,
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

/**
 * `WorkspaceOperation` carries the same pair a third time, by copy: the recorder is handed
 * `command: workspaceCommand?.command` and `cwd: existing.cwd`. Distinct sentinels again, so a
 * passing assertion names which exit it closed rather than borrowing another's.
 *
 * `metadata` gets its own: it is an open record written by ~10 recorder call sites and carries host
 * paths (`worktreePath`, `repoRoot`) that no named-key list would have covered in advance.
 */
const OPERATION_COMMAND_SENTINEL = "TOKEN_FIXTURE=sentinel-operation-command-not-a-real-credential npm run build";
const OPERATION_CWD_SENTINEL = "/fixture/sentinel-operation-cwd";
const OPERATION_METADATA_SENTINEL = "/fixture/sentinel-operation-worktree-path";

/**
 * PEN-3073. The lifecycle command scalars that sit BESIDE `workspaceRuntime` on the same config
 * object, and their siblings on the three nouns that carry the same strings elsewhere. Each gets its
 * own sentinel for the reason stated above: a passing assertion has to name the exit it closed.
 *
 * Before this ticket every one of these fixture fields was `null`, which is why the suite went green
 * while the values crossed — a fixture that carries nothing cannot show a mask that does nothing.
 * All invented; shaped like the inline-assignment idiom `bash -lc` makes ordinary.
 */
const CONFIG_PROVISION_SENTINEL = "TOKEN_FIXTURE=sentinel-provision-not-a-real-credential ./provision.sh";
const CONFIG_TEARDOWN_SENTINEL = "TOKEN_FIXTURE=sentinel-teardown-not-a-real-credential ./teardown.sh";
const CONFIG_CLEANUP_SENTINEL = "TOKEN_FIXTURE=sentinel-cleanup-not-a-real-credential ./cleanup.sh";
const PROJECT_SETUP_SENTINEL = "TOKEN_FIXTURE=sentinel-project-setup-not-a-real-credential pnpm install";
const PROJECT_CLEANUP_SENTINEL = "TOKEN_FIXTURE=sentinel-project-cleanup-not-a-real-credential ./drop.sh";
const STRATEGY_PROVISION_SENTINEL = "TOKEN_FIXTURE=sentinel-strategy-provision-not-a-real-credential ./boot.sh";
const STRATEGY_TEARDOWN_SENTINEL = "TOKEN_FIXTURE=sentinel-strategy-teardown-not-a-real-credential ./halt.sh";
const STRATEGY_PARENT_DIR_SENTINEL = "/fixture/sentinel-worktree-parent-dir";
const POLICY_RUNTIME_SENTINEL = "sentinel-project-policy-runtime-must-not-egress";

function workspaceOperationFixture(overrides: Record<string, unknown> = {}): WorkspaceOperation {
  return {
    id: "operation-1",
    companyId: "company-1",
    executionWorkspaceId: "workspace-1",
    heartbeatRunId: null,
    issueId: null,
    phase: "workspace_provision",
    command: OPERATION_COMMAND_SENTINEL,
    cwd: OPERATION_CWD_SENTINEL,
    status: "succeeded",
    exitCode: 0,
    logStore: null,
    logRef: null,
    logBytes: 4096,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    metadata: { action: "start", worktreePath: OPERATION_METADATA_SENTINEL },
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    finishedAt: new Date("2026-01-01T00:00:01.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:01.000Z"),
    ...overrides,
  } as WorkspaceOperation;
}

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
    // PEN-3073. `plannedActions` was `[]` before this ticket, which is the same blind spot the
    // `runtimeServices` fixture had: the route spreads `readiness`, so an empty array cannot show
    // that a populated one crosses. The two operator-authored kinds carry the operator's own string;
    // the generated preview below must SURVIVE, because blanking it would break the
    // confirm-before-destroy UI to hide a string the operator never wrote.
    plannedActions: [
      {
        kind: "cleanup_command",
        label: "Run workspace cleanup command",
        description: "Workspace-specific cleanup runs before teardown.",
        command: CONFIG_CLEANUP_SENTINEL,
      },
      {
        kind: "teardown_command",
        label: "Run teardown command",
        description: "Teardown runs after cleanup commands during workspace close.",
        command: STRATEGY_TEARDOWN_SENTINEL,
      },
      {
        kind: "git_worktree_remove",
        label: "Remove git worktree",
        description: "Paperclip will run git worktree cleanup.",
        command: "git worktree remove --force /fixture/cwd",
      },
    ],
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

/**
 * The runtime-command POSTs sit behind a MANAGE gate that reads `agents` and `heartbeatRuns` off a
 * real `db`; these apps mount `{}`. Stubbing it is what makes those routes drivable at all.
 *
 * This is deliberately not the control under test, and stubbing it does not weaken the ones that
 * are. A standard same-company agent genuinely PASSES this gate — it holds `runtime:manage` via
 * `allow_company_agent` — so a pass is the realistic case, and it is precisely that pass which
 * makes the READ boundary below the only thing standing between such an agent and the operator's
 * command text. The gate has its own coverage in `workspace-runtime-service-authz.test.ts`.
 */
const mockAssertCanManageProjectWorkspaceRuntimeServices = vi.hoisted(() =>
  vi.fn(async () => undefined),
);
vi.mock("../routes/workspace-runtime-service-authz.js", () => ({
  assertCanManageProjectWorkspaceRuntimeServices: mockAssertCanManageProjectWorkspaceRuntimeServices,
  assertCanManageExecutionWorkspaceRuntimeServices: vi.fn(async () => undefined),
}));

/**
 * PEN-3205: the workspace-operations route now reads `censorUsernameInLogs` per request, to apply
 * the username censoring the sibling list route in `routes/agents.ts` already applied. These apps
 * mount `{}` as `db`, so the real service's `getGeneral()` throws and the route answers 500 —
 * stubbing it is what keeps the withholding boundary below drivable at all.
 *
 * Default OFF so the censor is a no-op: the withholding assertions in this file measure
 * `publicWorkspaceOperation`, and a censor running underneath them could mask a sentinel and make
 * a withholding test pass for the wrong reason. The censor has its own coverage below, which
 * turns it on explicitly and pairs it with the off-case as the discriminator.
 */
const mockInstanceGeneralSettings = vi.hoisted(() => ({ censorUsernameInLogs: false }));
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: async () => ({ ...mockInstanceGeneralSettings }),
  }),
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
      provisionCommand: CONFIG_PROVISION_SENTINEL,
      teardownCommand: CONFIG_TEARDOWN_SENTINEL,
      cleanupCommand: CONFIG_CLEANUP_SENTINEL,
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
    setupCommand: PROJECT_SETUP_SENTINEL,
    cleanupCommand: PROJECT_CLEANUP_SENTINEL,
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
    mockInstanceGeneralSettings.censorUsernameInLogs = false;
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

    /**
     * PEN-3073. The three scalars that sit beside `workspaceRuntime` on the same object and carried
     * the same class of value — `provisionCommand` is executed as `bash -lc <string>`.
     */
    it("withholds the lifecycle command scalars beside workspaceRuntime", () => {
      const withheld = publicExecutionWorkspace(
        executionWorkspaceFixture(),
        WITHHELD_WORKSPACE_RUNTIME_VIEWER,
      );

      const serialized = JSON.stringify(withheld);
      expect(serialized).not.toContain(CONFIG_PROVISION_SENTINEL);
      expect(serialized).not.toContain(CONFIG_TEARDOWN_SENTINEL);
      expect(serialized).not.toContain(CONFIG_CLEANUP_SENTINEL);
      // Masked, not nulled: a withheld reader must still tell "none configured" from "withheld",
      // the same contract `hasWorkspaceRuntimeConfig` carries for the blob.
      expect(withheld.config?.provisionCommand).toBe(REDACTED_EVENT_VALUE);
      expect(withheld.config?.teardownCommand).toBe(REDACTED_EVENT_VALUE);
      expect(withheld.config?.cleanupCommand).toBe(REDACTED_EVENT_VALUE);
    });

    it("preserves null rather than masking it, so absent stays distinguishable from withheld", () => {
      const raw = executionWorkspaceFixture();
      const withheld = publicExecutionWorkspace(
        { ...raw, config: { ...raw.config!, provisionCommand: null } },
        WITHHELD_WORKSPACE_RUNTIME_VIEWER,
      );

      expect(withheld.config?.provisionCommand).toBeNull();
      expect(withheld.config?.teardownCommand).toBe(REDACTED_EVENT_VALUE);
    });

    /**
     * PEN-3073. `ProjectWorkspaceRuntimeConfig` has no command fields, so reading the
     * execution/project asymmetry off the two *runtime-config* types says the project side is
     * already closed. It is not: the ROW carries the same class one level up, as columns.
     */
    it("withholds the project workspace's own command columns", () => {
      const withheld = publicProjectWorkspace(
        projectWorkspaceFixture(),
        WITHHELD_WORKSPACE_RUNTIME_VIEWER,
      );

      const serialized = JSON.stringify(withheld);
      expect(serialized).not.toContain(PROJECT_SETUP_SENTINEL);
      expect(serialized).not.toContain(PROJECT_CLEANUP_SENTINEL);
      expect(withheld.setupCommand).toBe(REDACTED_EVENT_VALUE);
      expect(withheld.cleanupCommand).toBe(REDACTED_EVENT_VALUE);
      // The identity fields a caller needs to keep addressing the workspace are untouched.
      expect(withheld.name).toBe("Primary");
      expect(withheld.hasWorkspaceRuntimeConfig).toBe(true);
    });

    /**
     * PEN-3073. The project-level default for the same two objects the workspace rows carry
     * per-instance. It is not a workspace row, so nothing in the shipped boundary reached it.
     */
    it("withholds the project execution-workspace policy's strategy commands and runtime blob", () => {
      const withheld = publicProjectExecutionWorkspacePolicy(
        {
          enabled: true,
          defaultMode: "isolated_workspace",
          environmentId: "environment-1",
          workspaceStrategy: {
            type: "git_worktree",
            baseRef: "main",
            branchTemplate: "agent/{issue}",
            worktreeParentDir: STRATEGY_PARENT_DIR_SENTINEL,
            provisionCommand: STRATEGY_PROVISION_SENTINEL,
            teardownCommand: STRATEGY_TEARDOWN_SENTINEL,
            runScope: "per_issue",
          },
          workspaceRuntime: { services: [{ name: "web", env: { TOKEN_FIXTURE: POLICY_RUNTIME_SENTINEL } }] },
        },
        WITHHELD_WORKSPACE_RUNTIME_VIEWER,
      );

      const serialized = JSON.stringify(withheld);
      expect(serialized).not.toContain(STRATEGY_PROVISION_SENTINEL);
      expect(serialized).not.toContain(STRATEGY_TEARDOWN_SENTINEL);
      expect(serialized).not.toContain(STRATEGY_PARENT_DIR_SENTINEL);
      expect(serialized).not.toContain(POLICY_RUNTIME_SENTINEL);
      // Names and structure survive the runtime walk — PEN-2370 ask 1.
      expect(serialized).toContain("TOKEN_FIXTURE");
      // Closed-shape siblings cross intact, per the module's stated non-withholding list.
      expect(withheld?.enabled).toBe(true);
      expect(withheld?.environmentId).toBe("environment-1");
      expect(withheld?.workspaceStrategy?.type).toBe("git_worktree");
      expect(withheld?.workspaceStrategy?.baseRef).toBe("main");
      expect(withheld?.workspaceStrategy?.branchTemplate).toBe("agent/{issue}");
    });

    /**
     * PEN-3073. Masked by action KIND. Blanket masking would have hidden the generated preview that
     * is the entire point of a confirm-before-destroy readiness check.
     */
    it("withholds only the operator-authored planned-action commands on close-readiness", () => {
      const withheld = publicExecutionWorkspaceCloseReadiness(
        closeReadinessFixture() as never,
        WITHHELD_WORKSPACE_RUNTIME_VIEWER,
      );
      const byKind = Object.fromEntries(withheld.plannedActions.map((a) => [a.kind, a.command]));

      expect(JSON.stringify(withheld)).not.toContain(CONFIG_CLEANUP_SENTINEL);
      expect(JSON.stringify(withheld)).not.toContain(STRATEGY_TEARDOWN_SENTINEL);
      expect(byKind.cleanup_command).toBe(REDACTED_EVENT_VALUE);
      expect(byKind.teardown_command).toBe(REDACTED_EVENT_VALUE);
      expect(byKind.git_worktree_remove).toBe("git worktree remove --force /fixture/cwd");
      // The service rows the earlier revision already masked stay masked.
      expect(JSON.stringify(withheld)).not.toContain(SERVICE_COMMAND_SENTINEL);
    });

    it("discloses every PEN-3073 field to an entitled viewer", () => {
      const raw = executionWorkspaceFixture();
      const disclosed = publicExecutionWorkspace(raw, { revealRuntimeConfig: true });
      const project = publicProjectWorkspace(projectWorkspaceFixture(), { revealRuntimeConfig: true });

      // The runtime EDITORS read these back into a form and PATCH them. Masking them for an
      // entitled operator would not merely hide the value, it would let the editor write the
      // sentinel over the real one — the failure the entitlement split exists to prevent.
      expect(disclosed.config?.provisionCommand).toBe(CONFIG_PROVISION_SENTINEL);
      expect(disclosed.config?.teardownCommand).toBe(CONFIG_TEARDOWN_SENTINEL);
      expect(disclosed.config?.cleanupCommand).toBe(CONFIG_CLEANUP_SENTINEL);
      expect(project.setupCommand).toBe(PROJECT_SETUP_SENTINEL);
      expect(project.cleanupCommand).toBe(PROJECT_CLEANUP_SENTINEL);
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

  /**
   * Door #15 — `WorkspaceOperation`, found by Ally at head `ff95da68` and ruled in scope by the CTO
   * (BLO-33407 Ruling F).
   *
   * The defect this closes is not an adjacent field: the POST runtime-command handler reached into
   * one response literal, masked `workspace`, and left the sibling `operation` raw on the next line
   * — while `operation.command`/`.cwd` are recorded verbatim FROM the workspace command and
   * `existing.cwd` it had just withheld. Withholding a value at one projection and handing out a
   * byte-identical copy at another is the same exit, not a scope boundary.
   */
  describe("workspace operations (door #15)", () => {
    it("masks the copied command/cwd pair and the open metadata record", () => {
      const withheld = publicWorkspaceOperation(
        workspaceOperationFixture(),
        WITHHELD_WORKSPACE_RUNTIME_VIEWER,
      );

      expect(JSON.stringify(withheld)).not.toContain(OPERATION_COMMAND_SENTINEL);
      expect(JSON.stringify(withheld)).not.toContain(OPERATION_CWD_SENTINEL);
      // `metadata` is the exit a named-key list would have missed: `worktreePath` is written by one
      // recorder call site out of ~10, and the record has no closed shape.
      expect(JSON.stringify(withheld)).not.toContain(OPERATION_METADATA_SENTINEL);
      expect(withheld.command).toBe(REDACTED_EVENT_VALUE);
      expect(withheld.cwd).toBe(REDACTED_EVENT_VALUE);
    });

    it("keeps the fields a withheld reader still needs to see that an operation ran", () => {
      const withheld = publicWorkspaceOperation(
        workspaceOperationFixture(),
        WITHHELD_WORKSPACE_RUNTIME_VIEWER,
      );

      // Withholding the operator's text is the point; hiding the fact of execution is not.
      expect(withheld.phase).toBe("workspace_provision");
      expect(withheld.status).toBe("succeeded");
      expect(withheld.exitCode).toBe(0);
      expect(withheld.logBytes).toBe(4096);
      expect(withheld.id).toBe("operation-1");
      expect(withheld.executionWorkspaceId).toBe("workspace-1");
      expect(withheld.finishedAt).toEqual(new Date("2026-01-01T00:00:01.000Z"));
    });

    it("distinguishes a withheld command from an operation that has none", () => {
      const withheld = publicWorkspaceOperation(
        workspaceOperationFixture({ command: null, cwd: null, metadata: null }),
        WITHHELD_WORKSPACE_RUNTIME_VIEWER,
      );

      // withheld-is-not-absent, inherited from `maskWorkspaceRuntimeTextForRead` rather than
      // re-derived here.
      expect(withheld.command).toBeNull();
      expect(withheld.cwd).toBeNull();
      expect(withheld.metadata).toBeNull();
    });

    it("does not copy the input when the viewer is entitled", () => {
      const raw = workspaceOperationFixture();
      expect(publicWorkspaceOperation(raw, { revealRuntimeConfig: true })).toBe(raw);
    });

    it("withholds on GET /execution-workspaces/:id/workspace-operations", async () => {
      mockWorkspaceOperationService.listForExecutionWorkspace.mockResolvedValue([
        workspaceOperationFixture(),
      ]);

      const res = await request(createApp("execution-workspaces")).get(
        "/api/execution-workspaces/workspace-1/workspace-operations",
      );

      expect(res.status).toBe(200);
      // The load-bearing assertion: this route answered with the raw rows, so all three sentinels
      // crossed in cleartext to any caller holding only `company_scope:read`.
      expect(JSON.stringify(res.body)).not.toContain(OPERATION_COMMAND_SENTINEL);
      expect(JSON.stringify(res.body)).not.toContain(OPERATION_CWD_SENTINEL);
      expect(JSON.stringify(res.body)).not.toContain(OPERATION_METADATA_SENTINEL);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].command).toBe(REDACTED_EVENT_VALUE);
      expect(res.body[0].phase).toBe("workspace_provision");
    });

    it("discloses to a reader holding workspace_runtime:read", async () => {
      decideAsRuntimeManager();
      mockWorkspaceOperationService.listForExecutionWorkspace.mockResolvedValue([
        workspaceOperationFixture(),
      ]);

      const res = await request(createApp("execution-workspaces")).get(
        "/api/execution-workspaces/workspace-1/workspace-operations",
      );

      expect(res.status).toBe(200);
      expect(res.body[0].command).toBe(OPERATION_COMMAND_SENTINEL);
      expect(res.body[0].cwd).toBe(OPERATION_CWD_SENTINEL);
    });

    /**
     * PEN-3205, read side. `publicWorkspaceOperation` masks `command`/`cwd`/`metadata` and spreads
     * the rest, so `stdoutExcerpt` crosses this route UNMASKED by design — the username censor is
     * the only control standing over it here, and `routes/agents.ts` was already applying it on
     * the sibling list route while this one answered with a bare `res.json`.
     *
     * The home directory comes from `os.homedir()` rather than a literal because that is the same
     * value `defaultHomeDirs` derives its (module-cached) candidate list from, so this is
     * deterministic on any runner without reaching into that cache. The pair is the point: the
     * setting is the sole discriminator between the two cases, so neither passes if the censor is
     * dropped from the route, and neither passes if it is replaced by blanket blanking.
     */
    it("censors the current user's home directory in the excerpt when the setting is on", async () => {
      mockInstanceGeneralSettings.censorUsernameInLogs = true;
      const homeDir = os.homedir();
      mockWorkspaceOperationService.listForExecutionWorkspace.mockResolvedValue([
        workspaceOperationFixture({ stdoutExcerpt: `cloned into ${homeDir}/checkout` }),
      ]);

      const res = await request(createApp("execution-workspaces")).get(
        "/api/execution-workspaces/workspace-1/workspace-operations",
      );

      expect(res.status).toBe(200);
      expect(res.body[0].stdoutExcerpt).not.toContain(homeDir);
      // Censored, not blanked: the surrounding line survives so the excerpt stays readable.
      expect(res.body[0].stdoutExcerpt).toContain("cloned into ");
      expect(res.body[0].stdoutExcerpt).toContain("/checkout");
    });

    it("leaves the excerpt alone when the setting is off", async () => {
      mockInstanceGeneralSettings.censorUsernameInLogs = false;
      const homeDir = os.homedir();
      mockWorkspaceOperationService.listForExecutionWorkspace.mockResolvedValue([
        workspaceOperationFixture({ stdoutExcerpt: `cloned into ${homeDir}/checkout` }),
      ]);

      const res = await request(createApp("execution-workspaces")).get(
        "/api/execution-workspaces/workspace-1/workspace-operations",
      );

      expect(res.status).toBe(200);
      expect(res.body[0].stdoutExcerpt).toBe(`cloned into ${homeDir}/checkout`);
    });

    /**
     * Driven rather than source-pinned, at Ally's ask on the review of `024a330c`, and it is the
     * one that most deserved it: this exact handler is where the door was found. It masked
     * `workspace` and returned the sibling `operation` raw on the very next line — so a source
     * marker on the line above would have been green while the exit was open.
     *
     * The recorder is the seam that makes a 200 cheap. `recordOperation` owns the `run` callback,
     * so stubbing it hands back a recorded row without executing command resolution, the
     * service start/stop, or workspace provisioning. `action=stop` is the branch with no
     * `workspaceCommand` or `runtimeConfig` precondition, so nothing upstream short-circuits.
     */
    function arrangeProjectRuntimeCommand() {
      mockProjectService.getById.mockResolvedValue({
        id: "project-1",
        companyId: "company-1",
        workspaces: [projectWorkspaceFixture()],
      });
      mockWorkspaceOperationService.createRecorder.mockReturnValue({
        recordOperation: vi.fn(async () => workspaceOperationFixture()),
      });
    }

    it("withholds on POST /projects/:id/workspaces/:workspaceId/runtime-services/:action", async () => {
      arrangeProjectRuntimeCommand();

      const res = await request(createApp("projects"))
        .post("/api/projects/project-1/workspaces/project-workspace-1/runtime-services/stop")
        .send({});

      expect(res.status).toBe(200);
      // The sibling that was raw. All three sentinels, against the serialized body — a field-level
      // assertion alone would miss `metadata`, which has no closed shape.
      expect(JSON.stringify(res.body)).not.toContain(OPERATION_COMMAND_SENTINEL);
      expect(JSON.stringify(res.body)).not.toContain(OPERATION_CWD_SENTINEL);
      expect(JSON.stringify(res.body)).not.toContain(OPERATION_METADATA_SENTINEL);
      expect(res.body.operation.command).toBe(REDACTED_EVENT_VALUE);
      expect(res.body.operation.cwd).toBe(REDACTED_EVENT_VALUE);
      // Withholding the operator's text is the point; hiding that an operation ran is not.
      expect(res.body.operation.phase).toBe("workspace_provision");
      expect(res.body.operation.status).toBe("succeeded");
      // The workspace half in the same literal, so this pins both exits of the one response.
      expect(JSON.stringify(res.body)).not.toContain(SECRET_SENTINEL);
      expect(JSON.stringify(res.body)).not.toContain(SECOND_SENTINEL);
    });

    it("discloses the operation to a reader holding workspace_runtime:read", async () => {
      decideAsRuntimeManager();
      arrangeProjectRuntimeCommand();

      const res = await request(createApp("projects"))
        .post("/api/projects/project-1/workspaces/project-workspace-1/runtime-services/stop")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.operation.command).toBe(OPERATION_COMMAND_SENTINEL);
      expect(res.body.operation.cwd).toBe(OPERATION_CWD_SENTINEL);
      expect(JSON.stringify(res.body)).toContain(OPERATION_METADATA_SENTINEL);
    });

    /**
     * The other two call sites, pinned against the route SOURCE rather than driven.
     *
     * Both are real exits and neither is cheap to reach with a 200: the POST runs the whole
     * runtime-command path (command resolution, the recorder, workspace provisioning) before it
     * reaches its response literal, and the heartbeat-run route lives in `agents.ts`, whose router
     * needs ~30 services mocked to mount. A source assertion is weaker than a driven one and is
     * stated as such — but it fails loudly if someone deletes the wrapper, which is the regression
     * this door actually had.
     */
    it.each([
      {
        module: "execution-workspaces.ts",
        marker: "operation: publicWorkspaceOperation(operation, viewer)",
        site: "POST /execution-workspaces/:id/runtime-services/:action",
      },
      {
        module: "agents.ts",
        marker: "publicWorkspaceOperations(operations, viewer)",
        site: "GET /heartbeat-runs/:runId/workspace-operations",
      },
    ])("$site routes its operations through the withholding boundary", ({ module, marker }) => {
      const source = readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "routes", module),
        "utf8",
      );
      expect(source).toContain(marker);
    });
  });
});

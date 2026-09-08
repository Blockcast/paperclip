import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listWorkspaceCommandDefinitions,
  matchWorkspaceRuntimeServiceToCommand,
} from "@paperclipai/shared";
import { maskWorkspaceRuntimeForRead, REDACTED_EVENT_VALUE } from "../redaction.js";

/**
 * PEN-2854, door #14 of the PEN-2370 series.
 *
 * `compactIssueExecutionWorkspace` masks `config.workspaceRuntime`, then ~50
 * lines later emitted `runtimeServices[].command` / `.cwd` verbatim — the SAME
 * operator-authored strings, promoted onto typed columns when the service
 * started. One response body carried a masked copy and a cleartext copy.
 *
 * Every fixture value below is invented. No real credential appears in this
 * file, and no populated workspace was ever fetched to write it.
 */

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "44444444-4444-4444-8444-444444444444";
const runId = "55555555-5555-4555-8555-555555555555";
const serviceId = "66666666-6666-4666-8666-666666666666";

/** Invented. Shaped like the inline-assignment idiom `sh -c` makes normal. */
const INVENTED_TOKEN = "pen2854-invented-not-a-real-credential";
const OPERATOR_COMMAND = `API_TOKEN=${INVENTED_TOKEN} npm run dev`;
const OPERATOR_CWD = "/srv/tenant-acme/checkout";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getAncestors: vi.fn(async () => []),
  getComment: vi.fn(async () => null),
  getCommentCursor: vi.fn(async () => null),
  getCurrentScheduledRetry: vi.fn(async () => null),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [], relatedWork: [] })),
  listAttachments: vi.fn(async () => []),
  listBlockerAttention: vi.fn(async () => new Map()),
  listProductivityReviews: vi.fn(async () => new Map()),
  getBlockerDiagnostics: vi.fn(async () => null),
  listLabels: vi.fn(async () => []),
  findMentionedProjectIds: vi.fn(async () => []),
  getActiveInboxArchiveFields: vi.fn(async () => ({})),
  getActiveRun: vi.fn(async () => null),
  getSubtreeDiagnostics: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(async () => null),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({ getById: vi.fn() }));

function registerRouteMocks() {
  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => ({ getExperimental: vi.fn(async () => ({})) }),
  }));

  vi.doMock("../services/execution-workspaces.js", () => ({
    executionWorkspaceService: () => mockExecutionWorkspaceService,
  }));

  vi.doMock("../services/task-watchdog-scope.js", () => ({
    TASK_WATCHDOG_ORIGIN_KIND: "task_watchdog",
    resolveTaskWatchdogMutationScope: vi.fn(async () => ({ kind: "none" })),
    taskWatchdogScopeAllowsIssueMutation: vi.fn(async () => ({ kind: "none" })),
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companySkillService: () => ({}),
    companyService: () => ({ getById: vi.fn(async () => null) }),
    companySearchService: () => ({}),
    documentAnnotationService: () => ({}),
    documentService: () => ({
      getIssueDocumentByKey: vi.fn(async () => null),
      getIssueDocumentPayload: vi.fn(async () => null),
    }),
    executionWorkspaceService: () => mockExecutionWorkspaceService,
    externalObjectService: () => ({
      getIssueSummary: vi.fn(async () => null),
      getIssueSummaries: vi.fn(async () => new Map()),
      listForIssue: vi.fn(async () => []),
    }),
    feedbackService: () => ({}),
    goalService: () => ({
      getDefaultCompanyGoal: vi.fn(async () => null),
      getById: vi.fn(async () => null),
    }),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
    }),
    issueApprovalService: () => ({}),
    issueRecoveryActionService: () => ({ getActiveForIssue: vi.fn(async () => null) }),
    issueReferenceService: () => ({
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => ({}),
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({ listByIds: vi.fn(async () => []) }),
    routineService: () => ({}),
    workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
  }));
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: agentId,
    assigneeUserId: null,
    identifier: "PEN-2854",
    title: "Door #14",
    executionWorkspaceId: workspaceId,
    ...overrides,
  };
}

/**
 * A runtime-service row as `loadEffectiveRuntimeServicesByExecutionWorkspace`
 * hydrates it: `command`/`cwd` already copied off the operator's
 * `workspaceRuntime` entry by `resolveRuntimeServiceReuseIdentity`.
 */
function makeRuntimeService(overrides: Record<string, unknown> = {}) {
  return {
    id: serviceId,
    companyId,
    projectId: null,
    projectWorkspaceId: null,
    executionWorkspaceId: workspaceId,
    issueId,
    scopeType: "execution_workspace",
    scopeId: workspaceId,
    serviceName: "api",
    status: "running",
    lifecycle: "shared",
    reuseKey: "sha256-digest-not-the-env",
    command: OPERATOR_COMMAND,
    cwd: OPERATOR_CWD,
    port: 3000,
    url: "http://127.0.0.1:3000",
    provider: "local_process",
    providerRef: "12345",
    ownerAgentId: agentId,
    startedByRunId: runId,
    lastUsedAt: new Date("2026-09-08T00:00:00.000Z"),
    startedAt: new Date("2026-09-08T00:00:00.000Z"),
    stoppedAt: null,
    healthStatus: "healthy",
    configIndex: 0,
    createdAt: new Date("2026-09-08T00:00:00.000Z"),
    updatedAt: new Date("2026-09-08T00:00:00.000Z"),
    ...overrides,
  };
}

function makeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: workspaceId,
    companyId,
    projectId: null,
    projectWorkspaceId: null,
    sourceIssueId: issueId,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "ws",
    status: "ready",
    branchName: "feat/x",
    cwd: "/srv/tenant-acme/checkout",
    config: {
      workspaceRuntime: {
        services: [{ name: "api", command: OPERATOR_COMMAND, cwd: OPERATOR_CWD }],
      },
    },
    runtimeConfig: null,
    metadata: null,
    runtimeServices: [makeRuntimeService()],
    createdAt: new Date("2026-09-08T00:00:00.000Z"),
    updatedAt: new Date("2026-09-08T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * The issue-detail route issues several auxiliary drizzle queries (comments,
 * relations, ordering) whose rows this projection does not depend on — the
 * issue itself comes from the mocked `issueService`, and the workspace from the
 * mocked `executionWorkspaceService`. A chainable stub that resolves empty lets
 * the route run without a database.
 */
function makeQueryChain(rows: unknown[] = []) {
  const chain: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve(rows).then(resolve, reject);
        }
        return () => chain;
      },
    },
  );
  return chain;
}

async function createApp() {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const routeDb = { select: vi.fn(() => makeQueryChain([])) };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "agent",
      agentId,
      companyId,
      keyId: "key-1",
      runId,
      source: "agent_key",
    } as Express.Request["actor"];
    next();
  });
  app.use("/api", issueRoutes(routeDb as any, { provider: "local_disk" } as any));
  app.use(errorHandler);
  return app;
}

describe("issue projection masks runtime-service command/cwd (PEN-2854, door #14)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../services/index.js");
    registerRouteMocks();
    vi.resetAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockExecutionWorkspaceService.getById.mockResolvedValue(makeWorkspace());
    mockAgentService.list.mockResolvedValue([]);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async ({ action }: { action: string }) => ({
      allowed: action === "issue:read" || action === "issue:mutate",
      explanation: "Denied by test mock",
    }));
  });

  it("masks command and cwd on GET /issues/:id", async () => {
    const app = await createApp();
    const res = await request(app).get(`/api/issues/${issueId}`);

    expect(res.status).toBe(200);
    const service = res.body.currentExecutionWorkspace.runtimeServices[0];
    expect(service.command).toBe(REDACTED_EVENT_VALUE);
    expect(service.cwd).toBe(REDACTED_EVENT_VALUE);
    // The whole-body check is what makes this a bypass test rather than a field
    // test: door #12 masked the `config` copy, so an unmasked `runtimeServices`
    // copy left the same string reachable elsewhere in the SAME response.
    expect(JSON.stringify(res.body)).not.toContain(INVENTED_TOKEN);
  });

  it("masks command and cwd on GET /issues/:id/heartbeat-context", async () => {
    // The second of the two routes through this projection. `paperclipGetIssueWorkspaceRuntime`
    // and `paperclipGetHeartbeatContext` both read this one.
    const app = await createApp();
    const res = await request(app).get(`/api/issues/${issueId}/heartbeat-context`);

    expect(res.status).toBe(200);
    const service = res.body.currentExecutionWorkspace.runtimeServices[0];
    expect(service.command).toBe(REDACTED_EVENT_VALUE);
    expect(service.cwd).toBe(REDACTED_EVENT_VALUE);
    expect(JSON.stringify(res.body)).not.toContain(INVENTED_TOKEN);
  });

  // ---------------------------------------------------------------------
  // Over-reach and coupling guards. These are green against the unfixed
  // pass-through by construction — they are NOT fail-first evidence and are not
  // counted in the red total. They exist to fail if this change masks more than
  // it should, or if a later change un-masks one side of the pair.
  // ---------------------------------------------------------------------

  it("documents why both sides must be masked together, not one alone", () => {
    // Pure-function test over shared helpers: green before and after this
    // change. It is here to pin the *coupling*, so that un-masking either side
    // later fails with an explanation rather than silently degrading the UI.
    //
    // `IssueProperties.tsx` derives command definitions from
    // `currentExecutionWorkspace.config.workspaceRuntime` — which door #12 masks —
    // and matches them against `runtimeServices` from the same response.
    // `scoreWorkspaceRuntimeServiceMatch` disqualifies outright on a `command`
    // mismatch, so masking the definition side while leaving the service side
    // verbatim makes every configured service stop matching.
    const maskedRuntimeConfig = maskWorkspaceRuntimeForRead({
      services: [{ name: "api", command: OPERATOR_COMMAND, cwd: OPERATOR_CWD }],
    }) as Record<string, unknown>;
    const [definition] = listWorkspaceCommandDefinitions(maskedRuntimeConfig);

    // Unmasked service row against the masked definition: no match.
    expect(matchWorkspaceRuntimeServiceToCommand(definition, [makeRuntimeService() as any])).toBeNull();

    // Masked on both sides, as this change makes the projection emit: matches again.
    const masked = makeRuntimeService({
      command: REDACTED_EVENT_VALUE,
      cwd: REDACTED_EVENT_VALUE,
    });
    expect(matchWorkspaceRuntimeServiceToCommand(definition, [masked as any])?.id).toBe(serviceId);
  });

  it("keeps the fields the MCP control and wait tools address a service by", async () => {
    // `paperclipWaitForIssueWorkspaceService` returns `url` and selects on
    // `id`/`serviceName`/`status`; `url` is a generated local address, not
    // operator free text. `providerRef` is a pid.
    const app = await createApp();
    const res = await request(app).get(`/api/issues/${issueId}`);

    const service = res.body.currentExecutionWorkspace.runtimeServices[0];
    expect(service.id).toBe(serviceId);
    expect(service.serviceName).toBe("api");
    expect(service.status).toBe("running");
    expect(service.url).toBe("http://127.0.0.1:3000");
    expect(service.port).toBe(3000);
    expect(service.providerRef).toBe("12345");
    expect(service.configIndex).toBe(0);
  });

  it("passes a null command/cwd through instead of inventing a sentinel", async () => {
    // `null` carries nothing, and `scoreWorkspaceRuntimeServiceMatch` guards on
    // truthiness before comparing — turning it into a string would change
    // matching behaviour rather than only hiding a value.
    mockExecutionWorkspaceService.getById.mockResolvedValue(
      makeWorkspace({ runtimeServices: [makeRuntimeService({ command: null, cwd: null })] }),
    );
    const app = await createApp();
    const res = await request(app).get(`/api/issues/${issueId}`);

    const service = res.body.currentExecutionWorkspace.runtimeServices[0];
    expect(service.command).toBeNull();
    expect(service.cwd).toBeNull();
  });
});

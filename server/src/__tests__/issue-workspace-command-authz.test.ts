import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_PERMITTED_ISSUE_ADAPTER_CONFIG_KEYS,
  collectAgentDisallowedIssueAdapterConfigPaths,
  collectAgentDisallowedIssueWorkspaceRuntimePaths,
} from "../routes/workspace-command-authz.js";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  create: vi.fn(),
  findMentionedAgents: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(),
  saveIssueVote: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
  reportRunActivity: vi.fn(),
  getRun: vi.fn(),
  getActiveRunForAgent: vi.fn(),
  cancelRun: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  listCompanyIds: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(),
}));

const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([{ companyId: "company-1", agentId: "agent-1", contextSnapshot: null }]).then(
      onFulfilled,
      onRejected,
    ),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
}));

function registerRouteMocks() {
  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/execution-workspaces.js", () => ({
    executionWorkspaceService: () => mockExecutionWorkspaceService,
  }));

  vi.doMock("../services/feedback.js", () => ({
    feedbackService: () => mockFeedbackService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/routines.js", () => ({
    routineService: () => mockRoutineService,
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => mockExecutionWorkspaceService,
    feedbackService: () => mockFeedbackService,
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => mockInstanceSettingsService,
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueThreadInteractionService: () => ({
      listForIssue: vi.fn(async () => []),
      expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
      expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    }),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => mockRoutineService,
    workProductService: () => ({}),
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByUserId: "board-user",
    identifier: "PAP-1000",
    title: "Workspace authz",
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("issue workspace command authorization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/execution-workspaces.js");
    vi.doUnmock("../services/feedback.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/routines.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockIssueService.addComment.mockResolvedValue(null);
    mockIssueService.create.mockResolvedValue(makeIssue());
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.update.mockResolvedValue(makeIssue());
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: null,
    });
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    mockFeedbackService.listIssueVotesForUser.mockResolvedValue([]);
    mockFeedbackService.saveIssueVote.mockResolvedValue({
      vote: null,
      consentEnabledNow: false,
      sharingEnabled: false,
    });
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockLogActivity.mockResolvedValue(undefined);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{ companyId: "company-1", agentId: "agent-1", contextSnapshot: null }]).then(
          onFulfilled,
          onRejected,
        ),
    }));
  });

  it("rejects agent callers that create issue workspace provision commands", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Exploit",
        executionWorkspaceSettings: {
          workspaceStrategy: {
            type: "git_worktree",
            provisionCommand: "touch /tmp/paperclip-rce",
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("host-executed workspace commands");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects agent callers that patch assignee adapter workspace teardown commands", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .send({
        assigneeAdapterOverrides: {
          adapterConfig: {
            workspaceStrategy: {
              type: "git_worktree",
              teardownCommand: "rm -rf /tmp/paperclip-rce",
            },
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("host-executed workspace commands");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // PEN-6418. The two tests above pin the DENYLIST arm, and they also pin the
  // ORDER: the host-command refusal is evaluated first, so a body that trips
  // both guards still reports the command message. Do not reorder the two
  // asserts in `assertNoAgentIssueHostControlledMutation` without updating
  // them -- the command message is the more specific of the two and names the
  // path that actually reaches a shell.

  it("pins the agent adapter-config allowlist membership", () => {
    // Empty on purpose (PEN-6418). Adding a key here is a deliberate act and
    // must come with the reason it is safe for the LOWEST-privileged writer of
    // an issue, not merely for the UI.
    expect([...AGENT_PERMITTED_ISSUE_ADAPTER_CONFIG_KEYS].sort()).toEqual([]);
  });

  it("collects every adapter-config key an agent supplies, not only named ones", () => {
    expect(
      collectAgentDisallowedIssueAdapterConfigPaths({
        assigneeAdapterOverrides: {
          adapterConfig: { serviceAccountName: "paperclip-admin", image: "evil:latest" },
        },
      }),
    ).toEqual([
      "assigneeAdapterOverrides.adapterConfig.image",
      "assigneeAdapterOverrides.adapterConfig.serviceAccountName",
    ]);
    // Nothing to overlay is nothing to refuse.
    expect(
      collectAgentDisallowedIssueAdapterConfigPaths({
        assigneeAdapterOverrides: { adapterConfig: {} },
      }),
    ).toEqual([]);
    expect(
      collectAgentDisallowedIssueAdapterConfigPaths({
        assigneeAdapterOverrides: { modelProfile: "cheap" },
      }),
    ).toEqual([]);
    expect(collectAgentDisallowedIssueAdapterConfigPaths({})).toEqual([]);
  });

  it("rejects agent callers that create an issue adapter config override", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Overlay",
        assigneeAdapterOverrides: { adapterConfig: { graceSec: 15 } },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("issue adapter config overrides");
    expect(res.body.error).toContain("assigneeAdapterOverrides.adapterConfig.graceSec");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects agent callers that patch an issue adapter config override", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .send({ assigneeAdapterOverrides: { adapterConfig: { serviceAccountName: "paperclip-admin" } } });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("issue adapter config overrides");
    expect(res.body.error).toContain("assigneeAdapterOverrides.adapterConfig.serviceAccountName");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects agent callers that create a child issue adapter config override", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/issues/issue-1/children")
      .send({
        title: "Child overlay",
        assigneeAdapterOverrides: { adapterConfig: { image: "evil:latest" } },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("issue adapter config overrides");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  // MUST-PASS ARM. A refusal-only suite passes against a guard that refuses
  // everything, so each of the next three asserts a PROGRESS MARKER -- the
  // create/update mock having been reached -- and not merely `status !== 403`,
  // which is satisfied by a request that dies before the guard.
  it("admits an agent write of the typed modelProfile sibling", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Sanctioned model selection",
        assigneeAdapterOverrides: { modelProfile: "cheap" },
      });

    expect(res.status).not.toBe(403);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  it("admits an agent write carrying an empty adapter config", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Nothing to overlay",
        assigneeAdapterOverrides: { adapterConfig: {} },
      });

    expect(res.status).not.toBe(403);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  // NON-AGENT CONTROL. The guard returns early for any actor that is not an
  // agent, so the board/UI "custom model lane" (ui/src/lib/issue-assignee-overrides.ts,
  // which emits `adapterConfig.model` / `.effort` / `.chrome`) is untouched.
  // Without this arm an allowlist that refused EVERY actor would also pass.
  it("leaves a user actor's adapter config override alone", async () => {
    const app = await createApp({
      type: "user",
      userId: "board-user",
      companyId: "company-1",
      source: "session",
    });

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Board custom lane",
        assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5", chrome: true } },
      });

    expect(res.status).not.toBe(403);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // PEN-6430 — `executionWorkspaceSettings.workspaceRuntime`, the second bare
  // open record on this write surface. Refused WHOLE for an agent actor rather
  // than allowlisted, because no grant row can deliver `workspace_runtime:read`
  // — so there is no key an agent could write and then verify.
  // ---------------------------------------------------------------------------

  it("collects the workspace-runtime path for every non-nullish value an agent supplies", () => {
    const WRPATH = "executionWorkspaceSettings.workspaceRuntime";
    // MUST-FIRE. A populated record is the obvious arm; the other three are the
    // ones a key-enumerating guard (`adapterConfig`'s shape) would MISS.
    expect(
      collectAgentDisallowedIssueWorkspaceRuntimePaths({
        executionWorkspaceSettings: {
          workspaceRuntime: { services: [{ name: "web", command: "touch /tmp/pwn" }] },
        },
      }),
    ).toEqual([WRPATH]);
    // `{}` is REFUSED even though the sibling `adapterConfig: {}` is admitted,
    // and the asymmetry is deliberate: that guard enumerates keys, so an empty
    // record yields no paths, while here an empty record is a real VALUE.
    // `parseIssueExecutionWorkspaceSettings` emits `{ workspaceRuntime: {} }`
    // for it (`{}` is truthy), and BLO-27706's own control proves a supplied
    // value is written THROUGH to the shared `config.workspaceRuntime` — so an
    // empty record REPLACES whatever services an operator configured.
    expect(
      collectAgentDisallowedIssueWorkspaceRuntimePaths({
        executionWorkspaceSettings: { workspaceRuntime: {} },
      }),
    ).toEqual([WRPATH]);
    // Non-record values too: the schema is `z.record(...)`, but the guard reads
    // the RAW body, and refusing on presence rather than on shape also stops an
    // agent writing the PEN-3252 read mask back over a live operator record.
    expect(
      collectAgentDisallowedIssueWorkspaceRuntimePaths({
        executionWorkspaceSettings: { workspaceRuntime: ["pnpm dev"] },
      }),
    ).toEqual([WRPATH]);
    expect(
      collectAgentDisallowedIssueWorkspaceRuntimePaths({
        executionWorkspaceSettings: { workspaceRuntime: "[redacted]" },
      }),
    ).toEqual([WRPATH]);

    // MUST-REFUSE. Each of these is a live shape: the company-wide census
    // behind this guard (PEN-6430 §DW1, 5,838 rows, 0 read errors) found the
    // COMPLETE key set on this field object to be `mode` (2,183 rows) and
    // `workspaceStrategy` (4 rows), plus 373 empty objects — and ZERO rows
    // carrying `workspaceRuntime` at all.
    expect(
      collectAgentDisallowedIssueWorkspaceRuntimePaths({
        executionWorkspaceSettings: { mode: "shared_workspace" },
      }),
    ).toEqual([]);
    expect(
      collectAgentDisallowedIssueWorkspaceRuntimePaths({
        executionWorkspaceSettings: { workspaceStrategy: { type: "git_worktree" } },
      }),
    ).toEqual([]);
    expect(
      collectAgentDisallowedIssueWorkspaceRuntimePaths({
        executionWorkspaceSettings: {},
      }),
    ).toEqual([]);
    // `null` is the one admitted write, and for a measured reason:
    // `parseIssueExecutionWorkspaceSettings` DROPS a nullish value, and
    // BLO-27706 makes an absent key mean "leave the shared workspace config
    // intact", so it provably cannot reach `config.workspaceRuntime` at all.
    // It can only remove the key from the issue row's own settings, which is
    // the one undo an agent has for a field it cannot read back.
    expect(
      collectAgentDisallowedIssueWorkspaceRuntimePaths({
        executionWorkspaceSettings: { mode: "shared_workspace", workspaceRuntime: null },
      }),
    ).toEqual([]);
    expect(collectAgentDisallowedIssueWorkspaceRuntimePaths({ executionWorkspaceSettings: "nope" })).toEqual([]);
    expect(collectAgentDisallowedIssueWorkspaceRuntimePaths({})).toEqual([]);
  });

  it("rejects agent callers that create an issue workspace runtime config", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Runtime overlay",
        executionWorkspaceSettings: {
          workspaceRuntime: { services: [{ name: "web", command: "touch /tmp/paperclip-rce" }] },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("issue execution workspace runtime config");
    expect(res.body.error).toContain("executionWorkspaceSettings.workspaceRuntime");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects agent callers that patch an issue workspace runtime config", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .send({ executionWorkspaceSettings: { workspaceRuntime: { profile: "agent" } } });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("issue execution workspace runtime config");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects agent callers that create a child issue workspace runtime config", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/issues/issue-1/children")
      .send({
        title: "Child runtime overlay",
        executionWorkspaceSettings: { workspaceRuntime: { services: [] } },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("issue execution workspace runtime config");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  // ORDER PIN. Three asserts now run inside
  // `assertNoAgentIssueHostControlledMutation` and every ordering refuses the
  // same bodies, so these pin the MESSAGE, not the verdict. The host-command
  // refusal stays first because it names the literal command string; the two
  // whole-field refusals are at the same level of specificity and their order
  // is arbitrary, which is exactly why it is written down.
  it("reports the host-command message when a body trips the command denylist and the runtime refusal", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Both",
        executionWorkspaceSettings: {
          workspaceStrategy: { type: "git_worktree", provisionCommand: "touch /tmp/a" },
          workspaceRuntime: { services: [{ name: "web", command: "touch /tmp/b" }] },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("host-executed workspace commands");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("reports the adapter-config message when a body trips both whole-field refusals", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Both fields",
        assigneeAdapterOverrides: { adapterConfig: { image: "evil:latest" } },
        executionWorkspaceSettings: { workspaceRuntime: { profile: "agent" } },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("issue adapter config overrides");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  // MUST-PASS ARMS. Each asserts the create mock was REACHED, not merely that
  // the status is not 403 — a request that dies before the guard satisfies the
  // weaker form.
  it("admits an agent write of the typed executionWorkspaceSettings keys the census found live", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Sanctioned workspace settings",
        executionWorkspaceSettings: {
          mode: "shared_workspace",
          workspaceStrategy: { type: "git_worktree", runScope: "per_run" },
        },
      });

    expect(res.status).not.toBe(403);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  it("admits an agent write that clears workspaceRuntime with null", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Clear it",
        executionWorkspaceSettings: { mode: "shared_workspace", workspaceRuntime: null },
      });

    expect(res.status).not.toBe(403);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  // NON-AGENT CONTROL. Without this arm a refusal that applied to EVERY actor
  // would also pass every test above. `workspaceRuntime` is an operator-authored
  // field and the board/UI path must keep writing it.
  it("leaves a user actor's workspace runtime config alone", async () => {
    const app = await createApp({
      type: "user",
      userId: "board-user",
      companyId: "company-1",
      source: "session",
    });

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Operator runtime services",
        executionWorkspaceSettings: {
          mode: "shared_workspace",
          workspaceRuntime: { services: [{ name: "portal", command: "pnpm dev", port: 5173 }] },
        },
      });

    expect(res.status).not.toBe(403);
    expect(mockIssueService.create).toHaveBeenCalled();
  });
});

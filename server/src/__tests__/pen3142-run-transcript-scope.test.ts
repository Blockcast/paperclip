import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PEN-3142 — run *transcript* reads are scoped to own-run + manager chain +
 * human operators + an explicit `runs:read_transcript` grant, on BOTH transcript
 * routes. Run *state* is deliberately untouched and this file pins that too:
 * `denies-nothing-extra` below fails if the narrowing overshoots into state,
 * which the PEN-3140 decision calls out as wrong.
 *
 * The decider itself is pinned against the real service in
 * `authorization-service.test.ts`; `access.decide` is stubbed here so each route
 * arm can be exercised independently of how the decision was reached.
 */

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  buildRunOutputSilence: vi.fn(),
  decorateActiveRunStatus: vi.fn(),
  getRetryExhaustedReason: vi.fn(),
  getRetrySuccessor: vi.fn(),
  cancelRun: vi.fn(),
  getRun: vi.fn(),
  getRunIssueSummary: vi.fn(),
  getActiveRunIssueSummaryForAgent: vi.fn(),
  getRunLogAccess: vi.fn(),
  list: vi.fn(),
  listEvents: vi.fn(),
  readLog: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForRun: vi.fn(),
  listForExecutionWorkspace: vi.fn(),
  getById: vi.fn(),
  readLog: vi.fn(),
  owningAgentIdsByRunId: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
  listCompanyIds: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockDecide = vi.hoisted(() => vi.fn());

const runOwnerAgentId = "22222222-2222-4222-8222-222222222222";
const peerAgentId = "33333333-3333-4333-8333-333333333333";

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
    derivePaperclipPrReview: () => null,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({}),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      decide: mockDecide,
      hasPermission: vi.fn(async () => true),
    }),
    approvalService: () => ({}),
    builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => ({}),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    secretService: () => ({}),
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => mockWorkspaceOperationService,
    executionWorkspaceService: () => mockExecutionWorkspaceService,
  }));

  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
    findActiveServerAdapter: vi.fn(),
    requireServerAdapter: vi.fn(),
  }));
}

const boardActor = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

const peerAgentActor = {
  type: "agent",
  agentId: peerAgentId,
  companyId: "company-1",
  source: "agent_key",
  runId: "actor-run-1",
};

const ownerAgentActor = {
  type: "agent",
  agentId: runOwnerAgentId,
  companyId: "company-1",
  source: "agent_key",
  runId: "run-1",
};

async function createApp(actor: Record<string, unknown> = boardActor) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

/**
 * PEN-3204: the third read route lives in a different router, so it needs its own
 * app. Mounting only `agentRoutes` is exactly how a gate gets added to two of
 * three sibling paths and the third is never exercised.
 */
async function createWorkspaceApp(actor: Record<string, unknown> = boardActor) {
  const [{ executionWorkspaceRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/execution-workspaces.js")>("../routes/execution-workspaces.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", executionWorkspaceRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

/**
 * Minimal thenable stand-in for the drizzle query builder. Every chain method
 * returns the same object and the object itself resolves to `rows`, which is
 * what lets it serve both terminal shapes these routes use:
 * `…orderBy(…)` awaited directly, and `…orderBy(…)` held in a variable and
 * then awaited via `.limit(n)`.
 */
function stubDb(rows: Record<string, unknown>[]) {
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  for (const method of ["select", "from", "innerJoin", "leftJoin", "where", "orderBy", "limit", "offset", "groupBy"]) {
    chain[method] = () => chain;
  }
  return chain as unknown;
}

async function createAppWithDb(actor: Record<string, unknown>, rows: Record<string, unknown>[]) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", agentRoutes(stubDb(rows) as any, {} as any));
  app.use(errorHandler);
  return app;
}

async function requestApp<T>(app: express.Express, run: (baseUrl: string) => Promise<T> | T) {
  const server = app.listen(0);
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function auditCallsFor(action: string) {
  return mockLogActivity.mock.calls.filter((call) => call[1]?.action === action);
}

/**
 * PEN-3204 fixtures. `WORKSPACE_OP_CANARY` is the string that must never reach an
 * unentitled reader through any of the three workspace-operation read routes.
 *
 * `runAttachedOperation` has an owning agent reachable via `heartbeatRunId`;
 * `runlessCleanupOperation` has `heartbeatRunId: null`, which `listForRun`
 * deliberately returns for workspace-scoped cleanup and which no owner lookup can
 * resolve. The second one is the fail-closed branch and is the reason the map-miss
 * must withhold rather than fall open.
 */
const WORKSPACE_OP_CANARY = "npm ERR! authToken=npm_not-a-real-token";

const runAttachedOperation = {
  id: "op-1",
  companyId: "company-1",
  executionWorkspaceId: "workspace-1",
  heartbeatRunId: "run-1",
  issueId: "issue-1",
  phase: "workspace_provision",
  command: "git clone https://github.com/example/repo.git",
  cwd: "/workspaces/repo",
  status: "succeeded",
  exitCode: 0,
  logStore: "db",
  logRef: "op-1.log",
  logBytes: 2048,
  logSha256: "abc123",
  logCompressed: false,
  stdoutExcerpt: WORKSPACE_OP_CANARY,
  stderrExcerpt: `stderr also carries it: ${WORKSPACE_OP_CANARY}`,
  metadata: { worktreePath: "/workspaces/repo" },
  startedAt: new Date("2026-09-10T03:50:00.000Z"),
  finishedAt: new Date("2026-09-10T03:51:00.000Z"),
  createdAt: new Date("2026-09-10T03:50:00.000Z"),
  updatedAt: new Date("2026-09-10T03:51:00.000Z"),
};

const runlessCleanupOperation = {
  ...runAttachedOperation,
  id: "op-2",
  heartbeatRunId: null,
  issueId: null,
  phase: "workspace_cleanup",
  command: "rm -rf /workspaces/repo",
  exitCode: 0,
};

describe("run transcript scoping (PEN-3142)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/execution-workspaces.js");
    vi.doUnmock("../routes/authz.js");
    registerModuleMocks();
    vi.clearAllMocks();

    mockLogActivity.mockResolvedValue(undefined);
    // Default to DENIED so a test that means to exercise an allow has to say so.
    // A default-allow stub would make every withhold assertion below pass for
    // the wrong reason.
    mockDecide.mockImplementation(async (input: { action?: string }) => ({
      allowed: false,
      action: input.action,
      reason: "deny_missing_grant",
      explanation: "Missing permission: runs:read_transcript.",
    }));

    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    });
    mockInstanceSettingsService.getExperimental.mockResolvedValue({});
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);

    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: runOwnerAgentId,
      status: "failed",
      error: "Run hit provider throttle before any token usage",
      errorCode: "rate_limit_exhausted",
      scheduledRetryAt: new Date("2026-09-10T04:00:00.000Z"),
      scheduledRetryReason: "transient_failure",
      lastActivityAt: new Date("2026-09-10T03:59:00.000Z"),
      contextSnapshot: { executionWorkspaceId: "workspace-1" },
      // PEN-3149: transcript content that rides the run-STATE row.
      stdoutExcerpt: "ANTHROPIC_API_KEY=sk-live-not-a-real-key",
      stderrExcerpt: "traceback: vendor call failed with sk-live-not-a-real-key",
      logBytes: 4096,
      resultJson: {
        // free text the adapter fills from run output — withheld
        result: "I finished by exporting sk-live-not-a-real-key",
        summary: "ran the deploy and printed the key",
        message: "done",
        stdout: "sk-live-not-a-real-key",
        stderr: "warn",
        // machine keys live diagnosis depends on — kept
        status: "error",
        stopReason: "max_turns",
        errorFamily: "provider_capacity",
        penstockReason: "throttled",
        retryNotBefore: "2026-09-10T04:00:00.000Z",
        error: "provider returned 429",
        totalCostUsd: 0.42,
        // An adapter key no list mentions, carrying the canary. `resultJson` is
        // an open `Record<string, unknown>` written verbatim from the adapter
        // result event, and PEN-3153 establishes nothing scrubs it on the write
        // path -- so a denylist of the five free-text keys we happen to know
        // passes this straight through to an unentitled peer. Ally's review of
        // PR #1741 flagged exactly this.
        adapterVerboseOutput: "echo ANTHROPIC_API_KEY=sk-live-not-a-real-key",
        // Unenumerated VENDOR counters. A key allowlist drops these; the
        // value-shape rule keeps them, because a number cannot carry prose.
        num_turns: 17,
        duration_api_ms: 4821,
        is_error: true,
        // Prose nested inside an otherwise machine block. An earlier cut of
        // this change allowlisted `workspaceValidation` WHOLE on the reasoning
        // that it is platform-authored -- which is true of `reasonCode` and
        // false of `plainLanguageReason`. Recursion is what catches it.
        workspaceValidation: {
          reasonCode: "git_worktree_not_reusable",
          plainLanguageReason: "clone failed: remote rejected sk-live-not-a-real-key",
          attempts: 2,
        },
      },
      // The `result_*` GENERATED columns, which `getRun` selects because
      // `heartbeatRunSafeColumns` spreads `getTableColumns(heartbeatRuns)`.
      // Postgres fills them as `left(result_json ->> '<key>', 500)`, so they
      // carry the SAME prose as the blob above under different top-level names.
      // A fixture that omits them lets the "no credential anywhere in the
      // response" assertion below pass vacuously — which is how the first cut
      // of this change shipped a projection that closed `resultJson` and left
      // its mirror open.
      resultSummary: "ran the deploy and printed the key",
      resultResult: "I finished by exporting sk-live-not-a-real-key",
      resultMessage: "done",
      // Error text stays company-readable, so this one must SURVIVE.
      resultError: "provider returned 429",
      // `nextAction` is persisted by `classifyRunLiveness` from
      // `extractNextAction`, which lifts the matched line VERBATIM (capped at
      // 500 chars) out of -- among others -- `resultJson.summary`/`.result`/
      // `.message`, `resultJson.stdout`/`.stderr`, `stdoutExcerpt` and
      // `stderrExcerpt`. Every one of those is withheld above, so a populated
      // `nextAction` re-exports the same credential one key over. Shaped like
      // real extractor output: a "Next ..." line carrying the canary.
      nextAction: "Next: rerun the deploy with ANTHROPIC_API_KEY=sk-live-not-a-real-key",
    });
    mockHeartbeatService.getRunLogAccess.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: runOwnerAgentId,
      logStore: "local_file",
      logRef: "logs/run-1.ndjson",
    });
    mockHeartbeatService.readLog.mockResolvedValue({
      runId: "run-1",
      store: "local_file",
      logRef: "logs/run-1.ndjson",
      content: "ANTHROPIC_API_KEY=sk-live-not-a-real-key",
      nextOffset: 40,
    });
    mockHeartbeatService.getRetryExhaustedReason.mockResolvedValue(null);
    mockHeartbeatService.getRetrySuccessor.mockResolvedValue({ state: "retried", runId: "run-2" });
    mockHeartbeatService.buildRunOutputSilence.mockResolvedValue(null);
    mockHeartbeatService.decorateActiveRunStatus.mockImplementation((run: Record<string, unknown>) => ({
      ...run,
      // PEN-3149: the live-status decoration is where the assistant prose and
      // the message derived from it enter the response.
      currentToolName: "Bash",
      lastAssistantSnippet: "I am about to echo sk-live-not-a-real-key",
      currentStatusMessage: "I am about to echo sk-live-not-a-real-key",
      currentStatusUpdatedAt: null,
    }));
    mockHeartbeatService.listEvents.mockResolvedValue([
      {
        id: "1",
        companyId: "company-1",
        runId: "run-1",
        agentId: runOwnerAgentId,
        seq: 7,
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        color: null,
        message: "Bounded retry exhausted for the vendor call",
        payload: { nextAction: "agent-authored continuation prose" },
        createdAt: new Date("2026-09-10T03:58:00.000Z"),
      },
      {
        id: "2",
        companyId: "company-1",
        runId: "run-1",
        agentId: runOwnerAgentId,
        seq: 8,
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        color: null,
        message: "adapter invocation",
        payload: { command: "claude --model opus", cwd: "/workspace" },
        createdAt: new Date("2026-09-10T03:59:00.000Z"),
      },
    ]);

    // PEN-3204: the fixture this row replaces was `{ id, companyId, kind, status }` —
    // no command, no excerpts — so it was SILENT on whether captured output crosses
    // the boundary, which is why a green run did not catch what Ally caught. It now
    // carries both halves: transcript that must go, and state that must survive.
    mockWorkspaceOperationService.listForRun.mockResolvedValue([
      runAttachedOperation,
      runlessCleanupOperation,
    ]);
    mockWorkspaceOperationService.listForExecutionWorkspace.mockResolvedValue([
      runAttachedOperation,
      runlessCleanupOperation,
    ]);
    mockWorkspaceOperationService.getById.mockResolvedValue(runAttachedOperation);
    mockWorkspaceOperationService.readLog.mockResolvedValue({
      content: WORKSPACE_OP_CANARY,
      offset: 0,
      nextOffset: 64,
      eof: true,
    });
    // Only `run-1` resolves to an owning agent. The cleanup row's `heartbeatRunId`
    // is null, so it is absent from this map — the fail-closed branch.
    mockWorkspaceOperationService.owningAgentIdsByRunId.mockImplementation(
      async (runIds: (string | null)[]) => {
        const owners = new Map<string, string>();
        for (const runId of runIds) if (runId === "run-1") owners.set("run-1", runOwnerAgentId);
        return owners;
      },
    );
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
    });
  });

  describe("GET /heartbeat-runs/:runId/log", () => {
    it("denies a same-company peer with no transcript entitlement, and audits it", async () => {
      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log?offset=0&limitBytes=64"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      // Named boundary vocabulary, not a new error string: a client can tell
      // this apart from a cross-tenant 404 and from a missing run. Asserted
      // under `details` because that is where `authorizationDeniedDetails`
      // puts it on every other denied route in the codebase — the point of
      // reusing the decider is that this response is shaped like the rest.
      expect(res.body.details).toMatchObject({
        reason: "deny_missing_grant",
        boundary: "grant",
      });
      // The point of the gate: the log is never read on a denied request, so no
      // transcript reaches the response or an error message.
      expect(mockHeartbeatService.readLog).not.toHaveBeenCalled();
      expect(JSON.stringify(res.body)).not.toContain("sk-live-not-a-real-key");

      const audits = auditCallsFor("heartbeat.run_log_accessed");
      expect(audits).toHaveLength(1);
      expect(audits[0]?.[1]).toMatchObject({
        companyId: "company-1",
        actorType: "agent",
        agentId: peerAgentId,
        entityId: "run-1",
        details: expect.objectContaining({ result: "denied", actorRunId: "actor-run-1" }),
      });
    });

    it("allows the run's own agent", async () => {
      mockDecide.mockImplementation(async (input: { action?: string }) => ({
        allowed: true,
        action: input.action,
        reason: "allow_self",
        explanation: "Allowed because the actor owns the run whose transcript it is reading.",
      }));

      const res = await requestApp(
        await createApp({ ...peerAgentActor, agentId: runOwnerAgentId }),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ runId: "run-1", nextOffset: 40 });
      expect(auditCallsFor("heartbeat.run_log_accessed")[0]?.[1]?.details).toMatchObject({
        result: "allowed",
      });
    });

    /**
     * REST half of the WS-vs-REST pair for Ally review 5449228335 (the socket
     * half is in `pen3142-live-event-transcript-scope.test.ts`). The decider
     * stub mirrors `decideSkillTestAccess`'s default-deny — pinned against the
     * real service in `authorization-service.test.ts` — and otherwise allows
     * the owner, so the scope is the only thing that can deny here.
     */
    it("denies a skill_test-scoped key its own run's transcript, because the actor carries the scope", async () => {
      mockDecide.mockImplementation(async (input: { action?: string; actor: { keyScope?: { kind?: string } } }) =>
        input.actor.keyScope?.kind === "skill_test"
          ? { allowed: false, action: input.action, reason: "deny_scope", explanation: "Skill-test run token cannot use this API action." }
          : { allowed: true, action: input.action, reason: "allow_self", explanation: "own run" });
      const keyScope = { kind: "skill_test", issueId: "55555555-5555-4555-8555-555555555555" };

      const res = await requestApp(
        await createApp({ ...ownerAgentActor, keyId: "key-1", keyScope }),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({
        action: "runs:read_transcript",
        actor: expect.objectContaining({ keyId: "key-1", keyScope }),
      }));
    });

    it("asks the decider about the run's OWNING agent, not the caller", async () => {
      await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log"),
      );

      // Scoping to the caller would make every read self-authorizing.
      expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({
        action: "runs:read_transcript",
        resource: { type: "agent", companyId: "company-1", agentId: runOwnerAgentId },
      }));
    });

    it("keeps the cross-tenant 404 posture rather than exposing the new 403", async () => {
      const res = await requestApp(
        await createApp({ ...peerAgentActor, companyId: "company-2" }),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log"),
      );

      // A 403 here would turn the transcript gate into an existence oracle for
      // another tenant's run ids.
      expect(res.status).toBe(404);
      expect(mockDecide).not.toHaveBeenCalled();
    });

    it("keeps the read for a human operator without consulting the grant", async () => {
      const res = await requestApp(
        await createApp(boardActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockDecide).not.toHaveBeenCalled();
    });

    /**
     * Ally review 5375217878 (Important #1): the short-circuit used to admit
     * EVERY board membership role, while the seed migration named only a subset
     * — two sides of one gate disagreeing about who an operator is. The intent
     * these tests pin is the `requiresNonViewer` precedent the codebase already
     * applies to `workspace_runtime:read`, which guards *less* sensitive
     * material than a transcript: owner / admin / operator read, viewer does
     * not, and a grant is how you widen it.
     *
     * Ally review 5381822720 (Important #2) fixed the vocabulary the gate reads
     * that set in: `member` is a storable role that `normalizeHumanRole` folds
     * to `operator`, so matching the raw stored string reintroduced the same
     * disagreement one layer down — a `member` was an operator for grant
     * seeding and a non-operator here. It normalizes now, which is why `member`
     * sits with the allowed roles below and an UNKNOWN role sits with the
     * denied ones: normalization folds the known alias and fails closed on
     * everything else.
     */
    describe("human membership roles", () => {
      const humanActor = (membershipRole: string) => ({
        type: "board",
        userId: "user-1",
        companyIds: ["company-1"],
        source: "session",
        isInstanceAdmin: false,
        memberships: [{ companyId: "company-1", membershipRole, status: "active" }],
      });

      for (const membershipRole of ["owner", "admin", "operator", "member"]) {
        it(`keeps the read for a ${membershipRole} without consulting the grant`, async () => {
          const res = await requestApp(
            await createApp(humanActor(membershipRole)),
            (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log"),
          );

          expect(res.status, JSON.stringify(res.body)).toBe(200);
          expect(mockDecide).not.toHaveBeenCalled();
        });
      }

      for (const membershipRole of ["viewer", "support", "not-a-real-role"]) {
        it(`denies a ${membershipRole} who holds no grant, and says why`, async () => {
          const res = await requestApp(
            await createApp(humanActor(membershipRole)),
            (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log"),
          );

          expect(res.status, JSON.stringify(res.body)).toBe(403);
          // Falls THROUGH to the decider rather than being refused inline, so
          // the denial carries the named boundary vocabulary and a grant can
          // still admit — see the next case.
          expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({
            action: "runs:read_transcript",
            resource: expect.objectContaining({ type: "agent", agentId: runOwnerAgentId }),
          }));
          expect(auditCallsFor("heartbeat.run_log_accessed")[0]?.[1]?.details).toMatchObject({
            result: "denied",
          });
        });
      }

      /**
       * `membership_role` is a plain `text` column with no DB constraint, and
       * the cloud-tenant path writes `support` into it (`middleware/auth.ts`,
       * `stackMembershipRole`). `normalizeHumanRole`'s own default fallback is
       * `operator`, which would make every unknown string above an operator —
       * this gate passes `viewer` instead, so the two cases above are the
       * fail-closed direction rather than an accident of the role list.
       */
      it("does not take normalizeHumanRole's operator fallback for an unknown role", async () => {
        const res = await requestApp(
          await createApp(humanActor("support")),
          (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log"),
        );

        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(mockDecide).toHaveBeenCalled();
      });

      /**
       * Ally review 5381822720 (Important #1). A cloud-tenant user is stamped
       * `membershipRole: "owner"` whenever their stack role is owner OR admin
       * (`middleware/auth.ts`) and carries `companyIds: [companyId]`, so they
       * clear `hasCompanyAccess` and would match the operator set on the role
       * alone. The decider answers the OPPOSITE for them — it refuses to
       * elevate cloud tenants and enumerates four readable actions that do not
       * include `runs:read_transcript` — so the short-circuit has to refuse on
       * the source, ahead of the role.
       */
      for (const membershipRole of ["owner", "admin", "operator"]) {
        it(`denies a cloud-tenant ${membershipRole}, who would otherwise match the operator set`, async () => {
          const res = await requestApp(
            await createApp({
              type: "board",
              userId: "user-1",
              companyIds: ["company-1"],
              source: "cloud_tenant",
              isInstanceAdmin: false,
              memberships: [{ companyId: "company-1", membershipRole, status: "active" }],
            }),
            (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log"),
          );

          expect(res.status, JSON.stringify(res.body)).toBe(403);
          // Through the decider, not refused inline — same escape hatch as a
          // viewer, so an explicit grant still admits a cloud-tenant operator.
          expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({
            action: "runs:read_transcript",
          }));
        });
      }

      it("admits a viewer who was granted runs:read_transcript explicitly", async () => {
        mockDecide.mockImplementation(async (input: { action?: string }) => ({
          allowed: true,
          action: input.action,
          reason: "allow_grant",
          explanation: "Allowed by principal grant runs:read_transcript.",
        }));

        const res = await requestApp(
          await createApp(humanActor("viewer")),
          (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log"),
        );

        // The exclusion is a default, not a lockout: this is the escape hatch
        // constraint 5 of the PEN-3140 decision asks for, on the human side.
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      });

      it("ignores an operator membership in a DIFFERENT company", async () => {
        const res = await requestApp(
          await createApp({
            type: "board",
            userId: "user-1",
            companyIds: ["company-1", "company-2"],
            source: "session",
            isInstanceAdmin: false,
            memberships: [
              { companyId: "company-2", membershipRole: "owner", status: "active" },
              { companyId: "company-1", membershipRole: "viewer", status: "active" },
            ],
          }),
          (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log"),
        );

        // Matching on role without matching on company would let an owner
        // anywhere read transcripts everywhere they hold any membership.
        expect(res.status, JSON.stringify(res.body)).toBe(403);
      });

      it("ignores a non-active operator membership", async () => {
        const res = await requestApp(
          await createApp({
            type: "board",
            userId: "user-1",
            companyIds: ["company-1"],
            source: "session",
            isInstanceAdmin: false,
            memberships: [{ companyId: "company-1", membershipRole: "owner", status: "suspended" }],
          }),
          (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log"),
        );

        expect(res.status, JSON.stringify(res.body)).toBe(403);
      });

      // Ally review 5449228335 (Important): an ABSENT status is not an active
      // one. Every sibling check of this field is strict, and this branch is
      // the one that skips the authorization service entirely.
      it("does not treat an operator membership with no status as active", async () => {
        const res = await requestApp(
          await createApp({
            type: "board",
            userId: "user-1",
            companyIds: ["company-1"],
            source: "session",
            isInstanceAdmin: false,
            memberships: [{ companyId: "company-1", membershipRole: "owner" }],
          }),
          (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log"),
        );

        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(mockDecide).toHaveBeenCalled();
      });
    });
  });

  describe("GET /heartbeat-runs/:runId/events", () => {
    it("withholds message and payload from an unentitled peer while keeping the envelope", async () => {
      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/events"),
      );

      // 200, not 403: the envelope is run shape, which stays company-readable.
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toHaveLength(2);
      for (const event of res.body) {
        expect(event.message).toBeNull();
        expect(event.payload).toBeNull();
        // Without this a client cannot tell "not entitled" from "no content".
        expect(event.withheldFields).toEqual(["message", "payload"]);
      }
      // `seq` is the pagination cursor every consumer depends on.
      expect(res.body.map((event: { seq: number }) => event.seq)).toEqual([7, 8]);
      expect(res.body[0]).toMatchObject({ eventType: "lifecycle", stream: "system", level: "warn" });
      expect(JSON.stringify(res.body)).not.toContain("agent-authored continuation prose");
      expect(JSON.stringify(res.body)).not.toContain("claude --model opus");
    });

    it("audits the denied events read, which had no audit at all before", async () => {
      await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/events?afterSeq=6&limit=50"),
      );

      const audits = auditCallsFor("heartbeat.run_events_accessed");
      expect(audits).toHaveLength(1);
      expect(audits[0]?.[1]).toMatchObject({
        companyId: "company-1",
        actorType: "agent",
        agentId: peerAgentId,
        entityType: "heartbeat_run",
        entityId: "run-1",
        runId: "run-1",
        details: expect.objectContaining({
          result: "denied",
          actorSource: "agent_key",
          actorRunId: "actor-run-1",
          afterSeq: 6,
          limit: 50,
        }),
      });
      // Same discipline as the /log audit: never record the content itself.
      expect(JSON.stringify(audits[0]?.[1]?.details)).not.toContain("continuation prose");
    });

    it("returns full content and an allowed audit to an entitled reader", async () => {
      mockDecide.mockImplementation(async (input: { action?: string }) => ({
        allowed: true,
        action: input.action,
        reason: "allow_manager_chain",
        explanation: "Allowed because the actor manages the run's owning agent in the reporting chain.",
      }));

      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/events"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body[0]).toMatchObject({ message: "Bounded retry exhausted for the vendor call" });
      expect(res.body[0].payload).toMatchObject({ nextAction: "agent-authored continuation prose" });
      expect(res.body[0]).not.toHaveProperty("withheldFields");
      expect(auditCallsFor("heartbeat.run_events_accessed")[0]?.[1]?.details).toMatchObject({
        result: "allowed",
        eventCount: 2,
      });
    });

    // Fail-closed proof. Adapters choose their own `eventType` string and the
    // server only length-clamps it, so a type allowlist would leak the first
    // time an adapter emitted an unrecognized (or a deliberately state-looking)
    // label. Withholding by default is what makes that impossible.
    it("withholds content from an event type it has never seen", async () => {
      mockHeartbeatService.listEvents.mockResolvedValue([
        {
          id: "9",
          companyId: "company-1",
          runId: "run-1",
          agentId: runOwnerAgentId,
          seq: 99,
          eventType: "vendor.brand_new_stream",
          stream: "stdout",
          level: "info",
          color: null,
          message: "AWS_SECRET_ACCESS_KEY=not-a-real-secret",
          payload: { toolResult: "raw tool output" },
          createdAt: new Date("2026-09-10T04:01:00.000Z"),
        },
      ]);

      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/events"),
      );

      expect(res.status).toBe(200);
      expect(res.body[0]).toMatchObject({ eventType: "vendor.brand_new_stream", seq: 99 });
      expect(res.body[0].message).toBeNull();
      expect(res.body[0].payload).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain("not-a-real-secret");
      expect(JSON.stringify(res.body)).not.toContain("raw tool output");
    });
  });

  // The overshoot guard the PEN-3140 decision asks for by name: "If a peer can
  // no longer see that a run parked, failed, or was retried, the change has
  // overshot and is wrong." This fails if run STATE gets narrowed along with
  // transcript content.
  describe("run state stays company-readable for an unentitled peer", () => {
    it("returns status, error text, and the retry edge from the run route", async () => {
      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        id: "run-1",
        status: "failed",
        error: "Run hit provider throttle before any token usage",
        errorCode: "rate_limit_exhausted",
        scheduledRetryReason: "transient_failure",
        retrySuccessor: { state: "retried", runId: "run-2" },
      });
      expect(res.body.lastActivityAt).toBeTruthy();
      // Cost/usage and log size are state, not transcript.
      expect(res.body.logBytes).toBe(4096);
    });

    it("returns workspace operations", async () => {
      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/workspace-operations"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toMatchObject({ id: "op-1", status: "succeeded" });
    });
  });

  /**
   * PEN-3204, implementing the PEN-3202 ruling. A workspace operation is a MIX:
   * the captured OUTPUT narrows to this gate, the operation ROW stays
   * company-readable.
   *
   * Every case asserts BOTH directions on one response — the excerpt is gone AND
   * `phase` / `status` / `exitCode` / `command` survived beside it. A
   * withhold-only assertion would still pass if the projection nulled the whole
   * row, which would silently break fleet diagnosis while looking like a fix.
   *
   * All three read routes are covered, because gating two and leaving the third
   * is the PEN-2777 failure the `authz.ts` comment exists to prevent.
   */
  describe("workspace-operation captured output is scoped to the transcript gate (PEN-3204)", () => {
    function expectStateSurvived(operation: Record<string, unknown>) {
      // The row itself must be intact — withholding the operator's text is the
      // point, hiding that an operation ran is not.
      expect(operation.phase).toBeTruthy();
      expect(operation.status).toBe("succeeded");
      expect(operation.exitCode).toBe(0);
      expect(operation.command).toBeTruthy();
      expect(operation.logBytes).toBe(2048);
      expect(operation.logRef).toBe("op-1.log");
    }

    it("withholds the excerpts from an unentitled peer on the run route, keeping state beside them", async () => {
      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/workspace-operations"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toHaveLength(2);
      const [attached] = res.body;
      expect(attached.stdoutExcerpt).toBeNull();
      expect(attached.stderrExcerpt).toBeNull();
      expect(attached.withheldFields).toEqual(["stdoutExcerpt", "stderrExcerpt"]);
      expectStateSurvived(attached);
      // The canary must not appear ANYWHERE in the body, not merely on the key
      // the projection nulls.
      expect(JSON.stringify(res.body)).not.toContain(WORKSPACE_OP_CANARY);
    });

    it("withholds the RUN-LESS cleanup row too — the fail-closed branch", async () => {
      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/workspace-operations"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const runless = res.body.find((op: { id: string }) => op.id === "op-2");
      // `heartbeatRunId` is null, so no owner can be resolved. Falling open here
      // would hand every cleanup operation's output to any company peer.
      expect(runless.heartbeatRunId).toBeNull();
      expect(runless.stdoutExcerpt).toBeNull();
      expect(runless.stderrExcerpt).toBeNull();
      expectStateSurvived(runless);
    });

    it("gives the run's owning agent its own captured output back", async () => {
      mockDecide.mockImplementation(async (input: { action?: string }) => ({
        allowed: true,
        action: input.action,
        reason: "allow_self",
        explanation: "Allowed because the actor owns the run whose transcript it is reading.",
      }));

      const res = await requestApp(
        await createApp(ownerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/workspace-operations"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const attached = res.body.find((op: { id: string }) => op.id === "op-1");
      expect(attached.stdoutExcerpt).toBe(WORKSPACE_OP_CANARY);
      expect(attached.withheldFields).toBeUndefined();
    });

    it("asks the decider about the operation's OWNING agent, not the caller", async () => {
      await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/workspace-operations"),
      );

      expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({
        action: "runs:read_transcript",
        resource: expect.objectContaining({ type: "agent", agentId: runOwnerAgentId }),
      }));
    });

    it("withholds on the execution-workspace route, the widest of the three", async () => {
      // This route returns EVERY operation for the workspace, including other
      // agents' runs, and PR #1741 did not touch its file at all. Gating the run
      // route and leaving this one open is the exact PEN-2777 shape.
      //
      // The actor under test is the one that matters: it HOLDS `company_scope:read`
      // — so it legitimately reaches the route and sees the operation rows — and
      // lacks only the transcript entitlement. Denying company scope instead would
      // make this pass at the door and never exercise the projection.
      mockDecide.mockImplementation(async (input: { action?: string }) => (
        input.action === "company_scope:read"
          ? { allowed: true, action: input.action, reason: "allow_company_member", explanation: "Company member." }
          : {
            allowed: false,
            action: input.action,
            reason: "deny_missing_grant",
            explanation: "Missing permission: runs:read_transcript.",
          }
      ));

      const res = await requestApp(
        await createWorkspaceApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/execution-workspaces/workspace-1/workspace-operations"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toHaveLength(2);
      for (const operation of res.body) {
        expect(operation.stdoutExcerpt).toBeNull();
        expect(operation.stderrExcerpt).toBeNull();
        expectStateSurvived(operation);
      }
      expect(JSON.stringify(res.body)).not.toContain(WORKSPACE_OP_CANARY);
    });

    /**
     * Ally review 5386746244 (Important #1). The null-owner fallback used to keep
     * the read for every board actor (`req.actor.type === "board"`), which is the
     * predicate the transcript gate narrowed away from — so a viewer was denied
     * the owned row and handed the RUN-LESS one unprojected. It now takes the
     * same operator test as `decideRunTranscriptRead`, on both list routes.
     */
    const viewerBoardActor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      memberships: [{ companyId: "company-1", membershipRole: "viewer", status: "active" }],
    };

    function allowCompanyScopeOnly() {
      mockDecide.mockImplementation(async (input: { action?: string }) => (
        input.action === "company_scope:read"
          ? { allowed: true, action: input.action, reason: "allow_company_member", explanation: "Company member." }
          : {
            allowed: false,
            action: input.action,
            reason: "deny_missing_grant",
            explanation: "Missing permission: runs:read_transcript.",
          }
      ));
    }

    for (const [route, build] of [
      ["/api/heartbeat-runs/run-1/workspace-operations", createApp],
      ["/api/execution-workspaces/workspace-1/workspace-operations", createWorkspaceApp],
    ] as const) {
      it(`withholds the run-less row from a viewer-role board actor on ${route}`, async () => {
        allowCompanyScopeOnly();
        const res = await requestApp(
          await build(viewerBoardActor),
          (baseUrl) => request(baseUrl).get(route),
        );

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const runless = res.body.find((op: { id: string }) => op.id === "op-2");
        expect(runless.heartbeatRunId).toBeNull();
        expect(runless.stdoutExcerpt).toBeNull();
        expect(runless.stderrExcerpt).toBeNull();
        expectStateSurvived(runless);
        expect(JSON.stringify(res.body)).not.toContain(WORKSPACE_OP_CANARY);
      });

      // Counterweight: the human operator arm still keeps the run-less row, so
      // the case above cannot pass by withholding it from everyone.
      it(`keeps the run-less row for an admin-role board actor on ${route}`, async () => {
        allowCompanyScopeOnly();
        const res = await requestApp(
          await build({
            ...viewerBoardActor,
            memberships: [{ companyId: "company-1", membershipRole: "admin", status: "active" }],
          }),
          (baseUrl) => request(baseUrl).get(route),
        );

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const runless = res.body.find((op: { id: string }) => op.id === "op-2");
        expect(runless.stdoutExcerpt).toBe(WORKSPACE_OP_CANARY);
        expect(runless.withheldFields).toBeUndefined();
      });
    }

    /**
     * PEN-3204 / merge of 2026-09-20: the four cases that pinned a
     * `decideRunTranscriptRead` gate on `GET /workspace-operations/:operationId/log`
     * were REMOVED here rather than repaired, because the route they described is no
     * longer the route this branch ships.
     *
     * Master landed BLO-34631 on that same path while this PR was open, gating the
     * body on the `workspace_runtime:read` entitlement instead. That control is
     * strictly tighter for the population this gate protects: `workspace_runtime:read`
     * is unmapped in `permissionForAction` and absent from the same-company agent
     * allow-list (`services/authorization.ts`), so NO agent actor resolves
     * `revealRuntimeConfig` and the content is withheld from every agent, owner or
     * not. Stacking the transcript gate on top would have converted a withheld 200
     * into a 403 and changed no bytes.
     *
     * The coverage did not move to nothing — it moved to master's cases, which assert
     * BOTH directions on this route and are green at this head:
     * `agent-live-run-routes.test.ts` → "withholds workspace-operation log content
     * from a reader without workspace_runtime:read", "discloses ... to a reader
     * holding workspace_runtime:read", and "audits denied workspace-operation log
     * access without reading content".
     *
     * What is NOT settled by that, and is deliberately left to PEN-3204 rather than
     * decided in a merge: whether the `runs:read_transcript` grant should reach this
     * route at all. Under master's entitlement it does not.
     *
     * The cross-tenant 404 case below is kept — that posture is unchanged by either
     * control, and it is the one assertion here that still describes shipped behaviour.
     */

    it("keeps the cross-tenant 404 rather than exposing the new 403", async () => {
      mockWorkspaceOperationService.getById.mockResolvedValue({
        ...runAttachedOperation,
        companyId: "company-2",
      });

      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/workspace-operations/op-1/log"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(404);
    });
  });

  /**
   * PEN-3149 ruling, folded into this row: the run-STATE responses carry
   * transcript content of their own. Narrowing `/log` and `/events` while
   * leaving these open would have been decorative — the same prose exits here,
   * in bulk, and on the list route without even a per-run fetch.
   *
   * Every case below asserts BOTH directions on one response: the transcript
   * field is gone AND the state beside it survived. A withhold-only assertion
   * would still pass if the projection nulled the whole row.
   */
  describe("run state routes withhold transcript content but keep state (PEN-3149)", () => {
    it("withholds excerpts, snippet and resultJson free text from the run route", async () => {
      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.stdoutExcerpt).toBeNull();
      expect(res.body.stderrExcerpt).toBeNull();
      expect(res.body.lastAssistantSnippet).toBeNull();
      // Inside the blob: free text out, machine keys in. Withholding the whole
      // object would break the live throttle-family filters that read it
      // (PEN-2501, PEN-3129, PEN-2513).
      expect(res.body.resultJson).toMatchObject({
        status: "error",
        stopReason: "max_turns",
        errorFamily: "provider_capacity",
        penstockReason: "throttled",
        retryNotBefore: "2026-09-10T04:00:00.000Z",
        error: "provider returned 429",
        totalCostUsd: 0.42,
      });
      for (const key of ["result", "summary", "message", "stdout", "stderr"]) {
        expect(res.body.resultJson, `resultJson.${key} survived`).not.toHaveProperty(key);
      }
      // The generated mirror of those same keys, at the top level. These are
      // `left(result_json ->> '<key>', 500)` columns that `getRun` selects via
      // `getTableColumns`, so closing the blob without closing these would leave
      // the first 500 chars of the identical prose on the wire.
      expect(res.body.resultSummary).toBeNull();
      expect(res.body.resultResult).toBeNull();
      expect(res.body.resultMessage).toBeNull();
      // ...and the error mirror is state, so it survives alongside `error`.
      expect(res.body.resultError).toBe("provider returned 429");
      // `nextAction` is a verbatim line lifted out of the sources withheld
      // above, so it has to go with them.
      expect(res.body.nextAction).toBeNull();
      // The whole point: no copy of the credential anywhere in the response.
      expect(JSON.stringify(res.body)).not.toContain("sk-live-not-a-real-key");
      // ...and state is still there beside it.
      expect(res.body).toMatchObject({
        status: "failed",
        errorCode: "rate_limit_exhausted",
        retrySuccessor: { state: "retried", runId: "run-2" },
      });
    });

    it("re-derives currentStatusMessage from the tool name, not the assistant prose", async () => {
      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1"),
      );

      // Nulling `lastAssistantSnippet` alone is decorative: the same prose is
      // reachable on the same response through `currentStatusMessage`, which
      // `buildRunEventRuntimeProgress` derives from it. An unentitled reader's
      // message must come from the tool name or the event type only.
      expect(res.body.currentStatusMessage).toBe("Using Bash");
      expect(res.body.currentToolName).toBe("Bash");
      expect(res.body.withheldFields).toEqual(
        expect.arrayContaining(["lastAssistantSnippet", "currentStatusMessage"]),
      );
    });

    it("withholds nextAction, which carries the withheld prose verbatim", async () => {
      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1"),
      );

      // `nextAction` looks like a state field and is not one. `extractNextAction`
      // (`services/run-liveness.ts`) scans issue comment bodies, then
      // `resultJson.nextAction`, then `resultJson.summary`/`.result`/`.message`,
      // then the continuation-summary body, then `resultJson.stdout`/`.stderr`
      // plus `stdoutExcerpt`/`stderrExcerpt` -- and returns the matched line
      // UNCHANGED, capped at 500 chars. So it is not a classification derived
      // from the transcript, it is an excerpt OF it, and withholding the sources
      // while leaving this populated closes nothing.
      expect(res.body.nextAction).toBeNull();
      expect(res.body.withheldFields).toContain("nextAction");
      expect(JSON.stringify(res.body)).not.toContain("sk-live-not-a-real-key");
      // Its machine-valued neighbours from the same classifier row are state and
      // must survive -- `livenessReason` is a fixed classifier string and
      // `continuationAttempt` a counter, so narrowing them would overshoot.
      expect(res.body).toMatchObject({ status: "failed", errorCode: "rate_limit_exhausted" });
    });

    it("gives an entitled reader nextAction back", async () => {
      mockDecide.mockImplementation(async (input: { action?: string }) => ({
        allowed: true,
        action: input.action,
        reason: "allow_manager_chain",
      }));

      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1"),
      );

      // The allow path must not be collateral damage: a manager diagnosing a
      // stalled run needs exactly this line.
      expect(res.body.nextAction).toBe(
        "Next: rerun the deploy with ANTHROPIC_API_KEY=sk-live-not-a-real-key",
      );
    });

    it("withholds an unknown adapter key inside resultJson, not just the known five", async () => {
      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1"),
      );

      // The projection is an ALLOWLIST of machine keys, so a key no list
      // mentions is withheld by default. A denylist of `result` / `summary` /
      // `message` / `stdout` / `stderr` passes this through -- and since
      // PEN-3153 shows `resultJson` is persisted with no write-path scrub, what
      // it passes through is unscrubbed adapter output.
      expect(res.body.resultJson).not.toHaveProperty("adapterVerboseOutput");
      expect(res.body.withheldFields).toContain("resultJson.adapterVerboseOutput");
      // The nested prose subkey is named by its full path, so a consumer that
      // loses it can see exactly what went and why.
      expect(res.body.resultJson.workspaceValidation)
        .not.toHaveProperty("plainLanguageReason");
      expect(res.body.withheldFields)
        .toContain("resultJson.workspaceValidation.plainLanguageReason");
      expect(JSON.stringify(res.body)).not.toContain("sk-live-not-a-real-key");

      // ...and the allowlist is not a blunt instrument: every machine key the
      // live fleet filters read is still here. Narrowing to "withhold the whole
      // blob" would break PEN-2501 / PEN-3129 / PEN-2513.
      expect(res.body.resultJson).toEqual({
        status: "error",
        stopReason: "max_turns",
        errorFamily: "provider_capacity",
        penstockReason: "throttled",
        retryNotBefore: "2026-09-10T04:00:00.000Z",
        error: "provider returned 429",
        totalCostUsd: 0.42,
        // Unenumerated vendor counters survive on value shape alone -- this is
        // the half a key allowlist gets wrong, by dropping every key nobody
        // thought to name.
        num_turns: 17,
        duration_api_ms: 4821,
        is_error: true,
        // ...and the nested block keeps its machine subkeys while losing its
        // one prose subkey.
        workspaceValidation: { reasonCode: "git_worktree_not_reusable", attempts: 2 },
      });
    });

    it("gives an entitled reader the full run row", async () => {
      mockDecide.mockImplementation(async (input: { action?: string }) => ({
        allowed: true,
        action: input.action,
        reason: "allow_manager_chain",
        explanation: "Allowed because the actor manages the run's owning agent.",
      }));

      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.stdoutExcerpt).toContain("sk-live-not-a-real-key");
      expect(res.body.lastAssistantSnippet).toContain("sk-live-not-a-real-key");
      expect(res.body.resultJson).toHaveProperty("summary");
      expect(res.body.resultResult).toContain("sk-live-not-a-real-key");
      expect(res.body).not.toHaveProperty("withheldFields");
    });

    it("withholds the resultJson projection on the company run list", async () => {
      mockHeartbeatService.list.mockResolvedValue([
        {
          id: "run-1",
          companyId: "company-1",
          agentId: runOwnerAgentId,
          status: "failed",
          errorCode: "rate_limit_exhausted",
          logBytes: 4096,
          resultJson: {
            summary: "ran the deploy and printed sk-live-not-a-real-key",
            result: "sk-live-not-a-real-key",
            message: "done",
            error: "provider returned 429",
            totalCostUsd: 0.42,
          },
        },
      ]);

      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/companies/company-1/heartbeat-runs"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(JSON.stringify(res.body)).not.toContain("sk-live-not-a-real-key");
      expect(res.body[0].resultJson).toMatchObject({
        error: "provider returned 429",
        totalCostUsd: 0.42,
      });
      // The row itself is still there — the list is not filtered, only projected.
      expect(res.body[0]).toMatchObject({
        id: "run-1",
        status: "failed",
        errorCode: "rate_limit_exhausted",
        logBytes: 4096,
      });
    });

    it("decides once per owning agent, not once per run", async () => {
      mockHeartbeatService.list.mockResolvedValue(
        Array.from({ length: 6 }, (_, i) => ({
          id: `run-${i}`,
          companyId: "company-1",
          // three runs each from two agents
          agentId: i % 2 === 0 ? runOwnerAgentId : peerAgentId,
          status: "failed",
          resultJson: { summary: "prose", error: "e" },
        })),
      );

      await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/companies/company-1/heartbeat-runs"),
      );

      // Memoized on the owning agent. Without this a 200-run page would issue
      // 200 authorization decisions.
      expect(mockDecide).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * Ally review 5449228335 (late lens): `POST /heartbeat-runs/:runId/cancel`
   * returns the run row too, and on an already-terminal run `cancelRun` hands
   * back the unmodified `getRun` row. Board actors skip the cancel's own
   * decision, so the response must go through the same projection as its `GET`
   * sibling or a board actor that `GET` withholds from reads it with one POST.
   */
  describe("POST /heartbeat-runs/:runId/cancel projects the returned row like its GET sibling", () => {
    beforeEach(() => {
      // Terminal run: nothing to cancel, so the row comes back unmodified.
      mockHeartbeatService.cancelRun.mockImplementation(async () => mockHeartbeatService.getRun());
    });

    const boardWithRole = (source: string, membershipRole: string) => ({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source,
      isInstanceAdmin: false,
      memberships: [{ companyId: "company-1", membershipRole, status: "active" }],
    });

    it("withholds transcript content from a cloud-tenant owner cancelling a completed run", async () => {
      const res = await requestApp(
        await createApp(boardWithRole("cloud_tenant", "owner")),
        (baseUrl) => request(baseUrl).post("/api/heartbeat-runs/run-1/cancel").send({}),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.stdoutExcerpt).toBeNull();
      expect(res.body.stderrExcerpt).toBeNull();
      expect(res.body.nextAction).toBeNull();
      expect(res.body.resultJson).not.toHaveProperty("result");
      expect(res.body.resultJson).not.toHaveProperty("summary");
      expect(JSON.stringify(res.body)).not.toContain("sk-live-not-a-real-key");
      expect(res.body).toMatchObject({ id: "run-1", status: "failed", errorCode: "rate_limit_exhausted" });
      expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({
        action: "runs:read_transcript",
        resource: expect.objectContaining({ type: "agent", agentId: runOwnerAgentId }),
      }));
    });

    it("refuses a viewer-role board actor before the cancel runs at all", async () => {
      const res = await requestApp(
        await createApp(boardWithRole("session", "viewer")),
        (baseUrl) => request(baseUrl).post("/api/heartbeat-runs/run-1/cancel").send({}),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
      expect(JSON.stringify(res.body)).not.toContain("sk-live-not-a-real-key");
    });

    it("gives an operator the full row back", async () => {
      const res = await requestApp(
        await createApp(boardWithRole("session", "operator")),
        (baseUrl) => request(baseUrl).post("/api/heartbeat-runs/run-1/cancel").send({}),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.stdoutExcerpt).toContain("sk-live-not-a-real-key");
      expect(res.body).not.toHaveProperty("withheldFields");
    });
  });
  /**
   * The three routes below all changed in the same commit as the two above, and
   * all three were shipping untested: they build their rows straight off `db`
   * rather than through the heartbeat service, so the existing `{}`-db harness
   * could not reach them. Sharing a verified helper with a tested route is not
   * the same as being proven at the route -- a wrong `agentId` field or a
   * projection applied to the wrong object would pass invisibly.
   *
   * `/companies/:companyId/live-runs` is the one that matters most: it is
   * company-scoped, so it hands a peer every live agent's current prose in a
   * single call.
   */
  describe("the remaining run-state feeds (PEN-3149) are gated too", () => {
    const liveRunRow = {
      id: "run-1",
      companyId: "company-1",
      agentId: runOwnerAgentId,
      agentName: "Some Other Agent",
      status: "running",
      logBytes: 4096,
      // These three feeds select `nextAction` explicitly in their column maps,
      // so the canary has to be here too -- the per-run fixture above does not
      // reach them.
      nextAction: "Next: rerun the deploy with ANTHROPIC_API_KEY=sk-live-not-a-real-key",
    };

    // minCount=0 keeps this to the single live-runs query; the padding branch
    // issues a second one.
    const liveRunsPath = "/api/companies/company-1/live-runs?minCount=0";

    it("withholds the decorated prose on the company-wide live-runs feed", async () => {
      const res = await requestApp(
        await createAppWithDb(peerAgentActor, [liveRunRow]),
        (baseUrl) => request(baseUrl).get(liveRunsPath),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(JSON.stringify(res.body)).not.toContain("sk-live-not-a-real-key");
      expect(res.body[0].lastAssistantSnippet).toBeNull();
      expect(res.body[0].currentStatusMessage).toBe("Using Bash");
      // Ally flagged this feed by name: it selects `nextAction` in its own
      // column map, and this is the widest of the three -- every live agent's
      // current prose in one company-scoped call.
      expect(res.body[0].nextAction).toBeNull();
      // The row is projected, never dropped -- run state stays company-readable.
      expect(res.body[0]).toMatchObject({ id: "run-1", status: "running", logBytes: 4096 });
    });

    it("gives an entitled reader the prose on that same feed", async () => {
      mockDecide.mockImplementation(async (input: { action?: string }) => ({
        allowed: true,
        action: input.action,
        reason: "allow_manager_chain",
      }));

      const res = await requestApp(
        await createAppWithDb(peerAgentActor, [liveRunRow]),
        (baseUrl) => request(baseUrl).get(liveRunsPath),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body[0].lastAssistantSnippet).toContain("sk-live-not-a-real-key");
      expect(res.body[0]).not.toHaveProperty("withheldFields");
    });

    it("withholds the decorated prose on the per-issue live-runs feed", async () => {
      const issue = {
        id: "issue-1",
        companyId: "company-1",
        status: "in_progress",
        executionRunId: null,
        assigneeAgentId: runOwnerAgentId,
      };
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.getByIdentifier.mockResolvedValue(issue);

      const res = await requestApp(
        await createAppWithDb(peerAgentActor, [liveRunRow]),
        (baseUrl) => request(baseUrl).get("/api/issues/issue-1/live-runs"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(JSON.stringify(res.body)).not.toContain("sk-live-not-a-real-key");
      expect(res.body[0].lastAssistantSnippet).toBeNull();
      expect(res.body[0].currentStatusMessage).toBe("Using Bash");
      expect(res.body[0].nextAction).toBeNull();
    });

    it("withholds the decorated prose on the per-issue active-run route", async () => {
      const issue = {
        id: "issue-1",
        companyId: "company-1",
        status: "in_progress",
        executionRunId: "run-1",
        assigneeAgentId: runOwnerAgentId,
      };
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.getByIdentifier.mockResolvedValue(issue);
      mockHeartbeatService.getRunIssueSummary.mockResolvedValue({
        ...liveRunRow,
        issueId: "issue-1",
      });
      mockAgentService.getById.mockResolvedValue({
        id: runOwnerAgentId,
        name: "Some Other Agent",
        adapterType: "claude_k8s",
      });

      const res = await requestApp(
        await createAppWithDb(peerAgentActor, [liveRunRow]),
        (baseUrl) => request(baseUrl).get("/api/issues/issue-1/active-run"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain("sk-live-not-a-real-key");
      expect(res.body.lastAssistantSnippet).toBeNull();
      expect(res.body.currentStatusMessage).toBe("Using Bash");
      // Identity is not transcript and must survive the projection.
      expect(res.body).toMatchObject({ agentId: runOwnerAgentId, agentName: "Some Other Agent" });
    });
  });
});

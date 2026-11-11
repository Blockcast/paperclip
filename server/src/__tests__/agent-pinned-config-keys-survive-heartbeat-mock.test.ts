import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PEN-6335 — THE REGRESSION PIN FOR THE MOVE, not for the symptom.
//
// `PATCH /api/agents/:id` refuses an AGENT-authored write of the adapterConfig
// keys pinned to agent scope (PEN-6188 / PEN-6247 / PEN-6259). Those key sets
// used to live in `services/heartbeat.ts`, so `routes/agents.ts` reached them
// through an import of that 2.2 MB service — and a test file that did a TOTAL
// `vi.mock("../services/heartbeat.js")` replaced them with `undefined`, leaving
// the guard unable to compute its refusal set. `[...pinnedKeys]` then throws on
// `undefined` and the route 500s where it meant to 403.
//
// Measured once, first-party: `Blockcast/paperclip#3563`'s
// `General tests (server 6/6)` went red at head `04b41b0e` with
// `expected 500 to be 403`, on exactly the two arms of
// `agent-permissions-routes.test.ts` that reach the guard's success path.
//
// ⛔ WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT.
//
// It is NOT a re-test of the `importActual` repair that cleared that red. That
// repair is per-file, it works, and `agent-permissions-routes.test.ts` still
// carries it — re-testing it would pin the arm that was already fixed.
//
// It pins the STRUCTURAL property instead: the key sets now live in the leaf
// `services/agent-config-key-pins.ts`, which this file does not mock, so NO
// mock of `heartbeat.js` in ANY file can reach them. This file therefore mocks
// `heartbeat.js` TOTALLY and on purpose — no `importActual`, no named
// re-export list — which is precisely the shape that used to break the guard.
//
// Revert only the move (put the key sets back in `heartbeat.ts` and point
// `routes/agents.ts` at them there) and every refusal arm below reds with
// `expected 500 to be 403`, naming this file.
//
// ⚠ THE QUIET DIRECTION IS WHY THE PER-FILE REPAIR WAS NOT ENOUGH. Today a
// dropped export fails LOUD, because the route calls these values directly and
// `undefined(...)` throws. A future consumer reading a heartbeat export
// TOLERANTLY — `?.`, `?? fallback` — would see `undefined`, degrade silently to
// not-guarding, and leave the suite green. A per-file allowlist cannot reach a
// test file that does not exist yet; the leaf module can.
//
// Harness borrowed from `agent-scope-pinned-config-keys-routes.test.ts`, which
// exercises the same route WITHOUT a heartbeat mock. That pairing is the point:
// the two files differ in the one variable under test.

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  resolveByReference: vi.fn(),
  getConfigRevision: vi.fn(),
  rollbackConfigRevision: vi.fn(),
}));

const mockBuiltInAgentService = vi.hoisted(() => ({
  ensureCompanyDefaultAgentGrants: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => config,
  ),
}));

const mockEnvironmentService = vi.hoisted(() => ({ getById: vi.fn() }));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());
const mockFindServerAdapter = vi.hoisted(() => vi.fn());

function serviceModuleMocks() {
  return {
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({}),
    accessService: () => mockAccessService,
    approvalService: () => ({}),
    builtInAgentService: () => mockBuiltInAgentService,
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    environmentService: () => mockEnvironmentService,
    heartbeatService: () => ({}),
    issueApprovalService: () => ({}),
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => mockWorkspaceOperationServiceStub,
  };
}

const mockWorkspaceOperationServiceStub = vi.hoisted(() => ({}));

/**
 * ⛔ THE VARIABLE UNDER TEST. A TOTAL mock: no `importActual`, no named
 * re-export list. Every value export of `heartbeat.js` is `undefined` in this
 * suite — which is exactly the state that broke the guard before PEN-6335, and
 * exactly the state a future test file will reach for without knowing any of
 * this. Do NOT "repair" this into an `importActual`; that deletes the pin.
 */
function mockHeartbeatTotally() {
  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => ({}),
  }));
}

vi.mock("../services/index.js", () => serviceModuleMocks());
vi.mock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
vi.mock("../services/environments.js", () => ({ environmentService: () => mockEnvironmentService }));
vi.mock("../adapters/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
  findActiveServerAdapter: vi.fn(() => undefined),
  listAdapterModels: vi.fn(),
  // Reached by the model-profile normalization on every `runtimeConfig`
  // write. Omitting it 500s the request PAST the guard, which reads as a pass
  // in the must-pass arm — see the progress-marker assertion there.
  listAdapterModelProfiles: vi.fn(async () => []),
}));

function registerModuleMocks() {
  mockHeartbeatTotally();
  vi.doMock("../services/index.js", () => serviceModuleMocks());
  vi.doMock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
  vi.doMock("../services/environments.js", () => ({ environmentService: () => mockEnvironmentService }));
  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: mockFindServerAdapter,
    findActiveServerAdapter: vi.fn(() => undefined),
    listAdapterModels: vi.fn(),
    listAdapterModelProfiles: vi.fn(async () => []),
  }));
}

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function selfAgentActor() {
  return { type: "agent", agentId: AGENT_ID, companyId: "company-1", source: "agent_key" };
}

function boardActor() {
  return {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

/** Agent row with the publish broker ON — the state the composition keys are pinned under. */
function makeBrokeredAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {
      enableGitHubPublishBroker: true,
      image: "ghcr.io/blockcast/stored-image:pinned",
      model: "stored-model",
    },
    runtimeConfig: {},
    defaultEnvironmentId: null,
    permissions: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  const db = { update: () => ({ set: () => ({ where: async () => [] }) }) };
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

/** `allow_self` for the agent's own row — the PEN-6188 shape. Board actors are allowed. */
function decideAsAgentWithNoGrants({
  actor,
  action,
  resource,
  scope,
}: {
  actor: { type: string; agentId?: string };
  action: string;
  resource: { type: string; agentId?: string };
  scope?: Record<string, unknown>;
}) {
  if (actor.type !== "agent") {
    return { allowed: true, reason: "allow_board", explanation: "Board actor." };
  }
  const isSelf = resource.type === "agent" && resource.agentId === AGENT_ID;
  if (action === "agent_config:update" && isSelf && scope?.requiresChangeGrant !== true) {
    return {
      allowed: true,
      reason: "allow_self",
      explanation: "Allowed because the actor is updating its own agent configuration.",
    };
  }
  return {
    allowed: false,
    reason: "deny_no_grant",
    explanation: "Missing permission: agents:configure or agents:suggest-changes.",
  };
}

function patchAgent(app: express.Express, body: Record<string, unknown>) {
  return requestApp(app, (baseUrl) => request(baseUrl).patch(`/api/agents/${AGENT_ID}`).send(body));
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("../routes/agents.js");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../middleware/index.js");
  registerModuleMocks();
  vi.clearAllMocks();
  mockBuiltInAgentService.ensureCompanyDefaultAgentGrants.mockResolvedValue(0);
  mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent: unknown, config: unknown) => config);
  mockFindServerAdapter.mockImplementation((type: string) => ({ type }));
  mockAccessService.decide.mockImplementation(async (input: any) => decideAsAgentWithNoGrants(input));
  mockAgentService.getById.mockResolvedValue(makeBrokeredAgent());
  mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
    ...makeBrokeredAgent(),
    ...patch,
  }));
});

describe("PATCH /api/agents/:id pinned-key guard survives a TOTAL heartbeat mock (PEN-6335)", () => {
  /**
   * ⭐ THE PREMISE CONTROL. Every refusal below is only evidence if the mock in
   * this file genuinely voids `heartbeat.js` — otherwise the suite would be
   * passing for the boring reason that nothing was mocked at all, and the pin
   * would certify nothing. This asserts the mock is real and total: the two key
   * symbols are absent from the mocked module, and the one symbol it does
   * supply is present.
   *
   * It also states the move's invariant from the other side: the identical
   * names ARE present on the leaf, which this file does not mock.
   */
  it("the heartbeat mock in this file is real and TOTAL, and the leaf is untouched by it", async () => {
    const mockedHeartbeat = await import("../services/heartbeat.js");
    expect((mockedHeartbeat as Record<string, unknown>).heartbeatService).toBeTypeOf("function");

    // ⭐ Measured 2026-11-10, and it is sharper than "the export is undefined":
    // vitest's mock namespace THROWS on an export the factory did not return,
    // rather than yielding `undefined`. That is the 500 mechanism exactly — the
    // route does not call `undefined(...)`, it dies reaching for the binding —
    // and it is why the original red read `expected 500 to be 403`.
    //
    // ⛔ So this is the whole premise of every refusal arm below: under THIS
    // file's mock the old import site in `routes/agents.ts` is not merely
    // degraded, it is unreachable. The arms can only pass because the route
    // reads these names from the leaf instead.
    for (const name of ["agentActorUnwritableConfigKeys", "agentScopeOnlyConfigKeysFor"]) {
      // The matcher is the planted symbol name rather than vitest's own
      // sentence: the property under test is that ACCESS THROWS and that the
      // throw names the symbol, which is what makes a failure here readable.
      // vitest's wording is an implementation detail of the mock namespace and
      // is not part of the mechanism this arm reproduces.
      expect(() => (mockedHeartbeat as Record<string, unknown>)[name]).toThrowError(
        new RegExp(name),
      );
    }

    const leaf = await vi.importActual<typeof import("../services/agent-config-key-pins.js")>(
      "../services/agent-config-key-pins.js",
    );
    expect(leaf.agentActorUnwritableConfigKeys).toBeTypeOf("function");
    expect(leaf.agentScopeOnlyConfigKeysFor).toBeTypeOf("function");
    // The write-side set is a strict superset of the overlay set, always.
    const base = { enableGitHubPublishBroker: true };
    for (const key of leaf.agentScopeOnlyConfigKeysFor(base)) {
      expect(leaf.agentActorUnwritableConfigKeys(base).has(key)).toBe(true);
    }
    expect(leaf.agentActorUnwritableConfigKeys(base).has("image")).toBe(true);
    expect(leaf.agentScopeOnlyConfigKeysFor(base).has("image")).toBe(false);
  });

  // PEN-6188. Reverting the move reds this with `expected 500 to be 403`.
  it("refuses an agent clearing enableGitHubPublishBroker on ITSELF", async () => {
    const app = await createApp(selfAgentActor());
    const res = await patchAgent(app, { adapterConfig: { enableGitHubPublishBroker: false } });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("adapterConfig.enableGitHubPublishBroker");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  // PEN-6259. `image` is write-side only, so it exercises the key set the
  // overlay set does not contain — i.e. it pins BOTH leaf exports, not one.
  it("refuses an agent setting adapterConfig.image on ITSELF", async () => {
    const app = await createApp(selfAgentActor());
    const res = await patchAgent(app, { adapterConfig: { image: "ghcr.io/attacker/evil:latest" } });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("adapterConfig.image");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  // Removal is the other half: the adapter reads the flag with
  // `asBoolean(config.x, false)`, so DELETING it opts out just as well.
  it("refuses an agent DROPPING a pinned key via replaceAdapterConfig", async () => {
    const app = await createApp(selfAgentActor());
    const res = await patchAgent(app, {
      replaceAdapterConfig: true,
      adapterConfig: { model: "stored-model" },
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("adapterConfig.enableGitHubPublishBroker");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THE MUST-PASS ARM, WITH A PROGRESS MARKER. A gate that only ever refuses
   * is not shown to work — and `expect(status).not.toBe(403)` passes just as
   * happily when the request dies BEFORE the guard, which is the failure the
   * `listAdapterModelProfiles` note above describes. So this asserts the write
   * actually reached persistence, not merely that it was not a 403.
   */
  it("still lets a BOARD actor set a pinned key, and the write reaches persistence", async () => {
    const app = await createApp(boardActor());
    const res = await patchAgent(app, {
      adapterConfig: { enableGitHubPublishBroker: true, image: "ghcr.io/blockcast/operator:pinned" },
    });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });

  /** And an agent may still write an UNPINNED key on itself — the pin is narrow. */
  it("still lets an agent set an unpinned key on itself, and the write reaches persistence", async () => {
    const app = await createApp(selfAgentActor());
    const res = await patchAgent(app, { adapterConfig: { model: "agent-chosen-model" } });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });
});

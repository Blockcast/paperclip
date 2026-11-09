import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PEN-6188 — the adapterConfig keys pinned to AGENT scope must be unwritable
// by an agent actor, INCLUDING ON ITSELF.
//
// PEN-5017 pinned `enableGitHubPublishBroker` (and `enablePerAgentWorkspace
// Volume`) against the ISSUE-scope overlay, on the reasoning that "a boundary
// the constrained principal can decline per-run is not a boundary, it is a
// default". The pin is taken against AGENT scope — and agent scope is
// self-writable: `agent_config:update` resolves `allow_self` for an actor
// patching its own row, with no grant and no consent. So the constrained
// principal could decline the same boundary one scope up.
//
// Measured against the live control plane 2026-11-08: a PEER write is already
// refused (`deny_no_grant`, needs `agents:configure`); a SELF write returned
// 200. These tests pin the refusal of the self write and — equally — pin that
// everything which SHOULD still pass still does: a gate that only ever refuses
// is not shown to work.
//
// Harness and the `decideAsAgentWithNoGrants` shape are borrowed from
// `agent-profile-change-gate-mixing.test.ts` (BLO-27751), which exercises the
// sibling branch of the same route.

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
    workspaceOperationService: () => ({}),
  };
}

vi.mock("../services/index.js", () => serviceModuleMocks());
vi.mock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
vi.mock("../services/environments.js", () => ({ environmentService: () => mockEnvironmentService }));
vi.mock("../adapters/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
  // Reached by `adapterSupportsInstructionsBundle` on the create/hire paths.
  // `undefined` is the "adapter declares nothing" case, which falls back to
  // DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES — the production shape for
  // `codex_local`. Omitting it does not fail the test; it 500s the request
  // BEFORE the guard under test, which reads as a refusal in one arm and as a
  // pass in the other.
  findActiveServerAdapter: vi.fn(() => undefined),
  listAdapterModels: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => serviceModuleMocks());
  vi.doMock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
  vi.doMock("../services/environments.js", () => ({ environmentService: () => mockEnvironmentService }));
  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: mockFindServerAdapter,
    findActiveServerAdapter: vi.fn(() => undefined),
    listAdapterModels: vi.fn(),
  }));
}

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const REVISION_ID = "22222222-2222-4222-8222-222222222222";

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

/** Agent row whose stored config has the publish broker ON — the state stage 1 creates. */
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
    adapterConfig: { enableGitHubPublishBroker: true, model: "stored-model" },
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

/**
 * Reproduces `decideBase` for an agent holding NEITHER `agents:configure` NOR
 * `agents:suggest-changes` — the shape of most agents on this fleet, and the
 * shape measured on the Security seat on 2026-11-08. `allow_self` fires for
 * the agent's own row when `requiresChangeGrant` is absent. Board actors are
 * allowed, which is what makes the must-pass arm meaningful.
 */
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

function rollback(app: express.Express) {
  return requestApp(app, (baseUrl) =>
    request(baseUrl).post(`/api/agents/${AGENT_ID}/config-revisions/${REVISION_ID}/rollback`).send({}));
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
  mockAgentService.rollbackConfigRevision.mockImplementation(async () => makeBrokeredAgent());
});

describe("PATCH /api/agents/:id — agent-scope pinned adapterConfig keys (PEN-6188)", () => {
  // THE REGRESSION. Pre-fix this returned 200 and rendered the GitHub push
  // credential back into the agent container at uid 1000.
  it("refuses an agent clearing enableGitHubPublishBroker on ITSELF", async () => {
    const app = await createApp(selfAgentActor());
    const res = await patchAgent(app, { adapterConfig: { enableGitHubPublishBroker: false } });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("adapterConfig.enableGitHubPublishBroker");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  // Removal is the other half: the adapter reads this with
  // `asBoolean(config.x, false)`, so DELETING the key opts out just as well as
  // setting it false. A presence-only guard would pass this.
  it("refuses an agent DROPPING the key via replaceAdapterConfig", async () => {
    const app = await createApp(selfAgentActor());
    const res = await patchAgent(app, {
      replaceAdapterConfig: true,
      adapterConfig: { model: "stored-model" },
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("adapterConfig.enableGitHubPublishBroker");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("refuses an agent setting enablePerAgentWorkspaceVolume on itself", async () => {
    const app = await createApp(selfAgentActor());
    const res = await patchAgent(app, { adapterConfig: { enablePerAgentWorkspaceVolume: true } });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("adapterConfig.enablePerAgentWorkspaceVolume");
  });

  // The composition keys are pinned only WHEN THE BROKER IS ON, mirroring
  // `agentScopeOnlyConfigKeysFor` rather than copying a second list.
  it("refuses enableDocker while the broker is on at agent scope", async () => {
    const app = await createApp(selfAgentActor());
    const res = await patchAgent(app, { adapterConfig: { enableDocker: true } });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("adapterConfig.enableDocker");
  });

  // MUST-PASS ARM, and the one that bounds this change's blast radius: with the
  // broker off — the whole fleet today — the composition keys are not pinned,
  // so no current agent behaviour changes.
  it("allows enableDocker while the broker is OFF at agent scope", async () => {
    mockAgentService.getById.mockResolvedValue(makeBrokeredAgent({ adapterConfig: { model: "stored-model" } }));
    const app = await createApp(selfAgentActor());
    const res = await patchAgent(app, { adapterConfig: { enableDocker: true } });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });

  // MUST-PASS ARM. The guard is diff-based for exactly this reason: the
  // effective config shallow-merges the stored one, so a presence test would
  // refuse every write by a brokered agent, naming a key it never sent
  // (the BLO-32332 shape).
  it("allows an unrelated self write by a brokered agent", async () => {
    const app = await createApp(selfAgentActor());
    const res = await patchAgent(app, { adapterConfig: { model: "new-model" } });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });

  // MUST-PASS ARM. A verbatim round-trip of the pinned key is not a change.
  it("allows an agent resending the pinned key at its stored value", async () => {
    const app = await createApp(selfAgentActor());
    const res = await patchAgent(app, {
      adapterConfig: { enableGitHubPublishBroker: true, model: "new-model" },
    });

    expect(res.status).toBe(200);
  });

  // MUST-PASS ARM, and the one done-when 3 names: the boundary moves the write
  // to a board actor, it does not abolish it.
  it("allows a BOARD actor to clear enableGitHubPublishBroker", async () => {
    const app = await createApp(boardActor());
    const res = await patchAgent(app, { adapterConfig: { enableGitHubPublishBroker: false } });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });
});

// PEN-6259. `image` is pinned on the WRITE side only — it is NOT in
// `AGENT_SCOPE_ONLY_CONFIG_KEYS`, so the heartbeat overlay still honours a
// lower scope's agent-container image, and it IS in
// `agentActorUnwritableConfigKeys`, so an agent actor cannot set it on the
// agent row. These arms pin that split in both directions; harmonising the two
// sets would break one of them.
describe("agent-actor write pin on `image` (PEN-6259)", () => {
  const OPERATOR_IMAGE = "ghcr.io/blockcast/paperclip-agent:operator";
  const AGENT_CHOSEN_IMAGE = "ghcr.io/attacker/agent:self-chosen";

  // THE REGRESSION. `image` becomes `brokerImage` in job-manifest.ts, which
  // execs the publish hook with the GitHub push credential at uid 1001, and no
  // image allowlist exists at any layer.
  it("refuses an agent setting image on ITSELF", async () => {
    const app = await createApp(selfAgentActor());
    const res = await patchAgent(app, { adapterConfig: { image: AGENT_CHOSEN_IMAGE } });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("adapterConfig.image");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  // THE DISCRIMINATING ARM, and the reason `image` is unconditional while the
  // composition keys are broker-conditional. The refusal set is computed
  // against the config AS STORED. With the broker off — the whole fleet today
  // — a broker-conditional `image` would not be in the set here, the write
  // would land, and an OPERATOR flipping `enableGitHubPublishBroker` later
  // (D1 stage 1, PEN-6190) would promote the already-stored agent-chosen value
  // into `brokerImage`. A guard whose condition is set by a later, independent
  // act is not a guard. Add `image` to BROKERED_POD_COMPOSITION_CONFIG_KEYS
  // instead and THIS test goes green-to-red.
  it("refuses image even while the broker is OFF at agent scope", async () => {
    mockAgentService.getById.mockResolvedValue(makeBrokeredAgent({ adapterConfig: { model: "stored-model" } }));
    const app = await createApp(selfAgentActor());
    const res = await patchAgent(app, { adapterConfig: { image: AGENT_CHOSEN_IMAGE } });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("adapterConfig.image");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  // MUST-PASS ARM. The boundary moves the write to a board actor; it does not
  // abolish it. The operator image-bump path does not pass through this route
  // at all (`services/agent-image-bump.ts` writes in-process), so this is the
  // only image write the guard can even see.
  it("allows a BOARD actor to set image", async () => {
    const app = await createApp(boardActor());
    const res = await patchAgent(app, { adapterConfig: { image: OPERATOR_IMAGE } });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });

  // MUST-PASS ARM. Diff-based, not presence-based: once an agent HAS an image,
  // a presence test would refuse every subsequent adapterConfig write it makes,
  // naming a key it never changed (the BLO-32332 shape).
  it("allows an agent resending image at its stored value", async () => {
    mockAgentService.getById.mockResolvedValue(makeBrokeredAgent({
      adapterConfig: { enableGitHubPublishBroker: true, model: "stored-model", image: OPERATOR_IMAGE },
    }));
    const app = await createApp(selfAgentActor());
    const res = await patchAgent(app, { adapterConfig: { image: OPERATOR_IMAGE, model: "new-model" } });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });

  // Removal is the other half, as it is for every key in this set: the adapter
  // falls back to the server's own image when `image` is absent, so DROPPING a
  // pinned operator image is a change the agent chose.
  it("refuses an agent dropping a stored image via replaceAdapterConfig", async () => {
    mockAgentService.getById.mockResolvedValue(makeBrokeredAgent({
      adapterConfig: { enableGitHubPublishBroker: true, model: "stored-model", image: OPERATOR_IMAGE },
    }));
    const app = await createApp(selfAgentActor());
    const res = await patchAgent(app, {
      replaceAdapterConfig: true,
      adapterConfig: { enableGitHubPublishBroker: true, model: "stored-model" },
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("adapterConfig.image");
  });

  it("refuses an agent rolling back to a revision that changes image", async () => {
    mockAgentService.getById.mockResolvedValue(makeBrokeredAgent({
      adapterConfig: { enableGitHubPublishBroker: true, model: "stored-model", image: OPERATOR_IMAGE },
    }));
    mockAgentService.getConfigRevision.mockResolvedValue({
      id: REVISION_ID,
      agentId: AGENT_ID,
      afterConfig: {
        adapterConfig: {
          enableGitHubPublishBroker: true,
          model: "stored-model",
          image: AGENT_CHOSEN_IMAGE,
        },
      },
    });
    const app = await createApp(selfAgentActor());
    const res = await rollback(app);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("adapterConfig.image");
    expect(mockAgentService.rollbackConfigRevision).not.toHaveBeenCalled();
  });

  // Create/hire carries no stored config, so the diff baseline is `{}` and ANY
  // supplied `image` is a change — including one identical to the default.
  // That is the full blast radius of this arm and it is stated rather than
  // worked around: no agent-authored hire path supplies `image` today.
  it("refuses an agent hire that supplies image", async () => {
    mockAccessService.decide.mockImplementation(async (input: any) =>
      input.action === "agents:create"
        ? { allowed: true, reason: "allow_grant", explanation: "Granted." }
        : decideAsAgentWithNoGrants(input));
    const app = await createApp(selfAgentActor());
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post("/api/companies/company-1/agent-hires").send({
        name: "Hired",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: { image: AGENT_CHOSEN_IMAGE },
      }));

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("adapterConfig.image");
    expect(mockSecretService.normalizeAdapterConfigForPersistence).not.toHaveBeenCalled();
  });

  // MUST-PASS ARM, and the SCOPE decision rather than an oversight. A
  // model-profile `adapterConfig` is not the object the broker reads its image
  // from — `buildJobManifest` resolves `brokerImage` off `ctx.agent.adapter
  // Config`, the agent row verbatim, before any merge. Refusing `image` here
  // would cost a capability and close no hazard, so `configScope:
  // "model_profile"` deliberately uses the narrower overlay set. If this turns
  // red, someone has applied the write-side set uniformly.
  it("allows an agent setting image on a MODEL PROFILE", async () => {
    mockAgentService.getById.mockResolvedValue(makeBrokeredAgent({
      runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { model: "profile-model" } } } },
    }));
    const app = await createApp(selfAgentActor());
    const res = await patchAgent(app, {
      runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { model: "profile-model", image: AGENT_CHOSEN_IMAGE } } } },
    });

    // Asserted on a PROGRESS MARKER as well as the status, for the reason the
    // hire must-pass arm below records: a bare `not.toBe(403)` passes whether
    // the guard allowed the write or the request died somewhere past it.
    // `agentService.update` is the first mocked call after the runtimeConfig
    // guard, so calling it is positive evidence the guard let this through.
    expect(res.status).not.toBe(403);
    expect(mockAgentService.update).toHaveBeenCalled();
  });
});

describe("POST /api/agents/:id/config-revisions/:revisionId/rollback (PEN-6188)", () => {
  function reviseTo(adapterConfig: Record<string, unknown>) {
    mockAgentService.getConfigRevision.mockResolvedValue({
      id: REVISION_ID,
      agentId: AGENT_ID,
      afterConfig: { adapterConfig },
    });
  }

  // THE SECOND PATH. Rollback restores adapterConfig wholesale and carried none
  // of the agent-actor guards, so a stored revision from before the broker was
  // enabled was a one-request way back to it.
  it("refuses an agent rolling back to a revision that clears the pinned key", async () => {
    reviseTo({ model: "stored-model" });
    const app = await createApp(selfAgentActor());
    const res = await rollback(app);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("adapterConfig.enableGitHubPublishBroker");
    expect(mockAgentService.rollbackConfigRevision).not.toHaveBeenCalled();
  });

  // The same route was also a way back to a prior instructions bundle path —
  // the boundary `assertNoAgentInstructionsConfigMutation` holds on PATCH.
  it("refuses an agent rolling back to a revision with a different instructions path", async () => {
    reviseTo({ enableGitHubPublishBroker: true, instructionsFilePath: "/tmp/other/AGENTS.md" });
    const app = await createApp(selfAgentActor());
    const res = await rollback(app);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("instructionsFilePath");
    expect(mockAgentService.rollbackConfigRevision).not.toHaveBeenCalled();
  });

  // MUST-PASS ARM: a rollback that moves no guarded key is still allowed.
  it("allows an agent rolling back a revision that changes only an unguarded key", async () => {
    reviseTo({ enableGitHubPublishBroker: true, model: "older-model" });
    const app = await createApp(selfAgentActor());
    const res = await rollback(app);

    expect(res.status).toBe(200);
    expect(mockAgentService.rollbackConfigRevision).toHaveBeenCalled();
  });

  // MUST-PASS ARM: board rollback is untouched, including across pinned keys.
  it("allows a BOARD actor to roll back across the pinned key", async () => {
    reviseTo({ model: "stored-model" });
    const app = await createApp(boardActor());
    const res = await rollback(app);

    expect(res.status).toBe(200);
    expect(mockAgentService.rollbackConfigRevision).toHaveBeenCalled();
  });
});

// PEN-6201. `configPatchFromSnapshot` restores BOTH `adapterConfig` and
// `runtimeConfig`, and the block above closed only the first arm.
// `runtimeConfig.modelProfiles.*.adapterConfig` is a real adapter config whose
// instructions keys are honoured at dispatch (measured in
// heartbeat-model-profile.test.ts, "instructions-bundle reachability"), and
// `assertNoAgentRuntimeConfigAdapterConfigMutation` is the guard PATCH holds
// over it. Rollback made no such call.
describe("POST /api/agents/:id/config-revisions/:revisionId/rollback — runtimeConfig (PEN-6201)", () => {
  function reviseTo(afterConfig: Record<string, unknown>) {
    mockAgentService.getConfigRevision.mockResolvedValue({
      id: REVISION_ID,
      agentId: AGENT_ID,
      afterConfig: { adapterConfig: { enableGitHubPublishBroker: true }, ...afterConfig },
    });
  }

  function withModelProfile(adapterConfig: Record<string, unknown>) {
    return { runtimeConfig: { modelProfiles: { cheap: { adapterConfig } } } };
  }

  // THE REGRESSION. Pre-fix this returned 200 and the restored profile config
  // reached the run's effective adapter config, re-pointing the instructions
  // bundle the agent runs from.
  it("refuses an agent rolling back to a profile adapterConfig with a different instructions path", async () => {
    mockAgentService.getById.mockResolvedValue(makeBrokeredAgent({
      runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { instructionsRootPath: "/paperclip/agents/self" } } } },
    }));
    reviseTo(withModelProfile({ instructionsRootPath: "/tmp/attacker" }));
    const app = await createApp(selfAgentActor());
    const res = await rollback(app);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("runtimeConfig.modelProfiles.cheap.adapterConfig.instructionsRootPath");
    expect(mockAgentService.rollbackConfigRevision).not.toHaveBeenCalled();
  });

  // A profile the agent's stored runtimeConfig does not have at all. The diff
  // baseline is `null` there, so an introduction has to count as a change — a
  // guard keyed only on "this profile's stored value differs" would pass this.
  it("refuses an agent rolling back to a NEW profile carrying an instructions path", async () => {
    mockAgentService.getById.mockResolvedValue(makeBrokeredAgent({ runtimeConfig: {} }));
    reviseTo(withModelProfile({ instructionsFilePath: "/tmp/attacker/AGENTS.md" }));
    const app = await createApp(selfAgentActor());
    const res = await rollback(app);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("runtimeConfig.modelProfiles.cheap.adapterConfig.instructionsFilePath");
  });

  // The `pinnedKeySourceConfig` half, and the one arm that is about WHICH
  // object the pinned SET is read from rather than about the diff. The agent's
  // own config has the broker ON, so the composition keys are pinned for this
  // run; the PROFILE's stored config does not mention the broker. Computing
  // the set from the profile — which is what this guard did — reads the
  // conditional's input off an object that cannot carry it, and lets
  // `enableDocker` through.
  it("refuses a profile enableDocker because the AGENT's config has the broker on", async () => {
    mockAgentService.getById.mockResolvedValue(makeBrokeredAgent({
      runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { model: "profile-model" } } } },
    }));
    reviseTo(withModelProfile({ model: "profile-model", enableDocker: true }));
    const app = await createApp(selfAgentActor());
    const res = await rollback(app);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("runtimeConfig.modelProfiles.cheap.adapterConfig.enableDocker");
  });

  // MUST-PASS ARM. Same shape as the refusal above with the broker OFF at
  // AGENT scope — the composition keys are then not pinned for this run, so
  // this must still be allowed. Without it, the arm above would also pass a
  // guard that simply refuses every profile write.
  it("allows a profile enableDocker while the broker is OFF at agent scope", async () => {
    mockAgentService.getById.mockResolvedValue(makeBrokeredAgent({
      adapterConfig: { model: "stored-model" },
      runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { model: "profile-model" } } } },
    }));
    mockAgentService.getConfigRevision.mockResolvedValue({
      id: REVISION_ID,
      agentId: AGENT_ID,
      afterConfig: {
        adapterConfig: { model: "stored-model" },
        ...withModelProfile({ model: "profile-model", enableDocker: true }),
      },
    });
    const app = await createApp(selfAgentActor());
    const res = await rollback(app);

    expect(res.status).toBe(200);
    expect(mockAgentService.rollbackConfigRevision).toHaveBeenCalled();
  });

  // MUST-PASS ARM: a rollback whose profile config moves no guarded key.
  it("allows an agent rolling back a profile adapterConfig that moves only a model", async () => {
    mockAgentService.getById.mockResolvedValue(makeBrokeredAgent({
      runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { model: "newer-model" } } } },
    }));
    reviseTo(withModelProfile({ model: "older-model" }));
    const app = await createApp(selfAgentActor());
    const res = await rollback(app);

    expect(res.status).toBe(200);
    expect(mockAgentService.rollbackConfigRevision).toHaveBeenCalled();
  });

  // MUST-PASS ARM: a verbatim round-trip of the stored profile config is not a
  // change. This is the BLO-32332 shape at one level of nesting — a presence
  // test here would refuse every rollback by an agent that has any profile.
  it("allows a rollback that restores the profile config byte-for-byte", async () => {
    const profileConfig = { instructionsRootPath: "/paperclip/agents/self", model: "profile-model" };
    mockAgentService.getById.mockResolvedValue(makeBrokeredAgent({
      runtimeConfig: { modelProfiles: { cheap: { adapterConfig: profileConfig } } },
    }));
    reviseTo(withModelProfile({ ...profileConfig }));
    const app = await createApp(selfAgentActor());
    const res = await rollback(app);

    expect(res.status).toBe(200);
  });

  // MUST-PASS ARM: board rollback across the same profile key is untouched.
  it("allows a BOARD actor to roll back across a profile instructions path", async () => {
    mockAgentService.getById.mockResolvedValue(makeBrokeredAgent({ runtimeConfig: {} }));
    reviseTo(withModelProfile({ instructionsRootPath: "/tmp/other" }));
    const app = await createApp(boardActor());
    const res = await rollback(app);

    expect(res.status).toBe(200);
    expect(mockAgentService.rollbackConfigRevision).toHaveBeenCalled();
  });
});

// PEN-6201, carried over from the same review: the guard runs on agent-authored
// CREATE and HIRE and nothing pinned that. Those paths pass no
// `existingAdapterConfig`, so `existing = {}` and
// `JSON.stringify(false) !== JSON.stringify(undefined)` — a hire carrying
// `enableGitHubPublishBroker: false` is refused even though `false` is the
// fleet-wide value.
//
// That refusal is INTENDED, not a defect to soften: without it an agent opts
// out of the boundary by proxy, by hiring a new agent with the key already
// cleared and working there instead. It is pinned here because it is
// surprising — an agent-driven hire flow that copies an existing config
// verbatim starts failing — and an intended refusal nobody wrote down is
// indistinguishable from a regression when someone meets it.
describe("POST /api/companies/:companyId/agent-hires — agent-authored (PEN-6201)", () => {
  const BASE_HIRE = {
    name: "Hired",
    role: "engineer",
    adapterType: "codex_local",
  };

  function hire(app: express.Express, body: Record<string, unknown>) {
    return requestApp(app, (baseUrl) =>
      request(baseUrl).post("/api/companies/company-1/agent-hires").send(body));
  }

  // `agents:create` has to be allowed for the request to REACH the guard; the
  // shared `decideAsAgentWithNoGrants` denies it, which would 403 one layer
  // early and make the refusal arm below pass for the wrong reason.
  beforeEach(() => {
    mockAccessService.decide.mockImplementation(async (input: any) =>
      input.action === "agents:create"
        ? { allowed: true, reason: "allow_grant", explanation: "Granted." }
        : decideAsAgentWithNoGrants(input));
  });

  it("refuses an agent hiring with enableGitHubPublishBroker present, even at false", async () => {
    const app = await createApp(selfAgentActor());
    const res = await hire(app, { ...BASE_HIRE, adapterConfig: { enableGitHubPublishBroker: false } });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("adapterConfig.enableGitHubPublishBroker");
    expect(mockSecretService.normalizeAdapterConfigForPersistence).not.toHaveBeenCalled();
  });

  // MUST-PASS ARM, and the half that makes the refusal above a finding about
  // THIS key rather than about the hire path refusing everything.
  //
  // Asserted on a PROGRESS MARKER, not on the status, and that is the point:
  // this suite does not mock the hire route's `db.select` for the company, so
  // the request 500s a few statements past the guard either way. A plain
  // `expect(status).not.toBe(403)` therefore passes whether the guard allowed
  // the write or the request died before ever reaching it — measured, it was
  // passing for the second reason while the adapters mock was missing
  // `findActiveServerAdapter`.
  //
  // `secretService.normalizeAdapterConfigForPersistence` is the first mocked
  // call AFTER both guards (`routes/agents.ts`, hire path), so calling it is
  // positive evidence the guard let the request through, and the refusal arm
  // above asserts the converse.
  it("does not refuse an agent hire that names no pinned key", async () => {
    const app = await createApp(selfAgentActor());
    const res = await hire(app, { ...BASE_HIRE, adapterConfig: { model: "some-model" } });

    expect(res.status).not.toBe(403);
    expect(mockSecretService.normalizeAdapterConfigForPersistence).toHaveBeenCalled();
  });
});

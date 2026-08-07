import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ragHealthBucketCache } from "../routes/plugins.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  listByStatus: vi.fn(),
  getConfig: vi.fn(),
  upsertConfig: vi.fn(),
  getCompanySettings: vi.fn(),
  upsertCompanySettings: vi.fn(),
}));

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
  unload: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  getById: vi.fn(),
  syncSecretRefsForTarget: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

async function createApp(
  actor: Record<string, unknown>,
  loaderOverrides: Record<string, unknown> = {},
  routeOverrides: {
    db?: unknown;
    jobDeps?: unknown;
    toolDeps?: unknown;
    bridgeDeps?: unknown;
    captureJsonContext?: (context: unknown, body: unknown) => void;
  } = {},
) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const loader = {
    installPlugin: vi.fn(),
    ...loaderOverrides,
  };

  const app = express();
  app.use(express.json());
  if (routeOverrides.captureJsonContext) {
    app.use((_req, res, next) => {
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        routeOverrides.captureJsonContext?.((res as any).__errorContext, body);
        return originalJson(body);
      }) as typeof res.json;
      next();
    });
  }
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", pluginRoutes(
    (routeOverrides.db ?? {}) as never,
    loader as never,
    routeOverrides.jobDeps as never,
    undefined,
    routeOverrides.toolDeps as never,
    routeOverrides.bridgeDeps as never,
  ));
  app.use(errorHandler);

  return { app, loader };
}

function createSelectQueueDb(rows: Array<Array<Record<string, unknown>>>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(rows.shift() ?? [])),
        })),
      })),
    })),
  };
}

function createRagHealthDb(
  pluginRows: Array<Record<string, unknown>>,
  bucketRows: Array<Record<string, unknown>>,
) {
  const pluginOrderBy = vi.fn(() => Promise.resolve(pluginRows));
  const pluginWhere = vi.fn(() => ({ orderBy: pluginOrderBy }));
  const pluginFrom = vi.fn(() => ({ where: pluginWhere }));

  const bucketOrderBy = vi.fn(() => Promise.resolve(bucketRows));
  const bucketGroupBy = vi.fn(() => ({ orderBy: bucketOrderBy }));
  const bucketWhere = vi.fn(() => ({ groupBy: bucketGroupBy }));
  const bucketInnerJoin = vi.fn(() => ({ where: bucketWhere }));
  const bucketFrom = vi.fn(() => ({ innerJoin: bucketInnerJoin }));

  const select = vi.fn()
    .mockReturnValueOnce({ from: pluginFrom })
    .mockReturnValueOnce({ from: bucketFrom });
  return {
    bucketFrom,
    bucketGroupBy,
    bucketInnerJoin,
    bucketOrderBy,
    bucketWhere,
    pluginFrom,
    pluginOrderBy,
    pluginWhere,
    select,
  };
}

const companyA = "22222222-2222-4222-8222-222222222222";
const companyB = "33333333-3333-4333-8333-333333333333";
const agentA = "44444444-4444-4444-8444-444444444444";
const runA = "55555555-5555-4555-8555-555555555555";
const projectA = "66666666-6666-4666-8666-666666666666";
const pluginId = "11111111-1111-4111-8111-111111111111";
const pluginActionRpcTimeoutMs = 15 * 60 * 1_000;
const secretId = "77777777-7777-4777-8777-777777777777";

function boardActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyA],
    ...overrides,
  };
}

function agentActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    agentId: agentA,
    companyId: companyA,
    runId: runA,
    source: "agent_jwt",
    ...overrides,
  };
}

function readyPlugin() {
  mockRegistry.getById.mockResolvedValue({
    id: pluginId,
    pluginKey: "paperclip.example",
    version: "1.0.0",
    status: "ready",
  });
}

describe.sequential("plugin install and upgrade authz", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ragHealthBucketCache.clear();
  });

  it("lists bundled monorepo plugin packages", async () => {
    const { app } = await createApp(boardActor());

    const res = await request(app).get("/api/plugins/examples");

    expect(res.status).toBe(200);
    const packageNames = res.body.map((plugin: { packageName: string }) => plugin.packageName);
    const byPackageName = new Map(
      res.body.map((plugin: { packageName: string; experimental: boolean; hasBuiltEntrypoints: boolean }) => [plugin.packageName, plugin]),
    );
    expect(packageNames).toContain("@paperclipai/plugin-workspace-diff");
    expect(packageNames).toContain("@paperclipai/plugin-llm-wiki");
    expect(packageNames).toContain("@paperclipai/plugin-modal");
    expect(packageNames).toContain("@paperclipai/plugin-authoring-smoke-example");
    expect(packageNames).not.toContain("@paperclipai/plugin-sdk");
    expect(byPackageName.get("@paperclipai/plugin-workspace-diff")?.experimental).toBe(true);
    expect(byPackageName.get("@paperclipai/plugin-llm-wiki")?.experimental).toBe(true);
    expect(byPackageName.get("@paperclipai/plugin-modal")?.experimental).toBe(true);
    expect(byPackageName.get("@paperclipai/plugin-authoring-smoke-example")?.experimental).toBe(false);
    expect(typeof byPackageName.get("@paperclipai/plugin-workspace-diff")?.hasBuiltEntrypoints).toBe("boolean");
  }, 90_000);

  it("returns one plugin-health page payload for errored active plugins", async () => {
    const erroredPlugin = {
      id: pluginId,
      pluginKey: "paperclip-plugin-alertmanager",
      version: "1.0.0",
      status: "error",
      lastError: "worker exited with code 1",
      updatedAt: new Date("2026-06-13T12:00:00.000Z"),
    };
    mockRegistry.listByStatus.mockResolvedValue([erroredPlugin]);

    const { app } = await createApp(boardActor());
    const res = await request(app).get("/api/plugins/alerts/plugin-health");

    expect(res.status).toBe(200);
    expect(mockRegistry.listByStatus).toHaveBeenCalledWith("error");
    expect(res.body.status).toBe("firing");
    expect(res.body.alerts).toEqual([
      expect.objectContaining({
        alertname: "PaperclipPluginError",
        severity: "page",
        pluginId,
        pluginKey: "paperclip-plugin-alertmanager",
        status: "error",
        lastError: "worker exited with code 1",
        updatedAt: "2026-06-13T12:00:00.000Z",
      }),
    ]);
    expect(res.body.alerts[0].description).toContain("worker exited with code 1");
  }, 20_000);

  it("suppresses healthy, disabled, and paused plugin fixtures from plugin-health pages", async () => {
    mockRegistry.listByStatus.mockResolvedValue([]);

    const { app } = await createApp(boardActor());
    const res = await request(app).get("/api/plugins/alerts/plugin-health");

    expect(res.status).toBe(200);
    expect(mockRegistry.listByStatus).toHaveBeenCalledWith("error");
    expect(res.body).toMatchObject({
      status: "ok",
      alerts: [],
    });
  }, 20_000);

  it("lets agents read the narrow RAG health summary for their company", async () => {
    const updatedAt = new Date("2026-06-29T12:00:00.000Z");
    const db = createRagHealthDb(
      [
        {
          id: pluginId,
          pluginKey: "paperclip-plugin-gbrain",
          status: "error",
          lastError: "terminal 401",
          updatedAt,
        },
      ],
      [],
    );
    // Pre-populate the cache so the handler returns it immediately without
    // firing the background refresh (which uses db.transaction, not db.select).
    ragHealthBucketCache.set(`${companyA}:7`, {
      result: [{ status: "ok", count: 3 }, { status: "island", count: 2 }],
      ts: Date.now(),
      loading: false,
    });
    const { app } = await createApp(agentActor(), {}, { db });

    const res = await request(app).get("/api/plugins/rag-health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      companyId: companyA,
      windowDays: 7,
      pluginErrors: [
        {
          id: pluginId,
          pluginKey: "paperclip-plugin-gbrain",
          status: "error",
          lastError: "terminal 401",
          updatedAt: "2026-06-29T12:00:00.000Z",
        },
      ],
      gbrainContextBuckets: [
        { status: "ok", count: 3 },
        { status: "island", count: 2 },
      ],
    });
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(db.pluginWhere).toHaveBeenCalledOnce();
  }, 20_000);

  it("ignores agent query overrides for the RAG health company scope", async () => {
    const db = createRagHealthDb([], []);
    const { app } = await createApp(agentActor(), {}, { db });

    const res = await request(app).get(`/api/plugins/rag-health?companyId=${companyB}`);

    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(companyA);
  }, 20_000);

  it("lets board users read RAG health for an accessible company", async () => {
    ragHealthBucketCache.set(`${companyA}:14`, {
      result: [{ status: "no-issue-page", count: 1 }],
      ts: Date.now(),
      loading: false,
    });
    const db = createRagHealthDb([], []);
    const { app } = await createApp(boardActor(), {}, { db });

    const res = await request(app).get(`/api/plugins/rag-health?companyId=${companyA}&days=14`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      companyId: companyA,
      windowDays: 14,
      pluginErrors: [],
      gbrainContextBuckets: [{ status: "no-issue-page", count: 1 }],
    });
  }, 20_000);

  it("rejects plugin installation for non-admin board users", async () => {
    const { app, loader } = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: "paperclip-plugin-example" });

    expect(res.status).toBe(403);
    expect(loader.installPlugin).not.toHaveBeenCalled();
  }, 20_000);

  it("allows instance admins to install plugins", async () => {
    const pluginId = "11111111-1111-4111-8111-111111111111";
    const pluginKey = "paperclip.example";
    const discovered = {
      manifest: {
        id: pluginKey,
      },
    };

    mockRegistry.getByKey.mockResolvedValue({
      id: pluginId,
      pluginKey,
      packageName: "paperclip-plugin-example",
      version: "1.0.0",
    });
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey,
      packageName: "paperclip-plugin-example",
      version: "1.0.0",
    });
    mockLifecycle.load.mockResolvedValue(undefined);

    const { app, loader } = await createApp(
      {
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
        companyIds: [],
      },
      { installPlugin: vi.fn().mockResolvedValue(discovered) },
    );

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: "paperclip-plugin-example" });

    expect(res.status).toBe(200);
    expect(loader.installPlugin).toHaveBeenCalledWith({
      packageName: "paperclip-plugin-example",
      version: undefined,
    });
    expect(mockLifecycle.load).toHaveBeenCalledWith(pluginId);
  }, 20_000);

  it("rejects force=true without isLocalPath=true", async () => {
    const { app, loader } = await createApp(
      {
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
        companyIds: [],
      },
      { installPlugin: vi.fn() },
    );

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: "paperclip-plugin-example", force: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/force/i);
    expect(loader.installPlugin).not.toHaveBeenCalled();
  }, 20_000);

  it("threads force=true with isLocalPath=true to loader and skips lifecycle.load", async () => {
    const pluginId = "22222222-2222-4222-8222-222222222222";
    const pluginKey = "paperclip.example";
    const discovered = { manifest: { id: pluginKey } };

    mockRegistry.getByKey.mockResolvedValue({
      id: pluginId,
      pluginKey,
      packageName: "/app/packages/plugins/example",
      version: "1.0.0",
      status: "ready",
    });
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey,
      packageName: "/app/packages/plugins/example",
      version: "1.0.0",
      status: "ready",
    });

    const installPlugin = vi.fn().mockResolvedValue(discovered);
    const { app } = await createApp(
      {
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
        companyIds: [],
      },
      { installPlugin },
    );

    const res = await request(app)
      .post("/api/plugins/install")
      .send({
        packageName: "/app/packages/plugins/example",
        isLocalPath: true,
        force: true,
      });

    expect(res.status).toBe(200);
    expect(installPlugin).toHaveBeenCalledWith({
      localPath: "/app/packages/plugins/example",
      force: true,
    });
    // Skipping lifecycle.load avoids restarting an in-flight worker; the
    // updated package_name/path takes effect on the next worker (re)start.
    expect(mockLifecycle.load).not.toHaveBeenCalled();
  }, 20_000);

  it("rejects plugin upgrades for non-admin board users", async () => {
    const pluginId = "11111111-1111-4111-8111-111111111111";
    const { app } = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/upgrade`)
      .send({});

    expect(res.status).toBe(403);
    expect(mockRegistry.getById).not.toHaveBeenCalled();
    expect(mockLifecycle.upgrade).not.toHaveBeenCalled();
  }, 20_000);

  it.each([
    ["delete", "delete", "/api/plugins/11111111-1111-4111-8111-111111111111", undefined],
    ["enable", "post", "/api/plugins/11111111-1111-4111-8111-111111111111/enable", {}],
    ["disable", "post", "/api/plugins/11111111-1111-4111-8111-111111111111/disable", {}],
    ["config", "post", "/api/plugins/11111111-1111-4111-8111-111111111111/config", { configJson: {} }],
  ] as const)("rejects plugin %s for non-admin board users", async (_name, method, path, body) => {
    const { app } = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const req = method === "delete" ? request(app).delete(path) : request(app).post(path).send(body);
    const res = await req;

    expect(res.status).toBe(403);
    expect(mockRegistry.getById).not.toHaveBeenCalled();
    expect(mockRegistry.upsertConfig).not.toHaveBeenCalled();
    expect(mockLifecycle.unload).not.toHaveBeenCalled();
    expect(mockLifecycle.enable).not.toHaveBeenCalled();
    expect(mockLifecycle.disable).not.toHaveBeenCalled();
  }, 20_000);

  it("resolves plugin keys without probing the UUID id column for core plugin actions", async () => {
    const pluginKey = "paperclipqa.hello-plugin";
    const plugin = {
      id: pluginId,
      pluginKey,
      version: "1.0.0",
      status: "ready",
    };
    mockRegistry.getById.mockImplementation(() => {
      throw new Error("getById should not be called for plugin keys");
    });
    mockRegistry.getByKey.mockResolvedValue(plugin);
    mockLifecycle.unload.mockResolvedValue(plugin);
    mockLifecycle.enable.mockResolvedValue(plugin);
    mockLifecycle.disable.mockResolvedValue(plugin);

    const { app } = await createApp({
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyA],
    });

    const inspectRes = await request(app).get(`/api/plugins/${pluginKey}`);
    const disableRes = await request(app).post(`/api/plugins/${pluginKey}/disable`).send({});
    const enableRes = await request(app).post(`/api/plugins/${pluginKey}/enable`).send({});
    const uninstallRes = await request(app).delete(`/api/plugins/${pluginKey}?purge=true`);

    expect(inspectRes.status).toBe(200);
    expect(disableRes.status).toBe(200);
    expect(enableRes.status).toBe(200);
    expect(uninstallRes.status).toBe(200);
    expect(mockRegistry.getById).not.toHaveBeenCalled();
    expect(mockRegistry.getByKey).toHaveBeenCalledWith(pluginKey);
    expect(mockLifecycle.disable).toHaveBeenCalledWith(pluginId, undefined);
    expect(mockLifecycle.enable).toHaveBeenCalledWith(pluginId);
    expect(mockLifecycle.unload).toHaveBeenCalledWith(pluginId, true);
  }, 20_000);

  it("allows instance admins to save company-scoped secret refs and sync plugin bindings", async () => {
    readyPlugin();
    const configJson = {
      apiKeyRef: { type: "secret_ref", secretId, version: "latest" },
    };
    mockSecretService.getById.mockResolvedValue({ id: secretId, companyId: companyA, status: "active" });
    mockSecretService.syncSecretRefsForTarget.mockResolvedValue([]);
    mockRegistry.upsertConfig.mockResolvedValue({ id: "config-1", pluginId, companyId: companyA, configJson });

    const { app } = await createApp({
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyA],
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/config`)
      .send({ companyId: companyA, configJson });

    expect(res.status).toBe(200);
    expect(mockSecretService.getById).toHaveBeenCalledWith(secretId);
    expect(mockSecretService.syncSecretRefsForTarget).toHaveBeenCalledWith(
      companyA,
      { targetType: "plugin", targetId: pluginId },
      [expect.objectContaining({ secretId, configPath: "apiKeyRef", versionSelector: "latest" })],
      { replaceAll: true },
    );
    expect(mockRegistry.upsertConfig).toHaveBeenCalledWith(pluginId, companyA, {
      companyId: companyA,
      configJson,
    });
  }, 20_000);

  it("rejects plugin config saves that reference another company's secret before syncing bindings", async () => {
    readyPlugin();
    mockSecretService.getById.mockResolvedValue({ id: secretId, companyId: companyB, status: "active" });
    mockSecretService.syncSecretRefsForTarget.mockResolvedValue([]);

    const { app } = await createApp({
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyA],
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/config`)
      .send({
        companyId: companyA,
        configJson: {
          apiKeyRef: { type: "secret_ref", secretId, version: "latest" },
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outside the selected company/i);
    expect(mockSecretService.syncSecretRefsForTarget).not.toHaveBeenCalled();
    expect(mockRegistry.upsertConfig).not.toHaveBeenCalled();
  }, 20_000);

  it("allows instance admins to upgrade plugins", async () => {
    const pluginId = "11111111-1111-4111-8111-111111111111";
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey: "paperclip.example",
      version: "1.0.0",
    });
    mockLifecycle.upgrade.mockResolvedValue({
      id: pluginId,
      version: "1.1.0",
    });

    const { app } = await createApp({
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/upgrade`)
      .send({ version: "1.1.0" });

    expect(res.status).toBe(200);
    expect(mockLifecycle.upgrade).toHaveBeenCalledWith(pluginId, "1.1.0", { force: false });
  }, 20_000);
});

describe.sequential("scoped plugin API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches manifest-declared scoped routes after company access checks", async () => {
    const pluginId = "11111111-1111-4111-8111-111111111111";
    const workerManager = {
      call: vi.fn().mockResolvedValue({
        status: 202,
        body: { ok: true },
      }),
    };
    mockRegistry.getById.mockResolvedValue(null);
    mockRegistry.getByKey.mockResolvedValue({
      id: pluginId,
      pluginKey: "paperclip.example",
      version: "1.0.0",
      status: "ready",
      manifestJson: {
        id: "paperclip.example",
        capabilities: ["api.routes.register"],
        apiRoutes: [
          {
            routeKey: "smoke",
            method: "GET",
            path: "/smoke",
            auth: "board-or-agent",
            capability: "api.routes.register",
            companyResolution: { from: "query", key: "companyId" },
          },
        ],
      },
    });

    const { app } = await createApp(
      {
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: false,
        companyIds: ["company-1"],
      },
      {},
      { bridgeDeps: { workerManager } },
    );

    const res = await request(app)
      .get("/api/plugins/paperclip.example/api/smoke")
      .query({ companyId: "company-1" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "handleApiRequest",
      expect.objectContaining({
        routeKey: "smoke",
        method: "GET",
        companyId: "company-1",
        query: { companyId: "company-1" },
      }),
    );
  }, 20_000);
});

describe.sequential("plugin local folder routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getCompanySettings.mockResolvedValue(null);
  });

  function readyLocalFolderPlugin() {
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey: "paperclip.example",
      version: "1.0.0",
      status: "ready",
      manifestJson: {
        id: "paperclip.example",
        capabilities: ["local.folders"],
        localFolders: [
          {
            folderKey: "content-root",
            displayName: "Content root",
            access: "readWrite",
            requiredDirectories: ["docs"],
            requiredFiles: ["README.md"],
          },
        ],
      },
    });
  }

  it("rejects validation for undeclared local folder keys", async () => {
    readyLocalFolderPlugin();
    const { app } = await createApp(boardActor());

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/companies/${companyA}/local-folders/ssh/validate`)
      .send({ path: "/tmp" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Local folder key is not declared");
    expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
  });

  it("rejects saving undeclared local folder keys", async () => {
    readyLocalFolderPlugin();
    const { app } = await createApp(boardActor());

    const res = await request(app)
      .put(`/api/plugins/${pluginId}/companies/${companyA}/local-folders/ssh`)
      .send({ path: "/tmp" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Local folder key is not declared");
    expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
  });
});

describe.sequential("plugin tool and bridge authz", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows board tool execution without a runContext", async () => {
    const executeTool = vi.fn().mockResolvedValue({ content: "ok" });
    const { app } = await createApp(boardActor(), {}, {
      toolDeps: {
        toolDispatcher: {
          listToolsForAgent: vi.fn(),
          getTool: vi.fn(() => ({ name: "paperclip.example:search" })),
          executeTool,
        },
      },
    });

    const res = await request(app)
      .post("/api/plugins/tools/execute")
      .send({
        tool: "paperclip.example:search",
        parameters: { q: "test" },
      });

    expect(res.status).toBe(200);
    expect(executeTool).toHaveBeenCalledWith(
      "paperclip.example:search",
      { q: "test" },
      {},
    );
  });

  it("allows board tool execution with MCP-style company-only runContext", async () => {
    const executeTool = vi.fn().mockResolvedValue({ content: "ok" });
    const { app } = await createApp(boardActor(), {}, {
      toolDeps: {
        toolDispatcher: {
          listToolsForAgent: vi.fn(),
          getTool: vi.fn(() => ({ name: "paperclip.example:search" })),
          executeTool,
        },
      },
    });

    const res = await request(app)
      .post("/api/plugins/tools/execute")
      .send({
        tool: "paperclip.example:search",
        parameters: { q: "test" },
        runContext: {
          agentId: null,
          runId: null,
          companyId: companyA,
          projectId: null,
        },
      });

    expect(res.status).toBe(200);
    expect(executeTool).toHaveBeenCalledWith(
      "paperclip.example:search",
      { q: "test" },
      { companyId: companyA },
    );
  });

  it("rejects tool execution when the board user cannot access runContext.companyId", async () => {
    const executeTool = vi.fn();
    const getTool = vi.fn();
    const { app } = await createApp(boardActor(), {}, {
      toolDeps: {
        toolDispatcher: {
          listToolsForAgent: vi.fn(),
          getTool,
          executeTool,
        },
      },
    });

    const res = await request(app)
      .post("/api/plugins/tools/execute")
      .send({
        tool: "paperclip.example:search",
        parameters: {},
        runContext: {
          agentId: agentA,
          runId: runA,
          companyId: companyB,
          projectId: projectA,
        },
      });

    expect(res.status).toBe(403);
    expect(getTool).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("rejects tool execution when any runContext reference is outside the company scope", async () => {
    const cases: Array<[string, Array<Array<Record<string, unknown>>>]> = [
      [
        "agentId",
        [
          [{ companyId: companyB }],
        ],
      ],
      [
        "runId company",
        [
          [{ companyId: companyA }],
          [{ companyId: companyB, agentId: agentA }],
        ],
      ],
      [
        "runId agent",
        [
          [{ companyId: companyA }],
          [{ companyId: companyA, agentId: "77777777-7777-4777-8777-777777777777" }],
        ],
      ],
      [
        "projectId",
        [
          [{ companyId: companyA }],
          [{ companyId: companyA, agentId: agentA }],
          [{ companyId: companyB }],
        ],
      ],
    ];

    for (const [label, rows] of cases) {
      const executeTool = vi.fn();
      const { app } = await createApp(boardActor(), {}, {
        db: createSelectQueueDb(rows),
        toolDeps: {
          toolDispatcher: {
            listToolsForAgent: vi.fn(),
            getTool: vi.fn(() => ({ name: "paperclip.example:search" })),
            executeTool,
          },
        },
      });

      const res = await request(app)
        .post("/api/plugins/tools/execute")
        .send({
          tool: "paperclip.example:search",
          parameters: {},
          runContext: {
            agentId: agentA,
            runId: runA,
            companyId: companyA,
            projectId: projectA,
          },
        });

      expect(res.status, label).toBe(403);
      expect(executeTool).not.toHaveBeenCalled();
    }
  });

  it("allows tool execution when agent, run, and project all belong to runContext.companyId", async () => {
    const executeTool = vi.fn().mockResolvedValue({ content: "ok" });
    const { app } = await createApp(boardActor(), {}, {
      db: createSelectQueueDb([
        [{ companyId: companyA }],
        [{ companyId: companyA, agentId: agentA }],
        [{ companyId: companyA }],
      ]),
      toolDeps: {
        toolDispatcher: {
          listToolsForAgent: vi.fn(),
          getTool: vi.fn(() => ({ name: "paperclip.example:search" })),
          executeTool,
        },
      },
    });

    const res = await request(app)
      .post("/api/plugins/tools/execute")
      .send({
        tool: "paperclip.example:search",
        parameters: { q: "test" },
        runContext: {
          agentId: agentA,
          runId: runA,
          companyId: companyA,
          projectId: projectA,
        },
      });

    expect(res.status).toBe(200);
    expect(executeTool).toHaveBeenCalledWith(
      "paperclip.example:search",
      { q: "test" },
      {
        agentId: agentA,
        runId: runA,
        companyId: companyA,
        projectId: projectA,
      },
    );
  });

  it.each([
    ["legacy data", "post", `/api/plugins/${pluginId}/bridge/data`, { key: "health" }],
    ["legacy action", "post", `/api/plugins/${pluginId}/bridge/action`, { key: "sync" }],
    ["url data", "post", `/api/plugins/${pluginId}/data/health`, {}],
    ["url action", "post", `/api/plugins/${pluginId}/actions/sync`, {}],
  ] as const)("rejects %s bridge calls without companyId for non-admin users", async (_name, _method, path, body) => {
    readyPlugin();
    const call = vi.fn();
    const { app } = await createApp(boardActor(), {}, {
      bridgeDeps: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(path)
      .send(body);

    expect(res.status).toBe(403);
    expect(call).not.toHaveBeenCalled();
  });

  it("forwards authorized bridge company scope to the plugin worker", async () => {
    readyPlugin();
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(boardActor(), {}, {
      bridgeDeps: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/data/health`)
      .send({ companyId: companyA, params: { view: "compact" } });

    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledWith(pluginId, "getData", {
      key: "health",
      companyId: companyA,
      params: { view: "compact" },
      renderEnvironment: null,
    });
  });

  it("allows omitted-company bridge calls for instance admins as global plugin actions", async () => {
    readyPlugin();
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(boardActor({
      userId: "admin-1",
      isInstanceAdmin: true,
      companyIds: [],
    }), {}, {
      bridgeDeps: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/sync`)
      .send({});

    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledWith(pluginId, "performAction", {
      key: "sync",
      params: {},
      actorContext: {
        type: "user",
        userId: "admin-1",
        agentId: null,
        runId: null,
        companyId: null,
      },
      renderEnvironment: null,
    }, pluginActionRpcTimeoutMs);
  });

  it("passes authenticated actor context and overrides spoofed company scope for plugin actions", async () => {
    readyPlugin();
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(boardActor({ runId: runA }), {}, {
      bridgeDeps: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/sync`)
      .send({
        companyId: companyA,
        params: {
          companyId: companyB,
          reviewerUserId: "spoofed-user",
        },
      });

    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledWith(pluginId, "performAction", {
      key: "sync",
      params: {
        companyId: companyA,
        reviewerUserId: "spoofed-user",
      },
      actorContext: {
        type: "user",
        userId: "user-1",
        agentId: null,
        runId: runA,
        companyId: companyA,
      },
      renderEnvironment: null,
    }, pluginActionRpcTimeoutMs);
  });

  it("uses null for board actor userId when no authenticated user id is present", async () => {
    readyPlugin();
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(boardActor({ userId: undefined }), {}, {
      bridgeDeps: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/sync`)
      .send({ companyId: companyA });

    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledWith(
      pluginId,
      "performAction",
      expect.objectContaining({
        actorContext: expect.objectContaining({
          type: "user",
          userId: null,
          companyId: companyA,
        }),
      }),
      pluginActionRpcTimeoutMs,
    );
  });

  it("allows agent-scoped plugin actions with authenticated actor context", async () => {
    readyPlugin();
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(agentActor(), {}, {
      bridgeDeps: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/sync`)
      .send({
        companyId: companyA,
        params: {
          companyId: companyB,
          reviewerAgentId: "spoofed-agent",
        },
      });

    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledWith(pluginId, "performAction", {
      key: "sync",
      params: {
        companyId: companyA,
        reviewerAgentId: "spoofed-agent",
      },
      actorContext: {
        type: "agent",
        userId: null,
        agentId: agentA,
        runId: runA,
        companyId: companyA,
      },
      renderEnvironment: null,
    }, pluginActionRpcTimeoutMs);

    call.mockClear();
    const legacyRes = await request(app)
      .post(`/api/plugins/${pluginId}/bridge/action`)
      .send({
        key: "sync",
        companyId: companyA,
        params: {
          companyId: companyB,
          reviewerAgentId: "spoofed-agent",
        },
      });

    expect(legacyRes.status).toBe(200);
    expect(call).toHaveBeenCalledWith(pluginId, "performAction", {
      key: "sync",
      params: {
        companyId: companyA,
        reviewerAgentId: "spoofed-agent",
      },
      actorContext: {
        type: "agent",
        userId: null,
        agentId: agentA,
        runId: runA,
        companyId: companyA,
      },
      renderEnvironment: null,
    }, pluginActionRpcTimeoutMs);
  });

  it("rejects agent plugin actions outside the authenticated company scope", async () => {
    readyPlugin();
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(agentActor(), {}, {
      bridgeDeps: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/sync`)
      .send({ companyId: companyB });

    expect(res.status).toBe(403);
    expect(call).not.toHaveBeenCalled();
  });

  it("attaches worker bridge errors to the HTTP logger context", async () => {
    readyPlugin();
    const call = vi.fn().mockRejectedValue(new Error("missing source_objects column"));
    const captured: Array<{ context: any; body: unknown }> = [];
    const { app } = await createApp(boardActor(), {}, {
      bridgeDeps: {
        workerManager: { call },
      },
      captureJsonContext: (context, body) => {
        captured.push({ context, body });
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/data/source-objects`)
      .send({ companyId: companyA });

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      code: "UNKNOWN",
      message: "missing source_objects column",
    });
    expect(captured.at(-1)?.context?.error).toMatchObject({
      message: "missing source_objects column",
      details: {
        pluginId,
        pluginKey: "paperclip.example",
        bridgeMethod: "getData",
        dataKey: "source-objects",
        bridgeCode: "UNKNOWN",
      },
    });
  });

  it("rejects manual job triggers for non-admin board users", async () => {
    const scheduler = { triggerJob: vi.fn() };
    const jobStore = { getJobByIdForPlugin: vi.fn() };
    const { app } = await createApp(boardActor(), {}, {
      jobDeps: { scheduler, jobStore },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/jobs/job-1/trigger`)
      .send({});

    expect(res.status).toBe(403);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(jobStore.getJobByIdForPlugin).not.toHaveBeenCalled();
  }, 15_000);

  it("allows manual job triggers for instance admins", async () => {
    readyPlugin();
    const scheduler = { triggerJob: vi.fn().mockResolvedValue({ runId: "run-1", jobId: "job-1" }) };
    const jobStore = { getJobByIdForPlugin: vi.fn().mockResolvedValue({ id: "job-1" }) };
    const { app } = await createApp(boardActor({
      userId: "admin-1",
      isInstanceAdmin: true,
      companyIds: [],
    }), {}, {
      jobDeps: { scheduler, jobStore },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/jobs/job-1/trigger`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: "run-1", jobId: "job-1" });
    expect(scheduler.triggerJob).toHaveBeenCalledWith("job-1", "manual");
  });

  // ─── Agent JWT tool execution (cherry-picked from #5549) ─────────────────────

  it("rejects board users with no company memberships from listing plugin tools", async () => {
    const listToolsForAgent = vi.fn(() => []);
    const { app } = await createApp(
      boardActor({ companyIds: [], isInstanceAdmin: false, source: "session" }),
      {},
      {
        toolDeps: {
          toolDispatcher: {
            listToolsForAgent,
            getTool: vi.fn(),
            executeTool: vi.fn(),
          },
        },
      },
    );

    const res = await request(app).get("/api/plugins/tools");

    expect(res.status).toBe(403);
    expect(listToolsForAgent).not.toHaveBeenCalled();
  });

  it("allows agent JWT to list available plugin tools", async () => {
    const listToolsForAgent = vi.fn(() => []);
    const { app } = await createApp(agentActor(), {}, {
      toolDeps: {
        toolDispatcher: {
          listToolsForAgent,
          getTool: vi.fn(),
          executeTool: vi.fn(),
        },
      },
    });

    const res = await request(app).get("/api/plugins/tools");

    expect(res.status).toBe(200);
    expect(listToolsForAgent).toHaveBeenCalled();
  });

  it("allows agent JWT to execute a tool within its company scope", async () => {
    const executeTool = vi.fn().mockResolvedValue({ content: "ok" });
    const { app } = await createApp(
      agentActor(),
      {},
      {
        db: createSelectQueueDb([
          [{ companyId: companyA }],
          [{ companyId: companyA, agentId: agentA }],
          [{ companyId: companyA }],
        ]),
        toolDeps: {
          toolDispatcher: {
            listToolsForAgent: vi.fn(),
            getTool: vi.fn(() => ({ name: "paperclip.example:search", pluginDbId: pluginId })),
            executeTool,
          },
        },
      },
    );

    const res = await request(app)
      .post("/api/plugins/tools/execute")
      .send({
        tool: "paperclip.example:search",
        parameters: { q: "test" },
        runContext: { agentId: agentA, runId: runA, companyId: companyA, projectId: projectA },
      });

    expect(res.status).toBe(200);
    expect(executeTool).toHaveBeenCalledWith(
      "paperclip.example:search",
      { q: "test" },
      { agentId: agentA, runId: runA, companyId: companyA, projectId: projectA },
    );
  });

  it("rejects agent JWT when runContext.companyId is outside the agent's company scope", async () => {
    const executeTool = vi.fn();
    const { app } = await createApp(
      agentActor(),
      {},
      {
        db: createSelectQueueDb([]),
        toolDeps: {
          toolDispatcher: {
            listToolsForAgent: vi.fn(),
            getTool: vi.fn(() => ({ name: "paperclip.example:search", pluginDbId: pluginId })),
            executeTool,
          },
        },
      },
    );

    const res = await request(app)
      .post("/api/plugins/tools/execute")
      .send({
        tool: "paperclip.example:search",
        parameters: {},
        runContext: { agentId: agentA, runId: runA, companyId: companyB, projectId: projectA },
      });

    expect(res.status).toBe(403);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("rejects agent JWT when runContext.agentId does not belong to runContext.companyId", async () => {
    const otherAgent = "77777777-7777-4777-8777-777777777777";
    const executeTool = vi.fn();
    const { app } = await createApp(
      agentActor(),
      {},
      {
        db: createSelectQueueDb([
          [{ companyId: companyB }],
        ]),
        toolDeps: {
          toolDispatcher: {
            listToolsForAgent: vi.fn(),
            getTool: vi.fn(() => ({ name: "paperclip.example:search", pluginDbId: pluginId })),
            executeTool,
          },
        },
      },
    );

    const res = await request(app)
      .post("/api/plugins/tools/execute")
      .send({
        tool: "paperclip.example:search",
        parameters: {},
        runContext: { agentId: otherAgent, runId: runA, companyId: companyA, projectId: projectA },
      });

    expect(res.status).toBe(403);
    expect(executeTool).not.toHaveBeenCalled();
  });
});

describe.sequential("GET /api/plugins/alerts/plugin-health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok with empty alerts when no plugins are in error state", async () => {
    mockRegistry.listByStatus.mockResolvedValue([]);
    const { app } = await createApp(boardActor());
    const res = await request(app).get("/api/plugins/alerts/plugin-health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.alerts).toEqual([]);
    expect(res.body.checkedAt).toBeDefined();
    expect(mockRegistry.listByStatus).toHaveBeenCalledWith("error");
  });

  it("returns firing with alert entries when plugins are in error state", async () => {
    const errorPlugin = {
      id: pluginId,
      pluginKey: "paperclip.example",
      status: "error",
      lastError: "Connection refused",
      updatedAt: new Date("2026-01-15T12:00:00Z"),
    };
    mockRegistry.listByStatus.mockResolvedValue([errorPlugin]);
    const { app } = await createApp(boardActor());
    const res = await request(app).get("/api/plugins/alerts/plugin-health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("firing");
    expect(res.body.alerts).toHaveLength(1);
    const alert = res.body.alerts[0];
    expect(alert.alertname).toBe("PaperclipPluginError");
    expect(alert.severity).toBe("page");
    expect(alert.pluginId).toBe(pluginId);
    expect(alert.pluginKey).toBe("paperclip.example");
    expect(alert.status).toBe("error");
    expect(alert.lastError).toBe("Connection refused");
    expect(alert.summary).toBe("Plugin paperclip.example is in error state");
    expect(alert.updatedAt).toBe("2026-01-15T12:00:00.000Z");
  });

  it("sets lastError to null and uses fallback description when lastError is absent", async () => {
    const errorPlugin = {
      id: pluginId,
      pluginKey: "paperclip.example",
      status: "error",
      lastError: null,
      updatedAt: new Date("2026-01-15T12:00:00Z"),
    };
    mockRegistry.listByStatus.mockResolvedValue([errorPlugin]);
    const { app } = await createApp(boardActor());
    const res = await request(app).get("/api/plugins/alerts/plugin-health");
    expect(res.status).toBe(200);
    expect(res.body.alerts[0].lastError).toBeNull();
    expect(res.body.alerts[0].description).toContain("without a recorded last_error");
  });

  it("rejects non-board callers with 403", async () => {
    const { app } = await createApp(agentActor());
    const res = await request(app).get("/api/plugins/alerts/plugin-health");
    expect(res.status).toBe(403);
    expect(mockRegistry.listByStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// BLO-20794 / BLO-20871 — plugin config secret masking and masked round-trip
// ---------------------------------------------------------------------------

const CONFIG_SECRET = "sentinel-live-bearer-do-not-leak";

/** Manifest shape under test: one declared secret, one plain field. */
const maskingSchema = {
  type: "object",
  properties: {
    webhookToken: { type: "string", writeOnly: true },
    // Declared without `type` on purpose. A manifest that writes
    // `type: "string", format: "secret-ref"` makes Ajv reject the pointer
    // object form outright — that is the pre-existing BLO-20219 defect and is
    // out of scope here; constraining it would only test that bug.
    apiKeyRef: { format: "secret-ref" },
    endpoint: { type: "string" },
  },
};

function maskingPlugin(schema: Record<string, unknown> | undefined = maskingSchema) {
  mockRegistry.getById.mockResolvedValue({
    id: pluginId,
    pluginKey: "paperclip.example",
    version: "1.0.0",
    status: "ready",
    manifestJson: schema ? { instanceConfigSchema: schema } : {},
  });
}

/**
 * Back the registry config methods with a mutable store so a GET → POST → read
 * sequence exercises real persistence semantics rather than a fixed stub. The
 * value left in `store.configJson` after a POST is exactly what `upsertConfig`
 * writes to `plugin_config.config_json`.
 */
function seedConfigStore(configJson: Record<string, unknown>) {
  const store: { configJson: Record<string, unknown> } = { configJson: structuredClone(configJson) };
  mockRegistry.getConfig.mockImplementation(async () => ({
    id: "config-1",
    pluginId,
    companyId: companyA,
    configJson: store.configJson,
  }));
  mockRegistry.upsertConfig.mockImplementation(async (_pluginId, _companyId, input) => {
    store.configJson = input.configJson;
    return { id: "config-1", pluginId, companyId: companyA, configJson: store.configJson };
  });
  return store;
}

function adminActor() {
  return {
    type: "board",
    userId: "admin-1",
    source: "session",
    isInstanceAdmin: true,
    companyIds: [companyA],
  };
}

describe.sequential("plugin config secret masking (BLO-20794)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getConfig.mockReset();
    mockRegistry.upsertConfig.mockReset();
    ragHealthBucketCache.clear();
    mockSecretService.getById.mockResolvedValue({ id: secretId, companyId: companyA, status: "active" });
    mockSecretService.syncSecretRefsForTarget.mockResolvedValue([]);
  });

  it("rejects a config read from a board org member who cannot write it", async () => {
    maskingPlugin();
    seedConfigStore({ webhookToken: CONFIG_SECRET, endpoint: "https://alerts.example.com" });
    const { app } = await createApp(boardActor());

    const res = await request(app).get(`/api/plugins/${pluginId}/config?companyId=${companyA}`);

    expect(res.status).toBe(403);
    expect(mockRegistry.getConfig).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain(CONFIG_SECRET);
  }, 20_000);

  it("rejects a config test from a board org member who cannot write it", async () => {
    maskingPlugin();
    const { app } = await createApp(boardActor());

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/config/test`)
      .send({ companyId: companyA, configJson: { webhookToken: "__redacted__" } });

    expect(res.status).toBe(403);
    expect(mockRegistry.getConfig).not.toHaveBeenCalled();
  }, 20_000);

  it("never emits the stored secret to an authorized reader, and keeps non-secret fields intact", async () => {
    maskingPlugin();
    seedConfigStore({
      webhookToken: CONFIG_SECRET,
      apiKeyRef: { type: "secret_ref", secretId, version: "latest" },
      endpoint: "https://alerts.example.com",
    });
    const { app } = await createApp(adminActor());

    const res = await request(app).get(`/api/plugins/${pluginId}/config?companyId=${companyA}`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(CONFIG_SECRET);
    expect(res.body.configJson.webhookToken).toBe("__redacted__");
    // Non-secret field survives — guards against blanking the whole response.
    expect(res.body.configJson.endpoint).toBe("https://alerts.example.com");
    // The pointer is not a secret and must keep rendering in the config form.
    expect(res.body.configJson.apiKeyRef).toEqual({ type: "secret_ref", secretId, version: "latest" });
  }, 20_000);

  it("masks a credential-named field the manifest never declared", async () => {
    maskingPlugin({ type: "object", properties: { endpoint: { type: "string" } } });
    seedConfigStore({ webhookToken: CONFIG_SECRET, endpoint: "https://alerts.example.com" });
    const { app } = await createApp(adminActor());

    const res = await request(app).get(`/api/plugins/${pluginId}/config?companyId=${companyA}`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(CONFIG_SECRET);
    expect(res.body.configJson.endpoint).toBe("https://alerts.example.com");
  }, 20_000);

  it("preserves the stored secret when the masked response is posted back unchanged", async () => {
    maskingPlugin();
    const store = seedConfigStore({
      webhookToken: CONFIG_SECRET,
      apiKeyRef: { type: "secret_ref", secretId, version: "latest" },
      endpoint: "https://alerts.example.com",
    });
    const { app } = await createApp(adminActor());

    // 1. Read it masked.
    const readRes = await request(app).get(`/api/plugins/${pluginId}/config?companyId=${companyA}`);
    expect(readRes.status).toBe(200);
    expect(readRes.body.configJson.webhookToken).toBe("__redacted__");

    // 2. Post the exact masked payload back, unmodified — the UI's save path.
    const writeRes = await request(app)
      .post(`/api/plugins/${pluginId}/config`)
      .send({ companyId: companyA, configJson: readRes.body.configJson });
    expect(writeRes.status).toBe(200);

    // 3. Read storage directly: the original secret must still be there.
    expect(store.configJson.webhookToken).toBe(CONFIG_SECRET);
    expect(JSON.stringify(store.configJson)).not.toContain("__redacted__");
    expect(store.configJson.endpoint).toBe("https://alerts.example.com");
    expect(store.configJson.apiKeyRef).toEqual({ type: "secret_ref", secretId, version: "latest" });

    // The write response must not hand the secret back either.
    expect(JSON.stringify(writeRes.body)).not.toContain(CONFIG_SECRET);
  }, 20_000);

  it("persists a genuinely rotated secret instead of restoring the old one", async () => {
    maskingPlugin();
    const store = seedConfigStore({ webhookToken: CONFIG_SECRET, endpoint: "https://alerts.example.com" });
    const { app } = await createApp(adminActor());

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/config`)
      .send({
        companyId: companyA,
        configJson: { webhookToken: "rotated-bearer", endpoint: "https://alerts.example.com" },
      });

    expect(res.status).toBe(200);
    expect(store.configJson.webhookToken).toBe("rotated-bearer");
  }, 20_000);

  it("drops the mask sentinel rather than persisting it when nothing is stored", async () => {
    maskingPlugin();
    const store = seedConfigStore({});
    mockRegistry.getConfig.mockResolvedValue(null);
    mockRegistry.upsertConfig.mockImplementation(async (_pluginId, _companyId, input) => {
      store.configJson = input.configJson;
      return { id: "config-1", pluginId, companyId: companyA, configJson: store.configJson };
    });
    const { app } = await createApp(adminActor());

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/config`)
      .send({ companyId: companyA, configJson: { webhookToken: "__redacted__", endpoint: "https://x.example.com" } });

    expect(res.status).toBe(200);
    expect(store.configJson).toEqual({ endpoint: "https://x.example.com" });
  }, 20_000);

  it("re-homes nothing when an array entry is deleted, matching entries by identity", async () => {
    // BLO-20871 review finding: positional restore would hand `token-alpha` to
    // beta's endpoint. Identity matching keeps each secret with its own entry.
    maskingPlugin({ type: "object", properties: { endpoint: { type: "string" } } });
    const store = seedConfigStore({
      targets: [
        { name: "alpha", token: "token-alpha-live" },
        { name: "beta", token: "token-beta-live" },
      ],
    });
    const { app } = await createApp(adminActor());

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/config`)
      .send({
        companyId: companyA,
        configJson: { targets: [{ name: "beta", token: "__redacted__" }] },
      });

    expect(res.status).toBe(200);
    expect(store.configJson).toEqual({ targets: [{ name: "beta", token: "token-beta-live" }] });
    expect(JSON.stringify(store.configJson)).not.toContain("token-alpha-live");
  }, 20_000);

  it("rejects the save when a masked array entry cannot be matched to storage", async () => {
    // No stable identity on the entries, and the array shrank — restoring by
    // position could only guess, so the write is refused outright.
    maskingPlugin({ type: "object", properties: { endpoint: { type: "string" } } });
    const store = seedConfigStore({
      targets: [{ token: "token-alpha-live" }, { token: "token-beta-live" }],
    });
    const { app } = await createApp(adminActor());

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/config`)
      .send({ companyId: companyA, configJson: { targets: [{ token: "__redacted__" }] } });

    expect(res.status).toBe(400);
    expect(res.body.unresolvedMaskPaths).toEqual(["targets.0"]);
    // Storage is untouched, and no sentinel was written.
    expect(store.configJson).toEqual({
      targets: [{ token: "token-alpha-live" }, { token: "token-beta-live" }],
    });
    expect(mockRegistry.upsertConfig).not.toHaveBeenCalled();
  }, 20_000);

  it("restores the stored secret before validating against a constrained schema", async () => {
    // `__redacted__` is 12 chars; a minLength of 20 proves the merge runs first.
    maskingPlugin({
      type: "object",
      properties: { webhookToken: { type: "string", writeOnly: true, minLength: 20 } },
      required: ["webhookToken"],
    });
    const store = seedConfigStore({ webhookToken: CONFIG_SECRET });
    const { app } = await createApp(adminActor());

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/config`)
      .send({ companyId: companyA, configJson: { webhookToken: "__redacted__" } });

    expect(res.status).toBe(200);
    expect(store.configJson.webhookToken).toBe(CONFIG_SECRET);
  }, 20_000);

  it("hands the worker the restored secret, never the sentinel", async () => {
    maskingPlugin();
    seedConfigStore({ webhookToken: CONFIG_SECRET, endpoint: "https://alerts.example.com" });
    const workerCall = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(adminActor(), {}, {
      bridgeDeps: { workerManager: { isRunning: () => true, call: workerCall } },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/config`)
      .send({ companyId: companyA, configJson: { webhookToken: "__redacted__", endpoint: "https://alerts.example.com" } });

    expect(res.status).toBe(200);
    expect(workerCall).toHaveBeenCalledWith(
      pluginId,
      "configChanged",
      expect.objectContaining({ config: expect.objectContaining({ webhookToken: CONFIG_SECRET }) }),
    );
  }, 20_000);

  it("tests an unchanged masked config against the stored secret", async () => {
    maskingPlugin();
    seedConfigStore({ webhookToken: CONFIG_SECRET, endpoint: "https://alerts.example.com" });
    const workerCall = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(adminActor(), {}, {
      bridgeDeps: { workerManager: { isRunning: () => true, call: workerCall } },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/config/test`)
      .send({ companyId: companyA, configJson: { webhookToken: "__redacted__", endpoint: "https://alerts.example.com" } });

    expect(res.status).toBe(200);
    expect(workerCall).toHaveBeenCalledWith(
      pluginId,
      "validateConfig",
      { config: expect.objectContaining({ webhookToken: CONFIG_SECRET }) },
    );
  }, 20_000);

  it("redacts the restored secret from worker warnings", async () => {
    // BLO-20871 review finding: the worker legitimately receives plaintext, and
    // its diagnostics are author-controlled strings returned verbatim, so a
    // worker could echo the credential straight back out of /config/test.
    maskingPlugin();
    seedConfigStore({ webhookToken: CONFIG_SECRET, endpoint: "https://alerts.example.com" });
    const workerCall = vi.fn().mockResolvedValue({
      ok: true,
      warnings: [`token ${CONFIG_SECRET} is close to expiry`],
    });
    const { app } = await createApp(adminActor(), {}, {
      bridgeDeps: { workerManager: { isRunning: () => true, call: workerCall } },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/config/test`)
      .send({ companyId: companyA, configJson: { webhookToken: "__redacted__", endpoint: "https://alerts.example.com" } });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(CONFIG_SECRET);
    expect(res.body.message).toContain("__redacted__");
    expect(res.body.message).toContain("close to expiry");
  }, 20_000);

  it("redacts the restored secret from worker errors", async () => {
    maskingPlugin();
    seedConfigStore({ webhookToken: CONFIG_SECRET, endpoint: "https://alerts.example.com" });
    const workerCall = vi.fn().mockResolvedValue({
      ok: false,
      errors: [`upstream rejected bearer ${CONFIG_SECRET}`],
    });
    const { app } = await createApp(adminActor(), {}, {
      bridgeDeps: { workerManager: { isRunning: () => true, call: workerCall } },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/config/test`)
      .send({ companyId: companyA, configJson: { webhookToken: "__redacted__", endpoint: "https://alerts.example.com" } });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(CONFIG_SECRET);
    expect(res.body.message).toContain("upstream rejected bearer");
  }, 20_000);

  it("redacts the restored secret from a thrown worker RPC error", async () => {
    // The 502 path carries worker-controlled `message` and free-form `details`.
    maskingPlugin();
    seedConfigStore({ webhookToken: CONFIG_SECRET, endpoint: "https://alerts.example.com" });
    const workerCall = vi.fn().mockRejectedValue(
      new Error(`connect failed using ${CONFIG_SECRET}`),
    );
    const { app } = await createApp(adminActor(), {}, {
      bridgeDeps: { workerManager: { isRunning: () => true, call: workerCall } },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/config/test`)
      .send({ companyId: companyA, configJson: { webhookToken: "__redacted__", endpoint: "https://alerts.example.com" } });

    expect(JSON.stringify(res.body)).not.toContain(CONFIG_SECRET);
  }, 20_000);

  it("redacts a credential containing JSON metacharacters", async () => {
    // Redacting the 502 payload by stringify -> replace -> parse would miss
    // this: JSON.stringify escapes the quote and backslash, so the raw secret
    // never appears in the serialized text and survives verbatim. The walk has
    // to compare against real string values, not the serialized form.
    const awkwardSecret = 'sk-live-a"b\\c-xyz';
    maskingPlugin();
    seedConfigStore({ webhookToken: awkwardSecret, endpoint: "https://alerts.example.com" });
    const workerCall = vi.fn().mockRejectedValue(
      new Error(`connect failed using ${awkwardSecret}`),
    );
    const { app } = await createApp(adminActor(), {}, {
      bridgeDeps: { workerManager: { isRunning: () => true, call: workerCall } },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/config/test`)
      .send({ companyId: companyA, configJson: { webhookToken: "__redacted__", endpoint: "https://alerts.example.com" } });

    expect(JSON.stringify(res.body)).not.toContain("sk-live-a");
  }, 20_000);
});

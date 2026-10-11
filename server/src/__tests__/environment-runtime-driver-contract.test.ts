import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshConnectionConfig,
} from "@paperclipai/adapter-utils/ssh";
import {
  agents,
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  plugins,
} from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const sshFixtureSupport = await getSshEnvLabSupport();

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping environment runtime driver contract tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

interface RuntimeContractCase<C extends object = Record<string, unknown>> {
  name: string;
  driver: string;
  config: C;
  setup?: () => Promise<() => Promise<void>>;
  /**
   * Optional plugin worker manager. Supplying one also registers the `plugin`
   * driver in the runtime under test.
   */
  pluginWorkerManager?: PluginWorkerManager;
  expectLease: (lease: {
    providerLeaseId: string | null;
    metadata: Record<string, unknown> | null;
  }, environment: Environment) => void;
  /**
   * BLO-20795: asserted after the replayed (second) release, for drivers whose
   * provider calls are observable — e.g. "the plugin RPC was invoked twice and
   * neither call threw".
   */
  expectAfterReplay?: () => void;
}

describeEmbeddedPostgres("environment runtime driver contract", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const fixtureRoots: string[] = [];
  const servers: Server[] = [];

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("environment-runtime-contract");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    while (fixtureRoots.length > 0) {
      const root = fixtureRoots.pop();
      if (!root) continue;
      await stopSshEnvLabFixture(path.join(root, "state.json")).catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(plugins);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedEnvironment(input: {
    driver: string;
    config: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const runId = randomUUID();
    const now = new Date();
    let config = input.config;

    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Contract Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: now,
      updatedAt: now,
    });
    if (typeof config.privateKey === "string" && config.privateKey.length > 0) {
      const secret = await secretService(db).create(companyId, {
        name: `environment-contract-private-key-${randomUUID()}`,
        provider: "local_encrypted",
        value: config.privateKey,
      });
      config = {
        ...config,
        privateKey: null,
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: secret.id,
          version: "latest",
        },
      };
      // v513 requires a row in company_secret_bindings for every secret_ref
      // a consumer resolves at runtime; without it, secretService.resolve
      // throws "Secret is not bound to environment:<id> at <configPath>".
      await db.insert(companySecretBindings).values({
        companyId,
        secretId: secret.id,
        targetType: "environment",
        targetId: environmentId,
        configPath: "privateKeySecretRef",
        versionSelector: "latest",
        required: true,
      });
    }
    const existingLocal =
      input.driver === "local"
        ? await db.query.environments.findFirst({
            where: (environment, { eq }) => eq(environment.driver, "local"),
          })
        : null;
    const resolvedEnvironmentId = existingLocal?.id ?? environmentId;
    if (!existingLocal) {
      await db.insert(environments).values({
        id: resolvedEnvironmentId,
        name: `${input.driver} contract`,
        driver: input.driver,
        status: "active",
        config,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      config = (existingLocal.config as Record<string, unknown> | null) ?? {};
    }
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: now,
      updatedAt: now,
    });

    return {
      companyId,
      issueId: null,
      runId,
      environment: {
        id: resolvedEnvironmentId,
        companyId,
        name: `${input.driver} contract`,
        description: null,
        driver: input.driver,
        status: "active",
        config,
        metadata: null,
        createdAt: now,
        updatedAt: now,
      } as Environment,
    };
  }

  async function startHealthServer() {
    const server = createServer((req, res) => {
      if (req.url === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected health server to listen on a TCP port.");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async function runContract<C extends object>(testCase: RuntimeContractCase<C>) {
    const cleanup = await testCase.setup?.();
    try {
      const runtime = environmentRuntimeService(
        db,
        testCase.pluginWorkerManager ? { pluginWorkerManager: testCase.pluginWorkerManager } : {},
      );
      // seedEnvironment serialises config to JSON, so widen the concrete shape
      // (e.g. SshConnectionConfig) to the schema-level Record<string, unknown>.
      const { companyId, environment, issueId, runId } = await seedEnvironment({
        driver: testCase.driver,
        config: testCase.config as unknown as Record<string, unknown>,
      });

      const acquired = await runtime.acquireRunLease({
        companyId,
        environment,
        issueId,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: null,
      });

      expect(acquired.environment.id).toBe(environment.id);
      expect(acquired.lease.companyId).toBe(companyId);
      expect(acquired.lease.environmentId).toBe(environment.id);
      expect(acquired.lease.issueId).toBeNull();
      expect(acquired.lease.heartbeatRunId).toBe(runId);
      expect(acquired.lease.status).toBe("active");
      expect(acquired.leaseContext).toEqual({
        executionWorkspaceId: null,
        executionWorkspaceMode: null,
      });
      expect(acquired.lease.metadata).toMatchObject({
        driver: testCase.driver,
        executionWorkspaceMode: null,
      });
      testCase.expectLease(acquired.lease, environment);

      const released = await runtime.releaseRunLeases(runId);

      expect(released).toHaveLength(1);
      expect(released[0]?.environment.id).toBe(environment.id);
      expect(released[0]?.lease.id).toBe(acquired.lease.id);
      expect(released[0]?.lease.status).toBe("released");

      const activeRows = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.status, "active"));
      expect(activeRows).toHaveLength(0);
      await expect(runtime.releaseRunLeases(runId)).resolves.toEqual([]);

      // ---- BLO-20795: release is at-least-once -----------------------------
      // Provider release happens *before* the lease row is written. If that
      // write is lost — the worker dies in between, or the update itself fails
      // — the row stays `active` and worker-crash recovery replays the
      // release. Rewind the row to exactly that state: the provider side has
      // already been released, the database does not know it.
      await db
        .update(environmentLeases)
        .set({ status: "active", releasedAt: null, cleanupStatus: null, failureReason: null })
        .where(eq(environmentLeases.id, acquired.lease.id));

      const replayed = await runtime.releaseRunLeases(runId);

      // Converges: the second provider call did not throw, and the lease
      // reaches a released state rather than being stranded `active`.
      expect(replayed).toHaveLength(1);
      expect(replayed[0]?.lease.id).toBe(acquired.lease.id);
      expect(replayed[0]?.lease.status).toBe("released");
      // `cleanupStatus` is only written by drivers that reach a provider; a
      // driver that does reach one must not report the replay as failed.
      expect(replayed[0]?.lease.cleanupStatus).not.toBe("failed");
      const activeAfterReplay = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.status, "active"));
      expect(activeAfterReplay).toHaveLength(0);
      testCase.expectAfterReplay?.();
    } finally {
      await cleanup?.();
    }
  }

  const contractCases: RuntimeContractCase[] = [
    {
      name: "local",
      driver: "local",
      config: {},
      expectLease: (lease) => {
        expect(lease.providerLeaseId).toBeNull();
      },
    },
    {
      name: "fake sandbox",
      driver: "sandbox",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: false,
      },
      expectLease: (lease) => {
        expect(lease.providerLeaseId).toMatch(/^sandbox:\/\/fake\/[0-9a-f-]+\/[0-9a-f-]+$/);
        expect(lease.metadata).toMatchObject({
          provider: "fake",
          image: "ubuntu:24.04",
          reuseLease: false,
        });
      },
    },
    {
      // BLO-2976: k8s envs claim leases via the runtime same as local; the
      // claude_k8s / opencode_k8s adapter creates the agent Job pod itself
      // using the K8sRemoteSpec from environment-execution-target.ts. Without
      // this driver registered, the heartbeat lease acquire throws on any
      // k8s-typed environment.
      name: "k8s",
      driver: "k8s",
      config: {
        namespace: "paperclip",
        workspaceMountPath: "/workspace",
      },
      expectLease: (lease) => {
        expect(lease.providerLeaseId).toBeNull();
        expect(lease.metadata).toMatchObject({
          driver: "k8s",
        });
      },
    },
  ];

  for (const testCase of contractCases) {
    it(`${testCase.name} satisfies the acquire/release host contract`, async () => {
      await runContract(testCase);
    });
  }

  it("plugin driver satisfies the acquire/release host contract", async () => {
    const pluginId = randomUUID();
    const pluginKey = `acme.environments.${pluginId}`;
    const releaseCalls: Array<string | null> = [];
    const workerManager = {
      isRunning: (id: string) => id === pluginId,
      call: async (_pluginId: string, method: string, params: Record<string, unknown>) => {
        if (method === "environmentAcquireLease") {
          return { providerLeaseId: "plugin-contract-lease", metadata: { remoteCwd: "/workspace" } };
        }
        if (method === "environmentReleaseLease") {
          // A well-behaved provider releases an already-gone resource without
          // throwing (BLO-20795). Record the calls so the replay is observable.
          releaseCalls.push((params.providerLeaseId as string | null) ?? null);
          return undefined;
        }
        throw new Error(`Unexpected plugin environment method: ${method}`);
      },
    } as unknown as PluginWorkerManager;

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: "@acme/paperclip-environments",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: pluginKey,
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Acme Environments",
        description: "Contract-test plugin environment driver",
        author: "Acme",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "sandbox", displayName: "Sandbox", configSchema: { type: "object" } }],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as never);

    await runContract({
      name: "plugin",
      driver: "plugin",
      config: { pluginKey, driverKey: "sandbox", driverConfig: { template: "base" } },
      pluginWorkerManager: workerManager,
      expectLease: (lease) => {
        expect(lease.providerLeaseId).toBe("plugin-contract-lease");
        expect(lease.metadata).toMatchObject({ pluginId, pluginKey, driverKey: "sandbox" });
      },
      expectAfterReplay: () => {
        // The whole point: the host called the provider twice for one lease,
        // the second time against a resource it had already released, and the
        // run still converged.
        expect(releaseCalls).toEqual(["plugin-contract-lease", "plugin-contract-lease"]);
      },
    });
  });

  // BLO-20795 AC 3: no provider silently exempt. The covered set is checked
  // against the live registry rather than a hand-written list, so a driver
  // added to `environmentRuntimeService` fails this test until it has a case
  // above exercising release-twice.
  it("covers every driver registered in the environment runtime", () => {
    const stubWorkerManager = {
      isRunning: () => false,
      call: async () => undefined,
    } as unknown as PluginWorkerManager;
    const registered = environmentRuntimeService(db, { pluginWorkerManager: stubWorkerManager })
      .listDrivers()
      .map((driver) => driver.driver);

    // `ssh` and `plugin` have their own `it` blocks; the rest come from the
    // table above.
    const covered = [...new Set([...contractCases.map((testCase) => testCase.driver), "ssh", "plugin"])];

    expect([...registered].sort()).toEqual([...covered].sort());
  });

  it("SSH satisfies the acquire/release host contract", async () => {
    if (!sshFixtureSupport.supported) {
      console.warn(`Skipping SSH driver contract test: ${sshFixtureSupport.reason ?? "unsupported environment"}`);
      return;
    }

    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-env-runtime-contract-ssh-"));
    fixtureRoots.push(fixtureRoot);
    const fixture = await startSshEnvLabFixture({ statePath: path.join(fixtureRoot, "state.json") });
    const sshConfig = await buildSshEnvLabFixtureConfig(fixture);
    const runtimeApiUrl = await startHealthServer();
    const previousCandidates = process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
    process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = JSON.stringify([runtimeApiUrl]);

    await runContract<SshConnectionConfig>({
      name: "ssh",
      driver: "ssh",
      config: sshConfig,
      expectLease: (lease) => {
        expect(lease.providerLeaseId).toContain(`ssh://${sshConfig.username}@${sshConfig.host}:${sshConfig.port}`);
        expect(lease.metadata).toMatchObject({
          host: sshConfig.host,
          port: sshConfig.port,
          username: sshConfig.username,
          remoteWorkspacePath: sshConfig.remoteWorkspacePath,
          remoteCwd: sshConfig.remoteWorkspacePath,
          paperclipApiUrl: runtimeApiUrl,
        });
      },
      setup: async () => async () => {
        if (previousCandidates === undefined) {
          delete process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
        } else {
          process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = previousCandidates;
        }
      },
    });
  });
});

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, plugins } from "@paperclipai/db";
import {
  checkSharedDependencyConsistency,
  pluginLoader,
  type PluginRuntimeServices,
} from "../services/plugin-loader.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const SDK_PACKAGE = "@paperclipai/plugin-sdk";

async function writeInstalledPackageVersion(
  installDir: string,
  packageName: string,
  version: string,
): Promise<void> {
  const packageDir = path.join(installDir, "node_modules", ...packageName.split("/"));
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, version }, null, 2),
    "utf8",
  );
}

async function writeLockfileVersion(
  installDir: string,
  packageName: string,
  version: string,
): Promise<void> {
  await writeFile(
    path.join(installDir, "package-lock.json"),
    JSON.stringify(
      {
        name: "paperclip-plugins",
        lockfileVersion: 3,
        packages: {
          "": { name: "paperclip-plugins" },
          [`node_modules/${packageName}`]: { version },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("checkSharedDependencyConsistency", () => {
  const cleanupPaths = new Set<string>();

  afterEach(async () => {
    for (const cleanupPath of cleanupPaths) {
      await rm(cleanupPath, { recursive: true, force: true });
    }
    cleanupPaths.clear();
  });

  async function tempInstallDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-store-"));
    cleanupPaths.add(dir);
    return dir;
  }

  it("flags a torn store: lockfile records a newer version than what's installed", async () => {
    const installDir = await tempInstallDir();
    await writeLockfileVersion(installDir, SDK_PACKAGE, "2026.513.0");
    await writeInstalledPackageVersion(installDir, SDK_PACKAGE, "1.0.0");

    const result = await checkSharedDependencyConsistency(installDir, SDK_PACKAGE);

    expect(result).toEqual({
      packageName: SDK_PACKAGE,
      lockfileVersion: "2026.513.0",
      installedVersion: "1.0.0",
      lockfileState: "ok",
      installedState: "ok",
      consistent: false,
      problem: "version_mismatch",
      diagnostic: null,
    });
  });

  it("is consistent when the lockfile and installed package agree", async () => {
    const installDir = await tempInstallDir();
    await writeLockfileVersion(installDir, SDK_PACKAGE, "2026.513.0");
    await writeInstalledPackageVersion(installDir, SDK_PACKAGE, "2026.513.0");

    const result = await checkSharedDependencyConsistency(installDir, SDK_PACKAGE);
    expect(result.consistent).toBe(true);
  });

  it("does not flag a mismatch when there is no lockfile at all (local dev)", async () => {
    const installDir = await tempInstallDir();
    await writeInstalledPackageVersion(installDir, SDK_PACKAGE, "1.0.0");

    const result = await checkSharedDependencyConsistency(installDir, SDK_PACKAGE);
    expect(result).toEqual({
      packageName: SDK_PACKAGE,
      lockfileVersion: null,
      installedVersion: "1.0.0",
      lockfileState: "missing",
      installedState: "ok",
      consistent: true,
      problem: null,
      diagnostic: null,
    });
  });

  it("does not flag a mismatch when the package isn't installed yet", async () => {
    const installDir = await tempInstallDir();
    await writeLockfileVersion(installDir, SDK_PACKAGE, "2026.513.0");

    const result = await checkSharedDependencyConsistency(installDir, SDK_PACKAGE);
    expect(result).toEqual({
      packageName: SDK_PACKAGE,
      lockfileVersion: "2026.513.0",
      installedVersion: null,
      lockfileState: "ok",
      installedState: "missing",
      consistent: true,
      problem: null,
      diagnostic: null,
    });
  });

  it("falls back to the lockfileVersion=1 'dependencies' shape", async () => {
    const installDir = await tempInstallDir();
    await writeFile(
      path.join(installDir, "package-lock.json"),
      JSON.stringify({
        name: "paperclip-plugins",
        lockfileVersion: 1,
        dependencies: { [SDK_PACKAGE]: { version: "2026.513.0" } },
      }),
      "utf8",
    );
    await writeInstalledPackageVersion(installDir, SDK_PACKAGE, "1.0.0");

    const result = await checkSharedDependencyConsistency(installDir, SDK_PACKAGE);
    expect(result.consistent).toBe(false);
    expect(result.lockfileVersion).toBe("2026.513.0");
  });

  it("fails closed when the installed package.json exists but is malformed", async () => {
    const installDir = await tempInstallDir();
    await writeLockfileVersion(installDir, SDK_PACKAGE, "2026.513.0");
    const packageDir = path.join(installDir, "node_modules", ...SDK_PACKAGE.split("/"));
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(packageDir, "package.json"), "{", "utf8");

    const result = await checkSharedDependencyConsistency(installDir, SDK_PACKAGE);

    expect(result.consistent).toBe(false);
    expect(result.problem).toBe("metadata_invalid");
    expect(result.installedState).toBe("invalid");
    expect(result.diagnostic).toContain("Unable to read valid JSON");
    expect(result.diagnostic).toContain("package.json");
  });

  it("fails closed when the lockfile exists but is malformed", async () => {
    const installDir = await tempInstallDir();
    await writeFile(path.join(installDir, "package-lock.json"), "{", "utf8");
    await writeInstalledPackageVersion(installDir, SDK_PACKAGE, "2026.513.0");

    const result = await checkSharedDependencyConsistency(installDir, SDK_PACKAGE);

    expect(result.consistent).toBe(false);
    expect(result.problem).toBe("metadata_invalid");
    expect(result.lockfileState).toBe("invalid");
    expect(result.diagnostic).toContain("Unable to read valid JSON");
    expect(result.diagnostic).toContain("package-lock.json");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin-store fail-closed activation test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("torn plugin store — activation fails closed", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupPaths = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-store-consistency-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(plugins);
    for (const cleanupPath of cleanupPaths) {
      await rm(cleanupPath, { recursive: true, force: true });
    }
    cleanupPaths.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createFixturePluginPackage(): Promise<{
    packageRoot: string;
    packageName: string;
    manifest: {
      id: string;
      apiVersion: number;
      version: string;
      displayName: string;
      description: string;
      author: string;
      categories: string[];
      capabilities: string[];
      entrypoints: { worker: string };
    };
  }> {
    const slug = `plugin-store-consistency-${randomUUID().slice(0, 8)}`;
    const pluginKey = `paperclip.${slug.replace(/-/g, "_")}`;
    const packageName = `@paperclipai/${slug}`;
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-fixture-"));
    cleanupPaths.add(packageRoot);
    const distDir = path.join(packageRoot, "dist");
    await mkdir(distDir, { recursive: true });

    const manifest = {
      id: pluginKey,
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Torn Store Fixture",
      description: "Fixture plugin for BLO-18384 torn package-store coverage.",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["companies.read"],
      entrypoints: { worker: "./dist/worker.js" },
    };

    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify(
        {
          name: packageName,
          version: "0.1.0",
          private: true,
          type: "module",
          paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" },
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(path.join(distDir, "manifest.js"), `export default ${JSON.stringify(manifest, null, 2)};\n`, "utf8");
    await writeFile(path.join(distDir, "worker.js"), "export {};\n", "utf8");

    return { packageRoot, packageName, manifest };
  }

  function createRuntimeServices(startWorker = vi.fn().mockResolvedValue(undefined)) {
    const markError = vi.fn().mockResolvedValue(undefined);
    const runtimeServices: PluginRuntimeServices = {
      workerManager: {
        startWorker,
        stopWorker: vi.fn().mockResolvedValue(undefined),
        getWorker: vi.fn().mockReturnValue(undefined),
        isRunning: vi.fn().mockReturnValue(false),
        stopAll: vi.fn().mockResolvedValue(undefined),
      } as unknown as PluginRuntimeServices["workerManager"],
      eventBus: {
        forPlugin: vi.fn(),
        subscriptionCount: vi.fn().mockReturnValue(0),
        clearPlugin: vi.fn(),
      } as unknown as PluginRuntimeServices["eventBus"],
      jobScheduler: {
        registerPlugin: vi.fn(),
        unregisterPlugin: vi.fn(),
        stop: vi.fn(),
      } as unknown as PluginRuntimeServices["jobScheduler"],
      jobStore: {
        syncJobDeclarations: vi.fn(),
      } as unknown as PluginRuntimeServices["jobStore"],
      toolDispatcher: {
        registerPluginTools: vi.fn(),
        unregisterPluginTools: vi.fn(),
      } as unknown as PluginRuntimeServices["toolDispatcher"],
      lifecycleManager: {
        markError,
        load: vi.fn(),
        upgrade: vi.fn(),
        unload: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
      } as unknown as PluginRuntimeServices["lifecycleManager"],
      buildHostHandlers: vi.fn().mockReturnValue({}),
      instanceInfo: { instanceId: "test-instance", hostVersion: "1.0.0" },
    };
    return { runtimeServices, startWorker, markError };
  }

  async function insertReadyFixturePlugin(input: Awaited<ReturnType<typeof createFixturePluginPackage>>) {
    const [plugin] = await db.insert(plugins).values({
      pluginKey: input.manifest.id,
      packageName: input.packageName,
      version: input.manifest.version,
      apiVersion: input.manifest.apiVersion,
      categories: input.manifest.categories as never,
      manifestJson: input.manifest as never,
      status: "ready",
      packagePath: input.packageRoot,
    }).returning();
    if (!plugin) throw new Error("fixture plugin row not inserted");
    return plugin;
  }

  it("waits for activation-time shared SDK reconciliation before marking a plugin errored", async () => {
    const fixture = await createFixturePluginPackage();
    const installDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-store-"));
    cleanupPaths.add(installDir);
    await writeLockfileVersion(installDir, SDK_PACKAGE, "2026.513.0");
    await writeInstalledPackageVersion(installDir, SDK_PACKAGE, "1.0.0");

    const settleStore = sleep(100).then(() => writeInstalledPackageVersion(installDir, SDK_PACKAGE, "2026.513.0"));
    const { runtimeServices, startWorker, markError } = createRuntimeServices();
    const plugin = await insertReadyFixturePlugin(fixture);

    const loader = pluginLoader(db, { localPluginDir: installDir }, runtimeServices);
    const result = await loader.loadSingle(plugin.id);
    await settleStore;

    expect(result.success).toBe(true);
    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(markError).not.toHaveBeenCalled();
  }, 20_000);

  it("refuses to spawn a worker — and marks the plugin errored in well under the 60s initialize timeout — when the shared SDK package-lock.json disagrees with what's physically installed", async () => {
    // ---- Fixture: a locally-installable plugin package -------------------
    const slug = `plugin-store-consistency-${randomUUID().slice(0, 8)}`;
    const pluginKey = `paperclip.${slug.replace(/-/g, "_")}`;
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-fixture-"));
    cleanupPaths.add(packageRoot);
    const distDir = path.join(packageRoot, "dist");
    await mkdir(distDir, { recursive: true });

    const manifest = {
      id: pluginKey,
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Torn Store Fixture",
      description: "Fixture plugin for BLO-18384 torn package-store coverage.",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["companies.read"],
      entrypoints: { worker: "./dist/worker.js" },
    };

    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: `@paperclipai/${slug}`, version: "0.1.0", private: true, type: "module", paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" } }, null, 2),
      "utf8",
    );
    await writeFile(path.join(distDir, "manifest.js"), `export default ${JSON.stringify(manifest, null, 2)};\n`, "utf8");
    await writeFile(path.join(distDir, "worker.js"), "export {};\n", "utf8");

    // ---- Torn shared plugin store: node_modules/@paperclipai/plugin-sdk ---
    // reports 1.0.0 while package-lock.json records 2026.513.0 — exactly the
    // invariant violation reported against the live PVC in BLO-18384.
    const installDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-store-"));
    cleanupPaths.add(installDir);
    await writeLockfileVersion(installDir, SDK_PACKAGE, "2026.513.0");
    await writeInstalledPackageVersion(installDir, SDK_PACKAGE, "1.0.0");

    // ---- Runtime services: worker spawn must never be reached -------------
    const startWorker = vi.fn().mockImplementation(async () => {
      // Simulate the real 60s initialize hang if this is ever reached, so a
      // regression fails the test on a timeout rather than hanging forever.
      throw new Error("startWorker should not have been called for a torn plugin store");
    });
    const markError = vi.fn().mockResolvedValue(undefined);
    const runtimeServices: PluginRuntimeServices = {
      workerManager: {
        startWorker,
        stopWorker: vi.fn().mockResolvedValue(undefined),
        getWorker: vi.fn().mockReturnValue(undefined),
        isRunning: vi.fn().mockReturnValue(false),
        stopAll: vi.fn().mockResolvedValue(undefined),
      } as unknown as PluginRuntimeServices["workerManager"],
      eventBus: {
        forPlugin: vi.fn(),
        subscriptionCount: vi.fn().mockReturnValue(0),
        clearPlugin: vi.fn(),
      } as unknown as PluginRuntimeServices["eventBus"],
      jobScheduler: {
        registerPlugin: vi.fn(),
        unregisterPlugin: vi.fn(),
        stop: vi.fn(),
      } as unknown as PluginRuntimeServices["jobScheduler"],
      jobStore: {
        syncJobDeclarations: vi.fn(),
      } as unknown as PluginRuntimeServices["jobStore"],
      toolDispatcher: {
        registerPluginTools: vi.fn(),
        unregisterPluginTools: vi.fn(),
      } as unknown as PluginRuntimeServices["toolDispatcher"],
      lifecycleManager: {
        markError,
        load: vi.fn(),
        upgrade: vi.fn(),
        unload: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
      } as unknown as PluginRuntimeServices["lifecycleManager"],
      buildHostHandlers: vi.fn().mockReturnValue({}),
      instanceInfo: { instanceId: "test-instance", hostVersion: "1.0.0" },
    };

    const loader = pluginLoader(db, { localPluginDir: installDir }, runtimeServices);

    const discovered = await loader.installPlugin({ localPath: packageRoot });
    expect(discovered.manifest?.id).toBe(pluginKey);

    const [installedRow] = await db.select().from(plugins).where(eq(plugins.pluginKey, pluginKey));
    if (!installedRow) throw new Error("fixture plugin row not found after install");
    await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, installedRow.id));

    const startedAt = Date.now();
    const result = await loader.loadSingle(installedRow.id);
    const elapsedMs = Date.now() - startedAt;

    // The real bug hangs for INITIALIZE_TIMEOUT_MS (60s) before failing with
    // an opaque timeout. The consistency guard now waits through bounded
    // rechecks for an in-flight install to settle, but must still fail far
    // below the worker initialize timeout.
    expect(elapsedMs).toBeLessThan(10_000);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Torn plugin store detected/);
    expect(result.error).toContain(SDK_PACKAGE);
    expect(result.error).toContain("2026.513.0");
    expect(result.error).toContain("1.0.0");

    expect(startWorker).not.toHaveBeenCalled();
    expect(markError).toHaveBeenCalledTimes(1);
    expect(markError).toHaveBeenCalledWith(installedRow.id, expect.stringContaining("Torn plugin store detected"));
  }, 20_000);
});

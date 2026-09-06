/**
 * BLO-20961 — startup migration for pre-isolation plugin rows.
 *
 * The `installDir` column was added additively, so every row predating it
 * carries `installDir = NULL` and keeps resolving to the shared plugin store.
 * On the worker tier that store is torn *by construction* (index.ts re-vendors
 * the workspace SDK fork over it on every boot while the lockfile records the
 * registry version), so those rows fail the consistency guard on every restart
 * and stay latched in `error` — which is the exact production recurrence this
 * issue exists to stop.
 *
 * These tests cover the relocation pass that moves such rows into their own
 * install dir and revives the ones the guard latched.
 *
 * `node:child_process` is mocked here rather than in
 * `plugin-store-consistency.test.ts` because `promisify(execFile)` captures the
 * binding at module init, so the mock has to be hoisted — and applying it
 * file-wide there would take the real npm path away from the local-filesystem
 * fixtures those tests rely on.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginRuntimeServices } from "../services/plugin-loader.js";

// npm install becomes a no-op; each test pre-seeds the package tree that a
// real install would have produced in the target prefix.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      ..._args: unknown[]
    ): unknown => {
      const cb = _args[_args.length - 1];
      if (typeof cb === "function") (cb as (e: null, o: string, s: string) => void)(null, "", "");
      return undefined;
    },
  };
});

const { createDb, plugins } = await import("@paperclipai/db");
const { pluginLoader, TORN_STORE_ERROR_MARKER } = await import("../services/plugin-loader.js");
const { ISOLATED_SDK_PLUGIN_PACKAGES, resolveDefaultInstallDir } = await import(
  "../bootstrap/isolated-sdk-plugins.js"
);
const { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } = await import(
  "./helpers/embedded-postgres.js"
);

const SDK_PACKAGE = "@paperclipai/plugin-sdk";
const ISOLATED_PACKAGE = ISOLATED_SDK_PLUGIN_PACKAGES[0]!;

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
  await mkdir(installDir, { recursive: true });
  await writeFile(
    path.join(installDir, "package-lock.json"),
    JSON.stringify(
      { lockfileVersion: 3, packages: { [`node_modules/${packageName}`]: { version } } },
      null,
      2,
    ),
    "utf8",
  );
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping isolated-store migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("BLO-20961 — pre-isolation rows migrate into an isolated install dir", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupPaths = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-isolated-store-migration-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

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

  /**
   * Seed the package tree a real `npm install --prefix <isolatedDir>` would
   * have left behind, so the mocked install resolves to a valid plugin.
   */
  async function seedIsolatedPackage(isolatedDir: string, pluginKey: string) {
    const packageDir = path.join(isolatedDir, "node_modules", ...ISOLATED_PACKAGE.split("/"));
    const distDir = path.join(packageDir, "dist");
    await mkdir(distDir, { recursive: true });

    const manifest = {
      id: pluginKey,
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Isolated Store Fixture",
      description: "Fixture for the BLO-20961 pre-isolation migration.",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["companies.read"],
      entrypoints: { worker: "./dist/worker.js" },
    };

    await writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify(
        {
          name: ISOLATED_PACKAGE,
          version: "0.1.0",
          type: "module",
          paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" },
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      path.join(distDir, "manifest.js"),
      `export default ${JSON.stringify(manifest)};\n`,
      "utf8",
    );
    await writeFile(path.join(distDir, "worker.js"), "export {};\n", "utf8");
    return manifest;
  }

  function createRuntimeServices() {
    const startWorker = vi.fn().mockResolvedValue(undefined);
    const markError = vi.fn().mockResolvedValue(undefined);
    const runtimeServices = {
      workerManager: {
        startWorker,
        stopWorker: vi.fn().mockResolvedValue(undefined),
        getWorker: vi.fn().mockReturnValue(undefined),
        isRunning: vi.fn().mockReturnValue(false),
        stopAll: vi.fn().mockResolvedValue(undefined),
      },
      eventBus: { forPlugin: vi.fn(), subscriptionCount: vi.fn().mockReturnValue(0), clearPlugin: vi.fn() },
      jobScheduler: { registerPlugin: vi.fn(), unregisterPlugin: vi.fn(), stop: vi.fn() },
      jobStore: { syncJobDeclarations: vi.fn() },
      toolDispatcher: { registerPluginTools: vi.fn(), unregisterPluginTools: vi.fn() },
      lifecycleManager: {
        markError,
        load: vi.fn(),
        upgrade: vi.fn(),
        unload: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
      },
      buildHostHandlers: vi.fn().mockReturnValue({}),
      instanceInfo: { instanceId: "test-instance", hostVersion: "1.0.0" },
    } as unknown as PluginRuntimeServices;
    return { runtimeServices, startWorker, markError };
  }

  /** Shared store torn exactly as the boot-time fork copy leaves it. */
  async function tornSharedStore() {
    const sharedDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-shared-"));
    cleanupPaths.add(sharedDir);
    await writeLockfileVersion(sharedDir, SDK_PACKAGE, "2026.513.0");
    await writeInstalledPackageVersion(sharedDir, SDK_PACKAGE, "1.0.0");
    return sharedDir;
  }

  async function insertLegacyRow(
    pluginKey: string,
    manifest: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ) {
    const [row] = await db
      .insert(plugins)
      .values({
        pluginKey,
        packageName: ISOLATED_PACKAGE,
        version: "0.1.0",
        apiVersion: 1,
        categories: ["automation"] as never,
        manifestJson: manifest as never,
        status: "ready",
        // The whole point: a row written before the installDir column existed.
        installDir: null,
        packagePath: null,
        ...overrides,
      })
      .returning();
    if (!row) throw new Error("fixture plugin row not inserted");
    return row;
  }

  it("relocates an installDir IS NULL row off the shared store and persists the isolated dir", async () => {
    const sharedDir = await tornSharedStore();
    const isolatedDir = resolveDefaultInstallDir(ISOLATED_PACKAGE, sharedDir);
    cleanupPaths.add(isolatedDir);

    const pluginKey = `paperclip.legacy_${randomUUID().slice(0, 8)}`;
    const manifest = await seedIsolatedPackage(isolatedDir, pluginKey);
    // The isolated store is congruent — only the shared one is torn.
    await writeLockfileVersion(isolatedDir, SDK_PACKAGE, "2026.513.0");
    await writeInstalledPackageVersion(isolatedDir, SDK_PACKAGE, "2026.513.0");

    const row = await insertLegacyRow(pluginKey, manifest);
    expect(row.installDir).toBeNull();

    const { runtimeServices } = createRuntimeServices();
    const loader = pluginLoader(db, { localPluginDir: sharedDir }, runtimeServices);
    await loader.loadAll();

    const [after] = await db.select().from(plugins);
    expect(after?.installDir).toBe(isolatedDir);
    // Persisted, not merely resolved at runtime — a later boot must not have
    // to redo this, and must not fall back to the shared store.
    expect(after?.installDir).not.toBe(sharedDir);
  }, 60_000);

  it("revives a row the torn-store guard latched in error, so loadAll can see it again", async () => {
    const sharedDir = await tornSharedStore();
    const isolatedDir = resolveDefaultInstallDir(ISOLATED_PACKAGE, sharedDir);
    cleanupPaths.add(isolatedDir);

    const pluginKey = `paperclip.latched_${randomUUID().slice(0, 8)}`;
    const manifest = await seedIsolatedPackage(isolatedDir, pluginKey);
    await writeLockfileVersion(isolatedDir, SDK_PACKAGE, "2026.513.0");
    await writeInstalledPackageVersion(isolatedDir, SDK_PACKAGE, "2026.513.0");

    await insertLegacyRow(pluginKey, manifest, {
      status: "error",
      lastError: `${TORN_STORE_ERROR_MARKER}: package-lock.json for ${SDK_PACKAGE} records '2026.513.0' but ...`,
    });

    const { runtimeServices } = createRuntimeServices();
    const loader = pluginLoader(db, { localPluginDir: sharedDir }, runtimeServices);
    await loader.loadAll();

    const [after] = await db.select().from(plugins);
    expect(after?.status).toBe("ready");
    expect(after?.lastError).toBeNull();
    expect(after?.installDir).toBe(isolatedDir);
  }, 60_000);

  it("leaves a row errored for an unrelated reason alone", async () => {
    const sharedDir = await tornSharedStore();
    const isolatedDir = resolveDefaultInstallDir(ISOLATED_PACKAGE, sharedDir);
    cleanupPaths.add(isolatedDir);

    const pluginKey = `paperclip.unrelated_${randomUUID().slice(0, 8)}`;
    const manifest = await seedIsolatedPackage(isolatedDir, pluginKey);

    await insertLegacyRow(pluginKey, manifest, {
      status: "error",
      lastError: "Worker crashed during initialize: boom",
    });

    const { runtimeServices } = createRuntimeServices();
    const loader = pluginLoader(db, { localPluginDir: sharedDir }, runtimeServices);
    await loader.loadAll();

    const [after] = await db.select().from(plugins);
    // Not the guard's doing, so the migration must not launder it into ready.
    expect(after?.status).toBe("error");
    expect(after?.lastError).toContain("Worker crashed");
  }, 60_000);

  it("does not touch a row that already carries an installDir", async () => {
    const sharedDir = await tornSharedStore();
    const alreadyIsolated = await mkdtemp(path.join(os.tmpdir(), "paperclip-preset-"));
    cleanupPaths.add(alreadyIsolated);

    const pluginKey = `paperclip.preset_${randomUUID().slice(0, 8)}`;
    const manifest = await seedIsolatedPackage(alreadyIsolated, pluginKey);
    await writeLockfileVersion(alreadyIsolated, SDK_PACKAGE, "2026.513.0");
    await writeInstalledPackageVersion(alreadyIsolated, SDK_PACKAGE, "2026.513.0");

    await insertLegacyRow(pluginKey, manifest, { installDir: alreadyIsolated });

    const { runtimeServices } = createRuntimeServices();
    const loader = pluginLoader(db, { localPluginDir: sharedDir }, runtimeServices);
    await loader.loadAll();

    const [after] = await db.select().from(plugins);
    expect(after?.installDir).toBe(alreadyIsolated);
  }, 60_000);
});

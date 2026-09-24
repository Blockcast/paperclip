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

// npm install becomes a no-op by default; each test pre-seeds the package tree
// that a real install would have produced in the target prefix. `npmMock`
// records every argv so the BLO-34795 assertions read the *real* command rather
// than a copy of it, and `onInstall` lets a test make the fake install actually
// materialise a tree (the success path of the isolated SDK repair).
const npmMock = vi.hoisted(() => ({
  calls: [] as string[][],
  onInstall: null as null | ((args: string[]) => void | Promise<void>),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      ..._args: unknown[]
    ): unknown => {
      const cb = _args[_args.length - 1];
      const argv = Array.isArray(_args[1]) ? (_args[1] as string[]) : [];
      npmMock.calls.push(argv);
      const done = (err: Error | null): void => {
        if (typeof cb === "function") (cb as (e: Error | null, o: string, s: string) => void)(err, "", "");
      };
      void Promise.resolve(npmMock.onInstall?.(argv)).then(
        () => done(null),
        (err: unknown) => done(err instanceof Error ? err : new Error(String(err))),
      );
      return undefined;
    },
  };
});

const { createDb, plugins } = await import("@paperclipai/db");
const { pluginLoader, TORN_STORE_ERROR_MARKER, SDK_NOT_INSTALLED_ERROR_MARKER, buildPluginInstallArgs } =
  await import("../services/plugin-loader.js");
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
    npmMock.calls.length = 0;
    npmMock.onInstall = null;
    delete process.env["PAPERCLIP_PLUGIN_BOOT_ACTIVATION_RETRY_LIMIT"];
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

  // BLO-31857 — the nothing-installed latch needs its own un-latch rule.
  //
  // The torn-store marker above is cleared by a *relocation*, which is what
  // repoints a row away from the torn shared store. An empty tree is repaired
  // by an actual install, which never moves the dir — so a relocation test
  // would strand such a row in `error` forever and require an operator. These
  // two pin the re-probe rule that replaces it: revive iff the SDK is genuinely
  // there now, whether or not the dir moved.
  it("revives a row latched by the nothing-installed guard once the SDK install has landed, even though the dir never moved", async () => {
    const sharedDir = await tornSharedStore();
    // A row that ALREADY carries an installDir, so the relocation pass returns
    // it unchanged — the case the torn-store rule cannot help.
    const isolatedDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-notinstalled-"));
    cleanupPaths.add(isolatedDir);

    const pluginKey = `paperclip.notinstalled_${randomUUID().slice(0, 8)}`;
    const manifest = await seedIsolatedPackage(isolatedDir, pluginKey);
    // The slow boot `npm install` that outran the activation recheck window has
    // since completed: the SDK is now present and congruent.
    await writeLockfileVersion(isolatedDir, SDK_PACKAGE, "2026.513.0");
    await writeInstalledPackageVersion(isolatedDir, SDK_PACKAGE, "2026.513.0");

    await insertLegacyRow(pluginKey, manifest, {
      installDir: isolatedDir,
      status: "error",
      lastError: `${SDK_NOT_INSTALLED_ERROR_MARKER}: ${isolatedDir}/package-lock.json records no ${SDK_PACKAGE} entry ...`,
    });

    const { runtimeServices } = createRuntimeServices();
    const loader = pluginLoader(db, { localPluginDir: sharedDir }, runtimeServices);
    await loader.loadAll();

    const [after] = await db.select().from(plugins);
    expect(after?.status).toBe("ready");
    expect(after?.lastError).toBeNull();
    expect(after?.installDir).toBe(isolatedDir);
  }, 60_000);

  it("leaves a row latched by the nothing-installed guard errored while its tree is still empty", async () => {
    const sharedDir = await tornSharedStore();
    const isolatedDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-stillempty-"));
    cleanupPaths.add(isolatedDir);

    const pluginKey = `paperclip.stillempty_${randomUUID().slice(0, 8)}`;
    // The plugin package is there, but no SDK and no lockfile — the tree is
    // still (absent)/(absent), so the re-probe must NOT revive it into the
    // same failure.
    const manifest = await seedIsolatedPackage(isolatedDir, pluginKey);

    await insertLegacyRow(pluginKey, manifest, {
      installDir: isolatedDir,
      status: "error",
      lastError: `${SDK_NOT_INSTALLED_ERROR_MARKER}: ${isolatedDir}/package-lock.json records no ${SDK_PACKAGE} entry ...`,
    });

    const { runtimeServices } = createRuntimeServices();
    const loader = pluginLoader(db, { localPluginDir: sharedDir }, runtimeServices);
    await loader.loadAll();

    const [after] = await db.select().from(plugins);
    expect(after?.status).toBe("error");
    expect(after?.lastError).toContain(SDK_NOT_INSTALLED_ERROR_MARKER);
  }, 60_000);

  // BLO-34795 — an isolated tree that has lost its SDK must repair itself.
  //
  // `@lucitra/paperclip-plugin-secrets` declares `@paperclipai/plugin-sdk` as a
  // *peer* and has no regular dependencies, so while every plugin install ran
  // with `--legacy-peer-deps` no code path in the server could ever place the
  // SDK in its isolated tree. The boot install loop fired on every restart and
  // could not help; the tree was only ever repaired by a human `npm install`
  // over `kubectl exec`. These four pin the fix and, more importantly, the two
  // things it must not do.

  /** argv the loader passed to npm for installs targeting `prefix`. */
  function installArgsFor(prefix: string): string[][] {
    return npmMock.calls.filter((argv) => argv[0] === "install" && argv.includes(prefix));
  }

  it("reinstalls an isolated tree whose SDK is gone and re-enables the row in the same boot", async () => {
    const sharedDir = await tornSharedStore();
    const isolatedDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-sdkgone-"));
    cleanupPaths.add(isolatedDir);

    const pluginKey = `paperclip.sdkgone_${randomUUID().slice(0, 8)}`;
    const manifest = await seedIsolatedPackage(isolatedDir, pluginKey);
    // Production shape: the lockfile exists and records the *plugin*, but has
    // no SDK entry (it was installed as an uninstallable peer), and the SDK is
    // physically absent. That is (absent)/(absent) for the SDK — `not_installed`.
    await writeLockfileVersion(isolatedDir, ISOLATED_PACKAGE, "0.1.0");

    // A real peer-resolving `npm install` would land the SDK. The mock does it
    // so the re-probe has something true to find.
    npmMock.onInstall = async (argv) => {
      if (!argv.includes(isolatedDir)) return;
      await writeLockfileVersion(isolatedDir, SDK_PACKAGE, "2026.916.1");
      await writeInstalledPackageVersion(isolatedDir, SDK_PACKAGE, "2026.916.1");
    };

    await insertLegacyRow(pluginKey, manifest, {
      installDir: isolatedDir,
      status: "error",
      lastError: `${SDK_NOT_INSTALLED_ERROR_MARKER}: ${isolatedDir}/package-lock.json records no ${SDK_PACKAGE} entry ...`,
    });

    const { runtimeServices } = createRuntimeServices();
    const loader = pluginLoader(db, { localPluginDir: sharedDir }, runtimeServices);
    await loader.loadAll();

    const [after] = await db.select().from(plugins);
    // No human exec, no second boot.
    expect(after?.status).toBe("ready");
    expect(after?.lastError).toBeNull();
    expect(after?.installDir).toBe(isolatedDir);

    // The mechanism, not just the outcome: the isolated install resolves peers,
    // which is the only way the SDK can enter that tree.
    const isolatedInstalls = installArgsFor(isolatedDir);
    expect(isolatedInstalls.length).toBeGreaterThan(0);
    for (const argv of isolatedInstalls) {
      expect(argv).not.toContain("--legacy-peer-deps");
    }
  }, 60_000);

  it("does not reinstall the BLO-31857 healthy shape — lock absent, SDK installed", async () => {
    const sharedDir = await tornSharedStore();
    const isolatedDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-healthy-"));
    cleanupPaths.add(isolatedDir);

    const pluginKey = `paperclip.healthy_${randomUUID().slice(0, 8)}`;
    const manifest = await seedIsolatedPackage(isolatedDir, pluginKey);
    // No SDK lockfile entry, but the SDK is physically there. BLO-31857: this
    // tree works, and a reinstall over it is the tear BLO-20961 is about.
    await writeInstalledPackageVersion(isolatedDir, SDK_PACKAGE, "2026.916.1");

    await insertLegacyRow(pluginKey, manifest, {
      installDir: isolatedDir,
      status: "error",
      lastError: `${SDK_NOT_INSTALLED_ERROR_MARKER}: ${isolatedDir}/package-lock.json records no ${SDK_PACKAGE} entry ...`,
    });

    const { runtimeServices } = createRuntimeServices();
    const loader = pluginLoader(db, { localPluginDir: sharedDir }, runtimeServices);
    await loader.loadAll();

    const [after] = await db.select().from(plugins);
    expect(after?.status).toBe("ready");
    expect(after?.lastError).toBeNull();
    // Revived by the re-probe alone. Nothing was reinstalled over a good tree.
    expect(installArgsFor(isolatedDir)).toEqual([]);
  }, 60_000);

  it("never names the SDK in an install argv, and keeps --legacy-peer-deps for the shared store", async () => {
    // The shared store must not gain a second SDK writer (BLO-20961): the fix
    // changes which *peers* npm resolves in an isolated tree, and adds no
    // explicit SDK install anywhere. Asserted against the real argv builder so
    // it cannot drift from the command the loader actually runs.
    const sharedDir = await tornSharedStore();
    const isolatedDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-argv-"));
    cleanupPaths.add(isolatedDir);

    const sharedArgs = buildPluginInstallArgs(ISOLATED_PACKAGE, sharedDir, "/tmp/cache", {
      installPeers: false,
    });
    expect(sharedArgs).toContain("--legacy-peer-deps");
    expect(sharedArgs.join(" ")).not.toContain(SDK_PACKAGE);

    const isolatedArgs = buildPluginInstallArgs(ISOLATED_PACKAGE, isolatedDir, "/tmp/cache", {
      installPeers: true,
    });
    expect(isolatedArgs).not.toContain("--legacy-peer-deps");
    expect(isolatedArgs.join(" ")).not.toContain(SDK_PACKAGE);
  });

  it("stops reinstalling after the boot budget, leaving the exhausting failure in lastError", async () => {
    process.env["PAPERCLIP_PLUGIN_BOOT_ACTIVATION_RETRY_LIMIT"] = "1";

    const sharedDir = await tornSharedStore();
    const isolatedDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-budget-"));
    cleanupPaths.add(isolatedDir);

    const pluginKey = `paperclip.budget_${randomUUID().slice(0, 8)}`;
    const manifest = await seedIsolatedPackage(isolatedDir, pluginKey);
    await writeLockfileVersion(isolatedDir, ISOLATED_PACKAGE, "0.1.0");
    // A package that cannot be repaired: every install fails.
    npmMock.onInstall = (argv) => {
      if (argv.includes(isolatedDir)) throw new Error("E404 Not Found - GET .../- not found");
    };

    await insertLegacyRow(pluginKey, manifest, {
      installDir: isolatedDir,
      status: "error",
      lastError: `${SDK_NOT_INSTALLED_ERROR_MARKER}: ${isolatedDir}/package-lock.json records no ${SDK_PACKAGE} entry ...`,
    });

    const { runtimeServices } = createRuntimeServices();
    const loader = pluginLoader(db, { localPluginDir: sharedDir }, runtimeServices);

    await loader.loadAll();
    const [firstBoot] = await db.select().from(plugins);
    expect(firstBoot?.status).toBe("error");
    // The exhausting failure, not the stale original.
    expect(firstBoot?.lastError).toContain("E404 Not Found");
    expect(firstBoot?.lastError).toContain(SDK_NOT_INSTALLED_ERROR_MARKER);

    // Budget is spent across boots, not reset by each one.
    const afterFirstBoot = installArgsFor(isolatedDir).length;
    expect(afterFirstBoot).toBeGreaterThan(0);

    await loader.loadAll();
    const [secondBoot] = await db.select().from(plugins);
    expect(secondBoot?.status).toBe("error");
    expect(installArgsFor(isolatedDir).length).toBe(afterFirstBoot);
  }, 60_000);
});

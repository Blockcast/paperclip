/**
 * BLO-20410 — a transient activation failure must not survive a restart.
 *
 * The in-activation retry (`TRANSIENT_ACTIVATION_RETRY_DELAYS_MS`) only ever
 * covers the attempt already running. Once a row latches `error`, `loadAll()`
 * cannot see it again — it selects `status='ready'` — so the four plugins in
 * the original report were still dead 9 hours and one restart later, and a
 * human `/enable` was the only way back.
 *
 * These tests drive `loadAll()` against a real registry and assert the boot
 * re-attempt pass: a transiently-latched row is activated with no `/enable`
 * call, a row that failed closed is not, and the re-attempt budget is spent
 * across boots rather than reset by each one.
 *
 * The negative control is `PAPERCLIP_PLUGIN_BOOT_ACTIVATION_RETRY_LIMIT=0`,
 * which disables the pass and reproduces the pre-fix latch exactly. A test that
 * passes with the pass disabled is not measuring this defect.
 *
 * `node:child_process` is mocked for the same reason as
 * `plugin-isolated-store-migration.test.ts`: `promisify(execFile)` captures the
 * binding at module init, so the mock has to be hoisted.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginRuntimeServices } from "../services/plugin-loader.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (..._args: unknown[]): unknown => {
      const cb = _args[_args.length - 1];
      if (typeof cb === "function") (cb as (e: null, o: string, s: string) => void)(null, "", "");
      return undefined;
    },
  };
});

const { createDb, plugins } = await import("@paperclipai/db");
const {
  pluginLoader,
  TRANSIENT_RETRY_EXHAUSTED_MARKER,
  readBootActivationRetryCount,
} = await import("../services/plugin-loader.js");
const { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } = await import(
  "./helpers/embedded-postgres.js"
);

const RETRY_LIMIT_ENV = "PAPERCLIP_PLUGIN_BOOT_ACTIVATION_RETRY_LIMIT";

/** The exact `lastError` an exhausted transient activation writes. */
function transientLatchText(attempts = 2): string {
  return (
    `Activation failed: Worker initialize failed for "fixture": ` +
    `RPC call "initialize" timed out after 60000ms ` +
    `(${TRANSIENT_RETRY_EXHAUSTED_MARKER}: ${attempts} transient and 0 sdk-install-race retries spent)`
  );
}

/** The `lastError` a plugin that threw from its own `initialize` writes. */
const FAILED_CLOSED_LATCH_TEXT =
  `Activation failed: Worker initialize failed for "fixture": ` +
  `plugin config invalid: missing apiKey ` +
  `(failed closed on first attempt; not classified as transient)`;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping boot activation-retry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("BLO-20410 — boot re-attempts a transiently-latched plugin", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupPaths = new Set<string>();
  const originalRetryLimit = process.env[RETRY_LIMIT_ENV];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-boot-activation-retry-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(plugins);
    for (const cleanupPath of cleanupPaths) {
      await rm(cleanupPath, { recursive: true, force: true });
    }
    cleanupPaths.clear();
    if (originalRetryLimit === undefined) delete process.env[RETRY_LIMIT_ENV];
    else process.env[RETRY_LIMIT_ENV] = originalRetryLimit;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * A plugin dir the loader can resolve a worker entrypoint from. The store is
   * congruent so the torn-store guard stays out of the way — this suite is
   * about the activation latch, not the consistency check.
   */
  async function seedPluginDir(pluginKey: string) {
    const installDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-boot-retry-"));
    cleanupPaths.add(installDir);

    const packageName = `fixture-plugin-${pluginKey.split(".").pop()}`;
    const packageDir = path.join(installDir, "node_modules", packageName);
    const distDir = path.join(packageDir, "dist");
    await mkdir(distDir, { recursive: true });

    const manifest = {
      id: pluginKey,
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Boot Retry Fixture",
      description: "Fixture for the BLO-20410 boot re-attempt pass.",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["companies.read"],
      entrypoints: { worker: "./dist/worker.js" },
    };

    await writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify(
        {
          name: packageName,
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

    return { installDir, packageName, manifest };
  }

  function createRuntimeServices(options: { startWorkerFails?: boolean } = {}) {
    const startWorker = options.startWorkerFails
      ? vi.fn().mockRejectedValue(
          new Error(
            'Worker initialize failed for "fixture": RPC call "initialize" timed out after 60000ms',
          ),
        )
      : vi.fn().mockResolvedValue(undefined);
    const markError = vi.fn(async (pluginId: string, error: string) => {
      // Stand in for the real lifecycle transition: the assertion under test is
      // what lands in the row, so the write has to actually happen.
      const { eq } = await import("drizzle-orm");
      await db
        .update(plugins)
        .set({ status: "error", lastError: error, updatedAt: new Date() })
        .where(eq(plugins.id, pluginId));
    });
    const enable = vi.fn().mockResolvedValue(undefined);
    const runtimeServices = {
      workerManager: {
        startWorker,
        stopWorker: vi.fn().mockResolvedValue(undefined),
        getWorker: vi.fn().mockReturnValue(undefined),
        isRunning: vi.fn().mockReturnValue(false),
        stopAll: vi.fn().mockResolvedValue(undefined),
      },
      eventBus: {
        forPlugin: vi.fn(),
        subscriptionCount: vi.fn().mockReturnValue(0),
        clearPlugin: vi.fn(),
      },
      jobScheduler: { registerPlugin: vi.fn(), unregisterPlugin: vi.fn(), stop: vi.fn() },
      jobStore: { syncJobDeclarations: vi.fn() },
      toolDispatcher: { registerPluginTools: vi.fn(), unregisterPluginTools: vi.fn() },
      lifecycleManager: {
        markError,
        load: vi.fn(),
        upgrade: vi.fn(),
        unload: vi.fn(),
        enable,
        disable: vi.fn(),
      },
      buildHostHandlers: vi.fn().mockReturnValue({}),
      instanceInfo: { instanceId: "test-instance", hostVersion: "1.0.0" },
    } as unknown as PluginRuntimeServices;
    return { runtimeServices, startWorker, markError, enable };
  }

  async function insertLatchedRow(
    pluginKey: string,
    manifest: Record<string, unknown>,
    packageName: string,
    installDir: string,
    lastError: string,
  ) {
    const [row] = await db
      .insert(plugins)
      .values({
        pluginKey,
        packageName,
        version: "0.1.0",
        apiVersion: 1,
        categories: ["automation"] as never,
        manifestJson: manifest as never,
        status: "error",
        installDir,
        packagePath: null,
        lastError,
      })
      .returning();
    if (!row) throw new Error("fixture plugin row not inserted");
    return row;
  }

  it("activates a plugin latched by an exhausted transient budget, with no /enable call", async () => {
    const pluginKey = `paperclip.transient_${randomUUID().slice(0, 8)}`;
    const { installDir, packageName, manifest } = await seedPluginDir(pluginKey);
    await insertLatchedRow(pluginKey, manifest, packageName, installDir, transientLatchText());

    const { runtimeServices, startWorker, enable } = createRuntimeServices();
    const loader = pluginLoader(db, { localPluginDir: installDir }, runtimeServices);
    const result = await loader.loadAll();

    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(result.succeeded).toBe(1);

    const [after] = await db.select().from(plugins);
    expect(after?.status).toBe("ready");
    // The AC is explicit about both halves: recovered means ready *and* clean,
    // so the row is indistinguishable from one that never failed.
    expect(after?.lastError).toBeNull();
    // Recovery must not have gone through the operator route.
    expect(enable).not.toHaveBeenCalled();
  }, 60_000);

  it("NEGATIVE CONTROL: with the pass disabled the same row stays latched forever", async () => {
    process.env[RETRY_LIMIT_ENV] = "0";

    const pluginKey = `paperclip.control_${randomUUID().slice(0, 8)}`;
    const { installDir, packageName, manifest } = await seedPluginDir(pluginKey);
    const latchText = transientLatchText();
    await insertLatchedRow(pluginKey, manifest, packageName, installDir, latchText);

    const { runtimeServices, startWorker } = createRuntimeServices();
    const loader = pluginLoader(db, { localPluginDir: installDir }, runtimeServices);
    const result = await loader.loadAll();

    // This is the pre-fix build: loadAll cannot see the row at all.
    expect(result.total).toBe(0);
    expect(startWorker).not.toHaveBeenCalled();

    const [after] = await db.select().from(plugins);
    expect(after?.status).toBe("error");
    expect(after?.lastError).toBe(latchText);
  }, 60_000);

  it("leaves a plugin that failed closed on the first attempt latched", async () => {
    const pluginKey = `paperclip.closed_${randomUUID().slice(0, 8)}`;
    const { installDir, packageName, manifest } = await seedPluginDir(pluginKey);
    await insertLatchedRow(
      pluginKey,
      manifest,
      packageName,
      installDir,
      FAILED_CLOSED_LATCH_TEXT,
    );

    const { runtimeServices, startWorker } = createRuntimeServices();
    const loader = pluginLoader(db, { localPluginDir: installDir }, runtimeServices);
    await loader.loadAll();

    expect(startWorker).not.toHaveBeenCalled();

    const [after] = await db.select().from(plugins);
    // A real fault must stay terminal — that is the whole point of recording
    // the latch provenance rather than retrying every error row.
    expect(after?.status).toBe("error");
    expect(after?.lastError).toBe(FAILED_CLOSED_LATCH_TEXT);
  }, 60_000);

  it("spends the re-attempt budget across boots and stops rather than retrying forever", async () => {
    process.env[RETRY_LIMIT_ENV] = "2";

    const pluginKey = `paperclip.budget_${randomUUID().slice(0, 8)}`;
    const { installDir, packageName, manifest } = await seedPluginDir(pluginKey);
    await insertLatchedRow(pluginKey, manifest, packageName, installDir, transientLatchText());

    // Every boot times out again — a plugin whose transient failure is in fact
    // permanent. The budget has to converge instead of re-arming each restart.
    const attemptsPerBoot: number[] = [];
    for (let boot = 1; boot <= 4; boot += 1) {
      const { runtimeServices, startWorker } = createRuntimeServices({ startWorkerFails: true });
      const loader = pluginLoader(db, { localPluginDir: installDir }, runtimeServices);
      await loader.loadAll();
      attemptsPerBoot.push(startWorker.mock.calls.length);
    }

    // Boots 1 and 2 re-attempt (3 in-activation attempts each: initial + 2
    // retries); boots 3 and 4 find the budget spent and do not spawn at all.
    expect(attemptsPerBoot[0]).toBeGreaterThan(0);
    expect(attemptsPerBoot[1]).toBeGreaterThan(0);
    expect(attemptsPerBoot[2]).toBe(0);
    expect(attemptsPerBoot[3]).toBe(0);

    const [after] = await db.select().from(plugins);
    expect(after?.status).toBe("error");
    // The exhausting failure is still the recorded one, and the count that
    // exhausted the budget is legible to an operator reading the row.
    expect(after?.lastError).toContain(TRANSIENT_RETRY_EXHAUSTED_MARKER);
    expect(readBootActivationRetryCount(after?.lastError)).toBe(2);
  }, 120_000);
});

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
  classifyActivationLatch,
  TRANSIENT_RETRY_EXHAUSTED_MARKER,
  SDK_INSTALL_RACE_RETRY_EXHAUSTED_MARKER,
  readBootActivationRetryCount,
  isBootReattemptEligibleLatch,
} = await import("../services/plugin-loader.js");
const { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } = await import(
  "./helpers/embedded-postgres.js"
);

const RETRY_LIMIT_ENV = "PAPERCLIP_PLUGIN_BOOT_ACTIVATION_RETRY_LIMIT";

const INITIALIZE_TIMEOUT_ERROR = new Error(
  'Worker initialize failed for "fixture": RPC call "initialize" timed out after 60000ms',
);
/** A plugin rejecting its own `initialize` — same prefix, opposite meaning. */
const FAILED_CLOSED_ERROR = new Error(
  'Worker initialize failed for "fixture": plugin config invalid: missing apiKey',
);
const SDK_INSTALL_RACE_ERROR = new Error(
  "ERR_MODULE_NOT_FOUND: Cannot find package '@paperclipai/plugin-sdk' imported from worker.js",
);

/**
 * The eligibility predicate decides whether a boot may re-attempt a row, so it
 * is asserted directly rather than only through its effect. The case that
 * motivates this: spending a transient retry and *then* failing closed used to
 * be recorded as transient, because the marker was keyed on whether a retry had
 * been spent rather than on what the terminal failure was.
 */
describe("classifyActivationLatch — keys eligibility on the terminal error", () => {
  it("marks a row eligible when the transient budget was spent and the terminal error is transient", () => {
    const latch = classifyActivationLatch({
      err: INITIALIZE_TIMEOUT_ERROR,
      transientAttempt: 2,
      sdkRaceAttempt: 0,
    });

    expect(latch.eligibleForBootReattempt).toBe(true);
    expect(latch.suffix).toContain(TRANSIENT_RETRY_EXHAUSTED_MARKER);
  });

  it("does NOT revive a row that spent a transient retry and then failed closed", () => {
    // Attempt 1 times out (transientAttempt -> 1), attempt 2 is rejected by the
    // plugin itself. The row is genuinely broken: re-attempting it every boot
    // would burn the budget on a fault no restart can fix.
    const latch = classifyActivationLatch({
      err: FAILED_CLOSED_ERROR,
      transientAttempt: 1,
      sdkRaceAttempt: 0,
    });

    expect(latch.eligibleForBootReattempt).toBe(false);
    expect(latch.suffix).not.toContain(TRANSIENT_RETRY_EXHAUSTED_MARKER);
    // The counter is still recorded — it is provenance, just not the verdict.
    expect(latch.suffix).toContain("1 transient");
  });

  it("marks an SDK-install-race latch eligible so it is not left dead across boots", () => {
    const latch = classifyActivationLatch({
      err: SDK_INSTALL_RACE_ERROR,
      transientAttempt: 0,
      sdkRaceAttempt: 5,
    });

    expect(latch.eligibleForBootReattempt).toBe(true);
    expect(latch.suffix).toContain(SDK_INSTALL_RACE_RETRY_EXHAUSTED_MARKER);
  });

  it("does not let an SDK-install-race latch claim the transient marker", () => {
    // A worker that crashed at import matches both classifiers. The retry loop
    // refuses to let one class borrow the other's attempts; so must the marker.
    const latch = classifyActivationLatch({
      err: SDK_INSTALL_RACE_ERROR,
      transientAttempt: 1,
      sdkRaceAttempt: 5,
    });

    expect(latch.suffix).toContain(SDK_INSTALL_RACE_RETRY_EXHAUSTED_MARKER);
    expect(latch.suffix).not.toContain(TRANSIENT_RETRY_EXHAUSTED_MARKER);
  });

  it("leaves a first-attempt failed-closed row terminal", () => {
    const latch = classifyActivationLatch({
      err: FAILED_CLOSED_ERROR,
      transientAttempt: 0,
      sdkRaceAttempt: 0,
    });

    expect(latch.eligibleForBootReattempt).toBe(false);
    expect(latch.suffix).toContain("failed closed");
  });
});

/**
 * `lastError` concatenates the plugin's own error text, so eligibility must be
 * read from the region the loader writes rather than scanned for anywhere in
 * the string. The forged-marker case is the one that used to be unbounded: the
 * row latches with no re-attempt tag (suppressed when the latch is ineligible),
 * so a substring scan saw eligible=true and a spent count of 0 on *every* boot
 * — a fixed point that re-attempted forever and buried the budget-exhausted
 * warning.
 */
describe("isBootReattemptEligibleLatch — reads only the suffix the loader writes", () => {
  it("accepts exactly what classifyActivationLatch writes for each eligible class", () => {
    for (const { err, transientAttempt, sdkRaceAttempt } of [
      { err: INITIALIZE_TIMEOUT_ERROR, transientAttempt: 2, sdkRaceAttempt: 0 },
      { err: SDK_INSTALL_RACE_ERROR, transientAttempt: 0, sdkRaceAttempt: 5 },
    ]) {
      const latch = classifyActivationLatch({ err, transientAttempt, sdkRaceAttempt });
      expect(latch.eligibleForBootReattempt).toBe(true);
      // Round-trip: pins the suffix format against its matching pattern, which
      // would otherwise be free to drift apart silently.
      expect(isBootReattemptEligibleLatch(`Activation failed: boom${latch.suffix}`)).toBe(true);
    }
  });

  it("still accepts an eligible row carrying a re-attempt tag", () => {
    expect(
      isBootReattemptEligibleLatch(`${transientLatchText()} [boot-activation-retry 1/3]`),
    ).toBe(true);
  });

  it("does NOT revive a failed-closed row whose plugin error text forges the marker", () => {
    const latch = classifyActivationLatch({
      err: new Error(`plugin config invalid (${TRANSIENT_RETRY_EXHAUSTED_MARKER})`),
      transientAttempt: 0,
      sdkRaceAttempt: 0,
    });

    expect(latch.eligibleForBootReattempt).toBe(false);
    expect(
      isBootReattemptEligibleLatch(
        `Activation failed: plugin config invalid ` +
          `(${TRANSIENT_RETRY_EXHAUSTED_MARKER})${latch.suffix}`,
      ),
    ).toBe(false);
  });

  it("does NOT revive a row whose plugin error text forges the whole suffix", () => {
    // The real suffix is always appended last, so a forged copy can never be
    // the trailing one — this is the same fail-safe the tag anchoring buys.
    const latch = classifyActivationLatch({
      err: FAILED_CLOSED_ERROR,
      transientAttempt: 0,
      sdkRaceAttempt: 0,
    });

    expect(
      isBootReattemptEligibleLatch(`${transientLatchText()}${latch.suffix}`),
    ).toBe(false);
  });

  it("does not revive a row with no latch provenance at all", () => {
    expect(isBootReattemptEligibleLatch(null)).toBe(false);
    expect(isBootReattemptEligibleLatch("Activation failed: boom")).toBe(false);
  });

  it("revives a row latched by the previous release's suffix format", () => {
    // The rows this pass exists to rescue are latched *now*, by the deployed
    // build, in a format the new pattern does not match. Without this the first
    // boot after the rollout rescues nothing and a human `/enable` is still the
    // only way back for them.
    expect(isBootReattemptEligibleLatch(legacyLatchText())).toBe(true);
    expect(isBootReattemptEligibleLatch(`${legacyLatchText()} [boot-activation-retry 1/3]`)).toBe(
      true,
    );
  });

  it("stops honouring the legacy suffix as soon as the row has been re-latched", () => {
    // This is what bounds the legacy allowance to one re-attempt per row. Every
    // latch rewrites `lastError` through classifyActivationLatch, which always
    // appends one of its own suffixes — including on the failed-closed branch —
    // so the legacy suffix can never be the trailing region a second time. A
    // row that spent a transient retry and then failed closed is exactly the
    // case the legacy format cannot distinguish, so it is the one to pin.
    const latch = classifyActivationLatch({
      err: FAILED_CLOSED_ERROR,
      transientAttempt: 1,
      sdkRaceAttempt: 0,
    });

    expect(latch.eligibleForBootReattempt).toBe(false);
    expect(isBootReattemptEligibleLatch(`${legacyLatchText()}${latch.suffix}`)).toBe(false);
  });

  it("does NOT revive a row whose plugin error text forges the legacy suffix twice over", () => {
    // Same fail-safe as the forged new-format suffix: a plugin embedding the
    // legacy text in its own message buys one re-attempt, not a fixed point,
    // because the real suffix is appended after the message.
    const latch = classifyActivationLatch({
      err: new Error(`plugin config invalid (after 9 transient and 9 sdk-install-race retries)`),
      transientAttempt: 0,
      sdkRaceAttempt: 0,
    });

    expect(
      isBootReattemptEligibleLatch(
        `Activation failed: plugin config invalid ` +
          `(after 9 transient and 9 sdk-install-race retries)${latch.suffix}`,
      ),
    ).toBe(false);
  });
});

/** The exact `lastError` an exhausted transient activation writes. */
function transientLatchText(attempts = 2): string {
  return (
    `Activation failed: Worker initialize failed for "fixture": ` +
    `RPC call "initialize" timed out after 60000ms ` +
    `(${TRANSIENT_RETRY_EXHAUSTED_MARKER}: ${attempts} transient and 0 sdk-install-race retries spent)`
  );
}

/** The exact `lastError` an exhausted SDK-install-race activation writes. */
function sdkRaceLatchText(attempts = 5): string {
  return (
    `Activation failed: ERR_MODULE_NOT_FOUND: Cannot find package ` +
    `'@paperclipai/plugin-sdk' imported from worker.js ` +
    `(${SDK_INSTALL_RACE_RETRY_EXHAUSTED_MARKER}: 0 transient and ${attempts} sdk-install-race retries spent)`
  );
}

/**
 * The `lastError` a plugin that threw from its own `initialize` writes.
 *
 * Derived from the writer rather than hand-copied. The hand-copied version
 * drifted silently — it read `retries;` while `classifyActivationLatch` wrote
 * `retries spent;` — and every server shard stayed green, because this text is
 * only ever asserted against a row that was *seeded* with it, so the assertion
 * compared the seeded value with itself. Composing it the way the loader does
 * (`Activation failed: ${message}${suffix}`) makes that drift impossible.
 */
const FAILED_CLOSED_LATCH_TEXT =
  `Activation failed: ${FAILED_CLOSED_ERROR.message}` +
  classifyActivationLatch({
    err: FAILED_CLOSED_ERROR,
    transientAttempt: 0,
    sdkRaceAttempt: 0,
  }).suffix;

/**
 * The `lastError` the *previous* release wrote for a contention latch — the
 * format every row latched by the currently-deployed build still carries.
 *
 * Copied verbatim from that release rather than derived, deliberately: it is a
 * frozen on-disk format this build must keep reading, so a helper that tracked
 * the current writer would stop testing the thing that matters the moment the
 * writer changed again.
 */
function legacyLatchText(transient = 1, sdkRace = 0): string {
  return (
    `Activation failed: Worker initialize failed for "fixture": ` +
    `RPC call "initialize" timed out after 60000ms ` +
    `(after ${transient} transient and ${sdkRace} sdk-install-race retries)`
  );
}

/**
 * A plugin that fails closed *and* embeds the eligibility marker in its own
 * error text. The marker has to ride on the error itself, not merely on the
 * seeded row: each latch rewrites `lastError` from the current failure, so a
 * forgery present only in the seeded text is erased by the first re-latch and
 * the loop stops on its own. This error reproduces the same forged row every
 * time, which is what made the pre-fix behaviour a fixed point rather than one
 * stray revival.
 */
const FORGED_MARKER_ERROR = new Error(
  `Worker initialize failed for "fixture": plugin config invalid ` +
    `(${TRANSIENT_RETRY_EXHAUSTED_MARKER})`,
);

/** Derived from the error and the writer so the fixture cannot drift from either. */
const FORGED_MARKER_LATCH_TEXT =
  `Activation failed: ${FORGED_MARKER_ERROR.message}` +
  classifyActivationLatch({
    err: FORGED_MARKER_ERROR,
    transientAttempt: 0,
    sdkRaceAttempt: 0,
  }).suffix;

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

  function createRuntimeServices(
    options: { startWorkerFails?: boolean; startWorkerError?: Error } = {},
  ) {
    const startWorker = options.startWorkerError
      ? vi.fn().mockRejectedValue(options.startWorkerError)
      : options.startWorkerFails
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

  it("activates a plugin latched by the previous release's suffix, with no /enable call", async () => {
    // The BLO-20410 cohort — including `lucitra.plugin-secrets` — is latched in
    // this format right now. If the first boot after the rollout skips it, the
    // deploy that ships this fix rescues nothing and the manual verification on
    // the issue reads as the fix not working.
    const pluginKey = `paperclip.legacy_${randomUUID().slice(0, 8)}`;
    const { installDir, packageName, manifest } = await seedPluginDir(pluginKey);
    await insertLatchedRow(pluginKey, manifest, packageName, installDir, legacyLatchText());

    const { runtimeServices, startWorker, enable } = createRuntimeServices();
    const loader = pluginLoader(db, { localPluginDir: installDir }, runtimeServices);
    const result = await loader.loadAll();

    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(result.succeeded).toBe(1);

    const [after] = await db.select().from(plugins);
    expect(after?.status).toBe("ready");
    expect(after?.lastError).toBeNull();
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

  it("activates a plugin latched by an exhausted SDK-install-race budget", async () => {
    // Same defect as the transient case, different contention class: the plugin
    // lost a race against a concurrent @paperclipai/plugin-sdk install. By this
    // boot the install has finished, so the row must be re-attempted rather
    // than left for a human `/enable`.
    const pluginKey = `paperclip.sdkrace_${randomUUID().slice(0, 8)}`;
    const { installDir, packageName, manifest } = await seedPluginDir(pluginKey);
    await insertLatchedRow(pluginKey, manifest, packageName, installDir, sdkRaceLatchText());

    const { runtimeServices, startWorker, enable } = createRuntimeServices();
    const loader = pluginLoader(db, { localPluginDir: installDir }, runtimeServices);
    const result = await loader.loadAll();

    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(result.succeeded).toBe(1);

    const [after] = await db.select().from(plugins);
    expect(after?.status).toBe("ready");
    expect(after?.lastError).toBeNull();
    expect(enable).not.toHaveBeenCalled();
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

  it("NEGATIVE CONTROL: a plugin cannot forge its own eligibility and retry forever", async () => {
    const pluginKey = `paperclip.forged_${randomUUID().slice(0, 8)}`;
    const { installDir, packageName, manifest } = await seedPluginDir(pluginKey);
    await insertLatchedRow(pluginKey, manifest, packageName, installDir, FORGED_MARKER_LATCH_TEXT);

    // Several boots, because the defect this guards was a *fixed point* rather
    // than one wrong revival. The plugin fails closed every time, so the latch
    // stays ineligible and the re-attempt tag is suppressed — meaning the spent
    // count read back as 0 on every boot and the budget could never converge.
    // The row was re-attempted on every boot forever and the `spent >= limit`
    // "this is no longer contention" warning never fired. A single boot would
    // not distinguish that from a row on its first legitimate re-attempt, so
    // the loop and the unchanged-`lastError` assertion are both load-bearing.
    for (let boot = 1; boot <= 3; boot += 1) {
      const { runtimeServices, startWorker } = createRuntimeServices({
        startWorkerError: FORGED_MARKER_ERROR,
      });
      const loader = pluginLoader(db, { localPluginDir: installDir }, runtimeServices);
      await loader.loadAll();
      expect(startWorker, `boot ${boot} must not re-attempt a forged latch`).not.toHaveBeenCalled();

      const [row] = await db.select().from(plugins);
      // Unchanged every boot: never revived, so no re-attempt tag was written
      // and nothing re-latched over it.
      expect(row?.status).toBe("error");
      expect(row?.lastError).toBe(FORGED_MARKER_LATCH_TEXT);
    }
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
    // retries from TRANSIENT_ACTIVATION_RETRY_DELAYS_MS); boots 3 and 4 find
    // the budget spent and do not spawn at all. Pinned exactly, because the
    // interaction between the in-activation budget and the cross-boot budget is
    // the subtle part and the one most likely to regress silently.
    expect(attemptsPerBoot[0]).toBe(3);
    expect(attemptsPerBoot[1]).toBe(3);
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

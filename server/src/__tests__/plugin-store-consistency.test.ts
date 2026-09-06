import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, plugins } from "@paperclipai/db";
import {
  checkSharedDependencyConsistency,
  checkSharedDependencyConsistencyAfterRecheck,
  pluginLoader,
  SDK_NOT_INSTALLED_ERROR_MARKER,
  type PluginRuntimeServices,
} from "../services/plugin-loader.js";
import {
  ISOLATED_SDK_PLUGIN_PACKAGES,
  resolveDefaultInstallDir,
} from "../bootstrap/isolated-sdk-plugins.js";
import { BUNDLED_PLUGIN_PACKAGES } from "../bootstrap/bundled-plugin-packages.js";
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

  it("waits past the first recheck when a static mismatch settles", async () => {
    const installDir = await tempInstallDir();
    await writeLockfileVersion(installDir, SDK_PACKAGE, "2026.513.0");
    await writeInstalledPackageVersion(installDir, SDK_PACKAGE, "1.0.0");

    const settleStore = (async () => {
      await sleep(800);
      await writeInstalledPackageVersion(installDir, SDK_PACKAGE, "2026.513.0");
    })();

    const result = await checkSharedDependencyConsistencyAfterRecheck(installDir, SDK_PACKAGE);
    await settleStore;

    expect(result.consistent).toBe(true);
    expect(result.lockfileVersion).toBe("2026.513.0");
    expect(result.installedVersion).toBe("2026.513.0");
  }, 10_000);

  it("fails closed once the same mismatch stays stable past the minimum window", async () => {
    const installDir = await tempInstallDir();
    await writeLockfileVersion(installDir, SDK_PACKAGE, "2026.513.0");
    await writeInstalledPackageVersion(installDir, SDK_PACKAGE, "1.0.0");

    const startedAt = Date.now();
    const result = await checkSharedDependencyConsistencyAfterRecheck(installDir, SDK_PACKAGE);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(10_000);
    expect(elapsedMs).toBeLessThan(20_000);
    expect(result.consistent).toBe(false);
    expect(result.lockfileVersion).toBe("2026.513.0");
    expect(result.installedVersion).toBe("1.0.0");
  }, 25_000);

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

  it("fails closed when a path component blocks the installed package directory", async () => {
    const installDir = await tempInstallDir();
    await writeLockfileVersion(installDir, SDK_PACKAGE, "2026.513.0");
    const scopeDir = path.join(installDir, "node_modules", "@paperclipai");
    await mkdir(scopeDir, { recursive: true });
    await writeFile(path.join(scopeDir, "plugin-sdk"), "not a directory", "utf8");

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

  it("fails closed when the SDK is neither recorded nor installed — an empty tree, not a version disagreement", async () => {
    // The one absence that is NOT congruent (BLO-31857). Nothing recorded and
    // nothing installed means there is no tree for a worker to import the SDK
    // from, and — unlike the two single-sided absences pinned above — no other
    // mechanism covers it. A guard that called this congruent would let a boot
    // fixture that sets up nothing at all pass while asserting nothing.
    const installDir = await tempInstallDir();

    const result = await checkSharedDependencyConsistency(installDir, SDK_PACKAGE);

    expect(result).toEqual({
      packageName: SDK_PACKAGE,
      lockfileVersion: null,
      installedVersion: null,
      lockfileState: "missing",
      installedState: "missing",
      consistent: false,
      problem: "not_installed",
      diagnostic: null,
    });
  });

  it("reports not_installed distinctly from the two pre-existing problem classes", async () => {
    // The AC asks for a *distinct* problem value: a caller (or an operator
    // reading lastError) must be able to tell "nothing is installed" apart
    // from "two versions disagree", because the remedies differ — install vs
    // reconcile. Assert all three in one place so a future collapse of the
    // union into a single value fails here.
    const emptyDir = await tempInstallDir();

    const tornDir = await tempInstallDir();
    await writeLockfileVersion(tornDir, SDK_PACKAGE, "2026.513.0");
    await writeInstalledPackageVersion(tornDir, SDK_PACKAGE, "1.0.0");

    const invalidDir = await tempInstallDir();
    await writeFile(path.join(invalidDir, "package-lock.json"), "{", "utf8");
    await writeInstalledPackageVersion(invalidDir, SDK_PACKAGE, "1.0.0");

    const problems = await Promise.all(
      [emptyDir, tornDir, invalidDir].map(async (dir) =>
        (await checkSharedDependencyConsistency(dir, SDK_PACKAGE)).problem,
      ),
    );

    expect(problems).toEqual(["not_installed", "version_mismatch", "metadata_invalid"]);
    expect(new Set(problems).size).toBe(3);
  });
});

describe("BLO-31857: the healthy isolated-tree shape must stay congruent (outage guard)", () => {
  // Every test here pins `(lock absent)/(installed ok)` as CONGRUENT. That is
  // not a tolerance for sloppiness — it is the measured, healthy steady state
  // of all three isolated install dirs on the live PVC (2026-09-04):
  //
  //   plugins-isolated/lucitra__paperclip-plugin-secrets/package-lock.json
  //       -> 0 entries matching plugin-sdk           (lockfileState "missing")
  //   plugins-isolated/lucitra__paperclip-plugin-secrets/node_modules/
  //     @paperclipai/plugin-sdk -> 2026.817.0        (installedState "ok")
  //
  // A peer-dependency-only plugin declares no direct dependency, so npm has
  // nothing to record in the lockfile while still installing the peer. Because
  // `activatePlugin` throws on `!sdkConsistency.consistent` *before* spawning a
  // worker, a tightening that required both metadata sources to be present
  // would fail activation for `@lucitra/paperclip-plugin-secrets`,
  // `@lucitra/paperclip-plugin-chat` and `@penstock/paperclip-plugin`
  // simultaneously. A working tree that did exactly that is preserved unmerged
  // at `cto/blo-28656-isolated-sdk-proposed`. If a future change makes these
  // tests fail, the change is the outage — not the tests.
  const cleanupPaths = new Set<string>();

  afterEach(async () => {
    for (const cleanupPath of cleanupPaths) {
      await rm(cleanupPath, { recursive: true, force: true });
    }
    cleanupPaths.clear();
  });

  async function tempInstallDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-isolated-tree-"));
    cleanupPaths.add(dir);
    return dir;
  }

  /**
   * A package-lock.json that genuinely exists and resolves other packages but
   * carries no entry for `omittedPackage`. This is the live shape, and it is
   * NOT the same input as "no lockfile at all" (covered separately above) even
   * though both yield `lockfileState: "missing"` — production has a lockfile.
   */
  async function writeLockfileOmitting(installDir: string, omittedPackage: string): Promise<void> {
    await writeFile(
      path.join(installDir, "package-lock.json"),
      JSON.stringify(
        {
          name: "paperclip-plugins",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": { name: "paperclip-plugins" },
            "node_modules/zod": { version: "3.23.8" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const raw = await readFile(path.join(installDir, "package-lock.json"), "utf8");
    // Guard the fixture itself: if a future edit accidentally reintroduces the
    // package, these tests would silently stop covering the absent-lock shape.
    expect(raw).not.toContain(omittedPackage);
  }

  /**
   * The `@lucitra/paperclip-plugin-secrets` manifest shape: the SDK is a peer
   * dependency with no direct `dependencies` entry, which is *why* npm records
   * nothing for it in the install dir's lockfile.
   */
  async function writePeerDependencyOnlyPlugin(installDir: string, packageName: string): Promise<void> {
    const packageDir = path.join(installDir, "node_modules", ...packageName.split("/"));
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify(
        {
          name: packageName,
          version: "0.4.2",
          type: "module",
          peerDependencies: { [SDK_PACKAGE]: ">=1.0.0" },
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  it("accepts a PEER-DEPENDENCY-ONLY plugin whose lockfile records no SDK while the SDK is installed (the lucitra.plugin-secrets shape)", async () => {
    const installDir = await tempInstallDir();
    const packageName = "@lucitra/paperclip-plugin-secrets";
    expect(ISOLATED_SDK_PLUGIN_PACKAGES).toContain(packageName);

    await writePeerDependencyOnlyPlugin(installDir, packageName);
    await writeLockfileOmitting(installDir, "plugin-sdk");
    await writeInstalledPackageVersion(installDir, SDK_PACKAGE, "2026.817.0");

    const result = await checkSharedDependencyConsistency(installDir, SDK_PACKAGE);

    expect(result).toEqual({
      packageName: SDK_PACKAGE,
      lockfileVersion: null,
      installedVersion: "2026.817.0",
      lockfileState: "missing",
      installedState: "ok",
      consistent: true,
      problem: null,
      diagnostic: null,
    });
  });

  it("accepts an OPERATOR-INSTALLED, NON-BUNDLED plugin in the same shape (the paperclip-plugin-hindsight shape)", async () => {
    const installDir = await tempInstallDir();
    const packageName = "paperclip-plugin-hindsight";
    // hindsight opts into the isolation *mechanism* but is deliberately absent
    // from BUNDLED_PLUGIN_PACKAGES — it is installed by an operator, never
    // auto-installed on boot. It must be covered explicitly: a fixture built
    // only from bundled rows would not exercise this row at all.
    expect(ISOLATED_SDK_PLUGIN_PACKAGES).toContain(packageName);
    expect(BUNDLED_PLUGIN_PACKAGES).not.toContain(packageName);

    await writePeerDependencyOnlyPlugin(installDir, packageName);
    await writeLockfileOmitting(installDir, "plugin-sdk");
    await writeInstalledPackageVersion(installDir, SDK_PACKAGE, "2026.817.0");

    const result = await checkSharedDependencyConsistency(installDir, SDK_PACKAGE);

    expect(result.consistent).toBe(true);
    expect(result.problem).toBeNull();
    expect(result.lockfileState).toBe("missing");
    expect(result.installedState).toBe("ok");
  });

  it("stays congruent for every ISOLATED_SDK_PLUGIN_PACKAGES entry in its real install dir, so no single plugin regresses alone", async () => {
    // The proposed-but-unmerged tightening broke all three isolated plugins at
    // once. Sweep the whole list rather than one representative, so a partial
    // regression cannot hide behind a passing single-package test.
    const sharedDir = await tempInstallDir();

    for (const packageName of ISOLATED_SDK_PLUGIN_PACKAGES) {
      const isolatedDir = resolveDefaultInstallDir(packageName, sharedDir);
      cleanupPaths.add(isolatedDir);
      await mkdir(isolatedDir, { recursive: true });
      await writePeerDependencyOnlyPlugin(isolatedDir, packageName);
      await writeLockfileOmitting(isolatedDir, "plugin-sdk");
      await writeInstalledPackageVersion(isolatedDir, SDK_PACKAGE, "2026.817.0");

      const result = await checkSharedDependencyConsistency(isolatedDir, SDK_PACKAGE);
      expect(result.consistent, `${packageName} must remain congruent`).toBe(true);
      expect(result.problem, `${packageName} must report no problem`).toBeNull();
    }
  });

  it("still rejects that same tree once the installed SDK is removed, so the acceptance above is not blanket permissiveness", async () => {
    // The discriminating case: identical peer-dependency-only manifest and
    // identical SDK-less lockfile, differing only in whether the SDK is
    // physically installed. Congruent with it, rejected without it.
    const installDir = await tempInstallDir();
    const packageName = "@lucitra/paperclip-plugin-secrets";
    await writePeerDependencyOnlyPlugin(installDir, packageName);
    await writeLockfileOmitting(installDir, "plugin-sdk");

    const withoutSdk = await checkSharedDependencyConsistency(installDir, SDK_PACKAGE);
    expect(withoutSdk.consistent).toBe(false);
    expect(withoutSdk.problem).toBe("not_installed");

    await writeInstalledPackageVersion(installDir, SDK_PACKAGE, "2026.817.0");
    const withSdk = await checkSharedDependencyConsistency(installDir, SDK_PACKAGE);
    expect(withSdk.consistent).toBe(true);
    expect(withSdk.problem).toBeNull();
  });

  it("does not stall the recheck path on the healthy shape — a congruent first read returns without sleeping", async () => {
    // `checkSharedDependencyConsistencyAfterRecheck` only sleeps on a problem.
    // If the healthy shape were ever classified as a problem, activation for
    // all three isolated plugins would pay the full ~28s recheck budget on
    // every boot before failing. Assert the fast path directly, since a
    // wall-clock regression here is the cheap early warning for that.
    const installDir = await tempInstallDir();
    await writeLockfileOmitting(installDir, "plugin-sdk");
    await writeInstalledPackageVersion(installDir, SDK_PACKAGE, "2026.817.0");

    const startedAt = Date.now();
    const result = await checkSharedDependencyConsistencyAfterRecheck(installDir, SDK_PACKAGE);
    const elapsedMs = Date.now() - startedAt;

    expect(result.consistent).toBe(true);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("lets a transient boot-install (absent)/(absent) settle instead of failing closed immediately", async () => {
    // `(absent)/(absent)` is a real transient state during the concurrent boot
    // npm install that SDK_INSTALL_RACE_RETRY_DELAYS_MS was built for. Making
    // it a hard problem is only safe because the recheck path returns as soon
    // as the SDK lands. Without this, rejecting the shape would convert a
    // self-healing boot race into a latched plugin error.
    const installDir = await tempInstallDir();

    const settleStore = (async () => {
      await sleep(800);
      await writeInstalledPackageVersion(installDir, SDK_PACKAGE, "2026.817.0");
    })();

    const result = await checkSharedDependencyConsistencyAfterRecheck(installDir, SDK_PACKAGE);
    await settleStore;

    expect(result.consistent).toBe(true);
    expect(result.installedVersion).toBe("2026.817.0");
    expect(result.problem).toBeNull();
  }, 15_000);
});

describe("BLO-20961: installDir isolation survives a re-torn shared store across boots", () => {
  const cleanupPaths = new Set<string>();

  afterEach(async () => {
    for (const cleanupPath of cleanupPaths) {
      await rm(cleanupPath, { recursive: true, force: true });
    }
    cleanupPaths.clear();
  });

  async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupPaths.add(dir);
    return dir;
  }

  it("resolves every ISOLATED_SDK_PLUGIN_PACKAGES entry outside the shared store, and leaves everything else in it", async () => {
    const sharedDir = await tempDir("paperclip-shared-");

    for (const pkg of ISOLATED_SDK_PLUGIN_PACKAGES) {
      const resolved = resolveDefaultInstallDir(pkg, sharedDir);
      expect(resolved).not.toBe(sharedDir);
      expect(path.relative(sharedDir, resolved).startsWith("..")).toBe(true);
    }

    expect(resolveDefaultInstallDir("@paperclipai/some-other-plugin", sharedDir)).toBe(sharedDir);
    expect(resolveDefaultInstallDir(undefined, sharedDir)).toBe(sharedDir);
  });

  it("an isolated plugin's SDK install stays congruent when boot 2 re-tears only the shared store — the exact BLO-18384/BLO-20961 recurrence", async () => {
    // Boot 1: both the shared store and an isolated plugin's own install
    // start out correctly reconciled (mirrors the "reconciled after the
    // first boot" precondition from the BLO-20961 acceptance criteria).
    const sharedDir = await tempDir("paperclip-shared-");
    const isolatedDir = resolveDefaultInstallDir(ISOLATED_SDK_PLUGIN_PACKAGES[0], sharedDir);
    await mkdir(isolatedDir, { recursive: true });

    await writeLockfileVersion(sharedDir, SDK_PACKAGE, "2026.513.0");
    await writeInstalledPackageVersion(sharedDir, SDK_PACKAGE, "2026.513.0");
    await writeLockfileVersion(isolatedDir, SDK_PACKAGE, "2026.513.0");
    await writeInstalledPackageVersion(isolatedDir, SDK_PACKAGE, "2026.513.0");

    const bootOneShared = await checkSharedDependencyConsistency(sharedDir, SDK_PACKAGE);
    const bootOneIsolated = await checkSharedDependencyConsistency(isolatedDir, SDK_PACKAGE);
    expect(bootOneShared.consistent).toBe(true);
    expect(bootOneIsolated.consistent).toBe(true);

    // Boot 2: simulate the SHARED store being torn — node_modules moved to a
    // version its package-lock.json does not record. Until 2026-09-01 the
    // boot-time fork-vendor copy in index.ts did this on every restart (the
    // live recurrences on 2026-08-01/02/04); that copy is gone now the store
    // resolves the fork via an npm alias, but the shared tree still has
    // uncoordinated writers, so the isolation guarantee below still matters.
    await writeInstalledPackageVersion(sharedDir, SDK_PACKAGE, "1.0.0");

    const bootTwoShared = await checkSharedDependencyConsistency(sharedDir, SDK_PACKAGE);
    const bootTwoIsolated = await checkSharedDependencyConsistency(isolatedDir, SDK_PACKAGE);

    // The shared store re-tears just like before this fix — expected, and
    // orthogonal: nothing still sharing that store is exempted by this fix.
    expect(bootTwoShared.consistent).toBe(false);
    // What must hold: the isolated plugin's own install is untouched by the
    // second boot's fork-copy and remains exactly as it was after boot 1.
    expect(bootTwoIsolated).toEqual(bootOneIsolated);
    expect(bootTwoIsolated.consistent).toBe(true);
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

  it("waits past the first activation-time recheck when a static shared SDK mismatch is still reconciling", async () => {
    const fixture = await createFixturePluginPackage();
    const installDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-store-"));
    cleanupPaths.add(installDir);
    await writeLockfileVersion(installDir, SDK_PACKAGE, "2026.513.0");
    await writeInstalledPackageVersion(installDir, SDK_PACKAGE, "1.0.0");

    const settleStore = (async () => {
      await sleep(800);
      await writeInstalledPackageVersion(installDir, SDK_PACKAGE, "2026.513.0");
    })();
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
    // an opaque timeout. The consistency guard now gives a stable mismatch a
    // meaningful reconciliation window, but must still fail far below the
    // worker initialize timeout.
    expect(elapsedMs).toBeLessThan(30_000);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Torn plugin store detected/);
    expect(result.error).toContain(SDK_PACKAGE);
    expect(result.error).toContain("2026.513.0");
    expect(result.error).toContain("1.0.0");

    expect(startWorker).not.toHaveBeenCalled();
    expect(markError).toHaveBeenCalledTimes(1);
    expect(markError).toHaveBeenCalledWith(installedRow.id, expect.stringContaining("Torn plugin store detected"));
  }, 35_000);

  it("BLO-20961: activates an isolated third-party plugin across a second boot that re-tears only the shared store", async () => {
    const fixture = await createFixturePluginPackage();
    const sharedDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-store-"));
    cleanupPaths.add(sharedDir);
    const isolatedDir = resolveDefaultInstallDir(ISOLATED_SDK_PLUGIN_PACKAGES[0], sharedDir);
    cleanupPaths.add(isolatedDir);
    await mkdir(isolatedDir, { recursive: true });

    // Boot 1: both the shared store and this plugin's own (isolated) install
    // start out correctly reconciled.
    await writeLockfileVersion(sharedDir, SDK_PACKAGE, "2026.513.0");
    await writeInstalledPackageVersion(sharedDir, SDK_PACKAGE, "2026.513.0");
    await writeLockfileVersion(isolatedDir, SDK_PACKAGE, "2026.513.0");
    await writeInstalledPackageVersion(isolatedDir, SDK_PACKAGE, "2026.513.0");

    const [plugin] = await db
      .insert(plugins)
      .values({
        pluginKey: fixture.manifest.id,
        packageName: ISOLATED_SDK_PLUGIN_PACKAGES[0],
        version: fixture.manifest.version,
        apiVersion: fixture.manifest.apiVersion,
        categories: fixture.manifest.categories as never,
        manifestJson: fixture.manifest as never,
        status: "ready",
        packagePath: fixture.packageRoot,
        installDir: isolatedDir,
      })
      .returning();
    if (!plugin) throw new Error("fixture plugin row not inserted");

    // Boot 2: simulate the SHARED store being torn — the recurrence shape from
    // BLO-18384/BLO-18405, which the boot-time fork-vendor copy used to cause
    // on every restart. That copy is gone as of 2026-09-01, but a torn shared
    // store is still reachable via other writers, and it must never reach this
    // plugin's isolated install dir.
    await writeInstalledPackageVersion(sharedDir, SDK_PACKAGE, "1.0.0");

    const { runtimeServices, startWorker, markError } = createRuntimeServices();
    const loader = pluginLoader(db, { localPluginDir: sharedDir }, runtimeServices);
    const result = await loader.loadSingle(plugin.id);

    expect(result.success).toBe(true);
    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(markError).not.toHaveBeenCalled();
  }, 20_000);

  it("BLO-31857: ACTIVATES a peer-dependency-only isolated plugin whose lockfile records no SDK — the live production shape", async () => {
    // This is the end-to-end form of the outage guard. The unit tests above
    // pin the predicate; this pins the thing that actually breaks, because
    // `activatePlugin` throws on `!consistent` before spawning a worker. If a
    // future tightening requires both metadata sources to be present, THIS is
    // the test that fails, and its failure means the three isolated plugins in
    // production stop activating.
    const fixture = await createFixturePluginPackage();
    const sharedDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-store-"));
    cleanupPaths.add(sharedDir);
    const isolatedDir = resolveDefaultInstallDir(ISOLATED_SDK_PLUGIN_PACKAGES[0], sharedDir);
    cleanupPaths.add(isolatedDir);
    await mkdir(isolatedDir, { recursive: true });

    // A real lockfile that resolves other packages but records nothing for the
    // SDK, because it is a peer dependency — plus the SDK physically installed.
    await writeFile(
      path.join(isolatedDir, "package-lock.json"),
      JSON.stringify({
        name: "paperclip-plugins",
        lockfileVersion: 3,
        packages: { "": { name: "paperclip-plugins" }, "node_modules/zod": { version: "3.23.8" } },
      }),
      "utf8",
    );
    await writeInstalledPackageVersion(isolatedDir, SDK_PACKAGE, "2026.817.0");

    const [plugin] = await db
      .insert(plugins)
      .values({
        pluginKey: fixture.manifest.id,
        packageName: ISOLATED_SDK_PLUGIN_PACKAGES[0],
        version: fixture.manifest.version,
        apiVersion: fixture.manifest.apiVersion,
        categories: fixture.manifest.categories as never,
        manifestJson: fixture.manifest as never,
        status: "ready",
        packagePath: fixture.packageRoot,
        installDir: isolatedDir,
      })
      .returning();
    if (!plugin) throw new Error("fixture plugin row not inserted");

    const { runtimeServices, startWorker, markError } = createRuntimeServices();
    const loader = pluginLoader(db, { localPluginDir: sharedDir }, runtimeServices);
    const result = await loader.loadSingle(plugin.id);

    expect(result.success).toBe(true);
    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(markError).not.toHaveBeenCalled();
  }, 20_000);

  it("BLO-31857: refuses to spawn a worker when the install dir holds no SDK at all, with a message distinct from the torn-store one", async () => {
    const fixture = await createFixturePluginPackage();
    // Empty install dir: no lockfile, no node_modules. Nothing settles it, so
    // the recheck window elapses and the guard fails closed.
    const installDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-store-"));
    cleanupPaths.add(installDir);

    const { runtimeServices, startWorker, markError } = createRuntimeServices(
      vi.fn().mockImplementation(async () => {
        throw new Error("startWorker should not have been called for an empty plugin store");
      }),
    );
    const plugin = await insertReadyFixturePlugin(fixture);

    const loader = pluginLoader(db, { localPluginDir: installDir }, runtimeServices);
    const startedAt = Date.now();
    const result = await loader.loadSingle(plugin.id);
    const elapsedMs = Date.now() - startedAt;

    expect(result.success).toBe(false);
    expect(result.error).toContain(SDK_NOT_INSTALLED_ERROR_MARKER);
    // Must NOT borrow the torn-store marker: the startup isolation migration
    // un-latches rows carrying that marker, which would revive this row into
    // the same failure on the next boot instead of waiting for an install.
    expect(result.error).not.toContain("Torn plugin store detected");
    expect(startWorker).not.toHaveBeenCalled();
    expect(markError).toHaveBeenCalledTimes(1);
    // Still well under the 60s worker initialize timeout this guard exists to
    // pre-empt, while leaving the boot-install race room to settle.
    expect(elapsedMs).toBeGreaterThanOrEqual(10_000);
    expect(elapsedMs).toBeLessThan(35_000);
  }, 45_000);
});

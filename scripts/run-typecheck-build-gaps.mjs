#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";

const repoRoot = process.cwd();
const args = new Set(process.argv.slice(2));
const allowedArgs = new Set(["--runtime-assets-only"]);

for (const arg of args) {
  if (!allowedArgs.has(arg)) {
    fail(`Unknown argument: ${arg}`);
  }
}

function fail(message) {
  console.error(`[typecheck:build-gaps] ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`[typecheck:build-gaps] Failed to spawn ${command}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function formatPath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function listFilesRecursive(rootDir) {
  if (!existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const entries = readdirSync(rootDir, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(entryPath));
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function isRuntimeAsset(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return !new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]).has(ext);
}

function checkServerRuntimeAssets() {
  const runtimeAssetTrees = [
    {
      sourceDir: path.join(repoRoot, "server", "src", "built-ins"),
      distDir: path.join(repoRoot, "server", "dist", "built-ins"),
    },
    {
      sourceDir: path.join(repoRoot, "server", "src", "onboarding-assets"),
      distDir: path.join(repoRoot, "server", "dist", "onboarding-assets"),
    },
  ];
  const missingAssets = [];
  let checkedCount = 0;

  for (const assetTree of runtimeAssetTrees) {
    const sourceAssets = listFilesRecursive(assetTree.sourceDir).filter(isRuntimeAsset);
    checkedCount += sourceAssets.length;

    for (const sourcePath of sourceAssets) {
      const relativeAssetPath = path.relative(assetTree.sourceDir, sourcePath);
      const distPath = path.join(assetTree.distDir, relativeAssetPath);

      if (!existsSync(distPath) || !statSync(distPath).isFile()) {
        missingAssets.push({ sourcePath, distPath });
      }
    }
  }

  if (missingAssets.length > 0) {
    const missingList = missingAssets
      .map(
        ({ sourcePath, distPath }) =>
          `  - source: ${formatPath(sourcePath)}\n    expected dist: ${formatPath(distPath)}`,
      )
      .join("\n");

    fail(
      `Missing server runtime asset(s) in dist:\n${missingList}\nRun pnpm --filter @paperclipai/server build and ensure source runtime asset trees are copied into dist.`,
    );
  }

  console.log(
    `[typecheck:build-gaps] server runtime assets present in dist: ${checkedCount} file(s)`,
  );
}

// PEN-6723: this is the ONLY path that runs the runtime-asset guard. The root
// `build` script invokes it after `pnpm -r build`; see the note at the foot of
// this file for why it no longer runs on the default path.
if (args.has("--runtime-assets-only")) {
  checkServerRuntimeAssets();
  process.exit(0);
}

function listWorkspacePackages() {
  const result = spawnSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.error) {
    fail(`Unable to spawn pnpm to list workspace packages: ${result.error.message}`);
  }

  if (result.status !== 0) {
    fail("Unable to list pnpm workspace packages.");
  }

  return JSON.parse(result.stdout);
}

function buildSkipsTypeScript(pkg) {
  const buildScript = pkg.scripts?.build;
  if (typeof buildScript !== "string") {
    return false;
  }

  return !/\btsc\b/.test(buildScript);
}

const workspacePackages = listWorkspacePackages();
const buildGapCandidates = workspacePackages
  .filter((workspacePkg) => workspacePkg.path !== repoRoot)
  .map((workspacePkg) => ({
    name: workspacePkg.name,
    path: workspacePkg.path,
    pkg: readJson(path.join(workspacePkg.path, "package.json")),
  }))
  .filter(({ pkg }) => buildSkipsTypeScript(pkg));
const packagesMissingTypecheck = buildGapCandidates.filter(
  ({ pkg }) => typeof pkg.scripts?.typecheck !== "string",
);
if (packagesMissingTypecheck.length > 0) {
  const missingNames = packagesMissingTypecheck.map((workspacePkg) => workspacePkg.name).join(", ");
  fail(
    `Workspace packages with build scripts that skip tsc must define a typecheck script. Missing: ${missingNames}`,
  );
}
const buildGapPackages = buildGapCandidates.filter(
  ({ pkg }) => typeof pkg.scripts?.typecheck === "string",
);

console.log(
  `[typecheck:build-gaps] typechecking ${buildGapPackages.length} workspace(s): ${buildGapPackages.map(({ name }) => name).join(", ") || "(none)"}`,
);

function resolveConcurrency(packageCount) {
  const configured = process.env.TYPECHECK_BUILD_GAPS_CONCURRENCY;

  if (configured !== undefined && configured.trim() !== "") {
    const parsed = Number(configured);
    if (!Number.isInteger(parsed) || parsed < 1) {
      fail(
        `TYPECHECK_BUILD_GAPS_CONCURRENCY must be a positive integer, got ${JSON.stringify(configured)}`,
      );
    }
    return Math.min(parsed, packageCount);
  }

  const cpuCount =
    typeof os.availableParallelism === "function"
      ? os.availableParallelism()
      : (os.cpus()?.length ?? 1);

  return Math.max(1, Math.min(packageCount, cpuCount));
}

// Output is captured rather than inherited: these run concurrently, so
// interleaving them into the job log would make a tsc error unattributable to
// the workspace that raised it. Each run's buffer is printed as one block, under
// a header naming the workspace, by reportWorkspaceResult below.
function typecheckWorkspace(workspacePkg) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn("pnpm", ["--filter", workspacePkg.name, "typecheck"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));

    // `error` and `close` can both fire (a failed spawn still closes), so the
    // first one to arrive wins and the other is dropped.
    let settled = false;
    const settle = (status, extraOutput = "") => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        name: workspacePkg.name,
        status,
        durationMs: Date.now() - startedAt,
        output: Buffer.concat(chunks).toString("utf8") + extraOutput,
      });
    };

    child.on("error", (error) => {
      settle(1, `[typecheck:build-gaps] Failed to spawn pnpm: ${error.message}\n`);
    });

    child.on("close", (code, signal) => {
      settle(
        code ?? 1,
        signal ? `[typecheck:build-gaps] terminated by signal ${signal}\n` : "",
      );
    });
  });
}

// Results are written back at the item's ORIGINAL index, so `results` is in
// workspace order however the runs interleave -- which is what makes the exit
// status below deterministic.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function pump() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index]);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, pump));

  return results;
}

function reportWorkspaceResult(result) {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const verdict = result.status === 0 ? "ok" : `FAILED (exit ${result.status})`;
  const body = result.output === "" || result.output.endsWith("\n") ? result.output : `${result.output}\n`;

  process.stdout.write(
    `\n[typecheck:build-gaps] ----- ${result.name}: ${verdict} in ${seconds}s -----\n${body}`,
  );
}

if (buildGapPackages.length > 0) {
  // Hoisted deliberately, and it is what makes the concurrent section below
  // safe. ensure-plugin-build-deps.mjs returns on a LOCK-FREE fast path when
  // every output is already fresh, so once this call has run, each member's own
  // `ensure-build-deps` exits 0 without ever creating the lock directory -- the
  // 60s lock timeout is unreachable rather than merely unlikely. Two conditions
  // keep that true and are checked by nothing here: every workspace that
  // consumes plugin-sdk must call `ensure-build-deps` and NOT plugin-sdk
  // `build`, which takes no lock while writing the same dist; and no loop member
  // may EMIT (today cli and the three plugins are `tsc --noEmit`, and ui is
  // `tsc -b` over a `noEmit` project with no `references`), since an emitting
  // member could invalidate a sibling's freshness mid-flight.
  run("pnpm", ["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"]);

  const concurrency = resolveConcurrency(buildGapPackages.length);
  console.log(
    `[typecheck:build-gaps] running ${buildGapPackages.length} typecheck(s), concurrency ${concurrency}`,
  );

  const results = await runWithConcurrency(buildGapPackages, concurrency, async (workspacePkg) => {
    const result = await typecheckWorkspace(workspacePkg);
    reportWorkspaceResult(result);
    return result;
  });

  // Every member runs even once one has failed, so a single job reports every
  // broken workspace instead of only the first. The exit status is the first
  // failure in workspace order, which is what the previous serial loop exited
  // with. process.exitCode rather than process.exit() so the buffered output
  // above is flushed before the process ends.
  const failures = results.filter((result) => result.status !== 0);
  if (failures.length > 0) {
    console.error(
      `[typecheck:build-gaps] ${failures.length} of ${results.length} workspace typecheck(s) failed: ${failures
        .map(({ name }) => name)
        .join(", ")}`,
    );
    process.exitCode = failures[0].status;
  }
}

// PEN-6723: the runtime-asset guard deliberately does NOT run here any more.
// It is a presence check over server/dist, so it needs the server built -- and
// the only reason `typecheck:build-gaps` built the server at all was to satisfy
// it. That `pnpm --filter @paperclipai/server build` was a full tsc emit costing
// 253s, 16.8% of the capped `Typecheck + Release Registry` job, to assert that
// four `cp -R` commands in server's own build script had run. Nothing else in
// that lane reads server/dist: the loop filters server out (its build contains
// tsc), and every later step there is `tsc --noEmit` or `node --test` over
// scripts/.
//
// The guard now runs from the root `build` script instead, via
// `--runtime-assets-only`, where `pnpm -r build` has just produced the dist it
// inspects. COVERAGE IS UNCHANGED AND COST IS WHAT CHANGED: the producer is the
// same in both placements -- server's own `build` script emits that dist, and
// `pnpm -r build` runs that same script -- so the guard inspects bytes made by
// the same invocation either way. An earlier revision of this comment called the
// move "strictly STRONGER, not merely cheaper"; that was wrong and is WITHDRAWN.
// pr.yml's Build lane runs `pnpm build` under the identical path selector as
// this lane (`release_dry_run_needed`), so the two run and skip together and no
// diff that can reach the server build escapes the check.
//
// ⚠ Neither placement guards the image that SHIPS. The Dockerfile builds each
// package with its own `pnpm --filter <pkg> build`, ending at
// `pnpm --filter @paperclipai/server build`, and never invokes root `pnpm build`
// -- so do not read this move as extending coverage to the published image.
//
// ⚠ One speculative bound, recorded so it is not mistaken for a finding: under
// `pnpm -r build` the guard runs after EVERY package has built, so a future
// package whose build clobbered server/dist would be caught here where the old
// build-server-then-check ordering would have missed it. There is no such
// package today and no instance has been observed.

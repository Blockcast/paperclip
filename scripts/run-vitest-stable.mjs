#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadShardDurations, selectGeneralServerShard } from "./general-server-shard.mjs";
import {
  collectGeneralServerSuiteFiles,
  collectSerializedServerSuiteFiles,
} from "./run-vitest-stable-suites.mjs";

const repoRoot = process.cwd();
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const generalServerShardDurations = loadShardDurations(
  path.join(scriptsDir, "general-server-shard-durations.json"),
);
const serverRoot = path.join(repoRoot, "server");
// Every non-server project that CI must execute. This list is NOT derived from
// the root vitest.config.ts `projects` array -- it is a second, independent
// enumeration, and `--mode general` only ever runs `--project <name>` for the
// names below. A package that is added to vitest.config.ts but not here is
// therefore invisible to CI: it reports green because nothing ran it. That is
// exactly how packages/mcp-server's suites went unexecuted (BLO-20076).
// vitest-project-coverage.test.mjs holds the two lists in sync; add new
// packages to BOTH files.
const nonServerProjects = [
  "@paperclipai/shared",
  "@paperclipai/skills-catalog",
  "@paperclipai/db",
  "@paperclipai/adapter-utils",
  "@paperclipai/adapter-claude-local",
  "@paperclipai/adapter-codex-local",
  "@paperclipai/adapter-cursor-cloud",
  "@paperclipai/adapter-cursor-local",
  "@paperclipai/adapter-gemini-local",
  "@paperclipai/adapter-grok-local",
  "@paperclipai/adapter-opencode-local",
  "@paperclipai/adapter-pi-local",
  "@paperclipai/plugin-sdk",
  "@paperclipai/create-paperclip-plugin",
  // Unscoped, matching its package.json `name` -- `--project` matches the
  // package name, not the directory. Its 10 suites, including the BLO-32113
  // aggregate-fence reclaim regressions, ran in no CI lane before this.
  "paperclip-plugin-alertmanager",
  "@paperclipai/mcp-external",
  "@paperclipai/mcp-server",
  "@paperclipai/mcp-gateway",
  "@paperclipai/ui",
  "paperclipai",
];
let invocationIndex = 0;
const serializedModeName = "serialized";
const generalModeName = "general";
const allModeName = "all";
const generalServerGroupName = "general-server";
const generalWorkspacesAGroupName = "general-workspaces-a";
const generalWorkspacesBGroupName = "general-workspaces-b";
const generalWorkspacesAProjects = ["@paperclipai/ui", "paperclipai"];
const generalWorkspacesBProjects = nonServerProjects.filter((project) => !generalWorkspacesAProjects.includes(project));
const generalGroupNames = [generalServerGroupName, generalWorkspacesAGroupName, generalWorkspacesBGroupName];
const serializedServerVitestArgs = [
  "--no-file-parallelism",
  "--maxWorkers=1",
];
// Workspace projects run concurrently inside each Vitest invocation. ARC CPU
// contention can stretch otherwise healthy filesystem/process tests beyond
// Vitest's 5-second default without indicating a hang.
const arcWorkspaceVitestArgs = [
  "--testTimeout=30000",
  "--hookTimeout=60000",
];

function toServerPath(file) {
  return path.relative(serverRoot, file).split(path.sep).join("/");
}

function fail(message) {
  console.error(`[test:run] ${message}`);
  process.exit(1);
}

function readOptionValue(argv, index, argName) {
  const value = argv[index + 1];
  if (value === undefined) {
    fail(`Missing value for ${argName}`);
  }

  return value;
}

function parseNonNegativeInteger(value, argName) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 0) {
    fail(`${argName} must be a non-negative integer. Received "${value}".`);
  }

  return parsed;
}

function parsePositiveInteger(value, argName) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 1) {
    fail(`${argName} must be a positive integer. Received "${value}".`);
  }

  return parsed;
}

function parseCliOptions(argv) {
  let mode = allModeName;
  let shardIndex = null;
  let shardCount = null;
  let group = null;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }

    if (arg === "--mode") {
      mode = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length);
      continue;
    }

    if (arg === "--shard-index") {
      shardIndex = parseNonNegativeInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--shard-index=")) {
      shardIndex = parseNonNegativeInteger(arg.slice("--shard-index=".length), "--shard-index");
      continue;
    }

    if (arg === "--shard-count") {
      shardCount = parsePositiveInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--shard-count=")) {
      shardCount = parsePositiveInteger(arg.slice("--shard-count=".length), "--shard-count");
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--group") {
      group = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--group=")) {
      group = arg.slice("--group=".length);
      continue;
    }

    fail(`Unknown argument "${arg}".`);
  }

  if (!new Set([allModeName, generalModeName, serializedModeName]).has(mode)) {
    fail(`Unknown mode "${mode}". Expected one of: ${allModeName}, ${generalModeName}, ${serializedModeName}.`);
  }

  if ((shardIndex === null) !== (shardCount === null)) {
    fail("--shard-index and --shard-count must be provided together.");
  }

  const shardAllowed =
    mode === serializedModeName ||
    (mode === generalModeName && group === generalServerGroupName);
  if (!shardAllowed && shardIndex !== null) {
    fail(
      "--shard-index/--shard-count are only valid with --mode serialized or --mode general --group general-server.",
    );
  }

  if (group !== null && mode !== generalModeName) {
    fail("--group is only valid with --mode general.");
  }

  if (group !== null && !generalGroupNames.includes(group)) {
    fail(`Unknown group "${group}". Expected one of: ${generalGroupNames.join(", ")}.`);
  }

  if (shardIndex !== null) {
    if (shardIndex >= shardCount) {
      fail(`--shard-index must be less than --shard-count. Received ${shardIndex} of ${shardCount}.`);
    }
  }

  if (mode === serializedModeName) {
    return {
      mode,
      shardIndex: shardIndex ?? 0,
      shardCount: shardCount ?? 1,
      group: null,
      dryRun,
    };
  }

  return {
    mode,
    shardIndex,
    shardCount,
    group,
    dryRun,
  };
}

// Duration-aware partition of the serialized route/authz lane, mirroring the
// general-server lane. This used to be `index % shardCount` on the sorted
// path list, which packs by FILE COUNT: every shard got exactly 31-33 files
// and wildly different work. Measured on run 35789886432 (4 shards, real ARC
// job logs), per-shard test time was 892.7 / 311.4 / 1089.1 / 292.9 s --
// 3.72x on test time, 2.62x on job wall-clock. Sorted-path adjacency is what
// does it: the two heaviest suites in the lane (heartbeat-process-recovery
// 444s, issues-service 251s) are 4 apart in sort order, so modulo-4 lands
// both on the same shard. LPT over the same durations predicts 646.5 s on
// every shard. See BLO-28956.
function selectSerializedSuites(routeTests, shardIndex, shardCount) {
  const selected = new Set(
    selectGeneralServerShard(
      routeTests.map((routeTest) => routeTest.repoPath),
      shardIndex,
      shardCount,
      generalServerShardDurations,
    ),
  );
  return routeTests.filter((routeTest) => selected.has(routeTest.repoPath));
}

const PHASE_SUMMARY_HEADER = "### Vitest phase durations";

// BLO-28956: a `General tests (server N/4)` job runs TWO Vitest invocations --
// the duration-partitioned general-server shard, then the serialized
// route/authz shard -- and the only number anyone reads is the job's
// wall-clock, which blends them. That is how the serialized phase sat at a
// 2.6x imbalance for months behind a job total that looked fine. One row per
// invocation in the job summary makes each phase legible without opening a
// 370k-line log, so a regression in one cannot hide inside the other.
//
// Emitted on failure too: the phase that just blew the timeout budget is
// exactly the one whose duration you want recorded.
function recordPhaseDuration(label, startedAt, status) {
  const seconds = (Date.now() - startedAt) / 1000;
  console.log(`[test:run] phase ${status}: ${label} in ${seconds.toFixed(1)}s`);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  try {
    // The two phases of a server shard job are two separate STEPS, so this
    // runs in two separate processes appending to the same summary file --
    // `invocationIndex` cannot tell you whether the header is already there.
    // Ask the file.
    const existing = existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "";
    const header = existing.includes(PHASE_SUMMARY_HEADER)
      ? ""
      : `${PHASE_SUMMARY_HEADER}\n\n| phase | seconds | result |\n| --- | --: | --- |\n`;
    appendFileSync(summaryPath, `${header}| \`${label}\` | ${seconds.toFixed(1)} | ${status} |\n`);
  } catch (error) {
    // The job summary is diagnostics. Never fail a test lane over it.
    console.warn(`[test:run] could not write the job summary: ${error.message}`);
  }
}

function runVitest(args, label) {
  console.log(`\n[test:run] ${label}`);
  invocationIndex += 1;
  const tempRootParent = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const testRoot = mkdtempSync(path.join(tempRootParent, `pcvt-${process.pid}-${invocationIndex}-`));
  // Keep per-run paths compact so Unix socket fixtures stay under macOS path limits.
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PAPERCLIP_HOME: path.join(testRoot, "h"),
    PAPERCLIP_INSTANCE_ID: `vt-${process.pid}-${invocationIndex}`,
    TMPDIR: path.join(testRoot, "t"),
  };
  mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  const startedAt = Date.now();
  const result = spawnSync("pnpm", ["exec", "vitest", "run", ...args], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    recordPhaseDuration(label, startedAt, "start-failed");
    console.error(`[test:run] Failed to start Vitest: ${result.error.message}`);
    process.exit(1);
  }
  recordPhaseDuration(label, startedAt, result.status === 0 ? "passed" : "failed");
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runGeneralSuites(routeTests) {
  for (const groupName of generalGroupNames) {
    runGeneralGroup(routeTests, groupName);
  }
}

function runProjectGroup(projects, groupName, extraArgs = []) {
  for (const project of projects) {
    runVitest(["--project", project, ...extraArgs], `${groupName} project ${project}`);
  }
}

function runGeneralGroup(routeTests, groupName, shardIndex = null, shardCount = null) {
  if (groupName === generalServerGroupName) {
    if (shardCount !== null && shardCount > 1) {
      const shardFiles = selectGeneralServerShard(
        generalServerTestFiles,
        shardIndex,
        shardCount,
        generalServerShardDurations,
      );
      console.log(
        `\n[test:run] general-server shard ${shardIndex + 1}/${shardCount} running ${shardFiles.length} of ${generalServerTestFiles.length} suites`,
      );
      if (shardFiles.length === 0) {
        return;
      }

      runVitest(
        [
          "--project",
          "@paperclipai/server",
          ...serializedServerVitestArgs,
          ...shardFiles,
        ],
        `${groupName} shard ${shardIndex + 1}/${shardCount}`,
      );
      return;
    }

    const excludeRouteArgs = routeTests.flatMap((file) => ["--exclude", file.serverPath]);
    runVitest(
      [
        "--project",
        "@paperclipai/server",
        ...serializedServerVitestArgs,
        ...excludeRouteArgs,
      ],
      `${groupName} server suites excluding ${routeTests.length} serialized suites`,
    );
    return;
  }

  if (groupName === generalWorkspacesAGroupName) {
    runProjectGroup(["@paperclipai/ui"], groupName);
    // The CLI project has several embedded-Postgres suites. Starting those
    // files concurrently on a single ARC runner makes initialization contend
    // heavily and turns otherwise sub-minute tests into timeout flakes.
    runVitest(
      ["--project", "paperclipai", ...serializedServerVitestArgs],
      `${groupName} project paperclipai`,
    );
    return;
  }

  if (groupName === generalWorkspacesBGroupName) {
    runProjectGroup(generalWorkspacesBProjects, groupName, arcWorkspaceVitestArgs);
    return;
  }

  fail(`Unknown group "${groupName}".`);
}

function runSerializedSuites(routeTests, shardIndex, shardCount) {
  const shardTests = selectSerializedSuites(routeTests, shardIndex, shardCount);
  console.log(
    `\n[test:run] serialized shard ${shardIndex + 1}/${shardCount} running ${shardTests.length} of ${routeTests.length} suites`,
  );
  if (shardTests.length === 0) {
    return;
  }

  // Run the whole shard in ONE Vitest invocation instead of one process per
  // file. The dominant serialized-lane cost was never the per-test transform —
  // it was forking a fresh process + cold dep-optimize + cold-importing the
  // route graph PER FILE, paid fresh every file, which ARC contention balloons
  // into the timeout flake. Batching reuses the shared main-process transform/
  // dep-optimize cache across files while --isolate still runs each FILE in its
  // own fork (no cross-file module leak — verified on a 12-file shard under
  // --sequence.shuffle, and a full 31-file shard: 242/242, ~0.7GB peak RSS on
  // the orchestrator, well under the runner limit). Measured: a 6-file sample
  // dropped ~177s -> ~88s (~2x) and a full 31-file shard runs batched in one
  // pass, with zero source changes. --retry=1 is a thin permanent margin (not
  // the old crutch): batching removed the per-file cold-start that ARC
  // contention ballooned, confirmed by two clean 4/4 batched runs (the #765 PR
  // CI and the 6b8e9572 master canary), so one retry absorbs a rare contention
  // spike without masking a real regression (timeouts only). (BLO-17053)
  runVitest(
    [
      "--project",
      "@paperclipai/server",
      ...shardTests.map((routeTest) => routeTest.repoPath),
      "--no-file-parallelism",
      "--maxWorkers=1",
      "--pool=forks",
      "--isolate",
      "--retry=1",
    ],
    `serialized shard ${shardIndex + 1}/${shardCount} (${shardTests.length} suites, batched)`,
  );
}

// Note this enumerates the whole server/src tree, not just server/src/__tests__
// as it used to. The two sets are identical today; they differ the moment
// someone colocates a `*-routes.test.ts` next to its route module, which the
// old walk dropped from the serialized lane while isRouteOrAuthzTest kept it
// out of the general-server one -- i.e. a suite that ran nowhere (BLO-28956).
const routeTests = collectSerializedServerSuiteFiles(repoRoot).map((repoPath) => ({
  repoPath,
  serverPath: toServerPath(path.join(repoRoot, repoPath)),
}));

// Every server test file that the general-server group is responsible for,
// i.e. the whole server project minus the route/authz suites that run in the
// dedicated serialized shards. Sharding this list across runners is what keeps
// the general-server lane from becoming the PR critical path: the server vitest
// config pins maxWorkers to 1, so the only way to parallelize is across jobs.
// Suites are partitioned by recorded duration (scripts/general-server-shard.mjs)
// rather than round-robin, so one slow suite cluster can't stretch a single shard.
const generalServerTestFiles = collectGeneralServerSuiteFiles(repoRoot);

const options = parseCliOptions(process.argv.slice(2));
if (options.dryRun) {
  const serializedSuites =
    options.mode === serializedModeName
      ? selectSerializedSuites(routeTests, options.shardIndex, options.shardCount)
      : routeTests;
  const dryRunPayload = JSON.stringify(
    {
      mode: options.mode,
      shardIndex: options.shardIndex,
      shardCount: options.shardCount,
      group: options.group,
      availableGeneralGroups: generalGroupNames,
      nonServerProjects,
      generalWorkspacesAProjects,
      generalWorkspacesBProjects,
      generalWorkspacesBVitestArgs: arcWorkspaceVitestArgs,
      serializedSuiteCount: routeTests.length,
      selectedSerializedSuites: serializedSuites.map((routeTest) => routeTest.repoPath),
      generalServerSuiteCount: generalServerTestFiles.length,
      selectedGeneralServerSuites:
        options.mode === generalModeName &&
        options.group === generalServerGroupName &&
        options.shardCount !== null
          ? selectGeneralServerShard(
              generalServerTestFiles,
              options.shardIndex,
              options.shardCount,
              generalServerShardDurations,
            )
          : null,
    },
    null,
    2,
  );
  // This payload is consumed through a pipe by policy tests and by other
  // tooling. `console.log` followed by `process.exit` can leave the pipe's
  // final chunk unwritten once the suite list grows beyond the stream buffer.
  // A synchronous write makes the machine-readable dry-run contract complete.
  writeSync(1, `${dryRunPayload}\n`);
  process.exit(0);
}

if (options.mode === generalModeName || options.mode === allModeName) {
  if (options.group) {
    runGeneralGroup(routeTests, options.group, options.shardIndex, options.shardCount);
  } else {
    runGeneralSuites(routeTests);
  }
}

if (options.mode === serializedModeName || options.mode === allModeName) {
  runSerializedSuites(routeTests, options.shardIndex ?? 0, options.shardCount ?? 1);
}

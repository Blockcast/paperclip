#!/usr/bin/env node
/**
 * measure-general-server-shard-durations.mjs
 *
 * Measures real per-suite Vitest test-execution durations for the
 * general-server lane and folds them into
 * scripts/general-server-shard-durations.json.
 *
 * These are the JSON reporter's per-file testResults[].startTime->endTime
 * spans, NOT full wall-clock: they exclude each file's transform/setup/import
 * cost, which is why a trivial suite can read as single-digit ms. See the
 * manifest's own "$notes" key for why that does not skew the partition.
 *
 * This is the "one-line fix" scripts/check-shard-manifest-freshness.mjs
 * points at, and the executor .github/workflows/refresh-shard-manifest.yml
 * runs on a schedule so refreshing the manifest does not depend on a human
 * noticing drift (BLO-24241).
 *
 * Usage:
 *   node scripts/measure-general-server-shard-durations.mjs [--update] [--all]
 *     [--shard-index N --shard-count M] [--output <path>]
 *
 *   --update        Write the measured durations into the manifest on disk
 *                    (default: print the measured-only JSON to stdout so a
 *                    caller — e.g. a CI job merging several shards — can
 *                    combine results before writing).
 *   --all           Re-measure every general-server suite instead of only
 *                    the ones currently missing from the manifest.
 *   --shard-index/--shard-count
 *                    Measure only this slice of the target file list, so a
 *                    full-manifest refresh can be split across parallel CI
 *                    jobs the same way the real test lane is.
 *   --output <path> Also write the measured-only durations to this path as
 *                    JSON (used to hand results between CI jobs).
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadShardDurations } from "./general-server-shard.mjs";
import { collectGeneralServerSuiteFiles } from "./run-vitest-stable-suites.mjs";

const MEASURE_VITEST_ARGS = ["--no-file-parallelism", "--maxWorkers=1"];

export function selectTargetFiles({ allFiles, durations, all, shardIndex, shardCount }) {
  const base = all ? allFiles : allFiles.filter((file) => durations[file] === undefined);
  const target = [...base].sort((a, b) => a.localeCompare(b));
  if (shardIndex === null || shardCount === null) {
    return target;
  }
  return target.filter((_, index) => index % shardCount === shardIndex);
}

// Parses a Vitest --reporter=json report into { repoPath: ms }. Vitest test
// file `name` fields are absolute paths, so they are rebased onto repoRoot to
// match the manifest's repo-relative keys.
//
// An entry only counts as a measurement if the file actually ran tests.
// Vitest derives a test FILE's status by folding its tests' results, so a file
// that threw during collection -- import error, bad top-level await -- has no
// tests to fold: it comes back with an empty `assertionResults` and an
// endTime - startTime of roughly 0, and (because nothing failed) often a
// `passed` status. measureFiles deliberately tolerates a non-zero vitest exit
// so that ordinary test failures still yield real timings, which means without
// this guard that 0 is indistinguishable from a genuinely fast suite and is
// written to the manifest as one -- handing what may be the heaviest suite in
// the lane a near-zero partition weight until the next weekly --all pass.
//
// Skipping is the safe direction rather than recording a 0: mergeManifest
// keeps the suite's previous duration, and a suite that never had one stays
// absent and keeps the median default, which check-shard-manifest-freshness
// then reports by name. Note the conditions are written to skip only on
// positive evidence of a non-run -- an absent `assertionResults` or `status`
// (reporter shape drift) keeps the entry, because a guard that could silently
// empty the manifest would be worse than the bug it closes.
export function parseVitestJsonReport(reportText, repoRoot) {
  const report = JSON.parse(reportText);
  const measured = {};
  for (const testFile of report.testResults ?? []) {
    const repoPath = path.relative(repoRoot, testFile.name).split(path.sep).join("/");
    const durationMs = Math.round(testFile.endTime - testFile.startTime);

    const collectedNothing =
      Array.isArray(testFile.assertionResults) && testFile.assertionResults.length === 0;
    const unknownStatus =
      typeof testFile.status === "string" && !["passed", "failed"].includes(testFile.status);
    if (collectedNothing || unknownStatus) {
      continue;
    }

    if (Number.isFinite(durationMs) && durationMs >= 0) {
      measured[repoPath] = durationMs;
    }
  }
  return measured;
}

export function mergeDurations(existing, measured) {
  const merged = { ...existing, ...measured };
  const sorted = {};
  for (const key of Object.keys(merged).sort()) {
    sorted[key] = merged[key];
  }
  return sorted;
}

function measureFiles(repoRoot, files) {
  if (files.length === 0) {
    return {};
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "shard-measure-"));
  const reportPath = path.join(tempDir, "report.json");
  try {
    // Mirror run-vitest-stable.mjs's per-invocation isolation: a dedicated
    // PAPERCLIP_HOME/TMPDIR keeps this measurement run from colliding with
    // any other Paperclip process (dev server, another test run) using the
    // caller's ambient environment, and keeps fixture socket paths short.
    const env = {
      ...process.env,
      NODE_ENV: "test",
      PAPERCLIP_HOME: path.join(tempDir, "h"),
      PAPERCLIP_INSTANCE_ID: `measure-shard-${process.pid}`,
      TMPDIR: path.join(tempDir, "t"),
    };
    mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
    mkdirSync(env.TMPDIR, { recursive: true });

    // stdout is inherited, not piped, on purpose. The timing data comes from
    // --outputFile, so nothing here ever reads the child's stdout -- and
    // piping it would cap it at Node's default 1 MiB maxBuffer. A real
    // refresh shard runs ~108 server suites for 25-37 min; once their
    // combined stdout crossed that cap, spawnSync would kill vitest and set
    // `error` to ENOBUFS, failing the shard and (via `needs: [measure]`)
    // silently skipping the whole manifest refresh -- exactly the
    // depends-on-a-human-noticing failure this workflow exists to remove.
    // Inheriting also puts suite progress in the job log.
    const result = spawnSync(
      "pnpm",
      ["exec", "vitest", "run", "--project", "@paperclipai/server", ...files, ...MEASURE_VITEST_ARGS, "--reporter=json", `--outputFile=${reportPath}`],
      { cwd: repoRoot, env, stdio: ["ignore", "inherit", "inherit"] },
    );
    if (result.error) {
      throw result.error;
    }
    // Vitest exits non-zero on test failures, but the JSON report (and the
    // durations in it) is still written and still real. Only a missing
    // report means the run never actually produced timing data.
    const reportText = readFileSync(reportPath, "utf8");
    return parseVitestJsonReport(reportText, repoRoot);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseCliOptions(argv) {
  const options = { update: false, all: false, shardIndex: null, shardCount: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--update") {
      options.update = true;
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--shard-index") {
      options.shardIndex = Number(argv[(index += 1)]);
    } else if (arg === "--shard-count") {
      options.shardCount = Number(argv[(index += 1)]);
    } else if (arg === "--output") {
      options.output = argv[(index += 1)];
    }
  }
  return options;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const repoRoot = process.cwd();
  const manifestPath = path.join(repoRoot, "scripts", "general-server-shard-durations.json");
  const options = parseCliOptions(process.argv.slice(2));

  const allFiles = collectGeneralServerSuiteFiles(repoRoot);
  const durations = loadShardDurations(manifestPath);
  const targetFiles = selectTargetFiles({ allFiles, durations, ...options });

  console.log(`[measure-shard-durations] measuring ${targetFiles.length} suite(s)...`);
  const measured = measureFiles(repoRoot, targetFiles);

  if (options.output) {
    writeFileSync(options.output, JSON.stringify(measured, null, 2) + "\n");
  }

  if (options.update) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.durations = mergeDurations(manifest.durations, measured);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`[measure-shard-durations] updated ${Object.keys(measured).length} entries in ${manifestPath}`);
  } else {
    console.log(JSON.stringify(measured, null, 2));
  }
}

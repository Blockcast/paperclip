#!/usr/bin/env node
/**
 * merge-shard-duration-manifest.mjs
 *
 * Merges the per-shard measurement artifacts produced by the `measure` matrix
 * in .github/workflows/refresh-shard-manifest.yml into
 * scripts/general-server-shard-durations.json.
 *
 * Rewrites exactly two things: `durations` (merged, fresh measurements win,
 * keys sorted) and `$comment` (the sampling provenance sentence). Every other
 * manifest key is passed through untouched -- notably `$notes`, which holds
 * the durable guidance about what these numbers are and why a trivial suite
 * reads as single-digit ms.
 *
 * This lives in a script rather than inline in the workflow so it can be unit
 * tested. The first version was a YAML heredoc that unconditionally
 * overwrote `$comment` and so destroyed the units note on its first run --
 * and because that run is a Monday-morning schedule, nobody would have been
 * watching when it happened (BLO-24241).
 *
 * Usage:
 *   node scripts/merge-shard-duration-manifest.mjs --shard-dir <dir>
 *     [--manifest <path>] [--run-id <id>] [--date YYYY-MM-DD]
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Manifest keys this merge is allowed to rewrite. Anything else -- `$notes`,
// `unit`, and whatever a future reader adds -- survives a refresh verbatim.
export const REWRITTEN_KEYS = ["$comment", "durations"];

// Reads every per-shard artifact in shardDir and folds them into one map.
// Shard outputs are disjoint by construction (selectTargetFiles slices by
// index % count), so collision order does not matter.
export function readShardMeasurements(shardDir, { readDir = readdirSync, readFile = readFileSync } = {}) {
  let measured = {};
  for (const file of readDir(shardDir).sort()) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const shard = JSON.parse(readFile(path.join(shardDir, file), "utf8"));
    measured = { ...measured, ...shard };
  }
  return measured;
}

export function formatProvenanceComment({ runId, date, measuredCount, totalCount }) {
  return (
    `Per-suite Vitest durations (ms) for the general-server lane, used by ` +
    `scripts/general-server-shard.mjs to balance suites across the PR shard matrix. ` +
    `Re-sampled from the four .github/workflows/refresh-shard-manifest.yml shard jobs ` +
    `in run ${runId} on ${date}: ${measuredCount} suite(s) measured, ${totalCount} total ` +
    `entries. This sentence is regenerated on every refresh; see "$notes" for guidance ` +
    `that is meant to persist.`
  );
}

// Returns a new manifest object. Key order follows the input manifest so a
// refresh produces a minimal diff.
export function mergeManifest({ manifest, measured, runId, date }) {
  const merged = { ...manifest.durations, ...measured };
  const durations = {};
  for (const key of Object.keys(merged).sort()) {
    durations[key] = merged[key];
  }

  const next = { ...manifest };
  next.durations = durations;
  next["$comment"] = formatProvenanceComment({
    runId,
    date,
    measuredCount: Object.keys(measured).length,
    totalCount: Object.keys(durations).length,
  });
  return next;
}

function parseCliOptions(argv) {
  const options = { shardDir: null, manifest: null, runId: null, date: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--shard-dir") {
      options.shardDir = argv[(index += 1)];
    } else if (arg === "--manifest") {
      options.manifest = argv[(index += 1)];
    } else if (arg === "--run-id") {
      options.runId = argv[(index += 1)];
    } else if (arg === "--date") {
      options.date = argv[(index += 1)];
    }
  }
  return options;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const options = parseCliOptions(process.argv.slice(2));
  if (!options.shardDir) {
    console.error("[merge-shard-manifest] --shard-dir is required");
    process.exit(2);
  }

  const manifestPath =
    options.manifest ?? path.join(process.cwd(), "scripts", "general-server-shard-durations.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const measured = readShardMeasurements(options.shardDir);

  if (Object.keys(measured).length === 0) {
    // Every shard job produced an empty artifact. Writing the manifest here
    // would replace real durations with nothing but a fresh provenance line,
    // so fail loudly instead -- an empty refresh is a broken measure matrix.
    console.error("[merge-shard-manifest] no measurements found in " + options.shardDir);
    process.exit(1);
  }

  const next = mergeManifest({
    manifest,
    measured,
    runId: options.runId ?? process.env.GITHUB_RUN_ID ?? "unknown",
    date: options.date ?? new Date().toISOString().slice(0, 10),
  });

  writeFileSync(manifestPath, JSON.stringify(next, null, 2) + "\n");
  console.log(
    `[merge-shard-manifest] merged ${Object.keys(measured).length} measured suite(s) into ` +
      `${Object.keys(next.durations).length} total manifest entries.`,
  );
}

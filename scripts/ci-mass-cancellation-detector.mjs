#!/usr/bin/env node
// BLO-21078 AC3: detect the "mass-cancellation" class of CI failure — N or
// more `cancelled` workflow-run conclusions on a repo within a tight
// kill-instant window, spanning multiple unrelated branches/refs. This is
// distinct from ordinary `cancel-in-progress` concurrency supersession
// (pushing a new commit cancels the branch's own prior run) and from a
// single manually-cancelled run, neither of which should page anyone.
//
// Supersession heuristic is CTO's 2026-08-04 finding on this issue
// (https://paperclip.blockcast.net/BLO/issues/BLO-21078): a same-branch
// concurrency cancellation dies within a couple seconds of the newer run on
// that branch being created. A cluster caused by a shared-infrastructure
// event (ARC scale-set churn, node pressure, controller restart, ...) kills
// runs on *distinct* branches at the same instant, with no such newer-push
// explanation for any of them.
//
// Usage:
//   node scripts/ci-mass-cancellation-detector.mjs
//     Live mode: fetch cancelled runs from the last --lookback-minutes
//     (default 180), print DETECTOR_VERDICT=<json>, exit 1 if a qualifying
//     cluster is present, 0 if quiet, 2 on an operational error.
//
//   node scripts/ci-mass-cancellation-detector.mjs --since 2026-08-02T18:00:00Z --until 2026-08-02T20:00:00Z
//     Backtest mode: report every qualifying cluster whose kill instant
//     falls in [since, until). Same exit codes.
//
//   node scripts/ci-mass-cancellation-detector.mjs --json-file <path> ...
//     Read runs from a local JSON fixture (array of GitHub workflow-run
//     objects) instead of calling `gh api` — used by the test suite.
//
// Cluster membership defaults to `pull_request`-event runs only.
// `merge_group` cancellations are excluded by default: this repo's merge
// queue is configured with `maximumEntriesToBuild=1`, so when the queue's
// head entry finally merges (or the base branch otherwise advances) GitHub
// invalidates and cancels EVERY other queued entry's now-stale speculative
// build in one batch. That is expected, GitHub-side merge-queue mechanics,
// not a shared-infra kill — and it produces the exact same signature (many
// distinct refs, cancelled within seconds of each other) that this detector
// is built to catch. Verified against real repo history 2026-08-05/06: a
// backtest that included `merge_group` runs manufactured a dozen multi-hour
// "clusters" of up to 35 refs that were entirely merge-queue churn, not
// incidents. Pass --include-merge-group to opt back in once/if that
// cascade-cancel case gets its own supersession model.
//
// Env overrides (all optional):
//   CI_MASS_CANCEL_REPO                       default "Blockcast/paperclip"
//   CI_MASS_CANCEL_WORKFLOW                    default "PR"
//   CI_MASS_CANCEL_MIN_BRANCHES                default 3
//   CI_MASS_CANCEL_WINDOW_SECONDS              default 10
//   CI_MASS_CANCEL_SUPERSESSION_GRACE_SECONDS  default 5

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DEFAULTS = {
  repo: process.env.CI_MASS_CANCEL_REPO || "Blockcast/paperclip",
  workflowName: process.env.CI_MASS_CANCEL_WORKFLOW || "PR",
  minDistinctBranches: Number(process.env.CI_MASS_CANCEL_MIN_BRANCHES || 3),
  clusterWindowSeconds: Number(process.env.CI_MASS_CANCEL_WINDOW_SECONDS || 10),
  includeMergeGroup: false,
  supersessionGraceSeconds: Number(process.env.CI_MASS_CANCEL_SUPERSESSION_GRACE_SECONDS || 5),
};

export function parseArgs(argv) {
  const args = { lookbackMinutes: 180, maxPages: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--since") args.since = argv[++i];
    else if (arg === "--until") args.until = argv[++i];
    else if (arg === "--lookback-minutes") args.lookbackMinutes = Number(argv[++i]);
    else if (arg === "--repo") args.repo = argv[++i];
    else if (arg === "--json-file") args.jsonFile = argv[++i];
    else if (arg === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (arg === "--include-merge-group") args.includeMergeGroup = true;
  }
  return args;
}

function fetchCancelledRunsLive(repo, maxPages) {
  const runs = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const out = execFileSync(
      "gh",
      ["api", `repos/${repo}/actions/runs?status=cancelled&per_page=100&page=${page}`, "--jq", ".workflow_runs"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ).trim();
    const pageRuns = out ? JSON.parse(out) : [];
    if (pageRuns.length === 0) break;
    runs.push(...pageRuns);
    if (pageRuns.length < 100) break;
  }
  return runs;
}

function loadRuns(args) {
  if (args.jsonFile) {
    return JSON.parse(readFileSync(args.jsonFile, "utf8"));
  }
  return fetchCancelledRunsLive(args.repo || DEFAULTS.repo, args.maxPages);
}

// The concurrency-group key this repo's pr.yml actually uses today:
// `pull_request` groups by PR number (approximated here by head_branch,
// stable per PR); `merge_group` groups by `merge_group.base_ref` — NOT by
// head_sha — so every merge-queue re-stage against the same base branch
// shares one slot (`maximumEntriesToBuild=1`) and cancels the prior queued
// build regardless of the (unique-per-attempt) `gh-readonly-queue/<base>/…`
// head_branch. Getting this wrong makes ordinary single-slot merge-queue
// churn look like a correlated infra kill — verified against the live
// pr.yml on 2026-08-12 (github.com/Blockcast/paperclip, concurrency.group).
function supersessionKey(run) {
  if (run.event === "pull_request") return `pr:${run.head_branch}`;
  if (run.event === "merge_group") {
    const match = /^gh-readonly-queue\/([^/]+)\//.exec(run.head_branch || "");
    return match ? `merge_group:${match[1]}` : `merge_group:${run.head_branch}`;
  }
  return null;
}

// A cancelled run is ordinary `cancel-in-progress` supersession if a later
// run sharing its concurrency-group key was created within `graceSeconds` of
// this run's kill instant (updated_at) — i.e. something else claimed the
// shared slot and GitHub cancelled the stale build almost immediately. A
// successor created many minutes before the actual kill does NOT qualify:
// real supersession kills near-instantly, so a long gap means the run was
// still alive well after being "replaced" and died of something else.
function isSupersession(run, allRuns, graceSeconds) {
  const key = supersessionKey(run);
  if (!key) return false;
  const killAt = Date.parse(run.updated_at);
  const createdAt = Date.parse(run.created_at);
  return allRuns.some((other) => {
    if (other.id === run.id) return false;
    if (supersessionKey(other) !== key) return false;
    const otherCreatedAt = Date.parse(other.created_at);
    if (otherCreatedAt <= createdAt) return false;
    return Math.abs(otherCreatedAt - killAt) <= graceSeconds * 1000;
  });
}

// Single-linkage clustering on kill instant (updated_at): consecutive runs
// (sorted by updated_at) fall in the same cluster while the gap to the next
// run is <= windowSeconds.
function clusterByKillInstant(runs, windowSeconds) {
  const sorted = [...runs].sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
  const clusters = [];
  let current = [];
  for (const run of sorted) {
    if (current.length === 0) {
      current.push(run);
      continue;
    }
    const prevKillAt = Date.parse(current[current.length - 1].updated_at);
    const killAt = Date.parse(run.updated_at);
    if ((killAt - prevKillAt) / 1000 <= windowSeconds) {
      current.push(run);
    } else {
      clusters.push(current);
      current = [run];
    }
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

function summarizeCluster(cluster) {
  const branches = [...new Set(cluster.map((r) => r.head_branch))];
  const killTimes = cluster.map((r) => r.updated_at).sort();
  return {
    runCount: cluster.length,
    distinctBranchCount: branches.length,
    branches,
    killWindowStart: killTimes[0],
    killWindowEnd: killTimes[killTimes.length - 1],
    runs: cluster.map((r) => ({
      id: r.id,
      head_branch: r.head_branch,
      event: r.event,
      created_at: r.created_at,
      updated_at: r.updated_at,
      html_url: r.html_url,
    })),
  };
}

export function detect(rawRuns, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  // Same-workflow runs of ANY conclusion are needed as supersession
  // candidates — the run that superseded a cancelled one is typically still
  // `in_progress`/`success`, not itself `cancelled`.
  const sameWorkflow = rawRuns.filter((r) => r.name === opts.workflowName);
  const eligibleEvents = sameWorkflow.filter((r) => opts.includeMergeGroup || r.event !== "merge_group");
  const cancelled = eligibleEvents.filter((r) => r.conclusion === "cancelled");

  let scoped = cancelled;
  if (opts.since || opts.until) {
    const sinceMs = opts.since ? Date.parse(opts.since) : -Infinity;
    const untilMs = opts.until ? Date.parse(opts.until) : Infinity;
    scoped = cancelled.filter((r) => {
      const killAt = Date.parse(r.updated_at);
      return killAt >= sinceMs && killAt < untilMs;
    });
  } else if (opts.lookbackMinutes) {
    const cutoff = Date.now() - opts.lookbackMinutes * 60 * 1000;
    scoped = cancelled.filter((r) => Date.parse(r.updated_at) >= cutoff);
  }

  const nonSuperseded = scoped.filter((r) => !isSupersession(r, sameWorkflow, opts.supersessionGraceSeconds));
  const clusters = clusterByKillInstant(nonSuperseded, opts.clusterWindowSeconds)
    .filter((c) => new Set(c.map((r) => r.head_branch)).size >= opts.minDistinctBranches)
    .map(summarizeCluster);

  return {
    firing: clusters.length > 0,
    repo: opts.repo,
    workflowName: opts.workflowName,
    minDistinctBranches: opts.minDistinctBranches,
    clusterWindowSeconds: opts.clusterWindowSeconds,
    supersessionGraceSeconds: opts.supersessionGraceSeconds,
    scannedRunCount: scoped.length,
    supersessionExcludedCount: scoped.length - nonSuperseded.length,
    clusters,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let rawRuns;
  try {
    rawRuns = loadRuns(args);
  } catch (err) {
    console.error(`ci-mass-cancellation-detector: failed to fetch runs: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  const verdict = detect(rawRuns, {
    repo: args.repo,
    since: args.since,
    until: args.until,
    lookbackMinutes: args.since || args.until ? undefined : args.lookbackMinutes,
    includeMergeGroup: args.includeMergeGroup,
  });

  console.log(`DETECTOR_VERDICT=${JSON.stringify(verdict)}`);
  process.exitCode = verdict.firing ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

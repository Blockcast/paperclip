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
// --fetch-pad-minutes (default 360) pads BOTH ends of the requested window,
// so it — not --lookback-minutes — is what drives fetch volume: the default
// 180-minute live lookback fetches a ~15h span of runs of every conclusion
// and every workflow. That interacts with the ~1000-result API cap and with
// --max-pages; when either bound bites, `fetchTruncated` is set and a
// non-firing verdict exits 2 rather than reporting a floor as an all-clear.
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

// GitHub's `/actions/runs` list stops yielding at ~1000 results per query,
// regardless of paging. Reaching it means the fetch was truncated from the
// old end, so any verdict computed over it is a floor.
const FETCH_RESULT_CAP = 1000;

const DEFAULTS = {
  repo: process.env.CI_MASS_CANCEL_REPO || "Blockcast/paperclip",
  workflowName: process.env.CI_MASS_CANCEL_WORKFLOW || "PR",
  minDistinctBranches: Number(process.env.CI_MASS_CANCEL_MIN_BRANCHES || 3),
  clusterWindowSeconds: Number(process.env.CI_MASS_CANCEL_WINDOW_SECONDS || 10),
  includeMergeGroup: false,
  supersessionGraceSeconds: Number(process.env.CI_MASS_CANCEL_SUPERSESSION_GRACE_SECONDS || 5),
};

export function parseArgs(argv) {
  const args = { lookbackMinutes: 180, maxPages: 20, fetchPadMinutes: 360 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--since") args.since = argv[++i];
    else if (arg === "--until") args.until = argv[++i];
    else if (arg === "--lookback-minutes") args.lookbackMinutes = Number(argv[++i]);
    else if (arg === "--repo") args.repo = argv[++i];
    else if (arg === "--json-file") args.jsonFile = argv[++i];
    else if (arg === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (arg === "--fetch-pad-minutes") args.fetchPadMinutes = Number(argv[++i]);
    else if (arg === "--include-merge-group") args.includeMergeGroup = true;
  }
  return args;
}

// `/actions/runs` paginates from the NEWEST run and the list endpoint stops
// returning results at roughly 1000 entries, so a page-bounded fetch reaches
// back only as far as recent volume allows — measured 2026-09-20, 20 pages of
// `status=cancelled` bottomed out at 2026-08-10 and could not see the 08-02
// incident at all. `--since/--until` filtered only AFTER that fetch, so any
// backtest older than the reachable window returned `firing: false` with
// `scannedRunCount: 0`: a silent all-clear that is indistinguishable from a
// genuinely quiet window. Bound the fetch by `created=` instead, which the
// REST API filters server-side, so reachability depends on the requested
// window rather than on how busy the repo has been since.
export function createdRangeFor(args, now = Date.now()) {
  const padMs = (Number.isFinite(args.fetchPadMinutes) ? args.fetchPadMinutes : 360) * 60 * 1000;
  let startMs;
  let endMs;
  if (args.since || args.until) {
    startMs = args.since ? Date.parse(args.since) : now - 30 * 24 * 60 * 60 * 1000;
    endMs = args.until ? Date.parse(args.until) : now;
  } else {
    startMs = now - (args.lookbackMinutes || 180) * 60 * 1000;
    endMs = now;
  }
  // The window is expressed in KILL instants (`updated_at`) but `created=`
  // filters on `created_at`. Pad backwards so a long run created before the
  // window but killed inside it is still fetched, and forwards so the newer
  // run that would explain a cancellation as ordinary supersession is present
  // — without it every supersession reads as an infra kill.
  return `${new Date(startMs - padMs).toISOString()}..${new Date(endMs + padMs).toISOString()}`;
}

// Deliberately NOT `status=cancelled`: `detect()` needs same-workflow runs of
// any conclusion as supersession candidates, and the run that superseded a
// cancelled one is typically `success`/`in_progress`. Filtering to cancelled
// at fetch time hid exactly those, so ordinary concurrency supersession could
// only be recognised when the superseding run had itself been cancelled.
function ghFetchPage(repo, page, created) {
  const out = execFileSync(
    "gh",
    ["api", `repos/${repo}/actions/runs?per_page=100&page=${page}${created}`, "--jq", ".workflow_runs"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ).trim();
  return out ? JSON.parse(out) : [];
}

// `fetchPage` is injectable so the page-bounding branch below is reachable
// from a test. It is the only guard here the fixture-driven suite cannot
// exercise — `--json-file` bypasses this function entirely — and an unguarded
// guard is a comment: removing it left the suite green (mutation-tested).
export function fetchRunsLive(repo, maxPages, createdRange, fetchPage = ghFetchPage) {
  const runs = [];
  const created = `&created=${encodeURIComponent(createdRange)}`;
  let pageBounded = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const pageRuns = fetchPage(repo, page, created);
    if (pageRuns.length === 0) break;
    runs.push(...pageRuns);
    if (pageRuns.length < 100) break;
    // Stopping on --max-pages with a FULL final page means the API still had
    // more to give and we quit first. Paging is newest-first, so what was
    // dropped is the OLDEST part of the window — exactly where a backtested
    // incident lives. The `FETCH_RESULT_CAP` check below cannot see this:
    // truncation under the cap leaves a population that looks complete.
    // Measured at `--max-pages 1` over 2026-08-02T19:00Z..20:00Z: 100 runs
    // spanning 20:45Z..01:59Z, `firing:false`, exit 0 — a confident all-clear
    // over a window that provably contains the incident this detector exists
    // to catch.
    if (page === maxPages) pageBounded = true;
  }
  return { runs, pageBounded };
}

function loadRuns(args) {
  if (args.jsonFile) {
    return { runs: JSON.parse(readFileSync(args.jsonFile, "utf8")), pageBounded: false };
  }
  return fetchRunsLive(args.repo || DEFAULTS.repo, args.maxPages, createdRangeFor(args));
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
    // `fetchedRunCount` is the raw population the verdict was computed over,
    // and it is what separates "looked, found nothing" from "never looked".
    // `scannedRunCount: 0` alone cannot make that distinction, and the quiet
    // reading is the dangerous one — see `createdRangeFor` above.
    fetchedRunCount: rawRuns.length,
    // `fetchedRunCount` is the population across ALL workflows, so it cannot
    // catch a mistyped --workflow: the guard passes and the verdict reads
    // quiet over a window that contains an incident. This is the same count
    // one level down, and `> 0 fetched` with `0 same-workflow` is a lookup
    // failure, never an all-clear.
    sameWorkflowRunCount: sameWorkflow.length,
    // `/actions/runs` stops yielding at ~1000 results for any one query, and
    // it pages newest-first — so a truncated fetch silently drops the OLDEST
    // part of the requested window. `pageBounded` is the same hazard from the
    // other bound: we stopped on --max-pages while the API still had pages.
    // For a detector either is the dangerous direction (a missed cluster
    // reads as quiet), so say so out loud: the verdict is then a floor, not a
    // census, and main() refuses to report it as a clean exit. Narrow the
    // window, raise --max-pages, or lower --fetch-pad-minutes until it clears.
    fetchTruncated: rawRuns.length >= FETCH_RESULT_CAP || Boolean(opts.pageBounded),
    scannedRunCount: scoped.length,
    supersessionExcludedCount: scoped.length - nonSuperseded.length,
    clusters,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Validate here rather than letting `Date.parse` -> NaN reach
  // `createdRangeFor`, where `new Date(NaN).toISOString()` throws and is
  // caught below as "failed to fetch runs: Invalid time value" — the right
  // exit code attributing a parse error to the network.
  for (const key of ["since", "until"]) {
    if (args[key] !== undefined && Number.isNaN(Date.parse(args[key]))) {
      console.error(`ci-mass-cancellation-detector: --${key} is not a parseable timestamp: ${JSON.stringify(args[key])}`);
      process.exitCode = 2;
      return;
    }
  }

  let rawRuns;
  let pageBounded;
  try {
    ({ runs: rawRuns, pageBounded } = loadRuns(args));
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
    pageBounded,
  });

  console.log(`DETECTOR_VERDICT=${JSON.stringify(verdict)}`);
  // Three ways to reach `firing: false` without having looked — each renders
  // identically to a genuinely quiet window, and quiet is the dangerous
  // reading. A fixture run (`--json-file`) is exempt from the two population
  // guards: an empty fixture, or one deliberately containing only other
  // workflows, is a legitimate test input.
  if (!args.jsonFile && verdict.fetchedRunCount === 0) {
    console.error(
      "ci-mass-cancellation-detector: fetched 0 runs — the verdict above is vacuous, not quiet. " +
        "Check the repo, `gh` auth, and that the requested window is within API reach.",
    );
    process.exitCode = 2;
    return;
  }
  if (!args.jsonFile && verdict.sameWorkflowRunCount === 0) {
    console.error(
      `ci-mass-cancellation-detector: fetched ${verdict.fetchedRunCount} runs but none named ` +
        `"${verdict.workflowName}" — the verdict above is vacuous, not quiet. Check ` +
        "CI_MASS_CANCEL_WORKFLOW against the repo's actual workflow names.",
    );
    process.exitCode = 2;
    return;
  }
  // A truncated fetch makes a non-firing verdict a floor, not a census: the
  // dropped part of the window is the oldest, and a cluster there is exactly
  // what this looks for. Exit 2 so a CI gate consuming the exit code cannot
  // read a floor as an all-clear. A FIRING truncated verdict still exits 1 —
  // the incident was found, and more of the window would only add to it.
  if (verdict.fetchTruncated && !verdict.firing) {
    console.error(
      `ci-mass-cancellation-detector: fetch truncated at ${verdict.fetchedRunCount} runs — the ` +
        "non-firing verdict above is a floor, not a census. Narrow --since/--until, raise " +
        "--max-pages, or lower --fetch-pad-minutes.",
    );
    process.exitCode = 2;
    return;
  }
  process.exitCode = verdict.firing ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

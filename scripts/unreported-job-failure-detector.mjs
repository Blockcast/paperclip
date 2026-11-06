#!/usr/bin/env node
// PEN-5738: detect a FALSE RED — a check run GitHub concluded `failure` whose
// runner never reported, so no test actually failed.
//
// THE FAULT. A self-hosted ARC runner finishes a job, then loses external DNS
// before it can report. `CompleteJobAsync` retries against
// `run-actions-2-azure-eastus.actions.githubusercontent.com` and gets
// `SocketException(11)` / `TryAgain` (= `EAI_AGAIN`, name resolution), the
// Actions service times the job out and writes `conclusion: failure`, and the
// PR renders a red test shard for tests that all passed. The runner pod stays
// Running and holds its concurrency slot — measured 2026-11-06, two of
// `arc-paperclip-general`'s four slots, with 7 jobs queued 3h38m behind them.
//
// WHY THIS NEEDS A DETECTOR AT ALL. On the PR page the false red is
// BYTE-IDENTICAL to a genuine test failure, and the uploaded log truncates ~16
// minutes before GitHub closed the job — so the evidence that nothing failed is
// ABSENT rather than contradictory. An agent reading its own PR sees "General
// tests (server 3/6) — failure" and has every reason to start fixing a suite
// that was never broken. That wrong turn is more expensive than the lost
// capacity, which is why this ships ahead of any runner reaper.
//
// THE DISCRIMINATOR. Only the runner can close a step. The Actions service can
// set the JOB conclusion on timeout, but it cannot retro-fill steps it never
// heard about — so a job the runner abandoned keeps its unreported steps at
// `conclusion: null`, while a genuine failure always carries
// `conclusion: "failure"` on the failing step itself and `skipped` on the rest.
//
//     job.conclusion === "failure" && any step.conclusion === null
//         => the runner never reported          (FALSE RED)
//     job.conclusion === "failure" && every step resolved
//         => a step ran and failed              (GENUINE)
//
// MEASURED, not assumed (2026-11-06, Blockcast/paperclip, 97 failed jobs over
// the ~3 most recent pages of failed runs):
//
//     all steps resolved  ............ 94   classified genuine, 0 false alarms
//     >=1 null-conclusion step ....... 3    all three are PEN-5738 victims
//     zero steps reported ............ 0
//
// The three positives are `General tests (server 6/6)` @06:21:35Z and
// `General tests (server 3/6)` @06:22:14Z — the two the incident recorded — plus
// a third, `General tests (server 3/6)` @06:21:30Z, that nobody had found. So on
// this sample the rule is 3/3 sensitive and 94/94 specific.
//
// Their null steps sit at `status: "in_progress"` or `"pending"` on a job the
// service has marked `completed`. That combination is structurally unreachable
// for a runner that is still talking: a live runner either completes the step or
// the job stays open. We key on `conclusion === null` (what the incident
// recorded) and carry `status` into the comment as corroborating evidence.
//
// FAIL-SILENT, NOT FAIL-LOUD. The dangerous error here is telling an author
// "this red is infrastructure, ignore it" about a REAL failure. So a job is
// called a false red only on POSITIVE evidence: an actually-present step object
// carrying a null conclusion. Absent/empty `steps` is `indeterminate` and says
// nothing — never `runner_never_reported`.
//
// SCOPE. Only `conclusion === "failure"`. `cancelled` and `timed_out` are
// deliberately excluded: both legitimately leave steps null (a cancel lands
// mid-step), so the discriminator does not separate signal from noise there, and
// neither renders as a test failure an author would chase.
//
// Usage:
//   node scripts/unreported-job-failure-detector.mjs
//     Live scan of the last --lookback-minutes (default 60). Prints
//     DETECTOR_VERDICT=<json>; exit 1 if any false red is present, 0 if clean,
//     2 on an operational error.
//
//   node scripts/unreported-job-failure-detector.mjs --comment true
//     Also post/update one PR comment per affected head SHA.
//
//   node scripts/unreported-job-failure-detector.mjs --json-file <path>
//     Read `{runs:[{run, jobs:[...]}]}` from a fixture instead of calling the
//     API — used by the test suite.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const COMMENT_MARKER_PREFIX = "<!-- pen-5738-unreported-job-failure:";

const DEFAULT_REPO = process.env.UNREPORTED_JOB_REPO || "Blockcast/paperclip";

export function parseArgs(argv) {
  const args = {
    repo: DEFAULT_REPO,
    lookbackMinutes: 60,
    // A run is CREATED long before the job inside it fails — PR #3444 sat
    // queued 3h38m — so the server-side `created=` filter must reach much
    // further back than the window we actually report on, or the fetch drops
    // exactly the runs we are looking for.
    fetchPadMinutes: 720,
    maxRuns: 60,
    comment: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") args.repo = argv[++i];
    else if (arg === "--lookback-minutes") args.lookbackMinutes = Number(argv[++i]);
    else if (arg === "--fetch-pad-minutes") args.fetchPadMinutes = Number(argv[++i]);
    else if (arg === "--max-runs") args.maxRuns = Number(argv[++i]);
    else if (arg === "--json-file") args.jsonFile = argv[++i];
    else if (arg === "--comment") args.comment = String(argv[++i]).toLowerCase() === "true";
  }
  return args;
}

// ---------------------------------------------------------------------------
// Pure classification — the whole correctness argument lives here.
// ---------------------------------------------------------------------------

export function classifyJob(job) {
  if (!job || job.conclusion !== "failure") {
    return { verdict: "not_a_failure", unreportedSteps: [], stepCount: 0 };
  }
  const steps = Array.isArray(job.steps) ? job.steps : null;
  // No step array at all, or an empty one. This is NOT evidence of a silent
  // runner: it is evidence of nothing. Claiming a false red here would put an
  // "ignore this red" comment on a genuine failure, which is the one outcome
  // worse than staying quiet.
  if (!steps || steps.length === 0) {
    return {
      verdict: "indeterminate",
      reason: steps ? "job reported zero steps" : "job carried no steps array",
      unreportedSteps: [],
      stepCount: 0,
    };
  }
  const unreported = steps
    .filter((s) => s && s.conclusion === null)
    .map((s) => ({ name: s.name, status: s.status ?? null }));
  if (unreported.length === 0) {
    return { verdict: "genuine_failure", unreportedSteps: [], stepCount: steps.length };
  }
  return {
    verdict: "runner_never_reported",
    reason: `${unreported.length} of ${steps.length} steps were never closed by the runner`,
    unreportedSteps: unreported,
    stepCount: steps.length,
  };
}

// A run is worth fetching jobs for when it could plausibly contain a job that
// failed inside the window. Note the second arm: in the PEN-5738 incident the
// RUN was still `in_progress` (7 jobs queued) while two of its jobs had already
// been concluded `failure` — so filtering to completed/failed runs would have
// missed the live case entirely, which is the only case worth catching early.
export function runMayContainWindowFailure(run, windowStartMs) {
  if (!run) return false;
  if (run.status !== "completed") return true;
  const updated = Date.parse(run.updated_at ?? "");
  return Number.isFinite(updated) && updated >= windowStartMs;
}

export function detect({ runs, windowStartMs, windowEndMs, repo, fetchTruncated = false }) {
  const findings = [];
  let failedJobsScanned = 0;
  let genuine = 0;
  let indeterminate = 0;
  for (const entry of runs) {
    const run = entry.run ?? entry;
    for (const job of entry.jobs ?? []) {
      if (job.conclusion !== "failure") continue;
      const completed = Date.parse(job.completed_at ?? "");
      if (!Number.isFinite(completed) || completed < windowStartMs || completed > windowEndMs) continue;
      failedJobsScanned += 1;
      const c = classifyJob(job);
      if (c.verdict === "genuine_failure") { genuine += 1; continue; }
      if (c.verdict === "indeterminate") { indeterminate += 1; continue; }
      findings.push({
        jobId: job.id,
        jobName: job.name,
        htmlUrl: job.html_url,
        completedAt: job.completed_at,
        runId: run.id,
        runAttempt: run.run_attempt ?? job.run_attempt ?? null,
        headSha: run.head_sha ?? job.head_sha ?? null,
        headBranch: run.head_branch ?? null,
        workflowName: run.name ?? null,
        pullRequests: (run.pull_requests ?? []).map((p) => p.number),
        reason: c.reason,
        stepCount: c.stepCount,
        unreportedSteps: c.unreportedSteps,
      });
    }
  }
  return {
    firing: findings.length > 0,
    repo,
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(windowEndMs).toISOString(),
    // Separates "looked and found nothing" from "never looked". A clean verdict
    // over zero scanned failures is vacuous, and quiet is the dangerous reading.
    failedJobsScanned,
    genuineFailureCount: genuine,
    indeterminateCount: indeterminate,
    fetchTruncated,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function commentMarkerFor(headSha) {
  return `${COMMENT_MARKER_PREFIX}${headSha} -->`;
}

export function renderComment({ headSha, findings }) {
  const lines = [];
  lines.push(commentMarkerFor(headSha));
  lines.push("## ⚠️ Infrastructure fault, not a test failure — do not debug these tests");
  lines.push("");
  lines.push(
    `${findings.length === 1 ? "A red check" : `${findings.length} red checks`} at \`${String(headSha).slice(0, 7)}\` ` +
      "came back `failure` **without the runner ever reporting a result**. No test failed.",
  );
  lines.push("");
  lines.push("| Check | Concluded | Steps never closed by the runner |");
  lines.push("|---|---|---|");
  for (const f of findings) {
    const steps = f.unreportedSteps.map((s) => `\`${s.name}\`${s.status ? ` (${s.status})` : ""}`).join("<br>");
    const name = f.htmlUrl ? `[${f.jobName}](${f.htmlUrl})` : f.jobName;
    lines.push(`| ${name} | ${f.completedAt} | ${f.unreportedSteps.length}/${f.stepCount} — ${steps} |`);
  }
  lines.push("");
  lines.push("### How this is known");
  lines.push("");
  lines.push(
    "Only a runner can close a step. The Actions service sets the **job** conclusion when a runner " +
      "goes silent, but it cannot retro-fill steps it never heard about — so an abandoned job keeps " +
      "its unreported steps at `conclusion: null`. A genuine failure always carries " +
      "`conclusion: failure` **on the failing step itself**.",
  );
  lines.push("");
  lines.push("The usual cause is the runner losing external DNS at `CompleteJobAsync` (`EAI_AGAIN`) after the work finished.");
  lines.push("");
  lines.push("### What to do");
  lines.push("");
  lines.push("```");
  lines.push(`gh run rerun ${findings[0].runId} --failed`);
  lines.push("```");
  lines.push("");
  lines.push(
    "⛔ **Do not push a new head to retry.** It dismisses any review bound to this SHA and re-burns " +
      "the entire green check set to work around an infrastructure fault.",
  );
  lines.push("");
  lines.push("<sub>Posted by `scripts/unreported-job-failure-detector.mjs` — PEN-5738.</sub>");
  return lines.join("\n");
}

export function groupByHeadSha(findings) {
  const out = new Map();
  for (const f of findings) {
    if (!f.headSha) continue;
    if (!out.has(f.headSha)) out.set(f.headSha, []);
    out.get(f.headSha).push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

function ghApi(path, extra = []) {
  return JSON.parse(execFileSync("gh", ["api", path, ...extra], { encoding: "utf8", maxBuffer: 1 << 28 }));
}

function loadLive(args, windowStartMs, nowMs) {
  const padMs = args.fetchPadMinutes * 60 * 1000;
  const created = `${new Date(windowStartMs - padMs).toISOString()}..${new Date(nowMs + 60_000).toISOString()}`;
  const listed = ghApi(
    `/repos/${args.repo}/actions/runs?per_page=100&created=${encodeURIComponent(created)}`,
  ).workflow_runs ?? [];
  const candidates = listed.filter((r) => runMayContainWindowFailure(r, windowStartMs));
  const fetchTruncated = candidates.length > args.maxRuns;
  const runs = [];
  for (const run of candidates.slice(0, args.maxRuns)) {
    let jobs = [];
    try {
      jobs = ghApi(`/repos/${args.repo}/actions/runs/${run.id}/jobs?per_page=100&filter=latest`).jobs ?? [];
    } catch (err) {
      // One unreadable run must not void the whole scan, but it does mean the
      // census is incomplete — record that so a clean verdict cannot be read as
      // an all-clear.
      console.error(`unreported-job-failure-detector: could not read jobs for run ${run.id}: ${err.message}`);
      return { runs, fetchTruncated: true };
    }
    runs.push({ run, jobs });
  }
  return { runs, fetchTruncated };
}

// Paginated on purpose. A single `per_page=100` page is where the idempotency
// guarantee quietly dies: a PR with more than 100 comments pushes the marker
// off the page, every scan then believes it is posting for the first time, and
// the annotation is duplicated every cycle on exactly the long, busy PRs where
// extra noise is least welcome. `gh api --paginate` is not usable here — for an
// array response it concatenates separate JSON documents rather than merging
// them, so `JSON.parse` would fail on the second page.
function listIssueComments(repo, prNumber) {
  const all = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = ghApi(`/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

function upsertComment({ repo, prNumber, headSha, body }) {
  const marker = commentMarkerFor(headSha);
  const existing = listIssueComments(repo, prNumber).find((c) => (c.body ?? "").includes(marker));
  const args = ["-X", existing ? "PATCH" : "POST", "-f", `body=${body}`];
  const path = existing
    ? `/repos/${repo}/issues/comments/${existing.id}`
    : `/repos/${repo}/issues/${prNumber}/comments`;
  ghApi(path, args);
  return existing ? "updated" : "created";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const nowMs = Date.now();
  const windowStartMs = nowMs - args.lookbackMinutes * 60 * 1000;

  let runs;
  let fetchTruncated = false;
  try {
    if (args.jsonFile) {
      ({ runs } = JSON.parse(readFileSync(args.jsonFile, "utf8")));
    } else {
      ({ runs, fetchTruncated } = loadLive(args, windowStartMs, nowMs));
    }
  } catch (err) {
    console.error(`unreported-job-failure-detector: failed to load runs: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  const verdict = detect({
    runs,
    windowStartMs,
    windowEndMs: nowMs,
    repo: args.repo,
    fetchTruncated,
  });
  console.log(`DETECTOR_VERDICT=${JSON.stringify(verdict)}`);

  if (args.comment && verdict.firing) {
    for (const [headSha, findings] of groupByHeadSha(verdict.findings)) {
      const prNumbers = [...new Set(findings.flatMap((f) => f.pullRequests))];
      if (prNumbers.length === 0) {
        console.error(`unreported-job-failure-detector: no PR attached to ${headSha}; nothing to annotate`);
        continue;
      }
      const body = renderComment({ headSha, findings });
      for (const pr of prNumbers) {
        try {
          const action = upsertComment({ repo: args.repo, prNumber: pr, headSha, body });
          console.log(`unreported-job-failure-detector: ${action} comment on #${pr} for ${headSha}`);
        } catch (err) {
          console.error(`unreported-job-failure-detector: could not annotate #${pr}: ${err.message}`);
        }
      }
    }
  }

  // A truncated fetch makes a NON-firing verdict a floor rather than a census,
  // and "no false reds found" is the dangerous reading. A firing truncated
  // verdict still exits 1 — more of the window could only add findings.
  if (verdict.fetchTruncated && !verdict.firing) {
    console.error(
      "unreported-job-failure-detector: fetch truncated — the clean verdict above is a floor, " +
        "not a census. Raise --max-runs or narrow --lookback-minutes.",
    );
    process.exitCode = 2;
    return;
  }
  process.exitCode = verdict.firing ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

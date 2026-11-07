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
    // One jobs request per candidate, so this is the real cost knob. The
    // server-side arms in `loadLive` keep the live candidate set near ~75 at
    // this repo's volume (measured 2026-11-06), so 120 is headroom rather than
    // a bound that bites — which matters because hitting it means exit 2 and a
    // red scheduled run. Budget: ~4 listing pages + ~30 jobs calls per scan,
    // 4 scans/hour, against a GITHUB_TOKEN ceiling of 1000/hour per repo that
    // is SHARED with every other workflow here.
    maxRuns: 120,
    // Page cap for the run listing. 20 pages = 2000 runs; beyond that the scan
    // says it truncated rather than pretending to a census.
    maxPages: 20,
    comment: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") args.repo = argv[++i];
    else if (arg === "--lookback-minutes") args.lookbackMinutes = Number(argv[++i]);
    else if (arg === "--fetch-pad-minutes") args.fetchPadMinutes = Number(argv[++i]);
    else if (arg === "--max-runs") args.maxRuns = Number(argv[++i]);
    else if (arg === "--max-pages") args.maxPages = Number(argv[++i]);
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
  // WHAT A NULL CONCLUSION DOES AND DOES NOT PROVE (Ally review, PEN-5738).
  //
  // It proves the runner STOPPED REPORTING. It does NOT prove the work
  // finished. A runner that dies MID-TEST — OOM-killed, evicted, its node
  // removed, or wedged by the suite itself — produces exactly this shape, and
  // some of those causes ARE the tests. Telling that author "no test failed"
  // would be the one error this detector must never make.
  //
  // So distinguish the two, step-name-agnostically, on `status`:
  //
  //   any unreported step `in_progress` => a step was MID-FLIGHT when the
  //                                        runner went silent. Result UNKNOWN.
  //   every unreported step `pending`   => every step that STARTED also
  //                                        closed, and closed non-`failure`.
  //                                        The runner went silent BETWEEN
  //                                        steps. Still not "the job would
  //                                        have passed" — later steps never
  //                                        ran — but no step failed first.
  //
  // Neither branch licenses "no test failed". The victim fixture is
  // `mid_step`, which is the point: the incident knew its tests passed from
  // the RUNNER LOG, which this detector never reads.
  const midStep = unreported.some((s) => s.status === "in_progress");
  return {
    verdict: "runner_never_reported",
    shape: midStep ? "mid_step" : "between_steps",
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
        shape: c.shape,
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
  const anyMidStep = findings.some((f) => f.shape === "mid_step");
  const lines = [];
  lines.push(commentMarkerFor(headSha));
  lines.push("## ⚠️ The runner stopped reporting — this result is UNKNOWN, not a test failure");
  lines.push("");
  lines.push(
    `${findings.length === 1 ? "A red check" : `${findings.length} red checks`} at \`${String(headSha).slice(0, 7)}\` ` +
      "came back `failure` **without the runner ever reporting a result**. " +
      "**Rerun before debugging anything.**",
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
  lines.push("### What this does and does not tell you");
  lines.push("");
  lines.push(
    "Only a runner can close a step. The Actions service sets the **job** conclusion when a runner " +
      "goes silent, but it cannot retro-fill steps it never heard about — so an abandoned job keeps " +
      "its unreported steps at `conclusion: null`. A genuine test failure always carries " +
      "`conclusion: failure` **on the failing step itself**, and none of these do.",
  );
  lines.push("");
  lines.push(
    "**So the tests here did not report a failure — but they are not known to have passed either.** " +
      "That evidence lives in the runner log, which this check does not read.",
  );
  lines.push("");
  if (anyMidStep) {
    lines.push(
      "⚠️ At least one step above was still `in_progress` when the runner went silent, so its work " +
        "may not have finished. A runner killed **mid-test** — OOM, eviction, a lost node, or a suite " +
        "that wedges the runner — produces exactly this shape, and some of those causes are the tests " +
        "themselves. **Treat the result as unknown and rerun;** if the rerun reproduces, it is real.",
    );
  } else {
    lines.push(
      "Every unreported step above is `pending` — it never started. So every step that *did* start " +
        "also closed, and none closed `failure`; the runner went silent **between** steps. That is " +
        "consistent with the usual cause below, but it still does not prove the remaining steps would " +
        "have passed.",
    );
  }
  lines.push("");
  lines.push(
    "The usual cause is the runner losing external DNS at `CompleteJobAsync` (`EAI_AGAIN`), which " +
      "strands the pod holding a concurrency slot. See PEN-5738.",
  );
  lines.push("");
  lines.push("### What to do");
  lines.push("");
  lines.push("```");
  for (const runId of [...new Set(findings.map((f) => f.runId))]) {
    lines.push(`gh run rerun ${runId} --failed`);
  }
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

// Page one `actions/runs` query. Returns what it got plus whether the server
// said there was more than it returned.
//
// WHY THIS IS PAGINATED, AND WHY IT IS NOT ENOUGH ON ITS OWN (Ally, PEN-5738).
// The first version read ONE page of 100. Measured on this repo: ~1388 runs
// created in 13h, so `per_page=100` covers roughly the last HOUR — which made
// the 12h `fetchPadMinutes` completely inert and DROPPED THE MOTIVATING CASE.
// A run created 3h38m ago (the PR #3444 shape the padding exists for) was never
// listed, never became a candidate, and `fetchTruncated` stayed `false`, so the
// scan reported a clean census. That is precisely the "quiet is the dangerous
// reading" failure this file warns about, built into the fetch.
function listRunsPage(repo, query, maxPages) {
  const runs = [];
  let totalCount = null;
  let pagesExhausted = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const res = ghApi(`/repos/${repo}/actions/runs?per_page=100&page=${page}&${query}`);
    if (totalCount === null && Number.isFinite(res.total_count)) totalCount = res.total_count;
    const batch = res.workflow_runs ?? [];
    runs.push(...batch);
    // A short page is the end of the result set. This is OUR criterion and it
    // is sound; see below for why the server's own count is not.
    if (batch.length < 100) break;
    if (page === maxPages) pagesExhausted = true;
  }

  // TRUNCATION IS `pagesExhausted` ALONE — DELIBERATELY NOT `runs.length <
  // total_count`.
  //
  // That comparison looks like the obvious check and it is WRONG on this
  // endpoint: GitHub's run index is not self-consistent across filters, so
  // `total_count` can exceed the rows the same query actually returns on a
  // single, complete, non-truncated page. Measured here 2026-11-06:
  //
  //     status=in_progress   returned 8    total_count 9     <-- skew
  //     status=queued        returned 12   total_count 12
  //     status=failure       returned 78   total_count 78
  //
  // Using it as the truncation signal pinned `fetchTruncated` true on every
  // scan, which means exit 2 and a RED SCHEDULED RUN every cycle — an alarm
  // that is red by design is one everybody learns to ignore, which would
  // destroy this detector's only job. This repo already has prior art for the
  // same inconsistency: see the `total_count` cross-check and the "run index is
  // not self-consistent across filters (BLO-38286)" case in
  // scripts/check-scheduled-guard-liveness.mjs.
  //
  // The skew is still REPORTED rather than swallowed: it is real information
  // about the index, and a large gap would mean something different from a
  // one-row wobble. It just is not allowed to claim truncation on its own.
  const indexSkew = totalCount !== null && runs.length < totalCount ? totalCount - runs.length : 0;
  if (indexSkew > 0) {
    console.error(
      `unreported-job-failure-detector: index skew on \`${query}\` — server reported ` +
        `total_count=${totalCount}, the walk returned ${runs.length}. Not treated as truncation ` +
        `(BLO-38286 shape); see listRunsPage.`,
    );
  }
  return { runs, totalCount, indexSkew, truncated: pagesExhausted };
}

function loadLive(args, windowStartMs, nowMs) {
  const padMs = args.fetchPadMinutes * 60 * 1000;
  const created = `${new Date(windowStartMs - padMs).toISOString()}..${new Date(nowMs + 60_000).toISOString()}`;
  const createdQuery = `created=${encodeURIComponent(created)}`;

  // EVERY ARM IS SERVER-SIDE FILTERED. The first version listed the whole
  // `created` window and filtered client-side, which does not work at this
  // repo's volume and failed in the worst direction. Measured 2026-11-06:
  //
  //     runs created in the last 13h ............. 1375
  //     ...of those `conclusion: success` .........  467   cannot hold a failure
  //     ...of those `conclusion: failure` ..........  55
  //     live now (`in_progress` + `queued`) ........  19
  //
  // So the interesting set is ~74 and the listing walked 1375 to find it. One
  // page of 100 covered only the newest hour, which made the 12h
  // `fetchPadMinutes` inert and silently dropped the 3h38m case the padding
  // exists for; paginating the whole window instead blew the candidate cap and
  // exited 2 (red run) on a live dry-run even at `maxRuns: 200`.
  //
  // `status=` on this endpoint accepts a CONCLUSION as well as a status, which
  // is what makes the narrow query possible:
  //
  //   ARM 1  in_progress / queued  — live runs, UNBOUNDED by `created`. The
  //          correctness arm: a run still running can already contain a job
  //          GitHub concluded `failure`, which IS the PEN-5738 shape (7 jobs
  //          queued 3h38m behind two already-red ones). Unbounded because the
  //          whole point is a run that has been alive far longer than the
  //          report window, and it is cheap precisely because it is bounded by
  //          what is actually running rather than by time.
  //
  //   ARM 2  failure / timed_out, within `created` — completed runs that can
  //          still hold a false red. A run GitHub concluded `success` contains
  //          no job concluded `failure`, so fetching its jobs is pure cost.
  //
  // KNOWN SENSITIVITY LIMIT, stated rather than hidden: a job marked
  // `continue-on-error` can conclude `failure` inside a run that concludes
  // `success`, and arm 2 will not look there. That is a deliberate trade — such
  // a job does not render as a blocking red, so it cannot cause the
  // debug-the-wrong-thing harm this detector exists to prevent — but it IS a
  // coverage gap, not a proof of absence.
  const arms = [
    { query: "status=in_progress", dated: false },
    { query: "status=queued", dated: false },
    { query: "status=failure", dated: true },
    { query: "status=timed_out", dated: true },
  ];

  const byId = new Map();
  let fetchTruncated = false;
  for (const arm of arms) {
    const got = listRunsPage(args.repo, arm.dated ? `${arm.query}&${createdQuery}` : arm.query, args.maxPages);
    fetchTruncated = fetchTruncated || got.truncated;
    for (const run of got.runs) byId.set(run.id, run);
  }

  const candidates = [...byId.values()].filter((r) => runMayContainWindowFailure(r, windowStartMs));
  if (candidates.length > args.maxRuns) fetchTruncated = true;

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

// There is a read-then-write race here and it is REACHABLE, not theoretical
// (Ally, PEN-5738): the workflow deliberately carries no `concurrency` group —
// see the header, cancelling a queued scan loses the verdict exactly when a
// backlog makes it most valuable — so when an `arc-paperclip-light` backlog
// drains, several queued scans start together, all see no marker, and all POST.
//
// It is resolved AFTER the fact rather than prevented, because the lock that
// would prevent it is the `concurrency` group we are deliberately not taking.
// Post first (never lose the verdict), then converge: if more than one comment
// now carries this marker, the lowest id is canonical and the rest are the
// race's debris. Deleting them is best-effort — a permission failure degrades
// to a duplicated comment, which is the pre-existing behaviour and strictly
// better than throwing away a finding.
function reconcileDuplicates({ repo, prNumber, marker }) {
  const mine = listIssueComments(repo, prNumber)
    .filter((c) => (c.body ?? "").includes(marker))
    .sort((a, b) => a.id - b.id);
  for (const dup of mine.slice(1)) {
    try {
      ghApi(`/repos/${repo}/issues/comments/${dup.id}`, ["-X", "DELETE"]);
      console.log(`unreported-job-failure-detector: removed duplicate comment ${dup.id} on #${prNumber}`);
    } catch (err) {
      console.error(
        `unreported-job-failure-detector: could not remove duplicate comment ${dup.id}: ${err.message}`,
      );
    }
  }
  return mine.length;
}

function upsertComment({ repo, prNumber, headSha, body }) {
  const marker = commentMarkerFor(headSha);
  const existing = listIssueComments(repo, prNumber).find((c) => (c.body ?? "").includes(marker));
  const args = ["-X", existing ? "PATCH" : "POST", "-f", `body=${body}`];
  const path = existing
    ? `/repos/${repo}/issues/comments/${existing.id}`
    : `/repos/${repo}/issues/${prNumber}/comments`;
  ghApi(path, args);
  if (!existing) {
    const seen = reconcileDuplicates({ repo, prNumber, marker });
    if (seen > 1) return "created (raced; duplicates reconciled)";
  }
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

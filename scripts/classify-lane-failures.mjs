// BLO-28999: tell an ARC mid-job runner kill apart from a genuine lane failure.
//
// The `verify` job aggregates upstream lanes using only `needs.<lane>.result`.
// When the ARC pool kills a runner mid-job, GitHub records the job's
// `conclusion` as `failure` — NOT `cancelled` — so the killed lane lands in
// `failed_lanes` and `verify` reports "Upstream lane(s) reported failure",
// laundering an infrastructure interruption into something that reads as a
// defect in the PR's diff. `needs.<lane>.result` carries no signal that can
// distinguish the two, so this script goes back to the Actions API for the
// per-job detail the aggregator cannot see.
//
// Two independent signals, either of which is sufficient:
//
//   1. A `failure`-level annotation whose message is a known runner-loss
//      string ("The operation was canceled.", "The runner has received a
//      shutdown signal.", "lost communication with the server").
//   2. The job concluded `failure` but NO step concluded `failure`.
//
// Signal 2 alone is not enough, and the asymmetry matters: an empty failing-step
// set reliably means an abort, but a NON-empty one means nothing. On runner loss
// the in-flight step can be marked `failure` with its paired `Post <step>`
// `cancelled`, so which steps appear is a timing artifact rather than a property
// of the diff. That is why signal 1 is checked independently rather than as a
// tie-breaker — verified against run 32268626936, where all three killed lanes
// carried "The operation was canceled." AND an empty failing-step set, while
// genuine failures (e2e job 96224412919, policy job 96228076444) carried
// "Process completed with exit code 1." and a non-empty one.
//
// One case defeats both signals and is therefore handled as an override ahead
// of them: a `timeout-minutes` expiry, which GitHub renders in the same shape as
// a kill. See JOB_TIMEOUT_PATTERNS below.
//
// Deliberately NOT in scope: re-running the killed lane. This labels the
// outcome; it does not change the gate. `verify` still exits non-zero either
// way — a PR is never merged on the strength of an infrastructure kill.

const RUNNER_LOSS_PATTERNS = [
  /the operation was canceled\./i,
  /the runner has received a shutdown signal/i,
  /lost communication with the server/i,
  /the self-hosted runner.*lost communication/i,
];

// A `timeout-minutes` expiry is NOT a pool kill, and it is invisible to both
// signals above because it presents in exactly the same shape: GitHub cancels
// the job, records `conclusion: failure`, emits "The operation was canceled."
// (matching signal 1) and leaves the in-flight step at a non-`failure`
// conclusion (matching signal 2). The two signals are independent in general
// but not here — they agree on the wrong answer.
//
// Every lane in pr.yml sets a timeout (general_tests 90m, typecheck 40m,
// build 20m), so a hung, deadlocked or pathologically slow test introduced by
// the diff would otherwise be announced as "KILLED MID-JOB by the CI runner
// pool… not a defect in this PR's diff… Re-run the job" — inverting this
// script's purpose and turning a real red into an invitation to re-run
// forever. Not hypothetical here: a degraded npm registry already converted a
// fast red into a `policy` timeout once (BLO-28813).
//
// Job-level only. `pr.yml` sets `timeout-minutes` on the job, and that is the
// shape this string matches. A STEP-level `timeout-minutes` renders
// differently: it leaves the timed-out step at `failure`, so signal 2 declines
// to excuse it and no override is needed — but signal 1 would still fire if the
// runner also emitted a cancellation annotation. No lane sets a step-level
// timeout today (the only one in the file is verify's own classify bound, which
// is never classified), so nothing is broken. A future step-level timeout on a
// lane would need its own pattern here.
const JOB_TIMEOUT_PATTERNS = [/has exceeded the maximum execution time/i];

/**
 * Classify a single Actions job as an infrastructure kill or a real failure.
 *
 * `annotations` distinguishes two states that must not be conflated:
 *   - `[]`    — queried successfully, the job carries no failure annotation.
 *               Evidence of absence; the signals below decide.
 *   - `null`  — could NOT be queried (403, rate limit, 5xx). Absence of
 *               evidence, and NOT usable as a negative result.
 *
 * The default is `null`, the SAFE state, so omitting the argument cannot assert
 * a negative result the caller never obtained. `[]` as the default would make
 * the permissive reading the one you get by accident: a one-argument call on a
 * timed-out job would take signal 2 and answer `infrastructure`, the exact
 * misattribution the guard below exists to prevent. Every call site passes the
 * argument explicitly today, which is why this costs nothing to get right now.
 *
 * @param {{conclusion?: string, steps?: Array<{conclusion?: string}>}} job
 * @param {Array<{annotation_level?: string, message?: string}> | null} annotations
 * @returns {"infrastructure" | "reported"}
 */
export function classifyJobFailure(job, annotations = null) {
  if (job?.conclusion !== "failure") return "reported";

  // Everywhere else in this script, missing evidence keeps the ordinary failure
  // wording (see the no-matching-job branch in classifyLaneFailures). Here that
  // rule is load-bearing rather than merely consistent: the timeout override is
  // reachable ONLY through the annotations, so treating an unavailable set as
  // an empty one silently disarms it — and signal 2 then answers
  // `infrastructure` for every timed-out job, because a job-level timeout
  // leaves the in-flight step `cancelled` and the rest `skipped`, i.e. with no
  // failing step at all. That is the one place the fail-safe direction inverts:
  // for a kill, degrading to signal 2 is safe; for a timeout it produces
  // exactly the misattribution this script exists to prevent, and it does so
  // when the pool is degraded and these API calls are least reliable. So
  // decline to excuse a kill we cannot prove, rather than risk excusing a
  // timeout we cannot see.
  if (!Array.isArray(annotations)) return "reported";

  const failureAnnotations = annotations.filter(
    (annotation) => annotation?.annotation_level === "failure",
  );

  // Consulted BEFORE either signal, and deliberately an override rather than a
  // tie-breaker: signal 2 fires on an empty failing-step set ALONE, so a
  // timeout would still be excused no matter how the two signals were weighed
  // against each other. Same asymmetry argument that makes signal 1
  // independent rather than a tie-breaker.
  const timedOut = failureAnnotations.some((annotation) =>
    JOB_TIMEOUT_PATTERNS.some((pattern) => pattern.test(annotation?.message ?? "")),
  );
  if (timedOut) return "reported";

  const runnerLoss = failureAnnotations.some((annotation) =>
    RUNNER_LOSS_PATTERNS.some((pattern) => pattern.test(annotation?.message ?? "")),
  );
  if (runnerLoss) return "infrastructure";

  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const hasFailingStep = steps.some((step) => step?.conclusion === "failure");
  if (!hasFailingStep) return "infrastructure";

  return "reported";
}

/**
 * A lane's `name:` in pr.yml may interpolate matrix values, e.g.
 * `General tests (${{ matrix.group_label }})`. The static prefix before the
 * first `${{` is what identifies the lane; GitHub renders matrix jobs as
 * `<prefix> (<value>)`. Match the bare name or that parenthesized expansion,
 * so a matrix lane is recognized without hardcoding its shard labels.
 */
export function jobBelongsToLane(jobName, laneJobName) {
  if (typeof jobName !== "string" || typeof laneJobName !== "string") return false;
  if (jobName === laneJobName) return true;
  return jobName.startsWith(`${laneJobName} (`);
}

/**
 * Decide, for each named lane, whether every failed job backing it was an
 * infrastructure kill.
 *
 * A matrix lane fans out to several jobs. It is reported as infrastructure only
 * when EVERY failing job under it was killed — if any shard failed for a real
 * reason, the lane keeps the unchanged failure wording. Conflating them in that
 * direction would let a genuine defect hide behind a coincidental kill.
 *
 * @returns {{infrastructure: string[], reported: string[]}}
 */
export function classifyLaneFailures({ lanes, laneJobNames, jobs, annotationsByJobId = {} }) {
  // `lanes` and `laneJobNames` are paired by index. A length mismatch means the
  // caller built them out of step — every lane would then be matched against
  // some other lane's job name, match nothing, and fall through to the
  // fail-safe branch, silently disabling runner-kill detection while still
  // looking like it worked. Refuse loudly instead; main() turns any throw into
  // the empty set, which degrades to the pre-existing wording.
  if (!Array.isArray(lanes) || !Array.isArray(laneJobNames) || lanes.length !== laneJobNames.length) {
    throw new Error(
      `lanes (${lanes?.length}) and laneJobNames (${laneJobNames?.length}) must be paired by index`,
    );
  }

  const infrastructure = [];
  const reported = [];

  for (const [index, lane] of lanes.entries()) {
    const laneJobName = laneJobNames[index];
    const failingJobs = jobs.filter(
      (job) => job?.conclusion === "failure" && jobBelongsToLane(job?.name, laneJobName),
    );

    // No job matched — the lane result said `failure` but we cannot see why.
    // Fail safe: keep the existing failure wording rather than excusing a
    // failure we have no evidence was infrastructural.
    if (failingJobs.length === 0) {
      reported.push(lane);
      continue;
    }

    const allKilled = failingJobs.every(
      // `?? null`, NOT `?? []`: a job with no entry in the map is a job whose
      // annotations we never obtained, which classifyJobFailure must be able to
      // tell apart from a job that genuinely had none.
      (job) => classifyJobFailure(job, annotationsByJobId[job.id] ?? null) === "infrastructure",
    );
    (allKilled ? infrastructure : reported).push(lane);
  }

  return { infrastructure, reported };
}

async function githubJson(pathname, token, repository) {
  const response = await fetch(`https://api.github.com/repos/${repository}${pathname}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${pathname} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function main() {
  const lanes = process.argv.slice(2).filter(Boolean);
  if (lanes.length === 0) {
    process.stdout.write("\n");
    return;
  }

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const laneJobNames = (process.env.LANE_JOB_NAMES ?? "")
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);

  if (!token || !repository || !runId) {
    throw new Error(
      "classify-lane-failures needs GH_TOKEN/GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_RUN_ID",
    );
  }

  const jobs = [];
  // Structurally bounded rather than dependent on the API always returning a
  // short final page: 20 pages × 100 is far above any plausible run size, and a
  // pathological response can no longer spin here forever.
  const MAX_JOB_PAGES = 20;
  for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
    const payload = await githubJson(
      `/actions/runs/${runId}/jobs?per_page=100&page=${page}&filter=latest`,
      token,
      repository,
    );
    jobs.push(...(payload.jobs ?? []));
    if ((payload.jobs ?? []).length < 100) break;
  }

  const annotationsByJobId = {};
  for (const job of jobs.filter((candidate) => candidate.conclusion === "failure")) {
    try {
      annotationsByJobId[job.id] = await githubJson(
        `/check-runs/${job.id}/annotations`,
        token,
        repository,
      );
    } catch (error) {
      // `null`, not `[]`: the annotations are one of two independent signals,
      // but they are the ONLY route to the timeout override, so an unreadable
      // set must not read downstream as "this job did not time out". `actions:
      // read` and `checks: read` are distinct scopes, so the jobs call above
      // can succeed while this one 403s. classifyJobFailure keeps the ordinary
      // failure wording for these.
      annotationsByJobId[job.id] = null;
      // Say so on stderr: pr.yml turns any output here into the "lane
      // classifier degraded" warning, so a silent catch would hide a
      // systematically degraded classifier behind a normal-looking verdict.
      process.stderr.write(
        `classify-lane-failures: annotations unavailable for job ${job.id} (${job.name ?? "unnamed"}), keeping the ordinary failure wording: ${error.message}\n`,
      );
    }
  }

  const { infrastructure } = classifyLaneFailures({
    lanes,
    laneJobNames,
    jobs,
    annotationsByJobId,
  });
  process.stdout.write(`${infrastructure.join(" ")}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // Never let a classification problem change the gate. `verify` fails on the
    // lane results themselves; this script only decides which WORDING explains
    // them. Emitting an empty set degrades to today's behaviour.
    process.stderr.write(`classify-lane-failures: ${error.message}\n`);
    process.stdout.write("\n");
  });
}

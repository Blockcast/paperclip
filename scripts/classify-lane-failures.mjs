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
// Three independent signals, any of which is sufficient:
//
//   1. A `failure`-level annotation whose message is a known runner-loss
//      string ("The operation was canceled.", "The runner has received a
//      shutdown signal.", "lost communication with the server").
//   2. The job concluded `failure` but NO step concluded `failure`.
//   3. The job never reached its own body: every step the workflow declares is
//      `skipped`, and the only steps that failed are runner setup whose failure
//      the diff cannot have caused. See EXCUSABLE_SETUP_FAILURE_STEP_NAMES.
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
// That asymmetry is correct for a kill mid-body, and it is exactly what leaves
// signal 3 with work to do (PEN-3583). When the runner dies BEFORE the body
// starts, the failing step is the runner setup itself, so the failing-step set
// is non-empty and signal 2 declines; and the annotation is "Process completed
// with exit code 130." rather than a cancellation string, so signal 1 declines
// too. Measured: run 36303595922 attempt 2, job 108655477890 ("General tests
// (workspaces-b)") — `Set up runner` `failure`, every declared step `skipped`,
// no repository checked out, no dependency installed, not one test run, and
// `verify` still announced it as something that "may reflect a real problem
// with the PR diff".
//
// One case defeats both signals and is therefore handled as an override ahead
// of them: a `timeout-minutes` expiry, which GitHub renders in the same shape as
// a kill. See JOB_TIMEOUT_PATTERNS below.
//
// Deliberately NOT in scope: re-running the killed lane. This labels the
// outcome; it does not change the gate. `verify` still exits non-zero either
// way — a PR is never merged on the strength of an infrastructure kill.

// Exported so the tests can assert against THIS set rather than a hand-copied
// transcription of it. A falsification guard that proves "signal 1 declines on
// this fixture" is only worth the line it occupies if it is checking the
// patterns the module actually uses; a copy silently stops being that set the
// first time one is added here, and would then assert the opposite of the truth
// while still passing.
export const RUNNER_LOSS_PATTERNS = [
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
// Every lane in pr.yml sets a timeout (general_tests 110m for the server
// shards and 75/45m for workspaces-a/-b, typecheck 50m, build 25m — all
// re-sized against measured p100 by BLO-33313; read the file, do not trust
// these numbers to stay current), so a hung, deadlocked or pathologically slow
// test introduced by
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

// PEN-3583, signal 3. GitHub wraps every job in synthetic steps it owns rather
// than the workflow: `Set up job` and `Set up runner` run before the first
// declared step, and `Complete job` runs after the last one. Everything else in
// `steps` is the job BODY — the steps `pr.yml` actually declares.
//
// The two sets are split because they are load-bearing in opposite directions.
// A failure confined to the pre-body set means the lane died before it could
// read anything the PR wrote; the postamble is merely excluded from the
// all-skipped test below, because GitHub runs `Complete job` even on a job that
// died in setup and marks it `success`. That is the trap in this shape: the
// measured job's steps are NOT "all skipped after checkout" — steps 3-9 are
// skipped and step 10 `Complete job` is `success` — so a rule phrased as "every
// step from checkout onward is skipped" matches nothing and the signal is born
// inert. Matching on the declared body only is what makes it fire.
//
// Names identify these steps, but POSITION decides which ones are synthetic.
// GitHub runs its preamble before the first declared step and its postamble
// after the last one, so the preamble is the LEADING run of steps carrying
// these names and the postamble the TRAILING run — see `jobBodySteps` below. A
// step the workflow declares under one of these names anywhere after the body
// has started therefore stays IN the body, where its failure defeats the
// all-skipped test on its own.
//
// Names are still needed because indices alone will not do: a step's position
// moves whenever `pr.yml` gains or loses a step. These three names are
// GitHub's own and stable across lanes.
//
// The pre-body preamble is NOT always these two steps, and this set
// deliberately does not chase the third. A job declaring `container:` / `services:` gets an
// `Initialize containers` step of its own — measured, not inferred:
// `postgres-tests (heavy 3/4)` in `Blockcast/penstock-llm-proxy-core` (job
// 104214352274) renders `Set up job`, `Set up runner`, `Initialize
// containers`, then its own declared steps. That name is absent here on
// purpose; what it costs is worked through in the scope note on signal 3.
//
// A container lane's POSTAMBLE is likewise two steps, and that one IS chased.
// The same measured job renders `24:Stop containers` before `25:Complete job`,
// and on cancelled container jobs 100900589400 / 100896100309 in that repo
// `98:Stop containers` concludes `success` while the declared steps around it
// are `skipped` — it runs regardless of how the job ended, exactly like
// `Complete job`. Left out of this set it would land in `bodySteps` at a
// non-`skipped` conclusion and defeat the all-skipped test on its own: the
// `Complete job` trap described above, reproduced one step over, and it would
// make the verdict for every container lane hinge on how GitHub renders that
// step for a pre-body kill — which nobody has measured, because a container
// lane killed before `Initialize containers` has not been observed. Naming it
// here makes the answer the same under BOTH renderings, so the unmeasured
// branch stops deciding anything.
//
// The two container steps are treated oppositely on purpose, and the asymmetry
// is the same one that splits the sets above. `Initialize containers` stays in
// the body because a bad image is diff-controlled and MUST defeat the signal;
// `Stop containers` is postamble because it is GitHub's own teardown, carries
// nothing the diff can influence, and is only ever excluded from the
// all-skipped test — never from the failing-step test, which reads the raw
// step list. So a declared step colliding with `Stop containers` in the
// TRAILING position is not the unsafe residual the preamble has: the name is
// absent from EXCUSABLE_SETUP_FAILURE_STEP_NAMES, so its failure still forces
// `reported`.
//
// The residual collision is narrow but real, and it runs in the UNSAFE
// direction. A workflow whose FIRST declared step is named `Set up runner` is
// absorbed into the leading run, and — because that name is also in
// EXCUSABLE_SETUP_FAILURE_STEP_NAMES below — a failure there with the rest of
// the body skipped is excused as a pool kill: a defect the diff really did
// introduce, announced as infrastructure. That is this script's purpose
// inverted, the same failure mode the `timeout-minutes` override exists to
// prevent.
//
// It is NOT self-limiting, and an earlier revision of this comment claimed it
// was — wrongly, and in the unsafe direction. The colliding step is excused
// precisely WHEN IT FAILS: it is absorbed into the preamble by name and lands
// in the excusable set, so it never has to be `skipped`. Rename rather than
// reintroduce one — the reason being that the FAILING case is the dangerous
// one, not the skipped one.
//
// Nothing declares any of these names today, checked at this commit across
// `.github/workflows/` AND `.github/actions/**`: a composite action's steps
// render into the calling job's step list too, so both directories are the same
// surface and a check that looks at only one of them is incomplete.
const PRE_BODY_SETUP_STEP_NAMES = new Set(["set up job", "set up runner"]);
const RUNNER_POSTAMBLE_STEP_NAMES = new Set(["stop containers", "complete job"]);

// Which pre-body FAILURE is excusable — a strictly narrower question than which
// steps are synthetic, and the two must not share a set.
//
// `Set up job` is synthetic (so it belongs in the body exclusion above) but its
// failure is NOT excusable, because it is where GitHub resolves remote action
// references — and those are diff-controlled. `pr.yml` carries eight distinct
// ones at this commit (`actions/checkout@v6`, `actions/setup-node@v6`,
// `actions/setup-python@v5`, `actions/cache@v4`, `actions/upload-artifact@v4`
// and `@v7`, `actions/download-artifact@v4`, `azure/setup-helm@v4` — a count
// that will rot, so re-grep rather than trusting it), so a PR that bumps one to
// a ref that does not exist fails in setup for a reason entirely its own.
// Excusing that would announce a defect the PR really did introduce as a pool
// kill — this script's purpose inverted, which is the same failure mode the
// `timeout-minutes` override exists to prevent. Same class as the `container:` /
// `services:` caveat below; action resolution is simply the instance that is
// live today rather than hypothetical.
//
// `Set up runner` is what the measured instance needed and all it needed: in
// run 36303595922 attempt 2, `Set up job` was `success`. So this narrowing
// preserves that instance exactly while removing the wider reading. It also
// errs in the safe direction — an unexcused infrastructure failure merely keeps
// today's wording, whereas an excused diff defect is a red turned into an
// invitation to re-run forever.
const EXCUSABLE_SETUP_FAILURE_STEP_NAMES = new Set(["set up runner"]);

const normalizedStepName = (step) =>
  typeof step?.name === "string" ? step.name.trim().toLowerCase() : "";

/**
 * The steps a job's workflow actually DECLARED — everything between GitHub's
 * synthetic preamble and its synthetic postamble.
 *
 * Positional rather than by set membership, because "synthetic" is a fact about
 * WHERE a step runs, not what it is called. Filtering the whole step list by
 * name pulled a DECLARED step named `Set up runner` out of the body from any
 * position, so its failure both vanished from the all-skipped test below and
 * satisfied `EXCUSABLE_SETUP_FAILURE_STEP_NAMES` — the step name alone flipped a
 * real diff failure to `infrastructure`. Bounding the match to the leading and
 * trailing runs keeps a later collision inside the body, where a `failure`
 * conclusion defeats the signal on its own with no name-matching involved.
 *
 * @param {Array<{name?: string, conclusion?: string}>} steps
 */
function jobBodySteps(steps) {
  // Reading position rather than name makes ARRAY ORDER load-bearing, where the
  // previous whole-list name filter was order-independent. The API returns
  // steps in `number` order and every step carries the field, so this sort is a
  // no-op against real input — it retires the assumption instead of relying on
  // it, and pins it by test.
  //
  // Guarded on the key being present throughout rather than sorted
  // unconditionally: a comparator returning NaN is specified to compare EQUAL
  // (`SortCompare`), so a partially-numbered list would not throw, it would
  // interleave silently. With the key absent we keep declaration order, which
  // is exactly the behaviour this replaces.
  const ordered = steps.every((step) => Number.isFinite(step?.number))
    ? steps.slice().sort((a, b) => a.number - b.number)
    : steps;

  let start = 0;
  while (
    start < ordered.length &&
    PRE_BODY_SETUP_STEP_NAMES.has(normalizedStepName(ordered[start]))
  ) {
    start += 1;
  }
  let end = ordered.length;
  while (end > start && RUNNER_POSTAMBLE_STEP_NAMES.has(normalizedStepName(ordered[end - 1]))) {
    end -= 1;
  }
  return ordered.slice(start, end);
}

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

  // Signal 3 (PEN-3583): the job never reached its own body.
  //
  // Sound on a stronger ground than either signal above. Those two infer an
  // interruption from how the wreckage LOOKS — an annotation string, or a step
  // shape that a kill happens to leave behind. This one reads a property of the
  // lane: a job whose every declared step is `skipped` never checked out a
  // repository, never installed a dependency and never ran a test, so it cannot
  // have OBSERVED the diff, and a lane that did not observe the diff cannot be
  // evidence about it. That holds whatever killed the runner, so no annotation
  // string needs to be enumerated in advance.
  //
  // Deliberately NOT matched on the exit code, though the measured instance
  // carries "Process completed with exit code 130." (SIGINT, 128+2) and that is
  // already distinguishable from the "exit code 1." of a genuine failure. A test
  // process may legitimately exit on a signal — a suite that shells out to
  // something killed by the OOM killer exits 137 — so an exit code is a fact
  // about one process at one moment, whereas "nothing the workflow declared
  // ever ran" is a property of the whole lane. Structural, not a timing artifact.
  //
  // Disjoint from the `timeout-minutes` override in two independent ways, and
  // the ordering is the one that does not depend on being right about the shape:
  // the override returns above, so it wins positionally whatever the steps look
  // like (asserted by test, with a fixture carrying this exact shape AND a
  // timeout annotation). Separately, a job-level expiry leaves the in-flight
  // step `cancelled` and the steps BEFORE it `success` — TIMED_OUT_JOB's
  // `Checkout repository` is `success` — so it fails the all-skipped test here
  // as well. The second fact is the one BLO-28813/BLO-33313 care about; the
  // first is what keeps it true if GitHub ever renders a timeout differently.
  //
  // Scope caveat, in the spirit of the step-level-timeout note above: this
  // excuses a lane only for a diff that cannot reach the failing setup step.
  // `Set up job` resolves diff-controlled action refs and is excluded from the
  // excusable set for exactly that reason (see above), which leaves `Set up
  // runner` as the only excusable failure.
  //
  // An earlier revision of this note claimed `Set up runner` consumes a
  // workflow's `container:` / `services:` block, and that a lane gaining one
  // would need excluding here. Both are wrong, and in the direction that
  // invents work rather than hides exposure. GitHub gives that block a step of
  // its own, `Initialize containers`, AFTER the preamble — measured on
  // `postgres-tests (heavy 3/4)` in `Blockcast/penstock-llm-proxy-core` (job
  // 104214352274). It is in neither name set, so it lands in `bodySteps` and
  // needs no exclusion: a bad image fails THERE, at a non-`skipped`
  // conclusion, which defeats the all-skipped test, and `Initialize
  // containers` is not in EXCUSABLE_SETUP_FAILURE_STEP_NAMES either. Two
  // independent grounds to decline, both automatic.
  //
  // A previous revision then stopped one step short, and asserted the rest.
  // It said that on a genuine pre-body kill the container step "should be
  // `skipped` alongside the declared steps, leaving this signal firing
  // correctly" — inferred, and inferred about the wrong step. The lane's
  // teardown step `Stop containers` decided the verdict, not `Initialize
  // containers`: it was in neither name set, so it landed in `bodySteps`, and
  // it concludes `success` on a job that ended without running its body
  // (measured on cancelled jobs 100900589400 / 100896100309 in that repo). A
  // container lane therefore classified as `reported` under that rendering and
  // `infrastructure` under the other, with nobody having measured which one a
  // pre-body kill produces — the whole verdict resting on the unmeasured half.
  //
  // That conditional is now removed rather than documented, which is the same
  // move `jobBodySteps` makes on the preamble: `Stop containers` is named in
  // RUNNER_POSTAMBLE_STEP_NAMES, so it is excluded from the all-skipped test
  // whichever way it renders and the signal fires identically under both
  // (asserted by test, over both renderings). The residual inference is now
  // confined to `Initialize containers` alone, where it is safe in the sense
  // that matters: if GitHub renders a killed container step as anything but
  // `skipped`, this signal merely DECLINES and the failure keeps today's
  // wording. No lane in `pr.yml` declares `container:` or `services:` today
  // (checked at this commit), so none of this is live.
  const bodySteps = jobBodySteps(steps);
  const everyFailureIsExcusableSetup = steps
    .filter((step) => step?.conclusion === "failure")
    .every((step) => EXCUSABLE_SETUP_FAILURE_STEP_NAMES.has(normalizedStepName(step)));
  // `bodySteps.length > 0` guards against the vacuous read: a job we cannot see
  // any declared step for has not been SHOWN to have skipped its body, and
  // `every` on an empty array would answer `true` and excuse it anyway.
  if (
    bodySteps.length > 0 &&
    bodySteps.every((step) => step?.conclusion === "skipped") &&
    everyFailureIsExcusableSetup
  ) {
    return "infrastructure";
  }

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

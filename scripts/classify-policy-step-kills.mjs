// BLO-32682: tell a `policy` STEP-timeout kill apart from an assertion failure.
//
// When a `policy` step is killed by its step-level `timeout-minutes`, the log
// carries only:
//
//   ##[error]The action 'Test approval admissibility-probe backoff (BLO-28471)'
//   has timed out after 1 minutes.
//
// with no test output, no elapsed time, and nothing saying the kill was a
// DURATION kill rather than a failed assertion. In the checks UI that is
// indistinguishable from "your diff broke this test", which is what sent the
// author of #1707 hunting in the wrong file on 2026-09-07.
//
// This script reads the killed step back off the Actions API and re-emits it as
// a GitHub annotation that says so in as many words, visible without opening the
// raw log.
//
// ---------------------------------------------------------------------------
// Why the annotation, and NOT the step duration
// ---------------------------------------------------------------------------
//
// The obvious detector is arithmetic: a step whose elapsed time equals its
// budget was killed by the clock. It does not survive contact with the data.
// On the banked kill (run 34154564717 attempt 1, job 101843653563, commit
// a759f828) the step was bounded at 60s and ran for SEVENTY-THREE seconds:
//
//   started_at 2026-09-07T19:18:15Z -> completed_at 2026-09-07T19:19:28Z
//
// GitHub sends the kill at the bound and then bills the teardown, so elapsed
// OVERSHOOTS the budget by an unbounded margin under load. Any "elapsed is
// within N seconds of budget" rule is picking N against pool weather; too tight
// and it misses real kills (13s of overshoot here), too loose and it starts
// claiming that a genuine failure near its bound was a flake.
//
// GitHub already states the verdict directly. `The action '<step>' has timed
// out after <n> minutes.` is emitted BY the timeout path and by nothing else,
// and it names the step and the enforced budget. So duration is not the signal
// here — it is only enrichment, reported because "killed at 73s under a 60s
// bound" is the number a reader needs and the raw log never prints.
//
// ---------------------------------------------------------------------------
// Why the pattern is anchored, and not a substring
// ---------------------------------------------------------------------------
//
// A killed step emits BOTH `Process completed with exit code 1.` AND the
// timeout line (verified on the banked job), so the exit-code annotation cannot
// be read as "this was a real failure" — the timeout line has to win.
//
// The converse trap is sharper, and is why TIMEOUT_PATTERN is anchored to
// GitHub's exact phrasing rather than matching /timed out/ anywhere. A real
// assertion failure in the same run (job 101872142739) carried:
//
//   Caused by: Error: productivity review wake enqueue row-lock replay timed
//   out after 1000ms
//
// A substring match on "timed out after" relabels that genuine defect as an
// infrastructure flake — the one outcome that makes this script worse than not
// having it, because a misattributed red gets re-run instead of fixed. Test
// suites talk about their own timeouts constantly; only the runner emits
// `The action '...' has timed out after <n> minutes.`
//
// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------
//
// This script can never change whether `policy` passes or fails. It is wired
// `continue-on-error: true`, it exits 0 on every path including its own
// internal errors, and it emits annotations only. `policy` is already red by
// the time this runs — this decides only which WORDING explains the red, the
// same division of labour as scripts/classify-lane-failures.mjs.
//
// Deliberately a sibling of that script rather than a mode inside it. They
// answer different questions (which STEP inside one job vs which LANE across
// jobs), consume different payloads, and fail safe in OPPOSITE directions:
// classify-lane-failures must decline to excuse a failure it cannot prove was
// infrastructural, while this one must decline to EMIT when it cannot prove a
// kill. Folding them together would put those two defaults in one control flow.

// The budget group accepts a fraction because `timeout-minutes: 0.5` renders as
// `has timed out after 0.5 minutes.` — an integer-only group misses it. Nothing
// in .github/workflows uses a sub-minute bound today, and a miss is fail-safe,
// but the whole point of BLO-32670 was re-sizing these budgets, so a later edge
// tightening one below a minute is the expected direction of travel.
const TIMEOUT_PATTERN = /^The action '(.+)' has timed out after (\d+(?:\.\d+)?) minutes?\.$/;

/**
 * Escape a workflow-command message. `%`, CR and LF are the three characters
 * that terminate or corrupt a `::error::` line, so an unescaped step name or
 * error string could truncate the annotation it is embedded in.
 */
function escapeCommandValue(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * Elapsed seconds for a step, or `null` when either timestamp is missing or
 * unparseable. `null` is rendered as "unknown" rather than guessed: a wrong
 * duration in the annotation is worse than an absent one, because the whole
 * point of the annotation is to be the number the reader trusts without
 * opening the log.
 */
export function stepElapsedSeconds(step) {
  const started = Date.parse(step?.started_at ?? "");
  const completed = Date.parse(step?.completed_at ?? "");
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return null;
  const elapsed = Math.round((completed - started) / 1000);
  return elapsed >= 0 ? elapsed : null;
}

/**
 * Identify the steps GitHub killed on their step-level `timeout-minutes`.
 *
 * `annotations` distinguishes two states that must not be conflated, the same
 * convention as classify-lane-failures.mjs:
 *   - `[]`   — queried successfully, no annotations. Evidence of absence.
 *   - `null` — could NOT be queried (403, rate limit, 5xx). Absence of
 *              evidence, which here means "emit nothing and say why".
 *
 * The default is `null`, the safe state, so a one-argument call cannot assert a
 * negative the caller never obtained.
 *
 * @param {{annotations?: Array<{annotation_level?: string, message?: string}> | null,
 *          steps?: Array<{name?: string, conclusion?: string, started_at?: string, completed_at?: string}>}} input
 * @returns {{kills: Array<{name: string, budgetMinutes: number, elapsedSeconds: number | null}>,
 *            degraded: string | null}}
 */
export function classifyStepKills({ annotations = null, steps = [] } = {}) {
  if (!Array.isArray(annotations)) {
    return {
      kills: [],
      degraded: "annotations unavailable, cannot tell a step-timeout kill from a test failure",
    };
  }

  const stepList = Array.isArray(steps) ? steps : [];
  const kills = [];

  for (const annotation of annotations) {
    if (annotation?.annotation_level !== "failure") continue;
    const match = TIMEOUT_PATTERN.exec(String(annotation?.message ?? "").trim());
    if (!match) continue;

    const [, name, minutes] = match;
    // Matched by name against the step list only to recover its timestamps. A
    // step that does not match still yields a kill entry with an unknown
    // elapsed time: GitHub has already told us it killed something, and
    // dropping the annotation because we could not enrich it would reintroduce
    // exactly the silence this script exists to break.
    // `findLast`, not `find`: if two steps ever share a name, the later one is
    // the one whose timestamps belong to the kill just reported — the same
    // "prefer the later attempt" instinct selectCurrentJob already encodes.
    // `policy` has no duplicate step names today; this only decides which
    // elapsed time the annotation quotes, and quoting the wrong one would
    // undercut the number the annotation exists to be trusted for.
    const step = stepList.findLast(
      (candidate) => candidate?.name === name && candidate?.conclusion === "failure",
    );
    kills.push({
      name,
      budgetMinutes: Number(minutes),
      elapsedSeconds: step ? stepElapsedSeconds(step) : null,
    });
  }

  return { kills, degraded: null };
}

/**
 * Render the verdict as GitHub workflow commands, one line per annotation.
 *
 * Separated from classification so the test can assert the rendered text
 * without a network round trip, and so the wording is reviewable in one place.
 */
export function renderAnnotations({ kills, degraded }) {
  const lines = [];

  if (degraded) {
    lines.push(
      `::warning title=Step-kill classifier degraded::${escapeCommandValue(
        `${degraded}. The failure above is reported with its ordinary wording; it may or may not be a timeout kill.`,
      )}`,
    );
  }

  for (const kill of kills) {
    const budgetSeconds = kill.budgetMinutes * 60;
    const elapsed =
      kill.elapsedSeconds === null ? "unknown" : `${kill.elapsedSeconds}s`;
    lines.push(
      `::error title=Step timed out (not a test failure)::${escapeCommandValue(
        `'${kill.name}' was KILLED by its step-level timeout-minutes: ${kill.budgetMinutes} ` +
          `(${budgetSeconds}s budget), after running ${elapsed}. This is a DURATION kill, not an ` +
          `assertion failure — the step produced no verdict, so nothing here says your diff is ` +
          `broken. Re-run the job; if it reproduces, the step's budget is too tight for the pool ` +
          `rather than the test being wrong.`,
      )}`,
    );
  }

  return lines;
}

// A hung connection would otherwise be bounded only by the step's
// `timeout-minutes: 3`, spending three minutes of the job's ceiling on a run
// that is already red. Bound it in the script instead. An abort throws, which
// the callers already funnel into a `degraded` warning, so this stays fail-safe.
const REQUEST_TIMEOUT_MS = 20_000;

async function githubJson(pathname, token, repository) {
  const response = await fetch(`https://api.github.com/repos/${repository}${pathname}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GET ${pathname} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// Both paging loops are bounded for the same reason: a pathological response
// must not spin here forever.
const PAGE_SIZE = 100;
const MAX_ANNOTATION_PAGES = 5;
const MAX_JOB_PAGES = 20;

/**
 * Page a GitHub list endpoint, reporting WHICH of the two exits it took.
 *
 * BLO-32753: the cap and a short page used to leave through the same path, so a
 * truncated read was byte-identical to a complete one — `degraded: null`, no
 * warning, a missed kill reported with the ordinary wording. That is the exact
 * silence this script exists to break, and both loops in this file had it.
 * `truncated` is the whole point of this helper: a short page is evidence the
 * server had nothing more, the cap is only evidence that we stopped asking.
 *
 * @param {(page: number) => string} pathFor
 * @param {(payload: unknown) => Array<unknown>} select
 * @returns {Promise<{items: Array<unknown>, truncated: boolean}>}
 */
async function fetchPaged(pathFor, select, maxPages, token, repository) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = select(await githubJson(pathFor(page), token, repository));
    items.push(...batch);
    if (batch.length < PAGE_SIZE) return { items, truncated: false };
  }
  return { items, truncated: true };
}

/**
 * Read every annotation on a check run, not just the first page.
 *
 * The default page size is 30. Every `policy` step carries `if: !cancelled()`,
 * so a red run keeps executing all ~60 steps and each failing one contributes
 * at least `Process completed with exit code 1.` — so past ~30 failing steps
 * the runner's timeout line can fall off page 1. That would both miss the kill
 * AND trip the propagation retry below, whose `some(level === "failure")` test
 * would be evaluated over a truncated page: four wasted seconds and a warning
 * claiming no failure annotation exists, on precisely the run where it did.
 *
 * Returns `{annotations, truncated}` rather than a bare array so the caller can
 * tell a complete read from one that stopped at MAX_ANNOTATION_PAGES. The
 * annotations read BEFORE the cap are still returned and still classified — a
 * truncated read is partial evidence, not no evidence, and dropping a kill line
 * we already hold would reintroduce the silence rather than report it.
 */
export async function fetchAnnotations(jobId, token, repository) {
  const { items, truncated } = await fetchPaged(
    (page) => `/check-runs/${jobId}/annotations?per_page=${PAGE_SIZE}&page=${page}`,
    (payload) => (Array.isArray(payload) ? payload : []),
    MAX_ANNOTATION_PAGES,
    token,
    repository,
  );
  return { annotations: items, truncated };
}

/**
 * Find this workflow's own job in the run. `GITHUB_JOB` is the YAML key, which
 * is the DISPLAY name only for a job that declares no `name:` — so the caller
 * passes the display name explicitly and a test pins the two together.
 *
 * A re-run can leave several jobs sharing the name; prefer the one still
 * `in_progress`, which is necessarily this one, since this script runs as a
 * step inside it.
 */
export function selectCurrentJob(jobs, jobName) {
  const matches = (Array.isArray(jobs) ? jobs : []).filter((job) => job?.name === jobName);
  if (matches.length === 0) return null;
  return matches.find((job) => job?.status === "in_progress") ?? matches[matches.length - 1];
}

/**
 * Exported only so the suite can drive it. Two behaviours live nowhere else:
 * the `payload?.jobs ?? []` selector paging the jobs list, and the precedence
 * that keeps a truncation warning instead of overwriting it with the generic
 * propagation message. Both are reachable only end to end; the `import.meta.url`
 * guard below still decides whether the script self-runs.
 */
export async function main() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const jobName = process.env.POLICY_JOB_NAME || process.env.GITHUB_JOB;

  if (!token || !repository || !runId || !jobName) {
    throw new Error(
      "classify-policy-step-kills needs GH_TOKEN/GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID and POLICY_JOB_NAME",
    );
  }

  const { items: jobs, truncated: jobsTruncated } = await fetchPaged(
    (page) => `/actions/runs/${runId}/jobs?per_page=${PAGE_SIZE}&page=${page}&filter=latest`,
    (payload) => payload?.jobs ?? [],
    MAX_JOB_PAGES,
    token,
    repository,
  );

  const job = selectCurrentJob(jobs, jobName);
  if (!job) {
    // Truncation only matters on THIS branch. If the job was found, pages we
    // never read cannot contain a better match. If it was not, "no job named X"
    // is a negative-existence claim drawn from an admittedly partial read, and
    // saying it outright would be wrong in the one direction that misleads.
    for (const line of renderAnnotations({
      kills: [],
      degraded: jobsTruncated
        ? `job list for run ${runId} was truncated at the ${MAX_JOB_PAGES}-page cap ` +
          `(${MAX_JOB_PAGES * PAGE_SIZE} jobs read), so '${jobName}' may sit past it`
        : `no job named '${jobName}' in run ${runId}`,
    })) {
      process.stdout.write(`${line}\n`);
    }
    return;
  }

  // This script runs as a step INSIDE the job it is reading, so the annotation
  // for a step killed moments ago may not have propagated to the check run yet.
  // An un-propagated annotation is the one degradation that would be SILENT:
  // the query succeeds, returns no timeout line, and the kill is reported with
  // the ordinary wording — the exact bug this script exists to fix.
  //
  // A run step that failed always produces at least one failure-level
  // annotation ("Process completed with exit code 1." at minimum), so a job
  // holding a `failure`-conclusion step while reporting no failure annotations
  // is still propagating rather than genuinely clean. Poll briefly on that
  // signal alone, and say so if it never resolves.
  const hasFailingStep = (Array.isArray(job.steps) ? job.steps : []).some(
    (step) => step?.conclusion === "failure",
  );
  const ANNOTATION_ATTEMPTS = 3;
  const ANNOTATION_RETRY_MS = 2000;

  let annotations = null;
  let degraded = null;
  for (let attempt = 1; attempt <= ANNOTATION_ATTEMPTS; attempt += 1) {
    try {
      // `checks: read`, a DIFFERENT scope from the `actions: read` the jobs
      // call above needs, so this can 403 on its own while the jobs call
      // succeeds.
      const page = await fetchAnnotations(job.id, token, repository);
      annotations = page.annotations;
      // A truncated read is reported even though it succeeded: the kill line
      // may sit on a page we never asked for, so "no kill found" here is not
      // evidence of absence. Overwritten by a later clean attempt, same as any
      // other degradation, because `degraded` is recomputed every attempt.
      degraded = page.truncated
        ? `annotations for job ${job.id} were truncated at the ${MAX_ANNOTATION_PAGES}-page cap ` +
          `(${MAX_ANNOTATION_PAGES * PAGE_SIZE} read), so a timeout line past that point was not seen`
        : null;
    } catch (error) {
      annotations = null;
      degraded = `annotations unavailable for job ${job.id}: ${error.message}`;
    }

    const settled =
      Array.isArray(annotations) &&
      (!hasFailingStep ||
        annotations.some((annotation) => annotation?.annotation_level === "failure"));
    if (settled) break;

    if (attempt < ANNOTATION_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, ANNOTATION_RETRY_MS));
    } else if (!degraded) {
      degraded =
        `job ${job.id} has a failed step but reported no failure annotation after ` +
        `${ANNOTATION_ATTEMPTS} attempts`;
    }
  }

  const verdict = classifyStepKills({ annotations, steps: job.steps });
  for (const line of renderAnnotations({
    kills: verdict.kills,
    degraded: degraded ?? verdict.degraded,
  })) {
    process.stdout.write(`${line}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // Never let a classification problem change the gate, and never let it fail
    // SILENTLY either: a silent degradation is indistinguishable from "nothing
    // was killed", which is the bug this script exists to fix.
    //
    // `|| String(error)` because a thrown value with an empty `message` would
    // otherwise render as a falsy `degraded`, which renderAnnotations correctly
    // treats as "nothing to say" — turning the one path that MUST speak into
    // the silence it is here to prevent.
    const reason = error?.message || String(error);
    for (const line of renderAnnotations({ kills: [], degraded: reason })) {
      process.stdout.write(`${line}\n`);
    }
  });
}

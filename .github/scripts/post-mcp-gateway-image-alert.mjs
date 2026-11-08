#!/usr/bin/env node
/**
 * post-mcp-gateway-image-alert.mjs
 *
 * Reports the health of the mcp-gateway image delivery lane
 * (`docker-mcp-gateway.yml` on master) into Alertmanager, which fans every
 * alert to the paperclip-plugin-alertmanager webhook — so a build that
 * published no image becomes a Paperclip issue in the platform lane instead of
 * a `cancelled` run nobody reads.
 *
 * THE DEFECT (PEN-6034). On 2026-11-07 run 42326582436 built `e079fc2b` for
 * 15m13s against a 15-minute job ceiling and was killed. GitHub records a
 * `timeout-minutes` kill with `conclusion: cancelled` — not `failure`, not
 * `timed_out` — so nothing keyed on `failure` saw it, `sha-e079fc2` was never
 * published, and the only reason anyone noticed is that PEN-5690 happened to
 * re-verify its re-pin target instead of carrying it. A seat that merges a
 * gateway CVE fix and then re-pins a manifest has no signal distinguishing
 * "image published" from "build died".
 *
 * WHAT IS AMBIGUOUS, AND WHAT IS NOT. PEN-6034 states that a timed-out build
 * and a routinely superseded one "cannot be told apart". That is exactly true
 * of the CONCLUSION FIELD and false of the job's check-run annotations, which
 * is why this script reads them. Every `cancelled` job in this workflow's
 * lifetime — all 44 runs, fully paginated back to 2026-05-14 — carries an
 * annotation that names its cause, 4 of 4 with no overlap:
 *
 *   42326582436  e079fc2  "The job has exceeded the maximum execution time of 15m0s"
 *   41562000182  076c01d  "The job has exceeded the maximum execution time of 15m0s"
 *   25984348202  94949fd  "Canceling since a higher priority waiting request for
 *                          docker-mcp-gateway-refs/heads/master exists"
 *   25839436286  21f008f  "The run was canceled forcefully by @kkroo."
 *
 * So the lane is separable: a kill pages, a supersede and a human cancel do
 * not. `cancel-in-progress: true` makes supersession the ordinary case on this
 * workflow, so paging on the bare `cancelled` conclusion would be unusable
 * noise — and a noisy alert gets muted, which reproduces the silence this
 * script exists to end.
 *
 * THIS IS THE SECOND HALF OF THE FIX, NOT THE WHOLE OF IT. The workflow now
 * gives `Build and push` its own step budget below the job ceiling, so an
 * overrun reports `failure` and never reaches the ambiguous path at all (see
 * the header of docker-mcp-gateway.yml). The classifier below covers what the
 * step budget cannot: a hang outside the build step, a pool fault, and the
 * job-level ceiling acting as the backstop it is now reduced to.
 *
 * WHAT THIS CANNOT COVER, STATED PLAINLY. A workflow run that is never CREATED
 * emits nothing here, because this file only executes inside a run. PEN-6034's
 * Finding 2 is exactly that shape, and it is not a gateway defect: across
 * 2026-10, `GET /actions/runs?created=<date>` returns ZERO runs of ANY event
 * type on 13 of 31 days — including the contiguous block 10-13 -> 10-21 — while
 * master took 13-106 commits on each of those same days. All six of Finding 2's
 * "qualifying pushes with no build" land on such days. Nothing inside this
 * repository's Actions can detect that, for the same reason the liveness guard
 * states about itself: a job that does not run cannot report that it did not
 * run. That half needs an observer outside GitHub Actions and is recorded on
 * PEN-6034 rather than papered over with a detector that shares the failure
 * domain.
 *
 * WHY NOT GitHub Issues. Issues are DISABLED on this repository
 * (`gh api repos/Blockcast/paperclip --jq .has_issues` -> false). BLO-33382 is
 * the incident where an alert path assumed otherwise, died under
 * `set -euo pipefail` before reporting anything, and failed closed AND silently
 * for 8 master failures in 27h. Alertmanager is the channel this org actually
 * runs on, is reachable from the in-cluster `arc-*` pools with no credential,
 * and already backs `post-docker-agent-alert.mjs` (BLO-33382),
 * `post-guard-liveness-alert.mjs` (PEN-5261) and
 * `post-environment-protection-alert.mjs` (BLO-22329).
 *
 * LABEL CARDINALITY IS LOAD-BEARING. The Alertmanager fingerprint hashes the
 * ENTIRE label set and the Paperclip bridge dedupes on it, refreshing one issue
 * in place. The commit SHA, the run URL and the cancellation reason therefore
 * live in ANNOTATIONS, never in labels: any of them as a label would mint a
 * fresh alert identity per build and turn one persistent fault into one new
 * issue per red run, which is the flood documented in BLO-28616.
 *
 * RESOLUTION IS EXPLICIT, NOT A TIMER. `STATE=resolved` (pushed by the success
 * path) sets `endsAt` in the past so Alertmanager immediately sends a resolved
 * notification and the bridge cancels the issue. Without it `endsAt` would be
 * the only thing retiring the alert and the lane would go quiet on a clock
 * rather than on a fix. That success-path push doubles as a continuous
 * capability probe: every green master build exercises the exact delivery path
 * the failure path depends on, so a channel that rots is caught by the next
 * successful build instead of by the next outage — the property BLO-33382 was
 * missing.
 *
 * Delivery failure is deliberately fatal. A silent success here would recreate
 * exactly the defect this script exists to close: a guardrail everyone believes
 * is in place.
 */

const DEFAULT_ALERTMANAGER_URL = 'http://alertmanager.monitoring.svc.cluster.local:9093';

/**
 * Long enough that a quiet weekend cannot silently retire a real fault, since
 * nothing re-pushes this alert between gateway builds — and gateway builds are
 * sparse: 44 in the six months to 2026-11-07, with a 34-day stretch carrying
 * none. The success path is what normally clears it; this bound is only the
 * backstop.
 */
export const ALERT_TTL_MS = 72 * 60 * 60 * 1000;

export const ALERTNAME = 'McpGatewayImageBuildFailing';

/**
 * A JOB-level `timeout-minutes` kill. Verbatim from runs 42326582436 and
 * 41562000182, the two kills PEN-6034 was filed on. The duration is NOT matched:
 * it is the current ceiling, so pinning it would make this regex go quiet the
 * next time the budget is re-sized — the failure mode would be a classifier
 * that silently stops paging, which is this row's own defect wearing a
 * different hat.
 */
export const JOB_TIMEOUT_ANNOTATION = /has exceeded the maximum execution time/i;

/**
 * A STEP-level `timeout-minutes` kill. Not reachable through this function
 * today — a step timeout concludes `failure`, which pages without needing any
 * classification — but matched anyway so that if GitHub ever reports one as
 * `cancelled`, it lands in the paging branch rather than the unknown one.
 * Shape banked from a real kill in this repo (run 34154564717, job
 * 101843653563): "The action '<step name>' has timed out after 1 minutes."
 */
export const STEP_TIMEOUT_ANNOTATION = /has timed out after/i;

/**
 * Concurrency supersession. GitHub writes this only when a newer run evicts
 * this one from the group — `cancel-in-progress: true` on this workflow makes
 * that the ORDINARY outcome of two master landings in quick succession, so it
 * is the one `cancelled` shape that must never page.
 *
 * The group name is anchored deliberately. A bare "higher priority waiting
 * request" match would also swallow an eviction belonging to some other
 * workflow if one ever surfaced on this job's check run, and the whole value of
 * this branch is that it suppresses a page. Verbatim from run 25984348202; the
 * optional quote covers GitHub having quoted the group name in other repos'
 * annotations (see post-docker-agent-alert.mjs, which matches the same shape).
 */
export const SUPERSEDE_ANNOTATION = /higher priority waiting request for '?docker-mcp-gateway-/;

/**
 * A human pressed cancel. Verbatim from run 25839436286 ("The run was canceled
 * forcefully by @kkroo."); the `forcefully` is optional because the ordinary
 * cancel omits it. Someone who cancels a build knows they cancelled it and does
 * not need to be told.
 */
export const MANUAL_CANCEL_ANNOTATION = /The run was canceled( forcefully)? by/i;

/**
 * Classify a `cancelled` build job from its check-run annotations.
 *
 * ORDER IS THE SAFETY PROPERTY, not a style choice. A timeout kill emits BOTH
 * its own annotation and the generic "The operation was canceled." line, and a
 * future GitHub change could in principle pair a timeout with something else;
 * testing the kill shapes FIRST means any co-occurrence resolves toward paging.
 * The two suppressing branches are reached only when no kill shape matched at
 * all.
 *
 * Returns `'unknown'` for an empty or unrecognised annotation set, which the
 * caller treats as pageable — the fail-closed direction. An annotation list
 * that could not be read is not evidence that a build succeeded.
 */
export function classifyCancellation(annotations = []) {
  const messages = (Array.isArray(annotations) ? annotations : []).map((a) => String(a?.message ?? ''));
  if (messages.some((m) => JOB_TIMEOUT_ANNOTATION.test(m))) return 'job_timeout';
  if (messages.some((m) => STEP_TIMEOUT_ANNOTATION.test(m))) return 'step_timeout';
  if (messages.some((m) => SUPERSEDE_ANNOTATION.test(m))) return 'superseded';
  if (messages.some((m) => MANUAL_CANCEL_ANNOTATION.test(m))) return 'manual_cancel';
  return 'unknown';
}

/**
 * The two reasons a `cancelled` build is NOT a delivery failure. Everything
 * else — including `unknown` — pages.
 */
export const NON_PAGING_CANCELLATIONS = new Set(['superseded', 'manual_cancel']);

export function shouldPage({ buildResult, cancellation }) {
  if (buildResult === 'success' || buildResult === 'skipped') return false;
  if (buildResult !== 'cancelled') return true;
  return !NON_PAGING_CANCELLATIONS.has(cancellation);
}

/**
 * Read the build job's check-run annotations for this run attempt.
 *
 * Fail-closed toward ALERTING, exactly as post-docker-agent-alert.mjs is: any
 * lookup error returns `'unknown'`, so an API outage can only ever produce a
 * page, never suppress one. Suppression requires positive evidence.
 */
export async function classifyBuildCancellation(env = process.env, fetchFn = fetch) {
  const { GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_TOKEN } = env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return 'unknown';
  const api = `${GITHUB_API_URL || 'https://api.github.com'}/repos/${GITHUB_REPOSITORY}`;
  const get = async (path) => {
    const res = await fetchFn(`${api}${path}`, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  try {
    const { jobs = [] } = await get(
      `/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT || 1}/jobs?per_page=100`,
    );
    const job = jobs.find((j) => j.name === 'build-and-push');
    if (!job?.id) return 'unknown';
    const annotations = await get(`/check-runs/${job.id}/annotations?per_page=100`);
    return classifyCancellation(Array.isArray(annotations) ? annotations : []);
  } catch {
    return 'unknown';
  }
}

/**
 * Operator-facing gloss per classification. Kept beside the classifier so the
 * alert says WHY it fired rather than making the reader open the run to find
 * out, which is the step at which a `cancelled` conclusion stops being read.
 */
const CANCELLATION_DETAIL = {
  job_timeout:
    'the job hit its `timeout-minutes` ceiling and GitHub recorded the kill as `cancelled`. The ' +
    '`Build and push` step carries its own, lower budget precisely so an overrun reports ' +
    '`failure` instead — reaching the JOB ceiling means something stalled outside that step, or ' +
    'the step budget is now under-sized against a genuinely slower build.',
  step_timeout: 'the `Build and push` step exceeded its own `timeout-minutes` budget.',
  unknown:
    'the cancellation carried no annotation this classifier recognises, so it is treated as a ' +
    'delivery failure. That is the fail-closed direction and may be a false alarm — but an ' +
    'unreadable cancellation is not evidence that an image was published. If this shape recurs, ' +
    'add it to the classifier in `.github/scripts/post-mcp-gateway-image-alert.mjs` rather than ' +
    'widening the suppression.',
};

export function buildAlert({ state, repo, branch, runUrl, headSha, buildResult, cancellation, now }) {
  const resolved = state === 'resolved';
  // Alertmanager rejects `startsAt >= endsAt` with `400 start time must be
  // before end time`, so a resolved push cannot simply back-date `endsAt`
  // against a `now` start — both ends move. This is the live 400 BLO-33382's
  // first cut hit on 2026-09-11.
  const endsAt = resolved ? new Date(now.getTime() - 1000) : new Date(now.getTime() + ALERT_TTL_MS);
  const startsAt = resolved ? new Date(now.getTime() - 2000) : new Date(now);

  const why =
    buildResult === 'cancelled'
      ? `\`build-and-push\` was CANCELLED: ${CANCELLATION_DETAIL[cancellation] ?? CANCELLATION_DETAIL.unknown}`
      : '`build-and-push` failed.';

  return {
    // Stable label set ONLY — see the cardinality note in the file header. No
    // head SHA, no run id, no cancellation reason: all three are
    // per-occurrence and would fragment the identity the bridge dedupes on.
    labels: {
      alertname: ALERTNAME,
      severity: 'warning',
      namespace: 'paperclip',
      service: 'paperclip-mcp-gateway-image-delivery',
      repo,
      branch,
    },
    annotations: {
      summary: `The mcp-gateway image build is failing on ${branch} in ${repo}`,
      description:
        `\`Docker (mcp-gateway)\` did not publish an image for ${headSha} on ${branch}.\n\n` +
        `${why}\n\n` +
        'CONSEQUENCE: no `sha-<short>` tag exists for that commit in ' +
        '`harbor.blockcast.net/paperclip-mcp-gateway/paperclip-mcp-gateway`, so any manifest ' +
        're-pin aimed at it will reference a tag that does not exist. Confirm the newest ' +
        'SUCCESSFULLY published tag before re-pinning anything — do not infer it from the ' +
        'newest master commit. PEN-6034 is the row where a CVE re-pin nearly went to a tag no ' +
        'build ever produced.\n\n' +
        'A `cancelled` conclusion here is NOT self-explanatory: on this workflow it covers a ' +
        'timeout kill, a concurrency supersede and a human cancel alike. Only the first is a ' +
        'fault, and this alert has already made that distinction from the job annotations — ' +
        'supersedes and human cancels do not reach this channel at all.',
      head_sha: headSha,
      build_result: buildResult,
      cancellation_reason: buildResult === 'cancelled' ? cancellation : 'n/a',
      run_url: runUrl,
      runbook_url: 'https://paperclip.blockcast.net/PEN/issues/PEN-6034',
    },
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  };
}

async function main() {
  const state = process.env.STATE === 'resolved' ? 'resolved' : 'firing';
  const buildResult = process.env.BUILD_RESULT ?? 'unknown';

  let cancellation = 'n/a';
  if (state !== 'resolved' && buildResult === 'cancelled') {
    cancellation = await classifyBuildCancellation();
    if (!shouldPage({ buildResult, cancellation })) {
      console.log(
        `::notice::build-and-push was cancelled with reason '${cancellation}', which is not a ` +
          'delivery failure (PEN-6034). Not paging.',
      );
      return;
    }
  }

  const repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY ?? 'unknown/unknown';
  const branch = process.env.BRANCH || 'master';
  const runUrl = process.env.RUN_URL ?? '';
  const headSha = process.env.HEAD_SHA ?? 'unknown';
  const base = (process.env.ALERTMANAGER_URL || DEFAULT_ALERTMANAGER_URL).replace(/\/+$/, '');

  const alert = buildAlert({
    state,
    repo,
    branch,
    runUrl,
    headSha,
    buildResult,
    cancellation,
    now: new Date(),
  });

  const url = `${base}/api/v2/alerts`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([alert]),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error(
      `::error::ALERT DELIVERY FAILED: could not reach Alertmanager at ${url}: ${err.message}. ` +
        'The mcp-gateway image delivery lane is unmonitored until this is fixed.',
    );
    process.exit(1);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(
      `::error::ALERT DELIVERY FAILED: Alertmanager ${url} returned ${res.status}: ${body.slice(0, 500)}`,
    );
    process.exit(1);
  }

  console.log(
    `Pushed ${alert.labels.alertname} (state=${state}, severity=${alert.labels.severity}) to ${url}; ` +
      `endsAt ${alert.endsAt}.`,
  );
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

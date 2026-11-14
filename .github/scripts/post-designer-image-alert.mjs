#!/usr/bin/env node
/**
 * post-designer-image-alert.mjs
 *
 * Reports the health of the designer image delivery lane
 * (`docker-designer.yml` on master) into Alertmanager, which fans every alert
 * to the paperclip-plugin-alertmanager webhook — so a master push that
 * published no image becomes a Paperclip issue in the platform lane instead of
 * a cancelled run nobody reads.
 *
 * WHY THIS LANE NEEDED ITS OWN (PEN-6683, 2026-11-14). It is the last of the
 * seven image lanes with no arm at all, and it is the quietest of them — which
 * is the argument FOR covering it rather than against.
 *
 * Measured first-party against the Actions API on 2026-11-14 over all 19 runs
 * this workflow has ever had: `build-and-push` has FAILED on a master push
 * three times — #4 (2026-07-09T06:04:17Z), #3 (2026-07-09T05:34:47Z) and #2
 * (2026-05-24T08:11:58Z) — and not one of them reached anybody. Those were
 * `failure` rather than `cancelled`, so this lane has not yet exercised the
 * PEN-6034 shape; its siblings have. webflow-bot #81 and figma-bot #98 were
 * both ceiling-killed on a master push on 2026-11-14, recorded `cancelled`,
 * and silent — and this workflow carries the identical `timeout-minutes: 30`
 * ceiling, the identical `cancel-in-progress: true` concurrency, and the same
 * runner group. The arm therefore fires on `failure` OR `cancelled`, because
 * the one shape this lane has shown is not evidence about the one it has not.
 *
 * NOTHING ELSE WATCHES THIS LANE. Checked rather than assumed, 2026-11-14:
 * `master-health.yml` filters its run census on
 * `.path == ".github/workflows/pr.yml"`, so it cannot see a `docker-*` run at
 * all; `scheduled_workflow_last_verdict_failed` carries no `docker-*` series
 * and its alert keys on the CRON verdict, so it cannot see a push build; and
 * this workflow has no outcome job of its own. A red or cancelled master push
 * here reaches no surface.
 *
 * WHY ALERTMANAGER. GitHub Issues are disabled on this repo (BLO-33382), so the
 * `gh issue` path the agent-base lane once used dies under `set -euo pipefail`
 * before reporting anything. Alertmanager is the channel this org runs on, is
 * reachable from the in-cluster `arc-*` runners with no credential, and already
 * backs the gateway, agent-base and mcp-external lanes.
 *
 * LABEL CARDINALITY IS LOAD-BEARING. The Alertmanager fingerprint hashes the
 * ENTIRE label set and the Paperclip bridge dedupes on it, refreshing one issue
 * in place when it re-fires. So the commit SHA and run URL live in ANNOTATIONS,
 * never in labels — a SHA in a label mints a fresh alert identity per commit
 * and turns one persistent fault into one new issue per red build (BLO-28616).
 *
 * RESOLUTION IS EXPLICIT, NOT A TIMER. `STATE=resolved` sets `endsAt` in the
 * past so Alertmanager sends a resolved notification and the bridge cancels the
 * issue. That success-path push doubles as a continuous capability probe: this
 * lane is sparse — 15 successful builds across the 19 runs this workflow has
 * ever had — so a channel that rotted here would otherwise be discovered by the
 * next outage.
 */

const DEFAULT_ALERTMANAGER_URL = 'http://alertmanager.monitoring.svc.cluster.local:9093';

/**
 * Long enough that a quiet weekend does not silently retire a real fault, since
 * nothing re-pushes this alert between master builds. The success path is what
 * normally clears it; this bound is only the backstop.
 */
export const ALERT_TTL_MS = 72 * 60 * 60 * 1000;

export const ALERTNAME = 'DesignerImageBuildFailing';

/** A `timeout-minutes` kill on the JOB. GitHub records it as `cancelled`. */
export const JOB_TIMEOUT_ANNOTATION = /has exceeded the maximum execution time/i;

/** A `timeout-minutes` kill on the build STEP — the budget this lane added. */
export const STEP_TIMEOUT_ANNOTATION = /has timed out after/i;

/**
 * `cancel-in-progress: true` on this job's concurrency group, so a newer master
 * commit kills a RUNNING build. The group name is the only field that proves
 * supersession, and it must be anchored to THIS workflow: a looser
 * `docker-` prefix would also match `docker-designer-`, `docker-webflow-bot-`
 * and the main `docker-refs/...` lane, and would suppress a real kill there.
 */
export const SUPERSEDE_ANNOTATION = /higher priority waiting request for '?docker-designer-/;

export const MANUAL_CANCEL_ANNOTATION = /The run was canceled( forcefully)? by/i;

export function classifyCancellation(annotations = []) {
  const messages = (Array.isArray(annotations) ? annotations : []).map((a) => String(a?.message ?? ''));
  if (messages.some((m) => JOB_TIMEOUT_ANNOTATION.test(m))) return 'job_timeout';
  if (messages.some((m) => STEP_TIMEOUT_ANNOTATION.test(m))) return 'step_timeout';
  if (messages.some((m) => SUPERSEDE_ANNOTATION.test(m))) return 'superseded';
  if (messages.some((m) => MANUAL_CANCEL_ANNOTATION.test(m))) return 'manual_cancel';
  return 'unknown';
}

/** Supersession and a human cancel are intended; everything else pages. */
export const NON_PAGING_CANCELLATIONS = new Set(['superseded', 'manual_cancel']);

export function shouldPage({ buildResult, cancellation }) {
  if (buildResult === 'success' || buildResult === 'skipped') return false;
  if (buildResult !== 'cancelled') return true;
  return !NON_PAGING_CANCELLATIONS.has(cancellation);
}

/**
 * Fail-closed toward ALERTING: any lookup error returns 'unknown', which pages.
 * An API outage can only ever produce a page, never suppress one.
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

const CANCELLATION_DETAIL = {
  job_timeout:
    'the job hit its `timeout-minutes` ceiling and GitHub recorded the kill as `cancelled`. The ' +
    '`Build and push` step carries its own, lower budget precisely so an overrun reports ' +
    '`failure` instead — reaching the JOB ceiling means something stalled outside that step, or ' +
    'the step budget is now under-sized against a genuinely slower build.',
  step_timeout:
    'the `Build and push` step exceeded its own `timeout-minutes` budget. Check which runner ' +
    'scale set the job landed on before assuming the build is at fault: this lane has run on ' +
    'four different pools over its life and the spread is wide (1.4 to 11.3 min of measured step ' +
    'time, with an older job-level upper bound of 21.5). PEN-6677 pinned the runner GROUP after ' +
    'the tools-cluster twin hung four image builds on 2026-11-14; a recurrence means either the ' +
    'pin regressed or this is a different fault.',
  unknown:
    'the cancellation carried no annotation this classifier recognises, so it is treated as a ' +
    'delivery failure. That is the fail-closed direction and may be a false alarm — but an ' +
    'unreadable cancellation is not evidence that an image was published. If this shape recurs, ' +
    'add it to the classifier in `.github/scripts/post-designer-image-alert.mjs` rather than ' +
    'widening the suppression.',
};

export function buildAlert({ state, repo, branch, runUrl, headSha, buildResult, cancellation, now }) {
  const resolved = state === 'resolved';
  // Alertmanager rejects `startsAt >= endsAt` with `400 start time must be
  // before end time`, so a resolved push cannot simply back-date `endsAt`
  // against a `now` start — both ends move.
  const endsAt = resolved ? new Date(now.getTime() - 1000) : new Date(now.getTime() + ALERT_TTL_MS);
  const startsAt = resolved ? new Date(now.getTime() - 2000) : new Date(now);

  const detail =
    buildResult === 'cancelled'
      ? ` The build reported \`cancelled\`, and ${CANCELLATION_DETAIL[cancellation] ?? CANCELLATION_DETAIL.unknown}`
      : '';

  return {
    // Stable label set ONLY — see the cardinality note in the file header.
    labels: {
      alertname: ALERTNAME,
      severity: 'warning',
      namespace: 'paperclip',
      service: 'paperclip-designer-image-delivery',
      repo,
      branch,
    },
    annotations: {
      summary: `The designer image build is failing on ${branch} in ${repo}`,
      description:
        `\`Docker (designer)\` did not publish an image for ${headSha} on ${branch}.` +
        `${detail}\n\n` +
        'This lane publishes `harbor.blockcast.net/paperclip-designer/designer`, which the ' +
        'cluster yaml pins by `sha-` tag. Re-pinning is a MANUAL operator step, so a missed ' +
        'build does not roll the live deployment back — it silently freezes it at the last image ' +
        'that did publish. See PEN-6683 for the row this alert was built from, and check it ' +
        'before starting a fresh investigation.',
      head_sha: headSha,
      build_result: buildResult,
      cancellation,
      run_url: runUrl,
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
        `::notice::build-and-push reported cancelled and classified as '${cancellation}', which is ` +
          'an intended cancellation rather than a delivery failure. Not paging.',
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
        'The designer image delivery lane is unmonitored until this is fixed.',
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

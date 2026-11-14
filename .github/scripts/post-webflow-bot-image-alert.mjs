#!/usr/bin/env node
/**
 * post-webflow-bot-image-alert.mjs
 *
 * Reports the health of the webflow-bot image delivery lane
 * (`docker-webflow-bot.yml` on master) into Alertmanager, which fans every alert
 * to the paperclip-plugin-alertmanager webhook — so a master push that
 * published no image becomes a Paperclip issue in the platform lane instead of
 * a cancelled run nobody reads.
 *
 * WHY THIS LANE NEEDED ITS OWN (PEN-6683, 2026-11-14). This lane was
 * ceiling-killed on a master PUSH and reported it to nobody. Measured
 * first-party against the Actions API on 2026-11-14: run #81
 * (2026-11-14T14:53:16Z, push) ran 30.08 min against its own
 * `timeout-minutes: 30`, with the `Build and push` step alone at 29.77 min, on
 * runner scale set `arc-paperclip-buildkit-n7zlf`. It published nothing and was
 * recorded `cancelled`, NOT `failure` — the exact gap PEN-6034 named. An alert
 * arm keyed only on `failure` is silent for precisely the shape this lane fails
 * in.
 *
 * THIS LANE IS LOAD-BEARING FOR A SECOND ONE. `docker-figma-bot.yml` builds
 * FROM `harbor.blockcast.net/paperclip-webflow-bot/webflow-bot:latest`, so a
 * webflow-bot image that never publishes also starves the figma-bot lane of a
 * fresh base. Both were killed at the same master push on 2026-11-14.
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
 * lane is sparse — 9 successful builds across the 58 runs this workflow has
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

export const ALERTNAME = 'WebflowBotImageBuildFailing';

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
export const SUPERSEDE_ANNOTATION = /higher priority waiting request for '?docker-webflow-bot-/;

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

export function shouldPage({ buildResult, testResult = 'unknown', cancellation }) {
  if (buildResult === 'success') return false;
  // `build-and-push` is gated on `needs: test`. On a master push it is therefore
  // SKIPPED only because the test job did not succeed -- no image was published,
  // which is the same user-visible outcome as a failed build.
  //
  // This arm previously returned false, on the reasoning that the run is already
  // red for the real reason and a second alert would duplicate it. That is
  // circular: this lane has no first alert, which is the whole premise of
  // PEN-6683. A master push whose tests fail must reach somebody.
  //
  // The one exception is a deliberate stop. A concurrency supersede kills the
  // test job too, so a cancelled test is classified exactly like a cancelled
  // build, and anything the classifier cannot read still pages (fail-closed).
  if (buildResult === 'skipped') {
    return !(testResult === 'cancelled' && NON_PAGING_CANCELLATIONS.has(cancellation));
  }
  if (buildResult !== 'cancelled') return true;
  return !NON_PAGING_CANCELLATIONS.has(cancellation);
}

/**
 * Which job's annotations prove why no image was published.
 *
 * A cancelled build is classified from its own annotations. A build SKIPPED
 * behind a cancelled test has none of its own -- it never ran -- so the test
 * job's are the only evidence that the run was deliberately superseded. Reading
 * `build-and-push` there would always classify `unknown` and page through a
 * legitimate supersede.
 */
export function cancellationSourceJob({ buildResult, testResult }) {
  if (buildResult === 'cancelled') return 'build-and-push';
  if (buildResult === 'skipped' && testResult === 'cancelled') return 'test';
  return null;
}

/**
 * Fail-closed toward ALERTING: any lookup error returns 'unknown', which pages.
 * An API outage can only ever produce a page, never suppress one.
 */
export async function classifyBuildCancellation(env = process.env, fetchFn = fetch, jobName = 'build-and-push') {
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
    const job = jobs.find((j) => j.name === jobName);
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
    'scale set the job landed on before assuming the build is at fault: run #81 burned its whole ' +
    '30-minute ceiling on `arc-paperclip-buildkit-n7zlf`, while the same image built in 0.2-6.1 ' +
    'min on every other pool this lane has used. PEN-6677 pinned the runner GROUP to stop that ' +
    'placement; a recurrence means either the pin regressed or this is a different fault.',
  unknown:
    'the cancellation carried no annotation this classifier recognises, so it is treated as a ' +
    'delivery failure. That is the fail-closed direction and may be a false alarm — but an ' +
    'unreadable cancellation is not evidence that an image was published. If this shape recurs, ' +
    'add it to the classifier in `.github/scripts/post-webflow-bot-image-alert.mjs` rather than ' +
    'widening the suppression.',
};

export function buildAlert({ state, repo, branch, runUrl, headSha, buildResult, testResult = 'unknown', cancellation, now }) {
  const resolved = state === 'resolved';
  // Alertmanager rejects `startsAt >= endsAt` with `400 start time must be
  // before end time`, so a resolved push cannot simply back-date `endsAt`
  // against a `now` start — both ends move.
  const endsAt = resolved ? new Date(now.getTime() - 1000) : new Date(now.getTime() + ALERT_TTL_MS);
  const startsAt = resolved ? new Date(now.getTime() - 2000) : new Date(now);

  const detail =
    buildResult === 'cancelled'
      ? ` The build reported \`cancelled\`, and ${CANCELLATION_DETAIL[cancellation] ?? CANCELLATION_DETAIL.unknown}`
      : buildResult === 'skipped'
        ? ` The \`test\` job reported \`${testResult}\`, so \`build-and-push\` never ran (it is gated on ` +
          `\`needs: test\`) and no image was produced. Fix the test job: the build is not itself at fault.` +
          (testResult === 'cancelled'
            ? ` The cancellation classified as \`${cancellation}\`.`
            : '')
        : '';

  return {
    // Stable label set ONLY — see the cardinality note in the file header.
    labels: {
      alertname: ALERTNAME,
      severity: 'warning',
      namespace: 'paperclip',
      service: 'paperclip-webflow-bot-image-delivery',
      repo,
      branch,
    },
    annotations: {
      summary: `The webflow-bot image build is failing on ${branch} in ${repo}`,
      description:
        `\`Docker (webflow-bot)\` did not publish an image for ${headSha} on ${branch}.` +
        `${detail}\n\n` +
        'This lane publishes `harbor.blockcast.net/paperclip-webflow-bot/webflow-bot`, which the ' +
        'cluster yaml pins by `sha-` tag; re-pinning is a MANUAL operator step, so a missed build ' +
        'does not roll the live deployment back — it silently freezes it at the last image that ' +
        'did publish. It is also the BASE IMAGE for the figma-bot lane, which builds FROM ' +
        '`webflow-bot:latest`, so a failure here can starve that lane too. See PEN-6683 for the ' +
        'incident this alert was built from, and check it before starting a fresh investigation.',
      head_sha: headSha,
      build_result: buildResult,
      test_result: testResult,
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
  const testResult = process.env.TEST_RESULT ?? 'unknown';

  let cancellation = 'n/a';
  if (state !== 'resolved') {
    const cancelledJob = cancellationSourceJob({ buildResult, testResult });
    if (cancelledJob) {
      cancellation = await classifyBuildCancellation(process.env, fetch, cancelledJob);
    }
    if (!shouldPage({ buildResult, testResult, cancellation })) {
      console.log(
        `::notice::build-and-push reported '${buildResult}' (test: '${testResult}'` +
          `${cancellation === 'n/a' ? '' : `, classified '${cancellation}'`}), which is an intended ` +
          'outcome rather than an unpublished image. Not paging.',
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
    testResult,
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
        'The webflow-bot image delivery lane is unmonitored until this is fixed.',
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

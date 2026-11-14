#!/usr/bin/env node
/**
 * post-mcp-external-image-alert.mjs
 *
 * Reports the health of the mcp-external image delivery lane
 * (`docker-mcp-external.yml` on master) into Alertmanager, which fans every
 * alert to the paperclip-plugin-alertmanager webhook — so a master push that
 * published no image becomes a Paperclip issue in the platform lane instead of
 * a cancelled run nobody reads.
 *
 * WHY THIS LANE NEEDED ITS OWN (PEN-6676, 2026-11-14). On the first post-merge
 * master build after PEN-5927 landed, run #18 (43607193442) sat 14m39s with no
 * BuildKit progress after `#11 importing cache manifest from
 * harbor.blockcast.net/library/paperclip-mcp-external:buildcache-v1`, hit the
 * job's `timeout-minutes: 15` ceiling, and was recorded `cancelled`. It pushed
 * no manifest. Nothing anywhere reported it.
 *
 * It was not alone and it was not special. At that one push three builds landed
 * on runner scale set `arc-paperclip-buildkit-n7zlf` and all three were killed
 * at their own ceilings — mcp-external at 15m05s/15, webflow-bot at 30m05s/30,
 * figma-bot at 30m07s/30 — while designer and mcp-gateway, on `rnxnc` with the
 * SAME BuildKit ordinal, finished in 2m18s and 1m48s. mcp-external itself had
 * succeeded on `rnxnc` 5½ hours earlier (run #17, 4m53s, same cache ref). So a
 * bigger budget buys nothing: 30 was not enough for two siblings.
 *
 * WHY NOT a Prometheus rule. Measured 2026-11-14: `scheduled_workflow_last_
 * verdict_failed` carries 20 series for this repo and NONE of the `docker-*`
 * workflows, and its alert (`ScheduledWorkflowTrunkRed`) keys on the CRON
 * verdict, so it cannot see a push build at all. All 13 purpose-built BuildKit
 * rules were `inactive` throughout the incident. Alertmanager is the channel
 * this org runs on, is reachable from the in-cluster `arc-*` runners with no
 * credential, and already backs the gateway and agent-base lanes.
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
 * lane is sparse (9 successful builds between 2026-06-21 and 2026-11-14), so a
 * channel that rotted here would otherwise be discovered by the next outage.
 */

const DEFAULT_ALERTMANAGER_URL = 'http://alertmanager.monitoring.svc.cluster.local:9093';

/**
 * Long enough that a quiet weekend does not silently retire a real fault, since
 * nothing re-pushes this alert between master builds. The success path is what
 * normally clears it; this bound is only the backstop.
 */
export const ALERT_TTL_MS = 72 * 60 * 60 * 1000;

export const ALERTNAME = 'McpExternalImageBuildFailing';

/** A `timeout-minutes` kill on the JOB. GitHub records it as `cancelled`. */
export const JOB_TIMEOUT_ANNOTATION = /has exceeded the maximum execution time/i;

/** A `timeout-minutes` kill on the build STEP — the budget this lane added. */
export const STEP_TIMEOUT_ANNOTATION = /has timed out after/i;

/**
 * `cancel-in-progress: true` on this job's concurrency group, so a newer master
 * commit kills a RUNNING build. Run #16 (2026-11-14T09:19:39Z) died that way
 * after 1m54s, with a runner and with steps — which is why this lane cannot use
 * the agent-base lane's "evicted before it reached a runner" test. The group
 * name is the only field that proves supersession.
 */
export const SUPERSEDE_ANNOTATION = /higher priority waiting request for '?docker-mcp-external-/;

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
    'the `Build and push` step exceeded its own `timeout-minutes` budget. PEN-6676 is the worked ' +
    'case: BuildKit stalled after importing the Harbor cache manifest and emitted no further ' +
    'progress. Check which runner scale set the job landed on before assuming the build is at ' +
    'fault — that incident was a pool fault, and the same commit built clean on the other pool.',
  unknown:
    'the cancellation carried no annotation this classifier recognises, so it is treated as a ' +
    'delivery failure. That is the fail-closed direction and may be a false alarm — but an ' +
    'unreadable cancellation is not evidence that an image was published. If this shape recurs, ' +
    'add it to the classifier in `.github/scripts/post-mcp-external-image-alert.mjs` rather than ' +
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
      service: 'paperclip-mcp-external-image-delivery',
      repo,
      branch,
    },
    annotations: {
      summary: `The mcp-external image build is failing on ${branch} in ${repo}`,
      description:
        `\`Docker (mcp-external)\` did not publish an image for ${headSha} on ${branch}.` +
        `${detail}\n\n` +
        'This lane backs the `server` container of the `paperclip-mcp` deployment behind ' +
        'https://paperclip.blockcast.net/mcp, publishing to ' +
        '`harbor.blockcast.net/library/paperclip-mcp-external`. The manifest pins by `sha-` tag ' +
        'and re-pinning is a MANUAL step, so a missed build does not roll back the live ' +
        'deployment — it silently freezes it at the last image that did publish. See PEN-6676 ' +
        'for the incident this alert was built from, and check it before starting a fresh ' +
        'investigation.',
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
        'The mcp-external image delivery lane is unmonitored until this is fixed.',
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

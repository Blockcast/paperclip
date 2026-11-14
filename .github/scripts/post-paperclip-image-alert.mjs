#!/usr/bin/env node
/**
 * post-paperclip-image-alert.mjs
 *
 * Reports the health of the paperclip image delivery lane
 * (`docker.yml` on master) into Alertmanager, which fans every alert
 * to the paperclip-plugin-alertmanager webhook — so a master push that
 * published no image becomes a Paperclip issue in the platform lane instead of
 * a cancelled run nobody reads.
 *
 * WHY THIS LANE NEEDED ITS OWN (PEN-6683, 2026-11-14). This is the main
 * paperclip image. On a master PUSH, `build-and-push` is the ONLY job in
 * `docker.yml` that runs and NOTHING reports its outcome: `guard-pending-deploy`,
 * `guard-pending-deploy-final`, `deploy` and `deploy-dispatch-outcome` are every
 * one of them gated on `github.event_name == 'workflow_dispatch'`. So a push
 * that publishes no image is silent by construction.
 *
 * SCOPE, AND IT IS DELIBERATE. The `workflow_dispatch` path is ALREADY covered
 * by `deploy-dispatch-outcome`, whose own `if:` pins the dispatch event — the
 * PEN-4841 control. `assert-dispatch-deploy-outcome.sh` handles a failed or
 * cancelled build there explicitly (its Cause 1: "the attempt died upstream, at
 * the build... the run conclusion already carries that"). This arm therefore
 * excludes `workflow_dispatch` so the two cannot double-report one cause. That
 * exclusion is a non-duplication, not a copied default.
 *
 * ⚠ DO NOT CITE run #3485 AS THIS LANE'S INCIDENT. PEN-6683's filing listed it
 * (90.47 min against a 90-minute ceiling, 2026-11-14) alongside the webflow-bot
 * and figma-bot kills, but #3485 was a `workflow_dispatch`, i.e. on the path
 * `deploy-dispatch-outcome` already guards. Measured first-party on 2026-11-14
 * over the 60 most recent runs: of 16 cancelled builds, the only one anywhere
 * near the ceiling was that dispatch; every cancelled PUSH sat at 13-28 min,
 * which is the ordinary `cancel-in-progress: true` supersede this classifier
 * suppresses. The push-path gap here is STRUCTURAL and currently unexercised —
 * which is a reason to close it cheaply now, not a reason to claim an incident.
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
 * lane is BUSY rather than sparse — 44 successful builds in the 60 most recent
 * runs — so the resolve arm exercises the delivery path many times a day and a
 * rotted channel surfaces almost immediately.
 */

const DEFAULT_ALERTMANAGER_URL = 'http://alertmanager.monitoring.svc.cluster.local:9093';

/**
 * Long enough that a quiet weekend does not silently retire a real fault, since
 * nothing re-pushes this alert between master builds. The success path is what
 * normally clears it; this bound is only the backstop.
 */
export const ALERT_TTL_MS = 72 * 60 * 60 * 1000;

export const ALERTNAME = 'PaperclipImageBuildFailing';

/** A `timeout-minutes` kill on the JOB. GitHub records it as `cancelled`. */
export const JOB_TIMEOUT_ANNOTATION = /has exceeded the maximum execution time/i;

/** A `timeout-minutes` kill on the build STEP — the budget this lane added. */
export const STEP_TIMEOUT_ANNOTATION = /has timed out after/i;

/**
 * `cancel-in-progress: true` on this job's concurrency group, so a newer master
 * commit kills a RUNNING build. The group name is the only field that proves
 * supersession, and it is anchored to THIS lane's own group: on a push the
 * group is `docker-${{ github.ref }}-publish`, which renders as
 * `docker-refs/heads/master-publish`. That is what the anchor below matches.
 *
 * A looser `docker-` prefix would instead match the SIBLING image lanes --
 * `docker-designer-`, `docker-figma-bot-`, `docker-webflow-bot-` -- and could
 * suppress a real kill here as though it were a supersede.
 *
 * The annotations read below come only from this run's own `build-and-push`
 * check-run, so a sibling's group cannot in fact appear in them today. The
 * narrow anchor is defence in depth against that sourcing ever widening, not
 * the only thing standing between this lane and a false suppression.
 */
export const SUPERSEDE_ANNOTATION = /higher priority waiting request for '?docker-refs\//;

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
    'scale set the job landed on before assuming the build is at fault: on 2026-11-14 the four ' +
    'slowest successful builds (30.68, 26.83, 23.62 and 22.88 min) all landed on ' +
    '`arc-paperclip-buildkit-n7zlf`, against a 19.95 min worst case on the sibling pool. ' +
    'PEN-6677 pinned the runner GROUP to stop that placement; a recurrence means either the pin ' +
    'regressed or this is a different fault. Note also that this job contains a SECOND build ' +
    'step, `Build and push stable runtime image`, which carries no budget of its own: a stall ' +
    'there reaches the JOB ceiling and classifies `job_timeout`, not `step_timeout`.',
  unknown:
    'the cancellation carried no annotation this classifier recognises, so it is treated as a ' +
    'delivery failure. That is the fail-closed direction and may be a false alarm — but an ' +
    'unreadable cancellation is not evidence that an image was published. If this shape recurs, ' +
    'add it to the classifier in `.github/scripts/post-paperclip-image-alert.mjs` rather than ' +
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
      service: 'paperclip-image-delivery',
      repo,
      branch,
    },
    annotations: {
      summary: `The paperclip image build is failing on ${branch} in ${repo}`,
      description:
        `\`Docker\` did not publish an image for ${headSha} on ${branch}.` +
        `${detail}\n\n` +
        'This is the MAIN paperclip image, published to ' +
        '`harbor.blockcast.net/paperclip/paperclip`. A master push that publishes nothing leaves ' +
        'that commit with no image at all and does not refresh the shared ' +
        '`latest-k8s-vendored` cache tag, so later builds run colder. It does NOT roll the live ' +
        'deployment back: production deploys run from a separate `workflow_dispatch` path that ' +
        'rebuilds the approved SHA, and that path has its own guard in ' +
        '`deploy-dispatch-outcome`. The failure this alert catches is the PUBLISH lane going ' +
        'quiet, which is otherwise discovered only when a deploy of that SHA is attempted. See ' +
        'PEN-6683, and check it before starting a fresh investigation.',
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
        'The paperclip image delivery lane is unmonitored until this is fixed.',
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

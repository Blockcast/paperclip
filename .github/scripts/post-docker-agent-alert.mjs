#!/usr/bin/env node
/**
 * post-docker-agent-alert.mjs
 *
 * Reports the health of the agent-image delivery lane (`docker-agent.yml` on
 * master) into Alertmanager, which fans every alert to the
 * paperclip-plugin-alertmanager webhook — so a dead lane becomes a Paperclip
 * issue in the platform lane instead of a red run nobody reads.
 *
 * WHY NOT GitHub Issues (BLO-33382). The previous `alert-on-failure` step
 * called `gh issue list` / `gh issue create` against this repository, which has
 * Issues DISABLED:
 *
 *     $ gh api repos/Blockcast/paperclip --jq .has_issues
 *     false
 *
 * With `set -euo pipefail`, the first command exited non-zero and the step died
 * before it could report anything. The guardrail failed closed AND silently —
 * its own failure was the thing it was supposed to report. 8 master failures in
 * the 27h to 2026-09-11T19:4xZ produced zero notifications, and three promoted
 * agent images never reached the cluster. Alertmanager is the channel this org
 * actually runs on, is reachable from the in-cluster `arc-*` runners with no
 * credential, and already backs
 * `post-environment-protection-alert.mjs` (BLO-22329).
 *
 * LABEL CARDINALITY IS LOAD-BEARING. The Alertmanager fingerprint hashes the
 * ENTIRE label set, and the Paperclip bridge dedupes on that fingerprint —
 * refreshing one issue in place when it re-fires. So the commit SHA and run URL
 * live in ANNOTATIONS, never in labels. Putting either in a label would mint a
 * fresh alert identity per commit and turn a single persistent fault into one
 * new issue per red build, which is the flood documented in BLO-28616.
 *
 * RESOLUTION IS EXPLICIT, NOT A TIMER. `STATE=resolved` (pushed by the success
 * path) sets `endsAt` in the past so Alertmanager immediately sends a resolved
 * notification and the bridge cancels the issue. Without that, `endsAt` would
 * be the only thing retiring the alert, and the lane would go quiet on a timer
 * rather than on a fix — "silence is not health" in its most deceptive form.
 * That success-path push doubles as a continuous capability probe: every green
 * master build exercises this exact delivery path, so the channel cannot rot
 * unnoticed while waiting for a real failure to discover it.
 *
 * Delivery failure is deliberately fatal, for the same reason as the protection
 * alert: a silent success here would recreate precisely the defect this script
 * exists to close — a guardrail everyone believes is in place.
 */

const DEFAULT_ALERTMANAGER_URL = 'http://alertmanager.monitoring.svc.cluster.local:9093';

/**
 * Long enough that a quiet weekend does not silently retire a real fault, since
 * nothing re-pushes this alert between master builds. The success path is what
 * normally clears it; this bound is only the backstop.
 */
export const ALERT_TTL_MS = 72 * 60 * 60 * 1000;

export const ALERTNAME = 'DockerAgentBaseBuildFailing';

export function buildAlert({ state, repo, branch, runUrl, headSha, failedJob, now }) {
  const resolved = state === 'resolved';
  // Alertmanager rejects `startsAt >= endsAt` with `400 start time must be
  // before end time`, so a resolved push cannot simply back-date `endsAt`
  // against a `now` start — both ends move. Verified live on 2026-09-11: the
  // first cut did exactly that and 400'd, which would have left every green
  // build red and the firing alert un-retired.
  const endsAt = resolved ? new Date(now.getTime() - 1000) : new Date(now.getTime() + ALERT_TTL_MS);
  const startsAt = resolved ? new Date(now.getTime() - 2000) : new Date(now);

  return {
    // Stable label set ONLY — see the cardinality note in the file header.
    labels: {
      alertname: ALERTNAME,
      severity: 'warning',
      namespace: 'paperclip',
      service: 'paperclip-agent-image-delivery',
      repo,
      branch,
    },
    annotations: {
      summary: `Docker (agent base) is failing on ${branch} in ${repo}`,
      description:
        `\`Docker (agent base)\` failed on ${branch} at commit ${headSha}.\n\n` +
        'While this workflow is red, `Promote verified agent image` and `Bump agent image refs ' +
        'in cluster` do not complete, so no agent image change reaches the cluster until it is ' +
        'fixed. See BLO-23128 for the incident where this went unnoticed for ~6 days, and ' +
        'BLO-33382 for why this alert exists at all; check those issues and their comments for ' +
        'the last confirmed root cause before starting a fresh investigation.',
      head_sha: headSha,
      failed_job: failedJob,
      run_url: runUrl,
    },
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  };
}

async function main() {
  const state = process.env.STATE === 'resolved' ? 'resolved' : 'firing';
  const repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY ?? 'unknown/unknown';
  const branch = process.env.BRANCH || 'master';
  const runUrl = process.env.RUN_URL ?? '';
  const headSha = process.env.HEAD_SHA ?? 'unknown';
  const failedJob = process.env.FAILED_JOB ?? 'build-and-push';
  const base = (process.env.ALERTMANAGER_URL || DEFAULT_ALERTMANAGER_URL).replace(/\/+$/, '');

  const alert = buildAlert({ state, repo, branch, runUrl, headSha, failedJob, now: new Date() });

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
        'The agent-image delivery lane is unmonitored until this is fixed.',
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

#!/usr/bin/env node
/**
 * post-guard-liveness-alert.mjs
 *
 * Routes the verdict of `scripts/check-scheduled-guard-liveness.mjs` into
 * Alertmanager, which fans every alert to the paperclip-plugin-alertmanager
 * webhook — so a scheduled guard that has STOPPED becomes a Paperclip issue in
 * the platform lane instead of a red run nobody reads.
 *
 * THIS IS ROUTING, NOT DETECTION (PEN-5261). The detector is unchanged and is
 * not duplicated here: this script asserts nothing about liveness, computes no
 * threshold, and makes no API call to GitHub. It transports a verdict that has
 * already been reached. That separation is deliberate — PEN-5261 closes with
 * "do not add a new detector — one already works", and the failure it documents
 * was never a detection gap.
 *
 * THE GAP THIS CLOSES. On 2026-11-02T03:52:34Z a human set
 * `scheduled-production-deploy.yml` to `disabled_manually`, which was very
 * likely the RIGHT call — migration 0270 was still on master and an unattended
 * 07:23Z deploy would have re-run the migration behind that morning's
 * ~35-minute activity_log outage (PEN-5250/PEN-5251). The problem was never the
 * decision. It was that the decision left NO record anywhere a human looks: a
 * workflow `state` flip is a GitHub API field, not a commit, so it produced no
 * issue, no comment and no PR.
 *
 * `scheduled-guard-liveness` SAW IT, correctly, within the hour — red at
 * 04:51:24Z and every hour after, naming the cause exactly ("has state
 * 'disabled_manually', so its schedule no longer fires"). Nobody acted on it
 * for the same reason the docker-agent lane went unread for ~6 days in
 * BLO-23128: a red scheduled run is not a channel. By 07:23Z the daily
 * production deploy had silently not fired, production sat 77 commits behind,
 * and `paperclip_api_oldest_missing_commit_age_hours` was crossing 24h.
 *
 * THIS IS THE SECOND INSTANCE, WHICH IS WHY IT IS WORTH WIRING. The same
 * workflow was already `disabled_manually` on 2026-10-11 (recorded in its
 * WATCHED_GUARDS entry in the detector, `updated_at` 2026-10-11T14:32:32Z). Two
 * silent disables of the same production control in three weeks is a channel
 * defect, not an incident.
 *
 * WHY NOT RAISE THE PROMETHEUS ALERT INSTEAD. The obvious-looking alternative —
 * page on `PaperclipProductionDeployFailing` — is wrong twice over. Its rule in
 * onprem-k8s carries an explicit standing instruction ("SEVERITY IS warning ...
 * a DELIBERATE FLOOR NOT AN OVERSIGHT ... Do not raise this without a measured
 * page-rate argument"), and no such measurement is offered here. More
 * decisively, that alert requires `paperclip_api_deploy_failed_since_success >
 * 0` — a deploy attempt that was DISPATCHED and DIED. A disabled dispatcher
 * dispatches nothing, so the gauge it keys on never moves. It was firing on
 * 2026-11-02 only because of two unrelated manual `docker.yml` failures at
 * 01:24Z and 02:07Z; on the next green deploy it would have retracted while the
 * dispatcher stayed off. It is structurally the wrong instrument for "no
 * attempt is being made", and reaching for it would have bought a page that
 * goes quiet precisely when the fault persists.
 *
 * WHY NOT GitHub Issues. Issues are DISABLED on this repository
 * (`gh api repos/Blockcast/paperclip --jq .has_issues` -> false). BLO-33382 is
 * the incident where an alert path assumed otherwise, died under
 * `set -euo pipefail` before reporting anything, and failed closed AND silently
 * for 8 master failures in 27h. Alertmanager is the channel this org actually
 * runs on, is reachable from the in-cluster `arc-*` pools with no credential,
 * and already backs both `post-docker-agent-alert.mjs` (BLO-33382) and
 * `post-environment-protection-alert.mjs` (BLO-22329).
 *
 * LABEL CARDINALITY IS LOAD-BEARING, AND THE CHOICE HERE IS THE OPPOSITE OF THE
 * OBVIOUS ONE. The Alertmanager fingerprint hashes the ENTIRE label set and the
 * Paperclip bridge dedupes on it, refreshing one issue in place. The tempting
 * design is `workflow: <name>` as a label so each stopped guard gets its own
 * issue. That is wrong HERE, and not merely on cost: the detector's own header
 * states its verdict is per-EVENT, not per-workflow, because the failure shape
 * it was built for is a SHARED-LANE outage — 2026-09-14 and 2026-09-11 each
 * stopped five-to-six guards together. A per-workflow label would mint six
 * issues for one ARC outage, which is the flood BLO-28616 documents. The
 * stopped guards are therefore named in an ANNOTATION, which carries the
 * operator detail without touching alert identity.
 *
 * RESOLUTION IS EXPLICIT, NOT A TIMER. `STATE=resolved` (pushed by the healthy
 * path) sets `endsAt` in the past so Alertmanager immediately sends a resolved
 * notification and the bridge cancels the issue. Without it `endsAt` would be
 * the only thing retiring the alert and the lane would go quiet on a clock
 * rather than on a fix — "silence is not health" in its most deceptive form.
 * That healthy-path push doubles as a continuous capability probe: every green
 * hourly run exercises the exact delivery path the failure path depends on, so
 * a channel that rots is caught by the next healthy run instead of by the next
 * outage. That is the property BLO-33382 was missing.
 *
 * Delivery failure is deliberately fatal. A silent success here would recreate
 * exactly the defect this script exists to close: a guardrail everyone believes
 * is in place.
 */

const DEFAULT_ALERTMANAGER_URL = 'http://alertmanager.monitoring.svc.cluster.local:9093';

/**
 * Long enough that a quiet weekend cannot silently retire a real fault. The
 * detector runs hourly and re-pushes on every red, so in practice the alert is
 * refreshed long before this; the healthy path is what normally clears it. This
 * bound is only the backstop for the case where the detector itself stops —
 * which it cannot report on, by its own stated residual.
 */
export const ALERT_TTL_MS = 72 * 60 * 60 * 1000;

export const ALERTNAME = 'ScheduledGuardLivenessStopped';

/**
 * The detector's stdout is the authority on WHAT is wrong, so it is carried
 * through verbatim rather than re-summarised here — re-wording it in this file
 * would create a second, drifting account of the same verdict. It is only
 * bounded, because Alertmanager annotations are not an unbounded sink and the
 * per-guard annotation block grows with the watched set.
 */
export const MAX_DETAIL_CHARS = 4000;

export function truncateDetail(detail, max = MAX_DETAIL_CHARS) {
  const text = String(detail ?? '').trim();
  if (text.length <= max) return text;
  // Keep the TAIL, not the head. `check-scheduled-guard-liveness.mjs` prints
  // one annotation per guard and then exits with the summary headline on
  // stderr, so the verdict — the line that says how many stopped and why — is
  // the LAST thing written. Truncating from the end would reliably discard the
  // one line an operator needs first.
  return `[...truncated, showing last ${max} characters...]\n${text.slice(-max)}`;
}

export function buildAlert({ state, repo, runUrl, detail, now }) {
  const resolved = state === 'resolved';
  // Alertmanager rejects `startsAt >= endsAt` with `400 start time must be
  // before end time`, so a resolved push cannot simply back-date `endsAt`
  // against a `now` start — both ends move. This is the live 400 that
  // BLO-33382's first cut hit on 2026-09-11.
  const endsAt = resolved ? new Date(now.getTime() - 1000) : new Date(now.getTime() + ALERT_TTL_MS);
  const startsAt = resolved ? new Date(now.getTime() - 2000) : new Date(now);

  return {
    // Stable label set ONLY — see the cardinality note in the file header. No
    // workflow name, no count, no run id: all of those are per-occurrence and
    // would fragment the alert identity the bridge dedupes on.
    labels: {
      alertname: ALERTNAME,
      severity: 'warning',
      namespace: 'paperclip',
      service: 'paperclip-scheduled-guards',
      repo,
    },
    annotations: {
      summary: `A watched scheduled guard has stopped executing in ${repo}`,
      description:
        'One or more scheduled guards watched by `scheduled-guard-liveness` have not completed ' +
        'within their liveness threshold, so a control that is believed to be enforcing is not ' +
        'running. The detector names the cause per guard in `detail` below.\n\n' +
        'A `disabled_manually` state means a HUMAN turned the workflow off. That is often the ' +
        'right call in the moment (PEN-5261: the production-deploy dispatcher was disabled to ' +
        'stop an unattended deploy of the migration behind that morning\'s outage) — but it ' +
        'leaves no issue, no comment and no PR, so this alert is the only record that it has to ' +
        'be turned back ON. Do not simply re-enable: establish the condition that made ' +
        'disabling right, confirm it has passed, then re-enable. If the workflow was retired on ' +
        'purpose, drop it from WATCHED_GUARDS instead, so this stops paging.\n\n' +
        'If several guards stopped together, suspect their shared runner pool rather than the ' +
        'guards (PEN-3272).',
      detail: truncateDetail(detail),
      run_url: runUrl,
      runbook_url: 'https://paperclip.blockcast.net/PEN/issues/PEN-5261',
    },
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  };
}

async function main() {
  const state = process.env.STATE === 'resolved' ? 'resolved' : 'firing';
  const repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY ?? 'unknown/unknown';
  const runUrl = process.env.RUN_URL ?? '';
  const detail = process.env.GUARD_LIVENESS_DETAIL ?? '';
  const base = (process.env.ALERTMANAGER_URL || DEFAULT_ALERTMANAGER_URL).replace(/\/+$/, '');

  const alert = buildAlert({ state, repo, runUrl, detail, now: new Date() });

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
        'Scheduled-guard liveness is UNROUTED until this is fixed: the hourly detector still ' +
        'reds, but nothing carries that red to a human.',
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

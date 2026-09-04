#!/usr/bin/env node
/**
 * post-pending-deploy-alert.mjs
 *
 * Escalates a production deploy that has been parked on the
 * `paperclip-production` reviewer gate for longer than an agreed threshold.
 *
 * WHY THIS EXISTS (PEN-2848)
 * --------------------------
 * scheduled-production-deploy.yml's guard (1) refuses to stack a second
 * dispatch while one is already pending. The guard is correct. But the job it
 * protects is gated on three named human reviewers, so while any deploy sits
 * `waiting`, the daily dispatcher is a permanent no-op — and every skipped run
 * still reports `conclusion: success`. On 2026-09-01 that took production to 45
 * commits behind with an oldest-missing-commit age of 28.8h, and nothing
 * escalated: the mechanism built to remove a human from the loop disarms itself
 * precisely when the human is what is stuck.
 *
 * WHY severity=critical, WHEN THE SIBLING DRIFT ALERT IS ONLY `warning`
 * --------------------------------------------------------------------
 * `PaperclipApiOldestMissingCommitAge` is deliberately `warning` (BLO-22739):
 * it measures *commit age*, which a long-lived branch can push over the line
 * benignly, and its stated reasoning is that "the only remedy is a human
 * dispatching the manual release - there is no automated remediation to page
 * for". This alert is a different signal and does not inherit that reasoning.
 * It fires only when a named reviewer has a specific button in front of them
 * and has not pressed it, so it is actionable by construction. Alertmanager
 * routes `severity=~"critical|page"` to the slack-relay receiver; `warning`
 * reaches the paperclip webhook only — the very receiver whose outage this
 * alert may be needed to fix (PEN-2581). Reaching a human on a path
 * independent of that receiver is the whole point.
 *
 * WHY THIS PUSHES TO ALERTMANAGER RATHER THAN ADDING A PROMETHEUS RULE
 * -------------------------------------------------------------------
 * Both candidate homes for a rule-based version are Argo CD apps with no
 * `automated:` sync policy: `monitoring-rules` and `paperclip-api-deploy-drift`
 * were each `OutOfSync` when this was written (last synced 3 and 17 days
 * earlier). A rule added there merges green and deploys nothing, which is the
 * same defect this issue is about. The deploy-drift exporter also makes its
 * GitHub calls anonymously, so it cannot read `pending_deployments` at all
 * without a new credential. GitHub Actions deploys itself on merge; that is the
 * only plane here that reliably carries a fix.
 *
 * `endsAt` is set past the next scheduled run so the alert stays continuously
 * firing while the approval remains stuck, and auto-resolves (send_resolved:
 * true) once a run stops re-pushing it — so approving or rejecting produces a
 * "resolved" Slack message without this script detecting the fix itself.
 *
 * Delivery failure, an unreadable pending-runs file, a malformed threshold, and
 * an unparseable timestamp on a waiting run are all deliberately fatal. A silent
 * success in any of those cases would recreate the exact defect this check
 * exists to close: a control everyone believes is in place.
 */
import { appendFileSync, readFileSync } from 'node:fs';

const DEFAULT_ALERTMANAGER_URL = 'http://alertmanager.monitoring.svc.cluster.local:9093';
/** Slightly longer than the 24h dispatcher schedule, so firing is continuous. */
export const ALERT_TTL_MS = 25 * 60 * 60 * 1000;
export const DEFAULT_ALERT_AFTER_HOURS = 6;

/**
 * Raised when a `waiting` run carries a timestamp we cannot age. Fatal by
 * design — see selectStuckApproval.
 */
export class UnreadableWaitingRunError extends Error {}

/**
 * Pick the oldest run parked on the human reviewer gate and decide whether it
 * has been there too long.
 *
 * Only `waiting` counts. `queued` and `in_progress` also block the dispatcher's
 * anti-stacking guard, but they are runner/build states — no human is being
 * waited on, and paging three named reviewers for a slow build would be the
 * wrong people and the start of alert fatigue. Their timestamps are never read,
 * so a malformed one on a non-waiting run is ignored rather than fatal.
 *
 * A `waiting` run whose `createdAt` will not parse is fatal, NOT skipped.
 * Excluding it fails open in the one case that matters: if the malformed record
 * is the genuinely stuck approval and some other waiting run is younger than the
 * threshold, dropping it lets this step report "not stuck" and exit 0 — the
 * silent green that PEN-2848 is entirely about. We cannot judge the age, so we
 * say so loudly and let the step fail; `conclusion: failure` is itself one of
 * this change's escalation paths.
 */
export function selectStuckApproval({ pendingRuns, alertAfterHours, now }) {
  const waiting = (pendingRuns ?? []).filter((run) => run?.status === 'waiting');

  const unreadable = waiting.filter((run) => !Number.isFinite(Date.parse(run?.createdAt)));
  if (unreadable.length > 0) {
    const detail = unreadable
      .map(
        (run) => `run ${run?.databaseId ?? '(no id)'} createdAt=${JSON.stringify(run?.createdAt)}`,
      )
      .join('; ');
    throw new UnreadableWaitingRunError(
      `${unreadable.length} waiting deploy(s) have an unparseable createdAt, so their ` +
        `approval age cannot be judged: ${detail}`,
    );
  }

  waiting.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const oldest = waiting[0] ?? null;
  if (!oldest) {
    return { stuck: false, oldest: null, ageHours: 0, waitingCount: 0 };
  }

  const ageHours = (now.getTime() - Date.parse(oldest.createdAt)) / 3_600_000;
  return { stuck: ageHours >= alertAfterHours, oldest, ageHours, waitingCount: waiting.length };
}

export function buildAlert({
  oldest,
  ageHours,
  waitingCount,
  alertAfterHours,
  runUrl,
  repo,
  environment,
  now,
}) {
  const hours = ageHours.toFixed(1);
  const pendingUrl = oldest.url ?? '(url unavailable)';

  return {
    labels: {
      alertname: 'ProductionDeployApprovalStuck',
      severity: 'critical',
      namespace: 'paperclip',
      service: 'paperclip-production-deploy-gate',
      repo,
      environment,
    },
    annotations: {
      summary:
        `${repo} production deploy has been awaiting human approval for ${hours}h — ` +
        'the daily dispatcher is a no-op until it clears',
      description:
        `A docker.yml deploy has been parked on the ${environment} reviewer gate since ` +
        `${oldest.createdAt} (${hours}h; threshold ${alertAfterHours}h).\n\n` +
        "While it waits, scheduled-production-deploy.yml's anti-stacking guard skips every " +
        'daily slot, so production drift grows and each skipped run still reports ' +
        'conclusion=success. Nothing else escalates this.\n\n' +
        `Approve or reject the pending run to clear it: ${pendingUrl}\n\n` +
        `${waitingCount} deploy(s) currently waiting on this gate.`,
      pending_run_url: pendingUrl,
      pending_since: oldest.createdAt,
      run_url: runUrl,
      runbook_url: 'https://paperclip.blockcast.net/PEN/issues/PEN-2848',
    },
    startsAt: now.toISOString(),
    endsAt: new Date(now.getTime() + ALERT_TTL_MS).toISOString(),
  };
}

function setOutput(name, value) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  appendFileSync(path, `${name}=${value}\n`);
}

function readPendingRuns(path) {
  // Unlike the sibling protection alert, a missing file here is fatal rather
  // than "alert anyway": this step only runs because the dispatcher already
  // reported something pending, so an unreadable file means we cannot judge the
  // age — and reporting "not stuck" from a failed read is how a control goes
  // quietly blind.
  if (!path) {
    console.error('::error::PENDING_JSON_PATH is not set; cannot judge approval age.');
    process.exit(1);
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array of runs');
    return parsed;
  } catch (err) {
    console.error(`::error::Could not read pending dispatches from ${path}: ${err.message}`);
    process.exit(1);
  }
}

async function main() {
  const alertAfterHours = Number(process.env.ALERT_AFTER_HOURS ?? DEFAULT_ALERT_AFTER_HOURS);
  if (!Number.isFinite(alertAfterHours) || alertAfterHours <= 0) {
    // A misconfigured threshold must not silently disable the escalation.
    console.error(
      `::error::ALERT_AFTER_HOURS must be a positive number, got "${process.env.ALERT_AFTER_HOURS}".`,
    );
    process.exit(1);
  }

  const repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY ?? 'unknown/unknown';
  const environment = process.env.ENVIRONMENT_NAME || 'paperclip-production';
  const runUrl = process.env.RUN_URL ?? '';
  const base = (process.env.ALERTMANAGER_URL || DEFAULT_ALERTMANAGER_URL).replace(/\/+$/, '');

  const now = new Date();
  let verdict;
  try {
    verdict = selectStuckApproval({
      pendingRuns: readPendingRuns(process.env.PENDING_JSON_PATH),
      alertAfterHours,
      now,
    });
  } catch (err) {
    if (!(err instanceof UnreadableWaitingRunError)) throw err;
    // Same reasoning as an unreadable pending-runs file: this step only runs
    // because the dispatcher already reported something pending, so being
    // unable to age it is a failed read, not a clean bill of health.
    console.error(
      `::error::Cannot judge production approval age: ${err.message}. ` +
        'Failing rather than reporting no stuck approval.',
    );
    process.exit(1);
  }

  if (!verdict.stuck) {
    setOutput('escalated', 'false');
    console.log(
      verdict.oldest
        ? `Oldest waiting deploy is ${verdict.ageHours.toFixed(1)}h old, under the ` +
            `${alertAfterHours}h threshold — skip recorded, not escalating.`
        : 'No deploy is waiting on a human reviewer (pending runs are queued/building) — ' +
            'not escalating.',
    );
    return;
  }

  const alert = buildAlert({ ...verdict, alertAfterHours, runUrl, repo, environment, now });
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
        `The stuck approval is still real — ${alert.annotations.pending_run_url}`,
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

  setOutput('escalated', 'true');
  console.log(
    `Pushed ${alert.labels.alertname} (severity=${alert.labels.severity}) to ${url}; ` +
      `firing until ${alert.endsAt}. Pending since ${alert.annotations.pending_since}.`,
  );
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // An unhandled rejection would still exit non-zero, but without an ::error::
  // annotation naming the cause — on a path whose whole purpose is being legible
  // from the Actions list, that is worth the four lines.
  main().catch((err) => {
    console.error(`::error::post-pending-deploy-alert failed unexpectedly: ${err?.stack ?? err}`);
    process.exit(1);
  });
}

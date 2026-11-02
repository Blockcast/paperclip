#!/usr/bin/env node
/**
 * PEN-5285: deliver an unaccounted dependency advisory to Alertmanager rather
 * than relying on the scheduled workflow author's Actions notification, which
 * may not map to a GitHub user. Mirrors post-lockfile-drift-alert.mjs; stable
 * labels let Alertmanager deduplicate while the advisory persists, which
 * matters more here than for drift — an unremediated advisory can legitimately
 * stay open for weeks, and a daily re-page would train the route to ignore it.
 */

import { readFileSync } from 'node:fs';

const DEFAULT_ALERTMANAGER_URL = 'http://alertmanager.monitoring.svc.cluster.local:9093';

// Longer than the lockfile monitor's 2h because this job runs daily, not
// hourly: a TTL shorter than the cadence would let the alert resolve itself
// between runs and re-fire as new every day, defeating deduplication.
export const ALERT_TTL_MS = 26 * 60 * 60 * 1000;

/**
 * Pull just the violation lines out of the lane's report. Notices are
 * deliberately dropped: they are the non-failing half (below-threshold
 * advisories, and baseline entries the feed stopped reporting), and paging a
 * human with good news is how a route learns to ignore the alert.
 */
export function extractViolations(report) {
  if (!report) return [];
  return report
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\[(unbaselined|expired|severity-escalated)\]/.test(line));
}

export function buildAlert({ violations, runUrl, repo, now }) {
  // The lane fails for TWO unrelated reasons and they route to different
  // people. Either it found an unaccounted advisory -- a triage task -- or it
  // could not complete at all: registry unreachable, pnpm emitting an error
  // document, a malformed baseline, normalizeAudit refusing an unrecognized
  // shape. Failing closed on the second is right, but labelling it
  // `DependencyAdvisoryUnaccounted` sends the on-call hunting for an advisory
  // that was never reported. Raised by Ally on #3290.
  const incomplete = !violations?.length;
  const lines = incomplete
    ? ['the lane did not produce a violation list - see the run log for why it could not complete']
    : violations;
  return {
    labels: {
      alertname: incomplete ? 'DependencyAuditIncomplete' : 'DependencyAdvisoryUnaccounted',
      severity: 'warning',
      namespace: 'paperclip',
      service: 'paperclip-dependency-audit',
      repo,
      branch: 'master',
    },
    annotations: {
      summary: incomplete
        ? `${repo} master dependency audit could not complete`
        : `${repo} master has a dependency advisory with no triage entry`,
      description: lines.map((line) => `  - ${line}`).join('\n'),
      run_url: runUrl,
      runbook_url: 'https://github.com/Blockcast/paperclip/blob/master/runbooks/dependency-audit.md',
    },
    startsAt: now.toISOString(),
    endsAt: new Date(now.getTime() + ALERT_TTL_MS).toISOString(),
  };
}

function readReport() {
  const path = process.env.AUDIT_REPORT_FILE;
  if (!path) return null;
  try {
    const found = extractViolations(readFileSync(path, 'utf8'));
    return found.length > 0 ? found : null;
  } catch (error) {
    console.error(`::warning::could not read ${path}: ${error.message}`);
    return null;
  }
}

async function main() {
  const base = (process.env.ALERTMANAGER_URL || DEFAULT_ALERTMANAGER_URL).replace(/\/+$/, '');
  const alert = buildAlert({
    violations: readReport(),
    runUrl: process.env.RUN_URL ?? '',
    repo: process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY ?? 'unknown/unknown',
    now: new Date(),
  });

  const url = `${base}/api/v2/alerts`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([alert]),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.error(`::error::ALERT DELIVERY FAILED: could not reach Alertmanager at ${url}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(`::error::ALERT DELIVERY FAILED: Alertmanager returned ${response.status}: ${body.slice(0, 500)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Pushed ${alert.labels.alertname} to ${url}; firing until ${alert.endsAt}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

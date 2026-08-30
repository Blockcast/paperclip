#!/usr/bin/env node
/**
 * Deliver lockfile drift to Alertmanager instead of relying on the scheduled
 * workflow author's Actions notification, which may not map to a GitHub user.
 * Stable labels let Alertmanager deduplicate repeated hourly failures.
 */

const DEFAULT_ALERTMANAGER_URL = 'http://alertmanager.monitoring.svc.cluster.local:9093';
export const ALERT_TTL_MS = 2 * 60 * 60 * 1000;

export function buildAlert({ summary, runUrl, repo, now }) {
  const violations = summary?.violations ?? ['(summary unavailable - see the run log)'];
  const description = violations.map((violation) => `  - ${violation}`).join('\n');

  return {
    labels: {
      alertname: 'LockfileDriftDetected',
      severity: 'critical',
      namespace: 'paperclip',
      service: 'paperclip-lockfile-drift-monitor',
      repo,
      branch: 'master',
    },
    annotations: {
      summary: `${repo} master lockfile overrides are inconsistent`,
      description,
      run_url: runUrl,
    },
    startsAt: now.toISOString(),
    endsAt: new Date(now.getTime() + ALERT_TTL_MS).toISOString(),
  };
}

async function main() {
  const base = (process.env.ALERTMANAGER_URL || DEFAULT_ALERTMANAGER_URL).replace(/\/+$/, '');
  const alert = buildAlert({
    summary: { violations: process.env.DRIFT_SUMMARY ? [process.env.DRIFT_SUMMARY] : null },
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

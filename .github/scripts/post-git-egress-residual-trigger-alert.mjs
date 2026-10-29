#!/usr/bin/env node
/**
 * PEN-4988. Deliver a fired (or unreadable) PEN-3183 §7.2 trigger to Alertmanager.
 *
 * A red scheduled run is NOT the alerting path — it only notifies the last
 * committer. This is the path that reaches a human, and it matters more here than
 * for most guards: the condition it reports ENDS a security acceptance early, and
 * until this row nothing watched for it at all.
 *
 * Exit 1 (fired) and exit 2 (could not run) get DIFFERENT alertnames. "Bypass 3
 * has re-opened" and "nothing is currently watching for bypass 3 re-opening" have
 * different remedies, and folding the second into the first would report a
 * condition nobody has observed.
 */

const DEFAULT_ALERTMANAGER_URL = 'http://alertmanager.monitoring.svc.cluster.local:9093';
export const ALERT_TTL_MS = 2 * 60 * 60 * 1000;

/** Lifts the gate leg(s) out of the detector's report; that is the remedy selector. */
export function parseReasons(detail) {
  const match = /^reasons\s*=\s*(.+)$/m.exec(detail ?? '');
  return match ? match[1].trim() : null;
}

export function buildAlert({ exitCode, detail, runUrl, repo, now }) {
  const fired = exitCode === '1';
  const reasons = parseReasons(detail);

  const description = fired
    ? [
        'An agent Job rendered a BROAD read-write data mount (paperclip.io/data-mount-scope:',
        'broad:*). That is §7.2 trigger 2 of docs/security/',
        'PEN-3183-git-egress-enforcement-boundary-decision.md: it re-opens bypass 3 — the agent',
        'can write the git hooks directory again, so the egress guard returns to peers-not-layers.',
        '',
        `Gate leg(s) that fell through: ${reasons ?? '(see the run log)'}`,
        '',
        'THIS ENDS THE RESIDUAL ACCEPTANCE EARLY, regardless of the 2027-01-31 date. Do not',
        'treat it as hygiene and do not fold it silently into the PEN-4933 broker rollout.',
        '',
        'What to do:',
        '  1. Read the run summary for the reason leg, Job name and run id.',
        '  2. All three legs are operator-fixable config — isolation_disabled, no_claim and',
        '     foreign_claim are distinguished at job-manifest.ts (search broadDataMountReason).',
        '  3. Raise it to the CTO and record it on PEN-3183 / PEN-4988. §7.2 is the authority.',
        '',
        'NOTE the broker interaction: with enableGitHubPublishBroker set, a broad mount makes',
        'buildJobManifest THROW rather than render, so a fired trigger here may also be stopping',
        'runs outright.',
      ].join('\n')
    : [
        'The PEN-3183 §7.2 trigger-2 detector could not run (exit 2). It is NOT reporting that',
        'the trigger is clear — it is reporting that NOTHING is currently watching for an agent',
        'Job rendering a broad data mount.',
        '',
        'Causes, in the order worth checking:',
        '  1. Loki unreachable or unhealthy at LOKI_URL (default',
        '     loki.monitoring.svc.cluster.local:3100). The runner reaches it in-cluster, so this',
        '     usually means Loki, not the network.',
        '  2. Loki answered with a non-success status — a malformed query or a rejected range.',
        '  3. WINDOW_MINUTES was set to something non-numeric. Refused deliberately: a NaN range',
        '     returns an empty result, which is a confident FALSE CLEAR.',
        '',
        'Until it runs again the residual acceptance is unwatched. That is the condition this',
        'alert exists to make visible, not an incidental CI failure.',
      ].join('\n');

  return {
    labels: {
      alertname: fired ? 'GitEgressResidualTriggerFired' : 'GitEgressResidualTriggerCheckUnreadable',
      severity: 'critical',
      namespace: 'paperclip',
      service: 'paperclip-git-egress-residual-trigger-check',
      repo,
      branch: 'master',
    },
    annotations: {
      summary: fired
        ? `${repo} PEN-3183 §7.2 trigger 2 FIRED — an agent Job rendered a broad data mount`
        : `${repo} PEN-3183 §7.2 trigger-2 detector could not run`,
      description,
      run_url: runUrl,
    },
    startsAt: now.toISOString(),
    endsAt: new Date(now.getTime() + ALERT_TTL_MS).toISOString(),
  };
}

async function main() {
  const { readFileSync } = await import('node:fs');
  const base = (process.env.ALERTMANAGER_URL || DEFAULT_ALERTMANAGER_URL).replace(/\/+$/, '');

  let detail = '';
  if (process.env.DETAIL_PATH) {
    try {
      detail = readFileSync(process.env.DETAIL_PATH, 'utf8');
    } catch {
      detail = '';
    }
  }

  const alert = buildAlert({
    exitCode: process.env.EXIT_CODE ?? '',
    detail,
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

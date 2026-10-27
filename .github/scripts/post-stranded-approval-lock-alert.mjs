#!/usr/bin/env node
/**
 * PEN-4841. Deliver a stranded production approval lock to Alertmanager.
 *
 * A red scheduled run is NOT the alerting path — it only notifies the last
 * committer, which is the failure mode documented at length in
 * production-environment-protection-guard.yml. This is the path that reaches a
 * human. Stable labels let Alertmanager deduplicate the repeated hourly firings
 * a stranded lock necessarily produces until someone retires it.
 *
 * Exit 1 (stranded) and exit 2 (could not run) get DIFFERENT alertnames. They
 * have different remedies — one is "retire the lock", the other is "this check
 * cannot see the cluster" — and folding an unreadable check into the stranded
 * alarm would report a condition nobody has actually observed.
 */

const DEFAULT_ALERTMANAGER_URL = 'http://alertmanager.monitoring.svc.cluster.local:9093';
export const ALERT_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Lifts the pasteable retirement pair out of the detector's report so it lands
 * in the alert itself. Whoever reads this in Slack can act without opening the
 * run — and the pair is the whole remedy.
 */
export function parseDetail(detail) {
  const field = (name) => {
    const match = new RegExp(`^${name}\\s*=\\s*(.+)$`, 'm').exec(detail ?? '');
    return match ? match[1].trim() : null;
  };
  return {
    digest: field('lock_digest'),
    owner: field('lock_owner'),
    verdict: field('verdict'),
  };
}

export function buildAlert({ exitCode, detail, runUrl, repo, now }) {
  const stranded = exitCode === '1';
  const { digest, owner } = parseDetail(detail);

  const description = stranded
    ? [
        'An in-flight approval lock on ConfigMap/paperclip-api-approved-images can never be',
        'satisfied. EVERY production deploy is refused at its approval step until it is retired.',
        '',
        'Retire it by re-dispatching docker.yml (workflow_dispatch) with:',
        `  abandon_in_flight:       ${digest ?? '(see the run log)'}`,
        `  abandon_in_flight_owner: ${owner ?? '(see the run log)'}`,
        '',
        'target_sha is also REQUIRED on that form — use master\'s current tip.',
        'Re-read the pair before dispatching; any successful deploy replaces it.',
        'Confirm the rollout is genuinely not still landing first.',
      ].join('\n')
    : [
        'The stranded-approval-lock check could not run (exit 2): a required tool is missing or',
        'one of its two objects is unreadable. It is NOT reporting that the lock is fine — it is',
        'reporting that nothing is currently watching for a stranded lock at all.',
        '',
        'If this is the first run after PEN-4841 shipped, the likely cause is that',
        'BLOCKCAST_KUBE_CONFIG_B64 lacks get on ConfigMap paperclip-release-approvals/',
        'paperclip-api-approved-images or Deployment paperclip/paperclip-api. The workflow header',
        'records the fallback.',
      ].join('\n');

  return {
    labels: {
      alertname: stranded ? 'StrandedApprovalLockDetected' : 'StrandedApprovalLockCheckUnreadable',
      severity: 'critical',
      namespace: 'paperclip',
      service: 'paperclip-stranded-approval-lock-check',
      repo,
      branch: 'master',
    },
    annotations: {
      summary: stranded
        ? `${repo} production deploys are blocked by a stranded approval lock`
        : `${repo} stranded-approval-lock check could not run`,
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

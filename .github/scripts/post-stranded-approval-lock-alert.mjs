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
 * The detector renders an absent annotation as an angle-bracketed placeholder
 * rather than as a blank -- `lock_owner         = <empty>` at
 * check-stranded-approval-lock.sh:263. Those are prose, not values. Carrying one
 * through verbatim is what put `abandon_in_flight_owner: <empty>` into the form
 * this alert tells an operator to paste. Every real value on these three lines is
 * a hex digest, a hex owner id or a single verdict word, so rejecting anything
 * wholly wrapped in angle brackets cannot discard a legitimate reading.
 */
const PLACEHOLDER = /^<[\s\S]*>$/;

/**
 * Lifts the pasteable retirement pair out of the detector's report so it lands
 * in the alert itself. Whoever reads this in Slack can act without opening the
 * run — and the pair is the whole remedy.
 */
export function parseDetail(detail) {
  const field = (name) => {
    const match = new RegExp(`^${name}\\s*=\\s*(.+)$`, 'm').exec(detail ?? '');
    if (!match) return null;
    const value = match[1].trim();
    return PLACEHOLDER.test(value) ? null : value;
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

  // A lock with no owner annotation cannot be retired through docker.yml's form
  // at all -- the detector's own pasteable block says so in as many words
  // (check-stranded-approval-lock.sh:322). Distinguish that from "we never got a
  // report to read": if the digest parsed, the report rendered, so a null owner
  // IS the ownerless lock rather than a parse failure.
  const ownerLine =
    owner ??
    (digest
      ? '<MISSING -- this lock has no owner annotation; retire it by hand>'
      : '(see the run log)');

  const description = stranded
    ? [
        'An in-flight approval lock on ConfigMap/paperclip-api-approved-images can never be',
        'satisfied. EVERY production deploy is refused at its approval step until it is retired.',
        '',
        'Retire it by re-dispatching docker.yml (workflow_dispatch) with:',
        `  abandon_in_flight:       ${digest ?? '(see the run log)'}`,
        `  abandon_in_flight_owner: ${ownerLine}`,
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
        'Common causes of exit 2 -- NOT an exhaustive list (a non-integer grace',
        'override and an undecidable jq predicate also land here). The detector names',
        'which on stderr before it exits, so read the step summary first:',
        '',
        '  1. kubeconfig was never configured — KUBECONFIG_PAPERCLIP_CI_DEPLOY absent or',
        '     not base64-decodable. It is an environment secret, so it also reads as',
        '     absent if the job stops declaring environment: paperclip-production. That',
        '     step is continue-on-error precisely so this alert still fires; check',
        '     whether it went red in the run.',
        '  2. RBAC — the credential lacks get on ConfigMap paperclip-release-approvals/',
        '     paperclip-api-approved-images or Deployment paperclip/paperclip-api. The',
        '     workflow header records the fallback.',
        '  3. A required tool (kubectl, jq, sha256sum) is missing from the runner image.',
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

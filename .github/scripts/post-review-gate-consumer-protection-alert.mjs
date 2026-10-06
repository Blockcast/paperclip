#!/usr/bin/env node
/**
 * post-review-gate-consumer-protection-alert.mjs
 *
 * Pushes a required-review drift alert for the four review-gate consumer repos
 * into Alertmanager so it reaches a human. A red workflow run is deliberately
 * NOT the alerting path — it only emails the last committer, and this guard
 * lives in a repo whose committers are mostly agents.
 *
 * severity=critical by design, not by escalation reflex: Alertmanager routes
 * `severity=~"critical|page"` to the slack-relay receiver, and what lapses here
 * is the only control standing between "anyone who can push a branch" and a
 * merge on four repositories (BLO-26736).
 *
 * Delivery failure is fatal. A silent success here would recreate the exact
 * defect the guard exists to close: a control everyone believes is in place.
 */
import { readFileSync } from 'node:fs';
import { violationKindsLabel, UNKNOWN_VIOLATION_KINDS } from './post-environment-protection-alert.mjs';

const DEFAULT_ALERTMANAGER_URL = 'http://alertmanager.monitoring.svc.cluster.local:9093';
/** Slightly longer than the 12h schedule interval, so firing is continuous. */
export const ALERT_TTL_MS = 13 * 60 * 60 * 1000;

export function buildAlert({ exitCode, summary, runUrl, now }) {
  const unreadable = String(exitCode) === '2';
  const violations = summary?.violations ?? ['(summary unavailable — see run log)'];

  return {
    labels: {
      alertname: unreadable
        ? 'ReviewGateConsumerProtectionUnreadable'
        : 'ReviewGateConsumerProtectionDrift',
      severity: 'critical',
      namespace: 'paperclip',
      service: 'review-gate-consumer-merge-control',
      // Keyed into the fingerprint for the PEN-2863 reason: the alert is
      // re-pushed continuously while drift persists, so without this a SECOND
      // repo drifting on top of an existing one reuses the fingerprint and
      // silently swaps the description instead of firing. Repos are in the
      // value too, because "hang-mmt-fec lost its gate" and "core lost its
      // gate" are different incidents with the same violation kind.
      violation_kinds: unreadable
        ? `unreadable:${(summary?.unreadable ?? []).slice().sort().join(',') || UNKNOWN_VIOLATION_KINDS}`
        : violationKindsLabel(summary?.violationKinds),
    },
    annotations: {
      summary: unreadable
        ? `Review-gate consumer protection could not be evaluated on: ${(summary?.unreadable ?? ['unknown']).join(', ')}`
        : 'A review-gate consumer no longer requires an approving review to merge',
      description:
        (unreadable
          ? 'At least one consumer repository could NOT be evaluated, so its merge control is unknown. ' +
            'This is never a pass.\n'
          : 'A required-review control applied on 2026-10-05 (BLO-27563) is no longer in force. Until it ' +
            'is restored, the merge decision on that repo rests on `review/ally-complete`, which any pull ' +
            'request can write for its own head SHA (BLO-26736).\n') +
        violations.map((v) => `  - ${v}`).join('\n'),
      observed: JSON.stringify(summary?.observed ?? {}),
      run_url: runUrl,
    },
    startsAt: new Date(now).toISOString(),
    endsAt: new Date(now.getTime() + ALERT_TTL_MS).toISOString(),
  };
}

function readSummary(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // The check may have died before writing the summary. Alert anyway — the
    // absence of detail is not a reason to stay quiet.
    return null;
  }
}

async function main() {
  const runUrl = process.env.RUN_URL ?? '';
  const base = (process.env.ALERTMANAGER_URL || DEFAULT_ALERTMANAGER_URL).replace(/\/+$/, '');
  const alert = buildAlert({
    exitCode: process.env.EXIT_CODE ?? '1',
    summary: readSummary(process.env.SUMMARY_PATH),
    runUrl,
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
        'The drift itself is still real — see the check step log.',
    );
    process.exit(1);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`::error::ALERT DELIVERY FAILED: Alertmanager ${url} returned ${res.status}: ${body.slice(0, 500)}`);
    process.exit(1);
  }

  console.log(`Pushed ${alert.labels.alertname} (severity=critical) to ${url}; firing until ${alert.endsAt}.`);
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

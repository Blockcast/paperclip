#!/usr/bin/env node
/**
 * post-environment-protection-alert.mjs
 *
 * Pushes a `paperclip-production` protection-drift alert into Alertmanager so
 * it reaches a human. Alertmanager's route tree sends `severity=~"critical|page"`
 * to the slack-relay receiver; everything else lands only on the paperclip
 * webhook. This alert is therefore severity=critical by design, not by
 * escalation reflex — a lapsed production deploy gate is the one thing this
 * check exists to shout about (BLO-22329).
 *
 * `endsAt` is set past the next scheduled run so the alert stays continuously
 * firing while drift persists, and auto-resolves (send_resolved: true) once a
 * run stops re-pushing it. That means a fix produces a "resolved" Slack message
 * without this script needing to detect the fix itself.
 *
 * Delivery failure is deliberately fatal. If the runner cannot reach
 * Alertmanager, a silent success here would recreate the exact defect this
 * whole check exists to close: a control everyone believes is in place.
 */
import { readFileSync } from 'node:fs';

const DEFAULT_ALERTMANAGER_URL = 'http://alertmanager.monitoring.svc.cluster.local:9093';
/** Slightly longer than the 12h schedule interval, so firing is continuous. */
export const ALERT_TTL_MS = 13 * 60 * 60 * 1000;

/**
 * Label value used when the check died before writing its summary, so we know
 * a violation set exists but not which. Stable on purpose: a churning value
 * here would mint a new alert every run and drown the real signal.
 */
export const UNKNOWN_VIOLATION_KINDS = 'unknown';

/**
 * Collapse the violation-kind slugs into one stable label value.
 *
 * Sorted so that the same set of violations always yields the same string
 * regardless of the order the check emitted them — an unstable value would
 * re-fire the alert on every run for no reason.
 */
export function violationKindsLabel(kinds) {
  if (!Array.isArray(kinds) || kinds.length === 0) return UNKNOWN_VIOLATION_KINDS;
  return [...new Set(kinds)].sort().join(',');
}

export function buildAlert({ exitCode, summary, runUrl, repo, environment, now }) {
  const unreadable = String(exitCode) === '2';
  const startsAt = new Date(now);
  const endsAt = new Date(now.getTime() + ALERT_TTL_MS);

  const description = unreadable
    ? `The ${environment} environment could NOT be read, so its protection state is unknown. ` +
      `This is never a pass. Reason: ${summary?.reason ?? 'unknown'}`
    : `The ${environment} environment no longer matches the board-ratified protection shape ` +
      `(approval b75f8156). Violations:\n` +
      (summary?.violations ?? ['(summary unavailable — see run log)'])
        .map((v) => `  - ${v}`)
        .join('\n');

  return {
    labels: {
      alertname: unreadable
        ? 'ProductionEnvironmentProtectionUnreadable'
        : 'ProductionEnvironmentProtectionDrift',
      severity: 'critical',
      namespace: 'paperclip',
      service: 'paperclip-production-deploy-gate',
      repo,
      environment,
      // WHY THIS IS A LABEL AND NOT JUST AN ANNOTATION (PEN-2863):
      // Alertmanager's fingerprint is computed over labels, and this alert is
      // re-pushed with endsAt beyond the schedule interval so it fires
      // continuously while drift persists. With only the static labels above,
      // a *second* violation appearing on top of an existing one reused the
      // same fingerprint: Alertmanager saw the same already-firing alert and
      // silently swapped the description annotation, so no new-firing
      // notification was ever produced. That is how a tolerated drift masks an
      // intolerable one — e.g. `can_admins_bypass` flipping to true while a
      // benign membership drift is already firing, which is exactly the
      // compound the 2026-08-08 incident turned on. Keying the fingerprint to
      // the violation set makes the new shape a new alert (and lets the old
      // one auto-resolve via send_resolved), so the change is what pages.
      // Grouping is unaffected: the route groups by [alertname, namespace].
      violation_kinds: unreadable ? 'unreadable' : violationKindsLabel(summary?.violationKinds),
    },
    annotations: {
      summary: unreadable
        ? `Cannot read ${repo} environment '${environment}' — protection state unknown`
        : `${repo} environment '${environment}' protection has drifted`,
      description,
      observed: JSON.stringify(summary?.observed ?? {}),
      run_url: runUrl,
    },
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
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
  const exitCode = process.env.EXIT_CODE ?? '1';
  const repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY ?? 'unknown/unknown';
  const environment = process.env.ENVIRONMENT_NAME || 'paperclip-production';
  const runUrl = process.env.RUN_URL ?? '';
  const base = (process.env.ALERTMANAGER_URL || DEFAULT_ALERTMANAGER_URL).replace(/\/+$/, '');

  const alert = buildAlert({
    exitCode,
    summary: readSummary(process.env.SUMMARY_PATH),
    runUrl,
    repo,
    environment,
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
    console.error(
      `::error::ALERT DELIVERY FAILED: Alertmanager ${url} returned ${res.status}: ${body.slice(0, 500)}`,
    );
    process.exit(1);
  }

  console.log(
    `Pushed ${alert.labels.alertname} (severity=${alert.labels.severity}) to ${url}; ` +
      `firing until ${alert.endsAt}.`,
  );
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

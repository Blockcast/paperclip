import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALERT_TTL_MS,
  UNKNOWN_VIOLATION_KINDS,
  buildAlert,
  violationKindsLabel,
} from '../post-environment-protection-alert.mjs';

const NOW = new Date('2026-08-14T09:00:00.000Z');
const base = {
  runUrl: 'https://github.com/Blockcast/paperclip/actions/runs/1',
  repo: 'Blockcast/paperclip',
  environment: 'paperclip-production',
  now: NOW,
};

test('buildAlert: drift carries severity=critical so Alertmanager routes it to slack-relay', () => {
  const alert = buildAlert({
    ...base,
    exitCode: '1',
    summary: { violations: ['can_admins_bypass: expected false, got true'], observed: {} },
  });

  // The route tree matches severity=~"critical|page" -> slack-relay. Anything
  // else reaches the paperclip webhook only, which is not a human.
  assert.equal(alert.labels.severity, 'critical');
  assert.equal(alert.labels.alertname, 'ProductionEnvironmentProtectionDrift');
  assert.match(alert.annotations.description, /can_admins_bypass/);
  assert.equal(alert.annotations.run_url, base.runUrl);
});

test('buildAlert: unreadable gets a DISTINCT alertname and never reads as compliant', () => {
  const alert = buildAlert({
    ...base,
    exitCode: '2',
    summary: { status: 'unreadable', reason: '403: Resource not accessible by integration' },
  });

  assert.equal(alert.labels.alertname, 'ProductionEnvironmentProtectionUnreadable');
  assert.equal(alert.labels.severity, 'critical');
  assert.match(alert.annotations.summary, /Cannot read/);
  assert.match(alert.annotations.description, /403/);
  assert.match(alert.annotations.description, /never a pass/);
});

test('buildAlert: still alerts when the summary file is missing entirely', () => {
  const alert = buildAlert({ ...base, exitCode: '1', summary: null });

  assert.equal(alert.labels.alertname, 'ProductionEnvironmentProtectionDrift');
  assert.match(alert.annotations.description, /summary unavailable/);
});

test('buildAlert: endsAt outlives the schedule interval so firing stays continuous', () => {
  const alert = buildAlert({ ...base, exitCode: '1', summary: null });

  assert.equal(alert.startsAt, NOW.toISOString());
  assert.equal(new Date(alert.endsAt).getTime() - NOW.getTime(), ALERT_TTL_MS);
  // 12h schedule; a TTL at or under that would let the alert resolve between
  // runs and re-notify as if it were new.
  assert.ok(ALERT_TTL_MS > 12 * 60 * 60 * 1000);
});

test('buildAlert: labels identify the repo and environment for grouping', () => {
  const alert = buildAlert({ ...base, exitCode: '1', summary: null });

  assert.equal(alert.labels.repo, 'Blockcast/paperclip');
  assert.equal(alert.labels.environment, 'paperclip-production');
  assert.equal(alert.labels.namespace, 'paperclip');
});

// --- violation_kinds: the fingerprint has to track the violation SET ------
// Regression cover for PEN-2863. This alert is deliberately re-pushed with
// endsAt past the schedule interval so it fires continuously while drift
// persists. Alertmanager fingerprints on labels, so if the labels don't encode
// which controls are broken, a second violation landing on top of an existing
// one reuses the fingerprint and only mutates an annotation — no new firing
// notification, and the tolerated drift masks the intolerable one.

test('buildAlert: a NEW violation on top of an existing one changes the labels', () => {
  // Live shape on 2026-09-01: a benign membership widening, firing for days.
  const benign = buildAlert({
    ...base,
    exitCode: '1',
    summary: {
      violations: ['required_reviewers membership: unexpected ["kkroo"]'],
      violationKinds: ['required_reviewers_membership'],
    },
  });

  // The dangerous half of the 2026-08-08 compound arrives while that fires.
  const compound = buildAlert({
    ...base,
    exitCode: '1',
    summary: {
      violations: [
        'required_reviewers membership: unexpected ["kkroo"]',
        'can_admins_bypass: expected false, got true',
      ],
      violationKinds: ['required_reviewers_membership', 'can_admins_bypass'],
    },
  });

  // Before this label existed both alerts were label-identical, so Alertmanager
  // treated the second as the same already-firing alert and nobody was told.
  assert.notDeepEqual(compound.labels, benign.labels);
  assert.equal(benign.labels.violation_kinds, 'required_reviewers_membership');
  assert.equal(compound.labels.violation_kinds, 'can_admins_bypass,required_reviewers_membership');
});

test('buildAlert: an UNCHANGED violation set keeps identical labels across runs', () => {
  // The flip side: re-pushing the same drift must not mint a new alert every
  // 12h, or the signal drowns in its own noise.
  const summary = {
    violations: ['required_reviewers membership: unexpected ["kkroo"]'],
    violationKinds: ['required_reviewers_membership'],
  };
  const first = buildAlert({ ...base, exitCode: '1', summary });
  const second = buildAlert({
    ...base,
    exitCode: '1',
    now: new Date('2026-08-14T21:00:00.000Z'),
    summary,
  });

  assert.deepEqual(second.labels, first.labels);
});

test('violationKindsLabel: order-independent, deduped, and stable', () => {
  // Emission order is an implementation detail of the check; the label must not
  // move because of it.
  assert.equal(
    violationKindsLabel(['can_admins_bypass', 'required_reviewers_membership']),
    violationKindsLabel(['required_reviewers_membership', 'can_admins_bypass']),
  );
  assert.equal(violationKindsLabel(['can_admins_bypass', 'can_admins_bypass']), 'can_admins_bypass');
});

test('violationKindsLabel: a missing summary degrades to a STABLE placeholder', () => {
  // The check can die before writing the summary. Alert anyway (existing
  // behaviour), but with a fixed value — a churning one would re-fire forever.
  assert.equal(violationKindsLabel(undefined), UNKNOWN_VIOLATION_KINDS);
  assert.equal(violationKindsLabel([]), UNKNOWN_VIOLATION_KINDS);
  assert.equal(buildAlert({ ...base, exitCode: '1', summary: null }).labels.violation_kinds, UNKNOWN_VIOLATION_KINDS);
});

test('buildAlert: unreadable is its own violation_kinds value, never a drift shape', () => {
  const alert = buildAlert({
    ...base,
    exitCode: '2',
    summary: { status: 'unreadable', reason: '403' },
  });

  assert.equal(alert.labels.violation_kinds, 'unreadable');
});

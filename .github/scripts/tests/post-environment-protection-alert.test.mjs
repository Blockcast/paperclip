import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_TTL_MS, buildAlert } from '../post-environment-protection-alert.mjs';

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

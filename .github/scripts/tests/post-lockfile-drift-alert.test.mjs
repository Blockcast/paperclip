import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_TTL_MS, buildAlert } from '../post-lockfile-drift-alert.mjs';

const NOW = new Date('2026-08-30T12:00:00.000Z');
const base = {
  runUrl: 'https://github.com/Blockcast/paperclip/actions/runs/1',
  repo: 'Blockcast/paperclip',
  now: NOW,
};

test('buildAlert uses stable grouping labels and a routable severity', () => {
  const alert = buildAlert({ ...base, summary: { violations: ['missing override'] } });

  assert.deepEqual(alert.labels, {
    alertname: 'LockfileDriftDetected',
    severity: 'critical',
    namespace: 'paperclip',
    service: 'paperclip-lockfile-drift-monitor',
    repo: 'Blockcast/paperclip',
    branch: 'master',
  });
  assert.match(alert.annotations.description, /missing override/);
  assert.equal(alert.annotations.run_url, base.runUrl);
});

test('buildAlert keeps repeated failures firing across the hourly schedule', () => {
  const alert = buildAlert({ ...base, summary: null });

  assert.equal(alert.startsAt, NOW.toISOString());
  assert.equal(new Date(alert.endsAt).getTime() - NOW.getTime(), ALERT_TTL_MS);
  assert.ok(ALERT_TTL_MS > 60 * 60 * 1000);
  assert.match(alert.annotations.description, /summary unavailable/);
});

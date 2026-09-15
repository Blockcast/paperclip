import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { ALERT_TTL_MS, buildAlert } from '../post-lockfile-drift-alert.mjs';

const SCRIPT = fileURLToPath(new URL('../post-lockfile-drift-alert.mjs', import.meta.url));

// Runs the script as the workflow runs it, so the assertion is on the PROCESS
// EXIT CODE. `buildAlert` coverage cannot see this: a regression that leaves the
// alert undelivered while exiting 0 turns the drift monitor back into the silent
// control BLO-27611 exists to remove.
function runScript(env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT],
      { env: { ...process.env, DRIFT_SUMMARY: 'drift on master', GH_REPO: 'Blockcast/paperclip', ...env } },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

async function withAlertmanager(handler, fn) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

// A port we just bound and released: nothing is listening, so connect() is
// refused immediately rather than hanging on a firewall drop.
async function deadPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

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

test('an unreachable Alertmanager exits nonzero rather than reporting success', async () => {
  // The fetch-rejection branch. AbortSignal.timeout rejects into this same
  // catch, so a separate 15s timeout test would exercise identical code and
  // would need a configurable-timeout seam in production for no other reason.
  const { code, stderr } = await runScript({ ALERTMANAGER_URL: `http://127.0.0.1:${await deadPort()}` });

  assert.equal(code, 1, 'undelivered alert must fail the step, not pass silently');
  assert.match(stderr, /ALERT DELIVERY FAILED/);
});

test('a non-2xx from Alertmanager exits nonzero rather than reporting success', async () => {
  const { code, stderr } = await withAlertmanager(
    (req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('rule evaluation failed');
    },
    (base) => runScript({ ALERTMANAGER_URL: base }),
  );

  assert.equal(code, 1, 'a rejected alert must fail the step, not pass silently');
  assert.match(stderr, /ALERT DELIVERY FAILED/);
  assert.match(stderr, /500/);
});

test('a delivered alert exits 0 and POSTs the alert array to /api/v2/alerts', async () => {
  let seen = null;
  const { code } = await withAlertmanager(
    (req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        seen = { method: req.method, url: req.url, contentType: req.headers['content-type'], body };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    },
    // Trailing slash: the base URL is operator-supplied via `vars.ALERTMANAGER_URL`,
    // and `//api/v2/alerts` is a 404 that would drop the alert.
    (base) => runScript({ ALERTMANAGER_URL: `${base}/` }),
  );

  assert.equal(code, 0);
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/api/v2/alerts');
  assert.match(seen.contentType, /application\/json/);

  const posted = JSON.parse(seen.body);
  assert.equal(posted.length, 1, 'Alertmanager v2 takes an ARRAY of alerts');
  assert.equal(posted[0].labels.alertname, 'LockfileDriftDetected');
  assert.equal(posted[0].labels.severity, 'critical');
  assert.match(posted[0].annotations.description, /drift on master/);
});

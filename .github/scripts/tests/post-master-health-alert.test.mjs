import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  ALERTNAME,
  ALERT_TTL_MS,
  buildAlert,
  decideAlertState,
  suiteJobs,
} from '../post-master-health-alert.mjs';

const SCRIPT = fileURLToPath(new URL('../post-master-health-alert.mjs', import.meta.url));

const FAILED_RUN_JOBS = JSON.stringify({
  jobs: [
    { name: 'Was this commit already proven by the merge queue?', conclusion: 'success' },
    { name: 'Master tests (server 1/4)', conclusion: 'failure' },
    { name: 'Master tests (server 2/4)', conclusion: 'success' },
  ],
});

// Runs the script as the workflow runs it, so the assertion is on the PROCESS
// EXIT CODE. `decideAlertState` coverage cannot see this: a regression that
// leaves the alert undelivered while exiting 0 turns master-health back into
// the unrouted control PEN-6398 exists to remove.
function runScript(env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT],
      {
        env: {
          ...process.env,
          GH_REPO: 'Blockcast/paperclip',
          HEAD_SHA: '0e4e1b17f',
          HEAD_BRANCH: 'master',
          RUN_CONCLUSION: 'failure',
          MASTER_HEALTH_JOBS_JSON: FAILED_RUN_JOBS,
          ...env,
        },
      },
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

test('a cancelled run routes NEITHER way', () => {
  // The load-bearing case. `cancelled` is the MODAL outcome of master-health
  // (41 of the 50 most recent runs), and those runs never took a runner.
  // Firing on them would flood the lane; resolving on them would clear a real
  // red on the strength of a run that executed no tests.
  const decision = decideAlertState({ runConclusion: 'cancelled', jobs: [], headBranch: 'master' });
  assert.equal(decision.state, 'skip');
  assert.match(decision.reason, /cancelled/);
});

test('a cancelled run routes neither way EVEN IF stale job rows say success', () => {
  // Vacuity control for the test above: proves the cancelled branch is decided
  // on the run conclusion and cannot be talked round by job rows.
  const decision = decideAlertState({
    runConclusion: 'cancelled',
    jobs: [{ name: 'Master tests (server 1/4)', conclusion: 'success' }],
    headBranch: 'master',
  });
  assert.equal(decision.state, 'skip');
});

test('a failing suite job fires', () => {
  const decision = decideAlertState({ runConclusion: 'failure', jobs: JSON.parse(FAILED_RUN_JOBS).jobs, headBranch: 'master' });
  assert.equal(decision.state, 'firing');
  assert.deepEqual(decision.failedJobs, ['Master tests (server 1/4)']);
});

test('a failure wins over a sibling success in the same run', () => {
  // master-health sets `fail-fast: false`, so a red shard routinely sits beside
  // green ones. Resolving on the greens would clear the red that run found.
  const decision = decideAlertState({
    runConclusion: 'failure',
    jobs: [
      { name: 'Master tests (server 1/4)', conclusion: 'success' },
      { name: 'Master tests (server 3/4)', conclusion: 'failure' },
    ],
    headBranch: 'master',
  });
  assert.equal(decision.state, 'firing');
});

test('a suite that ran and passed resolves', () => {
  const decision = decideAlertState({
    runConclusion: 'success',
    jobs: [
      { name: 'Was this commit already proven by the merge queue?', conclusion: 'success' },
      { name: 'Master tests (server 1/4)', conclusion: 'success' },
    ],
    headBranch: 'master',
  });
  assert.equal(decision.state, 'resolved');
});

test('an ALL-SKIPPED matrix does NOT resolve, though the run concluded success', () => {
  // BLO-38228's shape: the gate found a merge_group proof and skipped the
  // matrix, and a skipped job still concludes `success`. Run 36648202266
  // reported SUCCESS on a head that was already red because the proof had
  // expired on the clock. Resolving here would clear a genuine red.
  const decision = decideAlertState({
    runConclusion: 'success',
    jobs: [
      { name: 'Was this commit already proven by the merge queue?', conclusion: 'success' },
      { name: 'Master tests (${{ matrix.group_label }})', conclusion: 'skipped' },
    ],
    headBranch: 'master',
  });
  assert.equal(decision.state, 'skip');
  assert.match(decision.reason, /skipped matrix still concludes success/);
});

test('a run with no suite job rows at all does not resolve', () => {
  const decision = decideAlertState({ runConclusion: 'success', jobs: [], headBranch: 'master' });
  assert.equal(decision.state, 'skip');
});

test('a GREEN run on a NON-master branch does not resolve', () => {
  // The silent false-resolve this file exists to rule out. master-health.yml's
  // `workflow_dispatch:` has no branch restriction, so
  // `gh workflow run master-health.yml --ref <branch>` makes a run this
  // consumer accepts -- and the alert carries no branch label, so resolving
  // here would clear master's standing red using a feature branch's green.
  const decision = decideAlertState({
    runConclusion: 'success',
    jobs: [{ name: 'Master tests (server 1/4)', conclusion: 'success' }],
    headBranch: 'devops/some-feature',
  });
  assert.equal(decision.state, 'skip');
  assert.match(decision.reason, /not 'master'/);
});

test('a RED run on a non-master branch does not fire either', () => {
  // The other direction: the alert says "master is RED", so firing it about a
  // tree that is not master is a false alarm, not a safe default.
  const decision = decideAlertState({
    runConclusion: 'failure',
    jobs: [{ name: 'Master tests (server 1/4)', conclusion: 'failure' }],
    headBranch: 'devops/some-feature',
  });
  assert.equal(decision.state, 'skip');
});

test('an ABSENT branch refuses, rather than being assumed to be master', () => {
  // Unknown is not master. If the branch could not be read back, the run's
  // subject is unestablished and it must route neither way.
  const decision = decideAlertState({
    runConclusion: 'success',
    jobs: [{ name: 'Master tests (server 1/4)', conclusion: 'success' }],
  });
  assert.equal(decision.state, 'skip');
  assert.match(decision.reason, /unknown branch/);
});

test('a TIMED-OUT shard beside green ones does not resolve', () => {
  // `failure` is not the only non-success a row can carry. The timed-out shard
  // may be exactly the one that was red, so three greens are not a green
  // master -- positive evidence is required per ROW, not per run.
  const decision = decideAlertState({
    runConclusion: 'success',
    jobs: [
      { name: 'Master tests (server 1/4)', conclusion: 'success' },
      { name: 'Master tests (server 2/4)', conclusion: 'success' },
      { name: 'Master tests (server 3/4)', conclusion: 'timed_out' },
    ],
    headBranch: 'master',
  });
  assert.equal(decision.state, 'skip');
  assert.match(decision.reason, /timed_out/);
});

test('a shard with NO conclusion does not resolve', () => {
  const decision = decideAlertState({
    runConclusion: 'success',
    jobs: [
      { name: 'Master tests (server 1/4)', conclusion: 'success' },
      { name: 'Master tests (server 2/4)', conclusion: null },
    ],
    headBranch: 'master',
  });
  assert.equal(decision.state, 'skip');
});

test('a skipped shard beside a green one still resolves', () => {
  // Vacuity control for the two tests above: the stricter rule must not have
  // made resolution unreachable. `skipped` is the one non-success that is
  // legitimately not evidence of anything, and master-health skips shards by
  // design when the gate finds a merge_group proof.
  const decision = decideAlertState({
    runConclusion: 'success',
    jobs: [
      { name: 'Master tests (server 1/4)', conclusion: 'success' },
      { name: 'Master tests (server 2/4)', conclusion: 'skipped' },
    ],
    headBranch: 'master',
  });
  assert.equal(decision.state, 'resolved');
});

test('a REPLAY of an older green run does not resolve', () => {
  // `workflow_dispatch` takes an arbitrary run id, so replaying a green run
  // from before a red landed would clear the alert that red raised.
  const decision = decideAlertState({
    runConclusion: 'success',
    jobs: [{ name: 'Master tests (server 1/4)', conclusion: 'success' }],
    headBranch: 'master',
    isReplay: true,
    headSha: 'aaaaaaa',
    masterHeadSha: 'bbbbbbb',
  });
  assert.equal(decision.state, 'skip');
  assert.match(decision.reason, /not the current master head/);
});

test('a REPLAY at the CURRENT master head resolves', () => {
  // Vacuity control: the documented "confirm a red master has recovered"
  // replay must still work.
  const decision = decideAlertState({
    runConclusion: 'success',
    jobs: [{ name: 'Master tests (server 1/4)', conclusion: 'success' }],
    headBranch: 'master',
    isReplay: true,
    headSha: 'aaaaaaa',
    masterHeadSha: 'aaaaaaa',
  });
  assert.equal(decision.state, 'resolved');
});

test('a replay whose master head could NOT be read does not resolve', () => {
  const decision = decideAlertState({
    runConclusion: 'success',
    jobs: [{ name: 'Master tests (server 1/4)', conclusion: 'success' }],
    headBranch: 'master',
    isReplay: true,
    headSha: 'aaaaaaa',
    masterHeadSha: '',
  });
  assert.equal(decision.state, 'skip');
});

test('a LIVE green run resolves even though master has moved on', () => {
  // The asymmetry is load-bearing. The arc-paperclip-general queue puts ~3.5h
  // between a push and its verdict, so master has ALWAYS advanced by the time
  // a run concludes. Holding the live path to the replay's head test would not
  // be safer -- it would make resolution impossible and leave the lane to
  // clear only on the 24h TTL.
  const decision = decideAlertState({
    runConclusion: 'success',
    jobs: [{ name: 'Master tests (server 1/4)', conclusion: 'success' }],
    headBranch: 'master',
    isReplay: false,
    headSha: 'aaaaaaa',
    masterHeadSha: 'bbbbbbb',
  });
  assert.equal(decision.state, 'resolved');
});

test('a non-master run exits 0 WITHOUT delivering anything', async () => {
  // Process-level control for the branch gate, matching the cancelled-run one:
  // `exit 0` alone is also what a successful delivery produces, so the
  // assertion is the request count.
  const seen = [];
  await withAlertmanager(
    (req, res) => {
      seen.push(req.url);
      res.writeHead(200).end('{}');
    },
    async (base) => {
      const { code, stdout } = await runScript({
        ALERTMANAGER_URL: base,
        HEAD_BRANCH: 'devops/some-feature',
        RUN_CONCLUSION: 'success',
      });
      assert.equal(code, 0, stdout);
      assert.equal(seen.length, 0, 'a run that did not test master must push nothing');
      assert.match(stdout, /Not routing/);
    },
  );
});

test('suiteJobs ignores the gate job and tolerates junk rows', () => {
  const picked = suiteJobs([
    { name: 'Was this commit already proven by the merge queue?', conclusion: 'success' },
    { name: 'Master tests (workspaces-a)', conclusion: 'success' },
    null,
    { conclusion: 'failure' },
  ]);
  assert.deepEqual(picked.map((j) => j.name), ['Master tests (workspaces-a)']);
});

test('the firing alert carries no per-occurrence LABEL, and carries the head as an annotation', () => {
  // Alertmanager fingerprints the whole label set and the Paperclip bridge
  // dedupes on it. master advances every ~10-20 minutes, so a head SHA in a
  // label would mint a new issue per commit for one standing red.
  const alert = buildAlert({
    state: 'firing',
    repo: 'Blockcast/paperclip',
    headSha: '0e4e1b17f',
    headBranch: 'master',
    runUrl: 'https://example.invalid/run/1',
    detail: 'Master tests (server 1/4)',
    now: new Date('2026-11-10T00:00:00Z'),
  });
  const labelValues = Object.values(alert.labels).join('|');
  assert.doesNotMatch(labelValues, /0e4e1b17f/);
  assert.doesNotMatch(labelValues, /example\.invalid/);
  assert.equal(alert.labels.alertname, ALERTNAME);
  // Vacuity control: the head must still be REACHABLE, so this test fails if
  // the SHA is deleted rather than merely moved out of the labels.
  assert.equal(alert.annotations.head_sha, '0e4e1b17f');
  assert.equal(alert.annotations.run_url, 'https://example.invalid/run/1');
});

test('firing opens a TTL window and resolved back-dates both ends', () => {
  const now = new Date('2026-11-10T00:00:00Z');
  const firing = buildAlert({ state: 'firing', repo: 'r', runUrl: '', detail: '', now });
  assert.equal(Date.parse(firing.endsAt) - Date.parse(firing.startsAt), ALERT_TTL_MS);

  const resolved = buildAlert({ state: 'resolved', repo: 'r', runUrl: '', detail: '', now });
  // Alertmanager 400s on `startsAt >= endsAt`, so both ends must move back.
  assert.ok(Date.parse(resolved.startsAt) < Date.parse(resolved.endsAt));
  assert.ok(Date.parse(resolved.endsAt) < now.getTime());
});

test('delivers the firing alert and exits 0', async () => {
  const seen = [];
  await withAlertmanager(
    (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ url: req.url, body: JSON.parse(body) });
        res.writeHead(200).end('{}');
      });
    },
    async (base) => {
      const { code, stdout } = await runScript({ ALERTMANAGER_URL: base });
      assert.equal(code, 0, stdout);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, '/api/v2/alerts');
      assert.equal(seen[0].body[0].labels.alertname, ALERTNAME);
      assert.match(seen[0].body[0].annotations.detail, /Master tests \(server 1\/4\)/);
    },
  );
});

test('a cancelled run exits 0 WITHOUT delivering anything', async () => {
  // The vacuity control for the skip path: `exit 0` alone would also be
  // produced by a successful delivery, so the request count is the assertion.
  const seen = [];
  await withAlertmanager(
    (req, res) => {
      seen.push(req.url);
      res.writeHead(200).end('{}');
    },
    async (base) => {
      const { code, stdout } = await runScript({
        ALERTMANAGER_URL: base,
        RUN_CONCLUSION: 'cancelled',
      });
      assert.equal(code, 0, stdout);
      assert.equal(seen.length, 0, 'a cancelled run must push nothing');
      assert.match(stdout, /Not routing/);
    },
  );
});

test('an unreachable Alertmanager is FATAL', async () => {
  const port = await deadPort();
  const { code, stderr } = await runScript({ ALERTMANAGER_URL: `http://127.0.0.1:${port}` });
  assert.equal(code, 1);
  assert.match(stderr, /ALERT DELIVERY FAILED/);
  assert.match(stderr, /UNROUTED/);
});

test('a non-2xx from Alertmanager is FATAL', async () => {
  await withAlertmanager(
    (req, res) => res.writeHead(400).end('start time must be before end time'),
    async (base) => {
      const { code, stderr } = await runScript({ ALERTMANAGER_URL: base });
      assert.equal(code, 1);
      assert.match(stderr, /returned 400/);
    },
  );
});

test('an unreadable job list is FATAL, not an empty one', async () => {
  const port = await deadPort();
  const { code, stderr } = await runScript({
    ALERTMANAGER_URL: `http://127.0.0.1:${port}`,
    MASTER_HEALTH_JOBS_JSON: '{not json',
  });
  assert.equal(code, 1);
  assert.match(stderr, /not valid JSON/);
});

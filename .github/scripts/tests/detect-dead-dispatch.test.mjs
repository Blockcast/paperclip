// PEN-4224. A dispatched production deploy that DIES in front of the `deploy`
// job consumes the day's slot exactly as one that deployed, and until this
// module nothing noticed: `supersede-stale-deploy.mjs` bounds a dispatch that
// lasts TOO LONG, and there was no converse guard for one that ends too fast.
//
// The property under test is a CLASSIFICATION, and its value is entirely in
// what it refuses to claim. A predicate that fires on every red `docker.yml`
// run would be trivially "correct" about the incident and useless — it would
// also fire on every genuine deploy-job failure, which is a different condition
// with a different owner (PEN-4176's migration pre-flight is the live example),
// and on every successful supersede. So the live run table below is replayed in
// full rather than just the one failing shape: the nine deploy-job failures and
// the four cancellations are the assertions that matter most.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPLETED_SCAN_LIMIT,
  DEPLOY_JOB_NAME,
  DISPATCH_FATE,
  classifyDispatchRun,
  deployJobExecuted,
  detectDeadDispatch,
  findLastCompletedDispatch,
  isDeadLane,
} from '../detect-dead-dispatch.mjs';
import { DISPATCH_FATE_DIED_BEFORE_DEPLOY, laneRefilled } from '../deploy-stall-record.mjs';

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'detect-dead-dispatch.mjs',
);
const source = readFileSync(scriptPath, 'utf8');

/**
 * Minimal GitHub client stand-in, same shape as deploy-delivery-gap.test.mjs.
 * Every call is recorded so a test can assert what was NOT fetched.
 */
function stubClient(routes) {
  const calls = [];
  return {
    calls,
    async request(method, requestPath) {
      calls.push(`${method} ${requestPath}`);
      for (const [prefix, value] of Object.entries(routes)) {
        if (!requestPath.startsWith(prefix)) continue;
        if (typeof value === 'function') return value(requestPath);
        return value;
      }
      throw new Error(`unstubbed ${method} ${requestPath}`);
    },
  };
}

const jobs = (...entries) => entries.map(([name, conclusion]) => ({ name, conclusion }));

// ---------------------------------------------------------------------------
// The live table. Measured 2026-10-17 over the 25 most recent
// `workflow_dispatch` runs of docker.yml (2026-10-05T07:57Z → 2026-10-17T07:32Z)
// by reading each run's jobs individually. Replayed here so a later widening of
// the predicate has to disagree with production data rather than with a
// hand-written example.
// ---------------------------------------------------------------------------
const LIVE_RUNS = [
  // THE INCIDENT. build-and-push failed in 84s; deploy never ran.
  { id: 39014044238, conclusion: 'failure', build: 'failure', deploy: 'skipped', expect: DISPATCH_FATE.DIED_BEFORE_DEPLOY },
  // The nine deploy-job failures: a real deploy attempt that failed. NOT ours.
  { id: 38948553579, conclusion: 'failure', build: 'success', deploy: 'failure', expect: DISPATCH_FATE.SURVIVED },
  { id: 38868312218, conclusion: 'failure', build: 'success', deploy: 'failure', expect: DISPATCH_FATE.SURVIVED },
  { id: 38530076746, conclusion: 'failure', build: 'success', deploy: 'failure', expect: DISPATCH_FATE.SURVIVED },
  { id: 38509596867, conclusion: 'failure', build: 'success', deploy: 'failure', expect: DISPATCH_FATE.SURVIVED },
  { id: 38136159113, conclusion: 'failure', build: 'success', deploy: 'failure', expect: DISPATCH_FATE.SURVIVED },
  { id: 37813834798, conclusion: 'failure', build: 'success', deploy: 'failure', expect: DISPATCH_FATE.SURVIVED },
  { id: 37546659714, conclusion: 'failure', build: 'success', deploy: 'failure', expect: DISPATCH_FATE.SURVIVED },
  { id: 37538410547, conclusion: 'failure', build: 'success', deploy: 'failure', expect: DISPATCH_FATE.SURVIVED },
  { id: 37342387937, conclusion: 'failure', build: 'success', deploy: 'failure', expect: DISPATCH_FATE.SURVIVED },
  // The four cancellations: every one is a supersede doing its job.
  { id: 38330396832, conclusion: 'cancelled', build: 'success', deploy: 'cancelled', expect: DISPATCH_FATE.SURVIVED },
  { id: 37480926215, conclusion: 'cancelled', build: 'success', deploy: 'cancelled', expect: DISPATCH_FATE.SURVIVED },
  { id: 37431411370, conclusion: 'cancelled', build: 'success', deploy: 'cancelled', expect: DISPATCH_FATE.SURVIVED },
  { id: 37286804320, conclusion: 'cancelled', build: 'success', deploy: 'cancelled', expect: DISPATCH_FATE.SURVIVED },
];

test('replay 2026-10-17: exactly ONE of the 14 non-success dispatch runs is a death', () => {
  const fates = LIVE_RUNS.map((row) =>
    classifyDispatchRun(
      { status: 'completed', conclusion: row.conclusion },
      jobs(['build-and-push', row.build], ['deploy', row.deploy]),
    ),
  );
  assert.deepEqual(fates, LIVE_RUNS.map((row) => row.expect));

  const deaths = LIVE_RUNS.filter((_, i) => fates[i] === DISPATCH_FATE.DIED_BEFORE_DEPLOY);
  assert.equal(deaths.length, 1, 'the predicate must stay this specific');
  assert.equal(deaths[0].id, 39014044238, 'and the one it fires on must be the incident');
});

test('a deploy job that RAN and failed is not a death — that is a different, owned condition', () => {
  // The shape this must never claim. A failing migration pre-flight, admission
  // check or `helm upgrade` is a real deploy attempt; it has its own alerting
  // and its own row (PEN-4176). Claiming it here would both duplicate that
  // signal and make this one untrustworthy, which is how a warning stops being
  // read.
  assert.equal(
    classifyDispatchRun({ status: 'completed', conclusion: 'failure' }, jobs(['deploy', 'failure'])),
    DISPATCH_FATE.SURVIVED,
  );
});

test('a CANCELLED run is not a death — that is what a successful supersede looks like', () => {
  // supersede-stale-deploy.mjs cancels a stale waiting dispatch as its normal
  // correct operation (PEN-3315). All four cancelled runs in the live window
  // carry `deploy: cancelled`. Counting cancellation as death would turn every
  // supersede into a false alarm, on a workflow whose `conclusion` PEN-2848
  // made load-bearing.
  assert.equal(
    classifyDispatchRun({ status: 'completed', conclusion: 'cancelled' }, jobs(['deploy', 'cancelled'])),
    DISPATCH_FATE.SURVIVED,
  );
  // And the same even when deploy never started at all: the conjunct that
  // excludes it is the run conclusion, independently of the job.
  assert.equal(
    classifyDispatchRun({ status: 'completed', conclusion: 'cancelled' }, jobs(['deploy', 'skipped'])),
    DISPATCH_FATE.SURVIVED,
  );
});

test('a GREEN run with deploy skipped is not a death either', () => {
  // docker.yml's own pending guard makes a run conclude `success` with `deploy`
  // skipped — the shape findLastSuccessfulDeploy exists to see through. It is
  // not a failure, so it is not this module's subject.
  assert.equal(
    classifyDispatchRun({ status: 'completed', conclusion: 'success' }, jobs(['deploy', 'skipped'])),
    DISPATCH_FATE.SURVIVED,
  );
});

test('a run still in flight is UNKNOWN, never a death', () => {
  // Guard (1) should have caught this before we are called, but a run that
  // transitions between guard (1)'s read and ours must not be reported as dead
  // on the strength of a `deploy` job that simply has not started yet.
  for (const status of ['queued', 'in_progress', 'waiting', undefined]) {
    assert.equal(
      classifyDispatchRun({ status, conclusion: null }, jobs(['deploy', null])),
      DISPATCH_FATE.UNKNOWN,
      `status ${status} must not classify`,
    );
  }
  assert.equal(classifyDispatchRun(null, []), DISPATCH_FATE.UNKNOWN);
});

test('deployJobExecuted: absent and skipped both mean "did not execute"', () => {
  assert.equal(deployJobExecuted(jobs(['build-and-push', 'success'])), false, 'absent');
  assert.equal(deployJobExecuted(jobs(['deploy', 'skipped'])), false, 'skipped');
  assert.equal(deployJobExecuted(jobs(['deploy', null])), false, 'not yet concluded');
  assert.equal(deployJobExecuted(jobs(['deploy', 'success'])), true);
  assert.equal(deployJobExecuted(jobs(['deploy', 'failure'])), true);
  assert.equal(deployJobExecuted(jobs(['deploy', 'cancelled'])), true);
  assert.equal(deployJobExecuted(undefined), false);
});

test('the deploy job name is matched EXACTLY, and shares that coupling deliberately', () => {
  // If `deploy` ever gains a matrix the job names become `deploy (...)`, and
  // this, findLastSuccessfulDeploy and guard (2) all silently find nothing.
  // Here that means permanent silence rather than a false alarm — the safe
  // direction, and the reason it must be pinned rather than relied on.
  assert.equal(DEPLOY_JOB_NAME, 'deploy');
  assert.equal(deployJobExecuted(jobs(['deploy (amd64)', 'success'])), false);
});

// ---------------------------------------------------------------------------
// Reading the lane.
// ---------------------------------------------------------------------------

const listPath = '/actions/workflows/docker.yml/runs';
const run = (id, status, conclusion, createdAt) => ({
  id,
  status,
  conclusion,
  created_at: createdAt,
  updated_at: createdAt,
  head_sha: `sha-${id}`,
  html_url: `https://github.com/Blockcast/paperclip/actions/runs/${id}`,
});

test('findLastCompletedDispatch: in-flight runs are stepped over, not judged', async () => {
  const client = stubClient({
    [listPath]: {
      workflow_runs: [
        run(3, 'in_progress', null, '2026-10-17T09:00:00Z'),
        run(2, 'completed', 'failure', '2026-10-17T07:32:58Z'),
        run(1, 'completed', 'success', '2026-10-16T07:36:41Z'),
      ],
    },
    '/actions/runs/2/jobs': { jobs: jobs(['build-and-push', 'failure'], ['deploy', 'skipped']) },
  });
  const result = await findLastCompletedDispatch({ client });
  assert.equal(result.fate, DISPATCH_FATE.DIED_BEFORE_DEPLOY);
  assert.equal(result.run.databaseId, 2);
});

test('findLastCompletedDispatch: ONLY the newest completed run is judged', async () => {
  // "What did the lane last do" is a statement about its current state. Scanning
  // further back would re-report a death that a later dispatch already
  // superseded — i.e. redden the dispatcher over a problem that is fixed.
  const client = stubClient({
    [listPath]: {
      workflow_runs: [
        run(2, 'completed', 'success', '2026-10-17T12:00:00Z'),
        run(1, 'completed', 'failure', '2026-10-17T07:32:58Z'),
      ],
    },
    '/actions/runs/2/jobs': { jobs: jobs(['deploy', 'success']) },
  });
  const result = await findLastCompletedDispatch({ client });
  assert.equal(result.fate, DISPATCH_FATE.SURVIVED);
  assert.ok(
    !client.calls.some((c) => c.includes('/actions/runs/1/jobs')),
    'the superseded older run must not even be fetched',
  );
});

test('findLastCompletedDispatch: order is taken from created_at, not from list order', async () => {
  // The API returns newest-first today and nothing in the contract says so. An
  // ordering change here would judge an OLDER run — which in this module means
  // resurrecting a death that has already been fixed.
  const client = stubClient({
    [listPath]: {
      workflow_runs: [
        run(1, 'completed', 'failure', '2026-10-17T07:32:58Z'),
        run(2, 'completed', 'success', '2026-10-17T12:00:00Z'),
      ],
    },
    '/actions/runs/2/jobs': { jobs: jobs(['deploy', 'success']) },
  });
  assert.equal((await findLastCompletedDispatch({ client })).fate, DISPATCH_FATE.SURVIVED);
});

test('findLastCompletedDispatch: an empty window is NONE, which reports nothing', async () => {
  const client = stubClient({ [listPath]: { workflow_runs: [] } });
  assert.deepEqual(await findLastCompletedDispatch({ client }), {
    fate: DISPATCH_FATE.NONE,
    run: null,
  });
});

test('findLastCompletedDispatch: an unreadable job list is UNKNOWN, never a guess', async () => {
  const client = stubClient({
    [listPath]: { workflow_runs: [run(2, 'completed', 'failure', '2026-10-17T07:32:58Z')] },
    '/actions/runs/2/jobs': () => {
      throw new Error('503 Service Unavailable');
    },
  });
  const result = await findLastCompletedDispatch({ client });
  assert.equal(result.fate, DISPATCH_FATE.UNKNOWN);
});

test('the completed-run window is small, and deliberately not the delivery-gap depth', () => {
  // The two scans ask different questions: the delivery gap must reach PAST a
  // stall (and gets deeper every day one persists), while this is answered by
  // the first completed run and never needs depth. Sharing the 300 would pay a
  // stall-sized cost hourly for an answer that is always on page one.
  assert.ok(COMPLETED_SCAN_LIMIT <= 50, 'this window exists only to step over in-flight runs');
  assert.ok(COMPLETED_SCAN_LIMIT >= 5, 'but must tolerate a short burst of concurrent dispatches');
});

// ---------------------------------------------------------------------------
// The second conjunct, and the fail-quiet direction.
// ---------------------------------------------------------------------------

test('isDeadLane: a death with production already AT master owes nothing', () => {
  const fate = DISPATCH_FATE.DIED_BEFORE_DEPLOY;
  assert.equal(isDeadLane({ fate, commitsBehind: 64 }), true);
  assert.equal(isDeadLane({ fate, commitsBehind: 0 }), false, 'idle lane, not a stalled one');
  assert.equal(isDeadLane({ fate, commitsBehind: null }), false, 'unmeasurable gap stays quiet');
  assert.equal(isDeadLane({ fate, commitsBehind: undefined }), false);
  for (const other of [DISPATCH_FATE.SURVIVED, DISPATCH_FATE.NONE, DISPATCH_FATE.UNKNOWN]) {
    assert.equal(isDeadLane({ fate: other, commitsBehind: 64 }), false, `${other} is not a death`);
  }
});

test('detectDeadDispatch: the gap is only measured when there is a death to qualify', async () => {
  // Cost, and direction. A /compare on every hourly slot buys nothing when the
  // lane is healthy, and the gap exists here ONLY to stop a dead-but-idle lane
  // reddening the dispatcher.
  const client = stubClient({
    [listPath]: { workflow_runs: [run(2, 'completed', 'success', '2026-10-17T07:32:58Z')] },
    '/actions/runs/2/jobs': { jobs: jobs(['deploy', 'success']) },
  });
  const result = await detectDeadDispatch({ client });
  assert.equal(result.dead, false);
  assert.ok(!client.calls.some((c) => c.includes('/compare/')), 'no gap call on a healthy lane');
});

test('detectDeadDispatch: a death plus a positive gap is the reportable condition', async () => {
  const client = stubClient({
    [listPath]: (p) =>
      p.includes('status=success')
        ? { workflow_runs: [run(1, 'completed', 'success', '2026-10-15T07:46:48Z')] }
        : { workflow_runs: [run(2, 'completed', 'failure', '2026-10-17T07:32:58Z')] },
    '/actions/runs/2/jobs': { jobs: jobs(['build-and-push', 'failure'], ['deploy', 'skipped']) },
    '/actions/runs/1/jobs': { jobs: jobs(['deploy', 'success']) },
    '/compare/': { ahead_by: 64, status: 'ahead' },
  });
  const result = await detectDeadDispatch({ client });
  assert.equal(result.fate, DISPATCH_FATE.DIED_BEFORE_DEPLOY);
  assert.equal(result.dead, true);
  assert.equal(result.gap.commitsBehind, 64);
  assert.equal(result.run.databaseId, 2);
});

test('detectDeadDispatch: every failure path is silent, not a guess', async () => {
  // This module can turn a dispatcher run RED, and PEN-2848 made that
  // conclusion load-bearing for a stuck approval. So unlike deploy-stall-chain
  // and deploy-delivery-gap — which resolve uncertainty toward a LARGER
  // reported gap because they annotate an alert a human is already reading —
  // every uncertainty here resolves toward silence.
  const listFails = stubClient({
    [listPath]: () => {
      throw new Error('502 Bad Gateway');
    },
  });
  const a = await detectDeadDispatch({ client: listFails });
  assert.equal(a.fate, DISPATCH_FATE.UNKNOWN);
  assert.equal(a.dead, false);
  assert.match(a.reason, /lookup failed/);

  // A death whose gap cannot be measured also stays quiet: resolveDeliveryGap
  // swallows its own failure into {gap:null}, and null is not > 0.
  const compareFails = stubClient({
    [listPath]: (p) =>
      p.includes('status=success')
        ? { workflow_runs: [run(1, 'completed', 'success', '2026-10-15T07:46:48Z')] }
        : { workflow_runs: [run(2, 'completed', 'failure', '2026-10-17T07:32:58Z')] },
    '/actions/runs/2/jobs': { jobs: jobs(['build-and-push', 'failure'], ['deploy', 'skipped']) },
    '/actions/runs/1/jobs': { jobs: jobs(['deploy', 'success']) },
    '/compare/': () => {
      throw new Error('404 Not Found');
    },
  });
  const b = await detectDeadDispatch({ client: compareFails });
  assert.equal(b.fate, DISPATCH_FATE.DIED_BEFORE_DEPLOY);
  assert.equal(b.dead, false, 'an unmeasurable gap must not redden the dispatcher');
});

// ---------------------------------------------------------------------------
// The invariants PEN-4224 required to be ASSERTED rather than assumed.
// ---------------------------------------------------------------------------

test('this module APPROVES NOTHING and DISPATCHES NOTHING — it holds no write path', () => {
  // Done-when #3 and #4. The 2026-08-28 rejection of auto-approval is untouched,
  // and guard (1)'s anti-stacking property cannot be affected by a module that
  // cannot produce a dispatch. Asserted on the source rather than reasoned
  // about, because the whole point of the detection is that it is reached on
  // every slot, including the ones that must stay inert.
  assert.ok(
    !/pending_deployments/.test(source),
    'the detection must never reach for the environment approval API',
  );
  assert.ok(
    !/workflow run|\/dispatches|createWorkflowDispatch/.test(source),
    'the detection must never dispatch a workflow',
  );
  assert.ok(!/\/cancel\b/.test(source), 'the detection must never cancel a run');
  // Every request this module makes is a GET. Anything else is a write.
  const methods = [...source.matchAll(/client\.request\(\s*'([A-Z]+)'/g)].map((m) => m[1]);
  assert.ok(methods.length > 0, 'positive control: the module must make requests at all');
  assert.deepEqual([...new Set(methods)], ['GET'], `non-GET request found: ${methods.join(',')}`);
});

test('the fate spelling is shared with deploy-stall-record, not re-derived', () => {
  // detect-dead-dispatch imports deploy-stall-record (for the client and the
  // workflow name), so the constant cannot be imported back without a cycle and
  // is spelled independently there. This is the pin that keeps the two honest —
  // a drift would silently restore the fail-open `laneRefilled` exists to close,
  // with both files still reading as correct.
  assert.equal(DISPATCH_FATE.DIED_BEFORE_DEPLOY, DISPATCH_FATE_DIED_BEFORE_DEPLOY);
  assert.equal(laneRefilled({ outcome: 'dispatched', lastDispatchFate: DISPATCH_FATE.DIED_BEFORE_DEPLOY }), false);
});

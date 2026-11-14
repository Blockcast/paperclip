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
  DEPLOY_BRANCH,
  DEPLOY_GATE_JOB_NAME,
  LANE_FAILED_TO_DELIVER_FATES,
  deployJobCompleted,
  deployJobExecuted,
  deployLaneGatedOff,
  detectDeadDispatch,
  findLastCompletedDispatch,
  isDeadLane,
  MIN_INTERVAL_STEP_NAME,
} from '../detect-dead-dispatch.mjs';
import { laneRefilled } from '../deploy-stall-record.mjs';

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
const run = (id, status, conclusion, createdAt, headBranch = 'master') => ({
  id,
  status,
  conclusion,
  created_at: createdAt,
  updated_at: createdAt,
  head_sha: `sha-${id}`,
  // The live API always carries this, and every real production dispatch is on
  // master. The gated-off claim reads it, so omitting it here would make these
  // fixtures quieter than the runs they stand for.
  head_branch: headBranch,
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

test('`survived` is NOT proof of a refill, and the close gate must not read it', () => {
  // Review finding on this change's first head. `classifyDispatchRun` returns
  // SURVIVED as a catch-all meaning "not a death this module may claim" — which
  // is right for a fail-quiet detector and wrong for a gate that needs proof.
  // These two shapes are the ones that caught it out.
  const cancelledBeforeDeploy = classifyDispatchRun(
    { status: 'completed', conclusion: 'cancelled' },
    [{ name: 'build-and-push', conclusion: 'cancelled' }],
  );
  const deploySkippedByGuard = classifyDispatchRun({ status: 'completed', conclusion: 'success' }, [
    { name: 'build-and-push', conclusion: 'success' },
    { name: 'deploy', conclusion: 'skipped' },
  ]);
  assert.equal(cancelledBeforeDeploy, DISPATCH_FATE.SURVIVED, 'a supersede is not a death');
  assert.equal(deploySkippedByGuard, DISPATCH_FATE.SURVIVED, 'nor is a guard-skipped deploy');
  // ...and neither refilled the lane. The strict signal says so.
  assert.equal(deployJobCompleted([{ name: 'build-and-push', conclusion: 'cancelled' }]), false);
  assert.equal(deployJobCompleted([{ name: 'deploy', conclusion: 'skipped' }]), false);
  assert.equal(deployJobCompleted([{ name: 'deploy', conclusion: 'cancelled' }]), false);
  assert.equal(deployJobCompleted([{ name: 'deploy', conclusion: null }]), false);
  assert.equal(deployJobCompleted([]), false, 'an absent deploy job executed nothing');
  // A deploy that RAN counts, whether or not it succeeded: that is a real
  // deploy attempt owned by whatever made it fail (PEN-4176's migration
  // pre-flight is the live example). The lane was refilled either way.
  assert.equal(deployJobCompleted([{ name: 'deploy', conclusion: 'success' }]), true);
  assert.equal(deployJobCompleted([{ name: 'deploy', conclusion: 'failure' }]), true);
});

test('the close gate is wired to deploy-execution, not to the fate string', () => {
  // The cross-module pin. detect-dead-dispatch imports deploy-stall-record (for
  // the client and the workflow name), so the gate cannot be imported back
  // without a cycle — this keeps the two honest. Feeding the gate a `survived`
  // run that executed no deploy must NOT close a record.
  const atRefill = {
    outcome: 'dispatched',
    lastDispatchAt: '2026-10-17T07:31:45.000Z',
    stallStartedAt: '2026-10-17T05:00:00.000Z',
  };
  assert.equal(laneRefilled({ ...atRefill, lastDispatchDeployExecuted: 'true' }), true);
  assert.equal(laneRefilled({ ...atRefill, lastDispatchDeployExecuted: 'false' }), false);
  // The fate is not an input at all any more, so passing one must not close it.
  assert.equal(laneRefilled({ ...atRefill, lastDispatchFate: DISPATCH_FATE.SURVIVED }), false);
});

test('the detector publishes the run TIME and the STRICT refill signal (PEN-4224)', () => {
  // The fate alone cannot say WHICH dispatch it describes, and on a `dispatched`
  // slot it never describes the one just issued — this module runs above
  // `gh workflow run`. `laneRefilled` therefore needs the run's creation time to
  // tell a survival belonging to this stall from one that predates it. Without
  // this output the gate receives an empty string and stops closing, which is
  // the safe direction but is still the feature silently gone.
  assert.match(source, /setOutput\('last_dispatch_at', result\.run\?\.createdAt \?\? ''\)/);
  assert.match(source, /setOutput\('last_dispatch_fate', result\.fate\)/);
  // The strict signal the close gate actually reads. Published as an explicit
  // 'true'/'false' string so an absent or unreadable run is 'false' — evidence
  // withheld — rather than an empty string some later reader coerces.
  assert.match(
    source,
    /setOutput\('last_dispatch_deploy_executed', result\.run\?\.deployExecuted === true \? 'true' : 'false'\)/,
  );
});

// ---------------------------------------------------------------------------
// PEN-5261: the lane that is SWITCHED OFF.
//
// The second cause of the same false green, and the one the original predicate
// absorbed by construction: a GREEN run with `deploy` skipped was the shape
// written for docker.yml's own pending guard, and a lane gated off at the
// workflow level is byte-identical to it in run conclusion. The discriminator
// is `guard-pending-deploy` — it declares no `needs:`, so nothing upstream can
// make it skip, and it carries the same condition `deploy` carries.
//
// Replayed from the live run rather than invented: 41596391238, dispatched by
// slot 41596273435 at 2026-11-03T07:27:01Z, concluded `success` with
// production 90 commits behind.
// ---------------------------------------------------------------------------

const GATED_OFF_JOBS = jobs(
  ['build-and-push', 'success'],
  ['guard-pending-deploy', 'skipped'],
  ['guard-pending-deploy-final', 'skipped'],
  ['deploy', 'skipped'],
);

const GATED_OFF_RUN = { status: 'completed', conclusion: 'success', head_branch: 'master' };

test('replay 2026-11-03 run 41596391238: a GREEN run whose entry guard never ran is the lane switched off', () => {
  assert.equal(
    classifyDispatchRun(GATED_OFF_RUN, GATED_OFF_JOBS),
    DISPATCH_FATE.LANE_GATED_OFF,
  );
  // And it must NOT be reported as the death it superficially resembles: the
  // remedies are opposite. A death is recovered by a later dispatch; this is
  // recovered by no dispatch at all.
  assert.notEqual(
    classifyDispatchRun(GATED_OFF_RUN, GATED_OFF_JOBS),
    DISPATCH_FATE.DIED_BEFORE_DEPLOY,
  );
});

test('the discriminator is the ENTRY GUARD, not the deploy job — both shapes end with deploy skipped', () => {
  // The pair that makes the predicate worth having. Identical run conclusion,
  // identical `deploy` conclusion; they differ only in whether the guard RAN.
  const run = { status: 'completed', conclusion: 'success', head_branch: 'master' };
  const pendingGuardBlocked = jobs(
    ['build-and-push', 'success'],
    ['guard-pending-deploy', 'success'],
    ['guard-pending-deploy-final', 'skipped'],
    ['deploy', 'skipped'],
  );
  assert.equal(
    classifyDispatchRun(run, pendingGuardBlocked),
    DISPATCH_FATE.SURVIVED,
    'a guard that RAN and reported blocked is normal, owned behaviour',
  );
  assert.equal(classifyDispatchRun(run, GATED_OFF_JOBS), DISPATCH_FATE.LANE_GATED_OFF);
});

test('an ABSENT entry guard is never claimed as gated off — absent is unknown, not off', () => {
  // The fail-quiet direction, and the reason this predicate reads `skipped`
  // rather than "not success". A renamed or matrixed guard job, and every
  // abbreviated fixture in this file, present as ABSENT; claiming a switched-off
  // lane from a job list that does not mention the gate would make this
  // module's one loud report a guess. Also what keeps the LIVE_RUNS replay and
  // the pre-existing green-skip test above honest.
  assert.equal(deployLaneGatedOff(jobs(['deploy', 'skipped'])), false);
  assert.equal(deployLaneGatedOff([]), false);
  assert.equal(deployLaneGatedOff(undefined), false);
  assert.equal(
    classifyDispatchRun(GATED_OFF_RUN, jobs(['deploy', 'skipped'])),
    DISPATCH_FATE.SURVIVED,
  );
});

test('deployLaneGatedOff: only `skipped` counts, and the job name is matched EXACTLY', () => {
  assert.equal(DEPLOY_GATE_JOB_NAME, 'guard-pending-deploy');
  assert.equal(deployLaneGatedOff(jobs([DEPLOY_GATE_JOB_NAME, 'skipped'])), true);
  for (const conclusion of ['success', 'failure', 'cancelled', null]) {
    assert.equal(
      deployLaneGatedOff(jobs([DEPLOY_GATE_JOB_NAME, conclusion])),
      false,
      `a ${conclusion} guard is not a switched-off lane`,
    );
  }
  // Same matrix hazard pinned for DEPLOY_JOB_NAME, same safe direction.
  assert.equal(deployLaneGatedOff(jobs(['guard-pending-deploy-final', 'skipped'])), false);
  assert.equal(deployLaneGatedOff(jobs(['guard-pending-deploy (amd64)', 'skipped'])), false);
});

test('a CANCELLED run whose entry guard was skipped is still a supersede, not a switched-off lane', () => {
  // The `success` conjunct earns its place here. A supersede stops the run, and
  // the guard can show `skipped` when it is stopped before starting; treating
  // that as a switched-off lane would redden the dispatcher on every successful
  // supersede, which is exactly the over-claiming this module refuses.
  assert.equal(
    classifyDispatchRun(
      { status: 'completed', conclusion: 'cancelled', head_branch: 'master' },
      GATED_OFF_JOBS,
    ),
    DISPATCH_FATE.SURVIVED,
  );
});

test('a hand-dispatched FEATURE BRANCH is not a switched-off lane — same skip, other conjunct', () => {
  // Ally caught this on review at c5e86458. `guard-pending-deploy`'s condition
  // has three conjuncts and a skipped guard proves only that ONE was false.
  // `findLastCompletedDispatch` never filters by branch, so a human dispatching
  // `docker.yml` by hand off a feature branch produces this shape off the REF
  // conjunct, becomes the lane's last completed dispatch, and would be reported
  // as `lane-gated-off` — naming a variable that may be perfectly healthy.
  //
  // Harmless before this fate existed (it classified `survived`); loud now.
  assert.equal(DEPLOY_BRANCH, 'master');
  assert.equal(
    classifyDispatchRun(
      { status: 'completed', conclusion: 'success', head_branch: 'release/v9' },
      GATED_OFF_JOBS,
    ),
    DISPATCH_FATE.SURVIVED,
    'the ref conjunct explains this skip; the variable is not implicated',
  );
  // Absent is not master either — the fail-quiet direction this module takes
  // everywhere, and the same one `deployLaneGatedOff` takes for an absent guard.
  assert.equal(
    classifyDispatchRun({ status: 'completed', conclusion: 'success' }, GATED_OFF_JOBS),
    DISPATCH_FATE.SURVIVED,
    'an unreadable ref is not evidence the switch is off',
  );
  // And the real shape still reports, so this conjunct cannot silence the lane.
  assert.equal(classifyDispatchRun(GATED_OFF_RUN, GATED_OFF_JOBS), DISPATCH_FATE.LANE_GATED_OFF);
});

test('a switched-off lane with production AT master reports nothing', () => {
  // The gap conjunct is what lets a DELIBERATE pause be silent. The report is
  // not "the switch is off" — it is "the switch is off AND commits are piling
  // up behind it", which is the only version a human owes anything about.
  const fate = DISPATCH_FATE.LANE_GATED_OFF;
  assert.equal(isDeadLane({ fate, commitsBehind: 90 }), true);
  assert.equal(isDeadLane({ fate, commitsBehind: 0 }), false, 'a paused lane with nothing to ship');
  assert.equal(isDeadLane({ fate, commitsBehind: null }), false, 'unmeasurable gap stays quiet');
  assert.ok(LANE_FAILED_TO_DELIVER_FATES.has(fate));
  assert.ok(LANE_FAILED_TO_DELIVER_FATES.has(DISPATCH_FATE.DIED_BEFORE_DEPLOY));
  for (const other of [DISPATCH_FATE.SURVIVED, DISPATCH_FATE.NONE, DISPATCH_FATE.UNKNOWN]) {
    assert.equal(LANE_FAILED_TO_DELIVER_FATES.has(other), false, `${other} delivered or is unknown`);
  }
});

test('detectDeadDispatch: a switched-off lane plus a positive gap is reportable end to end', async () => {
  const client = stubClient({
    [listPath]: (p) =>
      p.includes('status=success')
        ? { workflow_runs: [run(1, 'completed', 'success', '2026-11-02T09:09:42Z')] }
        : { workflow_runs: [run(2, 'completed', 'success', '2026-11-03T07:27:01Z')] },
    '/actions/runs/2/jobs': { jobs: GATED_OFF_JOBS },
    '/actions/runs/1/jobs': { jobs: jobs(['deploy', 'success']) },
    '/compare/': { ahead_by: 90, status: 'ahead' },
  });
  const result = await detectDeadDispatch({ client });
  assert.equal(result.fate, DISPATCH_FATE.LANE_GATED_OFF);
  assert.equal(result.dead, true);
  assert.equal(result.gap.commitsBehind, 90);
  // The strict refill signal must still say the lane was NOT refilled, so the
  // durable stall record cannot be closed by a dispatch that shipped nothing.
  assert.equal(result.run.deployExecuted, false);
});

// ---------------------------------------------------------------------------
// BLO-57061. Replay of docker.yml run 43571300881 (2026-11-14): build pushed
// ac5534f2, then `deploy` failed at the BLO-49140 minimum-interval step because
// paperclip-0 had been restarted 112m earlier. It read as `survived`, so no slot
// retried and a day of deploys was lost.
// ---------------------------------------------------------------------------
const refusedDeploy = (failingStep) => [
  { name: 'build-and-push', conclusion: 'success' },
  { name: DEPLOY_GATE_JOB_NAME, conclusion: 'success' },
  {
    name: DEPLOY_JOB_NAME,
    conclusion: 'failure',
    steps: [
      { name: 'Verify release tooling revision', conclusion: 'success' },
      { name: failingStep, conclusion: 'failure', completed_at: '2026-11-14T07:41:12Z' },
    ],
  },
];

test('replay 2026-11-14 run 43571300881: a min-interval refusal is retryable, not survived', () => {
  const run = { status: 'completed', conclusion: 'failure', head_branch: 'master' };
  assert.equal(
    classifyDispatchRun(run, refusedDeploy(MIN_INTERVAL_STEP_NAME)),
    DISPATCH_FATE.REFUSED_MIN_INTERVAL,
  );
  assert.equal(MIN_INTERVAL_STEP_NAME, 'Minimum interval since last roll (BLO-49140)');
});

test('a deploy job failing at any OTHER step is still survived — that is a real deploy attempt', () => {
  const run = { status: 'completed', conclusion: 'failure', head_branch: 'master' };
  assert.equal(
    classifyDispatchRun(run, refusedDeploy('Render, stamp, and validate deploy plan')),
    DISPATCH_FATE.SURVIVED,
  );
});

test('a refused run is not a refill for the close gate, and is not a dead lane', async () => {
  const client = stubClient({
    '/actions/workflows/': {
      workflow_runs: [
        { id: 43571300881, status: 'completed', conclusion: 'failure', head_branch: 'master',
          created_at: '2026-11-14T07:29:07Z' },
      ],
    },
    '/actions/runs/43571300881/jobs': { jobs: refusedDeploy(MIN_INTERVAL_STEP_NAME) },
  });
  const last = await findLastCompletedDispatch({ client });
  assert.equal(last.fate, DISPATCH_FATE.REFUSED_MIN_INTERVAL);
  assert.equal(last.run.deployExecuted, false);
  assert.equal(last.run.refusedAt, '2026-11-14T07:41:12Z', 'the retry clock starts at the refusal');
  assert.equal(LANE_FAILED_TO_DELIVER_FATES.has(DISPATCH_FATE.REFUSED_MIN_INTERVAL), false);
});

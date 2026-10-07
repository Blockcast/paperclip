// PEN-3315: guard (1) of scheduled-production-deploy.yml is correct and has no
// exit but a human. On 2026-09-14 a docker.yml dispatch at head c316ff73 sat
// `waiting` on the paperclip-production reviewer gate for 41.2h; for that whole
// window the dispatcher correctly refused to dispatch anything newer, production
// shipped nothing for 53h, and paperclip_api_deploy_commits_behind reached 164.
//
// The supersede path cancels such a run and re-dispatches at master. It approves
// NOTHING — that is the property these tests exist to keep true, alongside the
// two refusals that keep it from cancelling work a human is actually engaged
// with: a run whose target is still current, and a run that stopped being
// `waiting` between the guard's read and the cancel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANCEL_POLL_ATTEMPTS,
  CANCEL_POLL_DELAY_MS,
  DEPLOY_REF,
  confirmSupersede,
  parseSupersedeAfterHours,
  selectSupersedeCandidate,
  waitForCancel,
} from '../supersede-stale-deploy.mjs';
import { DEPLOY_WORKFLOW_FILE } from '../deploy-stall-record.mjs';

const NOW = new Date('2026-09-01T12:00:00.000Z');
const run = (createdAt, extra = {}) => ({
  databaseId: 1,
  status: 'waiting',
  createdAt,
  url: 'https://github.com/Blockcast/paperclip/actions/runs/1',
  ...extra,
});

test('selectSupersedeCandidate: a lone waiting run past the threshold is a candidate', () => {
  const selection = selectSupersedeCandidate({
    pendingRuns: [run('2026-09-01T02:00:00.000Z')],
    supersedeAfterHours: 6,
    now: NOW,
  });

  assert.equal(selection.eligible, true);
  assert.equal(selection.reason, 'stale-and-past-threshold');
  assert.equal(selection.ageHours, 10);
  assert.equal(selection.candidate.databaseId, 1);
});

test('selectSupersedeCandidate: a run under the threshold is NOT a candidate', () => {
  // A young waiting run is a reviewer who has simply not got to it yet;
  // cancelling it would be churn, not repair.
  const selection = selectSupersedeCandidate({
    pendingRuns: [run('2026-09-01T09:00:00.000Z')],
    supersedeAfterHours: 6,
    now: NOW,
  });

  assert.equal(selection.eligible, false);
  assert.equal(selection.reason, 'below-threshold');
  assert.equal(selection.ageHours, 3);
});

test('selectSupersedeCandidate: exactly at the threshold counts', () => {
  // Boundary inclusivity on its own terms: `supersedeAfterHours` reads as "after
  // N hours of waiting", and a run that has waited exactly N has satisfied that.
  // Pinned because the alternative (`>`) is a silent one-character change that
  // would defer every supersede by a whole polling interval.
  //
  // Deliberately NOT justified by matching the escalation. The two thresholds
  // are separate by design (BLO-25050) and differ by 42 hours — alerting at 6h
  // without superseding until 48h is the shipped behaviour, not a drift to
  // guard against.
  const selection = selectSupersedeCandidate({
    pendingRuns: [run('2026-09-01T06:00:00.000Z')],
    supersedeAfterHours: 6,
    now: NOW,
  });
  assert.equal(selection.eligible, true);
});

test('selectSupersedeCandidate: more than one waiting run is refused', () => {
  // Cancelling one of several leaves the lane held anyway, and nothing here has
  // a basis for choosing between them.
  const selection = selectSupersedeCandidate({
    pendingRuns: [
      run('2026-09-01T01:00:00.000Z', { databaseId: 2 }),
      run('2026-09-01T02:00:00.000Z', { databaseId: 3 }),
    ],
    supersedeAfterHours: 6,
    now: NOW,
  });

  assert.equal(selection.eligible, false);
  assert.equal(selection.reason, 'multiple-waiting-dispatches');
});

test('selectSupersedeCandidate: a queued or building dispatch alongside is refused', () => {
  // Dispatching while a build is live is exactly the stacking guard (1) exists
  // to prevent, and this must never become a way around it.
  for (const status of ['queued', 'in_progress']) {
    const selection = selectSupersedeCandidate({
      pendingRuns: [run('2026-09-01T01:00:00.000Z'), run('2026-09-01T11:00:00.000Z', { status })],
      supersedeAfterHours: 6,
      now: NOW,
    });
    assert.equal(selection.eligible, false, `${status} alongside must refuse`);
    assert.equal(selection.reason, 'non-waiting-dispatch-present');
  }
});

test('selectSupersedeCandidate: nothing waiting means nothing to supersede', () => {
  const selection = selectSupersedeCandidate({
    pendingRuns: [run('2026-09-01T01:00:00.000Z', { status: 'in_progress' })],
    supersedeAfterHours: 6,
    now: NOW,
  });
  assert.equal(selection.eligible, false);
  assert.equal(selection.reason, 'no-waiting-dispatch');
});

test('selectSupersedeCandidate: an unreadable createdAt declines rather than cancelling blind', () => {
  // post-pending-deploy-alert treats this as fatal because it cannot judge an
  // age it needs to report. Here the stake is different and larger: acting on an
  // age we cannot compute would cancel a human's pending approval on no
  // evidence. Declining is the only safe reading.
  const selection = selectSupersedeCandidate({
    pendingRuns: [run('not-a-date')],
    supersedeAfterHours: 6,
    now: NOW,
  });
  assert.equal(selection.eligible, false);
  assert.equal(selection.reason, 'unreadable-created-at');
});

test('confirmSupersede: a CURRENT waiting run is never superseded', () => {
  // THE negative case. A `waiting` run whose target is still master is SLOW, not
  // STALE: the reviewer has simply not pressed the button. Superseding it would
  // cancel a live approval request every six hours forever, achieving nothing
  // except losing whatever click was about to land.
  const verdict = confirmSupersede({ liveStatus: 'waiting', compareStatus: 'identical' });

  assert.equal(verdict.supersede, false);
  assert.equal(verdict.reason, 'target-is-current');
});

test('confirmSupersede: a strict ancestor of master IS superseded', () => {
  // `ahead` means master is ahead of the run's head, i.e. the run would deploy a
  // commit master has moved past. That is the 41.2h incident's exact shape.
  const verdict = confirmSupersede({ liveStatus: 'waiting', compareStatus: 'ahead' });

  assert.equal(verdict.supersede, true);
  assert.equal(verdict.reason, 'stale-target-superseded');
});

test('confirmSupersede: the approval race — a run that stopped waiting is left alone', () => {
  // The pending-runs file was written earlier in the job. A reviewer approving
  // in that window moves the run to in_progress, and cancelling then would throw
  // away the very click this whole mechanism is waiting for. The live re-read is
  // not decoration.
  for (const liveStatus of ['in_progress', 'queued', 'completed', undefined]) {
    const verdict = confirmSupersede({ liveStatus, compareStatus: 'ahead' });
    assert.equal(verdict.supersede, false, `liveStatus=${liveStatus} must not supersede`);
    assert.match(verdict.reason, /^no-longer-waiting:/);
  }
});

test('confirmSupersede: anything other than ahead/identical is refused, not guessed', () => {
  // `behind` and `diverged` mean the run targets something that is not simply an
  // older master — a rollback dispatched from a different ref, or history that
  // moved. We do not understand that situation, so we do not act on it.
  for (const compareStatus of ['behind', 'diverged', undefined, 'nonsense']) {
    const verdict = confirmSupersede({ liveStatus: 'waiting', compareStatus });
    assert.equal(verdict.supersede, false, `compare=${compareStatus} must not supersede`);
    assert.match(verdict.reason, /^unexpected-compare-status:/);
  }
});

test('the replacement is dispatched at master, never at the stale run head', () => {
  // PEN-3289 asked whether the dispatcher should re-target master; it always
  // has. The staleness lives in the pending RUN, so the constant that matters
  // here is that the replacement goes to master.
  assert.equal(DEPLOY_REF, 'master');
  assert.equal(DEPLOY_WORKFLOW_FILE, 'docker.yml');
});

test('replay 2026-09-14: the 41.2h incident is NOT superseded under the shipped 48h threshold', () => {
  // Real values, read from the Actions API. docker.yml workflow_dispatch run
  // 34889856627: created 19:55:57Z, head c316ff73, cancelled by a human
  // 2026-09-16T13:12:14Z — 41.2h on the gate. `compare/c316ff73...master`
  // reports ahead_by 123, behind_by 0, status `ahead`.
  //
  // This test used to assert that PEN-3315 covered its own motivating incident,
  // running the replay at the then-shipped 6h threshold. BLO-25050 moved the
  // supersede to 48h and that coverage is DELIBERATELY GIVEN UP: 41.2h is inside
  // the new 6h–48h survival band, so this exact incident would now run to the
  // human cancel untouched. The trade is stated once, here — a 6h supersede
  // destroys the gate-holder run id roughly six times per board decision cycle
  // (measured holder lifetimes 7.04h / 6.71h / 7.40h against a 45.7h median
  // time-to-decision), so it buys a fresh head at the cost of a gate that can
  // never be approved through the card channel at all. A stale head that a human
  // CAN approve beats a current head nobody can reach.
  const GATE = {
    databaseId: 34889856627,
    status: 'waiting',
    createdAt: '2026-09-14T19:55:57Z',
    url: 'https://github.com/Blockcast/paperclip/actions/runs/34889856627',
  };
  const HUMAN_CANCELLED_AT = Date.parse('2026-09-16T13:12:14Z');

  // Control, and the record of what was traded away: at the OLD coupled 6h
  // threshold the first hourly sampling slot past it (02:23Z the next morning)
  // did select this run.
  const firstSlotPastSixHours = Date.parse('2026-09-15T02:23:00Z');
  const atSixHours = selectSupersedeCandidate({
    pendingRuns: [GATE],
    supersedeAfterHours: 6,
    now: new Date(firstSlotPastSixHours),
  });
  assert.equal(atSixHours.eligible, true, 'control: the old 6h threshold did select this run');
  assert.ok(atSixHours.ageHours > 6.4 && atSixHours.ageHours < 6.5);

  // The shipped threshold, at the latest moment it could have mattered — the
  // instant the human gave up and cancelled. Still below 48h, so the lane was
  // never touched by the supersede at any point during the real incident.
  const atShippedThreshold = selectSupersedeCandidate({
    pendingRuns: [GATE],
    supersedeAfterHours: 48,
    now: new Date(HUMAN_CANCELLED_AT),
  });
  assert.equal(atShippedThreshold.eligible, false);
  assert.equal(atShippedThreshold.reason, 'below-threshold');
  assert.ok(
    atShippedThreshold.ageHours > 41.2 && atShippedThreshold.ageHours < 41.3,
    `the run reached ${atShippedThreshold.ageHours}h, short of the 48h threshold`,
  );

  // The selection mechanics this incident exercised are still worth pinning:
  // had it crossed 48h, the compare reads `ahead` and the run IS superseded.
  assert.equal(
    confirmSupersede({ liveStatus: 'waiting', compareStatus: 'ahead' }).supersede,
    true,
  );
});

// ---------------------------------------------------------------------------
// waitForCancel — the POST-cancel half of the approval race.
//
// selectSupersedeCandidate already refuses to act when a queued/in_progress
// dispatch sits alongside (`non-waiting-dispatch-present`). The same hazard
// exists on the other side of the cancel: `POST .../cancel` is asynchronous, so
// the run leaves `waiting` on its own schedule — and it can also leave `waiting`
// by being APPROVED. Reading merely-not-`waiting` as "the cancel landed" would
// dispatch a replacement alongside a live, approved production deploy, and
// nothing downstream would notice: guard-pending-deploy{,-final} both query
// `status=waiting` only, so an in_progress sibling reads as blocked=false.
const cancelClient = (statuses) => {
  const seen = [...statuses];
  return {
    request: async () => {
      const status = seen.length > 1 ? seen.shift() : seen[0];
      if (status instanceof Error) throw status;
      return { status };
    },
  };
};
const noSleep = { sleep: async () => {} };

test('waitForCancel: only a TERMINAL state proves the cancel landed', async () => {
  const outcome = await waitForCancel(cancelClient(['waiting', 'completed']), 1, noSleep);
  assert.deepEqual(outcome, { cleared: true, reason: 'cancel-landed', status: 'completed' });
});

test('waitForCancel: an APPROVED run is not a cleared lane — in_progress must not dispatch', async () => {
  // The exact race the file header documents: a reviewer clicks between the live
  // re-read and the cancel taking effect. An approved run goes
  // waiting -> queued -> in_progress, never straight to completed.
  for (const status of ['queued', 'in_progress']) {
    const outcome = await waitForCancel(cancelClient([status]), 1, noSleep);
    assert.equal(outcome.cleared, false, `${status} must not read as a cleared lane`);
    assert.equal(outcome.reason, 'approval-won-cancel-race');
    assert.equal(outcome.status, status);
  }
});

test('waitForCancel: a cancel that never settles times out rather than dispatching', async () => {
  const outcome = await waitForCancel(cancelClient(['waiting']), 1, noSleep);
  assert.deepEqual(outcome, { cleared: false, reason: 'cancel-did-not-settle', status: 'waiting' });
});

test('waitForCancel: a read failure counts as "not yet", never as cleared', async () => {
  // Same posture as before: we would rather not dispatch than dispatch into a
  // guard that refuses the replacement and leaves the lane looking healthy with
  // nothing in it.
  const outcome = await waitForCancel(cancelClient([new Error('502 Bad Gateway')]), 1, noSleep);
  assert.equal(outcome.cleared, false);
  assert.equal(outcome.reason, 'cancel-did-not-settle');
});

test('waitForCancel: polling is bounded and the bound is far inside a cancel settle', () => {
  assert.ok(CANCEL_POLL_ATTEMPTS * CANCEL_POLL_DELAY_MS >= 20_000);
  assert.ok(CANCEL_POLL_ATTEMPTS * CANCEL_POLL_DELAY_MS <= 60_000);
});

// BLO-25050. The supersede threshold was PENDING_DEPLOY_ALERT_HOURS (6h) until
// 2026-10-04. The gate has a second consumer now — a Paperclip board card pins to
// the waiting run id and is retired when that run terminates — and measured
// gate-holder lifetimes of 7.04h / 6.71h / 7.40h against a 45.7h median
// time-to-decision meant the card's handle was destroyed roughly six times per
// decision cycle, so the ask could never be answered through that channel.
//
// Regression guard for the separation: a run the OLD coupled 6h threshold would
// have cancelled must survive the new 48h one.
test('selectSupersedeCandidate: a run past the 6h ALERT threshold survives the 48h SUPERSEDE threshold', () => {
  const sevenHoursOld = run('2026-09-01T05:00:00.000Z');

  assert.equal(
    selectSupersedeCandidate({ pendingRuns: [sevenHoursOld], supersedeAfterHours: 6, now: NOW })
      .eligible,
    true,
    'control: the old coupled threshold did cancel this run',
  );

  const selection = selectSupersedeCandidate({
    pendingRuns: [sevenHoursOld],
    supersedeAfterHours: 48,
    now: NOW,
  });
  assert.equal(selection.eligible, false);
  assert.equal(selection.reason, 'below-threshold');
  assert.equal(selection.ageHours, 7);
});

// The separation must not become "never supersede". A genuinely abandoned run
// past 48h is still cancelled and re-dispatched, which is PEN-3315's whole point.
test('selectSupersedeCandidate: a run past the 48h threshold is still superseded', () => {
  const selection = selectSupersedeCandidate({
    pendingRuns: [run('2026-08-30T02:00:00.000Z')],
    supersedeAfterHours: 48,
    now: NOW,
  });

  assert.equal(selection.eligible, true);
  assert.equal(selection.reason, 'stale-and-past-threshold');
  assert.equal(selection.ageHours, 58);
});

// BLO-25050 removed the default, which makes a missing or garbled
// SUPERSEDE_AFTER_HOURS this script's only configuration failure mode. Nothing
// else exercises main()'s env parsing, so the rejection is pinned here rather
// than asserted in a comment.
test('parseSupersedeAfterHours rejects everything that is not a positive number', () => {
  for (const bad of [undefined, null, '', '   ', 'abc', '0', '-1', 'NaN', 'Infinity']) {
    assert.equal(parseSupersedeAfterHours(bad), null, `${JSON.stringify(bad)} must be rejected`);
  }
  assert.equal(parseSupersedeAfterHours('48'), 48);
  assert.equal(parseSupersedeAfterHours('6'), 6);
  assert.equal(parseSupersedeAfterHours(' 48 '), 48);
});

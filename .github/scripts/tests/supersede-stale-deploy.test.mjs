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
    alertAfterHours: 6,
    now: NOW,
  });

  assert.equal(selection.eligible, true);
  assert.equal(selection.reason, 'stale-and-past-threshold');
  assert.equal(selection.ageHours, 10);
  assert.equal(selection.candidate.databaseId, 1);
});

test('selectSupersedeCandidate: a run under the threshold is NOT a candidate', () => {
  // The supersede deliberately reuses PENDING_DEPLOY_ALERT_HOURS rather than
  // adding a tunable, so the condition that cancels is the condition that
  // already escalates. A young waiting run is a reviewer who has simply not got
  // to it yet; cancelling it would be churn, not repair.
  const selection = selectSupersedeCandidate({
    pendingRuns: [run('2026-09-01T09:00:00.000Z')],
    alertAfterHours: 6,
    now: NOW,
  });

  assert.equal(selection.eligible, false);
  assert.equal(selection.reason, 'below-threshold');
  assert.equal(selection.ageHours, 3);
});

test('selectSupersedeCandidate: exactly at the threshold counts, matching the escalation', () => {
  // The escalation uses `>=`. If these two disagreed by a hair, a slot could
  // alert without superseding (or the reverse) and the two signals would tell
  // different stories about the same run.
  const selection = selectSupersedeCandidate({
    pendingRuns: [run('2026-09-01T06:00:00.000Z')],
    alertAfterHours: 6,
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
    alertAfterHours: 6,
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
      alertAfterHours: 6,
      now: NOW,
    });
    assert.equal(selection.eligible, false, `${status} alongside must refuse`);
    assert.equal(selection.reason, 'non-waiting-dispatch-present');
  }
});

test('selectSupersedeCandidate: nothing waiting means nothing to supersede', () => {
  const selection = selectSupersedeCandidate({
    pendingRuns: [run('2026-09-01T01:00:00.000Z', { status: 'in_progress' })],
    alertAfterHours: 6,
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
    alertAfterHours: 6,
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

test('replay 2026-09-14: the incident that held the lane 41.2h would have been superseded', () => {
  // Real values, read from the Actions API. docker.yml workflow_dispatch run
  // 34889856627: created 19:55:57Z, head c316ff73, cancelled by a human
  // 2026-09-16T13:12:14Z — 41.2h on the gate. `compare/c316ff73...master`
  // reports ahead_by 123, behind_by 0, status `ahead`.
  const GATE = {
    databaseId: 34889856627,
    status: 'waiting',
    createdAt: '2026-09-14T19:55:57Z',
    url: 'https://github.com/Blockcast/paperclip/actions/runs/34889856627',
  };
  const HUMAN_CANCELLED_AT = Date.parse('2026-09-16T13:12:14Z');

  // The first hourly sampling slot at or past the 6h threshold (crossed
  // 01:55:57Z) is 02:23Z the next morning.
  const firstSlotPastThreshold = Date.parse('2026-09-15T02:23:00Z');
  const selection = selectSupersedeCandidate({
    pendingRuns: [GATE],
    alertAfterHours: 6,
    now: new Date(firstSlotPastThreshold),
  });

  assert.equal(selection.eligible, true);
  assert.ok(selection.ageHours > 6.4 && selection.ageHours < 6.5);

  // By then master had moved on, so the compare reads `ahead` and the run is
  // superseded — replacing a head that went on to be 123 commits stale.
  assert.equal(
    confirmSupersede({ liveStatus: 'waiting', compareStatus: 'ahead' }).supersede,
    true,
  );

  // What this buys, stated exactly: the lane would still have waited for a
  // human — the supersede approves nothing — but the head in front of that
  // human would have been refreshed roughly every 6h instead of decaying for
  // 41.2h into a partial.
  const missedHours = (HUMAN_CANCELLED_AT - firstSlotPastThreshold) / 3_600_000;
  assert.ok(missedHours > 34, `the stall ran ${missedHours}h past the first supersede point`);
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

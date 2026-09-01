import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALERT_TTL_MS,
  DEFAULT_ALERT_AFTER_HOURS,
  buildAlert,
  selectStuckApproval,
} from '../post-pending-deploy-alert.mjs';

const NOW = new Date('2026-09-01T12:00:00.000Z');
const waitingRun = (createdAt, extra = {}) => ({
  databaseId: 1,
  status: 'waiting',
  createdAt,
  url: 'https://github.com/Blockcast/paperclip/actions/runs/1',
  ...extra,
});

test('selectStuckApproval: a run waiting past the threshold is stuck', () => {
  const verdict = selectStuckApproval({
    pendingRuns: [waitingRun('2026-09-01T02:00:00.000Z')],
    alertAfterHours: 6,
    now: NOW,
  });

  assert.equal(verdict.stuck, true);
  assert.equal(verdict.ageHours, 10);
  assert.equal(verdict.waitingCount, 1);
});

test('selectStuckApproval: a young waiting run is NOT escalated', () => {
  const verdict = selectStuckApproval({
    pendingRuns: [waitingRun('2026-09-01T09:00:00.000Z')],
    alertAfterHours: 6,
    now: NOW,
  });

  assert.equal(verdict.stuck, false);
  assert.equal(verdict.ageHours, 3);
});

test('selectStuckApproval: queued/in_progress runs never escalate — no human is being waited on', () => {
  // These block the dispatcher's anti-stacking guard too, but they are runner
  // and build states. Paging three named reviewers for a slow build would be
  // the wrong people.
  const verdict = selectStuckApproval({
    pendingRuns: [
      waitingRun('2026-08-30T00:00:00.000Z', { status: 'in_progress' }),
      waitingRun('2026-08-30T00:00:00.000Z', { status: 'queued' }),
    ],
    alertAfterHours: 6,
    now: NOW,
  });

  assert.equal(verdict.stuck, false);
  assert.equal(verdict.oldest, null);
  assert.equal(verdict.waitingCount, 0);
});

test('selectStuckApproval: reports the OLDEST waiting run, not the first listed', () => {
  const verdict = selectStuckApproval({
    pendingRuns: [
      waitingRun('2026-09-01T10:00:00.000Z', { databaseId: 2 }),
      waitingRun('2026-09-01T01:00:00.000Z', { databaseId: 3 }),
    ],
    alertAfterHours: 6,
    now: NOW,
  });

  assert.equal(verdict.oldest.databaseId, 3);
  assert.equal(verdict.ageHours, 11);
  assert.equal(verdict.waitingCount, 2);
});

test('selectStuckApproval: runs with an unparseable createdAt are ignored, not treated as age 0', () => {
  // A NaN age silently compares false against any threshold, which would read
  // as "not stuck" — a failed read must never look like health.
  const verdict = selectStuckApproval({
    pendingRuns: [waitingRun('not-a-date'), waitingRun('2026-09-01T00:00:00.000Z')],
    alertAfterHours: 6,
    now: NOW,
  });

  assert.equal(verdict.stuck, true);
  assert.equal(verdict.oldest.createdAt, '2026-09-01T00:00:00.000Z');
  assert.equal(verdict.waitingCount, 1);
});

test('selectStuckApproval: an empty pending list does not escalate', () => {
  const verdict = selectStuckApproval({ pendingRuns: [], alertAfterHours: 6, now: NOW });
  assert.equal(verdict.stuck, false);
  assert.equal(verdict.oldest, null);
});

test('regression (PEN-2848): the 2026-09-01 incident would have escalated at the default threshold', () => {
  // The real numbers. Run 33456522759 went `waiting` at 00:52:41Z; the daily
  // dispatcher's first-ever real slot ran at 07:32:41Z, logged
  // "1 dispatch(es) already waiting or running — not dispatching", and exited
  // conclusion=success with nothing escalated. Production was 45 commits behind.
  const verdict = selectStuckApproval({
    pendingRuns: [
      waitingRun('2026-09-01T00:52:41.000Z', {
        databaseId: 33456522759,
        url: 'https://github.com/Blockcast/paperclip/actions/runs/33456522759',
      }),
    ],
    alertAfterHours: DEFAULT_ALERT_AFTER_HOURS,
    now: new Date('2026-09-01T07:32:41.000Z'),
  });

  assert.equal(verdict.stuck, true, 'the reported incident must trip the default threshold');
  assert.ok(verdict.ageHours > 6.6 && verdict.ageHours < 6.7);
});

test('buildAlert: carries severity=critical so Alertmanager routes it to slack-relay', () => {
  // The live route tree matches severity=~"critical|page" -> slack-relay and
  // sends everything else to the paperclip webhook only. Routing this alert to
  // paperclip alone would make it dark to the very outage it may be reporting.
  const verdict = selectStuckApproval({
    pendingRuns: [waitingRun('2026-09-01T02:00:00.000Z')],
    alertAfterHours: 6,
    now: NOW,
  });
  const alert = buildAlert({
    ...verdict,
    alertAfterHours: 6,
    runUrl: 'https://github.com/Blockcast/paperclip/actions/runs/99',
    repo: 'Blockcast/paperclip',
    environment: 'paperclip-production',
    now: NOW,
  });

  assert.equal(alert.labels.severity, 'critical');
  assert.equal(alert.labels.alertname, 'ProductionDeployApprovalStuck');
  assert.equal(alert.labels.repo, 'Blockcast/paperclip');
  assert.equal(alert.labels.environment, 'paperclip-production');
  assert.equal(alert.labels.namespace, 'paperclip');
});

test('buildAlert: names the pending run so the reader can act without opening the dispatcher log', () => {
  const verdict = selectStuckApproval({
    pendingRuns: [
      waitingRun('2026-09-01T02:00:00.000Z', {
        url: 'https://github.com/Blockcast/paperclip/actions/runs/33456522759',
      }),
    ],
    alertAfterHours: 6,
    now: NOW,
  });
  const alert = buildAlert({
    ...verdict,
    alertAfterHours: 6,
    runUrl: 'https://github.com/Blockcast/paperclip/actions/runs/99',
    repo: 'Blockcast/paperclip',
    environment: 'paperclip-production',
    now: NOW,
  });

  assert.equal(alert.annotations.pending_run_url, verdict.oldest.url);
  assert.equal(alert.annotations.pending_since, '2026-09-01T02:00:00.000Z');
  assert.match(alert.annotations.description, /Approve or reject/);
  assert.match(alert.annotations.description, /33456522759/);
  assert.match(alert.annotations.summary, /10\.0h/);
});

test('buildAlert: endsAt outlives the daily schedule so firing stays continuous', () => {
  const verdict = selectStuckApproval({
    pendingRuns: [waitingRun('2026-09-01T02:00:00.000Z')],
    alertAfterHours: 6,
    now: NOW,
  });
  const alert = buildAlert({
    ...verdict,
    alertAfterHours: 6,
    runUrl: '',
    repo: 'Blockcast/paperclip',
    environment: 'paperclip-production',
    now: NOW,
  });

  assert.equal(alert.startsAt, NOW.toISOString());
  assert.equal(new Date(alert.endsAt).getTime() - NOW.getTime(), ALERT_TTL_MS);
  // 24h schedule; a TTL at or under that would let the alert resolve between
  // runs and re-notify as if it were new.
  assert.ok(ALERT_TTL_MS > 24 * 60 * 60 * 1000);
});

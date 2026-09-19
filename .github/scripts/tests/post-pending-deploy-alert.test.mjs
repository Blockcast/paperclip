import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALERT_TTL_MS,
  DEFAULT_ALERT_AFTER_HOURS,
  UnreadableWaitingRunError,
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

test('selectStuckApproval: an unparseable createdAt on a waiting run is FATAL, not filtered out', () => {
  // Previously these were dropped from the candidate list. That fails open:
  // a NaN age compares false against any threshold, and excluding the record
  // entirely means an unjudgeable approval reads as absent. Either way the step
  // exits 0 and nothing escalates — the silent green PEN-2848 is about. We
  // cannot age it, so we say so and let the step fail.
  assert.throws(
    () =>
      selectStuckApproval({
        pendingRuns: [waitingRun('not-a-date'), waitingRun('2026-09-01T00:00:00.000Z')],
        alertAfterHours: 6,
        now: NOW,
      }),
    UnreadableWaitingRunError,
  );
});

test('selectStuckApproval: a malformed waiting run cannot be masked by a younger valid one', () => {
  // The case that makes this fail-open rather than merely lossy. Filtering the
  // malformed record left only a 1h-old run, so the verdict was `stuck: false`
  // and the genuinely stuck approval — the one we could not read — escalated
  // nothing. Reporting healthy state from unreadable input is the failure mode.
  assert.throws(
    () =>
      selectStuckApproval({
        pendingRuns: [
          waitingRun('2026-09-01T11:00:00.000Z', { databaseId: 7 }),
          waitingRun(undefined, { databaseId: 8 }),
        ],
        alertAfterHours: 6,
        now: NOW,
      }),
    (err) => err instanceof UnreadableWaitingRunError && /run 8/.test(err.message),
  );
});

test('selectStuckApproval: a malformed createdAt on a NON-waiting run is ignored, not fatal', () => {
  // queued/in_progress ages are never read, so a bad timestamp there tells us
  // nothing about a human sitting on a button. Failing the dispatcher over it
  // would be noise on the path we just made loud.
  const verdict = selectStuckApproval({
    pendingRuns: [
      waitingRun('nonsense', { status: 'queued' }),
      waitingRun('2026-09-01T02:00:00.000Z'),
    ],
    alertAfterHours: 6,
    now: NOW,
  });

  assert.equal(verdict.stuck, true);
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

test('buildAlert: endsAt brackets the hourly schedule — outlives a missed slot, resolves same-day', () => {
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

  const HOUR = 60 * 60 * 1000;
  assert.equal(alert.startsAt, NOW.toISOString());
  assert.equal(new Date(alert.endsAt).getTime() - NOW.getTime(), ALERT_TTL_MS);
  // Lower bound: the escalation re-pushes on the hourly cron, so a TTL at or
  // under one hour would let the alert resolve between runs and re-notify as if
  // it were new. Two hours of slack absorbs a delayed or failed slot.
  assert.ok(ALERT_TTL_MS > 2 * HOUR, 'TTL must survive one missed hourly slot');
  // Upper bound, and this is the half BLO-33400 added: the TTL is also how long
  // a CLEARED gate keeps a critical alert firing, because nothing detects the
  // fix — it resolves by expiry. At the old 25h value an approval granted at
  // 10:00 paged until 11:00 the next day.
  assert.ok(ALERT_TTL_MS <= 6 * HOUR, 'TTL must not outlive the gate it reports');
});

// ---------------------------------------------------------------------------
// When the stall record is UNREADABLE, the run only goes red if the record
// could have changed the verdict.
//
// PEN-2848 made this dispatcher's `conclusion` mean one specific thing: "a
// production approval is stuck". Exiting 1 on any failed record read would make
// a transient GitHub API blip, during a slot where nothing is on the reviewer
// gate at all, emit that same signal — and it would contradict the rule the
// sibling close step states, that the conclusion must not start meaning
// "housekeeping failed".
//
// The discriminator is `verdict.oldest`. These two tests pin the property the
// gate is derived from, so the gate cannot be "simplified" back.
test('with no waiting run the verdict is settled BEFORE the record is consulted', () => {
  // Every recorded stall start, including an absurd one, must produce the
  // identical verdict — which is what makes a failed read provably irrelevant.
  const base = { pendingRuns: [], alertAfterHours: 6, now: new Date('2026-09-16T12:00:00Z') };
  const noRecord = selectStuckApproval({ ...base, stallStartedAt: null });
  const ancientRecord = selectStuckApproval({ ...base, stallStartedAt: '2020-01-01T00:00:00Z' });

  assert.deepEqual(noRecord, ancientRecord);
  assert.equal(noRecord.stuck, false);
  assert.equal(noRecord.oldest, null);
});

test('queued and in_progress dispatches are not waiting runs, so they too settle without the record', () => {
  // This is the slot the finding is about: guard (1) reported something pending,
  // so the escalation step runs, but nothing is actually on the reviewer gate.
  const base = {
    pendingRuns: [
      { databaseId: 1, status: 'queued', createdAt: '2026-09-16T11:00:00Z' },
      { databaseId: 2, status: 'in_progress', createdAt: '2026-09-16T11:30:00Z' },
    ],
    alertAfterHours: 6,
    now: new Date('2026-09-16T12:00:00Z'),
  };
  assert.deepEqual(
    selectStuckApproval({ ...base, stallStartedAt: null }),
    selectStuckApproval({ ...base, stallStartedAt: '2020-01-01T00:00:00Z' }),
  );
  assert.equal(selectStuckApproval({ ...base, stallStartedAt: null }).oldest, null);
});

test('WITH a waiting run under threshold the record IS decisive, so a failed read stays fatal', () => {
  // The other arm: here an earlier recorded start pushes the age over the
  // threshold, so an unreadable record genuinely means an unjudgeable age.
  const base = {
    pendingRuns: [{ databaseId: 1, status: 'waiting', createdAt: '2026-09-16T11:00:00Z' }],
    alertAfterHours: 6,
    now: new Date('2026-09-16T12:00:00Z'),
  };
  assert.equal(selectStuckApproval({ ...base, stallStartedAt: null }).stuck, false);
  assert.equal(
    selectStuckApproval({ ...base, stallStartedAt: '2026-09-16T00:00:00Z' }).stuck,
    true,
    'the record can flip the verdict here, which is why a failed read must still fail',
  );
});

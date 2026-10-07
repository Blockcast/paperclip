import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALERT_TTL_MS,
  DEFAULT_ALERT_AFTER_HOURS,
  UnreadableWaitingRunError,
  buildAlert,
  selectStuckApproval,
} from '../post-pending-deploy-alert.mjs';
import { DEPLOY_WORKFLOW_FILE } from '../deploy-stall-record.mjs';

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

test('buildAlert: no run-level identity reaches the alert — it is terminal seconds after the push (BLO-39564)', () => {
  // THE GUARD. The escalate step runs BEFORE the supersede step that cancels the
  // run it would name, so any run id or run-level timestamp in this payload is
  // dead within seconds of every push, by the dispatcher's own design. Measured
  // 2026-10-02: supersede at 23:33:47Z cancelled run 37035438983, its
  // replacement failed in `build-and-push` at 23:46:08Z, and for 1h26m the only
  // firing alert asserted `pending run waiting since 16:39:45Z` against a run
  // with `pending_deployments: 0`.
  //
  // Asserted over the WHOLE annotation blob, not over the two field names that
  // carried it when this was written: the defect is "run identity is published",
  // and a reader who adds a third annotation next year should fail here too.
  //
  // The two values must be distinguishable from the stall clock for this to
  // discriminate, so the verdict is a SUPERSEDED one — stall start 02:00 is
  // three hours earlier than the run's own 05:00.
  const verdict = {
    ...selectStuckApproval({
      pendingRuns: [
        waitingRun('2026-09-01T05:00:00.000Z', {
          url: 'https://github.com/Blockcast/paperclip/actions/runs/37035438983',
        }),
      ],
      alertAfterHours: 6,
      now: NOW,
      stallStartedAt: '2026-09-01T02:00:00.000Z',
    }),
  };
  const alert = buildAlert({
    ...verdict,
    alertAfterHours: 6,
    runUrl: 'https://github.com/Blockcast/paperclip/actions/runs/99',
    repo: 'Blockcast/paperclip',
    environment: 'paperclip-production',
    now: NOW,
  });

  const blob = JSON.stringify(alert.annotations);
  assert.ok(
    !blob.includes('37035438983'),
    `no annotation may carry the pending run id — it is cancelled by supersede: ${blob}`,
  );
  assert.ok(
    !blob.includes('2026-09-01T05:00:00.000Z'),
    `no annotation may carry the run's createdAt as run-level context — the stall clock is ` +
      `the durable one. (\`stall_since\` legitimately equals the createdAt when no stall ` +
      `start is recorded; this fixture supplies one, so they differ.): ${blob}`,
  );
  assert.equal(alert.annotations.pending_run_url, undefined);
  assert.equal(alert.annotations.pending_since, undefined);

  // Positive control: the DURABLE half is still published, so this test fails on
  // a gutted alert as well as on a reverted guard.
  assert.equal(alert.annotations.stall_since, '2026-09-01T02:00:00.000Z');
  assert.match(alert.annotations.description, /superseded at least once/);
  assert.match(alert.annotations.summary, /10\.0h/);

  // BLO-32545. The body used to assert that a skipped slot 'still reports
  // conclusion=success' and that 'nothing else escalates this'. Both stopped being
  // UNIVERSALLY true when the four-exits work added the durable record and made a
  // stall PAST PENDING_DEPLOY_ALERT_HOURS fail the run. Guard (1) itself still
  // exits 0 (scheduled-production-deploy.yml:161-162); the red comes from the later
  // `Fail the run when a production approval is stuck` step, gated on
  // `escalate.outputs.escalated == 'true'`, which post-pending-deploy-alert.mjs sets
  // only past the threshold (:497 vs :420). So an under-threshold skipped slot is
  // still green — which is exactly why the retired sentence read as current fact in
  // a live triage ruling. The description is operator-facing, so an unconditional
  // mechanism claim in it is a defect even though no behaviour depends on the string.
  assert.doesNotMatch(alert.annotations.description, /conclusion[=:]\s*success/i);
  assert.doesNotMatch(alert.annotations.description, /Nothing else escalates/i);
});

test('buildAlert: an unsuperseded stall does not claim a supersede for a second-precision createdAt', () => {
  // `gh run list` emits createdAt at second precision, and selectStuckApproval
  // normalizes stallStartedAt through toISOString(), so the two spell the same
  // instant differently. Every other fixture here is already `.000Z`, which makes
  // that normalization a no-op; this one is not.
  const verdict = selectStuckApproval({
    pendingRuns: [waitingRun('2026-09-01T02:00:00Z')],
    alertAfterHours: 6,
    now: NOW,
  });
  assert.equal(verdict.stallStartedAt, '2026-09-01T02:00:00.000Z');
  const alert = buildAlert({
    ...verdict,
    alertAfterHours: 6,
    runUrl: 'https://github.com/Blockcast/paperclip/actions/runs/99',
    repo: 'Blockcast/paperclip',
    environment: 'paperclip-production',
    now: NOW,
  });
  assert.doesNotMatch(alert.annotations.description, /superseded at least once/);
});

test('buildAlert: the call to action is the waiting-runs queue, never the perishable run url', () => {
  // BLO-26972. The escalate step runs BEFORE the supersede step that cancels the
  // run it names — measured 6s apart on 2026-09-19, and the alert then carried
  // the dead url for the rest of the ~7h cycle. Sending the one human who can
  // approve to a cancelled run is the exact harm this ticket tracks, reproduced
  // inside the sanctioned supersede path.
  //
  // The assertion is on the line the reader ACTS on, not on the url appearing
  // somewhere in the body. That distinction mattered when BLO-26972 still quoted
  // the run as observed-at-alert context; BLO-39564 removed the quote entirely,
  // so both halves are now asserted — the CTA here, the whole payload above.
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

  const queueUrl =
    `https://github.com/Blockcast/paperclip/actions/workflows/${DEPLOY_WORKFLOW_FILE}` +
    '?query=is%3Awaiting';
  assert.equal(alert.annotations.pending_queue_url, queueUrl);

  const cta = alert.annotations.description
    .split('\n')
    .find((line) => line.startsWith('Approve or reject'));
  assert.ok(cta, 'the description must carry an "Approve or reject" call to action');
  assert.ok(
    cta.includes(queueUrl),
    `the call to action must link the waiting-runs queue, got: ${cta}`,
  );
  assert.ok(
    !cta.includes('/actions/runs/'),
    `the call to action must not link an individual run — it is cancelled by supersede: ${cta}`,
  );

  // BLO-39564 removed the demotion: the run is not quoted anywhere now, so this
  // test no longer needs to distinguish "in the CTA" from "elsewhere in the
  // body". The whole-payload guard is the test above; this one stays pointed at
  // the line the reader ACTS on, which is the invariant BLO-26972 bought.
  assert.ok(
    !alert.annotations.description.includes('33456522759'),
    'the run must not be quoted anywhere in the description (BLO-39564)',
  );
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

// --- PEN-3744: the delivery gap on the notifying surface ---------------------
//
// These tests exist because the thing that failed in production was not the
// rule, the threshold or the delivery — it was that the ONE alert Alertmanager
// lets through could not express how far behind production actually was. The
// sibling that could, `PaperclipApiProductionDeployStalled`, is inhibited by
// this alert (onprem-k8s BLO-37835) and read `suppressed` with
// `silencedBy: []` for seven days while 612 commits piled up.

/**
 * Reproduces what the Slack relay actually forwards from a description:
 * the first blank-line-delimited paragraph, whitespace-collapsed, truncated at
 * 400 chars (onprem-k8s monitoring/alertmanager-slack-relay.yaml,
 * `lead_paragraph` / `DESC_LEAD_MAX`). Without this the tests could assert text
 * a human never sees.
 */
const DESC_LEAD_MAX = 400;
const slackLead = (description) =>
  description.trim().split('\n\n', 1)[0].split(/\s+/).join(' ');

const STALLED_GAP = {
  commitsBehind: 612,
  days: 12.52,
  deployedSha: 'f06c717a6b1d3d1cbaca3a2708c21adf81fd7bba',
  landedAt: '2026-09-21T16:38:56Z',
  deployRunUrl: 'https://github.com/Blockcast/paperclip/actions/runs/35623928344',
  compareStatus: 'ahead',
  deployedCommitAt: '2026-09-20T22:55:03Z',
};

const stuckAlert = (extra = {}) => {
  const verdict = selectStuckApproval({
    pendingRuns: [waitingRun('2026-09-01T02:00:00.000Z')],
    alertAfterHours: 6,
    now: NOW,
  });
  return buildAlert({
    ...verdict,
    alertAfterHours: 6,
    runUrl: 'https://github.com/Blockcast/paperclip/actions/runs/99',
    repo: 'Blockcast/paperclip',
    environment: 'paperclip-production',
    now: NOW,
    ...extra,
  });
};

test('PEN-3744: the SUMMARY carries the delivery gap — the relay never truncates it', () => {
  const alert = stuckAlert({ deliveryGap: STALLED_GAP });

  assert.match(alert.annotations.summary, /612 commits \/ 12\.5d behind master/);
  // The approval age must survive too: it is the actionable half.
  assert.match(alert.annotations.summary, /awaiting human approval for 10\.0h/);
});

test('PEN-3744: the gap is in the FIRST paragraph and the Slack lead fits in 400 chars', () => {
  // This is the positive control for the whole change. A gap that lands in
  // paragraph 2, or overruns the cap, is a gap the human reading Slack does
  // not get — which is indistinguishable from not having fixed anything.
  const alert = stuckAlert({ deliveryGap: STALLED_GAP, stallStartedAt: '2026-08-31T20:00:00.000Z' });
  const lead = slackLead(alert.annotations.description);

  assert.match(lead, /612 commits \/ 12\.5d behind master/);
  assert.match(lead, /f06c717a landed 2026-09-21T16:38:56Z/);
  assert.ok(
    lead.length <= DESC_LEAD_MAX,
    `Slack lead is ${lead.length} chars, over the ${DESC_LEAD_MAX} cap: ${lead}`,
  );
  // And the approval clause, which this paragraph used to be entirely about,
  // is still inside the same lead rather than pushed out by the new text.
  assert.match(lead, /parked on the paperclip-production reviewer gate/);
});

test('PEN-3744: says out loud that the approval age is the SMALLER number', () => {
  // The filed defect was read as a ~48x understatement because the approval
  // age looked like the stall clock. Both numbers now appear together, so the
  // alert has to say which is which or it invites the same misreading.
  const alert = stuckAlert({ deliveryGap: STALLED_GAP });
  assert.match(slackLead(alert.annotations.description), /SMALLER, different number/);
});

test('PEN-3744: names the inhibited sibling so its silence is not read as a small gap', () => {
  const alert = stuckAlert({ deliveryGap: STALLED_GAP });
  assert.match(alert.annotations.description, /PaperclipApiProductionDeployStalled/);
  assert.match(alert.annotations.description, /INHIBITED by this alert/);
});

test('PEN-3744: machine annotations carry the gap for anyone querying /api/v2/alerts', () => {
  const alert = stuckAlert({ deliveryGap: STALLED_GAP });

  assert.equal(alert.annotations.delivery_gap_commits, '612');
  assert.equal(alert.annotations.delivery_gap_days, '12.5');
  assert.equal(alert.annotations.deployed_commit, STALLED_GAP.deployedSha);
  assert.equal(alert.annotations.last_deploy_at, '2026-09-21T16:38:56Z');
  assert.equal(alert.annotations.delivery_gap_unavailable, undefined);
});

test('PEN-3744: with NO gap the SUMMARY and LEAD are byte-identical to the pre-change wording', () => {
  // The enrichment must degrade to today's behaviour, never to silence and
  // never to a confusing half-sentence: an unmeasured gap is a GitHub blip on
  // the one path that reaches a human.
  //
  // Scoped deliberately to the summary and the LEAD PARAGRAPH, which are the
  // two things the Slack relay forwards. The description as a whole is NOT
  // byte-identical — it gains a paragraph explaining that neither surface is
  // reporting the gap — and the looser `startsWith` this used to assert let
  // exactly that change through unnoticed (Ally review of #2225).
  const alert = stuckAlert();

  assert.equal(
    alert.annotations.summary,
    'Blockcast/paperclip production deploy has been awaiting human approval for 10.0h — ' +
      'the daily dispatcher is a no-op until it clears',
  );
  assert.equal(
    slackLead(alert.annotations.description),
    'A docker.yml deploy has been parked on the paperclip-production reviewer gate since ' +
      '2026-09-01T02:00:00.000Z (10.0h; threshold 6h).',
  );
  assert.equal(alert.annotations.delivery_gap_commits, undefined);
});

test('PEN-3744: with no gap the alert does not claim to be carrying one', () => {
  // The inhibition paragraph used to assert "this is the only notification
  // carrying that figure" unconditionally — including on the branch whose own
  // lead says the gap could not be measured. Two paragraphs apart, flatly
  // contradictory (Ally review of #2225).
  const withGap = stuckAlert({ deliveryGap: STALLED_GAP }).annotations.description;
  const without = stuckAlert({ deliveryGapReason: 'lookup failed: 503 upstream' }).annotations
    .description;

  assert.match(withGap, /this is the only notification carrying that figure/);
  assert.doesNotMatch(without, /is the only notification carrying that figure/);
  assert.match(without, /would carry that figure/);
  // The warning itself must survive — it matters MORE when nothing is
  // reporting the gap, not less.
  assert.match(without, /NO surface is currently reporting the gap/);
  assert.match(without, /Do not read either silence as the gap being small/);
});

test('PEN-3744: a FAILED lookup is reported on the alert, not silently absent', () => {
  // "the gap is small" and "the gap was never measured" must not look the same
  // to the next reader.
  const alert = stuckAlert({ deliveryGapReason: 'lookup failed: 503 upstream' });

  assert.equal(alert.annotations.delivery_gap_unavailable, 'lookup failed: 503 upstream');
  assert.match(slackLead(alert.annotations.description), /could not be measured \(lookup failed/);
  assert.ok(slackLead(alert.annotations.description).length <= DESC_LEAD_MAX);
});

test('PEN-3744: an unbounded failure reason cannot blow the 400-char Slack lead', () => {
  const alert = stuckAlert({ deliveryGapReason: `lookup failed: ${'x'.repeat(4000)}` });
  assert.ok(slackLead(alert.annotations.description).length <= DESC_LEAD_MAX);
});

test('PEN-3744: an unparseable deploy timestamp still delivers the commit count', () => {
  const alert = stuckAlert({ deliveryGap: { ...STALLED_GAP, days: null } });

  assert.match(alert.annotations.summary, /612 commits behind master/);
  assert.equal(alert.annotations.delivery_gap_days, undefined);
  assert.equal(alert.annotations.delivery_gap_commits, '612');
});

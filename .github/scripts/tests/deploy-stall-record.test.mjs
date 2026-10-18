// PEN-3315. Two properties, both invisible until the moment they are needed:
//
// 1. DURABILITY. ProductionDeployApprovalStuck has a 3h TTL, so three hours
//    after the last push the escalation leaves no trace anywhere. PEN-3289 tried
//    to audit the 41.2h stall of 2026-09-14 after it cleared and got 0 hits from
//    a positive-controlled Alertmanager query. The record is what makes the
//    escalation reviewable after the fact — where a record can exist. (Until
//    2026-10-05 this read as true here. On THIS repository there is none:
//    `has_issues` is false, so `POST /issues` is a hard 410 — see
//    deploy-stall-chain.mjs.)
//
// 2. THE STALL CLOCK. supersede-stale-deploy cancels a stale pending run and
//    dispatches a fresh one, whose createdAt is NOW. Ageing the escalation off
//    the run alone would turn one 41h stall into a train of 6.0h ones that flap
//    firing/resolved on the threshold. resolveStallStartedAt is what stops the
//    supersede from resetting the reported age, and it can only ever move the
//    basis EARLIER — a lost or unreadable record degrades to the previous
//    behaviour rather than masking a stall. On THIS repository both
//    record-derived sources are permanently null, so the property is pinned by
//    deploy-stall-chain.test.mjs (the supersede-chain source), not here; this
//    suite pins how the record-derived sources resolve where Issues are enabled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFILLING_OUTCOMES,
  STALL_ISSUE_TITLE,
  STALL_LABEL,
  STALL_UNREFILLED_LABEL,
  createGitHubClient,
  isUnrefilled,
  laneRefilled,
  parseStallMarker,
  recordStallStartedAt,
  renderStallMarker,
  renderSupersedeFailedComment,
  resolveStallStartedAt,
} from '../deploy-stall-record.mjs';

const STALL_START = '2026-09-14T19:55:57.000Z';

test('the stall marker round-trips through a rendered issue body', () => {
  const body = `${renderStallMarker({ stallStartedAt: STALL_START })}\n\nprose that a human edits`;
  assert.deepEqual(parseStallMarker(body), { stallStartedAt: STALL_START });
});

test('an absent, malformed, mis-versioned or unparseable marker reads as null, never as a date', () => {
  // Every one of these means "we cannot trust this value". Returning a bogus
  // date would be worse than returning none: resolveStallStartedAt takes the
  // MINIMUM, so a garbage-but-parseable value could pin the stall start to the
  // epoch and make every future slot report a decades-old stall.
  assert.equal(parseStallMarker(undefined), null);
  assert.equal(parseStallMarker('no marker here'), null);
  assert.equal(parseStallMarker('<!-- production-deploy-stall:{not json} -->'), null);
  assert.equal(
    parseStallMarker('<!-- production-deploy-stall:{"version":99,"stallStartedAt":"2026-01-01"} -->'),
    null,
  );
  assert.equal(
    parseStallMarker('<!-- production-deploy-stall:{"version":1,"stallStartedAt":"soon"} -->'),
    null,
  );
});

test('resolveStallStartedAt: the recorded start survives a supersede', () => {
  // The whole point, where a record exists. The pending run is 20 minutes old
  // because we replaced it; the stall is 18 hours old. Reporting 0.3h here is
  // how a 41h outage would have read as healthy. On THIS repository
  // `source === 'record-marker'` is unreachable (`has_issues` is false); the
  // same incident is pinned through the chain source in deploy-stall-chain.test.mjs.
  const { stallStartedAt, source } = resolveStallStartedAt({
    marker: { stallStartedAt: '2026-09-15T00:00:00.000Z' },
    issueCreatedAt: '2026-09-15T06:00:00.000Z',
    oldestWaitingCreatedAt: '2026-09-15T17:40:00.000Z',
    alertAfterHours: 6,
  });

  assert.equal(stallStartedAt, '2026-09-15T00:00:00.000Z');
  assert.equal(source, 'record-marker');
});

test('resolveStallStartedAt: a run older than the record still wins', () => {
  // The minimum, not the marker. A stale record left open by a failed close must
  // not be able to move the clock FORWARD and shorten a real stall.
  const { stallStartedAt, source } = resolveStallStartedAt({
    marker: { stallStartedAt: '2026-09-15T12:00:00.000Z' },
    oldestWaitingCreatedAt: '2026-09-15T03:00:00.000Z',
    alertAfterHours: 6,
  });

  assert.equal(stallStartedAt, '2026-09-15T03:00:00.000Z');
  assert.equal(source, 'oldest-waiting-run');
});

test('resolveStallStartedAt: without a marker, the record creation time is a BOUNDED understatement', () => {
  // The record is opened at the first escalation, which by construction happens
  // at or after the threshold — so `created_at - threshold` is an upper bound on
  // the true start. It understates the age by at most the threshold and can
  // never report zero, which is the only failure mode that matters here.
  const { stallStartedAt, source } = resolveStallStartedAt({
    marker: null,
    issueCreatedAt: '2026-09-15T06:00:00.000Z',
    oldestWaitingCreatedAt: '2026-09-15T17:40:00.000Z',
    alertAfterHours: 6,
  });

  assert.equal(stallStartedAt, '2026-09-15T00:00:00.000Z');
  assert.equal(source, 'record-created-at');
});

test('resolveStallStartedAt: no record at all falls back to the run, which is the first escalation', () => {
  const { stallStartedAt, source } = resolveStallStartedAt({
    marker: null,
    issueCreatedAt: undefined,
    oldestWaitingCreatedAt: STALL_START,
    alertAfterHours: 6,
  });

  assert.equal(stallStartedAt, STALL_START);
  assert.equal(source, 'oldest-waiting-run');
});

test('resolveStallStartedAt: nothing readable yields null rather than a fabricated instant', () => {
  const resolved = resolveStallStartedAt({
    marker: null,
    issueCreatedAt: 'nonsense',
    oldestWaitingCreatedAt: undefined,
    alertAfterHours: 6,
  });
  assert.equal(resolved.stallStartedAt, null);
  assert.equal(resolved.source, 'none');
});

const stubClient = (handler) =>
  createGitHubClient({
    token: 'test-token',
    repo: 'Blockcast/paperclip',
    apiUrl: 'https://api.github.com',
    fetchImpl: async (url, init) => handler(url, init),
  });

const ok = (payload) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(payload),
});

test('findOpenStallIssue: deduplicates on the LABEL, not on a title search', () => {
  // The search API is eventually consistent, so a title query can miss an issue
  // opened minutes earlier and file a fresh duplicate on every hourly slot. A
  // label filter reads the issues list directly and is exact.
  let seen = null;
  const client = stubClient((url) => {
    seen = url;
    return ok([{ number: 7, created_at: '2026-09-15T00:00:00Z', body: 'x' }]);
  });

  return client.findOpenStallIssue().then((issue) => {
    assert.equal(issue.number, 7);
    assert.match(seen, /\/repos\/Blockcast\/paperclip\/issues\?/);
    assert.match(seen, /state=open/);
    assert.match(seen, new RegExp(`labels=${encodeURIComponent(STALL_LABEL)}`));
  });
});

test('findOpenStallIssue: ignores pull requests and prefers the oldest issue', () => {
  // `/issues` returns PRs too, and a PR could carry the label. Commenting the
  // escalation onto a pull request would put the stall record somewhere nobody
  // is looking and leave the real stall unrecorded. Oldest-wins makes a race
  // that opened two records converge on one rather than alternating.
  const client = stubClient(() =>
    ok([
      { number: 90, created_at: '2026-09-14T00:00:00Z', pull_request: { url: 'x' } },
      { number: 91, created_at: '2026-09-16T00:00:00Z' },
      { number: 92, created_at: '2026-09-15T00:00:00Z' },
    ]),
  );

  return client.findOpenStallIssue().then((issue) => assert.equal(issue.number, 92));
});

test('findOpenStallIssue: no open record is a legitimate answer, not an error', () => {
  const client = stubClient(() => ok([]));
  return client.findOpenStallIssue().then((issue) => assert.equal(issue, null));
});

test('ensureLabel: a 422 means the label already exists and must not fail the escalation', () => {
  const client = stubClient(() => ({
    ok: false,
    status: 422,
    text: async () => '{"message":"Validation Failed"}',
  }));
  return client.ensureLabel();
});

test('ensureLabel: any other failure still propagates', async () => {
  const client = stubClient(() => ({
    ok: false,
    status: 403,
    text: async () => '{"message":"Resource not accessible by integration"}',
  }));
  await assert.rejects(() => client.ensureLabel(), /403/);
});

test('createStallIssue: carries the dedupe label, or the next slot files a duplicate', () => {
  let body = null;
  const client = stubClient((url, init) => {
    body = JSON.parse(init.body);
    return ok({ number: 5, html_url: 'https://github.com/Blockcast/paperclip/issues/5' });
  });

  return client.createStallIssue('body text').then(() => {
    assert.deepEqual(body.labels, [STALL_LABEL]);
    assert.equal(body.title, STALL_ISSUE_TITLE);
  });
});

// ---------------------------------------------------------------------------
// "A human cleared it" vs "we emptied it and could not refill it".
//
// The supersede's two failure paths (cancel-poll timeout, dispatch-failed-
// after-cancel) both cancel the stale run and then fail to dispatch. The gate
// ends up EMPTY with production still at the stale commit — and the dispatcher
// reports that as `checked-no-pending`, exactly as it would if a human had
// cancelled the run themselves. Without this distinction the record opened to
// make the stall auditable is closed as RESOLVED by the one new way "nothing
// pending" can happen with no human having acted, while the escalation stops
// firing and nothing ships until the daily dispatch slot, up to ~24h later.
test('isUnrefilled: the label is what separates the two, in either label shape', () => {
  assert.equal(isUnrefilled({ labels: [{ name: STALL_UNREFILLED_LABEL }] }), true);
  assert.equal(isUnrefilled({ labels: [STALL_UNREFILLED_LABEL] }), true);
  assert.equal(isUnrefilled({ labels: [{ name: STALL_LABEL }] }), false);
  assert.equal(isUnrefilled({ labels: [] }), false);
  assert.equal(isUnrefilled({}), false);
  assert.equal(isUnrefilled(null), false);
});

test('an unrefilled record does NOT close on checked-no-pending — nothing shipped', () => {
  // This is the whole finding: `checked-no-pending` is precisely the outcome a
  // failed supersede produces, so it must not be the outcome that resolves it.
  assert.equal(REFILLING_OUTCOMES.has('checked-no-pending'), false);
});

test('an unrefilled record DOES close once the lane is actually refilled', () => {
  // `dispatched` means a replacement is on the gate; `up-to-date` means
  // production already carries master. Either way nothing is owed, so the record
  // must not be left open forever — the daily dispatch slot is the bounded exit.
  assert.equal(REFILLING_OUTCOMES.has('dispatched'), true);
  assert.equal(REFILLING_OUTCOMES.has('up-to-date'), true);
});

// ---------------------------------------------------------------------------
// PEN-4224. `dispatched` is a PROMISE to refill the lane, not a refill.
//
// The record's whole purpose is to tell "a human cleared the gate" apart from
// "we emptied it and could not refill it". REFILLING_OUTCOMES answers that from
// the dispatcher's OWN DECISION — and on 2026-10-17 that decision was wrong
// about its own consequence: a dispatch was issued, reported `dispatched`, and
// the run it created failed `build-and-push` in 84s with `deploy` skipped. The
// lane was never refilled. Closing an unrefilled record on that writes
// "resolved, nothing is on the reviewer gate" over a stall that is still
// running, arriving through the one outcome the label's own check waves through.
//
// ⛔ THE FIRST FIX FOR THIS DID NOT WORK, and these tests exist in the shape
// they do because of how it failed. It refused to close on an affirmative
// `died-before-deploy` fate — but detect-dead-dispatch.mjs runs ONCE per slot,
// inside guard (1c), ABOVE guard (2) and ABOVE `gh workflow run`. On a
// `dispatched` slot the fate therefore describes the PREVIOUS completed run and
// the dispatch being gated has not started. The guard passed its own test only
// because the test fed it a fate that could not refer to that dispatch. Replay
// the real 2026-10-17 timeline and the 07:31 slot still closed an unrefilled
// record. So the first two tests below are written as that replay: a fate that
// is `survived`, which is what the lane genuinely looked like at 07:31, and
// which the broken guard waved straight through.
//
// ⚠️ Latent, not exercised: on Blockcast/paperclip `has_issues` is false, so no
// record exists for this to have happened to. PEN-4224 found it by reading and
// asked for a test rather than a postmortem. These are that test.
// ---------------------------------------------------------------------------

// The incident, to scale. The record's stall begins between the two dispatches,
// which is the arrangement that makes the healthy predecessor useless as
// evidence for the stall that followed it.
const DISPATCH_BEFORE_STALL = '2026-10-16T07:31:45.000Z';
const PEN_4224_STALL_START = '2026-10-17T05:00:00.000Z';
const DISPATCH_AFTER_STALL = '2026-10-17T07:31:45.000Z';

// Shorthand: the evidence a refill actually requires.
const executed = (at) => ({
  outcome: 'dispatched',
  lastDispatchDeployExecuted: 'true',
  lastDispatchAt: at,
  stallStartedAt: PEN_4224_STALL_START,
});

test('a `dispatched` slot does NOT close an unrefilled record on its own say-so', () => {
  // The done-when, stated against the timeline that defeated the first attempt.
  // At 07:31 the newest COMPLETED dispatch is the healthy 10-16 one — it really
  // did execute its deploy job. It is still not evidence about the dispatch this
  // slot is issuing, because that run does not exist yet.
  assert.equal(REFILLING_OUTCOMES.has('dispatched'), true, 'control: the outcome still refills');
  assert.equal(
    laneRefilled(executed(DISPATCH_BEFORE_STALL)),
    false,
    'a refill that PREDATES the stall is not this stall\'s refill',
  );
  // And a dispatch that died in front of `deploy` never executed one.
  assert.equal(
    laneRefilled({ ...executed(DISPATCH_AFTER_STALL), lastDispatchDeployExecuted: 'false' }),
    false,
  );
});

test('the superseded run that OPENED the record cannot close it', () => {
  // Review finding on this change's first head, and the sharpest case there is.
  // The supersede cancels the waiting run W and fails to dispatch; that is what
  // labels the record unrefilled. W is then the newest COMPLETED dispatch, and
  // the detector's fate for it is `survived` — not because it refilled anything
  // but because a cancellation is not a death the detector may claim.
  //
  // TWO independent guards now exclude W, either alone sufficient:
  //
  //  1. W's deploy job never executed (it was cancelled), so there is no
  //     affirmative evidence. This is the one that does not depend on clocks.
  assert.equal(
    laneRefilled({
      outcome: 'dispatched',
      lastDispatchDeployExecuted: 'false',
      lastDispatchAt: PEN_4224_STALL_START,
      stallStartedAt: PEN_4224_STALL_START,
    }),
    false,
    'a cancelled run executed no deploy, whatever its fate string says',
  );
  //  2. The bound is STRICTLY after the record's creation, and the record is
  //     opened while W is still on the gate. An inclusive bound re-admitted W,
  //     because the marker the first version used is written from the MINIMISED
  //     resolveStallStartedAt, whose candidates include W's own created_at.
  assert.equal(
    laneRefilled(executed(PEN_4224_STALL_START)),
    false,
    'a run created at the stall start is the superseded one, not the refill',
  );
});

test('a LATER slot closes it once a dispatch is observed to have deployed', () => {
  // The exit. The record must not be unclosable: the next slot after a
  // replacement dispatch completes reads it as the newest completed run, and if
  // its deploy job executed the lane really was refilled during this stall.
  assert.equal(laneRefilled(executed(DISPATCH_AFTER_STALL)), true);
  // A boolean `true` is accepted as well as the workflow's string, so a direct
  // caller cannot be silently refused.
  assert.equal(
    laneRefilled({ ...executed(DISPATCH_AFTER_STALL), lastDispatchDeployExecuted: true }),
    true,
  );
});

test('`up-to-date` closes on its own evidence, with no observation required', () => {
  // Guard (2) emits `up-to-date` only when a `deploy` job SUCCEEDED at exactly
  // master's head, so production demonstrably carries the commits. That is a
  // stronger statement than any observation of the previous run, and it is
  // available when that observation is not.
  for (const evidence of ['true', 'false', '', undefined]) {
    assert.equal(
      laneRefilled({ outcome: 'up-to-date', lastDispatchDeployExecuted: evidence }),
      true,
      `up-to-date must close regardless of evidence ${JSON.stringify(evidence)}`,
    );
  }
});

test('absent evidence, time or stall start BLOCKS the close, it does not widen it', () => {
  // Direction of error, and it is deliberately the OPPOSITE of the first fix's.
  // That one asked for the absence of a disproof, which is why silence waved a
  // dispatch through; this asks for proof, so silence withholds. The cost is
  // bounded: `up-to-date` above closes the record outright once production
  // catches up, so a missed close is a record that closes one slot late.
  const base = executed(DISPATCH_AFTER_STALL);
  assert.equal(laneRefilled(base), true, 'control: the complete evidence closes it');
  for (const evidence of ['false', 'TRUE', 'yes', '1', '', undefined, null]) {
    assert.equal(
      laneRefilled({ ...base, lastDispatchDeployExecuted: evidence }),
      false,
      `evidence ${JSON.stringify(evidence)} is not proof a deploy executed`,
    );
  }
  for (const at of ['', undefined, 'not-a-date']) {
    assert.equal(
      laneRefilled({ ...base, lastDispatchAt: at }),
      false,
      `run time ${JSON.stringify(at)} cannot place the run in this stall`,
    );
  }
  for (const startedAt of [null, '', undefined, 'not-a-date']) {
    assert.equal(
      laneRefilled({ ...base, stallStartedAt: startedAt }),
      false,
      `stall start ${JSON.stringify(startedAt)} cannot place the run in this stall`,
    );
  }
  assert.equal(laneRefilled(), false, 'and no arguments at all is not an accidental close');
});

test('laneRefilled keeps every non-refilling outcome non-refilling', () => {
  // The evidence is an extra way to say YES to `dispatched`, never a new way to
  // say yes to an outcome that already means the gate is empty because WE
  // emptied it.
  for (const outcome of ['checked-no-pending', 'dispatch-died', 'skipped-pending', '']) {
    assert.equal(laneRefilled({ ...executed(DISPATCH_AFTER_STALL), outcome }), false, outcome);
  }
});

test('the stall start is the record\'s own created_at, never the marker', () => {
  // Review finding on this change's first head. The marker LOOKS exact and is
  // not: post-pending-deploy-alert.mjs writes it from resolveStallStartedAt,
  // which MINIMISES over candidates including the waiting run's own created_at.
  // Bounding on it therefore reaches back to before the superseded run and
  // admits that run as evidence of a refill.
  //
  // `created_at` is used raw. The record is opened at the first escalation,
  // which is at or after the true start and strictly after the superseded run
  // was created, so it is a genuine upper bound. (resolveStallStartedAt
  // subtracts alertAfterHours from this same value — the exact widening to
  // avoid here, which is why that function is not reused.)
  const marker = renderStallMarker({ stallStartedAt: '2026-10-17T05:00:00.000Z' });
  assert.equal(
    recordStallStartedAt({ body: `${marker}\n\nprose`, created_at: '2026-10-17T11:00:00.000Z' }),
    '2026-10-17T11:00:00.000Z',
    'the marker must NOT win — it is the minimised value',
  );
  // Positive control: the marker really does parse, so the assertion above is
  // about precedence rather than about an unreadable body.
  assert.deepEqual(parseStallMarker(`${marker}\n\nprose`), {
    stallStartedAt: '2026-10-17T05:00:00.000Z',
  });
  for (const issue of [undefined, {}, { created_at: 'nonsense' }]) {
    assert.equal(recordStallStartedAt(issue), null, 'unreadable is null, which blocks the close');
  }
});

test('`dispatch-died` is classified, and classified as NOT refilling', () => {
  // PEN-4224 adds a fifth dispatcher outcome, and the close step fires on it
  // (it is neither empty nor `skipped-pending`). An outcome that falls through
  // REFILLING_OUTCOMES unclassified would close an unrefilled record silently —
  // the seam scheduled-production-deploy-schedule.test.mjs guards generically,
  // pinned here for the specific value.
  assert.equal(REFILLING_OUTCOMES.has('dispatch-died'), false);
});

test('the supersede-failure comment states that production did NOT ship', () => {
  // The record is read by a human after the fact, and the danger is that it
  // reads as prompt recovery. Say the two things that are actually true.
  const body = renderSupersedeFailedComment({
    reason: 'dispatch-failed-after-cancel',
    detail: 'Run 34889856627 was cancelled, but dispatching docker.yml failed: 500',
    runUrl: 'https://github.com/Blockcast/paperclip/actions/runs/1',
  });
  assert.match(body, /still at the stale commit/i);
  assert.match(body, /stays OPEN/);
  assert.match(body, /24h/);
  assert.match(body, /dispatch-failed-after-cancel/);
});

// The marker regex reads a JSON object out of an HTML comment. The lazy
// quantifier is load-bearing in the direction that is easy to get backwards:
// `[\s\S]*?` BACKTRACKS to satisfy the `-->` terminator, so it already handles a
// nested object, while a greedy `[\s\S]*` would swallow everything between the
// FIRST marker and the LAST `-->` in a body carrying two of them.
test('parseStallMarker: a future nested-object shape still parses, and the first marker wins', () => {
  const nested = `<!-- production-deploy-stall:${JSON.stringify({
    version: 1,
    stallStartedAt: '2026-09-14T19:58:34.000Z',
    meta: { supersedes: 1 },
  })} -->\nbody`;
  assert.deepEqual(parseStallMarker(nested), { stallStartedAt: '2026-09-14T19:58:34.000Z' });

  const two = [
    renderStallMarker({ stallStartedAt: '2026-09-14T19:58:34.000Z' }),
    'edited body',
    renderStallMarker({ stallStartedAt: '2026-09-16T13:12:14.000Z' }),
  ].join('\n');
  assert.deepEqual(parseStallMarker(two), { stallStartedAt: '2026-09-14T19:58:34.000Z' });
});

test('addLabel: marks the record even when the label already exists', async () => {
  const calls = [];
  const client = stubClient((url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/labels') && !url.includes('/issues/')) {
      return { ok: false, status: 422, text: async () => '{"message":"already_exists"}' };
    }
    return ok([{ name: STALL_UNREFILLED_LABEL }]);
  });

  await client.addLabel(77, STALL_UNREFILLED_LABEL);
  const applied = calls.find((c) => c.url.includes('/issues/77/labels'));
  assert.ok(applied, 'the label must still be applied after the 422');
  assert.deepEqual(applied.body.labels, [STALL_UNREFILLED_LABEL]);
});

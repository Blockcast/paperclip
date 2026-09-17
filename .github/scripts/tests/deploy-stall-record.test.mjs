// PEN-3315. Two properties, both invisible until the moment they are needed:
//
// 1. DURABILITY. ProductionDeployApprovalStuck has a 3h TTL, so three hours
//    after the last push the escalation leaves no trace anywhere. PEN-3289 tried
//    to audit the 41.2h stall of 2026-09-14 after it cleared and got 0 hits from
//    a positive-controlled Alertmanager query. The record is what makes the
//    escalation reviewable after the fact.
//
// 2. THE STALL CLOCK. supersede-stale-deploy cancels a stale pending run and
//    dispatches a fresh one, whose createdAt is NOW. Ageing the escalation off
//    the run alone would turn one 41h stall into a train of 6.0h ones that flap
//    firing/resolved on the threshold. resolveStallStartedAt is what stops the
//    supersede from resetting the reported age, and it can only ever move the
//    basis EARLIER — a lost or unreadable record degrades to the previous
//    behaviour rather than masking a stall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFILLING_OUTCOMES,
  STALL_ISSUE_TITLE,
  STALL_LABEL,
  STALL_UNREFILLED_LABEL,
  createGitHubClient,
  isUnrefilled,
  parseStallMarker,
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
  // The whole point. The pending run is 20 minutes old because we replaced it;
  // the stall is 18 hours old. Reporting 0.3h here is how a 41h outage would
  // have read as healthy.
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

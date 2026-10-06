import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RATE_LIMIT_MIN_WAIT_MS,
  RATE_LIMIT_NOT_EVALUATED,
  RATE_LIMIT_RETRY_BUDGET_MS,
  TRANSIENT_UPSTREAM_NOT_EVALUATED,
  exitFatal,
  ghFetch,
  isTransientUpstreamFailure,
  rateLimitWaitMs,
  resolveInstallationId,
} from '../get-bot-token.mjs';

// ── ghFetch rate-limit retry (BLO-37010) ─────────────────────────────────────
//
// A 403/429 rate-limit response used to throw on the first call and become
// check conclusion `failure` — indistinguishable from a genuine quality or
// security finding on a check that is a merge STOP.

function response(status, { headers = {}, body = '{}' } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), text: async () => body };
}

// Installs a scripted global fetch and a sleep recorder. Returns both logs so a
// test can assert the attempt count AND the waits, which is what distinguishes
// "retried" from "retried for the right duration".
function harness(responses) {
  const original = globalThis.fetch;
  const calls = [];
  const slept = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    if (!responses.length) throw new Error(`unexpected fetch #${calls.length}: ${url}`);
    return responses.shift();
  };
  return {
    calls,
    slept,
    sleep: async ms => { slept.push(ms); },
    restore: () => { globalThis.fetch = original; },
  };
}

test('ghFetch: retries a GET rate-limited with x-ratelimit-reset, then succeeds', async () => {
  const resetAt = Math.floor((Date.now() + 2_000) / 1000);
  const h = harness([
    response(403, {
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) },
      body: '{"message":"API rate limit exceeded for installation ID 138085375"}',
    }),
    response(200, { body: '{"id":42}' }),
  ]);
  try {
    assert.deepEqual(await ghFetch('/repos/o/r/pulls/1', 'tok', { sleep: h.sleep }), { id: 42 });
    assert.equal(h.calls.length, 2, 'expected exactly one retry');
    assert.ok(h.slept[0] > 0 && h.slept[0] <= 2_000, `honoured x-ratelimit-reset, slept ${h.slept[0]}ms`);
  } finally {
    h.restore();
  }
});

test('ghFetch: retries a HEADERLESS 429 — the budget must fund the 60s floor (BLO-28906)', async () => {
  const h = harness([
    response(429, { body: '{"message":"You have exceeded a secondary rate limit"}' }),
    response(200, { body: '{"ok":true}' }),
  ]);
  try {
    assert.deepEqual(await ghFetch('/repos/o/r/pulls/1', 'tok', { sleep: h.sleep }), { ok: true });
    assert.equal(h.calls.length, 2, 'expected exactly one retry');
    assert.deepEqual(h.slept, [RATE_LIMIT_MIN_WAIT_MS]);
  } finally {
    h.restore();
  }
});

test('RATE_LIMIT_RETRY_BUDGET_MS funds at least one headerless retry', () => {
  // The deadline is checked BEFORE sleeping, so n retries need > n x the floor.
  // 45s — review-gate-action's default — funds zero and is inert (BLO-28906).
  assert.ok(
    RATE_LIMIT_RETRY_BUDGET_MS > RATE_LIMIT_MIN_WAIT_MS,
    `${RATE_LIMIT_RETRY_BUDGET_MS}ms funds zero retries of a ${RATE_LIMIT_MIN_WAIT_MS}ms wait`
  );
});

test('ghFetch: a budget below the 60s floor funds zero retries and says the diff was not evaluated', async () => {
  const h = harness([response(429, { body: '{"message":"You have exceeded a secondary rate limit"}' })]);
  try {
    await assert.rejects(
      ghFetch('/repos/o/r/pulls/1', 'tok', { sleep: h.sleep, retryBudgetMs: 45_000 }),
      err => {
        assert.ok(err.rateLimited, 'error must be flagged rateLimited');
        assert.match(err.message, new RegExp(RATE_LIMIT_NOT_EVALUATED));
        return true;
      }
    );
    assert.equal(h.calls.length, 1, 'must not retry when the wait exceeds the budget');
    assert.deepEqual(h.slept, [], 'must not sleep past the deadline');
  } finally {
    h.restore();
  }
});

test('ghFetch: does NOT retry a plain 403 permission denial, and does not mark it not-evaluated', async () => {
  const h = harness([response(403, { body: '{"message":"Resource not accessible by integration"}' })]);
  try {
    await assert.rejects(
      ghFetch('/repos/o/r/pulls/1', 'tok', { sleep: h.sleep }),
      err => {
        assert.equal(err.rateLimited, undefined, 'a permission denial is not a rate limit');
        assert.match(err.message, /→ 403/);
        return true;
      }
    );
    assert.equal(h.calls.length, 1);
  } finally {
    h.restore();
  }
});

test('ghFetch: does NOT retry a write, on a 5xx or a rate limit (BLO-19827: no idempotency key)', async () => {
  for (const res of [
    response(502, { body: 'bad gateway' }),
    response(429, { headers: { 'retry-after': '1' }, body: '{"message":"rate limit"}' }),
  ]) {
    const h = harness([res]);
    try {
      await assert.rejects(ghFetch('/repos/o/r/check-runs', 'tok', { method: 'POST', sleep: h.sleep }));
      assert.equal(h.calls.length, 1, `POST ${res.status} must be attempted exactly once`);
      assert.deepEqual(h.slept, []);
    } finally {
      h.restore();
    }
  }
});

test('rateLimitWaitMs: a reset at or behind our clock waits the floor, never zero', () => {
  const now = 1_700_000_000_000;
  for (const resetMs of [now - 5_000, now]) {
    const headers = new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetMs / 1000) });
    assert.equal(rateLimitWaitMs(headers, now), RATE_LIMIT_MIN_WAIT_MS, `reset ${resetMs - now}ms from now`);
  }
});

test('ghFetch: an abort during a rate-limit wait ends the wait at once', { timeout: 5_000 }, async () => {
  const h = harness([response(429, { body: '{"message":"You have exceeded a secondary rate limit"}' })]);
  const controller = new AbortController();
  const reason = new Error('advisory budget expired');
  setTimeout(() => controller.abort(reason), 20);
  const startedAt = Date.now();
  // Settles only on abort, as node:timers/promises does for a pending delay. If
  // ghFetch drops the signal this never settles and the test times out.
  const sleep = (ms, _value, { signal } = {}) => new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  try {
    await assert.rejects(ghFetch('/repos/o/r/pulls/1', 'tok', { signal: controller.signal, sleep }), err => {
      assert.equal(err, reason);
      return true;
    });
    assert.ok(Date.now() - startedAt < 1_000, `waited ${Date.now() - startedAt}ms after the abort`);
    assert.equal(h.calls.length, 1, 'an aborted wait must not re-request');
  } finally {
    h.restore();
  }
});

test('exitFatal: a genuine failure still exits 1 and is NOT labelled not-evaluated', () => {
  const lines = [];
  const error = console.error;
  console.error = msg => lines.push(String(msg));
  let code;
  try {
    exitFatal(new Error('Missing test coverage for server/src/foo.ts'), 'quality gates', c => { code = c; });
  } finally {
    console.error = error;
  }
  assert.equal(code, 1);
  assert.ok(!lines.some(l => l.includes('DID NOT EVALUATE')), 'a real finding must not be excused as a rate limit');
});

test('exitFatal: a rate-limit exhaustion exits 1 AND says the gate never ran', () => {
  const lines = [];
  const error = console.error;
  console.error = msg => lines.push(String(msg));
  let code;
  const err = new Error(`${RATE_LIMIT_NOT_EVALUATED}: ...`);
  err.rateLimited = true;
  try {
    exitFatal(err, 'quality gates', c => { code = c; });
  } finally {
    console.error = error;
  }
  assert.equal(code, 1, 'still a red check — it just is not a verdict on the code');
  assert.ok(lines.some(l => l.includes('DID NOT EVALUATE THE DIFF')), lines.join('\n'));
});

test('exitFatal: a rate-limit exhaustion marks the step output not_evaluated; a finding does not', () => {
  // The workflow's follow-up step reads this to say "did not run" instead of
  // "gates failed" -- no commitperclip comment exists for a run that never ran.
  const dir = mkdtempSync(join(tmpdir(), 'exitfatal-'));
  const out = join(dir, 'github_output');
  writeFileSync(out, '');
  const error = console.error;
  console.error = () => {};
  try {
    exitFatal(new Error('Missing test coverage for server/src/foo.ts'), 'quality gates', () => {}, out);
    assert.equal(readFileSync(out, 'utf8'), '', 'a real finding must not be marked not-evaluated');
    const err = new Error(`${RATE_LIMIT_NOT_EVALUATED}: ...`);
    err.rateLimited = true;
    exitFatal(err, 'quality gates', () => {}, out);
  } finally {
    console.error = error;
  }
  assert.equal(readFileSync(out, 'utf8'), 'not_evaluated=true\n');
  rmSync(dir, { recursive: true, force: true });
});

// ── transient upstream 5xx (PEN-3760) ────────────────────────────────────────
//
// A 504 on the first read of run-quality-gates.mjs threw a bare Error, so
// exitFatal emitted no marker and the workflow's else-branch announced "One or
// more quality gates failed. See commitperclip comment on the PR for details"
// — for a run that computed no verdict and posted no comment. The 5xx must
// reach exitFatal labelled, exactly as a rate-limit exhaustion does.

test('ghFetch: a GET that 5xxs is labelled not-evaluated, so it cannot read as a finding', async () => {
  for (const status of [500, 502, 503, 504]) {
    const h = harness([response(status, { body: '{"message":"We could not respond in time."}' })]);
    try {
      const err = await ghFetch('/repos/o/r/pulls/1', 'tok', { sleep: h.sleep }).then(
        () => { throw new Error(`${status} must not resolve`); },
        e => e,
      );
      assert.ok(
        err.notEvaluated?.includes(TRANSIENT_UPSTREAM_NOT_EVALUATED),
        `${status} must carry the not-evaluated marker, got ${JSON.stringify(err.notEvaluated)}`,
      );
      assert.match(err.message, new RegExp(`→ ${status}:`), 'the raw status stays in the message');
      assert.equal(h.calls.length, 1, 'classification only — this must not add a retry');
    } finally {
      h.restore();
    }
  }
});

test('ghFetch: a non-GET 5xx is NOT relabelled — a failed write can follow a real verdict', async () => {
  const h = harness([response(503, { body: '{"message":"unavailable"}' })]);
  try {
    const err = await ghFetch('/repos/o/r/issues/1/comments', 'tok', {
      method: 'POST', body: '{}', sleep: h.sleep,
    }).then(() => { throw new Error('must not resolve'); }, e => e);
    assert.equal(err.notEvaluated, undefined, 'the write path must keep its existing meaning');
    assert.equal(h.calls.length, 1, 'writes are never retried (BLO-19827)');
  } finally {
    h.restore();
  }
});

test('ghFetch: a 4xx that is not a rate limit stays a hard failure, not "did not evaluate"', async () => {
  // The boundary that keeps the fix from excusing real errors: a 404 or a
  // plain 403 permission denial is a definite answer, and must stay one.
  for (const status of [403, 404, 422]) {
    const h = harness([response(status, { body: '{"message":"Not Found"}' })]);
    try {
      const err = await ghFetch('/repos/o/r/pulls/1', 'tok', { sleep: h.sleep }).then(
        () => { throw new Error(`${status} must not resolve`); },
        e => e,
      );
      assert.equal(err.notEvaluated, undefined, `${status} is an answer, not an outage`);
      assert.equal(err.rateLimited, undefined);
    } finally {
      h.restore();
    }
  }
});

test('isTransientUpstreamFailure: 5xx only', () => {
  assert.equal(isTransientUpstreamFailure(500), true);
  assert.equal(isTransientUpstreamFailure(504), true);
  assert.equal(isTransientUpstreamFailure(599), true);
  assert.equal(isTransientUpstreamFailure(499), false);
  assert.equal(isTransientUpstreamFailure(429), false);
  assert.equal(isTransientUpstreamFailure(403), false);
  assert.equal(isTransientUpstreamFailure(200), false);
});

test('exitFatal: a 5xx-marked error writes not_evaluated=true and annotates', () => {
  // End to end on the real contract: this output is the ONLY thing standing
  // between a transient 5xx and the workflow asserting a verdict.
  const dir = mkdtempSync(join(tmpdir(), 'exitfatal-5xx-'));
  const out = join(dir, 'github_output');
  writeFileSync(out, '');
  const lines = [];
  const error = console.error;
  console.error = msg => lines.push(String(msg));
  let code;
  const err = new Error('GitHub API GET /repos/o/r/pulls/1 → 504: ...');
  err.notEvaluated = `${TRANSIENT_UPSTREAM_NOT_EVALUATED}: GitHub returned 504 ...`;
  try {
    exitFatal(err, 'quality gates', c => { code = c; }, out);
  } finally {
    console.error = error;
  }
  assert.equal(code, 1, 'still red — it just is not a verdict on the code');
  assert.equal(readFileSync(out, 'utf8'), 'not_evaluated=true\n');
  assert.ok(lines.some(l => l.includes('DID NOT EVALUATE THE DIFF')), lines.join('\n'));
  rmSync(dir, { recursive: true, force: true });
});

// ── installation resolution ──────────────────────────────────────────────────

test('resolveInstallationId: uses the repo installation endpoint when repo context is available', async () => {
  const seenPaths = [];
  const installationId = await resolveInstallationId(async (path) => {
    seenPaths.push(path);
    return { id: 42 };
  }, 'jwt', 'paperclipai/paperclip', 'paperclipai');

  assert.equal(installationId, 42);
  assert.deepEqual(seenPaths, ['/repos/paperclipai/paperclip/installation']);
});

test('resolveInstallationId: falls back to the matching owner installation', async () => {
  const installationId = await resolveInstallationId(async () => ([
    { id: 1, account: { login: 'someone-else' } },
    { id: 7, account: { login: 'PaperclipAI' } },
  ]), 'jwt', undefined, 'paperclipai');

  assert.equal(installationId, 7);
});

test('resolveInstallationId: rejects ambiguous installations without repo or owner context', async () => {
  await assert.rejects(
    resolveInstallationId(async () => ([
      { id: 1, account: { login: 'org-one' } },
      { id: 2, account: { login: 'org-two' } },
    ]), 'jwt'),
    /Multiple commitperclip installations found/
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHAIN_WINDOW_MINUTES,
  MAX_CHAIN_LINKS,
  createAncestryProbe,
  deriveStallStartFromSupersedeChain,
  fetchCancelledDispatchRuns,
  normaliseDispatchRun,
} from '../deploy-stall-chain.mjs';
import { resolveStallStartedAt } from '../deploy-stall-record.mjs';

const alwaysAncestor = async () => true;
const neverAncestor = async () => false;
const unknownAncestor = async () => null;

function waitingRun({ id = 900, createdAt, headSha = 'w'.repeat(40) } = {}) {
  return { databaseId: id, createdAt, headSha };
}

function cancelledRun({ id, createdAt, cancelledAt, headSha = 'c'.repeat(40) }) {
  return { databaseId: id, createdAt, cancelledAt, headSha };
}

test('a single supersede carries the clock back to the cancelled run', async () => {
  const chain = await deriveStallStartFromSupersedeChain({
    oldestWaitingRun: waitingRun({ createdAt: '2026-09-18T20:30:21Z' }),
    cancelledRuns: [
      cancelledRun({
        id: 35172796731,
        createdAt: '2026-09-17T02:01:24Z',
        cancelledAt: '2026-09-18T20:30:05Z',
      }),
    ],
    isAncestor: alwaysAncestor,
  });

  assert.equal(chain.stallStartedAt, '2026-09-17T02:01:24.000Z');
  assert.equal(chain.links.length, 1);
  assert.equal(chain.links[0].cancelledRunId, 35172796731);
  assert.equal(chain.links[0].ancestryVerified, true);
});

test('THE REGRESSION: the 2026-09-18 incident ages at ~46h, not 3h', async () => {
  // Replay of the live under-report. The dispatcher reported "3.0h old, under
  // the 6h threshold - skip recorded, not escalating" on a green run while
  // production was 107 commits behind, because PEN-3315's supersede had reset
  // the run clock and the durable record could not be written (410).
  const now = new Date('2026-09-18T23:27:30Z');
  const waiting = waitingRun({ id: 35391811913, createdAt: '2026-09-18T20:30:21Z' });

  const runOnlyAgeHours = (now.getTime() - Date.parse(waiting.createdAt)) / 3_600_000;
  assert.ok(runOnlyAgeHours < 6, `run-only ageing must be under threshold, got ${runOnlyAgeHours}`);

  const chain = await deriveStallStartFromSupersedeChain({
    oldestWaitingRun: waiting,
    cancelledRuns: [
      cancelledRun({
        id: 35172796731,
        createdAt: '2026-09-17T02:01:24Z',
        cancelledAt: '2026-09-18T20:30:05Z',
      }),
    ],
    isAncestor: alwaysAncestor,
  });

  const { stallStartedAt, source } = resolveStallStartedAt({
    marker: null,
    issueCreatedAt: null,
    oldestWaitingCreatedAt: waiting.createdAt,
    chainStallStartedAt: chain.stallStartedAt,
    alertAfterHours: 6,
  });

  assert.equal(source, 'supersede-chain');
  const derivedAgeHours = (now.getTime() - Date.parse(stallStartedAt)) / 3_600_000;
  assert.ok(derivedAgeHours > 45, `expected >45h, got ${derivedAgeHours}`);
  assert.ok(derivedAgeHours >= 6, 'the derived age must clear the escalation threshold');
});

test('multiple supersedes chain back to the ORIGINAL stall start', async () => {
  const chain = await deriveStallStartFromSupersedeChain({
    oldestWaitingRun: waitingRun({ id: 3, createdAt: '2026-09-18T18:00:00Z' }),
    cancelledRuns: [
      cancelledRun({ id: 2, createdAt: '2026-09-18T12:00:00Z', cancelledAt: '2026-09-18T17:59:50Z' }),
      cancelledRun({ id: 1, createdAt: '2026-09-18T06:00:00Z', cancelledAt: '2026-09-18T11:59:50Z' }),
    ],
    isAncestor: alwaysAncestor,
  });

  assert.equal(chain.stallStartedAt, '2026-09-18T06:00:00.000Z');
  assert.equal(chain.links.length, 2);
  assert.deepEqual(
    chain.links.map((l) => l.cancelledRunId),
    [2, 1],
  );
});

test('NEGATIVE: a cancel outside the window is not chained', async () => {
  const chain = await deriveStallStartFromSupersedeChain({
    oldestWaitingRun: waitingRun({ createdAt: '2026-09-18T20:30:00Z' }),
    cancelledRuns: [
      // 40 minutes earlier: the shape of a human cancelling a deploy they chose
      // not to ship, picked up by a LATER hourly dispatcher slot.
      cancelledRun({
        id: 55,
        createdAt: '2026-09-17T02:00:00Z',
        cancelledAt: '2026-09-18T19:50:00Z',
      }),
    ],
    isAncestor: alwaysAncestor,
  });

  assert.equal(chain.stallStartedAt, null);
  assert.equal(chain.links.length, 0);
  assert.equal(chain.stoppedBecause, 'no-supersede-found');
});

test('NEGATIVE: a cancel AFTER the waiting run was created is not chained', async () => {
  const chain = await deriveStallStartFromSupersedeChain({
    oldestWaitingRun: waitingRun({ createdAt: '2026-09-18T20:30:00Z' }),
    cancelledRuns: [
      cancelledRun({
        id: 56,
        createdAt: '2026-09-18T20:00:00Z',
        cancelledAt: '2026-09-18T20:32:00Z',
      }),
    ],
    isAncestor: alwaysAncestor,
  });

  assert.equal(chain.stallStartedAt, null);
  assert.equal(chain.stoppedBecause, 'no-supersede-found');
});

test('NEGATIVE: a replacement that did not move forward is not a supersede', async () => {
  const chain = await deriveStallStartFromSupersedeChain({
    oldestWaitingRun: waitingRun({ createdAt: '2026-09-18T20:30:00Z' }),
    cancelledRuns: [
      cancelledRun({
        id: 57,
        createdAt: '2026-09-17T02:00:00Z',
        cancelledAt: '2026-09-18T20:29:50Z',
      }),
    ],
    isAncestor: neverAncestor,
  });

  assert.equal(chain.stallStartedAt, null);
  assert.equal(chain.stoppedBecause, 'not-a-forward-replace');
});

test('unknown ancestry still chains, and records that it was unverified', async () => {
  // A transient compare failure must not reintroduce the under-report. Chaining
  // on a time-proximate link can only over-state the age.
  const chain = await deriveStallStartFromSupersedeChain({
    oldestWaitingRun: waitingRun({ createdAt: '2026-09-18T20:30:00Z' }),
    cancelledRuns: [
      cancelledRun({
        id: 58,
        createdAt: '2026-09-17T02:00:00Z',
        cancelledAt: '2026-09-18T20:29:50Z',
      }),
    ],
    isAncestor: unknownAncestor,
  });

  assert.equal(chain.stallStartedAt, '2026-09-17T02:00:00.000Z');
  assert.equal(chain.links[0].ancestryVerified, false);
});

test('a throwing ancestry probe is treated as unknown, not fatal', async () => {
  const chain = await deriveStallStartFromSupersedeChain({
    oldestWaitingRun: waitingRun({ createdAt: '2026-09-18T20:30:00Z' }),
    cancelledRuns: [
      cancelledRun({
        id: 59,
        createdAt: '2026-09-17T02:00:00Z',
        cancelledAt: '2026-09-18T20:29:50Z',
      }),
    ],
    isAncestor: async () => {
      throw new Error('compare exploded');
    },
  });

  assert.equal(chain.stallStartedAt, '2026-09-17T02:00:00.000Z');
  assert.equal(chain.links[0].ancestryVerified, false);
});

test('no waiting run yields no clock', async () => {
  const chain = await deriveStallStartFromSupersedeChain({
    oldestWaitingRun: null,
    cancelledRuns: [],
    isAncestor: alwaysAncestor,
  });
  assert.equal(chain.stallStartedAt, null);
  assert.equal(chain.stoppedBecause, 'no-waiting-run');
});

test('an unparseable waiting timestamp yields no clock rather than throwing', async () => {
  const chain = await deriveStallStartFromSupersedeChain({
    oldestWaitingRun: waitingRun({ createdAt: 'not-a-date' }),
    cancelledRuns: [],
    isAncestor: alwaysAncestor,
  });
  assert.equal(chain.stallStartedAt, null);
  assert.equal(chain.stoppedBecause, 'no-waiting-run');
});

test('cancelled runs with unparseable timestamps are skipped, not fatal', async () => {
  const chain = await deriveStallStartFromSupersedeChain({
    oldestWaitingRun: waitingRun({ createdAt: '2026-09-18T20:30:00Z' }),
    cancelledRuns: [
      cancelledRun({ id: 60, createdAt: 'nope', cancelledAt: '2026-09-18T20:29:50Z' }),
      cancelledRun({ id: 61, createdAt: '2026-09-18T20:00:00Z', cancelledAt: 'also-nope' }),
    ],
    isAncestor: alwaysAncestor,
  });
  assert.equal(chain.stallStartedAt, null);
});

test('the walk is bounded by MAX_CHAIN_LINKS', async () => {
  // A contiguous 40-link chain, each cancelled 10s before the next was created.
  const runs = [];
  let cursor = Date.parse('2026-09-01T00:00:00Z');
  for (let i = 0; i < 40; i += 1) {
    const createdAt = new Date(cursor).toISOString();
    cursor += 6 * 3_600_000;
    runs.push(
      cancelledRun({ id: i, createdAt, cancelledAt: new Date(cursor - 10_000).toISOString() }),
    );
  }
  const chain = await deriveStallStartFromSupersedeChain({
    oldestWaitingRun: waitingRun({ createdAt: new Date(cursor).toISOString() }),
    cancelledRuns: runs,
    isAncestor: alwaysAncestor,
  });

  assert.equal(chain.links.length, MAX_CHAIN_LINKS);
  assert.equal(chain.stoppedBecause, 'max-links');
});

test('the closest cancel in the window is chosen, and no run is consumed twice', async () => {
  const chain = await deriveStallStartFromSupersedeChain({
    oldestWaitingRun: waitingRun({ id: 9, createdAt: '2026-09-18T20:30:00Z' }),
    cancelledRuns: [
      cancelledRun({ id: 7, createdAt: '2026-09-18T14:00:00Z', cancelledAt: '2026-09-18T20:28:00Z' }),
      cancelledRun({ id: 8, createdAt: '2026-09-18T16:00:00Z', cancelledAt: '2026-09-18T20:29:55Z' }),
    ],
    isAncestor: alwaysAncestor,
  });

  // 8 is closest to the waiting run's creation, so it is the predecessor; 7 is
  // then chained from 8 only if it also falls in 8's window - it does not
  // (20:28:00 is 6.5h before 16:00 is impossible), so the chain stops at 8.
  assert.equal(chain.links[0].cancelledRunId, 8);
  assert.equal(chain.stallStartedAt, '2026-09-18T16:00:00.000Z');
  assert.equal(chain.links.length, 1);
});

test('CHAIN_WINDOW_MINUTES stays tight enough to exclude an hourly slot', () => {
  // The next scheduled dispatcher slot is up to 60 minutes away. If the window
  // ever reaches that, a deliberate human cancel starts reading as a supersede.
  assert.ok(CHAIN_WINDOW_MINUTES < 30, 'window must stay well under the hourly cadence');
});

test('resolveStallStartedAt prefers the earliest source and never moves the clock later', () => {
  const late = resolveStallStartedAt({
    marker: null,
    issueCreatedAt: null,
    oldestWaitingCreatedAt: '2026-09-18T20:00:00Z',
    // A chain answer LATER than the waiting run must be ignored in favour of the
    // earlier one, so a wrong derivation cannot mask a stall.
    chainStallStartedAt: '2026-09-18T22:00:00Z',
    alertAfterHours: 6,
  });
  assert.equal(late.source, 'oldest-waiting-run');
  assert.equal(late.stallStartedAt, '2026-09-18T20:00:00.000Z');

  const marker = resolveStallStartedAt({
    marker: { stallStartedAt: '2026-09-10T00:00:00Z' },
    issueCreatedAt: null,
    oldestWaitingCreatedAt: '2026-09-18T20:00:00Z',
    chainStallStartedAt: '2026-09-17T02:00:00Z',
    alertAfterHours: 6,
  });
  // Both durable sources present: still the earliest wins, so adding the chain
  // cannot regress a repository where the record DOES work.
  assert.equal(marker.source, 'record-marker');
});

test('resolveStallStartedAt ignores an unparseable chain value', () => {
  const out = resolveStallStartedAt({
    marker: null,
    issueCreatedAt: null,
    oldestWaitingCreatedAt: '2026-09-18T20:00:00Z',
    chainStallStartedAt: 'garbage',
    alertAfterHours: 6,
  });
  assert.equal(out.source, 'oldest-waiting-run');
});

test('normaliseDispatchRun maps updated_at to the cancel instant', () => {
  const run = normaliseDispatchRun({
    id: 42,
    created_at: '2026-09-17T02:01:24Z',
    updated_at: '2026-09-18T20:30:05Z',
    head_sha: 'a'.repeat(40),
    status: 'completed',
    conclusion: 'cancelled',
    html_url: 'https://example.invalid/42',
  });
  assert.equal(run.databaseId, 42);
  assert.equal(run.createdAt, '2026-09-17T02:01:24Z');
  assert.equal(run.cancelledAt, '2026-09-18T20:30:05Z');
  assert.equal(run.conclusion, 'cancelled');
});

test('fetchCancelledDispatchRuns scopes to cancelled workflow_dispatch runs', async () => {
  const seen = [];
  const client = {
    async request(method, path) {
      seen.push(`${method} ${path}`);
      return {
        workflow_runs: [
          {
            id: 1,
            created_at: '2026-09-17T02:01:24Z',
            updated_at: '2026-09-18T20:30:05Z',
            head_sha: 'b'.repeat(40),
            status: 'completed',
            conclusion: 'cancelled',
          },
        ],
      };
    },
  };

  const runs = await fetchCancelledDispatchRuns({ client });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].databaseId, 1);
  assert.equal(seen.length, 1);
  // A cancelled `push` build has nothing to do with the reviewer gate.
  assert.match(seen[0], /event=workflow_dispatch/);
  assert.match(seen[0], /status=cancelled/);
  assert.match(seen[0], /docker\.yml/);
});

test('createAncestryProbe maps compare status, caches, and refuses identical', async () => {
  let calls = 0;
  const client = {
    async request(_method, path) {
      calls += 1;
      if (path.includes('aheadbase')) return { status: 'ahead' };
      if (path.includes('behindbase')) return { status: 'behind' };
      if (path.includes('divergedbase')) return { status: 'diverged' };
      throw new Error('boom');
    },
  };
  const probe = createAncestryProbe({ client });

  assert.equal(await probe('aheadbase', 'head'), true);
  assert.equal(await probe('behindbase', 'head'), false);
  assert.equal(await probe('divergedbase', 'head'), false);
  assert.equal(await probe('explodes', 'head'), null, 'a failed compare is unknown, not false');

  // Same commit re-dispatched is explicitly NOT a supersede, and costs no call.
  const before = calls;
  assert.equal(await probe('same', 'same'), false);
  assert.equal(await probe(null, 'head'), null);
  assert.equal(calls, before, 'short-circuits must not issue a request');

  // Cached.
  const cachedAt = calls;
  assert.equal(await probe('aheadbase', 'head'), true);
  assert.equal(calls, cachedAt, 'repeat probes must be served from cache');
});

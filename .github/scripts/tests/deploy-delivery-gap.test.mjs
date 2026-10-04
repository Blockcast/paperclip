import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DEPLOY_SCAN_LIMIT,
  DEPLOY_SCAN_PAGE_SIZE,
  findLastSuccessfulDeploy,
  formatDeliveryGap,
  gapDays,
  measureDeliveryGap,
  resolveDeliveryGap,
} from '../deploy-delivery-gap.mjs';

const NOW = new Date('2026-10-04T05:17:00.000Z');

/**
 * Minimal GitHub client stand-in. `routes` maps a path PREFIX to either a value
 * or a thrower, and every call is recorded so the tests can assert the scan
 * stops rather than walking the whole page.
 */
function stubClient(routes) {
  const calls = [];
  return {
    calls,
    async request(method, path) {
      calls.push(`${method} ${path}`);
      for (const [prefix, value] of Object.entries(routes)) {
        if (!path.startsWith(prefix)) continue;
        if (typeof value === 'function') return value(path);
        return value;
      }
      throw new Error(`unstubbed ${method} ${path}`);
    },
  };
}

const run = (id, sha, createdAt, updatedAt = createdAt) => ({
  id,
  head_sha: sha,
  created_at: createdAt,
  updated_at: updatedAt,
  html_url: `https://github.com/Blockcast/paperclip/actions/runs/${id}`,
});

const jobs = (...entries) => ({
  jobs: entries.map(([name, conclusion]) => ({ name, conclusion })),
});

test('findLastSuccessfulDeploy: a run that SUCCEEDED with deploy SKIPPED is not a deploy', async () => {
  // The defect this guards: `status=success` is the RUN conclusion, and the
  // pending guard makes a run conclude success with `deploy` never running.
  const client = stubClient({
    '/actions/workflows/docker.yml/runs': {
      workflow_runs: [
        run(3, 'cccc', '2026-09-30T00:00:00Z'),
        run(2, 'bbbb', '2026-09-25T00:00:00Z'),
        run(1, 'aaaa', '2026-09-21T16:10:46Z', '2026-09-21T16:38:56Z'),
      ],
    },
    '/actions/runs/3/jobs': jobs(['guard', 'success'], ['deploy', 'skipped']),
    '/actions/runs/2/jobs': jobs(['guard', 'success']),
    '/actions/runs/1/jobs': jobs(['guard', 'success'], ['deploy', 'success']),
  });

  const last = await findLastSuccessfulDeploy({ client });

  assert.equal(last.databaseId, 1);
  assert.equal(last.headSha, 'aaaa');
  assert.equal(last.landedAt, '2026-09-21T16:38:56Z');
});

test('findLastSuccessfulDeploy: picks the NEWEST shipped run regardless of list order', async () => {
  const client = stubClient({
    '/actions/workflows/docker.yml/runs': {
      // Deliberately oldest-first: the API orders newest-first today but does
      // not promise to, and taking the wrong end overstates the gap silently.
      workflow_runs: [run(1, 'aaaa', '2026-09-21T16:10:46Z'), run(9, 'zzzz', '2026-10-01T00:00:00Z')],
    },
    '/actions/runs/9/jobs': jobs(['deploy', 'success']),
    '/actions/runs/1/jobs': jobs(['deploy', 'success']),
  });

  const last = await findLastSuccessfulDeploy({ client });

  assert.equal(last.headSha, 'zzzz');
  // Stops at the first shipped run; the older one is never read.
  assert.ok(!client.calls.some((c) => c.includes('/actions/runs/1/jobs')));
});

test('findLastSuccessfulDeploy: an all-skipped history returns null, not a guess', async () => {
  const client = stubClient({
    '/actions/workflows/docker.yml/runs': { workflow_runs: [run(3, 'cccc', '2026-09-30T00:00:00Z')] },
    '/actions/runs/3/jobs': jobs(['deploy', 'skipped']),
  });

  assert.equal(await findLastSuccessfulDeploy({ client }), null);
});

/**
 * Page-aware runs stub. `pages` is an array of run arrays, served in order as
 * `page=1`, `page=2`, ...; anything past the end is an empty page. This is the
 * shape the real API has and the flat stub above cannot express.
 */
function pagedRunsRoute(pages) {
  return (path) => {
    const page = Number(new URL(`https://x${path}`).searchParams.get('page') ?? '1');
    return { workflow_runs: pages[page - 1] ?? [] };
  };
}

test('findLastSuccessfulDeploy: a long stall does not consume the scan window (PEN-3744)', async () => {
  // THE REGRESSION THIS DEPTH EXISTS FOR. Every day a stall persists the
  // dispatcher adds one run that concludes `success` with `deploy` SKIPPED, so
  // the skipped runs push the last real deploy further back at ~1/day. At the
  // old 20-run depth a stall past ~20 days returned null and the alert
  // silently degraded to its pre-PEN-3744 wording — exactly when the gap was
  // most worth reporting. 60 days of stall must still find the deploy.
  const skipped = Array.from({ length: 60 }, (_, i) =>
    run(1000 + i, `skip${i}`, `2026-11-${String(30 - (i % 28)).padStart(2, '0')}T00:00:00Z`),
  );
  // Date them strictly newest-first so position, not timestamp luck, is what
  // this test exercises.
  skipped.forEach((r, i) => {
    r.created_at = new Date(Date.parse('2026-12-01T00:00:00Z') - i * 86_400_000).toISOString();
    r.updated_at = r.created_at;
  });
  const real = run(1, 'aaaa', '2026-09-21T16:10:46Z', '2026-09-21T16:38:56Z');

  const client = stubClient({
    '/actions/workflows/docker.yml/runs': pagedRunsRoute([[...skipped, real]]),
    '/actions/runs/': (path) =>
      path.includes('/actions/runs/1/jobs')
        ? jobs(['guard', 'success'], ['deploy', 'success'])
        : jobs(['guard', 'success'], ['deploy', 'skipped']),
  });

  const last = await findLastSuccessfulDeploy({ client });

  assert.equal(last.headSha, 'aaaa');
  assert.equal(last.landedAt, '2026-09-21T16:38:56Z');
  // And it is genuinely past the depth this used to stop at.
  assert.ok(60 > 20, 'the stall must exceed the retired 20-run window for this to prove anything');
});

test('findLastSuccessfulDeploy: pages at per_page=100 rather than asking for an impossible page', async () => {
  // GitHub CLAMPS per_page to 100 instead of rejecting it, so a depth beyond
  // 100 expressed as a single per_page looks configured and is not.
  const full = Array.from({ length: 100 }, (_, i) =>
    run(200 + i, `s${i}`, new Date(Date.parse('2026-12-01T00:00:00Z') - i * 3_600_000).toISOString()),
  );
  const real = run(1, 'aaaa', '2026-09-21T16:10:46Z', '2026-09-21T16:38:56Z');

  const client = stubClient({
    '/actions/workflows/docker.yml/runs': pagedRunsRoute([full, [real]]),
    '/actions/runs/': (path) =>
      path.includes('/actions/runs/1/jobs')
        ? jobs(['deploy', 'success'])
        : jobs(['deploy', 'skipped']),
  });

  const last = await findLastSuccessfulDeploy({ client });

  assert.equal(last.headSha, 'aaaa');
  const listCalls = client.calls.filter((c) => c.includes('/runs?'));
  assert.ok(listCalls.every((c) => /per_page=(100|\d{1,2})\b/.test(c)), listCalls.join('\n'));
  assert.ok(listCalls.some((c) => c.includes('page=1')));
  assert.ok(
    listCalls.some((c) => c.includes('page=2')),
    'a full first page must be followed by a second',
  );
});

test('findLastSuccessfulDeploy: a short page ends the scan, so a healthy lane pays one list call', async () => {
  // Cost must scale with the stall, not with the depth ceiling.
  const client = stubClient({
    '/actions/workflows/docker.yml/runs': pagedRunsRoute([
      [run(1, 'aaaa', '2026-09-21T16:10:46Z', '2026-09-21T16:38:56Z')],
    ]),
    '/actions/runs/1/jobs': jobs(['deploy', 'success']),
  });

  await findLastSuccessfulDeploy({ client });

  assert.equal(client.calls.filter((c) => c.includes('/runs?')).length, 1);
});

test('findLastSuccessfulDeploy: never requests more runs than the scan limit', async () => {
  const page = Array.from({ length: 100 }, (_, i) =>
    run(300 + i, `s${i}`, new Date(Date.parse('2026-12-01T00:00:00Z') - i * 3_600_000).toISOString()),
  );
  const client = stubClient({
    '/actions/workflows/docker.yml/runs': pagedRunsRoute([page, page, page, page]),
    '/actions/runs/': jobs(['deploy', 'skipped']),
  });

  assert.equal(await findLastSuccessfulDeploy({ client, scanLimit: 150 }), null);

  const requested = client.calls
    .filter((c) => c.includes('/runs?'))
    .map((c) => Number(new URL(`https://x${c.split(' ')[1]}`).searchParams.get('per_page')));
  assert.equal(
    requested.reduce((a, b) => a + b, 0),
    150,
    'the final page must be narrowed so the scan cannot overshoot its limit',
  );
});

test('findLastSuccessfulDeploy: the newest-first sort spans pages, not just within one', async () => {
  // A per-page sort would still trust the API to have PAGED in order. Here the
  // newest shipped run is on page 2, behind an older shipped run on page 1.
  const older = run(1, 'old', '2026-09-01T00:00:00Z');
  const filler = Array.from({ length: 99 }, (_, i) =>
    run(500 + i, `f${i}`, new Date(Date.parse('2026-09-02T00:00:00Z') + i * 3_600_000).toISOString()),
  );
  const newest = run(9, 'zzzz', '2026-10-01T00:00:00Z', '2026-10-01T00:05:00Z');

  const client = stubClient({
    '/actions/workflows/docker.yml/runs': pagedRunsRoute([[older, ...filler], [newest]]),
    '/actions/runs/': (path) =>
      /\/actions\/runs\/(1|9)\/jobs/.test(path) ? jobs(['deploy', 'success']) : jobs(['deploy', 'skipped']),
  });

  const last = await findLastSuccessfulDeploy({ client });

  assert.equal(last.headSha, 'zzzz', 'the newest shipped run wins even when it lands on a later page');
  assert.ok(!client.calls.some((c) => c.includes('/actions/runs/1/jobs')));
});

test('findLastSuccessfulDeploy: the depth is DECOUPLED from guard (2) and deeper on purpose', async () => {
  // Guard (2) asks "has anything ever deployed" (20 is ample); this asks "how
  // far behind are we", which must reach past the stall. Deeper can only
  // improve the second and cannot make the first wrong.
  assert.ok(
    DEFAULT_DEPLOY_SCAN_LIMIT > 20,
    'the scan must reach past guard (2)s depth or a long stall goes unmeasured',
  );
  assert.equal(DEFAULT_DEPLOY_SCAN_LIMIT % DEPLOY_SCAN_PAGE_SIZE, 0);
  assert.ok(DEPLOY_SCAN_PAGE_SIZE <= 100, 'GitHub clamps per_page above 100');
});

test('measureDeliveryGap: ahead_by is the count of commits production is missing', async () => {
  const client = stubClient({
    '/compare/': {
      status: 'ahead',
      ahead_by: 612,
      behind_by: 0,
      base_commit: { commit: { committer: { date: '2026-09-20T22:55:03Z' } } },
    },
  });

  const gap = await measureDeliveryGap({ client, deployedSha: 'f06c717a', baseRef: 'master' });

  assert.equal(gap.commitsBehind, 612);
  assert.equal(gap.compareStatus, 'ahead');
  assert.equal(gap.deployedCommitAt, '2026-09-20T22:55:03Z');
});

test('measureDeliveryGap: a compare with no usable ahead_by throws rather than reporting zero', async () => {
  // Reporting 0 from an unreadable compare is the exact silent all-clear this
  // whole module exists to prevent.
  const client = stubClient({ '/compare/': { status: 'diverged' } });
  await assert.rejects(
    () => measureDeliveryGap({ client, deployedSha: 'f06c717a' }),
    /no usable ahead_by/,
  );
});

test('gapDays / formatDeliveryGap render the pair a human reads', () => {
  assert.equal(gapDays('2026-09-21T16:38:56Z', NOW).toFixed(1), '12.5');
  assert.equal(formatDeliveryGap({ commitsBehind: 612, days: 12.52 }), '612 commits / 12.5d');
  // An unparseable deploy timestamp must not erase the commit count.
  assert.equal(formatDeliveryGap({ commitsBehind: 612, days: null }), '612 commits');
  assert.equal(formatDeliveryGap(null), null);
});

test('resolveDeliveryGap: measures the gap end to end', async () => {
  const client = stubClient({
    '/actions/workflows/docker.yml/runs': {
      workflow_runs: [run(1, 'f06c717a', '2026-09-21T16:10:46Z', '2026-09-21T16:38:56Z')],
    },
    '/actions/runs/1/jobs': jobs(['deploy', 'success']),
    '/compare/': { status: 'ahead', ahead_by: 612, base_commit: {} },
  });

  const { gap, reason } = await resolveDeliveryGap({ client, now: NOW });

  assert.equal(reason, null);
  assert.equal(gap.commitsBehind, 612);
  assert.equal(gap.deployedSha, 'f06c717a');
  assert.equal(gap.days.toFixed(1), '12.5');
});

test('resolveDeliveryGap: FAILS OPEN with a reason — it must never stop the escalation', async () => {
  const boom = stubClient({
    '/actions/workflows/docker.yml/runs': () => {
      throw new Error('503 upstream');
    },
  });

  const { gap, reason } = await resolveDeliveryGap({ client: boom, now: NOW });

  assert.equal(gap, null);
  assert.match(reason, /lookup failed: 503 upstream/);
});

test('resolveDeliveryGap: a history with no shipped deploy reports WHY, not a zero gap', async () => {
  const client = stubClient({
    '/actions/workflows/docker.yml/runs': { workflow_runs: [] },
  });

  const { gap, reason } = await resolveDeliveryGap({ client, now: NOW });

  assert.equal(gap, null);
  assert.match(reason, /no deploy job concluded success/);
});

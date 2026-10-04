import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DEPLOY_SCAN_LIMIT,
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

test('findLastSuccessfulDeploy: scans the same depth as the dispatcher guard', async () => {
  const client = stubClient({
    '/actions/workflows/docker.yml/runs': { workflow_runs: [] },
  });
  await findLastSuccessfulDeploy({ client });
  assert.equal(DEFAULT_DEPLOY_SCAN_LIMIT, 20);
  assert.ok(client.calls[0].includes(`per_page=${DEFAULT_DEPLOY_SCAN_LIMIT}`));
  assert.ok(client.calls[0].includes('event=workflow_dispatch'));
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

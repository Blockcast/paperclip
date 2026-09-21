#!/usr/bin/env node
/**
 * BLO-28886 ask 2: make a merge-queue ejection visible on the pull request.
 *
 * A queue entry runs the full suite on a temporary
 * `gh-readonly-queue/master/pr-<N>-<baseSha>` branch. When that run fails the
 * entry is ejected, and the PR carries NO trace of it: queue-branch runs do not
 * appear in the pull request's `statusCheckRollup`, so the PR keeps reading
 * CLEAN/green on every surface while its queue entry is dead. GitHub emits no
 * wake on ejection either, so the authoring agent's run is long over and the
 * human who enqueued it is never told.
 *
 * Measured cost of that invisibility (BLO-28886, 2026-09-17): #1853 sat out of
 * the queue for 17h43m, fully green, with nobody re-enqueuing it, and the only
 * question that would have found it was "which open PRs have a
 * `removed_from_merge_queue` event and are not currently in the queue?" —
 * which nobody was asking. Each ejection is therefore an independent chance of
 * PERMANENT abandonment, not merely a lost hour. At the ~26% terminal
 * failure rate re-derived on that issue, that is the dominant cost.
 *
 * This posts one comment on the ejected PR naming the failing lanes and linking
 * the queue run, which turns an invisible ejection into a diagnosable one.
 *
 * FAILURE POSTURE — read before changing an exit code. This runs from a
 * `workflow_run` listener, decoupled from the queue, so it can neither eject an
 * entry nor gate anything. It still exits 0 on every non-delivery path it can
 * (not a queue ref, unparseable ref, no failing lanes): a notifier that goes red
 * is noise on a run that is already reporting someone else's failure. It exits
 * non-zero only when the comment POST itself fails, because that is the one case
 * where staying silent reproduces the exact invisibility the script exists to
 * remove.
 */

/**
 * A queue ref is `gh-readonly-queue/<base>/pr-<number>-<baseSha>`. The base
 * branch may itself contain slashes, and the trailing SHA is hex, so anchor on
 * the LAST `/pr-` segment rather than splitting on `/`.
 */
export function parseQueueRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('gh-readonly-queue/')) return null;
  const match = /\/pr-(\d+)-[0-9a-f]+$/.exec(ref);
  if (!match) return null;
  return { prNumber: Number(match[1]) };
}

export function buildEjectionComment({ failedJobs, runUrl, runId, headSha }) {
  const shards = failedJobs.length
    ? failedJobs.map((name) => `- \`${name}\``).join('\n')
    : '- _(no job reported `failure`; see the run for cancelled or killed lanes)_';

  return [
    '### ⚠️ This PR was ejected from the merge queue',
    '',
    'Its queue entry ran the full suite on a temporary `gh-readonly-queue/…` branch and that run failed,',
    'so GitHub removed the entry. **This failure does not appear in this PR\'s check rollup** — the PR above',
    'still reads green, because queue-branch runs are reported against the queue branch, not against the PR.',
    '',
    '**Failing job(s) in the queue run:**',
    '',
    shards,
    '',
    `Queue run: ${runUrl} (\`${runId}\`, candidate head \`${String(headSha).slice(0, 12)}\`)`,
    '',
    'If the failure is unrelated to this diff, re-queue the PR — BLO-28886 tracks the underlying',
    'nondeterminism, and the failing shard varies run to run. If it is related, push a fix first.',
    '',
    '<sub>Posted by `.github/workflows/merge-queue-ejection-notice.yml` (BLO-28886 ask 2).</sub>',
  ].join('\n');
}

async function gh(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
  return response.json();
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  const headBranch = process.env.RUN_HEAD_BRANCH ?? '';
  const runId = process.env.RUN_ID ?? '';
  const runUrl = process.env.RUN_URL ?? '';
  const headSha = process.env.RUN_HEAD_SHA ?? '';

  const parsed = parseQueueRef(headBranch);
  if (!parsed) {
    console.log(`::notice::"${headBranch}" is not a merge-queue ref; nothing to report.`);
    return;
  }

  const jobs = await gh(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, token);
  const failedJobs = (jobs.jobs ?? [])
    .filter((job) => job.conclusion === 'failure')
    .map((job) => job.name);

  const body = buildEjectionComment({ failedJobs, runUrl, runId, headSha });

  const response = await fetch(
    `https://api.github.com/repos/${repo}/issues/${parsed.prNumber}/comments`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error(
      `::error::Could not post the ejection notice on #${parsed.prNumber}: ` +
        `${response.status} ${text.slice(0, 300)}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Posted ejection notice on #${parsed.prNumber} naming ${failedJobs.length} failing job(s).`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

#!/usr/bin/env node

/**
 * Report a failed merge-group run on the PR that GitHub ejected.
 *
 * Merge-group runs use refs such as gh-readonly-queue/master/pr-1306-<sha>,
 * and do not reliably populate workflow_run.pull_requests. The PR number in
 * the synthetic branch is therefore the durable correlation key.
 */

export function mergeQueuePullRequestNumber(headBranch) {
  if (typeof headBranch !== "string") return null;
  const match = headBranch.match(/(?:^|\/)pr-(\d+)(?:-|$)/i);
  return match ? Number(match[1]) : null;
}

export function shouldReportMergeQueueFailure({ headBranch, conclusion }) {
  // `failure` ONLY, deliberately. Under ALLGREEN a candidate is `cancelled`
  // whenever an earlier entry in the group dies, and those PRs stay queued and
  // get re-built -- they were not ejected and must not be told they were.
  // `failure` is the conclusion that actually drops the entry and nulls
  // autoMergeRequest. Baseline at BLO-26675 filing: 12 failure / 48 cancelled,
  // so getting this backwards would comment on four times more PRs than it helps.
  return mergeQueuePullRequestNumber(headBranch) !== null && conclusion === "failure";
}

async function githubRequest(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${path}`);
  }
  return response.json();
}

export async function reportMergeQueueFailure({ repository, headBranch, runUrl, runId }) {
  const number = mergeQueuePullRequestNumber(headBranch);
  if (number === null) return { reported: false, reason: "not-merge-group" };

  const [owner, repo] = repository.split("/", 2);
  if (!owner || !repo) throw new Error(`Invalid repository: ${repository}`);
  const comments = await githubRequest(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`);
  const marker = `<!-- paperclip:merge-queue-ejection:${runId} -->`;
  if (comments.some((comment) => comment.body?.startsWith(marker))) {
    return { reported: false, reason: "already-reported", number };
  }

  const body = `${marker}\nMerge-queue ejection detected for PR #${number}. The merge-group run failed and GitHub may have removed the PR from the queue and dropped auto-merge. Inspect the failed merge-group jobs, fix or rerun the failing checks, then re-enqueue the PR.\n\nRun: ${runUrl}`;
  await githubRequest(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  return { reported: true, number };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { GITHUB_REPOSITORY, GITHUB_WORKFLOW_RUN_HEAD_BRANCH, GITHUB_WORKFLOW_RUN_CONCLUSION, GITHUB_SERVER_URL, GITHUB_WORKFLOW_RUN_ID } = process.env;
  if (!shouldReportMergeQueueFailure({
    headBranch: GITHUB_WORKFLOW_RUN_HEAD_BRANCH,
    conclusion: GITHUB_WORKFLOW_RUN_CONCLUSION,
  })) process.exit(0);

  const result = await reportMergeQueueFailure({
    repository: GITHUB_REPOSITORY,
    headBranch: GITHUB_WORKFLOW_RUN_HEAD_BRANCH,
    runUrl: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_WORKFLOW_RUN_ID}`,
    runId: GITHUB_WORKFLOW_RUN_ID,
  });
  console.log(result.reported ? `Reported merge-queue ejection for PR #${result.number}` : `Skipped: ${result.reason}`);
}

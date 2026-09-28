#!/usr/bin/env node
/**
 * run-quality-gates.mjs
 * Orchestrates all quality gates. Fetches PR data once, runs all gates,
 * posts or updates a single consolidated comment via commitperclip.
 *
 * Env: GH_TOKEN, GH_REPO, PR_NUMBER, PR_AUTHOR, PR_BRANCH
 * Exit: 0 if all quality gates pass, 1 if any fail.
 */
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ghFetch, exitFatal, RATE_LIMIT_MIN_WAIT_MS } from './get-bot-token.mjs';
import { fetchAllPullRequestFiles } from './fetch-pr-files.mjs';
import { checkTemplate } from './check-pr-template.mjs';
import { checkLinkedIssue } from './check-pr-linked-issue.mjs';
import { checkDedupSearch } from './check-pr-dedup-search.mjs';
import { checkTestCoverage } from './check-pr-test-coverage.mjs';
import { checkLockfile } from './check-pr-lockfile.mjs';
import { checkDependencies } from './check-pr-dependencies.mjs';

const COMMENT_SIGNATURE = '— commitperclip';
const GRAPHIFY_REINDEX_AUTHOR = 'allyblockcast[bot]';
const GRAPHIFY_REINDEX_BRANCH = 'bot/graphify-reindex';
const GRAPHIFY_OUT_PREFIX = 'server/src/graphify-out/';

export function isGraphifyReindexArtifactOnlyPr({ author, branch, files }) {
  return (
    author === GRAPHIFY_REINDEX_AUTHOR &&
    branch === GRAPHIFY_REINDEX_BRANCH &&
    files.length > 0 &&
    files.every(f => f.filename?.startsWith(GRAPHIFY_OUT_PREFIX))
  );
}

export function buildComment(author, failures, informational) {
  if (failures.length === 0 && informational.length === 0) {
    return `✅ All checks passing — ready for Greptile review and maintainer approval.\n\n${COMMENT_SIGNATURE}`;
  }

  const lines = [
    `Hey @${author}! Before this PR can be reviewed, a few things need attention:\n`,
  ];

  if (failures.length > 0) {
    lines.push('**Missing or incomplete:**');
    for (const f of failures) lines.push(`- [ ] ${f}`);
  }

  if (informational.length > 0) {
    if (failures.length > 0) lines.push('');
    lines.push('**Informational:**');
    for (const i of informational) lines.push(`- ${i}`);
  }

  lines.push(
    // Most of what this gate fails on lives in the PR description or title,
    // and `pull_request_target: edited` re-fires the check for those — so do
    // not send the author to push a no-op commit to re-trigger a body check
    // (BLO-26636).
    '\nOnce updated, these checks re-run automatically: editing the PR description or title re-triggers them, as does pushing a new commit.\n',
    COMMENT_SIGNATURE
  );

  return lines.join('\n');
}

export async function findExistingComment(fetchFromGitHub, token, repo, prNumber) {
  for (let page = 1; ; page += 1) {
    const comments = await fetchFromGitHub(
      `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      token
    );

    // Match on the signature this script itself writes plus `type === 'Bot'`,
    // NOT on a hard-coded App login. get-bot-token.mjs resolves the App from
    // COMMITPERCLIP_APP_ID by design, so the author is `commitperclip[bot]`
    // upstream and `allyblockcast[bot]` on Blockcast — the old allowlist
    // hard-coded the upstream login, so on Blockcast `existing` was
    // permanently null: failing runs POSTed a duplicate every time, and
    // passing runs fell through the `|| existing` guard in main() and left the
    // stale failure comment standing forever (BLO-26636). `type === 'Bot'` is
    // what keeps a human comment quoting the signature out of the PATCH path.
    //
    // `endsWith`, not `includes`: on Blockcast every agent posts as
    // `allyblockcast[bot]`, so `type === 'Bot'` discriminates nothing against
    // an agent comment that merely *quotes* `— commitperclip` (they routinely
    // do). Since `.find` returns the first match in ascending id order, such a
    // comment posted before ours would take the PATCH — destroying content
    // that is not ours and leaving our stale comment standing. buildComment
    // puts the signature last in both branches, so anchoring on that is the
    // property we actually own.
    const existing = comments.find(
      c => c.user?.type === 'Bot' && (c.body ?? '').trimEnd().endsWith(COMMENT_SIGNATURE)
    );
    if (existing) return existing;

    if (comments.length < 100) return null;
  }
}

async function upsertComment(token, repo, prNumber, body, existing) {
  if (existing) {
    await ghFetch(`/repos/${repo}/issues/comments/${existing.id}`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  } else {
    await ghFetch(`/repos/${repo}/issues/${prNumber}/comments`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }
}

// Posting the comment is delivery, not evaluation: by the time it runs every
// gate has already produced its verdict, so no delivery failure may decide the
// exit code. Letting one reach exitFatal would discard the verdict and exit 1
// even when every gate passed. That covers a rate-limited POST/PATCH too:
// ghFetch never retries writes, so it throws those as a plain Error with no
// `rateLimited` flag, and keying on the flag would miss exactly the write.
// Same line postFlaggedSecurityResult takes for the security advisory.
//
// A failed delivery is still recorded as `comment_delivered=false`, so the
// workflow can say the failures are in the job log rather than pointing the
// author at a comment that was never posted.
export async function deliverComment(post, outputFile = process.env.GITHUB_OUTPUT) {
  try {
    await post();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `::warning::commitperclip could not post its comment (${message}). The verdict below is still authoritative.`
    );
    if (outputFile) appendFileSync(outputFile, 'comment_delivered=false\n');
    return false;
  }
}

// timeout-minutes of, in commitperclip-review.yml: the "Run quality gates"
// step, the `review` job it runs in, and the "Run security gates" step that
// follows it. A test pins each constant to the file.
export const QUALITY_STEP_TIMEOUT_MS = 5 * 60_000;
export const REVIEW_JOB_TIMEOUT_MS = 10 * 60_000;
export const SECURITY_STEP_TIMEOUT_MS = 3 * 60_000;

// Whole-script budget for the rate-limit sleeps of every read here. This is a
// different scope from ghFetch's RATE_LIMIT_RETRY_BUDGET_MS, which is sized per
// call (it funds one headerless retry).
//
// The binding cap is the job's, not this step's: whatever the steps before
// this one used (a cold ARC runner can spend minutes on setup-node and
// Dependency Review, and those steps have no cap of their own) comes out of
// the same 10 minutes, and the security step after it still needs its 3. So
// the budget is measured at run time from the job's start (recorded by the
// job's first step as REVIEW_JOB_STARTED_AT_MS): the smaller of what this
// step's cap leaves and what the job leaves once the security step's cap is
// set aside, minus one RATE_LIMIT_MIN_WAIT_MS held back for the verdict print
// and the requests after the last funded sleep. That reserve is a soft
// allowance, not a bound: each request is capped at GH_FETCH_DEFAULT_TIMEOUT_MS
// and writes never sleep, but fetchAllPullRequestFiles and findExistingComment
// paginate, so a large PR can issue more than the reserve covers. The step's
// timeout-minutes stays the hard backstop for that tail.
export function qualityRetryBudgetMs(jobStartedAtMs, now = Date.now()) {
  if (!Number.isFinite(jobStartedAtMs) || jobStartedAtMs <= 0) {
    const err = new Error(
      'REVIEW_JOB_STARTED_AT_MS is not set: the review job\'s first step must record it, ' +
      'because the retry budget is what is left of the job, not a guess.'
    );
    // Nothing has been evaluated yet, so exitFatal must say "did not run",
    // not let the workflow point at a commitperclip comment that never got posted.
    err.notEvaluated =
      'The review job did not record REVIEW_JOB_STARTED_AT_MS, so the retry budget could not be sized and no gate ran. ' +
      'Fix the job\'s Record job start step, then re-run.';
    throw err;
  }
  const jobLeftMs = jobStartedAtMs + REVIEW_JOB_TIMEOUT_MS - SECURITY_STEP_TIMEOUT_MS - now;
  return Math.max(0, Math.min(QUALITY_STEP_TIMEOUT_MS, jobLeftMs) - RATE_LIMIT_MIN_WAIT_MS);
}

// ghFetch gives EACH read its own per-call budget, and two of this script's
// reads paginate, so short rate limits on successive pages could sum past the
// step's timeout. The step would then be killed before exitFatal printed its
// not-evaluated annotation. Every read here instead draws on one shared
// budget, measured from script start, so the sum is capped and an exhausted
// budget fails fast into exitFatal. Same idea as check-pr-security's
// watchdogBoundFetch.
export function budgetBoundFetch(startedAt, budgetMs, fetchImpl = ghFetch, now = Date.now) {
  return (path, token, options = {}) => fetchImpl(path, token, {
    retryBudgetMs: Math.max(0, startedAt + budgetMs - now()),
    ...options,
  });
}

async function main() {
  const startedAt = Date.now();
  const gh = budgetBoundFetch(startedAt, qualityRetryBudgetMs(Number(process.env.REVIEW_JOB_STARTED_AT_MS), startedAt));
  const { GH_TOKEN, GH_REPO, PR_NUMBER, PR_AUTHOR, PR_BRANCH } = process.env;

  if (!GH_TOKEN || !GH_REPO || !PR_NUMBER) {
    console.error('ERROR: GH_TOKEN, GH_REPO, PR_NUMBER env vars required');
    process.exit(1);
  }

  // Sanitize inputs before use in URL construction (prevents SSRF)
  const prNumber = parseInt(PR_NUMBER, 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error('ERROR: PR_NUMBER must be a positive integer');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(GH_REPO)) {
    console.error('ERROR: GH_REPO must be in owner/repo format');
    process.exit(1);
  }

  // Fetch PR data once — gates use this, no redundant API calls
  const [pr, files] = await Promise.all([
    gh(`/repos/${GH_REPO}/pulls/${prNumber}`, GH_TOKEN),
    fetchAllPullRequestFiles(gh, GH_REPO, prNumber, GH_TOKEN),
  ]);

  const prBody = pr.body ?? '';
  const author = PR_AUTHOR ?? pr.user.login;
  const branch = PR_BRANCH ?? pr.head.ref;
  const skipTemplate = isGraphifyReindexArtifactOnlyPr({ author, branch, files });

  // Run all quality gates (pure functions run sync, deps check is async)
  const prTitle = pr.title ?? '';
  const [templateResult, issueResult, dedupResult, testResult, lockfileResult, depsResult] =
    await Promise.all([
      Promise.resolve(skipTemplate ? { passed: true, failures: [] } : checkTemplate(prBody)),
      Promise.resolve(checkLinkedIssue(prBody, prTitle)),
      Promise.resolve(checkDedupSearch(prBody, prTitle)),
      Promise.resolve(checkTestCoverage(files, prTitle)),
      Promise.resolve(checkLockfile(files, author, branch)),
      checkDependencies(files, GH_TOKEN, GH_REPO, prNumber, pr.base?.ref, gh),
    ]);

  const allFailures = [
    ...templateResult.failures,
    ...issueResult.failures,
    ...dedupResult.failures,
    ...testResult.failures,
    ...lockfileResult.failures,
  ];
  const informational = depsResult.informational ?? [];
  const allPassed = allFailures.length === 0;

  const commentBody = buildComment(author, allFailures, informational);

  // Post comment if there are failures/informational, or update existing comment
  await deliverComment(async () => {
    const existing = await findExistingComment(gh, GH_TOKEN, GH_REPO, prNumber);
    if (allFailures.length > 0 || informational.length > 0 || existing) {
      await upsertComment(GH_TOKEN, GH_REPO, prNumber, commentBody, existing);
    }
  });

  console.log(JSON.stringify({ passed: allPassed, failures: allFailures, informational }));
  process.exit(allPassed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => exitFatal(e, 'commitperclip quality gates'));
}

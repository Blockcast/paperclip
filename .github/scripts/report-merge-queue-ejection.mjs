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
  // `failure` and `cancelled`. An earlier revision took `failure` only, on the
  // premise that a `cancelled` candidate stays queued and gets re-built. Staff
  // Engineer measured the full history (398 merge_group PR runs, 2026-08-28 ->
  // 2026-09-18: 295 success / 80 failure / 22 cancelled) and that premise holds
  // for 1 of the 22: 6 merged at the cancel, 14 were EJECTED and never
  // re-added. `failure`-only therefore catches 80/94 = 85% of real ejections.
  // A job hitting `timeout-minutes` also surfaces as `cancelled`, and pr.yml
  // deliberately trades a fast red for a timeout -- so that class landed
  // entirely in the blind spot too.
  // The benign `cancelled` cases are suppressed on PR state, not on
  // conclusion: see shouldReportCancelledRun.
  return (
    mergeQueuePullRequestNumber(headBranch) !== null &&
    (conclusion === "failure" || conclusion === "cancelled")
  );
}

export function shouldReportCancelledRun({ merged, isInMergeQueue }) {
  // Only consulted for `cancelled`. `merged` covers the candidate whose group
  // landed; `isInMergeQueue` covers the one still queued for a re-build. Read
  // at an instant, so the race cuts both ways: a PR mid-re-dispatch reads
  // out-of-queue and gets one spurious comment (bounded by the per-runId
  // marker), and a PR re-enqueued before this handler fires reads
  // isInMergeQueue:true and is never reported at all. The second is the one
  // that loses data, and is accepted -- whoever re-added it already knows.
  // Against the measured 22: 14-15 true reports, 0 false alarms.
  return !merged && !isInMergeQueue;
}

// BLO-28886 asks the ejection signal to NAME the failing shard. Without it the
// comment says "inspect the merge-group jobs", i.e. it re-hands the lookup back
// to the reader -- and the whole point of this reporter is that a queue-branch
// failure is invisible from the PR, so that lookup is exactly the expensive bit.
//
// No name-filtering of aggregator jobs: a name allowlist rots on the next
// workflow rename. Aggregators are excluded STRUCTURALLY instead -- see
// causalJobs(). An earlier revision of this comment argued "one extra job name
// costs a reader nothing"; measured, that was wrong. On the two `policy`
// timeout ejections of 2026-09-23/25 the extra name was the ONLY name, and it
// was the wrong one.
//
// The filter is on CONCLUSION, not name. A `cancelled` job is only signal when
// nothing else failed: fail-fast cancels the siblings of a job that genuinely
// failed, so on run 35993984182 (ejected #1976) `Build` is cancelled collateral
// of `General tests (workspaces-a)`. Naming it sends the reader to a log that
// contains nothing but a cancellation -- the same misdirection runOutcomeText
// exists to prevent, one layer down. When nothing failed, a cancelled job IS the
// cause (a `timeout-minutes` kill surfaces that way) and must still be named.
//
// Both rules below need the same input -- the non-success jobs that could
// actually be a CAUSE -- so they share causalJobs() rather than each deriving
// it. That sharing is the point: the two used to disagree, and a reader only
// ever sees the sentence they compose.
//
// Stated as an allowlist of GOOD states, not a denylist of bad ones. The same
// argument as the aggregator-name allowlist below: a denylist rots as the enum
// grows, and this one was already one value short -- `timed_out` is in GitHub's
// documented jobs[].conclusion enum and was invisible here, which reintroduced
// the exact bug causalJobs() exists to kill (the timed-out lane is dropped, the
// messenger it kills becomes the only name). `conclusion` is null mid-flight,
// so the truthiness guard is what keeps an in-progress job from being a cause.
const GOOD_CONCLUSIONS = ["success", "skipped", "neutral"];
const isNonSuccess = (job) => Boolean(job?.conclusion) && !GOOD_CONCLUSIONS.includes(job.conclusion);

/**
 * Non-success jobs minus the aggregator lanes that merely report upstream death.
 *
 * `verify` needs: every other lane, so it goes red whenever anything it waits
 * on dies -- it is a MESSENGER, never a cause. Naming it is the same
 * misdirection as naming fail-fast collateral, and it is the one the
 * conclusion filter above cannot catch, because `verify` is a genuine
 * `failure` rather than a `cancelled`. Measured on the two `policy`
 * timeout ejections in the 2026-09-23/25 window (runs 35948766367 and
 * 36015721472): the comment read "The merge-group run failed. Failing job:
 * `verify`." -- the reader is sent to a log whose entire content is "upstream
 * lane(s) did not run", and `policy`, killed at its 600s cap, is never named.
 *
 * Detected structurally, not by name: an allowlist of aggregator names rots on
 * the next workflow rename. A job that starts only after EVERY other
 * non-success job has finished ran last by construction, which is what being
 * downstream of all of them means. Deliberately the narrowest form of that
 * test -- "after SOME other job" would drop a genuine second failure that
 * merely started late.
 *
 * ponytail: known ceiling at EXACTLY TWO non-success jobs, where "after ALL
 * others" and "after SOME other" are the same predicate, so the narrowness
 * above buys nothing and a genuine late second failure IS dropped. Reachable:
 * `verify` needs: 8 lanes but not `policy`, `canary_dry_run` or `e2e`, so a
 * failure confined to the last two leaves `verify` green and the set at two,
 * staggered only by arc-* runner assignment. NOT fixed by widening -- the
 * `policy`/`verify` pair below is also two jobs and dropping the later one is
 * correct there. The discriminator is the needs: graph and the jobs API does
 * not carry it. Cost is a dropped name, not a wrong one, so it degrades to a
 * second ejection rather than misdirection. Upgrade path: read the needs: graph
 * from pr.yml, or have the workflow emit it. Pinned by the `ceiling:` test.
 */
export function causalJobs(jobs) {
  const list = (Array.isArray(jobs) ? jobs : []).filter(isNonSuccess);
  const at = (value) => Date.parse(value ?? "");
  const causal = list.filter((job) => {
    const started = at(job.started_at);
    const others = list.filter((other) => other !== job);
    if (!others.length || Number.isNaN(started)) return true;
    return !others.every((other) => {
      const done = at(other.completed_at);
      return !Number.isNaN(done) && started >= done;
    });
  });
  // A single non-success job is vacuously "last"; never report nothing when
  // something did fail.
  return causal.length ? causal : list;
}

export function failingJobSummary(jobs) {
  const list = causalJobs(jobs);
  // `cancelled` is the one non-success state that is usually COLLATERAL, so it
  // is named only when nothing else died. Every other state in `list` is a real
  // death and is always named -- keyed on the complement so a new enum value
  // (`timed_out`, `stale`, ...) is reported rather than silently dropped.
  const anyRealDeath = list.some((job) => job?.conclusion !== "cancelled");
  const failed = list
    .filter((job) => job?.conclusion !== "cancelled" || !anyRealDeath)
    .map((job) => job.name)
    .filter((name) => typeof name === "string" && name.length > 0);
  if (failed.length === 0) return "";
  return ` Failing ${failed.length === 1 ? "job" : "jobs"}: ${failed.map((name) => `\`${name}\``).join(", ")}.`;
}

// A run whose conclusion is `cancelled` is NOT necessarily a timeout. GitHub
// marks the whole run `cancelled` when ANY job is cancelled, and fail-fast
// cancels the siblings of a job that genuinely failed -- so the commonest
// `cancelled` run is a real test failure wearing a timeout's clothes. Measured
// on run 35993984182 (ejected #1976): run `cancelled`, but `General tests
// (workspaces-a)` and `verify` both `failure`, and the actual cause was an
// after-teardown `ReferenceError: window is not defined` with 3075/3075 tests
// passing. Reading the run-level conclusion alone sends the reader to look for
// an infra timeout that is not there.
//
// Reads the same causalJobs() set as failingJobSummary: `verify`'s own
// `failure` used to flip this to "failed" on a run whose real cause was
// `policy` hitting its cap, so the sentence asserted a failure and then named
// only the messenger.
export function runOutcomeText(conclusion, jobs) {
  const failed =
    conclusion === "failure" || causalJobs(jobs).some((job) => job?.conclusion === "failure");
  return failed ? "failed" : "was cancelled (a job timeout surfaces this way)";
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

// `isInMergeQueue` is GraphQL-only -- REST /pulls/{n} has no queue-membership
// field, and its `mergeable_state` reads `unknown` for a queued PR (lazy
// compute), so it cannot answer this.
async function pullRequestQueueState(owner, repo, number) {
  const payload = await githubRequest("/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){merged isInMergeQueue}}}`,
      variables: { owner, repo, number },
    }),
  });
  // GraphQL answers 200 with an `errors` array, so response.ok proves nothing.
  if (payload.errors?.length) {
    throw new Error(`GitHub GraphQL: ${payload.errors.map((e) => e.message).join("; ")}`);
  }
  const pullRequest = payload.data?.repository?.pullRequest;
  if (!pullRequest) throw new Error(`No pull request ${owner}/${repo}#${number}`);
  return pullRequest;
}

export async function reportMergeQueueFailure({ repository, headBranch, conclusion, runUrl, runId }) {
  // Gate here as well as in the CLI, so the safe path is the only path.
  if (!shouldReportMergeQueueFailure({ headBranch, conclusion })) {
    return { reported: false, reason: "not-reportable" };
  }
  const number = mergeQueuePullRequestNumber(headBranch);

  const [owner, repo] = repository.split("/", 2);
  if (!owner || !repo) throw new Error(`Invalid repository: ${repository}`);

  if (conclusion === "cancelled") {
    // Deliberate: a GraphQL blip here reddens the reporter job rather than
    // silently skipping. A silent skip loses an ejection report on a PR that is
    // already stuck, which is the failure nobody notices.
    const state = await pullRequestQueueState(owner, repo, number);
    if (!shouldReportCancelledRun(state)) {
      return { reported: false, reason: state.merged ? "merged" : "still-queued", number };
    }
  }

  // One unpaginated page, oldest-first. GET /issues/{n}/comments does NOT honour
  // sort/direction -- only the repo-level /issues/comments does; measured on this
  // repo, the per-issue endpoint returns an identical first element with and
  // without direction=desc (#1306, #1158, #1859), while the repo-level one flips.
  // So the marker sits on the LAST page and a thread past 100 comments would
  // re-post on every redelivery. Ceiling accepted: the busiest thread here is 12,
  // and the blast radius is one duplicate comment. Paginate to the end if a PR
  // thread ever approaches 100.
  const comments = await githubRequest(
    `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
  );
  const marker = `<!-- paperclip:merge-queue-ejection:${runId} -->`;
  if (comments.some((comment) => comment.body?.startsWith(marker))) {
    return { reported: false, reason: "already-reported", number };
  }

  // Best-effort: a failure here must NOT lose the ejection report. Losing the
  // shard name degrades the comment; losing the comment leaves a stuck PR
  // silent, which is the failure this whole script exists to prevent.
  // One unpaginated page (default `filter=latest`, so a re-run's older attempts
  // are excluded). Ceiling: a workflow past 100 jobs truncates -- 17 today.
  let jobs;
  try {
    ({ jobs } = await githubRequest(
      `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`,
    ));
  } catch (error) {
    console.warn(`Could not read jobs for run ${runId}: ${error.message}`);
  }
  const summary = failingJobSummary(jobs);
  const body = `${marker}\nMerge-queue ejection detected for PR #${number}. The merge-group run ${runOutcomeText(conclusion, jobs)} and GitHub may have removed the PR from the queue and dropped auto-merge.${summary} Inspect the merge-group jobs, fix or rerun the failing checks, then re-enqueue the PR.\n\nRun: ${runUrl}`;
  await githubRequest(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  return { reported: true, number };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { GITHUB_REPOSITORY, GITHUB_WORKFLOW_RUN_HEAD_BRANCH, GITHUB_WORKFLOW_RUN_CONCLUSION, GITHUB_SERVER_URL, GITHUB_WORKFLOW_RUN_ID } = process.env;
  const result = await reportMergeQueueFailure({
    repository: GITHUB_REPOSITORY,
    headBranch: GITHUB_WORKFLOW_RUN_HEAD_BRANCH,
    conclusion: GITHUB_WORKFLOW_RUN_CONCLUSION,
    runUrl: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_WORKFLOW_RUN_ID}`,
    runId: GITHUB_WORKFLOW_RUN_ID,
  });
  console.log(result.reported ? `Reported merge-queue ejection for PR #${result.number}` : `Skipped: ${result.reason}`);
}

#!/usr/bin/env node

/**
 * Report a failed merge-group run on the PR that GitHub ejected.
 *
 * Merge-group runs use refs such as gh-readonly-queue/master/pr-1306-<sha>,
 * and do not reliably populate workflow_run.pull_requests. The PR number in
 * the synthetic branch is therefore the durable correlation key.
 */

// PEN-5592: the queue-removal attribution is IMPORTED from the sibling
// detector, not re-derived here. The two used to answer "why did this PR leave
// the queue" independently and contradict each other on the same event --
// measured on #3371 (2026-11-04), where this reporter posted "a job timeout
// surfaces this way ... re-enqueue the PR" at 13:15:17Z and
// merge-queue-eviction-detector posted "deliberate dequeue ... do not rebase"
// 14s later. Sharing the predicate is what makes that class of disagreement
// unrepresentable rather than merely unlikely.
//
// The workflow sparse-checkout MUST include scripts/merge-queue-eviction-detector.mjs
// for this import to resolve -- see report-merge-queue-ejection.yml.
import {
  isQueueInitiatedRemoval,
  selectLatestQueueAttemptWindow,
} from "../../scripts/merge-queue-eviction-detector.mjs";

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

/**
 * PEN-5592: how far AFTER the run's own end a `removed_from_merge_queue` may
 * still be read as the cause of that run's teardown.
 *
 * The causal ordering is dequeue -> GitHub tears the merge group down -> the
 * run concludes `cancelled`, so the removal normally PRECEDES the run's
 * `updated_at` (57s before it on the measured #3371). The tolerance exists
 * only for the reverse ordering of the two RECORDS, not of the two events:
 * the run's conclusion and the timeline event are written by different
 * subsystems and neither is ordered against the other.
 *
 * Deliberately small. Widening it suppresses more notices, and a dequeue a
 * clear minute after the run already died is a different act from the one
 * that killed it.
 */
export const MANUAL_DEQUEUE_SKEW_MS = 60 * 1000;

/**
 * The `removed_from_merge_queue` that explains THIS run's `cancelled`, when
 * one exists and was performed by someone other than the queue itself.
 *
 * This is the whole of PEN-5592. `conclusion === "cancelled"` holds over two
 * populations that nothing else here can separate:
 *
 *   1. the merge-group run genuinely died (a `timeout-minutes` kill surfaces
 *      as `cancelled`) and the queue then ejected the PR -- "rerun the checks
 *      and re-enqueue" is the right advice; and
 *   2. somebody dequeued the PR and GitHub tore the run down as a consequence
 *      -- nothing failed, nothing timed out, and "re-enqueue" is the single
 *      action a deliberate hold forbids.
 *
 * Measured cost of conflating them (#3371, 2026-11-04): the `kkroo` seat
 * dequeued at 13:13:57Z, run 41835906627 ended `cancelled` at 13:14:54Z, and
 * the notice told its reader to re-enqueue. `allyblockcast[bot]` did exactly
 * that at 20:59:58Z against an unchanged head, and the hold had to be
 * reimposed with a second dequeue at 21:31:38Z. The sibling runs at the same
 * two merge-group `created_at` both finished `success` in 41s and 59s --
 * nothing timed out.
 *
 * Fails toward REPORTING, in three independent ways, because a silent skip on
 * a genuinely stuck PR is the failure nobody notices:
 *   - an unparseable/absent run end -> null (callers treat that as fatal, see
 *     reportMergeQueueFailure -- a guard that can be silently switched off by
 *     dropping an env var is worse than no guard);
 *   - no enqueue or no removal on the timeline -> `selectLatestQueueAttemptWindow`
 *     returns null/`dequeuedAt: null` -> null;
 *   - no attributable actor -> `isQueueInitiatedRemoval` returns true -> null.
 * Only a POSITIVELY identified non-queue actor suppresses anything.
 *
 * Suppressing costs the PR no notice at all: the removal this function keys on
 * is itself a `pull_request_target: dequeued` event, so
 * merge-queue-eviction-detector has already fired for the very event being
 * read here, and it names the remover (`buildEvictionCommentBody`'s
 * `namedManualActor` branch). That is why this reporter yields rather than
 * growing a second manual-dequeue text: whichever notice survives must be the
 * one whose attribution comes from the timeline, and only the sibling's does.
 *
 * @param {Array<{ event: string, created_at: string, actor?: string | null }>} timelineEvents
 * @param {{ runUpdatedAt: string, skewMs?: number }} opts
 * @returns {{ dequeuedAt: string, dequeuedBy: string } | null}
 */
export function manualDequeueExplainingRun(timelineEvents, { runUpdatedAt, skewMs = MANUAL_DEQUEUE_SKEW_MS }) {
  const endedAt = Date.parse(runUpdatedAt ?? "");
  if (!Number.isFinite(endedAt)) return null;
  // `now: endedAt` is what scopes the window to THIS run: the enqueue is the
  // last one at or before the run ended, so a later attempt's enqueue (#3371
  // was re-enqueued at 20:59:58Z) cannot anchor the window of a run that
  // concluded hours earlier.
  const window = selectLatestQueueAttemptWindow(timelineEvents, { now: endedAt });
  if (!window?.dequeuedAt) return null;
  const dequeuedAt = Date.parse(window.dequeuedAt);
  // The removal must plausibly have CAUSED this teardown. `selectLatestQueueAttemptWindow`
  // takes the first removal after the anchoring enqueue with no upper bound,
  // so without this a run that genuinely timed out at 13:20 and a hold placed
  // at 14:00 would read as cause and effect.
  if (!Number.isFinite(dequeuedAt) || dequeuedAt > endedAt + skewMs) return null;
  if (isQueueInitiatedRemoval(window.dequeuedBy)) return null;
  return { dequeuedAt: window.dequeuedAt, dequeuedBy: window.dequeuedBy };
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
 * not carry it. Cost is a dropped name, not a wrong one -- PROVIDED the
 * surviving job is itself a real death, which is the reachable shape: the
 * `policy`-timeout pair drops the later `e2e` and names `policy`, which did
 * genuinely die. If the survivor were `cancelled` collateral the cost WOULD be a
 * wrong name, because anyRealDeath in failingJobSummary is computed over the
 * post-causalJobs list, so dropping the real failure stops it suppressing the
 * collateral. That shape needs collateral whose causer is absent from the set,
 * and fail-fast only cancels a sibling BECAUSE something failed -- so the causer
 * is in the set too and n is 3, which restores the right answer. Unreachable as
 * far as fail-fast semantics go; not proven impossible. On the reachable shape
 * it therefore degrades to a second ejection rather than misdirection. Upgrade
 * path: read the needs: graph from pr.yml, or have the workflow emit it. Pinned
 * by the `ceiling:` test.
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
  const named = list
    .filter((job) => job?.conclusion !== "cancelled" || !anyRealDeath)
    .filter((job) => typeof job?.name === "string" && job.name.length > 0);
  if (named.length === 0) return "";
  // PEN-5592: a cancelled job is not a failed job, and the label is the only
  // thing a reader has to tell them apart. On #3371 all 12 named jobs were
  // killed mid-flight when the PR was dequeued -- none had failed, none had
  // timed out -- and they were printed as "Failing jobs", which is HEARTBEAT
  // S4.2's "a cancelled check is not a failed check" trap running the other
  // way. Derived from what is actually being PRINTED (the post-filter set)
  // rather than from `anyRealDeath`, so the label cannot drift away from the
  // list it labels if that filter changes.
  const label = named.every((job) => job.conclusion === "cancelled") ? "Cancelled" : "Failing";
  return ` ${label} ${named.length === 1 ? "job" : "jobs"}: ${named.map((job) => `\`${job.name}\``).join(", ")}.`;
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
//
// The JOB-level test is an allowlist of timeout-SHAPED states, not the positive
// `conclusion === "failure"` it used to be. Under the positive form every future
// enum value (`stale`, ...) rendered the timeout parenthetical over a run that
// did not time out -- asserting an infra timeout that is not there is precisely
// the misdirection above, arriving through the enum instead of through the run
// conclusion. The complement defaults an unseen value to the generic "failed",
// which is the cheaper direction to be wrong in.
//
// Deliberately NOT the same partition as failingJobSummary, which treats
// `timed_out` as a real death and always names it. Different questions: "is this
// job worth naming as a cause" vs "does the run as a whole read as a timeout".
// A `timed_out` job is both a real cause AND timeout-shaped.
//
// The RUN-level `conclusion === "failure"` stays positive: a run GitHub marks
// `failure` did fail, and `cancelled` is the only other value this handler is
// ever invoked with (see shouldReportMergeQueueFailure).
const TIMEOUT_SHAPED = ["cancelled", "timed_out"];
export function runOutcomeText(conclusion, jobs) {
  const failed =
    conclusion === "failure" ||
    causalJobs(jobs).some((job) => !TIMEOUT_SHAPED.includes(job?.conclusion));
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
async function pullRequestQueueState(owner, repo, number, request = githubRequest) {
  const payload = await request("/graphql", {
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

const TIMELINE_PAGE_SIZE = 100;
// Ceiling accepted: 10 pages = 1000 events. The timeline is OLDEST-first, so a
// PR past this truncates the NEWEST events -- which is where the removal being
// attributed lives. That direction is deliberate and matches the two ceilings
// below: a missing removal reads as "no manual dequeue observed" and the notice
// is POSTED, so this can only ever cost a false notice on an absurdly long
// thread, never a suppressed genuine ejection. #3371 carries 39 events. Raise
// it, or switch to Link-header walking (which needs `githubRequest` to surface
// headers), if a PR thread ever approaches 1000.
const TIMELINE_PAGE_CEILING = 10;

/**
 * The issue timeline, walked past the first page.
 *
 * PEN-5592 (Ally review, PR #3399): the single unpaginated read this replaces
 * failed exactly where it mattered most. `removed_from_merge_queue` lands late
 * on a long timeline, so on a repeatedly-held, long-lived PR -- the population
 * a hold EXISTS for -- the removal fell on page 2, `dequeuedAt` read `null`,
 * and the reporter went back to telling its reader to re-enqueue a held PR.
 *
 * Paged through the injected `request` seam rather than with `--paginate`-style
 * Link walking, so the page boundary is observable from the tests without
 * teaching the fake transport about response headers.
 */
async function readTimeline(owner, repo, number, request) {
  const events = [];
  for (let page = 1; page <= TIMELINE_PAGE_CEILING; page += 1) {
    const batch = await request(
      `/repos/${owner}/${repo}/issues/${number}/timeline?per_page=${TIMELINE_PAGE_SIZE}&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    events.push(...batch);
    // A short page is the last page. Saves a request on the common single-page
    // case and terminates without needing a total count.
    if (batch.length < TIMELINE_PAGE_SIZE) break;
  }
  return events;
}

export async function reportMergeQueueFailure({
  repository,
  headBranch,
  conclusion,
  runUrl,
  runId,
  runUpdatedAt,
  // Seam, not configuration: the whole point of PEN-5592 is a decision taken
  // before any comment is composed, and that decision is only pinned by a test
  // that can observe the POST not happening.
  request = githubRequest,
}) {
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
    const state = await pullRequestQueueState(owner, repo, number, request);
    if (!shouldReportCancelledRun(state)) {
      return { reported: false, reason: state.merged ? "merged" : "still-queued", number };
    }

    // PEN-5592: fail LOUD rather than fail open. `runUpdatedAt` comes from the
    // same `workflow_run` payload as `conclusion`, so it is never legitimately
    // absent on this path -- but a guard that silently disables itself when an
    // env var is dropped from the workflow is the vacuous-green trap at
    // deployment scale, and the bug it would restore is one an automated
    // enqueuer already acted on once.
    if (!Number.isFinite(Date.parse(runUpdatedAt ?? ""))) {
      throw new Error(
        `reportMergeQueueFailure needs a parseable runUpdatedAt to attribute a cancelled run; got ${JSON.stringify(runUpdatedAt)}`,
      );
    }
    // Same policy as the GraphQL read above: a timeline blip reddens the job.
    // Posting a wrong CAUSE is not the cheap direction here -- it is read by
    // bots, and on #3371 one acted on it.
    const timeline = await readTimeline(owner, repo, number, request);
    const manual = manualDequeueExplainingRun(timeline, { runUpdatedAt });
    if (manual) {
      // merge-queue-eviction-detector has already fired on this very removal
      // and names the remover. Yielding is what makes the two detectors
      // incapable of posting contradictory causes for one event.
      return { reported: false, reason: "manual-dequeue", number, dequeuedBy: manual.dequeuedBy };
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
  const comments = await request(
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
    ({ jobs } = await request(
      `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`,
    ));
  } catch (error) {
    console.warn(`Could not read jobs for run ${runId}: ${error.message}`);
  }
  const summary = failingJobSummary(jobs);
  const body = `${marker}\nMerge-queue ejection detected for PR #${number}. The merge-group run ${runOutcomeText(conclusion, jobs)} and GitHub may have removed the PR from the queue and dropped auto-merge.${summary} Inspect the merge-group jobs, fix or rerun the failing checks, then re-enqueue the PR.\n\nRun: ${runUrl}`;
  await request(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  return { reported: true, number };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { GITHUB_REPOSITORY, GITHUB_WORKFLOW_RUN_HEAD_BRANCH, GITHUB_WORKFLOW_RUN_CONCLUSION, GITHUB_SERVER_URL, GITHUB_WORKFLOW_RUN_ID, GITHUB_WORKFLOW_RUN_UPDATED_AT } = process.env;
  const result = await reportMergeQueueFailure({
    repository: GITHUB_REPOSITORY,
    headBranch: GITHUB_WORKFLOW_RUN_HEAD_BRANCH,
    conclusion: GITHUB_WORKFLOW_RUN_CONCLUSION,
    runUrl: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_WORKFLOW_RUN_ID}`,
    runId: GITHUB_WORKFLOW_RUN_ID,
    // PEN-5592: when the run ENDED, which is what a `removed_from_merge_queue`
    // has to precede to be read as the cause of its teardown.
    runUpdatedAt: GITHUB_WORKFLOW_RUN_UPDATED_AT,
  });
  console.log(
    result.reported
      ? `Reported merge-queue ejection for PR #${result.number}`
      : result.reason === "manual-dequeue"
        ? `Skipped: manual-dequeue by ${result.dequeuedBy} (merge-queue-eviction-detector reports this one)`
        : `Skipped: ${result.reason}`,
  );
}

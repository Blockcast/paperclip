import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeQueuePullRequestNumber,
  shouldReportMergeQueueFailure,
  shouldReportCancelledRun,
  failingJobSummary,
  runOutcomeText,
  causalJobs,
  manualDequeueExplainingRun,
  reportMergeQueueFailure,
} from "../report-merge-queue-ejection.mjs";
import { timelineActorLogin } from "../../../scripts/merge-queue-eviction-detector.mjs";

test("extracts PR numbers from merge-group synthetic refs", () => {
  assert.equal(mergeQueuePullRequestNumber("gh-readonly-queue/master/pr-1306-abc123"), 1306);
  assert.equal(mergeQueuePullRequestNumber("refs/heads/gh-readonly-queue/master/pr-1158-def456"), 1158);
  assert.equal(mergeQueuePullRequestNumber("fix/BLO-1306"), null);
  // The segment anchor is load-bearing: this script POSTS a comment to the number
  // it derives, so an unanchored `pr-` match would comment on an unrelated PR.
  assert.equal(mergeQueuePullRequestNumber("cto/repr-1306-fix"), null);
  assert.equal(mergeQueuePullRequestNumber("fix/pr-notes-1306"), null);
  assert.equal(mergeQueuePullRequestNumber("gh-readonly-queue/master/pr-1306extra"), null);
});

test("failed and cancelled merge-group runs are reportable, nothing else is", () => {
  const branch = "gh-readonly-queue/master/pr-1306-abc123";
  assert.equal(shouldReportMergeQueueFailure({ headBranch: branch, conclusion: "failure" }), true);
  // 14 of the 22 measured `cancelled` runs were ejected and never re-added, and
  // a job timeout surfaces as `cancelled` -- so excluding it missed 15%.
  assert.equal(shouldReportMergeQueueFailure({ headBranch: branch, conclusion: "cancelled" }), true);
  assert.equal(shouldReportMergeQueueFailure({ headBranch: branch, conclusion: "success" }), false);
  // Widening to `!== "success"` would report in-flight and skipped runs.
  assert.equal(shouldReportMergeQueueFailure({ headBranch: branch, conclusion: null }), false);
  assert.equal(shouldReportMergeQueueFailure({ headBranch: branch, conclusion: "skipped" }), false);
  assert.equal(shouldReportMergeQueueFailure({ headBranch: "fix/BLO-1306", conclusion: "failure" }), false);
});

test("a cancelled run is reported only when the PR is neither merged nor still queued", () => {
  assert.equal(shouldReportCancelledRun({ merged: false, isInMergeQueue: false }), true);
  // The group landed: the cancel was collateral, not an ejection.
  assert.equal(shouldReportCancelledRun({ merged: true, isInMergeQueue: false }), false);
  // Still queued for a re-build: not ejected.
  assert.equal(shouldReportCancelledRun({ merged: false, isInMergeQueue: true }), false);
});

test("the ejection comment names the failing shards", () => {
  // Shape taken from the real run that ejected #1962 (35871782486). No
  // timestamps here on purpose: causalJobs() can only prove a lane is
  // downstream from them, so without them it keeps everything and this
  // degrades to naming the aggregator too. Fail-safe direction -- one extra
  // name, never a missing one. The timestamped cases below are the real shape.
  assert.equal(
    failingJobSummary([
      { name: "General tests (workspaces-a)", conclusion: "failure" },
      { name: "General tests (server 1/4)", conclusion: "success" },
      { name: "verify", conclusion: "failure" },
    ]),
    " Failing jobs: `General tests (workspaces-a)`, `verify`.",
  );
  // A job killed by `timeout-minutes` surfaces as cancelled, and that is the
  // class pr.yml deliberately trades a fast red for -- so it must be named too.
  // PEN-5592: named, but as CANCELLED. GitHub's own conclusion for this job is
  // `cancelled`; calling it a failure asserts a state the API does not report.
  assert.equal(
    failingJobSummary([{ name: "General tests (server 4/4)", conclusion: "cancelled" }]),
    " Cancelled job: `General tests (server 4/4)`.",
  );
  // Empty, not a dangling "Failing jobs:", when the jobs read gave nothing
  // usable -- the comment must still read as a sentence. Covers the
  // best-effort catch path, which passes no jobs at all.
  assert.equal(failingJobSummary([{ name: "verify", conclusion: "success" }]), "");
  assert.equal(failingJobSummary([]), "");
  assert.equal(failingJobSummary(undefined), "");
});

test("a `cancelled` run carrying a failed job is described as failed, not as a timeout", () => {
  // Shape taken from run 35993984182, which ejected #1976: run-level conclusion
  // `cancelled` (fail-fast cancelled `Build`), but the cause was a genuine
  // `failure` in a shard. Reporting that as "a job timeout surfaces this way"
  // points the reader at infra instead of at the shard.
  assert.equal(
    runOutcomeText("cancelled", [
      { name: "Build", conclusion: "cancelled" },
      { name: "General tests (workspaces-a)", conclusion: "failure" },
      { name: "verify", conclusion: "failure" },
    ]),
    "failed",
  );
  // A genuine timeout: every non-success job is cancelled, nothing failed.
  assert.equal(
    runOutcomeText("cancelled", [
      { name: "General tests (server 4/4)", conclusion: "cancelled" },
      { name: "verify", conclusion: "success" },
    ]),
    "was cancelled (a job timeout surfaces this way)",
  );
  // Degrades to the run-level conclusion when the best-effort jobs read gave
  // nothing -- i.e. exactly the pre-BLO-28886 behaviour, never worse.
  assert.equal(runOutcomeText("cancelled", undefined), "was cancelled (a job timeout surfaces this way)");
  assert.equal(runOutcomeText("failure", undefined), "failed");
});

test("the rendered sentence is coherent on a fail-fast run: no cancelled collateral is named", () => {
  // The two functions above are each correct in isolation while the sentence
  // they compose is wrong -- that split is what hid the `Build` case. So assert
  // on BOTH over ONE real shape: run 35993984182, verbatim from the API.
  // Untimestamped, so `verify` survives; the timestamped form of this same run
  // is asserted below, where it correctly drops to the shard alone.
  const jobs = [
    { name: "Build", conclusion: "cancelled" },
    { name: "General tests (workspaces-a)", conclusion: "failure" },
    { name: "General tests (server 1/4)", conclusion: "success" },
    { name: "verify", conclusion: "failure" },
  ];
  assert.equal(
    `The merge-group run ${runOutcomeText("cancelled", jobs)}.${failingJobSummary(jobs)}`,
    "The merge-group run failed. Failing jobs: `General tests (workspaces-a)`, `verify`.",
  );
  // `Build` was cancelled BECAUSE workspaces-a failed; its log shows only a
  // cancellation. Naming it is the misdirection, not extra detail.
  assert.ok(!failingJobSummary(jobs).includes("Build"));
});

test("a `policy` timeout is named as the cause, not the `verify` lane that merely reports it", () => {
  // Run 35948766367, verbatim from the API: an ejection whose cause is `policy`
  // killed at its 600s cap. `verify` needs: it, so `verify` goes red 14s later
  // and is a genuine `failure` -- which the conclusion filter cannot catch.
  // Before causalJobs() this rendered "The merge-group run failed. Failing job:
  // `verify`.", sending the reader to a log reading only "upstream lane(s) did
  // not run". 2 of the 7 merge-group ejections in the 2026-09-23/25 window.
  const jobs = [
    { name: "policy", conclusion: "cancelled", started_at: "2026-09-24T02:57:04Z", completed_at: "2026-09-24T03:08:22Z" },
    { name: "verify", conclusion: "failure", started_at: "2026-09-24T03:08:36Z", completed_at: "2026-09-24T03:08:47Z" },
  ];
  // PEN-5592: `Cancelled job`, not `Failing job` -- `policy` concluded
  // `cancelled` at its 600s cap, and the run sentence already says a timeout
  // surfaces this way. The two halves now agree instead of the list asserting
  // a failure the run text does not claim.
  assert.equal(
    `The merge-group run ${runOutcomeText("cancelled", jobs)}.${failingJobSummary(jobs)}`,
    "The merge-group run was cancelled (a job timeout surfaces this way). Cancelled job: `policy`.",
  );
  // Same shape, `timed_out` instead of `cancelled`. That value is in GitHub's
  // documented conclusion enum; under a denylist of bad states it was invisible
  // to causalJobs, so `policy` vanished, `verify` became vacuously causal and
  // the comment named the messenger -- verbatim the bug causalJobs kills. Fails
  // if isNonSuccess or the failingJobSummary filter goes back to enumerating
  // bad states.
  const timedOut = [{ ...jobs[0], conclusion: "timed_out" }, jobs[1]];
  assert.equal(
    `The merge-group run ${runOutcomeText("cancelled", timedOut)}.${failingJobSummary(timedOut)}`,
    "The merge-group run was cancelled (a job timeout surfaces this way). Failing job: `policy`.",
  );
});

test("ceiling: with exactly two non-success jobs the later one is dropped even if genuine", () => {
  // Pins the KNOWN GAP documented on causalJobs, so the next reader does not
  // re-derive it. At n=2 "started after ALL others" collapses into "after SOME
  // other", so the narrowness guarded by the test above buys nothing and `e2e`
  // -- a genuine independent failure -- is dropped. Reachable: `verify` needs:
  // neither `canary_dry_run` nor `e2e`, so a failure confined to those two
  // leaves `verify` green and the set at exactly two.
  //
  // Asserting the CURRENT behaviour deliberately. Widening causalJobs is the
  // wrong fix -- the policy/verify pair above is also two jobs and dropping the
  // later one is correct there; only the needs: graph separates them, and the
  // jobs API does not carry it. Cost is a dropped name, not a wrong one.
  const jobs = [
    { name: "canary_dry_run", conclusion: "failure", started_at: "2026-09-24T10:01:00Z", completed_at: "2026-09-24T10:03:00Z" },
    { name: "e2e", conclusion: "failure", started_at: "2026-09-24T10:05:00Z", completed_at: "2026-09-24T10:40:00Z" },
  ];
  assert.deepEqual(causalJobs(jobs).map((job) => job.name), ["canary_dry_run"]);
  assert.equal(failingJobSummary(jobs), " Failing job: `canary_dry_run`.");
});

test("a late-starting second failure is still named: only a job after ALL others is dropped", () => {
  // The narrowness guard. `Build` starts before `workspaces-a` finishes, so it
  // is not downstream-of-everything and must survive causalJobs() -- it is then
  // dropped as fail-fast collateral by the conclusion filter, which is a
  // different rule. Widening causalJobs to "after SOME other job" would drop a
  // genuine independent failure that merely started late.
  const jobs = [
    { name: "Build", conclusion: "cancelled", started_at: "2026-09-24T11:46:54Z", completed_at: "2026-09-24T12:12:33Z" },
    { name: "General tests (workspaces-a)", conclusion: "failure", started_at: "2026-09-24T11:45:42Z", completed_at: "2026-09-24T12:05:41Z" },
    { name: "verify", conclusion: "failure", started_at: "2026-09-24T13:36:47Z", completed_at: "2026-09-24T13:37:41Z" },
  ];
  assert.deepEqual(causalJobs(jobs).map((job) => job.name), ["Build", "General tests (workspaces-a)"]);
  assert.equal(
    `The merge-group run ${runOutcomeText("cancelled", jobs)}.${failingJobSummary(jobs)}`,
    "The merge-group run failed. Failing job: `General tests (workspaces-a)`.",
  );
});

test("a lone failing job is never dropped for being vacuously last", () => {
  const jobs = [{ name: "e2e", conclusion: "failure", started_at: "2026-09-24T11:45:42Z", completed_at: "2026-09-24T12:05:41Z" }];
  assert.equal(failingJobSummary(jobs), " Failing job: `e2e`.");
  // Jobs with no timestamps at all (never dispatched) must not vanish either.
  assert.equal(failingJobSummary([{ name: "policy", conclusion: "cancelled" }]), " Cancelled job: `policy`.");
});

test("an in-flight job is not a cause: a null conclusion is excluded, not read as non-success", () => {
  // Pins the `Boolean(job?.conclusion)` guard in isNonSuccess. `null` is not in
  // GOOD_CONCLUSIONS, so WITHOUT the guard an unfinished job reads as a
  // non-success cause and gets named -- and its log contains no failure at all,
  // which is verbatim the misdirection this module exists to prevent. Measured
  // on this shape: guarded names `General tests (workspaces-a)` alone, unguarded
  // names `e2e` too.
  //
  // Every other clause here has a failing mutation; before this test the guard
  // had none (deleting it left 12 pass / 0 fail), i.e. it was a comment rather
  // than a guard.
  //
  // NOT a claim that a completed merge_group run commonly carries a null
  // conclusion. This is a read-time race -- the jobs endpoint is read just after
  // the workflow_run completed event -- so a sample of long-settled runs cannot
  // discriminate, and 10 recent completed runs carried none. The claim is only
  // that the guard is load-bearing and its removal is silent.
  const jobs = [
    { name: "e2e", conclusion: null, started_at: "2026-09-24T10:00:00Z", completed_at: null },
    { name: "General tests (workspaces-a)", conclusion: "failure", started_at: "2026-09-24T10:01:00Z", completed_at: "2026-09-24T10:20:00Z" },
  ];
  assert.deepEqual(causalJobs(jobs).map((job) => job.name), ["General tests (workspaces-a)"]);
  assert.equal(failingJobSummary(jobs), " Failing job: `General tests (workspaces-a)`.");
});

test("an unknown job conclusion renders the generic `failed`, not a timeout assertion", () => {
  // runOutcomeText keys on an allowlist of TIMEOUT-SHAPED conclusions, so a
  // value this file has never seen falls to the generic "failed" rather than
  // asserting a timeout that did not happen -- the same misdirection
  // runOutcomeText exists to prevent, arriving through the enum instead of
  // through the run conclusion. Fails if the job-level test goes back to the
  // positive `conclusion === "failure"`, under which every new enum value
  // renders the timeout parenthetical.
  assert.equal(runOutcomeText("cancelled", [{ name: "e2e", conclusion: "stale" }]), "failed");
  // The two states that ARE timeout-shaped still render it.
  assert.equal(
    runOutcomeText("cancelled", [{ name: "policy", conclusion: "timed_out" }]),
    "was cancelled (a job timeout surfaces this way)",
  );
  assert.equal(
    runOutcomeText("cancelled", [{ name: "policy", conclusion: "cancelled" }]),
    "was cancelled (a job timeout surfaces this way)",
  );
});

test("a job that started after SOME but not ALL others is kept (guards the narrowness of causalJobs)", () => {
  // The `every` in causalJobs has to be `every`, not `some`. `b` starts after
  // `a` finished but while `c` is still running, so it is NOT last and is a
  // genuine independent failure. Under a `some` test it would silently vanish
  // from the comment. The fail-fast fixture above cannot catch this -- no job
  // in it starts after any other one completes -- which is why the widened
  // form passed the suite before this test existed.
  const jobs = [
    { name: "a", conclusion: "failure", started_at: "2026-09-24T10:00:00Z", completed_at: "2026-09-24T10:10:00Z" },
    { name: "b", conclusion: "failure", started_at: "2026-09-24T10:15:00Z", completed_at: "2026-09-24T10:40:00Z" },
    { name: "c", conclusion: "failure", started_at: "2026-09-24T10:05:00Z", completed_at: "2026-09-24T10:50:00Z" },
  ];
  assert.deepEqual(causalJobs(jobs).map((job) => job.name), ["a", "b", "c"]);
});

test("jobs cancelled at the same instant are all reported, not all dropped", () => {
  // Reachability of the `causal.length ? causal : list` fallback. Job timestamps
  // are second-resolution, so two lanes cancelled together when the run died
  // carry identical values -- each then reads as "started after the other
  // finished" and both get dropped, leaving the comment naming nothing at all.
  // Observed shape: needs:-gated lanes cancelled 0s after creation.
  const jobs = [
    { name: "Build", conclusion: "cancelled", started_at: "2026-09-24T10:00:00Z", completed_at: "2026-09-24T10:00:00Z" },
    { name: "e2e", conclusion: "cancelled", started_at: "2026-09-24T10:00:00Z", completed_at: "2026-09-24T10:00:00Z" },
  ];
  // PEN-5592: plural form of the cancelled label.
  assert.equal(failingJobSummary(jobs), " Cancelled jobs: `Build`, `e2e`.");
});


// ---------------------------------------------------------------------------
// PEN-5592: a deliberate dequeue is not a CI job timeout.
//
// The #3371 timeline, verbatim and all UTC on 2026-11-04. This is the measured
// shape the whole guard exists for, and every case below is a perturbation of
// exactly one field of it.
// ---------------------------------------------------------------------------
// `actor` is an OBJECT, because that is what the REST endpoint returns. An
// earlier revision of this fixture was labelled verbatim while carrying a
// FLATTENED `actor: "kkroo"`, which no caller of this script ever produces --
// the reporter passes the REST response through untouched. That one field is
// why every test below passed while the guard could not fire in production
// (Ally review, PR #3399): re-verified live on #3371, where all four
// merge-queue events carry `actor` of type object.
const PR_3371_TIMELINE = [
  {
    event: "added_to_merge_queue",
    created_at: "2026-11-04T13:11:37Z",
    actor: { login: "kkroo", id: 1234567, type: "User" },
  },
  {
    event: "removed_from_merge_queue",
    created_at: "2026-11-04T13:13:57Z",
    actor: { login: "kkroo", id: 1234567, type: "User" },
  },
];
// The same two events as `scripts/merge-queue-eviction-detector.mjs` hands
// them over: its `ghTimeline` flattens with `--jq '{..., actor: .actor.login}'`
// before calling the shared window selector. Both shapes reach the same
// predicate, so both are pinned here -- that interchangeability IS the fix.
const PR_3371_TIMELINE_FLATTENED = PR_3371_TIMELINE.map((e) => ({ ...e, actor: e.actor.login }));
// Run 41835906627 ended `cancelled` 57s AFTER the dequeue -- the dequeue is the
// cause of the teardown, not a consequence of it.
const PR_3371_RUN_ENDED = "2026-11-04T13:14:54Z";

test("PEN-5592: a dequeue by a non-queue actor before the run ended is attributed to that actor", () => {
  assert.deepEqual(
    manualDequeueExplainingRun(PR_3371_TIMELINE, { runUpdatedAt: PR_3371_RUN_ENDED }),
    { dequeuedAt: "2026-11-04T13:13:57.000Z", dequeuedBy: "kkroo" },
  );
});

test("PEN-5592: a queue-initiated removal is NOT a manual dequeue", () => {
  // The discriminator is the actor and nothing else. Same timeline, same
  // ordering, same everything -- only the login differs, and this is the
  // population whose notice ("rerun the checks, then re-enqueue") is correct.
  const queueRemoved = [
    PR_3371_TIMELINE[0],
    { ...PR_3371_TIMELINE[1], actor: { login: "github-merge-queue[bot]", type: "Bot" } },
  ];
  assert.equal(manualDequeueExplainingRun(queueRemoved, { runUpdatedAt: PR_3371_RUN_ENDED }), null);
  // Case-insensitively, via the sibling's own predicate.
  const shouty = [
    PR_3371_TIMELINE[0],
    { ...PR_3371_TIMELINE[1], actor: { login: "GitHub-Merge-Queue[BOT]", type: "Bot" } },
  ];
  assert.equal(manualDequeueExplainingRun(shouty, { runUpdatedAt: PR_3371_RUN_ENDED }), null);
  // And identically on the flattened shape the sibling detector passes in.
  assert.equal(
    manualDequeueExplainingRun(
      [PR_3371_TIMELINE_FLATTENED[0], { ...PR_3371_TIMELINE_FLATTENED[1], actor: "github-merge-queue[bot]" }],
      { runUpdatedAt: PR_3371_RUN_ENDED },
    ),
    null,
  );
});

test("PEN-5592: the guard fails TOWARD reporting on every missing input", () => {
  // No attribution available -> report, exactly as before PEN-5592. A timeline
  // that stops carrying `actor` must never make a genuine ejection quieter.
  const noActor = [PR_3371_TIMELINE[0], { ...PR_3371_TIMELINE[1], actor: null }];
  assert.equal(manualDequeueExplainingRun(noActor, { runUpdatedAt: PR_3371_RUN_ENDED }), null);
  // Every unattributable shape, flattened and raw. `{}` and `{login: null}` are
  // the ones the object unwrap introduced: a ghost actor must read as "no
  // attribution", never as a named remover, or the unwrap would start
  // SUPPRESSING genuine ejections instead of reporting them.
  for (const actor of [null, undefined, "   ", "", {}, { login: null }, { login: "   " }, { login: 42 }]) {
    assert.equal(
      manualDequeueExplainingRun([PR_3371_TIMELINE[0], { ...PR_3371_TIMELINE[1], actor }], {
        runUpdatedAt: PR_3371_RUN_ENDED,
      }),
      null,
      `actor ${JSON.stringify(actor)} must fail toward reporting`,
    );
  }
  // Enqueued, never removed: the run died on its own.
  assert.equal(manualDequeueExplainingRun([PR_3371_TIMELINE[0]], { runUpdatedAt: PR_3371_RUN_ENDED }), null);
  // No timeline at all / unreadable run end.
  assert.equal(manualDequeueExplainingRun([], { runUpdatedAt: PR_3371_RUN_ENDED }), null);
  assert.equal(manualDequeueExplainingRun(PR_3371_TIMELINE, { runUpdatedAt: undefined }), null);
  assert.equal(manualDequeueExplainingRun(PR_3371_TIMELINE, { runUpdatedAt: "not a date" }), null);
});

test("PEN-5592: a dequeue well AFTER the run already died is not its cause", () => {
  // The direction that would over-suppress. A run that genuinely timed out at
  // 13:14:54 and a hold placed at 14:00 are two unrelated acts;
  // selectLatestQueueAttemptWindow applies no upper bound of its own, so
  // without the skew test the later hold would be read as the cause of the
  // earlier teardown and the real timeout would go unreported.
  const lateHold = [
    PR_3371_TIMELINE[0],
    { event: "removed_from_merge_queue", created_at: "2026-11-04T14:00:00Z", actor: { login: "kkroo", type: "User" } },
  ];
  assert.equal(manualDequeueExplainingRun(lateHold, { runUpdatedAt: PR_3371_RUN_ENDED }), null);
  // Inside the record-ordering tolerance, it still counts: the run conclusion
  // and the timeline event are written by different subsystems.
  const justAfter = [
    PR_3371_TIMELINE[0],
    { event: "removed_from_merge_queue", created_at: "2026-11-04T13:15:30Z", actor: { login: "kkroo", type: "User" } },
  ];
  assert.equal(manualDequeueExplainingRun(justAfter, { runUpdatedAt: PR_3371_RUN_ENDED })?.dequeuedBy, "kkroo");
});

test("PEN-5592: a LATER attempt's dequeue cannot be read as this run's cause", () => {
  // #3371 really was re-enqueued at 20:59:58Z and dequeued again at 21:31:38Z.
  // The 13:14:54 run must still anchor to the 13:13:57 removal -- pins the
  // `now: endedAt` argument, without which the window walks forward to the
  // most recent attempt and attributes an evening hold to a lunchtime run.
  const full = [
    ...PR_3371_TIMELINE,
    { event: "added_to_merge_queue", created_at: "2026-11-04T20:59:58Z", actor: { login: "allyblockcast[bot]", type: "Bot" } },
    { event: "removed_from_merge_queue", created_at: "2026-11-04T21:31:38Z", actor: { login: "kkroo", type: "User" } },
  ];
  assert.equal(
    manualDequeueExplainingRun(full, { runUpdatedAt: PR_3371_RUN_ENDED }).dequeuedAt,
    "2026-11-04T13:13:57.000Z",
  );
});

/**
 * Drives reportMergeQueueFailure with a scripted transport, recording every POST.
 *
 * The timeline arm PAGES, the way the real endpoint does: it honours `page` and
 * `per_page` and slices `timeline` accordingly. A fake that returned the whole
 * array for any `/timeline` path would make the pagination below untestable --
 * and an unpaginated read is what sent a held, long-lived PR back to the
 * "re-enqueue" notice (Ally review, PR #3399).
 */
function fakeGitHub({ timeline, jobs, merged = false, isInMergeQueue = false }) {
  const posts = [];
  const timelinePaths = [];
  const request = async (path, options = {}) => {
    if (path === "/graphql") return { data: { repository: { pullRequest: { merged, isInMergeQueue } } } };
    if (path.includes("/timeline")) {
      timelinePaths.push(path);
      const perPage = Number(new URLSearchParams(path.split("?")[1] ?? "").get("per_page") ?? 100);
      const page = Number(new URLSearchParams(path.split("?")[1] ?? "").get("page") ?? 1);
      return timeline.slice((page - 1) * perPage, page * perPage);
    }
    if (path.includes("/jobs")) return { jobs };
    if (path.includes("/comments") && options.method === "POST") {
      posts.push(JSON.parse(options.body).body);
      return {};
    }
    if (path.includes("/comments")) return [];
    throw new Error(`unexpected request: ${path}`);
  };
  return { request, posts, timelinePaths };
}

const EJECTED_3371 = {
  repository: "Blockcast/paperclip",
  headBranch: "gh-readonly-queue/master/pr-3371-0e757f41",
  conclusion: "cancelled",
  runUrl: "https://github.com/Blockcast/paperclip/actions/runs/41835906627",
  runId: "41835906627",
  runUpdatedAt: PR_3371_RUN_ENDED,
};
// The 12 jobs the real notice listed as "Failing jobs" were killed mid-flight
// by the dequeue. None failed; none timed out.
const KILLED_MID_FLIGHT = [
  { name: "Build", conclusion: "cancelled", started_at: "2026-11-04T13:12:10Z", completed_at: "2026-11-04T13:14:54Z" },
  { name: "policy", conclusion: "cancelled", started_at: "2026-11-04T13:12:10Z", completed_at: "2026-11-04T13:14:54Z" },
];

test("PEN-5592: a deliberate dequeue produces NO notice, and never the re-enqueue instruction", () => {
  // THE REGRESSION. Before this guard, this exact input posted "The merge-group
  // run was cancelled (a job timeout surfaces this way). Failing jobs: ...
  // fix or rerun the failing checks, then re-enqueue the PR." --
  // `allyblockcast[bot]` then re-enqueued #3371 at an unchanged head at
  // 20:59:58Z and the hold had to be reimposed at 21:31:38Z.
  const { request, posts } = fakeGitHub({ timeline: PR_3371_TIMELINE, jobs: KILLED_MID_FLIGHT });
  return reportMergeQueueFailure({ ...EJECTED_3371, request }).then((result) => {
    assert.deepEqual(result, {
      reported: false,
      reason: "manual-dequeue",
      number: 3371,
      dequeuedBy: "kkroo",
    });
    // Not "no comment containing the bad advice" -- NO COMMENT. Asserted on the
    // transport, so it holds however the body is later reworded.
    assert.deepEqual(posts, []);
  });
});

test("PEN-5592: positive control -- a queue-initiated cancel still gets its notice", () => {
  // Mutation-proof pair for the test above: identical input but for the removal
  // actor. If this one stopped posting, the suppression test would pass
  // vacuously and prove nothing. Also pins that the string the regression
  // forbids is genuinely reachable on this path.
  const queueRemoved = [
    PR_3371_TIMELINE[0],
    { ...PR_3371_TIMELINE[1], actor: { login: "github-merge-queue[bot]", type: "Bot" } },
  ];
  const { request, posts } = fakeGitHub({ timeline: queueRemoved, jobs: KILLED_MID_FLIGHT });
  return reportMergeQueueFailure({ ...EJECTED_3371, request }).then((result) => {
    assert.deepEqual(result, { reported: true, number: 3371 });
    assert.equal(posts.length, 1);
    assert.match(posts[0], /then re-enqueue the PR/);
    // And the jobs it names are labelled as what GitHub says they are.
    assert.match(posts[0], /Cancelled jobs: `Build`, `policy`\./);
    assert.doesNotMatch(posts[0], /Failing job/);
  });
});

test("PEN-5592: a cancelled run with no parseable run end fails loud, not open", () => {
  // The guard must not be switchable off by dropping an env var from the
  // workflow: that is the vacuous-green trap one layer up, and it would
  // silently restore the #3371 behaviour on every future cancelled run.
  const { request, posts } = fakeGitHub({ timeline: PR_3371_TIMELINE, jobs: KILLED_MID_FLIGHT });
  return assert
    .rejects(
      () => reportMergeQueueFailure({ ...EJECTED_3371, runUpdatedAt: undefined, request }),
      /parseable runUpdatedAt/,
    )
    .then(() => assert.deepEqual(posts, []));
});

test("PEN-5592: the timeline is not consulted for a `failure` run", () => {
  // Scope discipline. A run GitHub marks `failure` DID fail, so its cause
  // attribution was never in doubt and this guard must not touch it -- the
  // fake transport throws on an unexpected path, so a stray timeline read here
  // fails the test rather than passing silently.
  const { request, posts } = fakeGitHub({
    timeline: PR_3371_TIMELINE,
    jobs: [{ name: "policy", conclusion: "failure", started_at: "2026-11-04T13:12:10Z", completed_at: "2026-11-04T13:14:00Z" }],
  });
  return reportMergeQueueFailure({
    ...EJECTED_3371,
    conclusion: "failure",
    runUpdatedAt: undefined,
    request,
  }).then((result) => {
    assert.deepEqual(result, { reported: true, number: 3371 });
    assert.match(posts[0], /The merge-group run failed and GitHub may have removed/);
    assert.match(posts[0], /Failing job: `policy`\./);
  });
});

test("PEN-5592: the timeline is paginated, so a removal past page 1 still suppresses", async () => {
  // Ally review (PR #3399). The timeline is OLDEST-first and
  // `removed_from_merge_queue` lands late, so on a long-lived PR the removal
  // sits on page 2+. With a single unpaginated read the reporter saw no
  // removal, fell through, and told the reader to re-enqueue -- failing
  // precisely on the repeatedly-held PRs a hold exists to protect.
  const filler = Array.from({ length: 120 }, (_, i) => ({
    event: "commented",
    created_at: `2026-11-04T12:${String(i % 60).padStart(2, "0")}:00Z`,
    actor: { login: "someone", type: "User" },
  }));
  const { request, posts, timelinePaths } = fakeGitHub({
    timeline: [...filler, ...PR_3371_TIMELINE],
    jobs: KILLED_MID_FLIGHT,
  });
  const result = await reportMergeQueueFailure({ ...EJECTED_3371, request });
  assert.deepEqual(result, { reported: false, reason: "manual-dequeue", number: 3371, dequeuedBy: "kkroo" });
  assert.deepEqual(posts, []);
  // It genuinely walked: page 1 was full, so page 2 had to be fetched.
  assert.equal(timelinePaths.length, 2);
  assert.match(timelinePaths[0], /per_page=100&page=1$/);
  assert.match(timelinePaths[1], /per_page=100&page=2$/);
});

test("PEN-5592: a short first page ends the walk without a second request", () => {
  // The common case, and the cost control: 39 events on #3371. A walk that
  // always probed the next page would double this script's timeline reads on
  // every cancelled run for nothing.
  const { request, timelinePaths } = fakeGitHub({ timeline: PR_3371_TIMELINE, jobs: KILLED_MID_FLIGHT });
  return reportMergeQueueFailure({ ...EJECTED_3371, request }).then(() => {
    assert.deepEqual(timelinePaths.length, 1);
  });
});

test("PEN-5592: both actor shapes reach the same verdict", () => {
  // The interchangeability the shared normalizer buys. The reporter passes the
  // raw REST response through; the sibling detector flattens with `--jq` first.
  // If these two ever diverge again, the detectors can contradict each other on
  // one event -- the whole defect this row was filed for.
  assert.deepEqual(
    manualDequeueExplainingRun(PR_3371_TIMELINE, { runUpdatedAt: PR_3371_RUN_ENDED }),
    manualDequeueExplainingRun(PR_3371_TIMELINE_FLATTENED, { runUpdatedAt: PR_3371_RUN_ENDED }),
  );
  assert.deepEqual(
    manualDequeueExplainingRun(PR_3371_TIMELINE_FLATTENED, { runUpdatedAt: PR_3371_RUN_ENDED }),
    { dequeuedAt: "2026-11-04T13:13:57.000Z", dequeuedBy: "kkroo" },
  );
});

test("PEN-5592: timelineActorLogin normalizes both shapes and nothing else", () => {
  // Unit-level pin on the shared helper itself, so a regression names the
  // helper rather than surfacing three layers up as a mysterious missing
  // suppression.
  assert.equal(timelineActorLogin({ login: "kkroo", type: "User" }), "kkroo");
  assert.equal(timelineActorLogin("kkroo"), "kkroo");
  // Idempotent: normalizing an already-normalized value is a no-op, which is
  // what lets both call sites pass through one chokepoint.
  assert.equal(timelineActorLogin(timelineActorLogin({ login: "kkroo" })), "kkroo");
  for (const bad of [null, undefined, "", "   ", {}, { login: null }, { login: "" }, { login: 42 }, 42]) {
    assert.equal(timelineActorLogin(bad), null, `${JSON.stringify(bad)} must not attribute`);
  }
});

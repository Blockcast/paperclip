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
const PR_3371_TIMELINE = [
  { event: "added_to_merge_queue", created_at: "2026-11-04T13:11:37Z", actor: "kkroo" },
  { event: "removed_from_merge_queue", created_at: "2026-11-04T13:13:57Z", actor: "kkroo" },
];
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
    { ...PR_3371_TIMELINE[1], actor: "github-merge-queue[bot]" },
  ];
  assert.equal(manualDequeueExplainingRun(queueRemoved, { runUpdatedAt: PR_3371_RUN_ENDED }), null);
  // Case-insensitively, via the sibling's own predicate.
  const shouty = [PR_3371_TIMELINE[0], { ...PR_3371_TIMELINE[1], actor: "GitHub-Merge-Queue[BOT]" }];
  assert.equal(manualDequeueExplainingRun(shouty, { runUpdatedAt: PR_3371_RUN_ENDED }), null);
});

test("PEN-5592: the guard fails TOWARD reporting on every missing input", () => {
  // No attribution available -> report, exactly as before PEN-5592. A timeline
  // that stops carrying `actor` must never make a genuine ejection quieter.
  const noActor = [PR_3371_TIMELINE[0], { ...PR_3371_TIMELINE[1], actor: null }];
  assert.equal(manualDequeueExplainingRun(noActor, { runUpdatedAt: PR_3371_RUN_ENDED }), null);
  assert.equal(
    manualDequeueExplainingRun([PR_3371_TIMELINE[0], { ...PR_3371_TIMELINE[1], actor: "   " }], { runUpdatedAt: PR_3371_RUN_ENDED }),
    null,
  );
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
    { event: "removed_from_merge_queue", created_at: "2026-11-04T14:00:00Z", actor: "kkroo" },
  ];
  assert.equal(manualDequeueExplainingRun(lateHold, { runUpdatedAt: PR_3371_RUN_ENDED }), null);
  // Inside the record-ordering tolerance, it still counts: the run conclusion
  // and the timeline event are written by different subsystems.
  const justAfter = [
    PR_3371_TIMELINE[0],
    { event: "removed_from_merge_queue", created_at: "2026-11-04T13:15:30Z", actor: "kkroo" },
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
    { event: "added_to_merge_queue", created_at: "2026-11-04T20:59:58Z", actor: "allyblockcast[bot]" },
    { event: "removed_from_merge_queue", created_at: "2026-11-04T21:31:38Z", actor: "kkroo" },
  ];
  assert.equal(
    manualDequeueExplainingRun(full, { runUpdatedAt: PR_3371_RUN_ENDED }).dequeuedAt,
    "2026-11-04T13:13:57.000Z",
  );
});

/** Drives reportMergeQueueFailure with a scripted transport, recording every POST. */
function fakeGitHub({ timeline, jobs, merged = false, isInMergeQueue = false }) {
  const posts = [];
  const request = async (path, options = {}) => {
    if (path === "/graphql") return { data: { repository: { pullRequest: { merged, isInMergeQueue } } } };
    if (path.includes("/timeline")) return timeline;
    if (path.includes("/jobs")) return { jobs };
    if (path.includes("/comments") && options.method === "POST") {
      posts.push(JSON.parse(options.body).body);
      return {};
    }
    if (path.includes("/comments")) return [];
    throw new Error(`unexpected request: ${path}`);
  };
  return { request, posts };
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
    { ...PR_3371_TIMELINE[1], actor: "github-merge-queue[bot]" },
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

import assert from "node:assert/strict";
import { test } from "node:test";

import { detect } from "../ci-mass-cancellation-detector.mjs";

// Fixture data transcribed from the real recurrences documented on
// https://paperclip.blockcast.net/BLO/issues/BLO-21078 — the 2026-08-02
// original incident (comment 44a6683d, kill instant corrected from the raw
// `created_at` table to the actual job-death timestamp) and the 2026-08-11
// recurrence (comment 23095b4e).

function run({ id, branch, event = "pull_request", created, killed }) {
  return {
    id,
    name: "PR",
    conclusion: "cancelled",
    event,
    head_branch: branch,
    created_at: created,
    updated_at: killed,
    html_url: `https://github.com/Blockcast/paperclip/actions/runs/${id}`,
  };
}

const AUG_02_CLUSTER = [
  run({ id: 1, branch: "blo-20613-claude-oom-signal", created: "2026-08-02T19:13:27Z", killed: "2026-08-02T19:34:01Z" }),
  run({ id: 2, branch: "cto/blo-20733-approval-plan-sync", created: "2026-08-02T19:17:29Z", killed: "2026-08-02T19:34:01Z" }),
  run({ id: 3, branch: "blo-20959-slack-job-registration", created: "2026-08-02T19:25:39Z", killed: "2026-08-02T19:34:01Z" }),
  run({ id: 4, branch: "cto/blo-18278-capacity-reset", created: "2026-08-02T19:31:32Z", killed: "2026-08-02T19:34:01Z" }),
];

const AUG_11_CLUSTER = [
  run({ id: 10, branch: "gh-readonly-queue/master/pr-1222-d63", event: "merge_group", created: "2026-08-11T00:09:41Z", killed: "2026-08-11T01:14:54Z" }),
  run({ id: 11, branch: "gh-readonly-queue/master/pr-1222-e24", event: "merge_group", created: "2026-08-11T00:21:52Z", killed: "2026-08-11T01:14:55Z" }),
  run({ id: 12, branch: "gh-readonly-queue/master/pr-1222-8d5", event: "merge_group", created: "2026-08-11T00:23:49Z", killed: "2026-08-11T01:14:56Z" }),
  run({ id: 13, branch: "kkroo/fix-hga-missing-builder", created: "2026-08-11T00:22:56Z", killed: "2026-08-11T01:14:56Z" }),
  run({ id: 14, branch: "fix/blo-24011-capacity-park-observability", created: "2026-08-11T00:36:40Z", killed: "2026-08-11T01:14:57Z" }),
  run({ id: 15, branch: "cto/blo-24191-reviewer-monitor-arm", created: "2026-08-10T23:46:36Z", killed: "2026-08-11T01:14:57Z" }),
  run({ id: 16, branch: "cto/blo-24190-handoff-liveness-bound", created: "2026-08-10T23:41:22Z", killed: "2026-08-11T01:14:58Z" }),
  run({ id: 17, branch: "codex/reopen-pr-821", created: "2026-08-10T23:06:03Z", killed: "2026-08-11T01:14:59Z" }),
];

// Ordinary same-branch `cancel-in-progress` supersession: three unrelated
// branches, each pushed twice, so the stale run on each dies ~1-2s after the
// newer run on that SAME branch was created. This must never fire — no
// shared kill instant across branches is a coincidence here, each is
// individually explained by its own newer push.
const SUPERSESSION_ONLY = [
  run({ id: 20, branch: "feature-a", created: "2026-08-05T10:00:00Z", killed: "2026-08-05T10:05:02Z" }),
  { ...run({ id: 21, branch: "feature-a", created: "2026-08-05T10:05:00Z", killed: "2026-08-05T10:09:00Z" }), conclusion: "success" },
  run({ id: 22, branch: "feature-b", created: "2026-08-05T11:00:00Z", killed: "2026-08-05T11:03:01Z" }),
  { ...run({ id: 23, branch: "feature-b", created: "2026-08-05T11:03:00Z", killed: "2026-08-05T11:07:00Z" }), conclusion: "success" },
  run({ id: 24, branch: "feature-c", created: "2026-08-05T12:00:00Z", killed: "2026-08-05T12:02:01Z" }),
  { ...run({ id: 25, branch: "feature-c", created: "2026-08-05T12:02:00Z", killed: "2026-08-05T12:06:00Z" }), conclusion: "success" },
];

// A single manually-cancelled run with no correlated siblings — below the
// distinct-branch threshold, must not fire.
const ISOLATED_MANUAL_CANCEL = [run({ id: 30, branch: "solo-branch", created: "2026-08-06T09:00:00Z", killed: "2026-08-06T09:04:00Z" })];

test("fires on the 2026-08-02 original incident (backtest)", () => {
  const verdict = detect(AUG_02_CLUSTER, { since: "2026-08-02T00:00:00Z", until: "2026-08-03T00:00:00Z" });
  assert.equal(verdict.firing, true);
  assert.equal(verdict.clusters.length, 1);
  assert.equal(verdict.clusters[0].distinctBranchCount, 4);
  assert.equal(verdict.clusters[0].killWindowStart, "2026-08-02T19:34:01Z");
});

test("fires on the 2026-08-11 recurrence (backtest) using only its pull_request branches by default", () => {
  // merge_group entries are excluded by default (see the module-level note on
  // why: merge-queue cascade-cancel has the same signature as a real
  // incident). The 5 pull_request branches alone still clear the threshold.
  const verdict = detect(AUG_11_CLUSTER, { since: "2026-08-11T00:00:00Z", until: "2026-08-11T02:00:00Z" });
  assert.equal(verdict.firing, true);
  assert.equal(verdict.clusters[0].distinctBranchCount, 5);
  assert.ok(verdict.clusters[0].branches.every((b) => !b.startsWith("gh-readonly-queue/")));
});

test("does not fire on merge-queue cascade-cancel even with many refs (opt-in only, off by default)", () => {
  // Modeled on the real 2026-08-06T02:38:11Z-02:39:13Z pattern: ~20 distinct
  // gh-readonly-queue/master/pr-N-<sha> refs, created over several hours,
  // all cancelled within about a minute of each other when the queue's head
  // entry finally merged. maximumEntriesToBuild=1 makes this routine.
  const cascade = Array.from({ length: 20 }, (_, i) =>
    run({
      id: 100 + i,
      branch: `gh-readonly-queue/master/pr-${900 + i}-${i.toString(16).padStart(40, "0")}`,
      event: "merge_group",
      created: new Date(Date.parse("2026-08-05T22:44:00Z") + i * 7 * 60_000).toISOString(),
      killed: new Date(Date.parse("2026-08-06T02:38:11Z") + i * 2_000).toISOString(),
    }),
  );
  const defaultVerdict = detect(cascade, { since: "2026-08-06T00:00:00Z", until: "2026-08-06T03:00:00Z" });
  assert.equal(defaultVerdict.firing, false);

  const optedIn = detect(cascade, { since: "2026-08-06T00:00:00Z", until: "2026-08-06T03:00:00Z", includeMergeGroup: true });
  assert.equal(optedIn.firing, true);
});

test("does not fire on ordinary same-branch concurrency supersession", () => {
  const verdict = detect(SUPERSESSION_ONLY, { since: "2026-08-05T00:00:00Z", until: "2026-08-06T00:00:00Z" });
  assert.equal(verdict.firing, false);
  assert.equal(verdict.supersessionExcludedCount, 3);
});

test("does not fire on an isolated single cancellation", () => {
  const verdict = detect(ISOLATED_MANUAL_CANCEL, { since: "2026-08-06T00:00:00Z", until: "2026-08-07T00:00:00Z" });
  assert.equal(verdict.firing, false);
});

test("quiet across a 24h window mixing ordinary failures/cancels with no cluster", () => {
  const quietDay = [
    ...SUPERSESSION_ONLY,
    ISOLATED_MANUAL_CANCEL[0],
    run({ id: 31, branch: "another-solo", created: "2026-08-06T14:00:00Z", killed: "2026-08-06T14:02:00Z" }),
  ];
  const verdict = detect(quietDay, { since: "2026-08-05T00:00:00Z", until: "2026-08-07T00:00:00Z" });
  assert.equal(verdict.firing, false);
});

test("does not cluster cancellations that are minutes apart even across many branches", () => {
  const spreadOut = [
    run({ id: 40, branch: "a", created: "2026-08-07T00:00:00Z", killed: "2026-08-07T00:00:00Z" }),
    run({ id: 41, branch: "b", created: "2026-08-07T00:01:00Z", killed: "2026-08-07T00:05:00Z" }),
    run({ id: 42, branch: "c", created: "2026-08-07T00:02:00Z", killed: "2026-08-07T00:10:00Z" }),
  ];
  const verdict = detect(spreadOut, { since: "2026-08-07T00:00:00Z", until: "2026-08-07T01:00:00Z" });
  assert.equal(verdict.firing, false);
});

test("only counts distinct branches, not run count, toward the threshold", () => {
  const sameBranchTwice = [
    run({ id: 50, branch: "x", created: "2026-08-08T00:00:00Z", killed: "2026-08-08T00:10:00Z" }),
    run({ id: 51, branch: "y", created: "2026-08-08T00:05:00Z", killed: "2026-08-08T00:10:02Z" }),
  ];
  const verdict = detect(sameBranchTwice, { since: "2026-08-08T00:00:00Z", until: "2026-08-08T01:00:00Z", minDistinctBranches: 3 });
  assert.equal(verdict.firing, false);
});

test("ignores runs from other workflows", () => {
  const otherWorkflow = AUG_02_CLUSTER.map((r) => ({ ...r, name: "release" }));
  const verdict = detect(otherWorkflow, { since: "2026-08-02T00:00:00Z", until: "2026-08-03T00:00:00Z" });
  assert.equal(verdict.firing, false);
});

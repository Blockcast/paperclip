import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MERGE_QUEUE_EVICTION_MARKER,
  buildEvictionCommentBody,
  buildRunSearchWindow,
  classifyAdmissionEvidence,
  ghHeadChecks,
  classifyMergeQueueEviction,
  extractPaperclipIdentifiers,
  filterMergeGroupRunsForPr,
  isQueueInitiatedRemoval,
  mergeQueueHeadBranchPrefix,
  selectLatestQueueAttemptWindow,
} from "../merge-queue-eviction-detector.mjs";

test("classifies zero merge_group runs as conflict_unstageable, not check_failure", () => {
  // BLO-23395: PR #1092's exact incident shape -- added to the queue,
  // evicted 4.5h later, and zero merge_group runs were ever created for it.
  const classification = classifyMergeQueueEviction({ merged: false, mergeGroupRuns: [] });
  assert.equal(classification, "conflict_unstageable");
  assert.notEqual(classification, "check_failure");
});

// --- PEN-3926: zero runs has two causes; the removal actor separates them ---
//
// Measured on `Blockcast/paperclip` 2026-10-10 over 74 `removed_from_merge_queue`
// events across 56 PRs: 53 attributed to `github-merge-queue[bot]`, 21 to a
// human, zero with an absent actor, and no actor on both sides. Pairing each
// detector notice to the removal that triggered it found 13 notices claiming
// `conflict / un-stageable rebase` for a human-initiated dequeue, across 8 PRs
// -- and 8 of the 13 PRs carrying a human removal went on to MERGE, which an
// un-stageable branch cannot do. The same split was measured independently
// from the webhook side over 108 runs (BLO-40351).

test("PEN-3926: zero runs + queue-bot actor stays conflict_unstageable (the genuine eviction)", () => {
  // PR #1092's removals are all `github-merge-queue[bot]`; this is the
  // positive control that the fix does not make a real eviction quieter.
  const classification = classifyMergeQueueEviction({
    merged: false,
    mergeGroupRuns: [],
    dequeueActor: "github-merge-queue[bot]",
  });
  assert.equal(classification, "conflict_unstageable");
});

test("PEN-3926: zero runs + human actor is a manual dequeue, not a conflict", () => {
  // #2331's four false notices: `kkroo` dequeued a branch reading
  // `mergeable: MERGEABLE`/`CLEAN`, each within minutes of announcing the
  // hold on the thread, and each notice told the reader to rebase it.
  const classification = classifyMergeQueueEviction({
    merged: false,
    mergeGroupRuns: [],
    dequeueActor: "kkroo",
  });
  assert.equal(classification, "manual");
  assert.notEqual(classification, "conflict_unstageable");
});

test("PEN-3926: an App dequeue is manual too -- the test is 'not the queue', not 'is a human'", () => {
  const classification = classifyMergeQueueEviction({
    merged: false,
    mergeGroupRuns: [],
    dequeueActor: "allyblockcast[bot]",
  });
  assert.equal(classification, "manual");
});

test("PEN-3926: an absent or unusable actor keeps the pre-PEN-3926 verdict (fails toward status quo)", () => {
  // The whole fix is gated on positively identifying a non-queue actor. If
  // the timeline stops carrying `actor`, or a caller does not thread it, the
  // classifier must behave exactly as it did before -- a genuine eviction
  // must never be downgraded to `manual` by a missing field.
  for (const dequeueActor of [null, undefined, "", "   ", 42, {}]) {
    assert.equal(
      classifyMergeQueueEviction({ merged: false, mergeGroupRuns: [], dequeueActor }),
      "conflict_unstageable",
      `actor ${JSON.stringify(dequeueActor)} must not change the verdict`,
    );
  }
});

test("PEN-3926: isQueueInitiatedRemoval fails toward 'queue initiated' for anything unusable", () => {
  assert.equal(isQueueInitiatedRemoval("github-merge-queue[bot]"), true);
  assert.equal(isQueueInitiatedRemoval("GitHub-Merge-Queue[bot]"), true, "actor match is case-insensitive");
  assert.equal(isQueueInitiatedRemoval(" github-merge-queue[bot] "), true, "surrounding whitespace is ignored");
  assert.equal(isQueueInitiatedRemoval(null), true);
  assert.equal(isQueueInitiatedRemoval(undefined), true);
  assert.equal(isQueueInitiatedRemoval(""), true);
  assert.equal(isQueueInitiatedRemoval("kkroo"), false);
  assert.equal(isQueueInitiatedRemoval("allyblockcast[bot]"), false);
});

test("PEN-3926: the actor never overrides a failing check, and never un-merges a merge", () => {
  // Deliberately narrow: the actor only arbitrates the ZERO-run branch,
  // where run count genuinely cannot tell the two causes apart. A human who
  // dequeues a PR whose merge_group run already failed is still reported as
  // `check_failure` -- 2 such removals are in the 2026-10-10 sample.
  assert.equal(
    classifyMergeQueueEviction({
      merged: false,
      mergeGroupRuns: [{ conclusion: "failure" }],
      dequeueActor: "kkroo",
    }),
    "check_failure",
  );
  assert.equal(
    classifyMergeQueueEviction({ merged: true, mergeGroupRuns: [], dequeueActor: "kkroo" }),
    "merged",
  );
});

test("PEN-3926: a truncated empty sample stays `unknown` even with a human actor", () => {
  // Truncation is a statement about the evidence, not the cause: an
  // incomplete sample cannot rule out a failing run that the actor says
  // nothing about. `unknown` already declines to prescribe a rebase, so
  // there is nothing to fix here -- assert the ordering so a later change
  // cannot quietly promote a truncated sample to a confident verdict.
  assert.equal(
    classifyMergeQueueEviction({
      merged: false,
      mergeGroupRuns: [],
      truncated: true,
      dequeueActor: "kkroo",
    }),
    "unknown",
  );
});

test("classifies a failing merge_group run as check_failure", () => {
  const classification = classifyMergeQueueEviction({
    merged: false,
    mergeGroupRuns: [{ conclusion: "success" }, { conclusion: "failure" }],
  });
  assert.equal(classification, "check_failure");
});

test("classifies a non-failing merge_group run with no merge as manual", () => {
  const classification = classifyMergeQueueEviction({
    merged: false,
    mergeGroupRuns: [{ conclusion: "success" }],
  });
  assert.equal(classification, "manual");
});

test("classifies a stuck-in-progress run (never reaches a conclusion) that was dequeued as manual, not check_failure", () => {
  // The runbook's existing "stalled head" shape: a merge_group run exists but
  // never terminates, so an SRE manually dequeues it. That is not a check
  // failure -- no check ever concluded failing.
  const classification = classifyMergeQueueEviction({
    merged: false,
    mergeGroupRuns: [{ conclusion: null, status: "in_progress" }],
  });
  assert.equal(classification, "manual");
});

test("classifies merged PRs as merged regardless of run history", () => {
  const classification = classifyMergeQueueEviction({
    merged: true,
    mergeGroupRuns: [],
  });
  assert.equal(classification, "merged");
});

test("classifies a truncated empty sample as unknown, not conflict_unstageable (Ally review #1220)", () => {
  // A `gh run list` sample that hit its cap is not proof of absence -- on a
  // busy repo, this PR's own merge_group run could sit beyond the cap. Only
  // report conflict_unstageable when the empty result is known-complete.
  const classification = classifyMergeQueueEviction({ merged: false, mergeGroupRuns: [], truncated: true });
  assert.equal(classification, "unknown");
  assert.notEqual(classification, "conflict_unstageable");
});

test("a truncated sample with a real match still classifies normally", () => {
  // Truncation only matters when it could be hiding this PR's run; once a
  // match is actually found, the sample answered the question either way.
  const classification = classifyMergeQueueEviction({
    merged: false,
    mergeGroupRuns: [{ conclusion: "failure" }],
    truncated: true,
  });
  assert.equal(classification, "check_failure");
});

test("mergeQueueHeadBranchPrefix matches GitHub's gh-readonly-queue naming", () => {
  assert.equal(mergeQueueHeadBranchPrefix("master", 1092), "gh-readonly-queue/master/pr-1092-");
});

test("filterMergeGroupRunsForPr excludes runs for other PRs, including numeric-prefix collisions", () => {
  const runs = [
    { headBranch: "gh-readonly-queue/master/pr-1092-abc123", conclusion: "success" },
    // Must NOT match PR 1092 despite sharing the "pr-1092" substring.
    { headBranch: "gh-readonly-queue/master/pr-10920-def456", conclusion: "failure" },
    { headBranch: "gh-readonly-queue/master/pr-961-ghi789", conclusion: "success" },
    { headBranch: "refs/heads/master", conclusion: null },
  ];
  const matched = filterMergeGroupRunsForPr(runs, { base: "master", prNumber: 1092 });
  assert.equal(matched.length, 1);
  assert.equal(matched[0].headBranch, "gh-readonly-queue/master/pr-1092-abc123");
});

test("filterMergeGroupRunsForPr on an empty run list returns empty, driving conflict_unstageable end to end", () => {
  // Replays the #1092 incident shape: enumerate every merge_group run in the
  // window (pr-1165, pr-961, pr-1046, pr-1011, pr-988, pr-900, pr-1163,
  // pr-1162, pr-1127 -- no pr-1092) and confirm the detector's full pipeline
  // (filter -> classify) lands on conflict_unstageable.
  const runs = [
    "pr-1165", "pr-961", "pr-1046", "pr-1011", "pr-988", "pr-900", "pr-1163", "pr-1162", "pr-1127",
  ].map((label, i) => ({
    headBranch: `gh-readonly-queue/master/${label}-${"a".repeat(7)}${i}`,
    conclusion: "success",
  }));
  const matched = filterMergeGroupRunsForPr(runs, { base: "master", prNumber: 1092 });
  assert.equal(matched.length, 0);
  assert.equal(classifyMergeQueueEviction({ merged: false, mergeGroupRuns: matched }), "conflict_unstageable");
});

test("selectLatestQueueAttemptWindow picks the most recent enqueue/dequeue pair for a re-queued PR (Ally review #1220)", () => {
  // A PR dequeued once for a failing check, manually re-added, then evicted
  // again for an un-stageable rebase must not have its first attempt's runs
  // leak into the second attempt's classification.
  const events = [
    { event: "added_to_merge_queue", created_at: "2026-08-08T09:00:00Z" },
    { event: "removed_from_merge_queue", created_at: "2026-08-08T09:10:00Z" },
    { event: "added_to_merge_queue", created_at: "2026-08-08T09:24:35Z", actor: "allyblockcast[bot]" },
    { event: "removed_from_merge_queue", created_at: "2026-08-08T13:55:45Z", actor: "github-merge-queue[bot]" },
  ];
  const window = selectLatestQueueAttemptWindow(events, { now: Date.parse("2026-08-08T14:00:00Z") });
  assert.deepEqual(window, {
    enqueuedAt: "2026-08-08T09:24:35.000Z",
    dequeuedAt: "2026-08-08T13:55:45.000Z",
    // PEN-3926: the remover, not the enqueuer -- #1092's real shape, where
    // the App enqueued and the queue itself evicted.
    dequeuedBy: "github-merge-queue[bot]",
  });
});

test("selectLatestQueueAttemptWindow is unaffected by event order in the input array", () => {
  const events = [
    { event: "removed_from_merge_queue", created_at: "2026-08-08T13:55:45Z", actor: "github-merge-queue[bot]" },
    { event: "added_to_merge_queue", created_at: "2026-08-08T09:24:35Z", actor: "allyblockcast[bot]" },
    // PEN-3926: the earlier attempt's removal carries a DIFFERENT actor, so
    // this fixture also fails if the actor is read off the wrong removal --
    // which would invert the verdict, not just mislabel it.
    { event: "removed_from_merge_queue", created_at: "2026-08-08T09:10:00Z", actor: "kkroo" },
    { event: "added_to_merge_queue", created_at: "2026-08-08T09:00:00Z", actor: "kkroo" },
  ];
  const window = selectLatestQueueAttemptWindow(events, { now: Date.parse("2026-08-08T14:00:00Z") });
  assert.deepEqual(window, {
    enqueuedAt: "2026-08-08T09:24:35.000Z",
    dequeuedAt: "2026-08-08T13:55:45.000Z",
    dequeuedBy: "github-merge-queue[bot]",
  });
});

test("selectLatestQueueAttemptWindow reports dequeuedAt: null when still enqueued (no matching removal yet), never a fabricated timestamp (Ally review #1220, 4th pass)", () => {
  // The old behavior substituted `now` for a missing removal, which could
  // misclassify an active or freshly-requeued attempt with no run yet as a
  // real eviction. The caller must retry or decline, not guess.
  const events = [{ event: "added_to_merge_queue", created_at: "2026-08-08T09:24:35Z" }];
  const now = Date.parse("2026-08-08T09:30:00Z");
  const window = selectLatestQueueAttemptWindow(events, { now });
  assert.deepEqual(window, {
    enqueuedAt: "2026-08-08T09:24:35.000Z",
    dequeuedAt: null,
    // PEN-3926: no removal observed means no remover. Never the enqueuer.
    dequeuedBy: null,
  });
});

test("selectLatestQueueAttemptWindow ignores a re-enqueue that lands after `now` (Ally review #1220, grace-period race)", () => {
  // The PR is dequeued (evicted) at 13:55:45, then manually re-added at
  // 13:56:10 -- inside this run's 60s post-dequeue grace-period sleep. `now`
  // is captured at trigger time (13:55:50), before that re-enqueue landed.
  // The window must still classify the dequeue that triggered this run, not
  // jump onto the brand-new attempt that has no runs yet.
  const events = [
    { event: "added_to_merge_queue", created_at: "2026-08-08T09:24:35Z", actor: "allyblockcast[bot]" },
    { event: "removed_from_merge_queue", created_at: "2026-08-08T13:55:45Z", actor: "github-merge-queue[bot]" },
    { event: "added_to_merge_queue", created_at: "2026-08-08T13:56:10Z", actor: "kkroo" },
  ];
  const now = Date.parse("2026-08-08T13:55:50Z");
  const window = selectLatestQueueAttemptWindow(events, { now });
  assert.deepEqual(window, {
    enqueuedAt: "2026-08-08T09:24:35.000Z",
    dequeuedAt: "2026-08-08T13:55:45.000Z",
    dequeuedBy: "github-merge-queue[bot]",
  });
});

test("selectLatestQueueAttemptWindow returns null when no added_to_merge_queue event exists", () => {
  const window = selectLatestQueueAttemptWindow(
    [{ event: "labeled", created_at: "2026-08-08T09:00:00Z" }],
    { now: Date.now() },
  );
  assert.equal(window, null);
});

test("buildRunSearchWindow buffers the window by 5 minutes on each side", () => {
  const range = buildRunSearchWindow({
    enqueuedAt: "2026-08-08T09:24:35.000Z",
    dequeuedAt: "2026-08-08T13:55:45.000Z",
  });
  assert.equal(range, "2026-08-08T09:19:35.000Z..2026-08-08T14:00:45.000Z");
});

test("buildRunSearchWindow throws on an incomplete window instead of emitting a 1970 bound (Ally review #1220, 5th pass)", () => {
  // `selectLatestQueueAttemptWindow` legitimately returns `dequeuedAt: null`
  // for "enqueue found, no removal observed yet", and `new Date(null)` is the
  // epoch -- so the old implementation produced a range ending in 1970, which
  // matches no runs and reads as a genuine zero-run result, i.e. a false
  // `conflict_unstageable`. Failing loudly is the only safe behaviour for a
  // caller that skipped main()'s guard.
  assert.throws(
    () => buildRunSearchWindow({ enqueuedAt: "2026-08-08T09:24:35.000Z", dequeuedAt: null }),
    /complete attempt window/,
  );
  assert.throws(
    () => buildRunSearchWindow({ enqueuedAt: "not-a-date", dequeuedAt: "2026-08-08T13:55:45.000Z" }),
    /complete attempt window/,
  );
});

test("a null attempt window is never classifiable: selectLatestQueueAttemptWindow -> buildRunSearchWindow refuses (Ally review #1220, 5th pass)", () => {
  // The missing-*enqueue* case. A real `dequeued` trigger whose timeline has
  // not replicated the `added_to_merge_queue` yet yields a null window; the
  // detector used to skip both the replication retry and the guard and fall
  // through to an UNBOUNDED merge_group lookup, where a PREVIOUS attempt's
  // runs match the PR-number filter and the eviction is reported as
  // `check_failure`/`manual` instead of `conflict_unstageable`. There is no
  // window to search, and this asserts the type-level fact that makes the
  // unbounded fallback unreachable: nothing downstream can build a range
  // from `null`.
  const window = selectLatestQueueAttemptWindow(
    [{ event: "removed_from_merge_queue", created_at: "2026-08-08T13:55:45Z" }],
    { now: Date.parse("2026-08-08T14:00:00Z") },
  );
  assert.equal(window, null);
  assert.throws(() => buildRunSearchWindow(window ?? { enqueuedAt: null, dequeuedAt: null }), TypeError);
});

test("extractPaperclipIdentifiers finds a ref in the branch name when title/body carry none (Ally review #1220, 4th pass)", () => {
  // The webhook's issue_comment handler has no branch name to fall back on;
  // this is the detector's own safety net -- embed the ref straight into the
  // comment body it posts so the shared extractor's commentBody source
  // picks it up regardless of what the PR's title/body say.
  const ids = extractPaperclipIdentifiers("blo-23395-merge-queue-eviction-detector", "Add a detector", null);
  assert.deepEqual(ids, ["BLO-23395"]);
});

test("extractPaperclipIdentifiers dedupes across sources and expands compact refs", () => {
  const ids = extractPaperclipIdentifiers(
    "fix/BLO-3182-thing",
    "Fixes BLO-3182 and BLO-3763/3764",
    "See also (BLO-3182)",
  );
  assert.deepEqual(new Set(ids), new Set(["BLO-3182", "BLO-3763", "BLO-3764"]));
});

test("extractPaperclipIdentifiers returns empty for a branch/title/body with no ticket ref", () => {
  assert.deepEqual(extractPaperclipIdentifiers("chore/tidy-up", "Tidy up", null), []);
});

// --- producer/consumer marker coupling (Ally review #1220, 5th pass) ---
//
// The detector PRODUCES the eviction comment and the webhook CONSUMES it via
// `body.startsWith(MERGE_QUEUE_EVICTION_MARKER)`. Before these tests the
// producer side was asserted nowhere at all, and the two literals were
// hand-maintained in separate files with no test spanning them. Drift in
// either one silently disables the entire feature -- startsWith returns
// false, no wake ever fires -- with both suites green and no red workflow
// run, because a dequeued PR is not a surface anyone watches. That is the
// same silent-loss class BLO-23395 exists to close, one layer up.
//
// Asserted textually against the TypeScript source rather than by importing
// it: a plain `node --test` .mjs script cannot import from the server's TS
// build, and a shared runtime module spanning both would be a far larger
// change than the coupling warrants.

const WEBHOOK_SOURCE_PATH = new URL("../../server/src/routes/github-webhook.ts", import.meta.url);

test("buildEvictionCommentBody emits the shared marker at byte 0", () => {
  const body = buildEvictionCommentBody({
    repo: "Blockcast/paperclip",
    prNumber: 1092,
    classification: "conflict_unstageable",
    mergeGroupRunCount: 0,
    base: "master",
    identifiers: ["BLO-23395"],
  });

  // Byte 0 exactly: the consumer anchors with startsWith, so a leading
  // newline or indent would be accepted here and dropped there.
  assert.ok(
    body.startsWith(MERGE_QUEUE_EVICTION_MARKER),
    `eviction comment body must start with ${MERGE_QUEUE_EVICTION_MARKER}, got: ${body.slice(0, 80)}`,
  );
});

test("webhook's MERGE_QUEUE_EVICTION_MARKER is byte-identical to the detector's", () => {
  const source = readFileSync(WEBHOOK_SOURCE_PATH, "utf8");
  const match = source.match(/const\s+MERGE_QUEUE_EVICTION_MARKER\s*=\s*"([^"]*)"/);

  assert.ok(
    match,
    `could not find a MERGE_QUEUE_EVICTION_MARKER string literal in ${WEBHOOK_SOURCE_PATH.pathname}. ` +
      "If it was renamed or restructured, update this test in the same change -- do NOT delete it: " +
      "it is the only thing keeping the producer and consumer literals in sync.",
  );
  assert.equal(
    match[1],
    MERGE_QUEUE_EVICTION_MARKER,
    "webhook and detector eviction markers have drifted; the webhook's startsWith gate will never match, " +
      "silently disabling every merge-queue eviction wake.",
  );
});

test("webhook gates the eviction marker with startsWith, not a substring test", () => {
  const source = readFileSync(WEBHOOK_SOURCE_PATH, "utf8");

  // Pins the byte-0 contract the producer test above relies on. A move to
  // `.includes(...)` would let a quoted marker inside an unrelated comment
  // spoof an eviction notice.
  assert.match(source, /\.startsWith\(MERGE_QUEUE_EVICTION_MARKER\)/);
});

// ---------------------------------------------------------------------------
// BLO-40351: the detector's TRIGGER is the thing that failed, not its logic.
//
// Shipped on `pull_request`, this workflow executed on 98/98 dequeues that were
// MERGES and was quarantined in `action_required` with zero jobs on 9/9 dequeues
// that were genuine EVICTIONS -- a perfect inversion, because GitHub keys the
// approval gate on the triggering actor and the actor is itself a function of
// the outcome (`github-merge-queue[bot]` only ever appears on the eviction
// path). It provided zero coverage for the entire time it was deployed while
// showing a 92-green run history, which is positive evidence of the wrong
// thing.
//
// These two tests exist so that regression is caught at PR time -- where it
// would be introduced -- rather than by nobody, which is what happened.
// ---------------------------------------------------------------------------

const DETECTOR_WORKFLOW_PATH = new URL(
  "../../.github/workflows/merge-queue-eviction-detector.yml",
  import.meta.url,
);

test("detector workflow triggers on pull_request_target, never bare pull_request (BLO-40351)", () => {
  const source = readFileSync(DETECTOR_WORKFLOW_PATH, "utf8");
  const onBlock = source.slice(source.search(/^on:$/m));

  assert.match(
    onBlock,
    /^ {2}pull_request_target:\n {4}types:\n {6}- dequeued$/m,
    "the `on:` block must trigger on `pull_request_target` with the `dequeued` activity type. " +
      "A bare `pull_request` trigger is approval-gated for the `github-merge-queue[bot]` actor, " +
      "which fires on EVERY eviction and NO merge -- i.e. it silently disables this detector " +
      "entirely while leaving its run history green. See BLO-40351.",
  );
  assert.doesNotMatch(
    onBlock,
    /^ {2}pull_request:$/m,
    "`pull_request:` reappeared as a trigger key; that is the exact BLO-40351 regression.",
  );
});

test("detector workflow has no half-migrated `pull_request` event_name guard (BLO-40351)", () => {
  const source = readFileSync(DETECTOR_WORKFLOW_PATH, "utf8");

  // The trigger rename is only half the change. Two conditionals gate on
  // `github.event_name`: the trigger-timestamp step, and the `--comment true`
  // argument that is the entire user-visible output. Leaving either comparing
  // against bare 'pull_request' makes every real eviction run, find the
  // eviction, and then decline to notify anybody -- which reads on every
  // dashboard as "ran, found nothing" rather than as a failure.
  assert.doesNotMatch(
    source,
    /event_name\s*==\s*'pull_request'/,
    "a `github.event_name == 'pull_request'` comparison survives alongside the " +
      "`pull_request_target` trigger, so it can never be true. Under the real trigger this " +
      "silently suppresses the eviction comment. Compare against 'pull_request_target'.",
  );
  assert.match(
    source,
    /--comment "\$\{\{ github\.event_name == 'pull_request_target' && 'true'/,
    "the notify step must pass --comment true on the real trigger; without it the detector " +
      "classifies the eviction and tells nobody, which is indistinguishable from no eviction.",
  );
});


test("PEN-3926: selectLatestQueueAttemptWindow reports the actor of the removal it anchored to", () => {
  // #2331's shape: a bot eviction, then three human holds. The window must
  // carry the actor of the removal belonging to THIS attempt -- taking the
  // last removal overall (or the webhook's sender) would attribute an
  // earlier attempt's bot eviction to a later deliberate hold.
  const events = [
    { event: "added_to_merge_queue", created_at: "2026-10-08T17:47:34Z", actor: "kkroo" },
    { event: "removed_from_merge_queue", created_at: "2026-10-08T22:34:32Z", actor: "github-merge-queue[bot]" },
    { event: "added_to_merge_queue", created_at: "2026-10-09T22:36:34Z", actor: "kkroo" },
    { event: "removed_from_merge_queue", created_at: "2026-10-09T22:42:12Z", actor: "kkroo" },
  ];

  const latest = selectLatestQueueAttemptWindow(events, { now: Date.parse("2026-10-09T22:43:00Z") });
  assert.equal(latest.dequeuedBy, "kkroo");
  assert.equal(classifyMergeQueueEviction({
    merged: false,
    mergeGroupRuns: [],
    dequeueActor: latest.dequeuedBy,
  }), "manual");

  // The earlier attempt, classified on its own window, is still the genuine
  // eviction it always was.
  const earlier = selectLatestQueueAttemptWindow(events, { now: Date.parse("2026-10-08T22:35:00Z") });
  assert.equal(earlier.dequeuedBy, "github-merge-queue[bot]");
  assert.equal(classifyMergeQueueEviction({
    merged: false,
    mergeGroupRuns: [],
    dequeueActor: earlier.dequeuedBy,
  }), "conflict_unstageable");
});

test("PEN-3926: a timeline event with no actor yields dequeuedBy: null, never a fabricated login", () => {
  const window = selectLatestQueueAttemptWindow(
    [
      { event: "added_to_merge_queue", created_at: "2026-10-09T22:36:34Z" },
      { event: "removed_from_merge_queue", created_at: "2026-10-09T22:42:12Z" },
    ],
    { now: Date.parse("2026-10-09T22:43:00Z") },
  );
  assert.equal(window.dequeuedBy, null);
  // ...and a null actor keeps the pre-PEN-3926 verdict.
  assert.equal(
    classifyMergeQueueEviction({ merged: false, mergeGroupRuns: [], dequeueActor: window.dequeuedBy }),
    "conflict_unstageable",
  );
});

test("PEN-3926: still-enqueued windows carry dequeuedBy: null alongside dequeuedAt: null", () => {
  const window = selectLatestQueueAttemptWindow(
    [{ event: "added_to_merge_queue", created_at: "2026-10-09T22:36:34Z", actor: "kkroo" }],
    { now: Date.parse("2026-10-09T22:43:00Z") },
  );
  assert.equal(window.dequeuedAt, null);
  assert.equal(window.dequeuedBy, null, "no removal observed means no remover, not the enqueuer");
});

test("PEN-3926: a manual notice names the actor and never prescribes a rebase", () => {
  const body = buildEvictionCommentBody({
    repo: "Blockcast/paperclip",
    prNumber: 2331,
    classification: "manual",
    mergeGroupRunCount: 0,
    base: "master",
    identifiers: ["PEN-2918"],
    dequeueActor: "kkroo",
  });

  assert.ok(body.includes("kkroo"), "a manual notice must name who dequeued it");
  assert.ok(
    !body.includes("rebase onto the current base"),
    "a manual dequeue notice must not instruct anyone to rebase: the branch is typically clean and under a " +
      "deliberate hold, and both a human reader and an automated lander can act on that instruction. This is " +
      "the concrete harm PEN-3926 was filed for.",
  );
  assert.ok(
    !body.includes("un-stageable"),
    "a manual dequeue notice must not assert an un-stageable rebase as the cause",
  );
  assert.ok(
    !body.includes("a `merge_group` run was created"),
    "the actor-attributed manual notice must not claim a run was created -- it is reachable at zero runs",
  );
});

test("PEN-3926: a manual notice without an attributable actor keeps the original run-based wording", () => {
  // The pre-PEN-3926 path into `manual` (a run existed and did not fail) has
  // no actor to name and its original wording is still exactly right. Pin it
  // so the new branch cannot silently rewrite the old one.
  const body = buildEvictionCommentBody({
    repo: "Blockcast/paperclip",
    prNumber: 1092,
    classification: "manual",
    mergeGroupRunCount: 1,
    base: "master",
    identifiers: [],
  });
  assert.ok(body.includes("a `merge_group` run was created for this PR's head and did not"));
});

test("PEN-3926: a conflict_unstageable notice still prescribes the rebase", () => {
  // The remediation line is keyed on classification now; assert the genuine
  // eviction kept its actionable instruction rather than losing it to the
  // `manual` branch.
  const body = buildEvictionCommentBody({
    repo: "Blockcast/paperclip",
    prNumber: 1092,
    classification: "conflict_unstageable",
    mergeGroupRunCount: 0,
    base: "master",
    identifiers: ["BLO-23395"],
    dequeueActor: "github-merge-queue[bot]",
  });
  assert.ok(body.includes("rebase onto the current base"));
  assert.ok(body.includes("un-stageable"));
});

// ---------------------------------------------------------------------------
// PEN-3926: the production wire that feeds a REAL actor into the fix is not
// exercised by any test above. Every PEN-3926 test hands `dequeueActor` to the
// pure functions directly, so the three links that carry a live actor from
// GitHub to the classifier are unpinned:
//
//   1. `ghTimeline`'s jq projection, which must select `.actor.login`;
//   2. `main()` passing `attemptWindow.dequeuedBy` to `classifyMergeQueueEviction`;
//   3. `main()` passing it to `buildEvictionCommentBody`.
//
// Breaking ANY of the three -- a conflict resolution restoring the old
// `.[] | {event, created_at}` projection, or a dropped argument -- is silent:
// `dequeuedBy` becomes `null`, `isQueueInitiatedRemoval(null)` returns `true`
// by its deliberate fail-open, and every zero-run removal is classified
// `conflict_unstageable` again with the rebase instruction restored. The whole
// suite stays green, because the fail-open is exactly what the unit tests
// assert. That is the precise regression PEN-3926 was filed to remove.
//
// Asserted textually for the same reason as the webhook pin above: `main()`
// shells out to `gh`, so there is no way to reach these lines from a unit test
// without a live queue. Ally review #2454.
// ---------------------------------------------------------------------------

const DETECTOR_SOURCE_PATH = new URL("../merge-queue-eviction-detector.mjs", import.meta.url);

test("PEN-3926: the timeline fetch still selects the removal actor", () => {
  const source = readFileSync(DETECTOR_SOURCE_PATH, "utf8");

  assert.match(
    source,
    /--jq",\s*"\.\[\] \| \{event, created_at, actor: \.actor\.login\}"/,
    "`ghTimeline`'s jq projection no longer selects `actor: .actor.login`. Do NOT delete this " +
      "assertion to make the change pass: without the actor, `selectLatestQueueAttemptWindow` " +
      "returns `dequeuedBy: null` on every window, `isQueueInitiatedRemoval(null)` fails open to " +
      "`true`, and every deliberate hold is reported as a conflict / un-stageable rebase again -- " +
      "telling the reader to rebase a clean, deliberately held branch (PEN-3926). The rest of the " +
      "suite cannot see this: it passes the actor to the classifier directly.",
  );
});

test("PEN-3926: main() threads the window's actor into both the classifier and the notice", () => {
  const source = readFileSync(DETECTOR_SOURCE_PATH, "utf8");
  const handoffs = source.match(/dequeueActor:\s*attemptWindow\.dequeuedBy/g) ?? [];

  assert.equal(
    handoffs.length,
    2,
    "expected `dequeueActor: attemptWindow.dequeuedBy` at exactly two call sites -- " +
      "`classifyMergeQueueEviction` (which decides manual vs conflict_unstageable) and " +
      `\`buildEvictionCommentBody\` (which names the remover) -- found ${handoffs.length}. ` +
      "Dropping either one silently restores the pre-PEN-3926 rebase instruction, because the " +
      "classifier's missing-actor fail-open is indistinguishable from a genuine queue eviction.",
  );
});

// ---------------------------------------------------------------------------
// PEN-4887: the queue ADMITTED the entry and ejected it for unmet merge
// requirements -- a third cause of zero `merge_group` runs, previously
// reported as `conflict_unstageable` ("rebase onto the current base") against
// a branch that was zero commits behind its base.
//
// Every fixture below is the measured shape of Blockcast/paperclip#3060 on
// 2026-10-28: stacked child #3061 merged into #3060's branch at 07:46:13Z,
// making that merge commit #3060's new head; #3060 was enqueued at 07:46:17Z
// (+4s) and ejected by `github-merge-queue[bot]` at 07:46:27Z (+10s), while
// `ci/ally-head-attested` did not succeed until 07:48:37Z.
// ---------------------------------------------------------------------------

const PEN4887_HEAD_COMMITTED_AT = "2026-10-28T07:46:13Z";
const PEN4887_ENQUEUED_AT = "2026-10-28T07:46:17Z";
const PEN4887_DEQUEUED_AT = "2026-10-28T07:46:27Z";

/**
 * #3060's head as the check surfaces actually reported it, verbatim -- the
 * full status HISTORY rather than a hand-deduped summary of it, because the
 * history is what `ghHeadChecks` hands the classifier.
 *
 * `GET commits/{sha}/statuses` returns one row per POST, so the two contexts
 * that had succeeded before the removal each appear FOUR times on `87a87dc0`:
 * twice at 07:46, before the 07:46:27Z dequeue, and twice more when they were
 * re-posted at 07:48, after it. Two of those contexts therefore STRADDLE the
 * dequeue, which is the shape that made an earlier revision of this fixture
 * (four rows, pre-deduped) score a bug as correct: counting rows reported both
 * contexts as "not complete at removal" via their 07:48 re-posts.
 *
 * Every check run, by contrast, was either unstarted at the removal or
 * completed minutes after it. That mix is the point -- see the "zero
 * completed" test below.
 */
const PEN4887_HEAD_CHECKS = [
  { name: "gate/ally-comment-findings", conclusion: "success", completedAt: "2026-10-28T07:46:19Z", surface: "status" },
  { name: "review/ally-comment", conclusion: "success", completedAt: "2026-10-28T07:46:21Z", surface: "status" },
  { name: "gate/ally-comment-findings", conclusion: "success", completedAt: "2026-10-28T07:46:23Z", surface: "status" },
  { name: "review/ally-comment", conclusion: "success", completedAt: "2026-10-28T07:46:24Z", surface: "status" },
  // --- the 07:46:27Z dequeue falls here ---
  { name: "gate/ally-comment-findings", conclusion: "success", completedAt: "2026-10-28T07:48:30Z", surface: "status" },
  { name: "review/ally-comment", conclusion: "success", completedAt: "2026-10-28T07:48:31Z", surface: "status" },
  { name: "gate/ally-comment-findings", conclusion: "success", completedAt: "2026-10-28T07:48:35Z", surface: "status" },
  { name: "review/ally-comment", conclusion: "success", completedAt: "2026-10-28T07:48:36Z", surface: "status" },
  // `/check-runs` defaults to `filter=latest`, so these arrive one row per
  // name. `ci/ally-head-attested` is a check RUN on this head, not a status --
  // the status surface is exactly `gate/ally-comment-findings` and
  // `review/ally-comment`, verified on `87a87dc0`.
  { name: "ci/ally-head-attested", conclusion: "success", completedAt: "2026-10-28T07:48:37Z", surface: "check_run" },
  { name: "policy", conclusion: null, completedAt: null, surface: "check_run" },
  { name: "Build", conclusion: null, completedAt: null, surface: "check_run" },
  { name: "Typecheck + Release Registry", conclusion: null, completedAt: null, surface: "check_run" },
];

const admissionRejection = (overrides = {}) =>
  classifyAdmissionEvidence({
    headChecks: PEN4887_HEAD_CHECKS,
    headCommittedAt: PEN4887_HEAD_COMMITTED_AT,
    enqueuedAt: PEN4887_ENQUEUED_AT,
    dequeuedAt: PEN4887_DEQUEUED_AT,
    ...overrides,
  });

test("PEN-4887: the #3060 admission-rejection shape classifies requirements_unmet, not a rebase problem", () => {
  const classification = classifyMergeQueueEviction({
    merged: false,
    mergeGroupRuns: [],
    dequeueActor: "github-merge-queue[bot]",
    admissionEvidence: admissionRejection(),
  });

  assert.equal(
    classification,
    "requirements_unmet",
    "a PR enqueued 4s after its head moved, ejected 10s later with its checks still reporting, is not an " +
      "un-stageable rebase -- #3060's merge base WAS `master`'s head throughout (0 commits behind).",
  );
});

test("PEN-4887 (the other side): a genuine un-stageable eviction still classifies conflict_unstageable", () => {
  // The BLO-23395 shape, which must not become quieter: a settled head whose
  // checks all finished long before the enqueue, evicted by the queue with no
  // `merge_group` run because it could not be replayed onto a moved base.
  //
  // The fixture deliberately CARRIES an incomplete check (`Canary Dry Run`
  // never concluded), so the only thing separating it from the #3060 shape is
  // the head's age at admission. A control whose checks had all completed
  // would pass for the wrong reason, and would score a `rejected` that ignored
  // the fresh-head window as correct.
  const settledChecks = [
    { name: "Build", conclusion: "success", completedAt: "2026-10-28T06:00:00Z" },
    { name: "ci/ally-head-attested", conclusion: "success", completedAt: "2026-10-28T06:01:00Z" },
    { name: "Canary Dry Run", conclusion: null, completedAt: null },
  ];
  const settled = classifyAdmissionEvidence({
    headChecks: settledChecks,
    headCommittedAt: "2026-10-28T05:40:00Z",
    enqueuedAt: "2026-10-28T06:30:00Z",
    dequeuedAt: "2026-10-28T06:30:12Z",
  });

  assert.ok(settled.incompleteAtDequeue.length > 0, "the control must carry an incomplete check, or it proves nothing");
  assert.equal(settled.rejected, false, "a head enqueued 50 minutes after it appeared is not a fresh-head admission");

  // Vary ONLY the head date: the same checks on a head that appeared 4s before
  // the enqueue DO read as an admission rejection. That difference is the
  // whole discriminator.
  const fresh = classifyAdmissionEvidence({
    headChecks: settledChecks,
    headCommittedAt: "2026-10-28T06:29:56Z",
    enqueuedAt: "2026-10-28T06:30:00Z",
    dequeuedAt: "2026-10-28T06:30:12Z",
  });
  assert.equal(fresh.rejected, true, "head age at admission is the signal; nothing else changed between these two");
  assert.equal(
    classifyMergeQueueEviction({
      merged: false,
      mergeGroupRuns: [],
      dequeueActor: "github-merge-queue[bot]",
      admissionEvidence: settled,
    }),
    "conflict_unstageable",
  );
});

test("PEN-4887: 'zero completed checks' alone is NOT the discriminator -- #3060 had completions before removal", () => {
  // Guards the measured correction that shaped this fix. Commit statuses
  // succeeded between the enqueue and the removal, so a predicate of the form
  // "nothing had completed" is FALSE on the very case it was meant to catch.
  const evidence = admissionRejection();

  assert.equal(
    evidence.completedByDequeue,
    2,
    "two CONTEXTS succeeded at or before 07:46:27Z. The eight status rows on this head are those two posted " +
      "four times each; counting rows would say four, which is what the first revision of this fix reported.",
  );
  assert.ok(
    evidence.rejected,
    "the verdict must survive those completions -- it rests on the fresh-head window plus the existential " +
      "'something had not finished', never on a universal 'nothing completed'.",
  );
});

test("PEN-4887 (Ally review, 2nd pass): a context posted twice, straddling the dequeue, counts ONCE and as complete", () => {
  // `GET commits/{sha}/statuses` returns the full post history, not the latest
  // state per context. Both contexts below succeeded BEFORE the 07:46:27Z
  // removal and were re-posted at 07:48, after it. Classifying row by row put
  // each of them in BOTH buckets -- and the notice then printed two finished
  // checks under "Not complete at removal", which is the cause line naming the
  // wrong cause.
  const evidence = admissionRejection();

  for (const name of ["gate/ally-comment-findings", "review/ally-comment"]) {
    assert.ok(
      !evidence.incompleteAtDequeue.includes(name),
      `\`${name}\` succeeded at 07:46:2xZ, before the removal. Its 07:48 re-post must not resurrect it as ` +
        "unfinished -- the notice prints this list verbatim.",
    );
  }

  assert.equal(
    evidence.incompleteAtDequeue.length,
    new Set(evidence.incompleteAtDequeue).size,
    "a context must never be named twice; duplicates are posts, not contexts",
  );
  assert.deepEqual(
    evidence.incompleteAtDequeue,
    ["ci/ally-head-attested", "policy", "Build", "Typecheck + Release Registry"],
    "exactly the contexts with no terminal row at or before the dequeue",
  );
  assert.equal(
    evidence.checkCount,
    6,
    "twelve rows, six distinct contexts -- `checkCount` is the denominator the notice prints, so it must " +
      "count contexts and not posts",
  );
});

test("PEN-4887 (Ally review, 2nd pass): the collapse is anchored to the dequeue, not to the latest row", () => {
  // Why `GET commits/{sha}/status` (combined, latest-per-context) is NOT the
  // fix: its "latest" is latest OVERALL. On #3060 that is the 07:48:35Z
  // re-post, AFTER the removal, so both contexts would still read as
  // incomplete -- the same wrong answer by a different route. The collapse has
  // to pick the latest row at or before the dequeue, which only the history
  // can supply.
  const pendingThenGreen = [
    { name: "policy", conclusion: "pending", completedAt: "2026-10-28T07:46:20Z", surface: "status" },
    { name: "policy", conclusion: "success", completedAt: "2026-10-28T07:48:00Z", surface: "status" },
  ];

  const evidence = admissionRejection({ headChecks: pendingThenGreen });

  assert.deepEqual(
    evidence.incompleteAtDequeue,
    ["policy"],
    "`policy` was still pending when the queue ruled at 07:46:27Z; it went green 93s later. Taking the " +
      "latest row overall would read it as complete and date the verdict to when the detector ran.",
  );
  assert.equal(evidence.completedByDequeue, 0);
  assert.equal(evidence.checkCount, 1, "two posts, one context");
  assert.equal(evidence.rejected, true);
});

test("PEN-4887 (Ally review, 2nd pass): a check run and a status sharing a name stay separate contexts", () => {
  // Not hypothetical: measured on #3060's own head, `gate/ally-comment-findings`
  // is BOTH a commit status that succeeded at 07:46:23Z -- before the
  // 07:46:27Z removal -- and a check run that did not conclude until
  // 07:48:35Z, after it. (`ci/ally-head-attested` is the same shape.)
  //
  // Collapsing the two surfaces by bare name would let the green status mask
  // the unstarted check run, dropping a genuinely unmet context from the
  // evidence. That is the fail-OPEN direction, the one this file refuses to
  // move in, and it would have bitten on the very PR this fix was written for.
  const evidence = admissionRejection({
    headChecks: [
      { name: "gate/ally-comment-findings", conclusion: "success", completedAt: "2026-10-28T07:46:23Z", surface: "status" },
      { name: "gate/ally-comment-findings", conclusion: null, completedAt: "2026-10-28T07:48:35Z", surface: "check_run" },
    ],
  });

  assert.equal(evidence.checkCount, 2, "same name, two surfaces, two contexts");
  assert.equal(evidence.completedByDequeue, 1, "the status completed before the removal");
  assert.deepEqual(
    evidence.incompleteAtDequeue,
    ["gate/ally-comment-findings (check run)"],
    "the unfinished check run must survive the dedupe, and must say which surface it is -- the notice prints " +
      "this list verbatim, and a bare name here sits beside an identically-named context that DID finish, " +
      "which reads exactly like the defect the dedupe fixes",
  );
});

test("PEN-4887 (Ally review, 2nd pass): an unambiguous name is never qualified with its surface", () => {
  // The qualifier is for collisions only. Tagging every name would make the
  // common notice noisier for no reader benefit.
  const evidence = admissionRejection();

  assert.ok(
    evidence.incompleteAtDequeue.every((name) => !/\((check run|status)\)$/.test(name)),
    `no name on this fixture collides across surfaces, so none may be qualified: ${evidence.incompleteAtDequeue}`,
  );
});

test("PEN-4887 (Ally review, 2nd pass): on an identical timestamp the terminal row wins (fails toward the old verdict)", () => {
  // Two rows for one context at the same second is reachable -- statuses carry
  // whole-second precision and are posted in bursts. Counting the context as
  // COMPLETE makes `rejected` less likely, which keeps the status-quo verdict;
  // the opposite tie-break would manufacture incompleteness.
  const sameSecond = [
    { name: "gate/ally-comment-findings", conclusion: "pending", completedAt: "2026-10-28T07:46:19Z", surface: "status" },
    { name: "gate/ally-comment-findings", conclusion: "success", completedAt: "2026-10-28T07:46:19Z", surface: "status" },
  ];

  assert.deepEqual(admissionRejection({ headChecks: sameSecond }).incompleteAtDequeue, []);
  assert.deepEqual(
    admissionRejection({ headChecks: [...sameSecond].reverse() }).incompleteAtDequeue,
    [],
    "and the tie-break must not depend on the order the API happened to return the rows in",
  );
});

test("PEN-4887: completion is judged at the dequeue instant, not at read time", () => {
  // This script runs minutes after the eviction, by which point the head's
  // checks have usually finished. A check that completed AFTER the removal was
  // still incomplete when the queue ruled.
  const evidence = admissionRejection();

  assert.ok(
    evidence.incompleteAtDequeue.includes("ci/ally-head-attested"),
    "`ci/ally-head-attested` succeeded at 07:48:37Z, 2m10s AFTER the 07:46:27Z removal -- reading it as " +
      "complete would date the verdict to when the detector happened to run.",
  );
});

test("PEN-4887: a `pending` commit status does not count as a completion", () => {
  // A commit status is reported in one shot, so `pending` carries an
  // `updated_at` like any other state. Counting it would weaken the guard in
  // the fail-open direction.
  const evidence = classifyAdmissionEvidence({
    headChecks: [{ name: "policy", conclusion: "pending", completedAt: "2026-10-28T07:46:20Z" }],
    headCommittedAt: PEN4887_HEAD_COMMITTED_AT,
    enqueuedAt: PEN4887_ENQUEUED_AT,
    dequeuedAt: PEN4887_DEQUEUED_AT,
  });

  assert.equal(evidence.completedByDequeue, 0);
  assert.deepEqual(evidence.incompleteAtDequeue, ["policy"]);
});

test("PEN-4887: unusable evidence falls back to the pre-PEN-4887 verdict, never to the new class", () => {
  // Same fail-toward-status-quo discipline as PEN-3926: this may never make a
  // genuine eviction quieter.
  const unusable = [
    { label: "no check list at all", input: { headChecks: null } },
    { label: "non-array check list", input: { headChecks: "nope" } },
    { label: "unparseable head commit date", input: { headCommittedAt: "not-a-date" } },
    { label: "unparseable enqueue", input: { enqueuedAt: "not-a-date" } },
    { label: "unparseable dequeue", input: { dequeuedAt: "not-a-date" } },
    { label: "head newer than its own enqueue (a later push)", input: { headCommittedAt: "2026-10-28T07:50:00Z" } },
  ];

  for (const { label, input } of unusable) {
    assert.equal(admissionRejection(input), null, `${label} must yield no evidence, not a guess`);
    assert.equal(
      classifyMergeQueueEviction({
        merged: false,
        mergeGroupRuns: [],
        dequeueActor: "github-merge-queue[bot]",
        admissionEvidence: admissionRejection(input),
      }),
      "conflict_unstageable",
      `${label} must keep the pre-PEN-4887 verdict`,
    );
  }

  // And the default -- a caller that does not thread the evidence at all.
  assert.equal(
    classifyMergeQueueEviction({ merged: false, mergeGroupRuns: [], dequeueActor: "github-merge-queue[bot]" }),
    "conflict_unstageable",
  );
});

test("PEN-4887: admission evidence never overrides a human dequeue, a failing check, or a merge", () => {
  const evidence = admissionRejection();

  assert.equal(
    classifyMergeQueueEviction({ merged: false, mergeGroupRuns: [], dequeueActor: "kkroo", admissionEvidence: evidence }),
    "manual",
    "PEN-3926's manual split is decided first: a person took it out, whatever the head's age",
  );
  assert.equal(
    classifyMergeQueueEviction({
      merged: false,
      mergeGroupRuns: [{ conclusion: "failure" }],
      dequeueActor: "github-merge-queue[bot]",
      admissionEvidence: evidence,
    }),
    "check_failure",
    "a staged run that failed explains the eviction on its own",
  );
  assert.equal(
    classifyMergeQueueEviction({ merged: true, mergeGroupRuns: [], admissionEvidence: evidence }),
    "merged",
  );
  assert.equal(
    classifyMergeQueueEviction({
      merged: false,
      mergeGroupRuns: [],
      truncated: true,
      dequeueActor: "github-merge-queue[bot]",
      admissionEvidence: evidence,
    }),
    "unknown",
    "an incomplete sample is still not proof of absence",
  );
});

test("PEN-4887: the requirements_unmet notice never prescribes a rebase, and names what was unmet", () => {
  const body = buildEvictionCommentBody({
    repo: "Blockcast/paperclip",
    prNumber: 3060,
    classification: "requirements_unmet",
    mergeGroupRunCount: 0,
    base: "master",
    identifiers: ["PEN-4877"],
    dequeueActor: "github-merge-queue[bot]",
    admissionEvidence: admissionRejection(),
  });

  assert.ok(
    !/rebase onto the current base/i.test(body),
    "this instruction is the whole harm: it sends the reader to rebase a branch that is 0 commits behind " +
      `its base, and an automated lander can act on it too. Body was:\n${body}`,
  );
  assert.ok(!/un-stageable rebase\*\*/.test(body), "must not claim the un-stageable-rebase cause");
  assert.match(body, /merge requirements not met at admission/);
  assert.match(body, /4s old/, "names how old the head was when the queue admitted it");
  assert.match(body, /`ci\/ally-head-attested`/, "names a check that had not completed at the removal");
  assert.match(body, /auto-merge/, "points at the primitive that enqueues only once requirements are met");
  assert.ok(body.startsWith(MERGE_QUEUE_EVICTION_MARKER), "still routable by the webhook");
  assert.match(body, /PEN-4877/, "still carries the linked issue for the wake");
});

test("PEN-4887: the conflict_unstageable notice is unchanged and still says to rebase", () => {
  // The other side of the notice change: the genuine cause must keep its
  // remedy. A one-sided assertion ("never says rebase") would score a
  // classifier that returned the new class unconditionally as correct.
  const body = buildEvictionCommentBody({
    repo: "Blockcast/paperclip",
    prNumber: 1092,
    classification: "conflict_unstageable",
    mergeGroupRunCount: 0,
    base: "master",
    identifiers: [],
    dequeueActor: "github-merge-queue[bot]",
  });

  assert.match(body, /conflict \/ un-stageable rebase/);
  assert.match(body, /rebase onto the current base/);
});

test("PEN-4887: a requirements_unmet notice built with no evidence still reads as prose, never `undefined`", () => {
  // `buildEvictionCommentBody` is exported independently of the classifier, so
  // a caller can reach this branch without evidence. Printing `undefineds` at
  // a reader is worse than printing the claim without its numbers.
  const body = buildEvictionCommentBody({
    repo: "Blockcast/paperclip",
    prNumber: 3060,
    classification: "requirements_unmet",
    mergeGroupRunCount: 0,
    base: "master",
    identifiers: [],
  });

  assert.ok(!/undefined|NaN/.test(body), `body must not leak placeholders:\n${body}`);
  assert.match(body, /merge requirements not met at admission/);
  assert.ok(!/rebase onto the current base/i.test(body));
});

test("PEN-4887: main() threads the admission evidence into both the classifier and the notice", () => {
  // Same guard shape as the PEN-3926 handoff test above: the rest of this
  // suite passes the evidence to the classifier directly, so a main() that
  // computed it and forgot to hand it over would leave every assertion green
  // while every live notice kept saying "rebase onto the current base".
  const source = readFileSync(DETECTOR_SOURCE_PATH, "utf8");
  const handoffs = source.match(/^\s*admissionEvidence,$/gm) ?? [];

  assert.equal(
    handoffs.length,
    3,
    "expected `admissionEvidence` shorthand at exactly three sites -- `classifyMergeQueueEviction`, " +
      `\`buildEvictionCommentBody\`, and the printed result -- found ${handoffs.length}.`,
  );
  assert.match(
    source,
    /headCommittedAt:\s*ghHeadCommittedAt\(repo,\s*pr\.headRefOid\)/,
    "the head date must be read SHA-pinned from the PR's own head, not inferred",
  );
});

test("PEN-4887: the head date is read from the COMMITTER date, not the author date", () => {
  // A rebased or cherry-picked commit keeps its original author date, which
  // would read as hours old and silently disable the fresh-head window --
  // restoring the mislabelling with this whole suite green.
  const source = readFileSync(DETECTOR_SOURCE_PATH, "utf8");

  assert.match(source, /\.commit\.committer\.date/);
  assert.ok(
    !/\.commit\.author\.date/.test(source),
    "the author date is attacker- and rebase-controlled relative to when this head actually appeared",
  );
});

test("PEN-4887: ghHeadChecks returns BOTH surfaces -- check runs and commit statuses", () => {
  // Reading only /check-runs would report "nothing completed" for a head whose
  // status contexts had reported, which is the fail-open direction for the
  // incompleteness guard. BOTH of #3060's pre-removal completions were
  // statuses and no check run had concluded by then, so this union is the
  // difference between the guard working and the guard being vacuous.
  //
  // Asserted behaviourally, through the `exec` seam, rather than by grepping
  // the source for the two URLs: a fetch whose result is dropped on the floor
  // still matches a grep.
  const calls = [];
  const exec = (args) => {
    calls.push(args.join(" "));
    if (args.some((arg) => String(arg).includes("/check-runs"))) {
      return '{"name":"Build","conclusion":null,"completedAt":null}\n';
    }
    return '{"name":"review/ally-comment","conclusion":"success","completedAt":"2026-10-28T07:46:24Z"}\n';
  };

  const checks = ghHeadChecks("Blockcast/paperclip", "87a87dc0", exec);

  assert.deepEqual(
    checks.map((check) => check.name).sort(),
    ["Build", "review/ally-comment"],
    `expected one entry from each surface; calls were:\n${calls.join("\n")}`,
  );
  assert.equal(calls.length, 2, "both surfaces must actually be read");

  // Ally review, 2nd pass: each entry must say WHICH surface it came from, or
  // `classifyAdmissionEvidence` collapses the two namespaces by bare name and
  // a green status can mask an unstarted check run of the same name. Asserted
  // here because that dedupe is the only consumer -- without this, dropping
  // the tag from the jq leaves every test green.
  assert.deepEqual(
    Object.fromEntries(checks.map((check) => [check.name, check.surface])),
    { Build: "check_run", "review/ally-comment": "status" },
  );
});

test("PEN-4887: ghHeadChecks returns null -- not [] -- when a surface cannot be read", () => {
  // `[]` is positive evidence ("this head carries no checks") and would let a
  // transient API error classify; `null` means "no evidence" and falls back to
  // the pre-PEN-4887 verdict.
  const thrower = () => {
    throw new Error("gh: API rate limit exceeded");
  };

  assert.equal(ghHeadChecks("Blockcast/paperclip", "87a87dc0", thrower), null);
  assert.equal(ghHeadChecks("Blockcast/paperclip", "", thrower), null, "an absent head SHA is not evidence either");
  assert.equal(
    classifyAdmissionEvidence({
      headChecks: ghHeadChecks("Blockcast/paperclip", "87a87dc0", thrower),
      headCommittedAt: PEN4887_HEAD_COMMITTED_AT,
      enqueuedAt: PEN4887_ENQUEUED_AT,
      dequeuedAt: PEN4887_DEQUEUED_AT,
    }),
    null,
  );
});

test("PEN-4887: a fresh head whose checks HAD all completed is not reported as requirements-unmet", () => {
  // The incompleteness guard, which the fresh-head window alone does not
  // supply. The notice for this class asserts that nothing had finished
  // attesting the head; if everything demonstrably had, that sentence is
  // false and the eviction needs the other explanation. Contrived (a 4s-old
  // head with a fully reported check suite does not occur in practice) and
  // kept anyway, because the alternative is a verdict that cannot be wrong --
  // which is a verdict that is not being checked.
  const evidence = classifyAdmissionEvidence({
    headChecks: [
      { name: "Build", conclusion: "success", completedAt: "2026-10-28T07:46:20Z" },
      { name: "ci/ally-head-attested", conclusion: "success", completedAt: "2026-10-28T07:46:21Z" },
    ],
    headCommittedAt: PEN4887_HEAD_COMMITTED_AT,
    enqueuedAt: PEN4887_ENQUEUED_AT,
    dequeuedAt: PEN4887_DEQUEUED_AT,
  });

  assert.deepEqual(evidence.incompleteAtDequeue, []);
  assert.equal(evidence.rejected, false, "every check on this head had reported before the removal");
  assert.equal(
    classifyMergeQueueEviction({
      merged: false,
      mergeGroupRuns: [],
      dequeueActor: "github-merge-queue[bot]",
      admissionEvidence: evidence,
    }),
    "conflict_unstageable",
  );
});

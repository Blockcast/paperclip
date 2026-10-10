import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MERGE_QUEUE_EVICTION_MARKER,
  buildEvictionCommentBody,
  buildRunSearchWindow,
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

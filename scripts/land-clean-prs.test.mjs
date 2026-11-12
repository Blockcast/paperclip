import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  CAP_STARVED_HOURS,
  CHECK_SETTLE_MINUTES,
  EJECTIONS_BEFORE_HOLD,
  MAX_ENQUEUES_PER_FIRE,
  STALE_ENQUEUE_HOURS,
  STALE_HOLD_HOURS,
  UNLANDED_ELIGIBLE_HOURS,
  alarmExitCode,
  WiringError,
  stateHold,
  statedHoldMarker,
  reviewGateRemedy,
  renderUnlandedEligible,
  unlandedEligible,
  capStarved,
  renderCapStarved,
  everOfferedQueueSlot,
  unlandedNeverQueued,
  allyVerdictAtHead,
  approvalLanes,
  approvalAttestsHead,
  checkSettlement,
  classifyAll,
  classifyFromListing,
  classifyPr,
  failingChecks,
  ejectionsAtHead,
  headMovedAt,
  applyRow,
  applyOrder,
  isFatalGhError,
  RATE_LIMIT_MAX_WAIT_MS,
  EXIT_UNMEASURED,
  ghErrorMessage,
  ghWithTransientRetry,
  isIdempotentGhRead,
  isTransientGhError,
  reportUnmeasured,
  ghWithRateLimitRetry,
  rateLimitWaitMs,
  liveHeadSha,
  isMainModule,
  markFailure,
  latestCheckStates,
  judgeableAgeHours,
  newestCheckStamp,
  renderReceipt,
  renderStalledHolds,
  stalledHolds,
  repoRunner,
  runRepo,
  markCollectFailure,
  settleMinutesFrom,
  sweepRepos,
  targetRepos,
  notifyRepos,
  sweepOrder,
  applyRowNotifyOnly,
  applierFor,
  demoteMergeActions,
  NOTIFY_ONLY_ACTION,
  CODEOWNER_REQUEST_MARKER,
  unsatisfiedOwners,
  codeownersPatternToRegExp,
  fetchCodeownerRules,
  fetchCodeownerEnforcement,
  landRepoHoldReason,
  CODEOWNER_ENFORCEMENT,
  fetchMergeQueueEntries,
  liveMergeQueueEntry,
  impliedOwners,
  isNotFoundGhError,
  ownersForFiles,
  parseCodeowners,
  stripCodeownersComment,
  resolveMergeState,
  UNLANDABLE_MERGE_STATES,
  KNOWN_MERGE_STATES,
  readMergeState,
  fetchMergeStates,
  fetchOpenPrs,
  fetchDefaultBranch,
  NON_DEFAULT_BASE_ACTION,
  MERGE_STATE_PAGE_SIZE,
} from "./land-clean-prs.mjs";

const HEAD = "958587ad1fe1eb52b06ca874c41734c9abdc2a10";
const OTHER = "b3a240ec8c0108eab7e60c36a5a328c00b3a984d";
const NOW = Date.parse("2026-09-13T12:00:00Z");

const ALLY_APP = { login: "allyblockcast[bot]", id: 290875700, type: "Bot" };

/** A canonical Ally body: one heading, one attestation, zero blocking findings. */
function body(head = HEAD, { critical = 0, important = 0, stillPresent = false } = {}) {
  return [
    "## Ally — Consolidated PR Review",
    "",
    `Reviewed head: ${head}`,
    "",
    ...(stillPresent ? ["- **prior:abc1234 important 1** — still-present — not fixed", ""] : []),
    `### Critical Issues (${critical})`,
    "",
    `### Important Issues (${important})`,
  ].join("\n");
}

function review(overrides = {}) {
  return {
    id: 1,
    state: "COMMENTED",
    user: ALLY_APP,
    commit_id: HEAD,
    submitted_at: "2026-09-13T06:00:00Z",
    body: body(),
    ...overrides,
  };
}

function pr(overrides = {}) {
  return {
    number: 1418,
    headRefOid: HEAD,
    author: { login: "allyblockcast[bot]", is_bot: true },
    labels: [],
    autoMergeRequest: null,
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: [{ name: "verify", conclusion: "SUCCESS", completedAt: "2026-09-13T05:00:00Z" }],
    reviewRequests: [],
    reviews: [review()],
    ...overrides,
  };
}

const classify = (overrides) => classifyPr(pr(overrides), { now: NOW });

describe("classifyPr rule order", () => {
  it("skips a human-authored PR before looking at anything else", () => {
    const row = classify({ author: { login: "kkroo", is_bot: false }, labels: [{ name: "do-not-merge" }] });
    assert.equal(row.action, "skip");
    assert.equal(row.reason, "human-author");
  });

  it("skips an opt-out label", () => {
    for (const name of ["do-not-merge", "review-gate-override"]) {
      const row = classify({ labels: [{ name }] });
      assert.equal(row.action, "skip");
      assert.equal(row.reason, `label:${name}`);
    }
  });

  it("skips a draft, however clean it looks", () => {
    // Draft is the author's own opt-out and the only machine-readable form a
    // deliberate sequencing hold reliably takes. trafficcontrol#1726 is the
    // case: draft, CLEAN, Ally-authored, reviewed clean, body reading "Do not
    // merge before magma#1936" — a shared proto field-number space that
    // landing this half alone would break.
    const row = classify({ isDraft: true, mergeStateStatus: "CLEAN" });
    assert.equal(row.action, "skip");
    assert.equal(row.reason, "draft");
    // And it must be decidable without paying for checks and reviews.
    assert.equal(classifyFromListing(pr({ isDraft: true }), { now: NOW }).reason, "draft");
  });

  it("reports a fresh auto-merge request as already-enqueued", () => {
    const row = classify({ autoMergeRequest: { enabledAt: "2026-09-13T10:00:00Z" } });
    assert.equal(row.action, "already-enqueued");
  });

  it(`reports an auto-merge request older than ${STALE_ENQUEUE_HOURS}h as stale-enqueue`, () => {
    const row = classify({ autoMergeRequest: { enabledAt: "2026-09-12T22:00:00Z" } });
    assert.equal(row.action, "stale-enqueue");
  });

  it("skips on any check that is not SUCCESS/NEUTRAL/SKIPPED, naming the state", () => {
    const row = classify({
      statusCheckRollup: [
        { name: "verify", conclusion: "SUCCESS" },
        { name: "e2e", conclusion: "FAILURE" },
      ],
    });
    assert.equal(row.action, "skip");
    assert.equal(row.reason, "checks:FAILURE");
    assert.match(row.detail, /e2e=FAILURE/);
  });

  it("names the STATE when the check's own name contains an `=`", () => {
    // `failingChecks` formats `name=STATE`, and splitting on the FIRST `=`
    // reads the middle of the name instead. Live on this repo 2026-11-02:
    // `Worktree install (NODE_ENV=production)=QUEUED` produced the reason
    // `checks:production)`. Cosmetic while the reason was only a receipt
    // column; `stateHold` now posts it as a sentence on the PR and keys the
    // comment's marker off it, so a mis-split reason is unreadable AND
    // unpredictable as a slug.
    const row = classify({
      statusCheckRollup: [
        { name: "Worktree install (NODE_ENV=production)", conclusion: null, status: "QUEUED" },
      ],
    });
    assert.equal(row.reason, "checks:QUEUED");
    assert.match(row.detail, /Worktree install \(NODE_ENV=production\)=QUEUED/);
  });

  it("treats a check still in flight as not passing", () => {
    const row = classify({
      statusCheckRollup: [{ name: "e2e", conclusion: null, status: "IN_PROGRESS" }],
    });
    assert.equal(row.action, "skip");
    assert.equal(row.reason, "checks:IN_PROGRESS");
  });

  it("holds a clean PR that still has an outstanding code-owner request", () => {
    const row = classify({ reviewRequests: [{ login: "kkroo" }] });
    assert.equal(row.action, "codeowner-review-requested");
    assert.equal(row.detail, "kkroo");
  });

  // PEN-5997. A human approval is credited only when it was submitted after
  // the head it is filed against came into existence, so these fixtures date
  // the head explicitly — exactly as the hydrated `timeline` does in
  // production. `commit_id` cannot carry that on its own: GitHub re-anchors it
  // forward onto the new head, so it reads HEAD on a stale approval too.
  const headCommittedAt = (at) => [{ event: "committed", sha: HEAD, committer: { date: at } }];
  const ownerApproval = (submittedAt) => ({
    id: 2,
    state: "APPROVED",
    user: { login: "kkroo", id: 1845185, type: "User" },
    commit_id: HEAD,
    submitted_at: submittedAt,
    body: "lgtm",
  });

  it("enqueues once the code owner has APPROVED at the current head", () => {
    // POSITIVE CONTROL for the PEN-5997 tightening: the gate must still be
    // satisfiable by a real approval, or it is unsatisfiable rather than safe.
    const row = classify({
      reviewRequests: [{ login: "kkroo" }],
      timeline: headCommittedAt("2026-09-13T04:00:00Z"),
      reviews: [review(), ownerApproval("2026-09-13T07:00:00Z")],
    });
    assert.equal(row.action, "enqueue");
  });

  it("does not credit a re-anchored approval submitted before this head existed", () => {
    // PEN-5997, the measured #1044 shape: `commit_id === headRefOid` is TRUE
    // because GitHub re-anchored it, while the approval predates the head's
    // commit by hours. Crediting it clears a code-owner hold on a tree no
    // human ever read, and this script's output is "merge it".
    const row = classify({
      reviewRequests: [{ login: "kkroo" }],
      timeline: headCommittedAt("2026-09-13T04:00:00Z"),
      reviews: [review(), ownerApproval("2026-09-13T03:00:00Z")],
    });
    assert.equal(row.action, "codeowner-review-requested");
    assert.equal(row.detail, "kkroo");
  });

  it("holds rather than crediting an approval when the head cannot be dated", () => {
    // PEN-5997. No datable timeline event means no stamp, so credit nobody —
    // the posture `impliedOwners` already takes on an unreadable CODEOWNERS.
    const row = classify({
      reviewRequests: [{ login: "kkroo" }],
      timeline: [],
      reviews: [review(), ownerApproval("2026-09-13T07:00:00Z")],
    });
    assert.equal(row.action, "codeowner-review-requested");
  });

  it("skips DIRTY/UNSTABLE/UNKNOWN merge states but enqueues BLOCKED and BEHIND", () => {
    for (const state of ["DIRTY", "UNSTABLE", "UNKNOWN"]) {
      assert.equal(classify({ mergeStateStatus: state }).reason, `mergestate:${state}`);
      assert.equal(classify({ mergeStateStatus: state }).action, "skip");
    }
    for (const state of ["BLOCKED", "BEHIND", "CLEAN"]) {
      assert.equal(classify({ mergeStateStatus: state }).action, "enqueue");
    }
  });

  it("holds UNSTABLE even when the check rule passes, because gh would merge it outright", () => {
    // `gh pr merge --auto` merges immediately for CLEAN, HAS_HOOKS and UNSTABLE
    // (cli/cli isImmediatelyMergeable). A red Ally verdict status is ignored by
    // the check rule, so the mergestate rule is the only thing holding this PR.
    const row = classify({
      mergeStateStatus: "UNSTABLE",
      statusCheckRollup: [
        { name: "verify", conclusion: "SUCCESS" },
        { __typename: "StatusContext", context: "gate/ally-comment-findings", state: "FAILURE" },
      ],
    });
    assert.equal(row.action, "skip");
    assert.equal(row.reason, "mergestate:UNSTABLE");
  });
});

describe("Ally verdict selection (BLO-32240)", () => {
  it("enqueues when an older blocking review is superseded by a newer clean one at the same head", () => {
    const row = classify({
      reviews: [
        review({ id: 5124450619, submitted_at: "2026-09-06T06:28:15Z", body: body(HEAD, { important: 1 }) }),
        review({ id: 5125141599, submitted_at: "2026-09-06T11:13:12Z", body: body(HEAD) }),
      ],
    });
    assert.equal(row.action, "enqueue");
  });

  it("does NOT enqueue when the newest review at that head is the blocking one", () => {
    const row = classify({
      reviews: [
        review({ id: 1, submitted_at: "2026-09-06T06:28:15Z", body: body(HEAD) }),
        review({ id: 2, submitted_at: "2026-09-06T11:13:12Z", body: body(HEAD, { important: 1 }) }),
      ],
    });
    assert.equal(row.action, "skip");
    assert.equal(row.reason, "review:blocking");
  });

  it("treats a still-present prior disposition as blocking", () => {
    const row = classify({ reviews: [review({ body: body(HEAD, { stillPresent: true }) })] });
    assert.equal(row.reason, "review:blocking");
  });

  it("distinguishes a stale-head review from no review at all", () => {
    assert.equal(classify({ reviews: [review({ body: body(OTHER) })] }).reason, "review:stale-head");
    assert.equal(classify({ reviews: [] }).reason, "review:missing");
  });

  it("ignores DISMISSED and PENDING reviews when selecting the verdict", () => {
    const dismissed = classify({ reviews: [review({ state: "DISMISSED" })] });
    assert.equal(dismissed.reason, "review:missing");

    // A dismissed blocking review must not veto a live clean one.
    const row = classify({
      reviews: [
        review({ id: 1, state: "DISMISSED", submitted_at: "2026-09-06T12:00:00Z", body: body(HEAD, { critical: 2 }) }),
        review({ id: 2, submitted_at: "2026-09-06T06:00:00Z", body: body(HEAD) }),
      ],
    });
    assert.equal(row.action, "enqueue");
  });

  it("reads the attestation from the body, not from commit_id", () => {
    // A force-push re-anchored commit_id to the current head while the body
    // still attests the tree that was actually read.
    const row = classify({ reviews: [review({ commit_id: HEAD, body: body(OTHER) })] });
    assert.equal(row.reason, "review:stale-head");

    // And the converse: commit_id is stale but the body attests this head.
    assert.equal(allyVerdictAtHead(pr({ reviews: [review({ commit_id: OTHER })] })).verdict, "clean");
  });

  it("rejects a body carrying more than one attestation as non-canonical", () => {
    const forged = `${body(HEAD)}\nReviewed head: ${OTHER}`;
    assert.equal(classify({ reviews: [review({ body: forged })] }).reason, "review:stale-head");
  });

  it("ignores reviews from identities that are not the Ally App", () => {
    const seat = review({ user: { login: "allyblockcast", id: 296676656, type: "User" } });
    assert.equal(classify({ reviews: [seat] }).reason, "review:missing");
  });
});

describe("per-fire cap", () => {
  it(`enqueues at most ${MAX_ENQUEUES_PER_FIRE} PRs and names the deferred ones`, () => {
    const prs = Array.from({ length: MAX_ENQUEUES_PER_FIRE + 3 }, (_, i) => pr({ number: 100 + i }));
    const rows = classifyAll(prs, { now: NOW });
    assert.equal(rows.filter((r) => r.action === "enqueue").length, MAX_ENQUEUES_PER_FIRE);
    const deferred = rows.filter((r) => r.reason === `cap:${MAX_ENQUEUES_PER_FIRE}-per-fire`);
    assert.equal(deferred.length, 3);
    assert.equal(rows.length, prs.length, "every PR gets exactly one row");
  });

  it("spends the cap on the OLDEST PRs, not the newest listed first (BLO-51664)", () => {
    // `gh pr list` is newest-first; allocating in that order starved the
    // oldest landable PRs on every fire.
    const rows = classifyAll([pr({ number: 3339 }), pr({ number: 3311 }), pr({ number: 3281 })], {
      now: NOW,
      maxEnqueues: 2,
    });
    assert.deepEqual(rows.map((r) => r.action), ["skip", "enqueue", "enqueue"]);
    assert.equal(rows[0].reason, "cap:2-per-fire");
  });

  // Listed NEWEST-FIRST on purpose: that is the order `gh pr list` returns, so
  // an ascending fixture cannot tell age order apart from listing order and
  // would pass against the pre-BLO-51664 allocation too.
  const newestFirst = (...numbers) =>
    [...numbers].sort((a, b) => b - a).map((number) => pr({ number }));

  it("returns rows in listing order, so allocating by age does not scramble the receipt", () => {
    // Allocation order and RECEIPT order are separate concerns. If sorting the
    // candidates also reordered the output, every fire's receipt would stop
    // being comparable with the last one and the diff would be unreadable.
    const listed = newestFirst(290, 300, 310, 320);
    const rows = classifyAll(listed, { now: NOW, maxEnqueues: 2 });
    assert.deepEqual(
      rows.map((r) => r.number),
      listed.map((candidate) => candidate.number),
      "receipt still reads newest-first even though the cap was spent oldest-first",
    );
  });

  it("changes nothing when the cap does not bind", () => {
    // Age order is an allocation rule for a SATURATED fire, not a filter: with
    // budget to spare every eligible PR must still enqueue.
    const rows = classifyAll(newestFirst(290, 300, 310), { now: NOW, maxEnqueues: 10 });
    assert.deepEqual(rows.map((r) => r.action), ["enqueue", "enqueue", "enqueue"]);
  });

  it("lands the oldest PR even while new ones keep arriving at the cap rate", () => {
    // The starvation is self-reinforcing, so it is only visible ACROSS fires:
    // a deferred PR only gets older while the front of the line is defined by
    // recency. With arrivals at the cap rate, listing-order allocation gives
    // every slot to the new arrivals and #300 is deferred forever. A
    // single-fire test cannot distinguish that from a one-off miss.
    let nextNumber = 400;
    let open = [pr({ number: 300 })];
    const perFire = [];
    for (let fire = 0; fire < 3; fire += 1) {
      open = [...newestFirst(nextNumber, nextNumber + 1), ...open];
      nextNumber += 2;
      const rows = classifyAll(open, { now: NOW, maxEnqueues: 2 });
      const won = new Set(rows.filter((r) => r.action === "enqueue").map((r) => r.number));
      perFire.push(won);
      open = open.filter((candidate) => !won.has(candidate.number));
    }
    assert.ok(perFire[0].has(300), "the oldest PR lands on the FIRST fire, not eventually");
    assert.ok(perFire.every((won) => won.size === 2), "and each fire still spends its budget");
  });

  it("sorts a row with no usable number last, so a malformed row cannot take a slot", () => {
    // The age key is read off the PR, so a row without one has no age. It must
    // lose the tiebreak rather than win it: sorting it first would let a
    // malformed row take a slot ahead of a real PR.
    const rows = classifyAll([pr({ number: undefined }), pr({ number: 500 })], {
      now: NOW,
      maxEnqueues: 1,
    });
    assert.equal(rows[1].action, "enqueue", "the real PR takes the slot");
    assert.equal(rows[0].reason, "cap:1-per-fire", "the numberless row is the one deferred");
  });

  it("does not spend cap on PRs that were not enqueueable anyway", () => {
    const rows = classifyAll([pr({ number: 1, mergeStateStatus: "DIRTY" }), pr({ number: 2 })], {
      now: NOW,
      maxEnqueues: 1,
    });
    assert.equal(rows[1].action, "enqueue");
  });

  const clean = () => Array.from({ length: 3 }, (_, i) => pr({ number: 200 + i }));

  it("carries spend across repos, so the cap is per FIRE and not per repo", () => {
    // `runRepo` calls `classifyAll` once per swept repo. Without `spent` the
    // counter restarts each call and the real ceiling is `cap x repos` — the
    // blast radius scaling with the multi-repo knob that makes a classifier
    // bug reach further in the first place.
    const perRepo = [];
    const spent = sweepRepos(["a/one", "a/two", "a/three"], (_repo, carried) => {
      const rows = classifyAll(clean(), { now: NOW, maxEnqueues: 4, spent: carried });
      perRepo.push(rows.filter((r) => r.action === "enqueue").length);
      return rows;
    });
    assert.deepEqual(perRepo, [3, 1, 0], "repo 2 gets the remainder, repo 3 gets nothing");
    assert.equal(spent, 4, "total armed never exceeds the cap");
  });

  it("does not spend budget on an enqueue that failed to apply", () => {
    // A failed enqueue merged nothing, so it must not starve later repos. The
    // opposite reading (counting `enqueue-failed` as spent) lets a repo full of
    // doomed enqueues eat the fire's budget before the sweep reaches the rest.
    const seen = [];
    const spent = sweepRepos(["a/one", "a/two", "a/three"], (repo, carried) => {
      seen.push(carried);
      const rows = classifyAll(clean(), { now: NOW, maxEnqueues: 4, spent: carried });
      if (repo === "a/one") markFailure(rows[0], "boom");
      return rows;
    });
    assert.deepEqual(seen, [0, 2, 4], "repo 1 spends 2 of its 3, not 3");
    assert.equal(spent, 4);
  });

  it("main's per-repo step hands the carried spend to runRepo", () => {
    // The two tests above stub the step, so they cannot see `main` drop the
    // carry. This one composes the real `repoRunner` with a spy in place of
    // `runRepo`: passing a literal 0 would make the cap per repo again.
    const rotted = [];
    const stranded = [];
    const starved = [];
    const calls = [];
    const spy = (...args) => {
      calls.push(args);
      return classifyAll(clean(), { now: NOW, maxEnqueues: 4, spent: args[3] });
    };
    sweepRepos(
      ["a/one", "a/two"],
      repoRunner({
        apply: true,
        settleMinutes: 7,
        rotted,
        stranded,
        run: spy,
        notify: new Set(),
        unreadable: [],
        starved,
        queued: [],
      }),
    );
    assert.deepEqual(
      calls.map(([bag]) => [bag.repo, bag.apply, bag.settleMinutes, bag.spent]),
      [
        ["a/one", true, 7, 0],
        ["a/two", true, 7, 3],
      ],
    );
    // deepEqual is structural, so the empty `rotted`/`stranded` above match
    // any empty array. Identity is what main relies on: `rotted` for the
    // `finally` cohort, `stranded` and `starved` for the --alarm exit code,
    // and a copy in any position would report an empty cohort and exit 0
    // forever. `starved` is pinned for exactly the same reason as `stranded`
    // and from the day it was added (PEN-5391): a cohort threaded by value
    // is a detector that can never fire, which is indistinguishable from the
    // blind spot it was written to close.
    for (const [bag] of calls) {
      assert.equal(bag.rotted, rotted);
      assert.equal(bag.stranded, stranded);
      assert.equal(bag.starved, starved);
    }
  });
});

describe("apply order (PEN-5503)", () => {
  // One PR yields one row, and `classifyAll` has already rewritten every
  // over-budget `enqueue` to `skip`/`cap:` — so the `enqueue` rows ARE the cap
  // winners. Listed NEWEST-FIRST, because that is the order `gh pr list`
  // returns and the order the apply loop used to walk; an ascending fixture
  // could not tell the fix from the defect.
  const enq = (number) => ({ number, action: "enqueue", reason: "mergestate:CLEAN", headSha: HEAD });
  const cor = (number) => ({ number, action: "codeowner-review-requested", detail: "@team" });
  const skip = (number) => ({ number, action: "skip", reason: "checks:settling" });

  // The shape of the 2026-11-04 08:45Z fire, shortened: winners interleaved
  // with notification rows by PR number, oldest winner last.
  const saturated = () => [
    enq(3368), cor(3358), enq(3356), cor(3335), skip(3330), enq(3307), cor(3290), enq(3215),
  ];

  it("hoists every enqueue to the front, oldest first, and leaves the rest alone", () => {
    const rows = saturated();
    assert.deepEqual(
      applyOrder(rows).map((row) => `${row.number}:${row.action[0]}`),
      ["3215:e", "3307:e", "3356:e", "3368:e", "3358:c", "3335:c", "3330:s", "3290:c"],
      "enqueues ascend by number; the remainder keeps its listing order",
    );
  });

  it("returns the SAME row objects, so the loop's in-place writes still reach the receipt", () => {
    // The loop writes `row.detail` and `row.action` on whatever it iterates. If
    // this returned copies, every outcome and every `enqueue-failed` rename
    // would land on a throwaway and the receipt would report the
    // classification instead of the result.
    const rows = saturated();
    const ordered = applyOrder(rows);
    assert.equal(ordered.length, rows.length, "a permutation, not a filter");
    for (const row of rows) assert.ok(ordered.includes(row), `#${row.number} is the same object`);
  });

  it("is an identity when nothing enqueues, which is every notify-only repo", () => {
    // `demoteMergeActions` renames every merge-shaped row before the applier
    // runs there, so this must not shuffle a notify-only fire's work.
    const rows = [cor(600), skip(590), { number: 580, action: NOTIFY_ONLY_ACTION }];
    assert.deepEqual(applyOrder(rows), rows);
    assert.deepEqual(applyOrder([]), []);
    assert.deepEqual(applyOrder(undefined), []);
  });

  it("sorts an enqueue with no usable number last among the enqueues", () => {
    // Same rule as the cap allocation: a row without a number has no age, so
    // it loses the tiebreak rather than jumping the oldest real PR.
    const rows = [enq(undefined), enq(3368), enq(3215)];
    assert.deepEqual(applyOrder(rows).map((row) => row.number), [3215, 3368, undefined]);
  });

  describe("through runRepo, where it decides what a dying fire has already done", () => {
    const quiet = (fn) => {
      const log = console.log;
      const error = console.error;
      console.log = () => {};
      console.error = () => {};
      try {
        return fn();
      } finally {
        console.log = log;
        console.error = error;
      }
    };

    /**
     * Runs a fire whose applier throws a fatal `gh` error on the row named by
     * `failOn`, and reports what had been applied by then.
     *
     * `runRepo` answers a fatal throw with `process.exit(1)`, which would take
     * the test runner with it, so it is swapped for a sentinel throw. That is
     * the behaviour under test, not an inconvenience: the whole defect is that
     * the fire STOPS there.
     */
    const fireUntilFatal = (rows, failOn) => {
      const applied = [];
      const realExit = process.exit;
      const sentinel = new Error("process.exit(1)");
      process.exit = () => {
        throw sentinel;
      };
      try {
        assert.throws(
          () =>
            quiet(() =>
              runRepo({
                repo: "a/one",
                apply: true,
                settleMinutes: 0,
                spent: 0,
                rotted: [],
                stranded: [],
                starved: [],
                queued: [],
                fetch: () => rows.map(({ number }) => ({ number })),
                classify: () => rows,
                applyOne: (_repo, row) => {
                  if (row.number === failOn) {
                    // `isFatalGhError` matches this; a non-fatal throw would be
                    // recorded as `enqueue-failed` and the loop would carry on.
                    throw Object.assign(new Error("gh failed"), {
                      stderr: "API rate limit exceeded for installation",
                    });
                  }
                  applied.push(row.number);
                  return null;
                },
                state: () => {},
              }),
            ),
          (error) => error === sentinel,
          "a fatal gh error ends the fire",
        );
      } finally {
        process.exit = realExit;
      }
      return applied;
    };

    it("has already enqueued every winner when a NOTIFICATION row kills the fire", () => {
      // The amended acceptance case, and the one that separates this fix from
      // the obvious one. `applyRow` mutates remote state for
      // `codeowner-review-requested` as well as `enqueue`, and those rows sit
      // interleaved among the winners by PR number — so merely permuting the
      // winners into age order inside their existing slots leaves the newest
      // winner behind every notification call. Injecting the abort at the
      // FIRST notification is what makes that visible: under listing order it
      // reaches one winner, under a winners-only permutation it still reaches
      // one, and only hoisting the whole cohort reaches all four.
      const rows = saturated();
      assert.deepEqual(
        fireUntilFatal(rows, 3358),
        [3215, 3307, 3356, 3368],
        "every cap winner is spent before any deferrable notification is attempted",
      );
    });

    it("reaches the oldest winners first when an ENQUEUE kills the fire", () => {
      // The budget cannot always be spent in full — this row's own abort is
      // proof. When it cannot, the fairness fix decides WHICH winners a
      // half-spent cap bought, and it must be the oldest. Under listing order
      // the one winner this reaches is #3368, the NEWEST, which is precisely
      // the cohort BLO-51664 deferred on purpose.
      const rows = saturated();
      assert.deepEqual(fireUntilFatal(rows, 3356), [3215, 3307], "oldest first, newest dropped");
    });

    it("leaves the receipt in listing order, with each outcome on its own row", () => {
      // Done-when #2, and the constraint the whole implementation is shaped
      // around: apply order and receipt order differ ON PURPOSE. `rows` is the
      // receipt and must stay diffable against the last fire's, while the
      // in-place writes the loop makes must still land on the right PR.
      const rows = saturated();
      const applied = [];
      quiet(() =>
        runRepo({
          repo: "a/one",
          apply: true,
          settleMinutes: 0,
          spent: 0,
          rotted: [],
          stranded: [],
          starved: [],
          queued: [],
          fetch: () => rows.map(({ number }) => ({ number })),
          classify: () => rows,
          applyOne: (_repo, row) => {
            applied.push(row.number);
            return `touched ${row.number}`;
          },
          state: () => {},
        }),
      );
      assert.deepEqual(
        applied,
        [3215, 3307, 3356, 3368, 3358, 3335, 3330, 3290],
        "control: the loop really did run out of listing order",
      );
      assert.deepEqual(
        rows.map((row) => row.number),
        [3368, 3358, 3356, 3335, 3330, 3307, 3290, 3215],
        "the receipt is still newest-first",
      );
      for (const row of rows) {
        assert.ok(
          String(row.detail).includes(`touched ${row.number}`),
          `#${row.number} carries its OWN outcome, not a neighbour's`,
        );
      }
    });
  });
});

describe("settle floor from the environment", () => {
  // `Number("15m")` is NaN and `ageMinutes < NaN` is false, so an unparseable
  // value reported every rollup as settled — the guard disarming itself in the
  // fail-OPEN direction, silently.
  it("falls back to the default for values that are not a number of minutes", () => {
    // No `undefined` here: the parameter has an env default, so passing it
    // re-reads the ambient environment instead of the fallback this case is
    // named for — a red under `LAND_CLEAN_PRS_SETTLE_MINUTES=30`, which the
    // script itself invites operators to set. The env path is pinned below.
    for (const bad of ["15m", "banana", "", "   ", null, "-5", "NaN"]) {
      assert.equal(settleMinutesFrom(bad), CHECK_SETTLE_MINUTES, `bad input: ${String(bad)}`);
    }
  });

  it("reads the environment when called with no argument", () => {
    const prior = process.env.LAND_CLEAN_PRS_SETTLE_MINUTES;
    try {
      delete process.env.LAND_CLEAN_PRS_SETTLE_MINUTES;
      assert.equal(settleMinutesFrom(), CHECK_SETTLE_MINUTES, "unset falls back to the default");
      process.env.LAND_CLEAN_PRS_SETTLE_MINUTES = "25";
      assert.equal(settleMinutesFrom(), 25, "a good value is honoured");
      process.env.LAND_CLEAN_PRS_SETTLE_MINUTES = "15m";
      assert.equal(settleMinutesFrom(), CHECK_SETTLE_MINUTES, "a bad value cannot disarm the floor");
    } finally {
      if (prior === undefined) delete process.env.LAND_CLEAN_PRS_SETTLE_MINUTES;
      else process.env.LAND_CLEAN_PRS_SETTLE_MINUTES = prior;
    }
  });

  it("honours a real number, including an explicit 0", () => {
    assert.equal(settleMinutesFrom("30"), 30);
    assert.equal(settleMinutesFrom(" 7 "), 7);
    assert.equal(settleMinutesFrom("0"), 0, "0 is a deliberate opt-out, not a bad value");
  });

  it("a bad value cannot let an unsettled rollup read as settled", () => {
    const fresh = [
      { name: "verify", conclusion: "SUCCESS", completedAt: new Date(NOW - 60_000).toISOString() },
    ];
    const settlement = checkSettlement(fresh, { now: NOW, settleMinutes: settleMinutesFrom("15m") });
    assert.equal(settlement.settled, false);
    assert.equal(settlement.reason, "settling");
  });
});

describe("Ally verdict-mirror statuses are not CI checks", () => {
  // Measured on #1681 @c57fafa0: newest attesting review clean, gate red.
  // Shape mirrors `gh pr view --json statusCheckRollup`, which unions
  // CheckRun and StatusContext and tags every row with __typename.
  const ALLY_RED = [
    { __typename: "StatusContext", context: "gate/ally-comment-findings", state: "FAILURE" },
    { __typename: "StatusContext", context: "review/ally-comment", state: "FAILURE" },
    { __typename: "StatusContext", context: "review/ally-complete", state: "FAILURE" },
  ];

  it("does not let a stale Ally status veto a clean review", () => {
    const row = classify({ statusCheckRollup: [{ name: "verify", conclusion: "SUCCESS" }, ...ALLY_RED] });
    assert.equal(row.action, "enqueue", "a red Ally mirror must not block a PR its review says is clean");
    assert.deepEqual(failingChecks(ALLY_RED), []);
  });

  // The exclusion has to reach BOTH check rules, or they disagree about what a
  // check is and the settle guard loses. Green mirrors, so nothing here is
  // about `failingChecks`.
  const ALLY_GREEN = (iso) => [
    { __typename: "StatusContext", context: "review/ally-complete", state: "SUCCESS", createdAt: iso },
    { __typename: "StatusContext", context: "gate/ally-comment-findings", state: "SUCCESS", createdAt: iso },
  ];

  it("counts a mirror-only rollup as nothing attesting the head, not as settled", () => {
    // Fail-open: the rows are non-empty, so the `checks:none` stop never fired
    // and a head with zero CI classified `enqueue`. Asserted through `classify`
    // rather than `checkSettlement` directly: the filter lives at the call site
    // that feeds both check rules, so the helper still reports on whatever set
    // it is handed.
    assert.equal(classify({ statusCheckRollup: ALLY_GREEN("2026-09-13T09:00:00Z") }).reason, "checks:none");
  });

  it("does not let a fresh mirror row reset the settle clock on settled CI", () => {
    // Fail-closed, and this one fired routinely: the normal ordering is
    // CI -> review -> mirror, so the newest row is almost always a mirror.
    const row = classify({
      statusCheckRollup: [
        { name: "verify", conclusion: "SUCCESS", completedAt: "2026-09-13T09:00:00Z" },
        ...ALLY_GREEN("2026-09-13T11:58:00Z"),
      ],
    });
    assert.equal(row.action, "enqueue", "CI settled 3h ago; a 2m-old mirror is not a check");
  });

  it("still blocks on the review itself, so the verdict is not lost", () => {
    const row = classify({
      statusCheckRollup: [{ name: "verify", conclusion: "SUCCESS" }, ...ALLY_RED],
      reviews: [review({ body: body(HEAD, { important: 1 }) })],
    });
    assert.equal(row.reason, "review:blocking");
  });

  it("keeps the bare `review` quality gate and Ally-named check-runs as real checks", () => {
    assert.deepEqual(
      failingChecks([{ __typename: "StatusContext", context: "review", state: "FAILURE" }]),
      ["review=FAILURE"],
    );
    assert.deepEqual(
      failingChecks([{ __typename: "CheckRun", name: "Ally review gate", conclusion: "FAILURE" }]),
      ["Ally review gate=FAILURE"],
    );
  });

  it("does not let the name exclusion swallow a failing check-run", () => {
    // The exclusion is keyed on __typename, not on the name: a CheckRun in the
    // Ally namespace is the workflow that publishes the status, and a red one
    // is a real failure. Excluding it would enqueue past a red required check.
    for (const name of ["review/ally-complete", "gate/ally-comment-findings"]) {
      assert.deepEqual(failingChecks([{ __typename: "CheckRun", name, conclusion: "FAILURE" }]), [
        `${name}=FAILURE`,
      ]);
      assert.equal(
        classify({ statusCheckRollup: [{ __typename: "CheckRun", name, conclusion: "FAILURE" }] })
          .reason,
        "checks:FAILURE",
      );
    }
  });

  it("treats an untyped row as a real check, so the failure is over-hold not over-enqueue", () => {
    assert.deepEqual(failingChecks([{ context: "review/ally-complete", state: "FAILURE" }]), [
      "review/ally-complete=FAILURE",
    ]);
  });

  // The gate publishes the verdict on BOTH surfaces, so every row above has a
  // check-run twin carrying the identical name. Typing on `StatusContext`
  // strips one copy and reads the other as CI. Measured on #1957 @68f3f598.
  const TWINNED = (state, iso) => [
    { __typename: "StatusContext", context: "gate/ally-comment-findings", state, createdAt: iso },
    {
      __typename: "CheckRun",
      name: "gate/ally-comment-findings",
      conclusion: state,
      completedAt: iso,
    },
  ];

  it("strips the check-run twin of an Ally status, so a red mirror cannot read as a red check", () => {
    assert.deepEqual(failingChecks(TWINNED("FAILURE", "2026-09-13T09:00:00Z")), []);
    assert.equal(
      classify({
        statusCheckRollup: [
          { name: "verify", conclusion: "SUCCESS", completedAt: "2026-09-13T09:00:00Z" },
          ...TWINNED("FAILURE", "2026-09-13T09:00:00Z"),
        ],
      }).action,
      "enqueue",
      "a red Ally mirror must not block through its check-run copy either",
    );
  });

  it("counts a twinned mirror-only rollup as nothing attesting the head", () => {
    // The `checks:none` stop, through the other surface: filtering only the
    // status copy leaves a non-empty rollup, so a head with zero CI reads as
    // attested. This is the case the two StatusContext fixtures above missed.
    assert.equal(
      classify({ statusCheckRollup: TWINNED("SUCCESS", "2026-09-13T09:00:00Z") }).reason,
      "checks:none",
    );
  });

  it("does not let a fresh check-run twin reset the settle clock on settled CI", () => {
    // #1981: once the status copy is filtered, the twin is the newest datable
    // row, so it resets the floor on CI that finished hours earlier.
    assert.equal(
      classify({
        statusCheckRollup: [
          { name: "verify", conclusion: "SUCCESS", completedAt: "2026-09-13T09:00:00Z" },
          ...TWINNED("SUCCESS", "2026-09-13T11:58:00Z"),
        ],
      }).action,
      "enqueue",
      "CI settled 3h ago; a 2m-old mirror twin is not a check",
    );
  });

  it("only treats a check-run as a mirror while its status twin is beside it", () => {
    // The twin is what proves it is a duplicate reading. Without one, an
    // Ally-named check-run is the publishing workflow and a red one is real —
    // which is why the exclusion is contextual rather than simply untyped.
    assert.deepEqual(
      failingChecks([
        { __typename: "CheckRun", name: "gate/ally-comment-findings", conclusion: "FAILURE" },
        { __typename: "StatusContext", context: "review/ally-complete", state: "SUCCESS" },
      ]),
      ["gate/ally-comment-findings=FAILURE"],
    );
  });

  it("reads a passing Ally-named check-run with no status twin as CI (documented over-enqueue direction)", () => {
    // Pins the split the `withoutAllyVerdictMirrors` comment documents: only a
    // FAILURE orphan over-holds. A passing orphan is a row attesting the head,
    // so `checks:none` does not fire and classification falls through to the
    // review rules. `reviews: []` makes that landing deterministic; the row is
    // 6h before NOW so `checks:settling` is not in play.
    for (const conclusion of ["SUCCESS", "NEUTRAL", "SKIPPED"]) {
      const row = classify({
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            name: "gate/ally-comment-findings",
            conclusion,
            completedAt: "2026-09-13T06:00:00Z",
          },
        ],
        reviews: [],
      });
      assert.notEqual(row.reason, "checks:none", `${conclusion} orphan is a row attesting the head`);
      assert.equal(row.reason, "review:missing");
    }
  });
});

describe("approval rot (BLO-33208)", () => {
  const HUMAN = { login: "kkroo", id: 169, type: "User" };
  const BOT = { login: "allyblockcast[bot]", id: 290875700, type: "Bot" };
  const approval = (user) => ({ state: "APPROVED", user, commit_id: HEAD, submitted_at: "2026-09-09T14:38:50Z" });

  it("splits approvers by identity, not by a `[bot]` login suffix", () => {
    // A suffix is a naming convention any account may adopt; `type` is the
    // identity. Conflating them overstated this ticket's own cohort by ~2.7x.
    const lanes = approvalLanes({
      reviews: [
        approval(HUMAN),
        approval(BOT),
        approval({ login: "looks-like-a[bot]", type: "User" }),
        { state: "COMMENTED", user: HUMAN },
      ],
    });
    assert.deepEqual(lanes, { human: ["kkroo", "looks-like-a[bot]"], bot: ["allyblockcast[bot]"] });
  });

  it("reports a conflicted PR that spent a human approval as its own action", () => {
    // The priority cohort: finished, reviewed, and unmergeable because master
    // moved. Its own action so the receipt tally carries the count instead of
    // burying it among every other skip.
    const row = classify({ mergeStateStatus: "DIRTY", reviews: [review(), approval(HUMAN)] });
    assert.equal(row.action, "approval-rotted");
    assert.equal(row.reason, "mergestate:DIRTY");
    assert.match(row.detail, /spent human approval: kkroo/);
  });

  it("names a bot-only approval separately, since no scarce resource was spent", () => {
    const row = classify({ mergeStateStatus: "DIRTY", reviews: [review(), approval(BOT)] });
    assert.equal(row.action, "approval-rotted");
    assert.match(row.detail, /bot-only approval: allyblockcast\[bot\]/);
  });

  it("leaves an unapproved conflicted PR as a plain skip", () => {
    const row = classify({ mergeStateStatus: "DIRTY" });
    assert.equal(row.action, "skip");
    assert.equal(row.reason, "mergestate:DIRTY");
  });

  it("reports the conflict, never a check, on a DIRTY PR (BLO-32606)", () => {
    // GitHub cannot evaluate a `paths:` filter on a PR whose merge commit will
    // not compute, so path-filtered workflows are silently never dispatched and
    // the surviving checks mean nothing. Measured on onprem-k8s#3269: 4 runs
    // dirty, 22 for the identical tree once mergeable.
    const row = classify({
      mergeStateStatus: "DIRTY",
      statusCheckRollup: [{ name: "verify", conclusion: "FAILURE", completedAt: "2026-09-13T05:00:00Z" }],
      reviews: [review(), approval(HUMAN)],
    });
    assert.equal(row.reason, "mergestate:DIRTY", "the conflict is the true and only actionable cause");
  });

  it("does not spend enqueue cap on a rotted PR, and never enqueues it", () => {
    const rows = classifyAll(
      [pr({ mergeStateStatus: "DIRTY", reviews: [review(), approval(HUMAN)] }), pr({ mergeStateStatus: "CLEAN" })],
      { now: NOW, maxEnqueues: 1 },
    );
    assert.deepEqual(rows.map((r) => r.action), ["approval-rotted", "enqueue"]);
  });
});

describe("check settling floor (BLO-33208 bucket-B age floor)", () => {
  const at = (iso) => [{ name: "verify", conclusion: "SUCCESS", completedAt: iso }];

  it("treats a rollup with zero rows as a stop, not a pass", () => {
    // Nothing reporting means nothing attested this head, which renders
    // identically to every check passing.
    assert.deepEqual(checkSettlement([], { now: NOW }), { settled: false, reason: "none" });
    assert.equal(classify({ statusCheckRollup: [] }).reason, "checks:none");
  });

  it(`holds an all-green rollup whose newest check is under ${CHECK_SETTLE_MINUTES}m old`, () => {
    // Green only because the reds have not registered yet.
    const row = classify({ statusCheckRollup: at("2026-09-13T11:56:00Z") });
    assert.equal(row.reason, "checks:settling");
    assert.match(row.detail, /4\.0m ago, floor 15m/);
  });

  it("enqueues once the newest check has been green past the floor", () => {
    assert.equal(classify({ statusCheckRollup: at("2026-09-13T11:40:00Z") }).action, "enqueue");
  });

  it("does not hold forever on rows carrying no parseable timestamp", () => {
    // A commit status never moves on its own, so holding undatable rows would
    // be permanent — the immortal-stale-verdict shape. `--auto` re-gates, so
    // enqueuing early is the bounded direction.
    assert.deepEqual(checkSettlement([{ name: "verify", conclusion: "SUCCESS" }], { now: NOW }), {
      settled: true,
    });
  });
});

describe("multi-repo sweep", () => {
  it("parses a comma-separated repo list and defaults to this repo", () => {
    // The rot is not repo-local: it has been hand-cleaned four times and
    // regrown in the same repos, because each sweep only looked at one.
    assert.deepEqual(targetRepos("Blockcast/trafficcontrol, Blockcast/multicast"), [
      "Blockcast/trafficcontrol",
      "Blockcast/multicast",
    ]);
    // Same rule as `settleMinutesFrom` above, and for the same reason: no
    // `undefined` here, because the parameter has an env default and passing it
    // re-reads the ambient environment instead of the fallback. `""` and `null`
    // cover the empty path; the env path is pinned below.
    assert.deepEqual(targetRepos(""), ["Blockcast/paperclip"]);
    assert.deepEqual(targetRepos(null), ["Blockcast/paperclip"]);
    assert.deepEqual(targetRepos("Blockcast/paperclip,,  "), ["Blockcast/paperclip"]);
  });

  it("reads the environment when called with no argument", () => {
    const prior = process.env.LAND_CLEAN_PRS_REPO;
    try {
      delete process.env.LAND_CLEAN_PRS_REPO;
      assert.deepEqual(targetRepos(), ["Blockcast/paperclip"], "unset falls back to this repo");
      process.env.LAND_CLEAN_PRS_REPO = "Blockcast/multicast,Blockcast/trafficcontrol";
      assert.deepEqual(targetRepos(), ["Blockcast/multicast", "Blockcast/trafficcontrol"]);
    } finally {
      if (prior === undefined) delete process.env.LAND_CLEAN_PRS_REPO;
      else process.env.LAND_CLEAN_PRS_REPO = prior;
    }
  });
});

describe("notify-only repos (PEN-5430)", () => {
  // One list used to answer two unrelated questions — where to NOTIFY a
  // human-gated hold, and where to ARM `gh pr merge --auto`. Adding a repo for
  // the first silently bought the second. These pin the split.

  const NOW_ISO = "2026-09-13T12:00:00Z";
  const OLD_CHECK = "2026-09-12T20:00:00Z"; // 16h before NOW_ISO, past STALE_HOLD_HOURS
  const atNow = (fn) => {
    const real = Date.now;
    Date.now = () => Date.parse(NOW_ISO);
    try {
      return fn();
    } finally {
      Date.now = real;
    }
  };
  const quiet = (fn) => {
    const log = console.log;
    console.log = () => {};
    try {
      return fn();
    } finally {
      console.log = log;
    }
  };
  /** Three PRs that really do classify `enqueue` through the real classifier. */
  const landable = () => Array.from({ length: 3 }, (_, i) => pr({ number: 400 + i }));

  it("parses the notify list and defaults to EMPTY, not to this repo", () => {
    // The default matters as much as the parsing: an unset variable must leave
    // the routine behaving exactly as it did before this split, and a notify
    // list that defaulted to anything would start commenting somewhere nobody
    // asked for on the next fire.
    assert.deepEqual(notifyRepos("Blockcast/penstock-llm-proxy-core"), [
      "Blockcast/penstock-llm-proxy-core",
    ]);
    assert.deepEqual(notifyRepos("Blockcast/one, Blockcast/two"), ["Blockcast/one", "Blockcast/two"]);
    assert.deepEqual(notifyRepos(""), []);
    assert.deepEqual(notifyRepos(null), []);
    assert.deepEqual(notifyRepos("  ,, "), []);
  });

  it("reads the environment when called with no argument", () => {
    const prior = process.env.LAND_CLEAN_PRS_NOTIFY_REPO;
    try {
      delete process.env.LAND_CLEAN_PRS_NOTIFY_REPO;
      assert.deepEqual(notifyRepos(), [], "unset notifies nowhere");
      process.env.LAND_CLEAN_PRS_NOTIFY_REPO = "Blockcast/penstock-llm-proxy-core";
      assert.deepEqual(notifyRepos(), ["Blockcast/penstock-llm-proxy-core"]);
    } finally {
      if (prior === undefined) delete process.env.LAND_CLEAN_PRS_NOTIFY_REPO;
      else process.env.LAND_CLEAN_PRS_NOTIFY_REPO = prior;
    }
  });

  it("sweeps the union, land repos first, with no repo visited twice", () => {
    assert.deepEqual(sweepOrder(["a/land"], ["b/notify"]), ["a/land", "b/notify"]);
    assert.deepEqual(sweepOrder(["a/land"], []), ["a/land"]);
    assert.deepEqual(sweepOrder([], ["b/notify"]), ["b/notify"]);
    // A repo named in both is swept ONCE. Which mode it gets is the next test;
    // what matters here is that it is not classified and reported twice.
    assert.deepEqual(sweepOrder(["a/both", "a/land"], ["a/both"]), ["a/both", "a/land"]);
  });

  it("gives a repo named in BOTH lists the notify-only mode", () => {
    // The restrictive reading wins on purpose. Worst case under this
    // precedence is that nothing lands somewhere it could have, which the
    // receipt prints as `notify-only`. Worst case under the other is that a
    // typo in the notify list arms an autolander in a human-gated repo — the
    // exact failure this row exists to make unreachable.
    const seen = [];
    const spy = ({ repo, landable = true }) => {
      seen.push([repo, landable]);
      return [];
    };
    const notify = new Set(["a/both"]);
    quiet(() =>
      sweepRepos(
        sweepOrder(["a/both", "a/land"], [...notify]),
        repoRunner({
          apply: true,
          settleMinutes: 0,
          rotted: [],
          stranded: [],
          run: spy,
          notify,
          unreadable: [],
          starved: [],
          queued: [],
        }),
      ),
    );
    assert.deepEqual(seen, [
      ["a/both", false],
      ["a/land", true],
    ]);
  });

  it("calls runRepo with the UNCHANGED argument vector when nothing is notify-only", () => {
    // The options bag is spread in conditionally rather than always passed, so
    // a fire with no notify list is byte-identical to the pre-split one. Pinned
    // because the obvious implementation (always pass the bag) would make every
    // existing argument-vector assertion assert a new trailing slot instead.
    //
    // PEN-5536 converted both signatures to named bags, so there is no slot to
    // count any more and the invariant is stated directly: `landable` is
    // ABSENT from the bag in a land repo, which is what lets `runRepo`'s own
    // default supply it. The assertion is on
    // the bag NOT being appended, not on the number 6.
    const calls = [];
    const spy = (...args) => (calls.push(args), []);
    quiet(() =>
      sweepRepos(
        ["a/one"],
        repoRunner({
          apply: true,
          settleMinutes: 7,
          rotted: [],
          stranded: [],
          run: spy,
          unreadable: [],
          starved: [],
          queued: [],
        }),
      ),
    );
    assert.equal(calls[0].length, 1, "one named bag, never a positional vector");
    assert.ok(
      !("landable" in calls[0][0]),
      "no `landable` key when the notify list is empty, so runRepo's own default applies",
    );
  });

  // ---- The acceptance criterion: zero enqueues, structurally. ----

  it("produces ZERO `enqueue` actions in a notify-only repo", () => {
    // Driven through the REAL classifier on PRs that really are landable, so
    // this cannot pass by stubbing the classification. The control asserts the
    // same three PRs DO read `enqueue` in a land repo — without it, a test
    // that broke the fixture would report the guarantee it stopped testing.
    const run = (notifyOnly) =>
      quiet(() =>
        atNow(() =>
          runRepo({
            repo: "a/repo",
            apply: true,
            settleMinutes: 0,
            spent: 0,
            rotted: [],
            stranded: [],
            starved: [],
            queued: [],
            fetch: landable,
            applyOne: () => null,
            state: () => {},
            ...(notifyOnly ? { landable: false } : {}),
          }),
        ),
      );

    const control = run(false);
    assert.deepEqual(
      control.map((row) => row.action),
      ["enqueue", "enqueue", "enqueue"],
      "control: these PRs are genuinely landable",
    );

    const rows = run(true);
    assert.equal(
      rows.filter((row) => row.action === "enqueue").length,
      0,
      "a notify-only repo enqueues nothing",
    );
    assert.deepEqual(
      rows.map((row) => row.action),
      [NOTIFY_ONLY_ACTION, NOTIFY_ONLY_ACTION, NOTIFY_ONLY_ACTION],
    );
    // The receipt must say why, not merely stop saying `enqueue`.
    for (const row of rows) assert.match(row.detail, /notify-only repo: would have `enqueue`/);
  });

  it("has no reachable `gh pr merge` call on the notify-only path", () => {
    // The structural half. `applyRowNotifyOnly` does not branch on a flag — it
    // is a different function with no merge call in it — so this asserts over
    // EVERY action the lander acts on, including ones a classifier bug could
    // hand it in a repo where they should be impossible.
    const issued = [];
    const run = (args) => {
      issued.push(args);
      return "[]";
    };
    for (const action of ["enqueue", "stale-enqueue", "already-enqueued", "hold", "skip"]) {
      assert.equal(
        applyRowNotifyOnly("o/r", { number: 7, action, headSha: HEAD }, run),
        null,
        `${action} is a no-op on the notify-only path`,
      );
    }
    assert.deepEqual(issued, [], "not one gh invocation of any kind");
  });

  it("selects the notify-only applier for a notify-only repo", () => {
    // Defence in depth, asserted on the selection itself.
    //
    // Two guards stop a notify-only repo enqueuing: `demoteMergeActions`
    // renames the row before the apply loop, and `applierFor` hands that loop
    // an applier with no merge call in it. They are REDUNDANT by construction
    // — after the demotion both appliers behave identically on every action
    // that exists — so no stub driven through `runRepo` can distinguish them,
    // and reverting the selection to `applyRow` passed the whole suite while
    // it lived in a parameter default. This asserts the choice directly, which
    // is the only place it is observable.
    assert.equal(applierFor(false), applyRowNotifyOnly, "notify-only repos get the inert applier");
    assert.equal(applierFor(true), applyRow, "land repos keep the real one");
  });

  it("merges nothing in a notify-only repo even when a row reaches apply reading `enqueue`", () => {
    // Defence in depth, pinned at the WIRING level rather than by calling
    // `applyRowNotifyOnly` directly.
    //
    // Two independent guards stop a notify-only repo enqueuing:
    // `demoteMergeActions` renames the row before the apply loop, and
    // `runRepo` hands that loop an applier with no merge call in it. Because
    // the first fires on every ordinary path, the second is never exercised by
    // a test that lets classification run — reverting the applier default to
    // `applyRow` passed the whole suite until this test existed, which is to
    // say the second guard was asserted nowhere.
    //
    // So: stub `classify` to hand the apply loop a live `enqueue` row, exactly
    // as a future classifier bug or a dropped demotion would, and assert the
    // merge still does not happen. `gh` is reached through `applyRow`'s own
    // `run` seam, so a merge attempt would be visible here as an invocation.
    const issued = [];
    const run = (args) => {
      issued.push(args);
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ headRefOid: HEAD });
      if (args[0] === "api") return "[]";
      return "";
    };
    quiet(() =>
      atNow(() =>
        runRepo({
          repo: "b/notify",
          apply: true,
          settleMinutes: 0,
          spent: 0,
          rotted: [],
          stranded: [],
          starved: [],
          queued: [],
          landable: false,
          fetch: () => [pr({ number: 600 })],
          classify: () => [{ number: 600, action: "enqueue", reason: "mergestate:CLEAN", headSha: HEAD }],
          // No `applyOne` override: the point is which applier `runRepo` picks.
          applyRun: run,
          state: () => {},
        }),
      ),
    );
    assert.deepEqual(
      issued.filter((args) => args[0] === "pr" && args[1] === "merge"),
      [],
      "a notify-only repo issues no `gh pr merge`, even handed a live enqueue row",
    );
  });

  it("still posts the code-owner notification, and still only once", () => {
    // The whole point of the notify list: this comment is what a human-gated
    // repo is being added for. The dedupe PEN-5263 built must survive the
    // split, so the second fire against a PR that already carries the marker
    // posts nothing.
    const issued = [];
    const run = (existing) => (args) => {
      issued.push(args);
      if (args[0] === "api") return JSON.stringify(existing);
      return "";
    };
    const row = { number: 2959, action: "codeowner-review-requested", detail: "@Blockcast/team" };

    assert.equal(applyRowNotifyOnly("o/r", row, run([])), "posted");
    const posted = issued.find((args) => args[0] === "pr" && args[1] === "comment");
    assert.ok(posted, "first fire comments");
    assert.ok(posted.at(-1).startsWith(CODEOWNER_REQUEST_MARKER), "under the dedupe marker");

    issued.length = 0;
    assert.equal(
      applyRowNotifyOnly("o/r", row, run([{ body: `${CODEOWNER_REQUEST_MARKER}\nalready here` }])),
      "already-posted",
    );
    assert.deepEqual(
      issued.filter((args) => args[0] === "pr"),
      [],
      "second fire posts nothing",
    );
  });

  it("does not tell a notify-only repo that CODEOWNERS is unenforced there", () => {
    // Ally review, PR #3365. The land-repo sentence — "GitHub does not enforce
    // CODEOWNERS on this repository" — is FALSE in the repo this notify list
    // was built for: `penstock-llm-proxy-core`#2959 reads BLOCKED /
    // REVIEW_REQUIRED against a CODEOWNERS of
    // `* @Blockcast/onprem-k8s-ally-reviewer @kkroo`. Posting it would tell the
    // one human the notification exists to reach that their review does not
    // count, and `commentOnce` dedupes on the marker, so it would be permanent
    // per PR and unreplaceable without changing the marker.
    const bodyFrom = (applier) => {
      let posted = null;
      applier(
        "o/r",
        { number: 2959, action: "codeowner-review-requested", detail: "@Blockcast/team" },
        (args) => {
          if (args[0] === "api") return "[]";
          posted = args.at(-1);
          return "";
        },
      );
      return posted;
    };

    const notifyBody = bodyFrom(applyRowNotifyOnly);
    const landBody = bodyFrom(applyRow);

    assert.doesNotMatch(notifyBody, /does not enforce CODEOWNERS/);
    assert.match(notifyBody, /does not land pull requests in this repository/);
    assert.match(notifyBody, /waiting on the requested review/);
    // Control: the two appliers really do differ.
    //
    // PEN-6522 narrowed what the land arm says but not THAT it differs. The
    // land sentence is now derived per repo, and this row carries no
    // verdict, so it is the UNKNOWN wording — which still must not tell
    // anyone their review is unenforced.
    assert.match(landBody, /could not be read from here/);
    assert.doesNotMatch(landBody, /does not enforce CODEOWNERS/);
    assert.notEqual(notifyBody, landBody);
    // Both still carry the dedupe marker and the outstanding owner.
    for (const body of [notifyBody, landBody]) {
      assert.ok(body.startsWith(CODEOWNER_REQUEST_MARKER));
      assert.match(body, /@Blockcast\/team/);
    }
  });

  it("does not print a per-fire cap in a repo the cap cannot throttle", () => {
    // Ally review, PR #3365. `classifyAll` applies MAX_ENQUEUES_PER_FIRE and
    // rewrites the overflow to `skip`/`cap:N-per-fire` BEFORE
    // `demoteMergeActions` can see it, so a notify-only repo would print a
    // throttle that does not apply to it — routinely, since it happens as soon
    // as the land repos spend the cap or the notify repo holds more than N
    // clean PRs. Here the budget is pre-spent to the ceiling, which is exactly
    // the state a land repo would leave behind.
    const many = () => Array.from({ length: MAX_ENQUEUES_PER_FIRE + 2 }, (_, i) => pr({ number: 700 + i }));
    const actionsIn = (landableRepo) =>
      quiet(() =>
        atNow(() =>
          runRepo({
            repo: "b/repo",
            apply: true,
            settleMinutes: 0,
            spent: MAX_ENQUEUES_PER_FIRE,
            rotted: [],
            stranded: [],
            starved: [],
            queued: [],
            landable: landableRepo,
            fetch: many,
            applyOne: () => null,
            state: () => {},
          }),
        ),
      ).map((row) => row.reason);

    // Control: a land repo arriving with the budget spent DOES print the cap.
    assert.ok(
      actionsIn(true).every((reason) => /^cap:/.test(reason)),
      "control: the cap is real and visible in a land repo",
    );
    assert.deepEqual(
      actionsIn(false).filter((reason) => /^cap:/.test(reason)),
      [],
      "a notify-only repo never names a throttle it is not subject to",
    );
  });

  it("spends no enqueue budget, so a notify repo cannot starve the lander", () => {
    // `sweepRepos` tallies rows still reading `enqueue` against
    // MAX_ENQUEUES_PER_FIRE. If a notify-only repo kept that name, adding a
    // repo for NOTIFICATIONS would throttle the repos that actually land —
    // the same coupling this split removes, re-entering through the cap.
    const notify = new Set(["b/notify"]);
    const spent = quiet(() =>
      atNow(() =>
        sweepRepos(
          sweepOrder(["a/land"], [...notify]),
          repoRunner({
            apply: true,
            settleMinutes: 0,
            rotted: [],
            stranded: [],
            unreadable: [],
            starved: [],
            queued: [],
            run: (bag) =>
              runRepo({
                ...bag,
                fetch: landable,
                applyOne: () => null,
                state: () => {},
              }),
            notify,
          }),
        ),
      ),
    );
    assert.equal(spent, 3, "only the land repo's three rows are spend");
  });

  it("makes no `stated-hold` write in a notify-only repo", () => {
    // In a notify-only repo the ONLY write is the code-owner notification. A
    // `stated-hold:*` comment there is the routine explaining its own inaction
    // in a repo where that inaction is the policy — and the narrowest write
    // surface is what makes this safe to ask a human to grant.
    //
    // The fixture must be a REAL stale hold or the test is vacuous: the first
    // version of it used the default rollup stamp, 7h before NOW against a
    // 13h bar, so `stalledHolds` returned nothing and the assertion held with
    // the gate removed. `OLD_CHECK` is 16h, past STALE_HOLD_HOURS, and the
    // land-repo control below is what proves the cohort is non-empty.
    const held = () => [
      pr({
        number: 500,
        mergeStateStatus: "DIRTY",
        statusCheckRollup: [{ name: "verify", conclusion: "SUCCESS", completedAt: OLD_CHECK }],
      }),
    ];
    const statedIn = (landableRepo) => {
      const stated = [];
      quiet(() =>
        atNow(() =>
          runRepo({
            repo: "b/repo",
            apply: true,
            settleMinutes: 0,
            spent: 0,
            rotted: [],
            stranded: [],
            starved: [],
            queued: [],
            landable: landableRepo,
            fetch: held,
            applyOne: () => null,
            state: (_repo, row) => stated.push(row),
          }),
        ),
      );
      return stated;
    };

    assert.equal(statedIn(true).length, 1, "control: this IS a stale hold a land repo states");
    assert.deepEqual(statedIn(false), [], "no hold is stated in a repo we are a guest in");
  });

  it("does not age a notify-only row into the stale-hold cohort", () => {
    // The hold never clears by design, so aging it would park every clean PR
    // in the repo in the stale-hold cohort permanently.
    const rows = demoteMergeActions([{ number: 1, action: "enqueue", reason: "mergestate:CLEAN" }]);
    assert.equal(rows[0].action, NOTIFY_ONLY_ACTION);
    assert.deepEqual(
      stalledHolds([{ number: 1, statusCheckRollup: [] }], rows, { now: Date.parse(NOW_ISO) }),
      [],
    );
  });

  it("does not report a notify-only row as stranded, so --alarm stays honest", () => {
    // `unlandedEligible` keys on `enqueue` and `--alarm` exits non-zero on a
    // non-empty cohort. A clean PR in a notify-only repo is not stranded; it is
    // held by policy, and alarming on it would turn the detector permanently
    // red for working as designed.
    const rows = demoteMergeActions([{ number: 1, action: "enqueue", reason: "mergestate:CLEAN" }]);
    assert.deepEqual(unlandedEligible([{ number: 1, statusCheckRollup: [] }], rows), []);
  });

  it("refuses to disarm a human's auto-merge in a notify-only repo", () => {
    // `stale-enqueue` runs `gh pr merge --disable-auto`. We never armed it
    // there, so a wedged request belongs to a human — disarming it is as much
    // not-ours-to-do as arming one.
    const rows = demoteMergeActions([{ number: 2, action: "stale-enqueue", reason: "enqueued:30h" }]);
    assert.equal(rows[0].action, NOTIFY_ONLY_ACTION);
    assert.match(rows[0].detail, /would have `stale-enqueue`/);
  });
});

describe("helpers", () => {
  it("decides the cheap rules from the listing alone and defers the rest", () => {
    // These three need no checks and no reviews, so the fetcher must not pay
    // two API calls for them.
    const listing = (overrides) => classifyFromListing(pr(overrides), { now: NOW });
    assert.equal(listing({ author: { login: "kkroo", is_bot: false } }).reason, "human-author");
    assert.equal(listing({ labels: [{ name: "do-not-merge" }] }).reason, "label:do-not-merge");
    assert.equal(
      listing({ autoMergeRequest: { enabledAt: "2026-09-13T10:00:00Z" } }).action,
      "already-enqueued",
    );

    // Anything else is undecided until its checks and reviews are fetched.
    assert.equal(listing({}), null);

    // And the deferred verdict must not change when routed through classifyPr.
    assert.equal(classifyPr(pr({ labels: [{ name: "do-not-merge" }] }), { now: NOW }).reason, "label:do-not-merge");
  });

  it("keeps only the newest attempt per check name", () => {    const states = latestCheckStates([
      { name: "verify", conclusion: "FAILURE", completedAt: "2026-09-13T05:00:00Z" },
      { name: "verify", conclusion: "SUCCESS", completedAt: "2026-09-13T06:00:00Z" },
    ]);
    assert.deepEqual([...states], [["verify", "SUCCESS"]]);
    assert.deepEqual(failingChecks([{ name: "lint", state: "SUCCESS" }]), []);
  });

  it("does not let a green status context shadow a failing check-run of the same name", () => {
    // The two surfaces are independent namespaces inside one rollup, so the
    // newest row must be picked within each — not across both.
    const rollup = [
      {
        __typename: "CheckRun",
        name: "verify",
        conclusion: "FAILURE",
        completedAt: "2026-09-13T05:00:00Z",
      },
      {
        __typename: "StatusContext",
        context: "verify",
        state: "SUCCESS",
        createdAt: "2026-09-13T06:00:00Z",
      },
    ];
    assert.deepEqual(failingChecks(rollup), ["verify=FAILURE"]);
    assert.equal(classify({ statusCheckRollup: rollup }).reason, "checks:FAILURE");
  });

  it("counts a team review request as never satisfied by a login approval", () => {
    assert.deepEqual(
      unsatisfiedOwners({
        headRefOid: HEAD,
        reviewRequests: [{ slug: "reviewers" }],
        reviews: [{ state: "APPROVED", user: { login: "kkroo" }, commit_id: HEAD }],
      }),
      ["team:reviewers"],
    );
  });

  it("does not credit an approval recorded against a different head", () => {
    assert.deepEqual(
      unsatisfiedOwners({
        headRefOid: HEAD,
        reviewRequests: [{ login: "kkroo" }],
        reviews: [{ state: "APPROVED", user: { login: "kkroo" }, commit_id: OTHER }],
      }),
      ["kkroo"],
    );
  });

  it("classifies rate-limit and auth failures as fatal to the fire", () => {
    assert.ok(isFatalGhError("API rate limit exceeded for installation"));
    assert.ok(isFatalGhError("HTTP 401: Bad credentials"));
    assert.ok(!isFatalGhError("Pull request is in the merge queue"));
  });

  it("does not run main() when imported", () => {
    // Passing `undefined` would re-trigger the parameter default (process.argv[1]),
    // so name the paths explicitly.
    assert.equal(isMainModule("", "file:///tmp/land-clean-prs.mjs"), false);
    assert.equal(isMainModule("/tmp/other.mjs", "file:///tmp/land-clean-prs.mjs"), false);
    assert.equal(isMainModule("/tmp/land-clean-prs.mjs", "file:///tmp/land-clean-prs.mjs"), true);
  });
});

describe("applyRow", () => {
  /**
   * Regression for BLO-36804. `gh pr merge --auto` only infers a merge method
   * when the PR base branch has a merge queue, so a PR targeting a stacked
   * feature branch failed with "--merge, --rebase, or --squash required" on 9
   * consecutive fires while still reporting `enqueue`.
   */
  it("arms auto-merge with an explicit merge method", () => {
    const calls = [];
    // PEN-4887: the row carries its classified head and the live read agrees,
    // so the enqueue proceeds exactly as before.
    const outcome = applyRow("o/r", { number: 7, action: "enqueue", headSha: HEAD }, (args) => {
      calls.push(args);
      return JSON.stringify({ headRefOid: HEAD });
    });
    // Not "armed": the same call queues, arms, or merges outright depending on
    // the base, and this defect was a receipt naming an action it had not taken.
    assert.equal(outcome, "merge requested");
    assert.deepEqual(calls.at(-1), [
      "pr", "merge", "7", "--repo", "o/r", "--auto", "--rebase", "--match-head-commit", HEAD,
    ]);
  });

  /**
   * Ally review, 2nd pass. The re-read above is check-then-act: the head can
   * still move between `pr view` and `pr merge`. `--match-head-commit` hands
   * GitHub the SHA every gate in this row was evaluated against, so the server
   * refuses the merge atomically if the head moved inside that window.
   *
   * What this pins down is that the flag is present and carries the row's own
   * head rather than a constant or an unrelated SHA. It cannot distinguish
   * `row.headSha` from the re-read value, because the guard above has already
   * thrown unless the two are equal -- that equality is the point, not an
   * untested branch.
   */
  it("pins the merge to the head the row was classified against, atomically", () => {
    const calls = [];
    applyRow("o/r", { number: 7, action: "enqueue", headSha: HEAD }, (args) => {
      calls.push(args);
      return JSON.stringify({ headRefOid: HEAD });
    });

    const merge = calls.at(-1);
    const pinned = merge[merge.indexOf("--match-head-commit") + 1];
    assert.equal(pinned, HEAD, "the pin must be the classified head");
    assert.notEqual(pinned, OTHER);
  });

  /**
   * PEN-4887. `fetchOpenPrs` snapshots every PR once per fire; landing a
   * stacked child into this PR's branch replaces its head with the merge
   * commit, on which nothing has run. #3060 was enqueued 4s after that
   * happened and ejected by the queue 10s later, 2m10s before
   * `ci/ally-head-attested` even succeeded.
   */
  it("refuses to enqueue when the head moved since classification", () => {
    const calls = [];
    assert.throws(
      () =>
        applyRow("o/r", { number: 3060, action: "enqueue", headSha: HEAD }, (args) => {
          calls.push(args);
          return JSON.stringify({ headRefOid: OTHER });
        }),
      /head moved since classification/,
    );
    assert.ok(
      !calls.some((args) => args[0] === "pr" && args[1] === "merge"),
      `must not reach the merge call; calls were ${JSON.stringify(calls)}`,
    );
  });

  it("fails closed when the live head cannot be read, or the row carries none", () => {
    // An unreadable SHA is not permission to enqueue: it means the
    // classification cannot be shown to still apply. The row re-classifies on
    // the next fire, and `markFailure` keeps the refusal out of the cap.
    for (const liveResponse of ["{}", JSON.stringify({ headRefOid: "" }), JSON.stringify({ headRefOid: null })]) {
      assert.throws(
        () => applyRow("o/r", { number: 11, action: "enqueue", headSha: HEAD }, () => liveResponse),
        /head moved since classification/,
        `unreadable live head (${liveResponse}) must not enqueue`,
      );
    }
    assert.throws(
      () => applyRow("o/r", { number: 12, action: "enqueue" }, () => JSON.stringify({ headRefOid: HEAD })),
      /head moved since classification/,
      "a row with no classified head cannot be compared against anything",
    );
  });

  it("the refusal lands in the action column, so it never spends a queue slot", () => {
    // End-to-end with `markFailure`/`sweepRepos`'s reading: only rows still
    // reading `enqueue` count against MAX_ENQUEUES_PER_FIRE.
    const row = { number: 3060, action: "enqueue", reason: "mergestate:CLEAN", detail: null, headSha: HEAD };
    try {
      applyRow("o/r", row, () => JSON.stringify({ headRefOid: OTHER }));
      assert.fail("expected a refusal");
    } catch (error) {
      markFailure(row, error.message);
    }
    assert.equal(row.action, "enqueue-failed");
    assert.match(row.detail, /head moved since classification/);
    assert.equal([row].filter((r) => r.action === "enqueue").length, 0);
    assert.equal(isFatalGhError(row.detail), false, "a moved head is a skip, never a reason to abort the fire");
  });

  it("liveHeadSha reads the PR's current head and normalises an unusable answer to null", () => {
    const calls = [];
    assert.equal(
      liveHeadSha("o/r", 7, (args) => {
        calls.push(args);
        return JSON.stringify({ headRefOid: HEAD });
      }),
      HEAD,
    );
    assert.deepEqual(calls, [["pr", "view", "7", "--repo", "o/r", "--json", "headRefOid"]]);
    assert.equal(liveHeadSha("o/r", 7, () => "{}"), null);
    assert.equal(liveHeadSha("o/r", 7, () => JSON.stringify({ headRefOid: "" })), null);
  });

  it("disarms a stale enqueue without a merge method", () => {
    const calls = [];
    applyRow("o/r", { number: 8, action: "stale-enqueue" }, (args) => {
      calls.push(args);
      return args[0] === "api" ? "[]" : "";
    });
    assert.deepEqual(calls[0], ["pr", "merge", "8", "--repo", "o/r", "--disable-auto"]);
    assert.equal(calls.at(-1)[0], "pr");
    assert.equal(calls.at(-1)[1], "comment");
  });

  it("leaves unknown actions alone", () => {
    assert.equal(applyRow("o/r", { number: 9, action: "hold" }, () => {
      throw new Error("must not shell out");
    }), null);
  });
});

describe("markFailure", () => {
  /**
   * The receipt tallies by action, so a failure recorded only in `detail` is
   * invisible to the summary line. That is how 9 silent fires survived review.
   */
  it("moves the failure into the action column and keeps prior detail", () => {
    const row = markFailure(
      { number: 7, action: "enqueue", detail: "clean at head" },
      "  --merge, --rebase, or --squash required\nusage: gh pr merge\n",
    );
    assert.equal(row.action, "enqueue-failed");
    assert.equal(row.detail, "clean at head — failed: --merge, --rebase, or --squash required");
  });

  it("is visible in the receipt tally", () => {
    const receipt = renderReceipt([
      { number: 1, action: "enqueue", reason: "clean", detail: "" },
      markFailure({ number: 2, action: "enqueue", reason: "clean", detail: "" }, "boom"),
    ]);
    assert.match(receipt, /enqueue: 1/);
    assert.match(receipt, /enqueue-failed: 1/);
  });
});

/**
 * PEN-4919. `fetchCodeownerRules` is the fail-CLOSED half of the owner hold:
 * `null` ("unreadable, keep holding") must stay distinguishable from `[]`
 * ("measured, nobody is owed"). Two paths used to cross that line silently.
 */
describe("fetchCodeownerRules fails closed on anything it did not read", () => {
  const CODEOWNERS = "docs/ @org/docs-team\n";

  /** `execFileSync` surfaces gh's diagnostics on `stderr` as a Buffer. */
  function ghError(stderr) {
    return Object.assign(new Error("Command failed"), { stderr: Buffer.from(stderr) });
  }

  const notFound = () => ghError("gh: Not Found (HTTP 404)\n");
  const blob = (text, encoding = "base64") =>
    JSON.stringify({ encoding, content: Buffer.from(text).toString("base64") });

  /** Answers by path, so precedence order is observable rather than assumed. */
  function runner(byPath, calls = []) {
    return (args) => {
      const path = String(args.at(-1)).replace(/^repos\/[^/]+\/[^/]+\/contents\//, "");
      calls.push(path);
      const answer = byPath[path] ?? notFound;
      if (typeof answer === "function") throw answer();
      return answer;
    };
  }

  it("falls through a 404 to the next location, in precedence order", () => {
    const calls = [];
    const rules = fetchCodeownerRules(
      "Blockcast/paperclip",
      runner({ CODEOWNERS: blob(CODEOWNERS) }, calls),
    );
    assert.deepEqual(calls, [".github/CODEOWNERS", "CODEOWNERS"]);
    assert.equal(rules.length, 1);
    assert.deepEqual(rules[0].owners, ["team:docs-team"]);
  });

  it("does NOT fall through a 5xx to a lower-precedence CODEOWNERS", () => {
    // The whole point: a transient outage on `.github/CODEOWNERS` must not
    // silently adopt `docs/CODEOWNERS`'s rules. Unreadable is not absent.
    const calls = [];
    const rules = fetchCodeownerRules(
      "Blockcast/paperclip",
      runner(
        {
          ".github/CODEOWNERS": () => ghError("gh: Internal Server Error (HTTP 500)\n"),
          "docs/CODEOWNERS": blob("* @someone-else\n"),
        },
        calls,
      ),
    );
    assert.equal(rules, null);
    assert.deepEqual(calls, [".github/CODEOWNERS"]);
  });

  it("does NOT fall through a 403, and stops on a transport failure", () => {
    for (const stderr of ["gh: Forbidden (HTTP 403)\n", "spawnSync gh ENOENT"]) {
      assert.equal(
        fetchCodeownerRules("r/r", runner({ ".github/CODEOWNERS": () => ghError(stderr) })),
        null,
      );
    }
  });

  it("reads a >1 MB CODEOWNERS as unread, not as empty", () => {
    // Blobs over 1 MB are not inlined: `content: ""` with `encoding: "none"`.
    // That used to decode to "" and parse to [] -- "nobody is owed" -- which
    // drops every outstanding request and releases every held PR at once.
    const calls = [];
    const rules = fetchCodeownerRules(
      "Blockcast/paperclip",
      runner({ ".github/CODEOWNERS": JSON.stringify({ encoding: "none", content: "" }) }, calls),
    );
    assert.equal(rules, null);
    assert.notDeepEqual(rules, []);
    assert.deepEqual(calls, [".github/CODEOWNERS"], "must not try a lower-precedence file either");
  });

  it("skips a directory at the path but still reads the next location", () => {
    const rules = fetchCodeownerRules(
      "r/r",
      runner({
        ".github/CODEOWNERS": JSON.stringify([{ name: "OWNERS" }]),
        CODEOWNERS: blob(CODEOWNERS),
      }),
    );
    assert.equal(rules.length, 1);
  });

  it("returns null when every location 404s, and when the body is not JSON", () => {
    assert.equal(fetchCodeownerRules("r/r", runner({})), null);
    assert.equal(fetchCodeownerRules("r/r", runner({ ".github/CODEOWNERS": "<html>" })), null);
  });

  it("identifies a 404 and nothing looser", () => {
    assert.ok(isNotFoundGhError("gh: Not Found (HTTP 404)"));
    assert.ok(!isNotFoundGhError("gh: Internal Server Error (HTTP 500)"));
    // A 404 named only in prose is not a status; the caller must fail closed.
    assert.ok(!isNotFoundGhError("Not Found"));
    assert.ok(!isNotFoundGhError(undefined));
  });
});

/**
 * PEN-6522. The hold SENTENCE used to be a repo-independent constant that
 * asserted "GitHub does not enforce CODEOWNERS on this repository". Measured
 * 2026-11-12 it is false on `Blockcast/trafficcontrol@master` and
 * `Blockcast/magma@main`, and it was emitted on `trafficcontrol`#2959 anyway.
 *
 * These pin the derivation and, above all, the direction: an unreadable plane
 * must produce a sentence that claims NOTHING, never one that claims absence.
 */
describe("the code-owner hold reason is derived per repo, and fails to claiming nothing", () => {
  const { ENFORCED, UNENFORCED, UNKNOWN } = CODEOWNER_ENFORCEMENT;

  function ghError(stderr) {
    return Object.assign(new Error("Command failed"), { stderr: Buffer.from(stderr) });
  }

  /** What `gh` does on a partial FORBIDDEN: exit non-zero. Measured 2026-11-12. */
  const forbidden = () => ghError("gh: Resource not accessible by integration\n");

  const ownerRule = (requireCodeOwnerReview) => ({
    type: "PULL_REQUEST",
    parameters: { requireCodeOwnerReview },
  });
  const rulesRef = (nodes, totalCount = nodes.length) => ({ rules: { totalCount, nodes } });
  const protectionRef = (branchProtectionRule) => ({ branchProtectionRule });

  /**
   * Answers the two planes SEPARATELY, and records which were asked — the
   * split is the safety property, so the call log is part of the assertion.
   * A function answer throws; a string answer is returned verbatim.
   */
  function planes({ rules, protection }, calls = []) {
    return (args) => {
      const query = String(args.find((arg) => String(arg).startsWith("query=")) ?? "");
      const plane = query.includes("branchProtectionRule") ? "protection" : "rules";
      calls.push(plane);
      const answer = plane === "protection" ? protection : rules;
      if (typeof answer === "function") throw answer();
      if (typeof answer === "string") return answer;
      return JSON.stringify({ data: { repository: { ref: answer ?? null } } });
    };
  }

  it("reads ENFORCED off the rules plane and does not probe the second one", () => {
    // `Blockcast/trafficcontrol@master` and `Blockcast/magma@main`, measured
    // 2026-11-12: an ACTIVE ruleset whose `PULL_REQUEST` rule carries
    // `requireCodeOwnerReview: true`. No second read can retract that, so the
    // withheld classic plane is never consulted.
    const calls = [];
    assert.equal(
      fetchCodeownerEnforcement(
        "Blockcast/trafficcontrol",
        "master",
        planes({ rules: rulesRef([ownerRule(true)]) }, calls),
      ),
      ENFORCED,
    );
    assert.deepEqual(calls, ["rules"]);
  });

  it("does not read a PULL_REQUEST rule that requires approvals but NOT an owner", () => {
    // `Blockcast/onprem-k8s@master`, measured 2026-11-12:
    // `requiredApprovingReviewCount: 0, requireCodeOwnerReview: false`. A
    // PULL_REQUEST rule is not by itself a code-owner requirement.
    const calls = [];
    assert.equal(
      fetchCodeownerEnforcement(
        "o/r",
        "master",
        planes({ rules: rulesRef([ownerRule(false)]), protection: forbidden }, calls),
      ),
      UNKNOWN,
    );
    assert.deepEqual(calls, ["rules", "protection"], "a silent rules plane must still try the second");
  });

  it("reaches UNENFORCED only when the classic plane POSITIVELY says nothing protects the branch", () => {
    // `Blockcast/Network-Operator-Portal@main`, measured 2026-11-12: no
    // PULL_REQUEST rule, and `ref.branchProtectionRule` answers a CLEAN null
    // at `gh` exit 0 with NO errors — a readable "no classic rule here".
    const calls = [];
    assert.equal(
      fetchCodeownerEnforcement(
        "o/r",
        "main",
        planes({ rules: rulesRef([]), protection: protectionRef(null) }, calls),
      ),
      UNENFORCED,
    );
    assert.deepEqual(calls, ["rules", "protection"]);
  });

  it("⛔ a WITHHELD classic plane is UNKNOWN, never UNENFORCED", () => {
    // The whole row. `ref.branchProtectionRule` needs `administration: read`,
    // which no agent seat on this fleet holds, so this is the LIVE answer on
    // `paperclip` and `trafficcontrol` alike: `null` at exit 1 carrying
    // `errors[0].type: FORBIDDEN`.
    //
    // The counter-example that makes the distinction load-bearing:
    // `Blockcast/penstock-llm-proxy-core@main` returns ZERO rules on the
    // readable plane while 20 of 20 sampled open PRs there read
    // `REVIEW_REQUIRED` against a `*` catch-all CODEOWNERS. A silent rules
    // plane is NOT evidence of absence.
    assert.equal(
      fetchCodeownerEnforcement(
        "Blockcast/paperclip",
        "master",
        planes({ rules: rulesRef([]), protection: forbidden }),
      ),
      UNKNOWN,
    );
    for (const stderr of ["gh: Internal Server Error (HTTP 500)\n", "spawnSync gh ENOENT"]) {
      assert.equal(
        fetchCodeownerEnforcement(
          "o/r",
          "main",
          planes({ rules: rulesRef([]), protection: () => ghError(stderr) }),
        ),
        UNKNOWN,
      );
    }
  });

  it("⛔ a 200 carrying `errors` is unread too, even though `gh` exited cleanly", () => {
    // The second guard, kept beside the `catch` because it is a different
    // shape: a payload that parsed, with a null body and an error beside it.
    const withErrors = JSON.stringify({
      data: { repository: { ref: { branchProtectionRule: null } } },
      errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
    });
    assert.equal(
      fetchCodeownerEnforcement("o/r", "main", planes({ rules: rulesRef([]), protection: withErrors })),
      UNKNOWN,
    );
    // And on the FIRST plane it is equally unread — never an empty rule set.
    assert.equal(fetchCodeownerEnforcement("o/r", "main", planes({ rules: withErrors })), UNKNOWN);
  });

  it("reads the classic plane when it answers, in both directions", () => {
    const served = (rule) =>
      fetchCodeownerEnforcement(
        "o/r",
        "main",
        planes({ rules: rulesRef([]), protection: protectionRef(rule) }),
      );
    assert.equal(served({ requiresCodeOwnerReviews: true }), ENFORCED);
    assert.equal(served({ requiresCodeOwnerReviews: false }), UNENFORCED);
    // ⛔ A rule object carrying neither boolean is a shape this seat has never
    // observed, so it must not be read as "measured, nothing required".
    assert.equal(served({}), UNKNOWN);
  });

  it("⛔ a TRUNCATED rules page is unread, not an empty rule set", () => {
    // The rule that requires an owner could be the one that fell off the end,
    // and this plane is the only one that can ever say ENFORCED on this fleet.
    assert.equal(
      fetchCodeownerEnforcement(
        "o/r",
        "main",
        planes({ rules: rulesRef([ownerRule(false)], 51), protection: protectionRef(null) }),
      ),
      UNKNOWN,
    );
    // Control: the same page, not truncated, reaches the second plane.
    assert.equal(
      fetchCodeownerEnforcement(
        "o/r",
        "main",
        planes({ rules: rulesRef([ownerRule(false)], 1), protection: protectionRef(null) }),
      ),
      UNENFORCED,
    );
  });

  it("⛔ a failed rules read short-circuits, so a dead ref never reaches the UNENFORCED arm", () => {
    // Ordering guard. A branch that does not resolve answers `ref: null` on
    // BOTH planes, and on the second that is indistinguishable from "nothing
    // protects it". Running the readable plane FIRST keeps a dead ref out of
    // the UNENFORCED branch. Measured: `Blockcast/remote-key-server` answers
    // `ref: null` for `refs/heads/main`.
    const calls = [];
    assert.equal(
      fetchCodeownerEnforcement(
        "o/r",
        "main",
        planes({ rules: null, protection: protectionRef(null) }, calls),
      ),
      UNKNOWN,
    );
    assert.deepEqual(calls, ["rules"], "the classic plane is never asked");
  });

  it("⛔ a ref that stops resolving BETWEEN the two reads is UNKNOWN, not UNPROTECTED", () => {
    // The `?? null` on the ref is not redundant with the non-array guard above
    // it: that one catches an unreadable body on the FIRST plane, this one
    // catches a ref that did not resolve on the SECOND. They differ in
    // direction — a null ref reaching the classic plane as `{}` would read as
    // "nothing protects this branch", which is the fail-open. Reachable as a
    // race: the branch is deleted between the two reads.
    const calls = [];
    assert.equal(
      fetchCodeownerEnforcement("o/r", "main", planes({ rules: rulesRef([]), protection: null }, calls)),
      UNKNOWN,
    );
    assert.deepEqual(calls, ["rules", "protection"], "it really did reach the second plane");
  });

  it("treats an unreadable repo or branch as UNKNOWN and asks nothing", () => {
    const calls = [];
    for (const branch of ["", null, undefined]) {
      assert.equal(fetchCodeownerEnforcement("o/r", branch, planes({ rules: rulesRef([]) }, calls)), UNKNOWN);
    }
    for (const repo of ["", "no-slash", null]) {
      assert.equal(fetchCodeownerEnforcement(repo, "main", planes({ rules: rulesRef([]) }, calls)), UNKNOWN);
    }
    assert.deepEqual(calls, [], "an unread repo or default branch costs no API call");
    // A non-array `nodes` is an answer this function cannot read.
    assert.equal(
      fetchCodeownerEnforcement("o/r", "main", planes({ rules: { rules: { totalCount: 0, nodes: null } } })),
      UNKNOWN,
    );
  });

  it("names the branch, holds in every state, and the three sentences differ", () => {
    const say = (codeownerEnforcement) => landRepoHoldReason({ baseRefName: "master", codeownerEnforcement });
    const enforced = say(ENFORCED);
    const unenforced = say(UNENFORCED);
    const unknown = say(UNKNOWN);

    assert.equal(new Set([enforced, unenforced, unknown]).size, 3, "three distinct sentences");
    for (const sentence of [enforced, unenforced, unknown]) {
      assert.match(sentence, /`master`/, "every sentence names the base branch");
      assert.match(sentence, /holds it here rather than enqueuing it\.$/, "the HOLD never varies");
    }
    // ⛔ The UNKNOWN wording must assert NOTHING about GitHub in either
    // direction. That is the whole correction: the constant it replaces
    // asserted absence from a read nobody had taken.
    assert.match(unknown, /could not be read/);
    assert.doesNotMatch(unknown, /No branch rule/);
    assert.doesNotMatch(unknown, /will not merge until/);
    assert.doesNotMatch(unknown, /does not enforce CODEOWNERS/);
    // An unnamed base degrades the wording and nothing else.
    assert.match(landRepoHoldReason({ codeownerEnforcement: UNKNOWN }), /base branch/);
  });

  it("CONTROL: the two arms differ end to end, trafficcontrol vs Network-Operator-Portal", () => {
    // Done-when #2 of PEN-6522, with both repos' measured 2026-11-12 shapes
    // driven through the real reader rather than asserted.
    const sentenceFor = (shape, branch) =>
      landRepoHoldReason({
        baseRefName: branch,
        codeownerEnforcement: fetchCodeownerEnforcement("o/r", branch, planes(shape)),
      });

    const trafficcontrol = sentenceFor({ rules: rulesRef([ownerRule(true)]) }, "master");
    const networkOperatorPortal = sentenceFor(
      { rules: rulesRef([]), protection: protectionRef(null) },
      "main",
    );

    assert.notEqual(trafficcontrol, networkOperatorPortal, "the whole point: the text is per-repo");
    assert.match(trafficcontrol, /GitHub requires a code-owner review on `master`/);
    assert.doesNotMatch(trafficcontrol, /would not block/);
    assert.match(networkOperatorPortal, /No branch rule on `main` requires a code-owner review/);
    // And neither repo gets the constant this row removed.
    for (const sentence of [trafficcontrol, networkOperatorPortal]) {
      assert.doesNotMatch(sentence, /does not enforce CODEOWNERS on this repository/);
    }
  });

  it("⛔ the verdict chooses a SENTENCE and never an action: all three still hold, and none merges", () => {
    // A misread here must cost a wrong sentence and nothing else.
    const bodies = new Set();
    for (const codeownerEnforcement of [ENFORCED, UNENFORCED, UNKNOWN, undefined]) {
      const issued = [];
      const outcome = applyRow(
        "o/r",
        {
          number: 2959,
          action: "codeowner-review-requested",
          detail: "kkroo",
          baseRefName: "master",
          codeownerEnforcement,
        },
        (args) => {
          issued.push(args);
          if (args[0] === "api") return "[]";
          return "";
        },
      );
      assert.equal(outcome, "posted");
      assert.deepEqual(
        issued.filter((args) => args[0] === "pr" && args[1] === "merge"),
        [],
        "no state of the verdict reaches `gh pr merge`",
      );
      const posted = issued.find((args) => args[0] === "pr" && args[1] === "comment").at(-1);
      assert.ok(posted.startsWith(CODEOWNER_REQUEST_MARKER), "still under the dedupe marker");
      assert.match(posted, /outstanding code-owner review request \(kkroo\)/, "still names the owner");
      bodies.add(posted);
    }
    // Four inputs, three distinct bodies: an ABSENT verdict is the UNKNOWN one.
    assert.equal(bodies.size, 3);
  });

  it("carries the verdict and the base branch from the PR onto the held row", () => {
    const held = (overrides) =>
      classifyPr(pr({ reviewRequests: [{ login: "kkroo" }], baseRefName: "master", ...overrides }), {
        now: NOW,
      });

    const withVerdict = held({ codeownerEnforcement: ENFORCED });
    assert.equal(withVerdict.action, "codeowner-review-requested");
    assert.equal(withVerdict.codeownerEnforcement, ENFORCED);
    assert.equal(withVerdict.baseRefName, "master");
    // ⛔ An unread verdict defaults to UNKNOWN rather than to absence, so a
    // row built by any path that does not carry one still claims nothing.
    assert.equal(held({}).codeownerEnforcement, UNKNOWN);
    assert.equal(held({ baseRefName: undefined }).baseRefName, null);
  });

  it("reads the enforcement once per repo, against the repo's DEFAULT branch", () => {
    // Same placement argument as `fetchCodeownerRules` and `fetchDefaultBranch`:
    // the requirement is a property of the base branch, not of a PR.
    const asked = [];
    const prs = fetchOpenPrs("o/r", {
      run: (args) => {
        if (args[0] === "pr" && args[1] === "list") {
          return JSON.stringify([
            { number: 1, headRefOid: HEAD, baseRefName: "master", reviewRequests: [] },
            { number: 2, headRefOid: OTHER, baseRefName: "master", reviewRequests: [] },
          ]);
        }
        if (args[0] === "api") return "[]";
        return "{}";
      },
      mergeStates: () => new Map([[1, "BLOCKED"], [2, "BLOCKED"]]),
      defaultBranch: () => "master",
      enforcement: (repo, branch) => {
        asked.push([repo, branch]);
        return ENFORCED;
      },
    });
    assert.deepEqual(asked, [["o/r", "master"]], "one read per repo, keyed on the default branch");
    for (const pr of prs) assert.equal(pr.codeownerEnforcement, ENFORCED);
  });
});

/**
 * PEN-3474. `reviewRequests` alone is not the gate the hold claims to be: it
 * holds on requests CODEOWNERS never implied, and on requests GitHub stopped
 * implying when the owned file left the diff and then never withdrew.
 */
describe("CODEOWNERS scoping of the owner hold", () => {
  /** The live `Blockcast/paperclip` rules, verbatim, so the cases are the real ones. */
  const RULES = parseCodeowners(
    [
      "# Code owners.",
      "",
      ".github/** @kkroo",
      "scripts/release*.sh @kkroo",
      "doc/RELEASING.md @kkroo",
      "skills/** @kkroo",
      "package.json @kkroo   # matches at every depth",
      "docs/ @org/docs-team",
    ].join("\n"),
  );

  it("parses owners, skips comments and blank lines, and ignores a pattern with no owner", () => {
    assert.equal(RULES.length, 6);
    assert.deepEqual(RULES.at(-1).owners, ["team:docs-team"]);
    assert.deepEqual(parseCodeowners("# only a comment\n\nlonely-pattern\n"), []);
  });

  it("anchors a pattern containing a slash and floats a bare name to any depth", () => {
    // The checked-in CODEOWNERS relies on both, and says so in its own comment.
    assert.ok(codeownersPatternToRegExp("package.json").test("packages/acpx-local/package.json"));
    assert.ok(codeownersPatternToRegExp("package.json").test("package.json"));
    assert.ok(!codeownersPatternToRegExp("scripts/release*.sh").test("scripts/nested/release.sh"));
    assert.ok(codeownersPatternToRegExp("scripts/release*.sh").test("scripts/release-x.sh"));
  });

  it("spans whole segments for `**` and owns the contents of a directory pattern", () => {
    assert.ok(codeownersPatternToRegExp("a/**/b.ts").test("a/b.ts"));
    assert.ok(codeownersPatternToRegExp("a/**/b.ts").test("a/x/y/b.ts"));
    assert.ok(!codeownersPatternToRegExp("a/**/b.ts").test("z/a/b.ts"));
    assert.ok(codeownersPatternToRegExp("docs/").test("docs/x/y.md"));
    assert.ok(!codeownersPatternToRegExp("docs/").test("docsy/x.md"));
  });

  it("treats a literal dot as a literal, not as a wildcard", () => {
    // The chain-replace translator this replaced mangled `a.b*`: its lookbehind
    // guard fired on the escaped dot and left the `*` as a regex quantifier.
    assert.ok(codeownersPatternToRegExp("a.b*").test("a.bc"));
    assert.ok(!codeownersPatternToRegExp("a.b*").test("axbc"));
  });

  it("confines an interior `**` to one segment and keeps an escaped `#` literal", () => {
    // PEN-4919 (c). gitignore: "other consecutive asterisks are considered
    // regular asterisks", so `a**b` must not cross `/` the way `.*` did.
    assert.ok(codeownersPatternToRegExp("a**b").test("axxb"));
    assert.ok(!codeownersPatternToRegExp("a**b").test("a/x/b"));
    // The forms that ARE bounded by slashes keep spanning whole segments.
    assert.ok(codeownersPatternToRegExp("a/**/b").test("a/x/y/b"));
    assert.ok(codeownersPatternToRegExp("a/**").test("a/x/y"));

    assert.equal(stripCodeownersComment("src/a\\#b @o   # trailing"), "src/a#b @o");
    const [rule] = parseCodeowners("weird\\#name @kkroo\n");
    assert.equal(rule.pattern, "weird#name");
    assert.ok(rule.matcher.test("weird#name"));
  });

  it("applies LAST match wins per file, then unions across files", () => {
    const rules = parseCodeowners(["src/** @first", "src/special.ts @second"].join("\n"));
    assert.deepEqual([...ownersForFiles(["src/other.ts"], rules)], ["first"]);
    assert.deepEqual([...ownersForFiles(["src/special.ts"], rules)], ["second"]);
    assert.deepEqual([...ownersForFiles(["src/other.ts", "src/special.ts"], rules)].sort(), [
      "first",
      "second",
    ]);
  });

  it("drops a request whose owned file left the diff (#3067)", () => {
    // Opened touching `.github/workflows/pr.yml`, auto-requested @kkroo two
    // seconds later, then force-pushed down to one unowned file. GitHub never
    // withdraws the request, and GraphQL `asCodeOwner` still read `true`.
    const row = classifyPr(
      pr({
        mergeStateStatus: "CLEAN",
        reviewRequests: [{ login: "kkroo" }],
        codeownerRules: RULES,
        files: ["scripts/__tests__/vitest-project-coverage.test.mjs"],
      }),
      { now: NOW },
    );
    assert.equal(row.action, "enqueue");
  });

  it("keeps a request the current diff still owes (#3054, #3051)", () => {
    for (const files of [[".github/workflows/stranded-approval-lock-check.yml"], ["skills/paperclip/SKILL.md"]]) {
      const row = classifyPr(
        pr({ reviewRequests: [{ login: "kkroo" }], codeownerRules: RULES, files }),
        { now: NOW },
      );
      assert.equal(row.action, "codeowner-review-requested");
      assert.equal(row.detail, "kkroo");
    }
  });

  it("drops the `allyblockcast` User request CODEOWNERS never named", () => {
    // The original PEN-3474 cohort: the requested User (id 296676656) is a
    // different principal from the `allyblockcast[bot]` App that reviews, so
    // no review can ever clear it. CODEOWNERS names only @kkroo.
    assert.deepEqual(
      unsatisfiedOwners({
        headRefOid: HEAD,
        reviewRequests: [{ login: "allyblockcast" }],
        reviews: [review()],
        codeownerRules: RULES,
        files: [".github/workflows/pr.yml"],
      }),
      [],
    );
  });

  it("keeps a team request the diff owes, which no login approval can satisfy", () => {
    assert.deepEqual(
      unsatisfiedOwners({
        headRefOid: HEAD,
        reviewRequests: [{ slug: "docs-team" }],
        reviews: [{ state: "APPROVED", user: { login: "kkroo" }, commit_id: HEAD }],
        codeownerRules: RULES,
        files: ["docs/guide.md"],
      }),
      ["team:docs-team"],
    );
  });

  it("falls back to holding when ownership cannot be determined", () => {
    // This script's output is "merge it", so every unknown has to over-hold.
    // `null` and `[]` must stay distinguishable: the empty set means nobody is
    // owed, and reading an unreadable CODEOWNERS as empty would release every
    // held PR at once.
    const base = {
      headRefOid: HEAD,
      reviewRequests: [{ login: "kkroo" }],
      reviews: [review()],
      files: ["scripts/unowned.mjs"],
    };
    assert.deepEqual(unsatisfiedOwners(base), ["kkroo"], "no rules fetched");
    assert.deepEqual(
      unsatisfiedOwners({ ...base, codeownerRules: RULES, files: null }),
      ["kkroo"],
      "file listing failed",
    );
    assert.deepEqual(
      unsatisfiedOwners({
        ...base,
        codeownerRules: RULES,
        files: Array.from({ length: 3000 }, (_, i) => `f${i}.ts`),
      }),
      ["kkroo"],
      "GitHub truncated the file listing",
    );
    assert.equal(impliedOwners({ codeownerRules: RULES, files: null }), null);
    assert.deepEqual([...impliedOwners({ codeownerRules: RULES, files: ["unowned.ts"] })], []);
  });
});

describe("approvalAttestsHead — dating a human approval (PEN-5997)", () => {
  const AT = Date.parse("2026-09-13T04:00:00Z");
  const approval = (overrides = {}) => ({
    state: "APPROVED",
    user: { login: "kkroo", id: 1845185, type: "User" },
    commit_id: HEAD,
    submitted_at: "2026-09-13T07:00:00Z",
    ...overrides,
  });

  it("credits an approval submitted after the head was committed", () => {
    assert.equal(approvalAttestsHead(approval(), HEAD, AT), true);
  });

  it("rejects a re-anchored approval that predates the head it is filed against", () => {
    // The whole defect. Measured on Blockcast/paperclip 2026-11-07: #1044,
    // #1465, #1506, #1512, #1551 and #2731 all satisfy `commit_id === head`
    // while having been submitted before that head's commit existed.
    assert.equal(
      approvalAttestsHead(approval({ submitted_at: "2026-09-13T03:00:00Z" }), HEAD, AT),
      false,
    );
  });

  it("breaks a same-second tie toward the hold", () => {
    // One-second timeline resolution makes the pair genuinely unordered. This
    // is the difference between `>` and `>=`, which no other assertion sees.
    assert.equal(
      approvalAttestsHead(approval({ submitted_at: "2026-09-13T04:00:00Z" }), HEAD, AT),
      false,
    );
  });

  it("rejects every state that is not APPROVED", () => {
    for (const state of ["COMMENTED", "CHANGES_REQUESTED", "DISMISSED", "PENDING", ""]) {
      assert.equal(approvalAttestsHead(approval({ state }), HEAD, AT), false, state);
    }
  });

  it("keeps the commit_id conjunct, which still rejects a review GitHub did not re-anchor", () => {
    assert.equal(approvalAttestsHead(approval({ commit_id: OTHER }), HEAD, AT), false);
    assert.equal(approvalAttestsHead(approval({ commit_id: null }), HEAD, AT), false);
  });

  it("credits nobody when the head, its date, or the submission time is unreadable", () => {
    assert.equal(approvalAttestsHead(approval(), HEAD, null), false, "undatable head");
    assert.equal(approvalAttestsHead(approval(), "", AT), false, "unknown head");
    assert.equal(approvalAttestsHead(approval(), null, AT), false, "null head");
    for (const submitted_at of ["not-a-date", undefined, null, ""]) {
      assert.equal(approvalAttestsHead(approval({ submitted_at }), HEAD, AT), false, String(submitted_at));
    }
    assert.equal(approvalAttestsHead(null, HEAD, AT), false, "no review");
  });
});

describe("the unattested-head fallback must not reach the code-owner gate (PEN-6105)", () => {
  // The fixture PEN-5997 could not have: every timeline it added either
  // attests the head or is empty, so `unsatisfiedOwners` was never handed the
  // fallback stamp that poisons it. Here the timeline carries a real
  // `committed` event and NONE of them is the head.
  const committed = (at, sha) => ({ event: "committed", sha, committer: { date: at } });
  const approval = (submitted_at) => ({
    state: "APPROVED",
    user: { login: "kkroo", id: 1845185, type: "User" },
    // Re-anchored forward by GitHub onto the current head, which is exactly
    // why this equality proves nothing on its own (PEN-5997).
    commit_id: HEAD,
    submitted_at,
  });
  // No `codeownerRules`, so `impliedOwners` is null and the CODEOWNERS filter
  // is out of the way: what these assert is the head-dating and nothing else.
  const pr = (timeline, submitted_at) => ({
    headRefOid: HEAD,
    timeline,
    reviews: [approval(submitted_at)],
    reviewRequests: [{ login: "kkroo" }],
  });
  const UNATTESTED = [committed("2026-09-13T01:00:00Z", OTHER)];
  const ATTESTED = [committed("2026-09-13T04:00:00Z", HEAD)];

  it("A: holds when nothing attests the head and the approval predates it", () => {
    // The defect. Before PEN-6105 the fallback dated this head 01:00 off a
    // commit that is NOT the head, 03:00 > 01:00 credited the approval, and
    // the hold cleared on the one path that arms `gh pr merge --auto` with no
    // human in the loop.
    assert.deepEqual(unsatisfiedOwners(pr(UNATTESTED, "2026-09-13T03:00:00Z")), ["kkroo"]);
  });

  it("A: and an unattested head credits nobody even when the approval is LATE", () => {
    // Discriminates the fix from "the timestamps happened to order right":
    // under the fallback a 07:00 approval cleared the hold too. An undatable
    // head credits NOBODY, which `approvalAttestsHead` already claimed and
    // was never handed.
    assert.deepEqual(unsatisfiedOwners(pr(UNATTESTED, "2026-09-13T07:00:00Z")), ["kkroo"]);
  });

  it("B: holds when the head IS attested and the approval predates it", () => {
    assert.deepEqual(unsatisfiedOwners(pr(ATTESTED, "2026-09-13T03:00:00Z")), ["kkroo"]);
  });

  it("C: holds when the timeline is empty", () => {
    assert.deepEqual(unsatisfiedOwners(pr([], "2026-09-13T03:00:00Z")), ["kkroo"]);
  });

  it("D: still credits a genuine approval of an attested head", () => {
    // The must-pass input. Holding everything passes A, B and C.
    assert.deepEqual(unsatisfiedOwners(pr(ATTESTED, "2026-09-13T07:00:00Z")), []);
  });
});

describe(`stale-hold report (held >${STALE_HOLD_HOURS}h, PEN-5005)`, () => {
  // Every fixture is anchored on NOW so the clock under test is the only
  // moving part.
  const checkAt = (iso) => [{ name: "verify", conclusion: "SUCCESS", completedAt: iso }];
  const pr = (number, iso) => ({ number, statusCheckRollup: iso === null ? [] : checkAt(iso) });
  const row = (number, action, reason) => ({ number, action, reason });

  const FRESH = "2026-09-13T11:00:00Z"; // 1h before NOW
  const OLD = "2026-09-12T20:00:00Z"; // 16h before NOW

  it("reports a hold whose head stopped moving longer ago than the window", () => {
    const held = stalledHolds(
      [pr(1, OLD)],
      [row(1, "codeowner-review-requested", "owner-approval-pending")],
      { now: NOW },
    );
    assert.deepEqual(held, [
      { number: 1, reason: "owner-approval-pending", ageHours: 16 },
    ]);
  });

  it("does not report a hold that is still inside the window", () => {
    // The live case this detector was written against: #3089 and #3085 were
    // 9.2h and 9.8h OLD on 2026-10-29 against a 2.2-6.8h create->merge
    // spread, which reads as a strand — but both had pushed that morning and
    // their CI had finished ~2.5h earlier, and both classified `enqueue` on
    // the next read. A creation clock names them; this one must not.
    assert.deepEqual(
      stalledHolds([pr(1, FRESH)], [row(1, "skip", "checks:settling")], { now: NOW }),
      [],
    );
  });

  it("ages what a PR ended as, so an acted-on row is never reported", () => {
    const prs = [pr(1, OLD), pr(2, OLD), pr(3, OLD), pr(4, OLD)];
    const rows = [
      row(1, "enqueue", "mergestate:CLEAN"),
      row(2, "already-enqueued", "auto-merge armed 1.0h ago"),
      // Both of these carry their own cohort or their own better clock, and
      // reporting them here would name one PR twice under two mechanisms.
      row(3, "approval-rotted", "mergestate:DIRTY"),
      row(4, "stale-enqueue", "auto-merge armed 20.0h ago"),
    ];
    assert.deepEqual(stalledHolds(prs, rows, { now: NOW }), []);
  });

  it("never ages a row the cap deferred — the next fire takes it", () => {
    // Ally on #3106: `classifyAll` rewrites an over-budget `enqueue` into
    // `skip`/`cap:N-per-fire`, and the budget is spent on the PRs whose CI
    // reported most recently — so the deferred rows carry the OLDEST stamps
    // and age like strands. Reporting them would fire this block hardest
    // exactly when the queue is deepest and the routine is working.
    assert.deepEqual(
      stalledHolds([pr(1, OLD)], [row(1, "skip", `cap:${MAX_ENQUEUES_PER_FIRE}-per-fire`)], {
        now: NOW,
      }),
      [],
    );
  });

  it("never ages a deliberate hold", () => {
    // Draft, an opt-out label and a human author are all states someone CHOSE.
    // An alarm that fires on its own normal operation is one nobody reads.
    const prs = [pr(1, OLD), pr(2, OLD), pr(3, OLD)];
    const rows = [
      row(1, "skip", "draft"),
      row(2, "skip", "label:do-not-merge"),
      row(3, "skip", "human-author"),
    ];
    assert.deepEqual(stalledHolds(prs, rows, { now: NOW }), []);
  });

  it("REPORTS an undatable hold rather than dropping it", () => {
    // The fail-toward-clean shape: a held PR whose rollup carries no stamp is
    // a PR nothing ever ran on, which is the case most worth hearing about.
    // Silence here would be indistinguishable from a healthy repo.
    assert.deepEqual(
      stalledHolds([pr(1, null)], [row(1, "skip", "checks:none")], { now: NOW }),
      [{ number: 1, reason: "checks:none", ageHours: null }],
    );
    assert.deepEqual(
      stalledHolds([], [row(9, "skip", "checks:none")], { now: NOW }),
      [{ number: 9, reason: "checks:none", ageHours: null }],
      "a row whose PR is missing entirely is still reported",
    );
  });

  it("reads the clock past an Ally verdict mirror posted after CI finished", () => {
    // #1981's shape, arriving through this door: the mirror is the newest
    // datable row, so an unfiltered read would restart the clock on a hold
    // that has not moved since CI reported.
    const prWithMirror = {
      number: 1,
      statusCheckRollup: [
        { __typename: "CheckRun", name: "verify", conclusion: "SUCCESS", completedAt: OLD },
        {
          __typename: "StatusContext",
          context: "gate/ally-comment-findings",
          state: "SUCCESS",
          createdAt: FRESH,
        },
      ],
    };
    assert.equal(judgeableAgeHours(prWithMirror, { now: NOW }), 16);
  });

  it("renders nothing when no hold is stale, and names each one when they are", () => {
    assert.equal(renderStalledHolds("a/one", []), "");
    const text = renderStalledHolds("a/one", [
      { number: 7, reason: "owner-approval-pending", ageHours: 40.2 },
      { number: 8, reason: "checks:none", ageHours: null },
    ]);
    // The header names the clock that was measured. "held >13h" would claim a
    // duration this report does not have: a hold acquired this fire on CI
    // that finished 14h ago is reported, and that is correct.
    assert.match(text, /stale-hold \(judgeable >13h or undated, still held\)/);
    assert.match(text, /time since this head last reported, not time the hold has stood/);
    assert.match(text, /a\/one#7 — `owner-approval-pending`, 40\.2h/);
    assert.match(text, /a\/one#8 — `checks:none`, age unknown/);
  });

  it("shares one clock definition with the settle floor", () => {
    // Two definitions of "when did this head last report" would drift, and the
    // drift would be invisible: both answers look plausible in isolation.
    assert.equal(newestCheckStamp(checkAt(OLD)), Date.parse(OLD));
    assert.equal(newestCheckStamp([{ name: "verify", conclusion: "SUCCESS" }]), null);
    assert.equal(newestCheckStamp([]), null);
    assert.equal(judgeableAgeHours({ statusCheckRollup: [] }, { now: NOW }), null);
  });
});

describe("ejected-at-current-head hold (PEN-5022)", () => {
  // Real shapes. `removed_from_merge_queue` carries `commit_id: null` (verified
  // on #3089's three events, 2026-10-29), which is why the rule dates against
  // the head rather than matching a sha.
  // Real shapes again, and the two are disjoint: a `committed` event carries
  // its sha under `sha`, a `head_ref_force_pushed` under `commit_id` (read
  // live off #3089 and #3114, 2026-10-29). Both default to undefined so every
  // pre-PEN-5028 call site below keeps meaning "a commit nobody identified".
  const committed = (at, sha) => ({ event: "committed", sha, committer: { date: at } });
  const forcePushed = (at, commitId) => ({
    event: "head_ref_force_pushed",
    created_at: at,
    commit_id: commitId,
  });
  const added = (at) => ({ event: "added_to_merge_queue", created_at: at, commit_id: null });
  const ejected = (at) => ({ event: "removed_from_merge_queue", created_at: at, commit_id: null });

  describe("headMovedAt", () => {
    it("reads an ordinary push off committer.date, not created_at", () => {
      // `committed` is a raw git object and has no `created_at`. Reading only
      // `created_at` would date the head off force-pushes alone and silently
      // treat every ordinary push as "head never moved".
      assert.equal(headMovedAt([committed("2026-09-13T08:00:00Z")]), Date.parse("2026-09-13T08:00:00Z"));
    });

    it("takes the newest of either kind", () => {
      assert.equal(
        headMovedAt([forcePushed("2026-09-13T09:00:00Z"), committed("2026-09-13T08:00:00Z")]),
        Date.parse("2026-09-13T09:00:00Z"),
      );
    });

    it("is null when nothing dates the head, and that is not 'infinitely old'", () => {
      assert.equal(headMovedAt([added("2026-09-13T10:00:00Z")]), null);
      assert.equal(headMovedAt([]), null);
      assert.equal(headMovedAt(undefined), null);
    });

    it("PEN-5028: ignores a commit that is no longer the head, however new it is", () => {
      // The fail-OPEN direction, and the expensive one. #3089 carries six
      // `committed` events of which exactly one is the head; an abandoned
      // commit dated AFTER the head drags the stamp forward, and every
      // ejection older than it is then silently dropped. Without the headSha
      // narrowing this returns 10:00 and reports a head that never moved.
      const timeline = [
        committed("2026-09-13T08:00:00Z", HEAD),
        committed("2026-09-13T10:00:00Z", OTHER),
      ];
      assert.equal(headMovedAt(timeline, HEAD), Date.parse("2026-09-13T08:00:00Z"));
      // Unnarrowed is the pre-PEN-5028 answer, kept as the contrast.
      assert.equal(headMovedAt(timeline), Date.parse("2026-09-13T10:00:00Z"));
    });

    it("PEN-5028: reads a force-push's sha off commit_id, not off sha", () => {
      // `head_ref_force_pushed` carries `commit_id` and a null `sha`. Matching
      // only on `sha` would make every force-pushed head unattested and send
      // it down the fallback, which is the one path that cannot narrow.
      // The trailing abandoned commit is what makes this discriminating: on a
      // `sha`-only match the force-push attests nothing, the whole timeline
      // falls back, and the stamp reads 10:00 instead of 09:00.
      const timeline = [
        committed("2026-09-13T08:00:00Z", OTHER),
        forcePushed("2026-09-13T09:00:00Z", HEAD),
        committed("2026-09-13T10:00:00Z", "c0ffee11c0ffee11c0ffee11c0ffee11c0ffee11"),
      ];
      assert.equal(headMovedAt(timeline, HEAD), Date.parse("2026-09-13T09:00:00Z"));
    });

    it("PEN-5028: falls back to the unnarrowed stamp when nothing attests the head", () => {
      // Deliberate, and it is the anti-stranding guard. Returning null here
      // would count every historical ejection and hold the PR, and no push
      // could ever clear it — a permanent hold on exactly the PRs whose
      // timeline is odd. The fallback is the pre-PEN-5028 behaviour, so the
      // narrowing can only ever bite on positive evidence about the head.
      const timeline = [committed("2026-09-13T08:00:00Z"), committed("2026-09-13T10:00:00Z")];
      assert.equal(headMovedAt(timeline, HEAD), Date.parse("2026-09-13T10:00:00Z"));
      assert.equal(headMovedAt(timeline, HEAD), headMovedAt(timeline));
    });

    it("PEN-6105: `attestingOnly` reports null instead of falling back", () => {
      // Same timeline and same head as the fallback test directly above, one
      // option apart — so if the two answers ever agree, the option does
      // nothing. The fallback stays because `ejectionsAtHead` needs it; this
      // exists because `approvalAttestsHead` is poisoned by it.
      const timeline = [committed("2026-09-13T08:00:00Z"), committed("2026-09-13T10:00:00Z")];
      assert.equal(headMovedAt(timeline, HEAD, { attestingOnly: true }), null);
      assert.equal(headMovedAt(timeline, HEAD), Date.parse("2026-09-13T10:00:00Z"));
    });

    it("PEN-6105: `attestingOnly` still dates a head the timeline DOES attest", () => {
      // The must-pass input. An option that only ever returned null would
      // satisfy the fail-closed assertion above and gate every PR forever.
      const timeline = [
        committed("2026-09-13T08:00:00Z", HEAD),
        committed("2026-09-13T10:00:00Z", OTHER),
      ];
      assert.equal(
        headMovedAt(timeline, HEAD, { attestingOnly: true }),
        Date.parse("2026-09-13T08:00:00Z"),
      );
      // And off `commit_id`, which is where a force-pushed head carries its sha.
      assert.equal(
        headMovedAt([forcePushed("2026-09-13T09:00:00Z", HEAD)], HEAD, { attestingOnly: true }),
        Date.parse("2026-09-13T09:00:00Z"),
      );
    });

    it("PEN-6105: `attestingOnly` treats an unknown head as undatable, not as 'any commit will do'", () => {
      const timeline = [committed("2026-09-13T08:00:00Z", HEAD)];
      for (const head of [null, undefined, ""]) {
        assert.equal(headMovedAt(timeline, head, { attestingOnly: true }), null, String(head));
      }
    });

    it("PEN-6105: `ejectionsAtHead` is NOT switched — it still takes the fallback", () => {
      // The "only one caller moves" box, as an assertion rather than a
      // promise. Nothing attests this head, so under `attestingOnly` the
      // stamp is null, every historical ejection counts, and the count goes
      // 1 -> 2: the permanent unclearable hold EJECTIONS_BEFORE_HOLD exists
      // to rule out. If this ever goes red, the wrong caller was switched.
      const timeline = [
        added("2026-09-13T07:50:00Z"),
        ejected("2026-09-13T08:00:00Z"),
        committed("2026-09-13T09:00:00Z"),
        added("2026-09-13T09:50:00Z"),
        ejected("2026-09-13T10:00:00Z"),
      ];
      assert.equal(headMovedAt(timeline, HEAD, { attestingOnly: true }), null);
      assert.equal(ejectionsAtHead(timeline, HEAD).count, 1);
    });

    it("PEN-5028 CEILING: dates the head by COMMIT time, so a commit-before-ejection, push-after keeps the ejection", () => {
      // ⛔ This pins a KNOWN LIMITATION, not a desired behaviour. The REST
      // timeline records no push time for a non-force push, so the only clock
      // available is `committer.date`:
      //
      //   08:00 original commit · 10:00 ejection #1 · 10:30 fix COMMITTED
      //   · 11:00 ejection #2 · 11:05 fix PUSHED, becoming the head
      //
      // The head is dated 10:30, so the 11:00 ejection survives onto a head
      // that has never been in the queue. Narrowing to the head sha does NOT
      // reach this — 10:30 is the head's own stamp — which is why the fix for
      // PEN-5028 is a corrected doc plus this test, and not a filter. Closing
      // it needs a push time from a source other than this timeline.
      //
      // If this ever goes red because the count dropped to 0, the ceiling has
      // been closed: delete the ponytail notes on `headMovedAt` and
      // `ejectionsAtHead` rather than relaxing the assertion.
      const timeline = [
        committed("2026-09-13T08:00:00Z", OTHER),
        added("2026-09-13T09:50:00Z"),
        ejected("2026-09-13T10:00:00Z"),
        committed("2026-09-13T10:30:00Z", HEAD),
        added("2026-09-13T10:50:00Z"),
        ejected("2026-09-13T11:00:00Z"),
      ];
      assert.equal(headMovedAt(timeline, HEAD), Date.parse("2026-09-13T10:30:00Z"));
      // One ejection carried onto a head that was never enqueued, so for this
      // push ordering the effective threshold is EJECTIONS_BEFORE_HOLD - 1.
      assert.equal(ejectionsAtHead(timeline, HEAD).count, 1);
      assert.equal(EJECTIONS_BEFORE_HOLD - 1, 1);
    });
  });

  describe("ejectionsAtHead", () => {
    it("counts only ejections newer than the head — a push clears the history", () => {
      const timeline = [
        ejected("2026-09-13T06:00:00Z"),
        ejected("2026-09-13T07:00:00Z"),
        committed("2026-09-13T08:00:00Z"),
        ejected("2026-09-13T09:00:00Z"),
      ];
      assert.equal(ejectionsAtHead(timeline).count, 1);
    });

    it("reports requeued when the newest event is the re-add", () => {
      const timeline = [committed("2026-09-13T08:00:00Z"), ejected("2026-09-13T09:00:00Z"), added("2026-09-13T10:00:00Z")];
      const result = ejectionsAtHead(timeline);
      assert.equal(result.count, 1);
      assert.equal(result.requeued, true);
    });

    it("is not requeued when the ejection is the newest event", () => {
      const timeline = [committed("2026-09-13T08:00:00Z"), added("2026-09-13T09:00:00Z"), ejected("2026-09-13T10:00:00Z")];
      assert.equal(ejectionsAtHead(timeline).requeued, false);
    });

    it("breaks a same-second add/removal tie toward the hold, not toward requeued", () => {
      // One-second resolution makes the pair genuinely unordered. The
      // directions are not symmetric: reading a tie as requeued suppresses the
      // hold and re-enters the loop; reading it as held costs one deferred
      // enqueue. This pins the asymmetry — it is the difference between `>`
      // and `>=`, which no other assertion here can see.
      const timeline = [
        committed("2026-09-13T08:00:00Z"),
        added("2026-09-13T09:00:00Z"),
        ejected("2026-09-13T09:00:00Z"),
      ];
      assert.equal(ejectionsAtHead(timeline).requeued, false);
    });

    it("counts an undatable ejection rather than dropping it", () => {
      // Fails toward a hold the next push clears, never toward the re-enqueue
      // loop. Under-counting costs every entry in the queue a rebuild.
      assert.equal(ejectionsAtHead([ejected("2026-09-13T09:00:00Z")]).count, 1);
    });
  });

  describe("classifyPr", () => {
    const withEjections = (n, extra = []) => [
      committed("2026-09-13T08:00:00Z"),
      ...Array.from({ length: n }, (_, i) => [added(`2026-09-13T09:0${i}:00Z`), ejected(`2026-09-13T09:0${i}:30Z`)]).flat(),
      ...extra,
    ];

    it(`holds a PR GitHub has ejected ${EJECTIONS_BEFORE_HOLD}x at the current head`, () => {
      const row = classify({ mergeStateStatus: "CLEAN", timeline: withEjections(EJECTIONS_BEFORE_HOLD) });
      assert.equal(row.action, "skip");
      assert.equal(row.reason, "ejected-at-current-head");
    });

    it("NEGATIVE CONTROL: enqueues after ONE ejection — an infra flake must not strand a healthy PR", () => {
      // 3 of the 4 failing jobs on #3089's queue head were infrastructure (a
      // runner shutdown and two cancellations) and all three were `success` on
      // the rebuilt heads. If this test ever goes red the threshold has been
      // lowered to 1 and healthy PRs are being held forever.
      const row = classify({ mergeStateStatus: "CLEAN", timeline: withEjections(1) });
      assert.equal(row.action, "enqueue");
    });

    it("clears the hold when the head moves, with no state to expire", () => {
      const row = classify({
        mergeStateStatus: "CLEAN",
        timeline: [...withEjections(EJECTIONS_BEFORE_HOLD), forcePushed("2026-09-13T10:00:00Z")],
      });
      assert.equal(row.action, "enqueue");
    });

    it("does not re-enqueue a PR already back in the queue, however many times it was ejected", () => {
      // §4yy: `classifyPr` is otherwise structurally blind to queue
      // membership — `PR_LIST_FIELDS` carries no queue field, and auto-merge
      // is a different GitHub mechanism.
      const row = classify({
        mergeStateStatus: "CLEAN",
        timeline: withEjections(EJECTIONS_BEFORE_HOLD, [added("2026-09-13T11:00:00Z")]),
      });
      assert.notEqual(row.reason, "ejected-at-current-head");
    });

    it("runs LAST: a red check is still reported as the check, not as the ejection", () => {
      // The ejection hold is the least actionable reason on the row — fixing
      // the red check is what clears both.
      const row = classify({
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ name: "e2e", conclusion: "FAILURE", completedAt: "2026-09-13T05:00:00Z" }],
        timeline: withEjections(EJECTIONS_BEFORE_HOLD),
      });
      assert.equal(row.reason, "checks:FAILURE");
    });

    it("is unchanged for a PR with no timeline at all", () => {
      assert.equal(classify({ mergeStateStatus: "CLEAN" }).action, "enqueue");
    });

    it("PEN-5028: an abandoned commit newer than the head no longer suppresses the hold", () => {
      // End-to-end for the fail-open direction. Before the headSha narrowing
      // the trailing OTHER commit dated the head at 10:00, both ejections fell
      // away, and a head GitHub had ejected twice classified `enqueue`.
      const row = classify({
        mergeStateStatus: "CLEAN",
        timeline: [
          committed("2026-09-13T08:00:00Z", HEAD),
          ...Array.from({ length: EJECTIONS_BEFORE_HOLD }, (_, i) => [
            added(`2026-09-13T09:0${i}:00Z`),
            ejected(`2026-09-13T09:0${i}:30Z`),
          ]).flat(),
          committed("2026-09-13T10:00:00Z", OTHER),
        ],
      });
      assert.equal(row.action, "skip");
      assert.equal(row.reason, "ejected-at-current-head");
    });

    it("PEN-5028: the detail names remedies that exist — not a deleted queue build", () => {
      // An ejection DELETES the `gh-readonly-queue/...` branch, so "rerun the
      // queue build" pointed a human at a dead ref. A push and a manual
      // re-enqueue are the only two things that clear this row.
      const row = classify({ mergeStateStatus: "CLEAN", timeline: withEjections(EJECTIONS_BEFORE_HOLD) });
      assert.match(row.detail, /push a fix/);
      assert.match(row.detail, /re-enqueue manually/);
      assert.doesNotMatch(row.detail, /rerun the queue build/);
    });
  });

  it("is aged by the stale-hold report — it is a wedge, not a deliberate hold", () => {
    // DELIBERATE_HOLD_REASON_RE must not grow to cover this. A PR ejected
    // twice at an unchanged head is stuck and wants a human; aging it is the
    // only thing that ever says how long it has been stuck.
    const stuck = pr({
      number: 3089,
      mergeStateStatus: "CLEAN",
      // The hold's age is measured off the newest CHECK stamp, not off the
      // timeline — see judgeableAgeHours.
      statusCheckRollup: [{ name: "verify", conclusion: "SUCCESS", completedAt: "2026-09-12T20:00:00Z" }],
    });
    const held = stalledHolds(
      [stuck],
      [{ number: 3089, action: "skip", reason: "ejected-at-current-head" }],
      { now: NOW },
    );
    assert.deepEqual(held.map((row) => row.number), [3089]);
  });
});

describe("resolveMergeState (PEN-5057)", () => {
  // A run stub that returns each queued state in turn and records every call,
  // so "how many reads did this cost" is asserted rather than assumed.
  const stub = (states) => {
    const calls = [];
    return {
      calls,
      run: (args) => {
        calls.push(args);
        return JSON.stringify({ mergeStateStatus: states[calls.length - 1] });
      },
    };
  };
  const sleeps = () => {
    const slept = [];
    return { slept, sleep: (ms) => slept.push(ms) };
  };

  it("spends nothing on a PR whose state GitHub already computed", () => {
    const { calls, run } = stub([]);
    const { slept, sleep } = sleeps();
    assert.equal(resolveMergeState("o/r", 1, "CLEAN", { run, sleep }), "CLEAN");
    assert.deepEqual(calls, []);
    assert.deepEqual(slept, []);
  });

  it("resolves UNKNOWN -> CLEAN, which is the enqueue this bug suppressed", () => {
    const { calls, run } = stub(["CLEAN"]);
    const { slept, sleep } = sleeps();
    assert.equal(resolveMergeState("o/r", 3123, "UNKNOWN", { run, sleep }), "CLEAN");
    assert.equal(calls.length, 1);
    // Sleeps BEFORE the first re-read: the read that reported UNKNOWN is what
    // scheduled the recomputation.
    assert.deepEqual(slept, [2000]);
  });

  it("stops at the first computed value instead of spending every retry", () => {
    const { calls, run } = stub(["UNKNOWN", "CLEAN", "CLEAN"]);
    const { sleep } = sleeps();
    assert.equal(resolveMergeState("o/r", 1, "UNKNOWN", { run, sleep }), "CLEAN");
    assert.equal(calls.length, 2);
  });

  it("holds a PR that is STILL UNKNOWN when the retries are spent", () => {
    const { calls, run } = stub(["UNKNOWN", "UNKNOWN", "UNKNOWN"]);
    const { sleep } = sleeps();
    assert.equal(resolveMergeState("o/r", 1, "UNKNOWN", { run, sleep }), "UNKNOWN");
    assert.equal(calls.length, 3);
    assert.ok(UNLANDABLE_MERGE_STATES.has("UNKNOWN"));
  });

  it("resolves UNKNOWN -> DIRTY and HOLDS — it is not a retry-until-it-looks-good", () => {
    const { run } = stub(["DIRTY"]);
    const { sleep } = sleeps();
    const resolved = resolveMergeState("o/r", 1, "UNKNOWN", { run, sleep });
    assert.equal(resolved, "DIRTY");
    assert.ok(UNLANDABLE_MERGE_STATES.has(resolved));
  });

  it("treats a throwing read as still-unknown rather than killing the fire", () => {
    let calls = 0;
    const run = () => {
      calls += 1;
      if (calls === 1) throw new Error("gh: 502 Bad Gateway");
      return JSON.stringify({ mergeStateStatus: "CLEAN" });
    };
    const { sleep } = sleeps();
    assert.equal(resolveMergeState("o/r", 1, "UNKNOWN", { run, sleep }), "CLEAN");
    assert.equal(calls, 2);
  });

  it("returns UNKNOWN when every read throws", () => {
    const run = () => {
      throw new Error("gh: network unreachable");
    };
    const { sleep } = sleeps();
    assert.equal(resolveMergeState("o/r", 1, "UNKNOWN", { run, sleep }), "UNKNOWN");
  });

  it("asks for mergeStateStatus on the named PR and repo", () => {
    const { calls, run } = stub(["CLEAN"]);
    const { sleep } = sleeps();
    resolveMergeState("Blockcast/paperclip", 3098, "UNKNOWN", { run, sleep });
    assert.deepEqual(calls[0], [
      "pr",
      "view",
      "3098",
      "--repo",
      "Blockcast/paperclip",
      "--json",
      "mergeStateStatus",
    ]);
  });

  it("treats a missing/absent state as UNKNOWN rather than as computed", () => {
    const { calls, run } = stub(["CLEAN"]);
    const { sleep } = sleeps();
    assert.equal(resolveMergeState("o/r", 1, undefined, { run, sleep }), "CLEAN");
    assert.equal(calls.length, 1);
  });
});

describe("unlanded-eligible PRs (PEN-5263)", () => {
  const checkAt = (iso) => [
    { __typename: "CheckRun", name: "verify", conclusion: "SUCCESS", completedAt: iso },
  ];
  const pr = (number, iso) => ({ number, statusCheckRollup: iso === null ? [] : checkAt(iso) });
  const row = (number, action, reason) => ({ number, action, reason });

  const FRESH = "2026-09-13T11:00:00Z"; // 1h before NOW
  const OLD = "2026-09-12T20:00:00Z"; // 16h before NOW

  it("reports a PR the classifier said yes to that is still open hours later", () => {
    // #3241's shape, 2026-11-02: `enqueue` / `mergestate:CLEAN`, Ally clean at
    // the exact head, no outstanding reviewer — and 21 PRs merged past it
    // while it sat there. It appeared in no report anywhere, because the only
    // report in the routine enumerates reasons for inaction and it had none.
    assert.deepEqual(
      unlandedEligible([pr(3241, OLD)], [row(3241, "enqueue", "mergestate:CLEAN")], { now: NOW }),
      [{ number: 3241, reason: "mergestate:CLEAN", ageHours: 16 }],
    );
  });

  it("does not report a PR that is about to land — the normal case", () => {
    // The overwhelming majority of `enqueue` rows are this. A detector that
    // named them would fire on its own normal operation and be ignored.
    assert.deepEqual(
      unlandedEligible([pr(1, FRESH)], [row(1, "enqueue", "mergestate:CLEAN")], { now: NOW }),
      [],
    );
  });

  it("is disjoint from stalledHolds — a PR is in exactly one cohort", () => {
    // The two blocks print together, so an overlap would name one PR twice
    // under two mechanisms. `stalledHolds` takes rows WITH a reason for
    // inaction, this one takes rows with none; the split is on `action`, so
    // it is total.
    const prs = [pr(1, OLD), pr(2, OLD)];
    const rows = [
      row(1, "enqueue", "mergestate:CLEAN"),
      row(2, "codeowner-review-requested", "owner-approval-pending"),
    ];
    assert.deepEqual(unlandedEligible(prs, rows, { now: NOW }), [
      { number: 1, reason: "mergestate:CLEAN", ageHours: 16 },
    ]);
    assert.deepEqual(stalledHolds(prs, rows, { now: NOW }), [
      { number: 2, reason: "owner-approval-pending", ageHours: 16 },
    ]);
  });

  it("leaves the cohorts that already have a clock to someone else", () => {
    // `already-enqueued` is bounded by STALE_ENQUEUE_HOURS off the auto-merge
    // request's own `enabledAt`, which is a better clock than this one;
    // `enqueue-failed` falls out of NON_HOLD_ACTIONS and is aged by
    // `stalledHolds`. Claiming either here would name one PR twice.
    const prs = [pr(1, OLD), pr(2, OLD), pr(3, OLD)];
    const rows = [
      row(1, "already-enqueued", "auto-merge armed 1.0h ago"),
      row(2, "stale-enqueue", "auto-merge armed 20.0h ago"),
      row(3, "enqueue-failed", "mergestate:CLEAN"),
    ];
    assert.deepEqual(unlandedEligible(prs, rows, { now: NOW }), []);
    assert.deepEqual(
      stalledHolds(prs, rows, { now: NOW }).map((held) => held.number),
      [3],
      "enqueue-failed is the one of the three stalledHolds owns",
    );
  });

  it("does NOT claim the cap-deferred row — neither of these two owns it", () => {
    // `classifyAll` rewrites an over-budget `enqueue` into `skip`/`cap:`, so
    // the row no longer reads `enqueue` and is excluded here by action.
    // `stalledHolds` excludes it by reason, deliberately: the deferred rows
    // are selected for old check stamps, so this clock is biased against them.
    //
    // Both exclusions are UNCHANGED by PEN-5391 and this pin is why: the
    // cap-starved case is owned by `capStarved`, which discriminates on the
    // PR's timeline rather than on either of these clocks. Widening either
    // predicate here still has to be a choice, and still should not be made.
    const prs = [pr(1, OLD)];
    const rows = [row(1, "skip", `cap:${MAX_ENQUEUES_PER_FIRE}-per-fire`)];
    assert.deepEqual(unlandedEligible(prs, rows, { now: NOW }), []);
    assert.deepEqual(stalledHolds(prs, rows, { now: NOW }), []);
  });

  it("never claims a deliberate hold, including #3209's do-not-merge label", () => {
    // #3209 was PEN-5263's one unexplained residual. It is explained: the
    // `do-not-merge` label was applied 2026-11-01T11:55:56Z, 2m56s after its
    // head commit and ~20h before the measurement, so it classified
    // `skip`/`label:do-not-merge` throughout. An explicit opt-out, not a
    // strand — and it must never reach this cohort, whose whole claim is that
    // nothing is holding the row.
    assert.deepEqual(
      unlandedEligible([pr(3209, OLD)], [row(3209, "skip", "label:do-not-merge")], { now: NOW }),
      [],
    );
  });

  it("does not claim a row whose merge state GitHub has not computed", () => {
    // Measured 2026-11-02: #3241 and #3255 read `enqueue`/`mergestate:CLEAN`
    // at 09:0xZ and `skip`/`mergestate:UNKNOWN` at 09:2xZ, after
    // `resolveMergeState` had spent its retries. UNKNOWN is UNREAD, so this
    // cohort — whose entire content is "nothing is holding this" — must not
    // claim it. Costs one sample; `stalledHolds` owns the row from
    // STALE_HOLD_HOURS. Pinned so a later widening has to argue past it.
    const prs = [pr(3241, OLD)];
    const rows = [row(3241, "skip", "mergestate:UNKNOWN")];
    assert.deepEqual(unlandedEligible(prs, rows, { now: NOW }), []);
    assert.deepEqual(stalledHolds(prs, rows, { now: NOW }), [
      { number: 3241, reason: "mergestate:UNKNOWN", ageHours: 16 },
    ]);
  });

  it("REPORTS an undatable eligible row rather than dropping it", () => {
    // Same §4l posture as `stalledHolds`: an instrument that cannot see
    // something must not report clean. Narrow — it needs a non-empty rollup
    // with no timestamp on any entry — and a row that persists here is a true
    // finding twice over: nothing landed it, and nothing dated it.
    assert.deepEqual(
      unlandedEligible(
        [{ number: 1, statusCheckRollup: [{ name: "verify", conclusion: "SUCCESS" }] }],
        [row(1, "enqueue", "mergestate:CLEAN")],
        { now: NOW },
      ),
      [{ number: 1, reason: "mergestate:CLEAN", ageHours: null }],
    );
    assert.deepEqual(
      unlandedEligible([], [row(9, "enqueue", "mergestate:CLEAN")], { now: NOW }),
      [{ number: 9, reason: "mergestate:CLEAN", ageHours: null }],
      "a row whose PR is missing entirely is still reported",
    );
  });

  it("renders nothing when none is stranded, and names each one when they are", () => {
    assert.equal(renderUnlandedEligible("a/one", []), "");
    const text = renderUnlandedEligible("a/one", [
      { number: 3241, reason: "mergestate:CLEAN", ageHours: 9.3 },
      { number: 8, reason: "mergestate:CLEAN", ageHours: null },
    ]);
    assert.match(text, /unlanded-eligible \(judgeable >6h or undated, nothing holding it\)/);
    // The remedy has to point AWAY from the PR: every one of these rows is
    // clean, so a reader sent to inspect the PR finds nothing and concludes
    // the report is noise.
    assert.match(text, /the landing itself, not a decision about it/);
    assert.match(text, /a\/one#3241 — `mergestate:CLEAN`, 9\.3h/);
    assert.match(text, /a\/one#8 — `mergestate:CLEAN`, age unknown/);
  });

  it("shares the settle floor's clock, so the two cannot drift apart", () => {
    assert.equal(UNLANDED_ELIGIBLE_HOURS < STALE_HOLD_HOURS, true);
    const withMirror = {
      number: 1,
      statusCheckRollup: [
        { __typename: "CheckRun", name: "verify", conclusion: "SUCCESS", completedAt: OLD },
        {
          __typename: "StatusContext",
          context: "gate/ally-comment-findings",
          state: "SUCCESS",
          createdAt: FRESH,
        },
      ],
    };
    // #1981's shape: an Ally verdict mirror posted after CI finished must not
    // restart the clock on a PR that has not moved.
    assert.deepEqual(
      unlandedEligible([withMirror], [row(1, "enqueue", "mergestate:CLEAN")], { now: NOW }),
      [{ number: 1, reason: "mergestate:CLEAN", ageHours: 16 }],
    );
  });

  it("turns the schedule red only when something is stranded (AC4)", () => {
    // The whole point of the scheduled detector: a stranded PR must surface
    // without a human noticing by hand. Exiting 0 on a non-empty cohort is
    // the failure this guards, and it is silent.
    assert.equal(alarmExitCode([]), 0);
    assert.equal(alarmExitCode(undefined), 0);
    assert.equal(alarmExitCode(["a/one#3241"]), 1);
    assert.equal(alarmExitCode(["a/one#3241", "a/one#3255"]), 1);
  });
});

describe("stated holds on the PR (PEN-5263)", () => {
  it("keys the marker by reason, so a later hold is not silenced by an earlier one", () => {
    // Keyed by PR alone, a row that waited on CI and then sat on a code-owner
    // request would carry a comment naming the CI and nothing naming the
    // owner — the exact silent-hold shape this closes.
    assert.notEqual(
      statedHoldMarker("checks:FAILURE"),
      statedHoldMarker("owner-approval-pending"),
    );
    assert.equal(
      statedHoldMarker("mergestate:DIRTY"),
      "<!-- landing-routine:stated-hold:mergestate-dirty -->",
    );
  });

  it("cannot be made to close its own HTML comment", () => {
    // Reasons carry free text (`cap:10-per-fire`, a detail string), so the
    // marker slugs rather than interpolates. A `-->` reaching the marker
    // would terminate it early and leave the rest of the body as visible
    // noise — and, worse, break the idempotency substring match so the
    // routine re-posted every fire.
    const marker = statedHoldMarker("evil --> <script>x</script>");
    assert.equal(marker.match(/-->/g).length, 1);
    assert.equal(marker.endsWith(" -->"), true);
    assert.equal(marker.includes("<script>"), false);
  });

  it("slugs a reason the vocabulary does not cover without colliding", () => {
    assert.equal(statedHoldMarker(undefined), "<!-- landing-routine:stated-hold:unknown -->");
    assert.notEqual(statedHoldMarker("checks:none"), statedHoldMarker("checks:FAILURE"));
  });

  it("posts once per reason and never again", () => {
    const calls = [];
    const marker = statedHoldMarker("owner-approval-pending");
    const run = (args) => {
      calls.push(args);
      if (args[0] === "api") return JSON.stringify([]);
      return "";
    };
    assert.equal(
      stateHold("a/one", { number: 7, reason: "owner-approval-pending", ageHours: 40.2 }, run),
      "posted",
    );
    const [read, write] = calls;
    assert.deepEqual(read, ["api", "repos/a/one/issues/7/comments", "--paginate"]);
    assert.deepEqual(write.slice(0, 5), ["pr", "comment", "7", "--repo", "a/one"]);
    assert.match(write[6], /^<!-- landing-routine:stated-hold:owner-approval-pending -->/);
    assert.match(write[6], /`owner-approval-pending`/);
    assert.match(write[6], /last reported 40\.2h ago/);
    // The reader has to know this will not repeat, or the natural response to
    // a routine comment is to mute the routine.
    assert.match(write[6], /once per reason, not once per fire/);

    // Second fire, same reason: the marker is already there.
    const seen = (args) =>
      args[0] === "api" ? JSON.stringify([{ body: `${marker}\nanything` }]) : "";
    const after = [];
    assert.equal(
      stateHold(
        "a/one",
        { number: 7, reason: "owner-approval-pending", ageHours: 64 },
        (args) => (after.push(args), seen(args)),
      ),
      "already-posted",
    );
    assert.equal(after.length, 1, "reads the comments, writes nothing");
  });

  it("states an undatable hold without claiming a duration it does not have", () => {
    const calls = [];
    const run = (args) => (calls.push(args), args[0] === "api" ? JSON.stringify([]) : "");
    stateHold("a/one", { number: 8, reason: "checks:none", ageHours: null }, run);
    assert.match(calls[1][6], /an unknown time \(no dated check on this head\)/);
    assert.doesNotMatch(calls[1][6], /NaN|null|undefined/);
  });

  // PEN-5263: `checks:FAILURE` on the bare `review` context reads as "go fix
  // the code" and is the one hold in this repo that an author can usually
  // clear alone. `#3032` sat on it six days; `#3238` cleared in ~2 minutes.
  it("names the quality-gate remedy when the red check is the bare `review`", () => {
    const body = reviewGateRemedy("review=FAILURE, Build=SUCCESS");
    assert.match(body, /PR-quality gate/);
    assert.match(body, /commitperclip PR Review/);
    assert.match(body, /not CI and not a code finding/);
  });

  // The half the obvious one-liner gets wrong. Three of the six gates read
  // `files`/`commits`, so "edit the description, no push required" would send
  // a trailer or coverage failure round the edit loop forever.
  it("does not promise a description edit clears the gates that read the diff", () => {
    const body = reviewGateRemedy("review=FAILURE");
    assert.match(body, /template sections, linked issue, dedup search/);
    assert.match(body, /test coverage, lockfile, commit trailers/);
    assert.match(body, /they need a push/);
    // Must point at the only thing that knows which of the six actually fired.
    assert.match(body, /gate's own comment on this PR names which ones failed/);
  });

  // `failingChecks` emits `name=STATE`, and this repo also publishes
  // `security-review`. A substring test would claim the quality-gate remedy
  // for a red security review, which has no such remedy.
  it("matches the check name exactly and not as a substring", () => {
    assert.equal(reviewGateRemedy("security-review=FAILURE"), "");
    assert.equal(reviewGateRemedy("gate/ally-comment-findings=FAILURE"), "");
    assert.equal(reviewGateRemedy("review-gate=FAILURE"), "");
    assert.equal(reviewGateRemedy("mergestate:DIRTY"), "");
    assert.equal(reviewGateRemedy(undefined), "");
    assert.equal(reviewGateRemedy(null), "");
  });

  // A check name may itself contain `=` (the measured
  // `Worktree install (NODE_ENV=production)=QUEUED` case), so the name is
  // everything BEFORE the last `=`, not the first field.
  it("recovers the name when the check name itself contains `=`", () => {
    assert.equal(reviewGateRemedy("Worktree install (NODE_ENV=production)=QUEUED"), "");
    assert.match(
      reviewGateRemedy("Worktree install (NODE_ENV=production)=QUEUED, review=FAILURE"),
      /PR-quality gate/,
    );
  });

  it("appends the remedy to the stated hold, keeping the marker keyed on reason alone", () => {
    const calls = [];
    const run = (args) => (calls.push(args), args[0] === "api" ? JSON.stringify([]) : "");
    stateHold(
      "a/one",
      { number: 3032, reason: "checks:FAILURE", ageHours: 144, detail: "review=FAILURE" },
      run,
    );
    const body = calls[1][6];
    assert.match(body, /^<!-- landing-routine:stated-hold:checks-failure -->/);
    assert.match(body, /PR-quality gate/);
    // The generic sentence and the once-per-reason promise both survive.
    assert.match(body, /is not enqueuing this PR: `checks:FAILURE`/);
    assert.match(body, /once per reason, not once per fire/);
  });
});

describe("runRepo apply wiring (PEN-5263)", () => {
  // The cohort tests above call `unlandedEligible` and `stateHold` directly,
  // so none of them can see what `runRepo` does with the results. That gap is
  // where the review found the write-path defect this block pins.
  const NOW_ISO = "2026-09-13T12:00:00Z";
  const OLD = "2026-09-12T20:00:00Z"; // 16h before NOW_ISO, so well past both bars
  const checkAt = (iso) => [
    { __typename: "CheckRun", name: "verify", conclusion: "SUCCESS", completedAt: iso },
  ];
  const prAt = (number, iso) => ({ number, statusCheckRollup: checkAt(iso) });

  // `judgeableAgeHours` reads the wall clock, and `runRepo` does not take a
  // `now`. Pinning it is what makes OLD mean "16h" rather than "whenever the
  // suite happened to run".
  const atNow = (fn) => {
    const real = Date.now;
    Date.now = () => Date.parse(NOW_ISO);
    try {
      return fn();
    } finally {
      Date.now = real;
    }
  };

  const harness = ({ prs, rows, apply }) => {
    const stated = [];
    const applied = [];
    const stranded = [];
    const starved = [];
    const log = console.log;
    console.log = () => {};
    try {
      atNow(() =>
        runRepo({
          repo: "a/one",
          apply,
          settleMinutes: 0,
          spent: 0,
          rotted: [],
          stranded,
          starved,
          queued: [],
          fetch: () => prs,
          classify: () => rows,
          applyOne: (_repo, row) => (applied.push(row.number), "merge requested"),
          state: (_repo, row) => stated.push(row),
        }),
      );
    } finally {
      console.log = log;
    }
    return { stated, applied, stranded, starved, rows };
  };

  it("never tells a PR it just enqueued that it is not being enqueued", () => {
    // The defect: `applyRow` leaves a successful enqueue reading `enqueue`
    // (only `markFailure` renames it), `unlandedEligible` keys on exactly that
    // action, and it ran AFTER the apply loop — so the cohort collected the
    // rows the fire had just acted on and `stateHold` posted "The landing
    // routine is not enqueuing this PR" on them. Permanently, because
    // `commentOnce` never repeats.
    //
    // The trigger is the ordinary case, not an exotic one: a PR whose CI
    // finished long before its review or owner approval arrived is already
    // past UNLANDED_ELIGIBLE_HOURS on the very first fire that can enqueue it.
    const rows = [{ number: 3241, action: "enqueue", reason: "mergestate:CLEAN" }];
    const { stated, applied } = harness({
      prs: [prAt(3241, OLD)],
      rows,
      apply: true,
    });
    assert.deepEqual(applied, [3241], "the fire did enqueue it");
    assert.deepEqual(stated, [], "and said nothing contradicting that");
    assert.equal(rows[0].action, "enqueue", "a successful apply leaves the action alone");
    assert.match(rows[0].detail ?? "", /merge requested/);
  });

  // The unit tests above call `stateHold` with a `detail` the caller has to
  // supply. `stalledHolds` deliberately does not carry one, so if the join in
  // `runRepo` is wrong the remedy is silently never reached and every unit
  // test still passes.
  it("joins the classification detail onto the stated hold so the remedy is reachable", () => {
    const { stated } = harness({
      prs: [prAt(3032, OLD)],
      rows: [
        {
          number: 3032,
          action: "skip",
          reason: "checks:FAILURE",
          detail: "review=FAILURE",
        },
      ],
      apply: true,
    });
    // The apply loop appends its outcome to `detail`, so what reaches
    // `stateHold` is a COMPOSITE, not the bare classification string. (Here
    // that suffix comes from the harness stub; the real `applyRow` returns
    // null for a `skip`. It is asserted anyway because `enqueue-failed` rows
    // DO arrive composite in production, via `markFailure`.)
    assert.deepEqual(stated, [
      {
        number: 3032,
        reason: "checks:FAILURE",
        ageHours: 16,
        detail: "review=FAILURE — merge requested",
      },
    ]);
    // ...and the remedy must still fire on that composite, which is the whole
    // point of the join. A name parser that took the FIRST `=` field of the
    // whole string, or split on whitespace, would miss it.
    assert.match(reviewGateRemedy(stated[0].detail), /PR-quality gate/);
  });

  it("still states a durable hold that the fire did NOT act on", () => {
    // The other side of the cut: suppressing the just-enqueued cohort must not
    // take the real holds with it, or the fix trades one silent hold for all
    // of them.
    const { stated } = harness({
      prs: [prAt(7, OLD)],
      rows: [{ number: 7, action: "skip", reason: "mergestate:DIRTY" }],
      apply: true,
    });
    // `detail` rides along since PEN-5263 so `reviewGateRemedy` can read the
    // failing check names. The value here is the HARNESS's `applyOne` stub,
    // which returns an outcome for every action; the real `applyRow` returns
    // null for a `skip`, so a production DIRTY row reaches `stateHold` with
    // its classification detail (here, none) and no key is added at all.
    assert.deepEqual(stated, [
      { number: 7, reason: "mergestate:DIRTY", ageHours: 16, detail: "merge requested" },
    ]);
  });

  it("does not post a second hold comment where applyRow already posted one", () => {
    // `codeowner-review-requested` is in neither NON_HOLD_ACTIONS nor
    // DELIBERATE_HOLD_REASON_RE, so it reaches `stalledHolds` on age and used
    // to collect a `stated-hold:owner-approval-pending` comment beside the
    // bespoke CODEOWNER_REQUEST_MARKER one. Two comments, same claim, and only
    // the bespoke one names the owner.
    const { stated, applied } = harness({
      prs: [prAt(3102, OLD)],
      rows: [
        { number: 3102, action: "codeowner-review-requested", reason: "owner-approval-pending" },
      ],
      apply: true,
    });
    assert.deepEqual(applied, [3102], "applyRow still posts its own comment");
    assert.deepEqual(stated, [], "and the age report does not repeat it");
  });

  it("reports the cohort on a dry run, where the action still means what it says", () => {
    // The suppression is apply-only. On a dry run nothing has acted, so a row
    // reading `enqueue` really does mean "no fire has taken this" — which is
    // the whole detector, and what `--alarm` exits non-zero on.
    const { stated, applied, stranded } = harness({
      prs: [prAt(3241, OLD)],
      rows: [{ number: 3241, action: "enqueue", reason: "mergestate:CLEAN" }],
      apply: false,
    });
    assert.deepEqual(applied, [], "a dry run writes nothing");
    assert.deepEqual(stated, []);
    assert.deepEqual(stranded, ["a/one#3241"], "and the alarm can still see it");
    assert.equal(alarmExitCode(stranded), 1);
  });
});

describe("transient 5xx retry in gh() (PEN-5314)", () => {
  // `withRetry` announces each attempt with `::warning::`, and this suite runs
  // inside landing-sweep.yml — unsilenced it would hang a workflow annotation
  // off every green run.
  const quiet = (fn) => {
    const real = console.log;
    console.log = () => {};
    try {
      return fn();
    } finally {
      console.log = real;
    }
  };
  const fails = (stderr) => () => {
    throw Object.assign(new Error("gh failed"), { stderr });
  };
  const READ = ["pr", "list", "--repo", "o/r", "--state", "open"];
  const WRITE = ["pr", "merge", "3241", "--repo", "o/r", "--auto", "--rebase"];

  describe("isTransientGhError", () => {
    it("accepts the measured 5xx shapes, by status or by prose", () => {
      for (const text of [
        "HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)",
        "HTTP 503",
        "HTTP 504",
        "Bad Gateway",
        "Service Unavailable",
        "Gateway Timeout",
        "Gateway Time-out",
      ]) {
        assert.equal(isTransientGhError(text), true, text);
      }
    });

    it("refuses 500, which retrying cannot fix, and every non-5xx class", () => {
      for (const text of ["HTTP 500", "HTTP 404", "HTTP 422", "", null, undefined]) {
        assert.equal(isTransientGhError(text), false, String(text));
      }
    });

    // The deliberate abort must survive: a fire that continued past an
    // exhausted rate limit would print `skip:` rows indistinguishable from
    // real verdicts, which is what `isFatalGhError` exists to prevent.
    it("never claims a fatal error is transient, so the abort cannot be retried away", () => {
      for (const text of [
        "API rate limit exceeded for installation ID 138085375. (HTTP 403)",
        "HTTP 401: Bad credentials",
        "could not read Username for 'https://github.com'",
      ]) {
        assert.equal(isFatalGhError(text), true, `${text} is fatal`);
        assert.equal(isTransientGhError(text), false, `${text} is not transient`);
      }
    });
  });

  describe("isIdempotentGhRead", () => {
    it("admits the reads this script actually makes", () => {
      for (const args of [
        READ,
        ["pr", "view", "3241", "--repo", "o/r", "--json", "statusCheckRollup"],
        ["api", "repos/o/r/issues/1/timeline", "--paginate"],
        ["api", "repos/o/r/contents/CODEOWNERS"],
        ["api", "repos/o/r/pulls/1/files", "--paginate"],
        ["api", "-X", "GET", "repos/o/r"],
        // PEN-5442 splits the listing onto a paginated GraphQL query; it is a
        // POST on the wire and a read in meaning, so the query text decides.
        ["api", "graphql", "--paginate", "-F", "owner=o", "-F", "name=r"],
        ["api", "-i", "graphql", "-f", "query={viewer{login}}"],
      ]) {
        assert.equal(isIdempotentGhRead(args), true, args.join(" "));
      }
    });

    // ⛔ The safety property. A 5xx can be returned AFTER the mutation landed,
    // so a retried write can arm auto-merge twice or double-post a comment.
    it("refuses every write, and anything it cannot positively identify", () => {
      for (const args of [
        WRITE,
        ["pr", "merge", "3241", "--repo", "o/r", "--disable-auto"],
        ["pr", "comment", "3241", "--repo", "o/r", "--body", "hi"],
        ["api", "-X", "POST", "repos/o/r/statuses/abc", "-f", "state=success"],
        ["api", "--method", "DELETE", "repos/o/r/issues/1"],
        ["api", "repos/o/r/issues/1/comments", "-f", "body=hi"],
        ["api", "graphql", "-f", "query=mutation{enablePullRequestAutoMerge}"],
        ["pr", "edit", "1"],
        ["repo", "clone", "o/r"],
        [],
        undefined,
      ]) {
        assert.equal(isIdempotentGhRead(args), false, JSON.stringify(args ?? null));
      }
    });
  });

  it("retries a transient 5xx on a read and returns the eventual value", () => {
    let calls = 0;
    const out = quiet(() =>
      ghWithTransientRetry(READ, {
        delayMs: 0,
        exec: () => {
          calls += 1;
          if (calls < 3) fails("HTTP 502: 502 Bad Gateway")();
          return "[]";
        },
      }),
    );
    assert.equal(out, "[]");
    assert.equal(calls, 3, "two retries were spent");
  });

  // The defect in the row: one 502 on `fetchOpenPrs` took the whole fire down.
  it("rethrows once the attempts are exhausted, so the fire still fails closed", () => {
    let calls = 0;
    assert.throws(
      () =>
        quiet(() =>
          ghWithTransientRetry(READ, {
            delayMs: 0,
            exec: () => {
              calls += 1;
              fails(`HTTP 502 #${calls}`)();
            },
          }),
        ),
      /gh failed/,
    );
    assert.equal(calls, 3, "bounded — it does not retry forever");
  });

  it("spends exactly one attempt on a WRITE, however transient the failure looks", () => {
    for (const args of [WRITE, ["pr", "comment", "1", "--repo", "o/r", "--body", "x"]]) {
      let calls = 0;
      assert.throws(
        () =>
          quiet(() =>
            ghWithTransientRetry(args, {
              delayMs: 0,
              exec: () => {
                calls += 1;
                // Would SUCCEED on a retry, so one call proves none was spent.
                if (calls > 1) return "ok";
                fails("HTTP 502: 502 Bad Gateway")();
              },
            }),
          ),
        /gh failed/,
      );
      assert.equal(calls, 1, `${args[1]} must not be repeated`);
    }
  });

  it("does not retry a read whose failure is a 404 or an exhausted rate limit", () => {
    for (const stderr of [
      "HTTP 404: Not Found",
      "API rate limit exceeded for installation ID 1. (HTTP 403)",
    ]) {
      let calls = 0;
      assert.throws(
        () =>
          quiet(() =>
            ghWithTransientRetry(["api", "repos/o/r/contents/CODEOWNERS"], {
              delayMs: 0,
              exec: () => {
                calls += 1;
                if (calls > 1) return "{}";
                fails(stderr)();
              },
            }),
          ),
        /gh failed/,
      );
      assert.equal(calls, 1, stderr);
    }
  });

  it("reads the failure text from stderr, message, or the error itself", () => {
    assert.equal(ghErrorMessage({ stderr: Buffer.from("HTTP 502") }), "HTTP 502");
    assert.equal(ghErrorMessage(new Error("HTTP 504")), "HTTP 504");
    assert.equal(ghErrorMessage("plain"), "plain");
  });
});

describe("the unmeasured exit code (PEN-5314)", () => {
  // ⛔ The whole row: red must stop meaning two different things.
  it("is distinct from every other code this script can spend", () => {
    assert.equal(EXIT_UNMEASURED, 3);
    assert.notEqual(EXIT_UNMEASURED, alarmExitCode([]), "not the all-clear");
    assert.notEqual(EXIT_UNMEASURED, alarmExitCode(["a/one#1"]), "not the alarm");
    assert.notEqual(EXIT_UNMEASURED, 2, "2 is --alarm + --apply misuse");
  });

  const capture = (error, stranded, options) => {
    const lines = [];
    reportUnmeasured(error, stranded, { ...options, log: (line) => lines.push(line) });
    return lines.join("\n");
  };

  it("names the failure and refuses to claim a verdict", () => {
    const out = capture(Object.assign(new Error("x"), { stderr: "HTTP 502: Bad Gateway\nmore" }), []);
    assert.match(out, /DID NOT MEASURE/);
    assert.match(out, /HTTP 502: Bad Gateway/);
    assert.doesNotMatch(out, /more/, "only the first line of the failure");
    assert.match(out, /makes no claim/);
  });

  // The wake-comment finding: `stranded` was populated and then discarded
  // unread, so the run went red as a stack trace naming no PRs.
  it("reports the partial cohort it had computed before stopping", () => {
    const out = capture(new Error("HTTP 504"), ["a/one#3241", "a/two#17"], { alarm: true });
    assert.match(out, /a\/one#3241, a\/two#17/);
    assert.match(out, /possibly incomplete/);
  });

  it("calls an empty partial cohort a prefix, never an all-clear", () => {
    const out = capture(new Error("HTTP 504"), [], { alarm: true });
    assert.match(out, /PREFIX, not an all-clear/);
  });

  it("says nothing about a cohort when the run was not an alarm run", () => {
    const out = capture(new Error("HTTP 504"), ["a/one#1"], { alarm: false });
    assert.doesNotMatch(out, /a\/one#1/);
  });

  it("⛔ an unreadable repo ALONE is unmeasured; a real cohort beside it still alarms", () => {
    const blocked = ["a/broken (HTTP 502)"];
    assert.equal(alarmExitCode([], blocked, []), EXIT_UNMEASURED, "nothing measured, a repo unread");
    // PRECEDENCE. A measured verdict outranks a transport report: there IS a
    // PR to act on, and 1 is the code that says so. The `unreadable` ALARM
    // block still names the skipped repo, so spending 3 here would cost the
    // actionable signal and buy nothing.
    assert.equal(alarmExitCode(["a/one#1"], blocked, []), 1, "a stranded PR outranks it");
    assert.equal(alarmExitCode([], blocked, ["a/one#2"]), 1, "so does a cap-starved one");
    assert.equal(alarmExitCode([], [], []), 0, "control: a clean measured run is still green");
    // PEN-5442's fail-open guard is indifferent to the renumbering, and is
    // asserted separately so it keeps holding if the integer ever moves again.
    for (const code of [alarmExitCode([], blocked, []), alarmExitCode(["a/one#1"], blocked, [])]) {
      assert.notEqual(code, 0, "an unread repo can never produce a green run");
    }
  });

  it("reports the partial cap-starved cohort too, not only the stranded one", () => {
    const out = capture(new Error("HTTP 504"), ["a/one#3241"], {
      alarm: true,
      starved: ["a/two#3306"],
    });
    assert.match(out, /Partial unlanded-eligible cohort .*a\/one#3241/);
    assert.match(out, /Partial cap-starved cohort .*a\/two#3306/);
  });

  it("reports a cap-starved prefix even when the stranded cohort is empty", () => {
    const out = capture(new Error("HTTP 504"), [], { alarm: true, starved: ["a/two#3306"] });
    assert.match(out, /Partial cap-starved cohort .*a\/two#3306/);
    assert.doesNotMatch(out, /PREFIX, not an all-clear/, "something WAS found before stopping");
  });

  it("calls BOTH cohorts empty a prefix, never an all-clear", () => {
    const out = capture(new Error("HTTP 504"), [], { alarm: true, starved: [] });
    assert.match(out, /PREFIX, not an all-clear/);
  });

  it("keeps the frames for a throw that did not come from gh", () => {
    // A `gh` failure carries stderr, and one line is the right amount of it.
    // A programming error carries none — there the frames ARE the diagnosis,
    // and the first line is the least useful part of them.
    const bug = new Error("rows.map is not a function");
    const out = capture(bug, [], {});
    assert.match(out, /rows\.map is not a function/);
    assert.ok(out.includes(bug.stack), "the frames Node would have printed are kept");

    const gh = Object.assign(new Error("gh failed"), { stderr: "HTTP 502: Bad Gateway\nnoise" });
    const ghOut = capture(gh, [], {});
    assert.doesNotMatch(ghOut, /noise/, "a gh failure is still trimmed to one line");
    assert.ok(!ghOut.includes(gh.stack), "and still carries no frames");
  });
});

describe("rate-limit retry in gh() (BLO-51665)", () => {
  const refused = () =>
    Object.assign(new Error("gh failed"), {
      stderr: "gh: API rate limit exceeded for installation ID 138085375. (HTTP 403)",
    });

  it("waits out one refusal whose reset is near, then succeeds", () => {
    const calls = [];
    const slept = [];
    const out = ghWithRateLimitRetry(["api", "repos/o/r/issues/1/timeline", "--paginate"], {
      exec: (args) => {
        calls.push(args);
        if (calls.length === 1) throw refused();
        return "[]";
      },
      sleep: (ms) => slept.push(ms),
      waitMs: () => 27_000,
    });
    assert.equal(out, "[]");
    assert.equal(calls.length, 2);
    assert.deepEqual(slept, [27_000]);
  });

  it("keeps the abort for a far reset, unreadable headers, a second refusal, or a non-rate-limit error", () => {
    for (const waitMs of [() => RATE_LIMIT_MAX_WAIT_MS + 1, () => null]) {
      // The retry would SUCCEED here, so throwing proves no retry was spent.
      let calls = 0;
      const exec = () => {
        calls += 1;
        if (calls === 1) throw refused();
        return "[]";
      };
      assert.throws(() => ghWithRateLimitRetry(["api", "x"], { exec, sleep: () => {}, waitMs }), /gh failed/);
      assert.equal(calls, 1);
    }
    let n = 0;
    assert.throws(
      () => ghWithRateLimitRetry(["api", "x"], { exec: () => { n += 1; throw refused(); }, sleep: () => {}, waitMs: () => 0 }),
      (error) => isFatalGhError(error.stderr),
    );
    assert.equal(n, 2, "exactly one retry");
    let waited = false;
    assert.throws(() =>
      ghWithRateLimitRetry(["api", "x"], {
        exec: () => { throw Object.assign(new Error("boom"), { stderr: "HTTP 404" }); },
        sleep: () => {},
        waitMs: () => ((waited = true), 0),
      }),
    );
    assert.equal(waited, false);
  });

  it("reads the reset from the failing probe's own headers, picking the bucket by call", () => {
    const probes = [];
    const exhausted = (args) => {
      probes.push(args);
      throw Object.assign(new Error("probe refused"), {
        stdout: "HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: 1000\n",
      });
    };
    assert.equal(rateLimitWaitMs(["api", "repos/o/r"], { exec: exhausted, now: () => 978_000 }), 27_000);
    assert.deepEqual(probes[0], ["api", "-i", "meta"]);
    rateLimitWaitMs(["pr", "list"], { exec: exhausted, now: () => 0 });
    assert.equal(probes[1][2], "graphql");
    assert.equal(rateLimitWaitMs(["api", "x"], { exec: () => "X-Ratelimit-Remaining: 12\n" }), 0);
    assert.equal(rateLimitWaitMs(["api", "x"], { exec: () => "no headers" }), null);
  });

  it("a crash while collecting PRs still names the repo on stdout", () => {
    const lines = [];
    const log = console.log;
    console.log = (line) => lines.push(String(line));
    try {
      assert.throws(() =>
        // `starved` (PEN-5391) sits between `stranded` and the options bag.
        // Omitting it silently bound this stub to `starved`, leaving `fetch`
        // defaulted to the real network call -- which is how this read green
        // against a live GraphQL error instead of the injected refusal. It is
        // no longer silent: `runRepo` now rejects a non-array in slot 7.
        runRepo({
          repo: "a/one",
          apply: true,
          settleMinutes: 0,
          spent: 0,
          rotted: [],
          stranded: [],
          starved: [],
          queued: [],
          fetch: () => { throw refused(); },
        }),
      );
    } finally {
      console.log = log;
    }
    // PEN-5442 reworded this from "Aborted while collecting PRs" — `runRepo`
    // still rethrows, but it is no longer the frame that decides whether the
    // fire ends, so it no longer claims to. The behaviour this test exists for
    // (BLO-51665: name the repo and the reason on stdout rather than dying
    // with an empty receipt) is unchanged.
    assert.match(lines.join("\n"), /## a\/one[\s\S]*Could not collect PRs: .*rate limit/);
  });
});

describe("the merge-state read is total and fail-closed (PEN-5442)", () => {
  // `fetchOpenPrs` now JOINS `mergeStateStatus` on from a second call, so for
  // the first time a row can reach the classifier carrying a state nobody
  // read. Every test here is about the SAME direction: an unread state must
  // never be a licence to merge. The opposite direction — holding a PR that
  // could have landed — costs one cycle and is not what these pin.

  it("maps every unrecognised shape to UNKNOWN and passes real states through", () => {
    for (const state of KNOWN_MERGE_STATES) {
      assert.equal(readMergeState(state), state, `${state} is a state and survives`);
      assert.equal(readMergeState(state.toLowerCase()), state, "case is normalised");
      assert.equal(readMergeState(` ${state} `), state, "surrounding space is trimmed");
    }
    // The shapes a join can produce. `""` is the one that matters: `??` passes
    // it through, so the obvious `String(x ?? "UNKNOWN").toUpperCase()` leaves
    // it as `""`, which is NOT in UNLANDABLE_MERGE_STATES and therefore falls
    // past every hold. Measured enqueuing before this existed.
    for (const value of ["", "   ", undefined, null, 0, 1, NaN, false, true, {}, [], "MERGED", "garbage"]) {
      assert.equal(readMergeState(value), "UNKNOWN", `${JSON.stringify(value) ?? String(value)} is not a state`);
    }
    assert.ok(UNLANDABLE_MERGE_STATES.has("UNKNOWN"), "and UNKNOWN is held");
  });

  it("⛔ a PR that would otherwise enqueue cannot enqueue once its merge state is lost", () => {
    // The guard the whole row is about. `classify`'s default PR is BLOCKED and
    // enqueues, so each case below differs from an enqueueing row by the merge
    // state ALONE.
    assert.equal(classify({ mergeStateStatus: "CLEAN" }).action, "enqueue", "control: this row does enqueue");

    const lost = {
      "deleted outright": (pr) => { delete pr.mergeStateStatus; },
      "undefined": (pr) => { pr.mergeStateStatus = undefined; },
      "null": (pr) => { pr.mergeStateStatus = null; },
      "empty string": (pr) => { pr.mergeStateStatus = ""; },
      "whitespace": (pr) => { pr.mergeStateStatus = " "; },
      "a value outside the enum": (pr) => { pr.mergeStateStatus = "MERGED"; },
    };
    for (const [label, lose] of Object.entries(lost)) {
      const subject = pr({ mergeStateStatus: "CLEAN" });
      lose(subject);
      const row = classifyPr(subject, { now: NOW });
      assert.notEqual(row.action, "enqueue", `${label} must not enqueue`);
      assert.equal(row.action, "skip", `${label} holds`);
      assert.equal(row.reason, "mergestate:UNKNOWN", `${label} says why, in the resolvable form`);
    }
  });

  it("holds a lost state as UNKNOWN specifically, so resolveMergeState can still repair it", () => {
    // UNKNOWN rather than a new terminal reason: `resolveMergeState` re-reads
    // exactly UNKNOWN, so a row that lost its state to the two-call race is
    // repaired on the same fire instead of waiting a cycle. A bespoke
    // `mergestate:MISSING` would have been a permanent hold.
    const calls = [];
    const run = (args) => (calls.push(args), JSON.stringify({ mergeStateStatus: "CLEAN" }));
    assert.equal(
      resolveMergeState("a/one", 1418, readMergeState(""), { run, sleep: () => {} }),
      "CLEAN",
    );
    assert.equal(calls.length, 1, "one re-read repaired it");
  });
});

describe("fetchOpenPrs splits the listing and joins on number (PEN-5442)", () => {
  const HEAD_A = "1".repeat(40);
  const HEAD_B = "2".repeat(40);
  const listing = [
    { number: 11, headRefOid: HEAD_A, author: { login: "kkroo", is_bot: false }, labels: [], isDraft: false, autoMergeRequest: null, reviewRequests: [] },
    { number: 22, headRefOid: HEAD_B, author: { login: "kkroo", is_bot: false }, labels: [], isDraft: false, autoMergeRequest: null, reviewRequests: [] },
  ];
  // Every row here is human-authored, so `classifyFromListing` decides them all
  // and `fetchOpenPrs` never hydrates — no checks, no reviews, no timeline. The
  // join is the only thing under test.
  const run = (args) => {
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(listing);
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };

  it("asks for the merge state in a SEPARATE call, and not in the listing", () => {
    // The defect: one call carrying all 8 fields 502'd on 3 of 3 attempts
    // against a 153-open-PR repo. Splitting it is the fix, so the listing must
    // not quietly regain the field.
    const seen = [];
    fetchOpenPrs("a/one", {
      run: (args) => (seen.push(args), run(args)),
      mergeStates: () => new Map([[11, "CLEAN"], [22, "CLEAN"]]),
    });
    const list = seen.find((args) => args[0] === "pr" && args[1] === "list");
    assert.ok(list, "it still lists");
    const fields = list[list.indexOf("--json") + 1];
    assert.ok(!fields.includes("mergeStateStatus"), `the listing must not ask for it: ${fields}`);
    for (const field of ["number", "headRefOid", "author", "labels", "isDraft", "autoMergeRequest", "reviewRequests"]) {
      assert.ok(fields.includes(field), `${field} still comes from the listing`);
    }
  });

  it("joins each row to ITS OWN number, not to the position in the other call", () => {
    // The join risk that made this its own PR. The two calls are independent
    // reads, so the merge-state call can come back in a different order, or
    // short — and a positional join would hand #22's state to #11. Returned
    // reversed on purpose.
    const prs = fetchOpenPrs("a/one", {
      run,
      mergeStates: () => new Map([[22, "DIRTY"], [11, "CLEAN"]]),
    });
    assert.deepEqual(
      prs.map((row) => [row.number, row.mergeStateStatus]),
      [[11, "CLEAN"], [22, "DIRTY"]],
    );
  });

  it("holds a row the merge-state call did not return, rather than inventing a state", () => {
    // The expected race, not a bug: the two calls are not atomic, so a PR open
    // for the listing can merge before the merge-state read. It must resolve
    // to a hold — and to UNKNOWN specifically.
    const prs = fetchOpenPrs("a/one", { run, mergeStates: () => new Map([[11, "CLEAN"]]) });
    assert.equal(prs[0].mergeStateStatus, "CLEAN");
    assert.equal(prs[1].mergeStateStatus, "UNKNOWN", "#22 was not in the second call");
    assert.equal(classifyPr({ ...pr(), ...prs[1] }, { now: NOW }).action, "skip");
  });

  it("holds every row when the merge-state call comes back empty", () => {
    // The whole-call failure mode, which is the one actually measured. If this
    // ever enqueued, a single bad second call would merge the entire open set.
    const prs = fetchOpenPrs("a/one", { run, mergeStates: () => new Map() });
    for (const row of prs) assert.equal(row.mergeStateStatus, "UNKNOWN");
  });

  it("fails the whole read when the merge-state call throws, rather than returning stateless rows", () => {
    // Read BEFORE the join for this reason: a caught-and-ignored failure would
    // yield a full listing with every state missing, which is the previous
    // test's shape arrived at by accident instead of on purpose.
    assert.throws(
      () => fetchOpenPrs("a/one", { run, mergeStates: () => { throw new Error("HTTP 502"); } }),
      /502/,
    );
  });

  it("threads the injected `run` into the merge-queue read, instead of falling back to the real gh", () => {
    // The defect this pins. `fetchOpenPrs` takes an injected `run` and threads
    // it into every read it makes except one: `fetchMergeQueueEntries` was
    // called as `(repo, base)`, so its third parameter fell back to the
    // module-level `gh`. None of the tests above caught it because none of
    // their listing rows carry `baseRefName`, and `mergeQueueEntryFor` returns
    // before the call is made when the base is absent.
    //
    // Assert on what the stub SAW rather than on the verdict, because the
    // verdict cannot distinguish the two: `fetchMergeQueueEntries` catches its
    // own throws and returns `null`, so the fallback degraded to "queue
    // unread" in silence. Keyed this way the test fails deterministically if
    // the argument is dropped again, with or without a network.
    const seen = [];
    const based = [{ ...listing[0], baseRefName: "master" }];
    const prs = fetchOpenPrs("a/one", {
      run: (args) => {
        seen.push(args);
        if (args[0] === "pr" && args[1] === "list") return JSON.stringify(based);
        if (args[0] === "api" && args[1] === "graphql") {
          return JSON.stringify({
            data: {
              repository: {
                mergeQueue: {
                  entries: {
                    pageInfo: { hasNextPage: false },
                    nodes: [{ position: 1, state: "QUEUED", enqueuedAt: "2026-11-04T08:50:28Z", pullRequest: { number: 11 } }],
                  },
                },
              },
            },
          });
        }
        throw new Error(`unexpected gh call: ${args.join(" ")}`);
      },
      mergeStates: () => new Map([[11, "UNKNOWN"]]),
    });
    assert.ok(
      seen.some((args) => args[0] === "api" && args[1] === "graphql" && args.includes("branch=master")),
      "the merge-queue read must arrive at the injected run, not at the real gh",
    );
    assert.equal(prs[0].mergeQueueEntry?.position, 1, "and the stub's answer must reach the row");
  });
});

describe("fetchMergeStates reads merge states at a controlled page size (PEN-5442)", () => {
  const nd = (rows) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

  it("pages at MERGE_STATE_PAGE_SIZE, which is the measured fix", () => {
    // `gh pr list` pages at 100 whatever `--limit` says, and a 100-item page
    // carrying mergeStateStatus is what GitHub 502s on. 25 measured 6/6 clean
    // where the 100-item page measured 10/13.
    let seen;
    fetchMergeStates("a/one", { run: (args) => ((seen = args), nd([])) });
    assert.equal(seen[0], "api");
    assert.equal(seen[1], "graphql");
    assert.ok(seen.includes("--paginate"), "and follows every page");
    assert.ok(seen.includes(`first=${MERGE_STATE_PAGE_SIZE}`), seen.join(" "));
    assert.ok(MERGE_STATE_PAGE_SIZE < 100, "below the page size that fails");
    assert.ok(seen.includes("owner=a") && seen.includes("name=one"), "repo is split for GraphQL");
    const query = seen[seen.indexOf("-f") + 1];
    assert.ok(/states:OPEN/.test(query), query);
    // Two scalars and no nested connection: this is why the file's "do not
    // hand-roll GraphQL" warning (about `contexts(first: 100)` truncating
    // silently) does not transfer to this query.
    assert.ok(!/\(first:\s*100\)/.test(query), "no inner connection to truncate");
  });

  it("keys by number and normalises each state through readMergeState", () => {
    const states = fetchMergeStates("a/one", {
      run: () => nd([
        { number: 11, mergeStateStatus: "CLEAN" },
        { number: 22, mergeStateStatus: "dirty" },
        { number: 33, mergeStateStatus: "" },
        { number: 44, mergeStateStatus: null },
      ]),
    });
    assert.equal(states.get(11), "CLEAN");
    assert.equal(states.get(22), "DIRTY");
    // Normalised at the boundary, so a malformed node enters the join as a
    // hold rather than as a string the classifier has to defend against.
    assert.equal(states.get(33), "UNKNOWN");
    assert.equal(states.get(44), "UNKNOWN");
    assert.equal(states.get(99), undefined, "an absent number stays absent for the join to default");
  });

  it("tolerates the blank lines --paginate leaves between pages", () => {
    const states = fetchMergeStates("a/one", {
      run: () => '\n{"number":11,"mergeStateStatus":"CLEAN"}\n\n{"number":22,"mergeStateStatus":"BEHIND"}\n\n',
    });
    assert.deepEqual([...states.entries()], [[11, "CLEAN"], [22, "BEHIND"]]);
  });
});

describe("an unreadable repo is skipped, not fatal to the fire (PEN-5442)", () => {
  const quietly = (fn) => {
    const log = console.log;
    const lines = [];
    console.log = (line) => lines.push(String(line));
    try {
      return { value: fn(), lines: lines.join("\n") };
    } finally {
      console.log = log;
    }
  };
  // PEN-5482: `run` here stands in for `runRepo`, so it has to fail the way
  // `runRepo` does — a LISTING failure is tagged `collectFailed` by `runRepo`'s
  // own fetch catch, and that tag is what makes it skippable. An untagged throw
  // is a different failure and gets its own test below.
  const boom = (message) => () => {
    throw markCollectFailure(Object.assign(new Error("gh failed"), { stderr: message }));
  };

  it("⛔ one unreadable repo no longer ends the whole fire", () => {
    // The defect: `fetchOpenPrs` is the first thing `runRepo` does, its throw
    // escaped `runRepo`'s try, and neither `sweepRepos` nor `main` had a
    // catch — so a repo the routine merely could not LIST discarded every
    // other repo's verdicts. Measured 502 on 3 of 3 attempts against a
    // 153-open-PR repo, so this is the ordinary case for that repo, not an
    // exotic one.
    const unreadable = [];
    const swept = [];
    const run = ({ repo }) => {
      if (repo === "a/broken") boom("HTTP 502: 502 Bad Gateway")();
      swept.push(repo);
      return [{ number: 1, action: "enqueue" }];
    };
    const { value, lines } = quietly(() =>
      sweepRepos(
        ["a/broken", "a/fine"],
        repoRunner({
          apply: true,
          settleMinutes: 0,
          rotted: [],
          stranded: [],
          run,
          notify: new Set(),
          unreadable,
          starved: [],
          queued: [],
        }),
      ),
    );
    assert.deepEqual(swept, ["a/fine"], "the readable repo was still swept");
    assert.equal(value, 1, "and its enqueue still counted toward the cap");
    assert.deepEqual(unreadable, ["a/broken (HTTP 502: 502 Bad Gateway)"], "named, with the reason");
    assert.match(lines, /Skipped a\/broken/);
  });

  it("still ends the fire for a failure that makes every later verdict untrustworthy", () => {
    // `isFatalGhError` keeps its meaning. An exhausted rate limit or bad
    // credentials would make every subsequent `skip:` row indistinguishable
    // from a real verdict, which is a different thing from one repo being
    // unlistable. Skipping those would be the fail-open direction.
    for (const fatal of ["API rate limit exceeded (HTTP 403)", "Bad credentials", "HTTP 401"]) {
      const unreadable = [];
      assert.throws(
        () =>
          quietly(() =>
            sweepRepos(
              ["a/one"],
              repoRunner({
                apply: true,
                settleMinutes: 0,
                rotted: [],
                stranded: [],
                run: boom(fatal),
                notify: new Set(),
                unreadable,
                starved: [],
                queued: [],
              }),
            ),
          ),
        /gh failed/,
        `${fatal} must still abort`,
      );
      assert.deepEqual(unreadable, [], "and is not recorded as a mere skip");
    }
  });

  it("does not spend the skipped repo's budget on anything", () => {
    const unreadable = [];
    const seen = [];
    const run = ({ repo, spent }) => {
      seen.push([repo, spent]);
      if (repo === "a/broken") boom("HTTP 502")();  // tagged: a listing failure
      return [{ number: 1, action: "enqueue" }, { number: 2, action: "enqueue" }];
    };
    quietly(() =>
      sweepRepos(
        ["a/first", "a/broken", "a/last"],
        repoRunner({
          apply: true,
          settleMinutes: 0,
          rotted: [],
          stranded: [],
          run,
          notify: new Set(),
          unreadable,
          starved: [],
          queued: [],
        }),
      ),
    );
    // The skipped repo contributes no rows, so the carry into `a/last` is the
    // 2 that `a/first` actually spent — not 2 plus a guess for the repo nobody
    // could read.
    assert.deepEqual(seen, [["a/first", 0], ["a/broken", 2], ["a/last", 2]]);
  });

  it("keeps `unreadable` OUT of the per-repo argument vector, and `starved` IN", () => {
    // PEN-5442 + PEN-5391. Both cohorts are collected by reference and both are
    // `repoRunner` CONSTRUCTOR arguments, but they are not symmetric, and the
    // asymmetry is the thing worth pinning:
    //
    //   `unreadable` is observed OUT HERE, in `repoRunner`'s catch, because the
    //   condition it records is "`runRepo` threw before reporting anything".
    //   It must therefore never enter the per-repo vector.
    //
    //   `starved` is observed INSIDE the sweep, per PR — `starved.push` sits
    //   beside `stranded.push` in `runRepo` — so it must enter it.
    //
    // ⛔ This test was named "leaves the per-repo argument vector alone" and
    // asserted `length === 6`. The name went FALSE the moment `starved` was
    // threaded, while the assertion stayed true for an unrelated reason (the
    // options bag is still not appended). A name that contradicts the code it
    // guards is how the next reader derives the inverted principle — that
    // `starved` should not be threaded at all — which compiles, passes, and
    // leaves `main`'s array empty forever. So this asserts IDENTITIES now, not
    // a length alone: a length can be satisfied by the wrong array.
    const unreadable = [];
    const starved = [];
    const calls = [];
    quietly(() =>
      sweepRepos(
        ["a/one"],
        repoRunner({
          apply: true,
          settleMinutes: 7,
          rotted: [],
          stranded: [],
          run: (...args) => (calls.push(args), []),
          notify: new Set(),
          unreadable,
          starved,
          queued: [],
        }),
      ),
    );
    assert.equal(calls[0].length, 1, "one named bag, never a positional vector");
    const [bag] = calls[0];
    assert.equal(bag.starved, starved, "`starved` is threaded through BY REFERENCE");
    assert.ok(
      !Object.values(bag).includes(unreadable),
      "`unreadable` never reaches `runRepo`, under ANY key",
    );
    assert.ok(!("unreadable" in bag), "and not under its own name either");
  });

  it("⛔ an alarm run goes red for a repo it could not read", () => {
    // Skipping is only safe BECAUSE of this. Before PEN-5442 an unreadable
    // repo crashed the fire, which at least exited non-zero; skipping it
    // without this term would turn that into a clean `0` — "nothing has been
    // landable and ignored" asserted over a repo the fire never read, which is
    // exactly the silent all-clear this detector exists to rule out.
    assert.equal(alarmExitCode([], []), 0, "control: nothing wrong is still green");
    // ⛔ The property this test exists for is NON-ZERO, asserted separately
    // from which non-zero. PEN-5314 moved the integer from 1 to
    // EXIT_UNMEASURED; the fail-open guard is indifferent to that and must
    // keep holding if it ever moves again.
    assert.notEqual(alarmExitCode([], ["a/broken (HTTP 502)"]), 0, "an unread repo is never green");
    assert.equal(alarmExitCode(["a/one#1"], []), 1, "the stranded term is unchanged");
    assert.equal(alarmExitCode(["a/one#1"], ["a/broken (HTTP 502)"]), 1);
    assert.equal(alarmExitCode(undefined, undefined), 0, "and both still default");
    assert.equal(alarmExitCode([]), 0, "including the one-argument call sites");
  });

  it("⛔ a transient 5xx spends EXIT_UNMEASURED, not the stranded cohort's 1 (PEN-5314)", () => {
    // The composition, run through the REAL path rather than a hand-built
    // cohort — because the regression was in the composition and every
    // by-hand `alarmExitCode` test above kept passing while it was live.
    //
    // PEN-5314 added EXIT_UNMEASURED for exactly this input. This catch then
    // took it back: a 502 that outlives `fetchOpenPrs`'s retries is NOT fatal,
    // so it arrives here as an unreadable skip rather than at `main`'s
    // `sweepError` branch — and the dominant "GitHub 502'd" case went back to
    // spelling "could not measure" with the same integer as "a PR has been
    // landable for hours and nothing took it".
    const unreadable = [];
    const stranded = [];
    const starved = [];
    quietly(() =>
      sweepRepos(
        ["a/broken"],
        repoRunner({
          apply: false,
          settleMinutes: 0,
          rotted: [],
          stranded,
          run: boom("HTTP 502: 502 Bad Gateway"),
          notify: new Set(),
          unreadable,
          starved,
          queued: [],
        }),
      ),
    );
    assert.deepEqual(unreadable, ["a/broken (HTTP 502: 502 Bad Gateway)"], "the 5xx became a skip");
    assert.deepEqual(stranded, [], "having measured nothing");
    assert.equal(
      alarmExitCode(stranded, unreadable, starved),
      EXIT_UNMEASURED,
      "so the run says it could not measure — NOT that a PR is stranded",
    );
  });
});

describe(`cap-starved PRs (judgeable >${CAP_STARVED_HOURS}h, never queued, PEN-5391)`, () => {
  const checkAt = (iso) => [
    { __typename: "CheckRun", name: "verify", conclusion: "SUCCESS", completedAt: iso },
  ];
  // `timeline` defaults to `[]` — a READ timeline carrying no queue event,
  // which is the shape of the PR this cohort exists to name.
  //
  // The UNREAD case cannot be spelled `capPr(n, iso, undefined)`: a default
  // parameter substitutes on `undefined`, so that call produces `[]` and
  // silently tests the opposite thing. (It did, on the first draft of this
  // block, and the unread test below is what caught it.) `prUnread` omits the
  // key entirely, which is the shape `fetchOpenPrs` actually produces when it
  // does not hydrate a timeline.
  const capPr = (number, iso, timeline = []) => ({
    number,
    statusCheckRollup: iso === null ? [] : checkAt(iso),
    timeline,
  });
  const capPrUnread = (number, iso) => ({
    number,
    statusCheckRollup: iso === null ? [] : checkAt(iso),
  });
  const row = (number, action, reason) => ({ number, action, reason });
  const capRow = (number) => row(number, "skip", `cap:${MAX_ENQUEUES_PER_FIRE}-per-fire`);
  const event = (name, iso = "2026-09-12T10:00:00Z") => ({ event: name, created_at: iso });

  const FRESH = "2026-09-13T08:00:00Z"; // 4h before NOW — inside the window
  const OLD = "2026-09-12T20:00:00Z"; // 16h before NOW — past it

  it("reports a cap-deferred PR that has never once been offered a queue slot", () => {
    // #3306's shape, 2026-11-03: CLEAN and green for 12h, `enqueue` at 09:1xZ,
    // `skip`/`cap:10-per-fire` by 11:28Z with nothing about the PR changed,
    // and NO `added_to_merge_queue` or `auto_merge_enabled` anywhere on its
    // timeline. The 11:28Z sweep went red naming six other PRs and was silent
    // about this one, which is the miss this cohort closes.
    assert.deepEqual(capStarved([capPr(3306, OLD)], [capRow(3306)], { now: NOW }), [
      { number: 3306, reason: `cap:${MAX_ENQUEUES_PER_FIRE}-per-fire`, ageHours: 16 },
    ]);
  });

  it("stays quiet when the cap is not saturated — the normal case", () => {
    // THE negative case. `classifyAll` only writes a `cap:` reason once the
    // budget is spent, so an unsaturated fire produces no row this cohort can
    // match, however old and however never-queued the PRs are. A detector that
    // fired here would fire on every fire, which is the failure mode the two
    // sibling cohorts are each written to avoid.
    //
    // Driven through the REAL `classifyAll` rather than hand-written rows, so
    // the test binds to the thing that actually mints the reason.
    const eligible = [200, 201, 202].map((number) =>
      pr({ number, statusCheckRollup: checkAt(OLD), timeline: [] }),
    );
    const unsaturated = classifyAll(eligible, { now: NOW, maxEnqueues: MAX_ENQUEUES_PER_FIRE });
    assert.deepEqual(
      unsaturated.map((r) => r.action),
      ["enqueue", "enqueue", "enqueue"],
      "precondition: the cap did not bite, so no row carries a cap: reason",
    );
    assert.deepEqual(capStarved(eligible, unsaturated, { now: NOW }), []);

    // ...and the quiet is the CAP's doing, not the fixtures being inert. Same
    // PRs, same ages, same empty timelines, budget lowered until it bites:
    // the cohort fires. Without this control the assertion above would pass
    // just as happily on a predicate that can never match anything.
    const saturated = classifyAll(eligible, { now: NOW, maxEnqueues: 1 });
    assert.deepEqual(
      saturated.map((r) => r.action),
      ["enqueue", "skip", "skip"],
      "control: the cap bit on the last two",
    );
    assert.deepEqual(
      capStarved(eligible, saturated, { now: NOW }).map((r) => r.number),
      [201, 202],
    );
  });

  it("does not report a cap-deferred PR the routine HAS reached before", () => {
    // The discriminator, and the reason this cohort is safe where an age test
    // over `cap:` rows is not. Deferral by a saturated fire is normal and is
    // what a deep queue looks like; the finding is deferral by a routine that
    // has never served this PR at all. One `added_to_merge_queue` anywhere on
    // the timeline settles it permanently, whatever the check stamps say.
    assert.deepEqual(
      capStarved([capPr(1, OLD, [event("added_to_merge_queue")])], [capRow(1)], { now: NOW }),
      [],
    );
  });

  it("counts an armed auto-merge as an offer even with no queue entry yet", () => {
    // `auto_merge_enabled` is the arming that precedes `added_to_merge_queue`
    // on a queue-enabled base (both were present on #3322, 2026-11-03). A PR
    // the routine armed and that has not reached the queue yet is waiting, not
    // starved, so either event alone must disqualify it.
    assert.deepEqual(
      capStarved([capPr(1, OLD, [event("auto_merge_enabled")])], [capRow(1)], { now: NOW }),
      [],
    );
  });

  it("does not report an EJECTED PR — served and bounced is not starved", () => {
    // An ejection is the routine reaching the PR and GitHub throwing it back.
    // It has its own rule (`ejected-at-current-head`) with its own clock, and
    // claiming it here would name one PR twice under two mechanisms that
    // disagree about what is wrong with it.
    const timeline = [event("added_to_merge_queue"), event("removed_from_merge_queue")];
    assert.deepEqual(capStarved([capPr(1, OLD, timeline)], [capRow(1)], { now: NOW }), []);
  });

  it("does not report a PR deferred by one saturated fire", () => {
    // Measured 2026-11-03 over the 30 most recent merges: every one reached
    // the queue, worst first-slot wait 11.7h on a clock that over-states it
    // (creation, not judgeable age). A 4h-old deferral is squarely inside
    // normal operation and this cohort must not name it.
    assert.deepEqual(capStarved([capPr(1, FRESH)], [capRow(1)], { now: NOW }), []);
  });

  it("claims only cap deferrals, not every skip", () => {
    // `stalledHolds` owns the rows with a reason for inaction and ages them on
    // a clock that is sound for them. Widening past `cap:` would take them
    // over on a clock chosen for a different question.
    const prs = [capPr(1, OLD), capPr(2, OLD), capPr(3, OLD)];
    const rows = [
      row(1, "skip", "label:do-not-merge"),
      row(2, "skip", "checks:FAILURE"),
      row(3, "skip", "human-author"),
    ];
    assert.deepEqual(capStarved(prs, rows, { now: NOW }), []);
  });

  it("is disjoint from both sibling cohorts — a PR is in exactly one", () => {
    // All three blocks print together and two of them now set the exit code,
    // so an overlap would name one PR twice and double-count the alarm.
    // `stalledHolds` excludes the row by reason, `unlandedEligible` by action,
    // and this one requires both — so the split is total by construction.
    const prs = [capPr(1, OLD), capPr(2, OLD), capPr(3, OLD)];
    const rows = [
      capRow(1),
      row(2, "enqueue", "mergestate:CLEAN"),
      row(3, "codeowner-review-requested", "owner-approval-pending"),
    ];
    assert.deepEqual(
      capStarved(prs, rows, { now: NOW }).map((r) => r.number),
      [1],
    );
    assert.deepEqual(
      unlandedEligible(prs, rows, { now: NOW }).map((r) => r.number),
      [2],
    );
    assert.deepEqual(
      stalledHolds(prs, rows, { now: NOW }).map((r) => r.number),
      [3],
    );
  });

  describe("everOfferedQueueSlot is three-valued", () => {
    it("separates an unread timeline from a read one carrying no queue event", () => {
      // The expensive conflation. `fetchOpenPrs` hydrates `timeline` only for
      // PRs that survive `classifyFromListing` — today exactly the set that can
      // reach `cap:` — so an absent timeline read as `false` would mark EVERY
      // cap-deferred row starved at once and turn this detector into noise on
      // its first fire.
      assert.equal(everOfferedQueueSlot(undefined), null);
      assert.equal(everOfferedQueueSlot(null), null);
      assert.equal(everOfferedQueueSlot("not an array"), null);
      assert.equal(everOfferedQueueSlot([]), false);
      assert.equal(everOfferedQueueSlot([event("labeled")]), false);
      assert.equal(everOfferedQueueSlot([event("added_to_merge_queue")]), true);
    });

    it("is live rather than vacuous — the event it looks for does occur", () => {
      // Verified against GitHub 2026-11-03 before the cohort was written: 6 of
      // 6 recently merged PRs carried `added_to_merge_queue`, and the two then
      // sitting cap-deferred (#3306, #3215) carried no queue event at all. A
      // predicate over an event that never appears reports clean forever, so
      // the shape of a real merged timeline is pinned here.
      const merged = [
        event("committed"),
        event("added_to_merge_queue", "2026-11-03T11:06:40Z"),
        event("removed_from_merge_queue", "2026-11-03T11:21:00Z"),
        event("merged"),
      ];
      assert.equal(everOfferedQueueSlot(merged), true);
    });
  });

  it("does NOT claim a row whose timeline was not read", () => {
    // The opposite call to the undatable-clock case below, and deliberately
    // so: the clock REFINES a finding that stands without it, while the
    // timeline IS the finding. Same posture `unlandedEligible` takes toward
    // `mergestate:UNKNOWN` — an unread datum must not be asserted over.
    assert.deepEqual(capStarved([capPrUnread(1, OLD)], [capRow(1)], { now: NOW }), []);
    // And the row IS reported once the same timeline comes back read and
    // empty — so the quiet above is the unread key, not the predicate.
    assert.deepEqual(
      capStarved([capPr(1, OLD, [])], [capRow(1)], { now: NOW }).map((r) => r.number),
      [1],
    );
  });

  it("REPORTS an undatable cap-deferred row rather than dropping it", () => {
    // Same §4l posture as both siblings: an instrument that cannot see
    // something must not report clean. A cap-deferred PR that has never been
    // queued and whose head carries no dated check is a true finding twice
    // over — nothing served it, and nothing dated it.
    assert.deepEqual(capStarved([capPr(1, null)], [capRow(1)], { now: NOW }), [
      { number: 1, reason: `cap:${MAX_ENQUEUES_PER_FIRE}-per-fire`, ageHours: null },
    ]);
    // A row whose PR is MISSING entirely is dropped, which DIVERGES from both
    // siblings — `stalledHolds` and `unlandedEligible` both keep it with a
    // null age. The divergence is the unread-timeline rule above, not a
    // different §4l posture: no PR means no timeline, and this cohort cannot
    // assert "never offered a slot" about a PR it never saw. Unreachable in
    // this script (rows and PRs come from one fetch), pinned so the contrast
    // is deliberate rather than discovered.
    assert.deepEqual(capStarved([], [capRow(9)], { now: NOW }), []);
    assert.deepEqual(
      stalledHolds([], [row(9, "skip", "checks:none")], { now: NOW }),
      [{ number: 9, reason: "checks:none", ageHours: null }],
      "the sibling keeps it — this is a divergence, not a shared rule",
    );
  });

  it("renders nothing when the cohort is empty, and names the remedy when it is not", () => {
    assert.equal(renderCapStarved("a/one", []), "");
    assert.equal(renderCapStarved("a/one", undefined), "");
    const block = renderCapStarved("a/one", [
      { number: 3306, reason: "cap:10-per-fire", ageHours: 16 },
      { number: 3215, reason: "cap:10-per-fire", ageHours: null },
    ]);
    assert.match(block, /^cap-starved \(judgeable >12h or undated, never once queued\) — 2:/);
    assert.match(block, /a\/one#3306 — `cap:10-per-fire`, 16\.0h/);
    assert.match(block, /a\/one#3215 — `cap:10-per-fire`, age unknown/);
    // The remedy is the point: re-running the routine cannot reach these.
    assert.match(block, /Raising throughput is the fix; re-running the routine is not\./);
  });

  it("turns the alarm red, like the unlanded-eligible cohort and unlike stale-hold", () => {
    // AC4: the condition must surface without a human noticing by hand. A
    // print-only cohort inside a workflow whose only channel is its exit code
    // would reproduce the silence-means-health failure landing-sweep.yml was
    // written to remove.
    //
    // ⛔ `starved` is the THIRD argument. The second is `unreadable` (PEN-5442).
    // Passing a starved cohort in the second slot returns 1 either way, so such
    // a test passes while asserting nothing about this cohort — which is how
    // the PEN-5442/PEN-5391 collision was going to bind silently. Every
    // assertion below is positional ON PURPOSE.
    assert.equal(alarmExitCode([], [], []), 0, "control: nothing wrong is green");
    assert.equal(
      alarmExitCode([], [], ["a/one#3306"]),
      1,
      "the starved term goes red ON ITS OWN, with both siblings empty",
    );
    assert.equal(alarmExitCode(["a/one#3241"], [], ["a/one#3306"]), 1);
    assert.equal(alarmExitCode([], ["a/broken (HTTP 502)"], ["a/one#3306"]), 1);
    // The two siblings still go red alone, so widening did not swallow either.
    assert.equal(alarmExitCode(["a/one#3241"], [], []), 1, "stranded alone");
    assert.notEqual(
      alarmExitCode([], ["a/broken (HTTP 502)"], []),
      0,
      "unreadable alone — still red, though PEN-5314 changed WHICH non-zero",
    );
    // Optional and quiet by default, so no existing caller changes meaning.
    assert.equal(alarmExitCode([]), 0);
    assert.equal(alarmExitCode([], []), 0);
    assert.equal(alarmExitCode(undefined, undefined, undefined), 0);
  });

  describe("runRepo wiring", () => {
    const atNow = (fn) => {
      const real = Date.now;
      Date.now = () => Date.parse("2026-09-13T12:00:00Z");
      try {
        return fn();
      } finally {
        Date.now = real;
      }
    };

    const sweep = (apply) => {
      const stranded = [];
      const starved = [];
      const printed = [];
      const log = console.log;
      console.log = (line) => printed.push(String(line));
      try {
        atNow(() =>
          runRepo({
            repo: "a/one",
            apply,
            settleMinutes: 0,
            spent: 0,
            rotted: [],
            stranded,
            starved,
            queued: [],
            fetch: () => [capPr(3306, OLD)],
            classify: () => [capRow(3306)],
            applyOne: () => "merge requested",
            state: () => {},
          }),
        );
      } finally {
        console.log = log;
      }
      return { stranded, starved, printed: printed.join("\n") };
    };

    it("collects the cohort on a dry run and prints its block", () => {
      const { starved, printed } = sweep(false);
      assert.deepEqual(starved, ["a/one#3306"]);
      assert.match(printed, /cap-starved \(judgeable >12h or undated, never once queued\) — 1:/);
      assert.match(printed, /a\/one#3306/);
      assert.equal(
        alarmExitCode([], [], starved),
        1,
        "and that is what turns --alarm red — THIRD slot, not the unreadable one",
      );
    });

    it("is silent on an applying fire, which has just spent the budget", () => {
      // Same `apply ? [] :` cut as `unlandedEligible`, for an adjacent reason:
      // an applying fire spends the very budget this cohort reasons about and
      // `applyRow` re-reads no timeline, so a row deferred by that spend would
      // be scored against a snapshot taken before it. The hourly `--alarm`
      // fire owns this measurement, and it cannot apply by construction.
      const { starved, printed } = sweep(true);
      assert.deepEqual(starved, []);
      assert.doesNotMatch(printed, /cap-starved/);
    });

    it("⛔ rejects an UNKNOWN option, naming the key (PEN-5536)", () => {
      // Supersedes the deleted `Array.isArray(starved)` slot guard, and is
      // strictly stronger on the axis that guard was written for: it caught
      // ONE slot, this catches every key — including `fetch`, the misspelling
      // that started all of this by silently falling back to the real
      // `fetchOpenPrs` and issuing a LIVE GraphQL call from a green test.
      assert.throws(
        () =>
          runRepo({
            repo: "a/one",
            apply: false,
            settleMinutes: 0,
            spent: 0,
            rotted: [],
            stranded: [],
            starved: [],
            queued: [],
            fecth: () => {
              throw new Error("the real fetchOpenPrs must never be reached here");
            },
          }),
        (error) =>
          error instanceof WiringError && /unknown option `fecth`/.test(error.message),
        "a mistyped key must name ITSELF, not merely fail",
      );
    });

    it("⛔ rejects an OMITTED cohort, naming the key (PEN-5536)", () => {
      // The other half, and it is invisible to the check above: a typo has two
      // halves and an omission has one. Without this, a dropped `starved:`
      // would let the callee collect into an array the caller never reads —
      // the alarm sums zero and the suite stays green.
      assert.throws(
        () =>
          runRepo({
            repo: "a/one",
            apply: false,
            settleMinutes: 0,
            spent: 0,
            rotted: [],
            stranded: [],
            classify: () => [],
          }),
        (error) =>
          error instanceof WiringError && /missing required option `starved`/.test(error.message),
        "an omitted cohort must name ITSELF",
      );
    });

    it("rejects a positional call outright rather than binding it as a bag", () => {
      // The conversion's own boundary: the old vector must not half-work.
      assert.throws(
        () => runRepo("a/one", false, 0, 0, [], [], []),
        (error) =>
          error instanceof WiringError && /expected a named options object/.test(error.message),
      );
    });

    it("accepts a complete, correctly-spelled bag", () => {
      // The positive control for all three throws above. Without it they would
      // all still pass if `runRepo` rejected every bag outright — which is the
      // job the deleted slot-8 positive control was doing, re-anchored.
      const seen = [];
      atNow(() =>
        runRepo({
          repo: "a/one",
          apply: false,
          settleMinutes: 0,
          spent: 0,
          rotted: [],
          stranded: [],
          starved: [],
          queued: [],
          fetch: () => (seen.push("injected"), []),
          classify: () => [],
          state: () => {},
        }),
      );
      assert.deepEqual(seen, ["injected"], "the injected fetch ran, not the real one");
    });

    it("applies both guards to `repoRunner`'s bag as well, not just `runRepo`'s", () => {
      // Both signatures grew cohorts and both are called from `main`; a guard
      // on one of them is a guard on half the surface.
      assert.throws(
        () =>
          repoRunner({ apply: true, settleMinutes: 0, rotted: [], stranded: [], unreadable: [] }),
        (error) =>
          error instanceof WiringError && /missing required option `starved`/.test(error.message),
      );
      assert.throws(
        () =>
          repoRunner({
            apply: true,
            settleMinutes: 0,
            rotted: [],
            stranded: [],
            unreadable: [],
            starved: [],
            queued: [],
            notifiy: new Set(),
          }),
        (error) => error instanceof WiringError && /unknown option `notifiy`/.test(error.message),
      );
      assert.doesNotThrow(() =>
        repoRunner({
          apply: true,
          settleMinutes: 0,
          rotted: [],
          stranded: [],
          unreadable: [],
          starved: [],
          queued: [],
        }),
      );
    });

    it("refuses a present-but-unusable cohort at the bag boundary, not at its first `.push`", () => {
      // `key in bag` ADMITS `{ queued: undefined }`. The fault then surfaces at
      // the first `queued.push`, as a BARE TypeError — and `repoRunner`'s catch
      // reads a bare TypeError as "this repo could not be listed" and files it
      // under `unreadable`. That is precisely the misfiling this conversion
      // exists to remove, so the cohort's SHAPE is checked at the boundary,
      // where the fault can still be named. Reverting the check to `key in bag`
      // fails every row below. (Ally review, PR#3415.)
      for (const bad of [undefined, null, {}, 0, "[]"]) {
        assert.throws(
          () =>
            repoRunner({
              apply: true,
              settleMinutes: 0,
              rotted: [],
              stranded: [],
              unreadable: [],
              starved: [],
              queued: bad,
            }),
          (error) =>
            error instanceof WiringError &&
            /missing required option `queued`/.test(error.message) &&
            /must be an array/.test(error.message),
          `a \`queued\` of ${JSON.stringify(bad) ?? "undefined"} must be refused by name`,
        );
      }
    });
  });

  describe("⛔ a wiring fault is never recorded as a repo-readability fact (PEN-5536)", () => {
    const hushed = (fn) => {
      const log = console.log;
      console.log = () => {};
      try {
        return fn();
      } finally {
        console.log = log;
      }
    };
    it("lets a WiringError ESCAPE `repoRunner`'s catch", () => {
      // Without the rethrow, `assertBag`'s throw is matched against
      // `isFatalGhError` — a regex over rate-limit / bad-credential / HTTP 401
      // / HTTP 403 messages that a shape fault matches none of — so it lands in
      // `unreadable` and is printed as "it could not be listed". A wiring fault
      // is repo-INDEPENDENT, so EVERY repo takes the same throw and the hourly
      // detector reports an apparent GitHub outage.
      const unreadable = [];
      assert.throws(
        () =>
          hushed(() =>
            sweepRepos(
              ["a/one"],
              repoRunner({
                apply: true,
                settleMinutes: 0,
                rotted: [],
                stranded: [],
                unreadable,
                starved: [],
                queued: [],
                // A seam standing in for `runRepo` that fails the way a
                // mis-wired `runRepo` fails.
                run: () => {
                  throw new WiringError("runRepo: missing required option `starved`.");
                },
              }),
            ),
          ),
        (error) => error instanceof WiringError,
      );
      assert.deepEqual(unreadable, [], "and is NOT filed as an unreadable repo");
    });

    it("⛔ CONTROL: a plain TypeError from the read path STILL lands in `unreadable`", () => {
      // This is the assertion that keeps the rethrow narrow, and it is the one
      // that fails if someone later widens the predicate back to bare
      // `TypeError`. `fetchOpenPrs` JSON.parses `gh pr list` output and calls
      // `.map` on it, so a well-formed non-array payload raises exactly this —
      // a genuine per-repo read failure, PEN-5442's subject, where the repo is
      // skipped and every other repo keeps its verdicts. A blanket `TypeError`
      // rethrow would end the whole fire instead: `sweepRepos` has no catch and
      // `main`'s try/`finally` has none either.
      //
      // The test above alone stays green under that widening. This one does not.
      //
      // PEN-5482 made the seam TAG its throw. The real `fetchOpenPrs`
      // `TypeError` is raised inside `runRepo`'s fetch try and leaves it
      // tagged, so a seam standing in for `runRepo` has to fail the way
      // `runRepo` fails or it is modelling a contract the module no longer
      // has — which is why `markCollectFailure` is exported. The assertion is
      // unchanged and so is its reach: widen the rethrow above to bare
      // `TypeError` and this still goes red, because identity is consulted
      // before the tag. The case where that tag is ABSENT is the subject of
      // "only a LISTING failure is skippable (PEN-5482)" below.
      const unreadable = [];
      const swept = [];
      hushed(() =>
        sweepRepos(
          ["a/broken", "a/fine"],
          repoRunner({
            apply: true,
            settleMinutes: 0,
            rotted: [],
            stranded: [],
            unreadable,
            starved: [],
            queued: [],
            run: ({ repo }) => {
              if (repo === "a/broken") {
                throw markCollectFailure(new TypeError("rows.map is not a function"));
              }
              swept.push(repo);
              return [];
            },
          }),
        ),
      );
      assert.deepEqual(unreadable, ["a/broken (rows.map is not a function)"]);
      assert.deepEqual(swept, ["a/fine"], "and the fire CONTINUED to the next repo");
    });
  });
});

describe(`unlanded-eligible rows never once offered a slot (PEN-6363)`, () => {
  const checkAt = (iso) => [
    { __typename: "CheckRun", name: "verify", conclusion: "SUCCESS", completedAt: iso },
  ];
  const event = (name, iso = "2026-09-12T10:00:00Z") => ({ event: name, created_at: iso });
  // `timeline: []` is a READ timeline carrying no queue event — the shape this
  // refinement exists to name. The UNREAD case OMITS the key, and cannot be
  // spelled by passing `undefined`: a default parameter substitutes on
  // `undefined`, so that call produces `[]` and silently tests the opposite
  // thing. Same trap the cap-starved block records, same escape.
  const pr = (number, iso, timeline = []) => ({
    number,
    statusCheckRollup: iso === null ? [] : checkAt(iso),
    timeline,
  });
  const prUnread = (number, iso) => ({
    number,
    statusCheckRollup: iso === null ? [] : checkAt(iso),
  });
  const enqueueRow = (number) => ({ number, action: "enqueue", reason: "mergestate:CLEAN" });
  const capRow = (number) => ({
    number,
    action: "skip",
    reason: `cap:${MAX_ENQUEUES_PER_FIRE}-per-fire`,
  });
  const strandedRow = (number, ageHours) => ({ number, reason: "mergestate:CLEAN", ageHours });

  const OLD = "2026-09-12T20:00:00Z"; // 16h before NOW — past CAP_STARVED_HOURS
  const RECENT = "2026-09-13T04:00:00Z"; // 8h before NOW — inside it

  it("names a row the classifier said yes to that has never once been queued", () => {
    // ⛔ THE REGRESSION. #3555's shape, 2026-11-09T19:27Z: action `enqueue`
    // (inside that fire's top-10 window), judgeable 12.7h, and NO
    // `added_to_merge_queue` or `auto_merge_enabled` anywhere in its timeline.
    // Six siblings carried the same shape at 12.7-21.7h. Before this, that
    // fact was consulted only behind `action === "skip"`, so the whole band
    // was reported as `unlanded-eligible` under a remedy that sends the reader
    // to a routine which had fired 4h21m earlier and merged five of its eight
    // enqueues.
    const prs = [pr(3555, OLD)];
    const stranded = unlandedEligible(prs, [enqueueRow(3555)], { now: NOW });
    assert.deepEqual(stranded, [{ number: 3555, reason: "mergestate:CLEAN", ageHours: 16 }]);
    assert.deepEqual(unlandedNeverQueued(prs, stranded), [3555]);
  });

  it("is reported regardless of which bucket the sweep's allocation put the row in", () => {
    // ⛔ THE DEFECT ITSELF. One PR, one timeline, one age — and the only thing
    // that differs between the two calls is the action `classifyAll` happened
    // to assign at THIS fire. `capStarved` saw it when the cap had pushed it
    // out of the window; nothing saw it when the window held it. Both arms
    // must now report the same underlying fact, or the discriminator is
    // gated away from its population again.
    const prs = [pr(3555, OLD)];
    assert.deepEqual(
      capStarved(prs, [capRow(3555)], { now: NOW }).map((r) => r.number),
      [3555],
      "outside the window: the existing cohort names it",
    );
    assert.deepEqual(
      unlandedNeverQueued(prs, unlandedEligible(prs, [enqueueRow(3555)], { now: NOW })),
      [3555],
      "inside the window: the fact is now reported there too",
    );
  });

  it("does not name a PR the routine has offered a slot — either event", () => {
    // The negative control, and the whole reason an age test cannot stand in
    // for this one: a PR the queue has served is not starved, whatever its
    // check stamps say.
    for (const name of ["added_to_merge_queue", "auto_merge_enabled"]) {
      const prs = [pr(1, OLD, [event(name)])];
      assert.deepEqual(
        unlandedNeverQueued(prs, unlandedEligible(prs, [enqueueRow(1)], { now: NOW })),
        [],
        `${name} clears the row`,
      );
    }
  });

  it("does not name a row inside the clock — the normal case", () => {
    // UNLANDED_ELIGIBLE_HOURS (6) is a fire interval; CAP_STARVED_HOURS (12)
    // is two. A row between them is the ordinary schedule wait the
    // landing-sweep header describes, so the cohort still names it and this
    // refinement must stay quiet about it.
    const prs = [pr(1, RECENT)];
    const stranded = unlandedEligible(prs, [enqueueRow(1)], { now: NOW });
    assert.deepEqual(stranded.map((r) => r.number), [1], "control: the cohort does hold it");
    assert.deepEqual(unlandedNeverQueued(prs, stranded), []);
  });

  it("does not name a row whose timeline was not read", () => {
    // `null` is not `false`. The claim is "nothing has ever offered this a
    // slot" and an unread timeline cannot support it — the same call
    // `capStarved` makes, and the opposite of the undatable-clock call below,
    // because the clock REFINES a finding that stands without it while the
    // timeline IS the finding.
    const prs = [prUnread(1, OLD)];
    const stranded = unlandedEligible(prs, [enqueueRow(1)], { now: NOW });
    assert.deepEqual(stranded.map((r) => r.number), [1], "control: the cohort does hold it");
    assert.equal(everOfferedQueueSlot(prs[0].timeline), null);
    assert.deepEqual(unlandedNeverQueued(prs, stranded), []);
  });

  it("names an undatable row, matching both sibling cohorts", () => {
    // §4l: an instrument that cannot see something must not report clean. A
    // row with no dated check that has also never been queued is a true
    // finding twice over.
    assert.deepEqual(unlandedNeverQueued([pr(1, null)], [strandedRow(1, null)]), [1]);
  });

  it("drops a row whose PR is absent, because no PR means no timeline", () => {
    // The same divergence from its siblings that `capStarved` records: they
    // keep such a row with a null clock, this cannot, and the reason is the
    // unread-timeline rule above rather than a different §4l posture.
    assert.deepEqual(unlandedNeverQueued([], [strandedRow(9, 16)]), []);
  });

  it("marks only the named rows and says what the fact does and does not settle", () => {
    const stranded = [strandedRow(3555, 12.7), strandedRow(3549, 6.5)];
    const block = renderUnlandedEligible("a/one", stranded, { neverQueued: [3555] });
    assert.match(block, /a\/one#3555 — `mergestate:CLEAN`, 12\.7h, never once queued/);
    assert.match(block, /a\/one#3549 — `mergestate:CLEAN`, 6\.5h$/m);
    assert.doesNotMatch(block, /a\/one#3549 — .*never once queued/);
    assert.match(block, /never once queued \(>12h judgeable or undated/);
    // ⛔ The remedy must name BOTH remaining causes and must not pick one. The
    // acting fire's allocation is the separating datum and an `--alarm` fire
    // does not have it, so asserting either cause here is the defect PEN-6363
    // reported, in the other direction.
    assert.match(block, /THIS SWEEP CANNOT SEPARATE THEM/);
    assert.match(block, /no acting fire has run since they became eligible/);
    assert.match(block, /the ACTING fire's per-fire cap did not reach them/);
    // And the cohort's own closing sentence must stop short of "the routine
    // has not run", which is what measured false.
    assert.match(block, /A yes does not clear this cohort/);
    assert.doesNotMatch(block, /before looking at the PRs/);
  });

  it("says nothing extra when no row qualifies — the quiet arm", () => {
    // Both arms, because a paragraph that always prints is a paragraph nobody
    // reads, and a marker that always attaches tells a reader nothing.
    const block = renderUnlandedEligible("a/one", [strandedRow(3549, 6.5)]);
    assert.match(block, /a\/one#3549 — `mergestate:CLEAN`, 6\.5h$/m);
    assert.doesNotMatch(block, /never once queued/);
    assert.doesNotMatch(block, /THIS SWEEP CANNOT SEPARATE THEM/);
  });

  it("⛔ is wired at the runRepo call site, not just available to it", () => {
    // The predicate and the render are each pinned above, and deleting the
    // OPTION THAT JOINS THEM was free: the block still printed, correctly, just
    // without the fact — 6 of 7 mechanisms red under per-mechanism mutation and
    // this one green. That is the same unenforced-call-site shape `runRepo`'s
    // own option guards exist for (see its UNKNOWN/OMITTED pair), and it is the
    // failure mode this whole issue is an instance of: a discriminator that
    // exists and is not consulted.
    const printed = [];
    const log = console.log;
    const realNow = Date.now;
    Date.now = () => NOW;
    console.log = (l) => printed.push(String(l));
    try {
      runRepo({
        repo: "a/one",
        apply: false,
        settleMinutes: 0,
        spent: 0,
        rotted: [],
        stranded: [],
        starved: [],
        queued: [],
        fetch: () => [pr(3555, OLD)],
        classify: () => [enqueueRow(3555)],
        applyOne: () => "merge requested",
        state: () => {},
      });
    } finally {
      console.log = log;
      Date.now = realNow;
    }
    const out = printed.join("\n");
    assert.match(
      out,
      /unlanded-eligible \(judgeable >6h or undated, nothing holding it\) — 1:/,
      "control: the cohort itself still prints, so a red below is the FACT missing",
    );
    assert.match(out, /a\/one#3555 — `mergestate:CLEAN`, 16\.0h, never once queued/);
    assert.match(out, /THIS SWEEP CANNOT SEPARATE THEM/);
  });

  it("cannot be made to name a PR the cohort does not hold", () => {
    // The set is intersected with `stranded` rather than trusted. A caller
    // that hands over a wider set — a future one computing it from `rows`
    // instead of from the cohort — must not be able to add a row to this
    // block, which is the one way this refinement could become the predicate
    // widening its own comment refuses.
    const block = renderUnlandedEligible("a/one", [strandedRow(3549, 6.5)], {
      neverQueued: [3549 + 1, 777],
    });
    assert.doesNotMatch(block, /a\/one#777/);
    assert.doesNotMatch(block, /never once queued/);
  });
});

describe("every cohort heading names the undated arm its gate admits (PEN-6392)", () => {
  // All three cohorts DELIBERATELY keep a row they could not date
  // (`ageHours === null`) — the §4l call each producer's comment records: an
  // instrument that cannot see something must not report clean. Each block
  // then prints that row as `age unknown`. A heading that states only a
  // judgeable-age floor therefore contradicts, inside one block, the line two
  // rows beneath it — and a reader takes the floor as the membership rule.
  //
  // ⚠ What these pin is PROSE, which is usually brittle and worth little.
  // They are here because the prose is the whole deliverable: the cohorts'
  // behaviour is covered above and was never wrong. What drifts is the
  // sentence, and it drifts SILENTLY — PEN-6363 shipped the `never once
  // queued` marking under a ">12h judgeable" heading, over a row the same
  // block printed as undatable, and nothing failed.
  //
  // Each case drives the PRODUCER rather than a hand-built cohort, and
  // asserts BOTH directions: that the gate admits the undated row, and that
  // the heading says so. Either one moving alone reds this suite, which is
  // the drift the two halves could otherwise do independently.
  const NOW = Date.parse("2026-09-13T12:00:00Z");
  // Non-empty but carrying no stamp on any entry — the narrow real case the
  // producers' comments describe, not merely an empty rollup.
  const undated = (number, extra = {}) => ({
    number,
    statusCheckRollup: [{ name: "verify", conclusion: "SUCCESS" }],
    ...extra,
  });
  const row = (number, action, reason) => ({ number, action, reason });

  it("stale-hold", () => {
    const held = stalledHolds(
      [undated(1)],
      [row(1, "codeowner-review-requested", "owner-approval-pending")],
      { now: NOW },
    );
    assert.deepEqual(
      held.map((r) => r.ageHours),
      [null],
      "control: the gate admits the undated row",
    );
    const block = renderStalledHolds("a/one", held);
    assert.match(block, /^stale-hold \(judgeable >\d+h or undated,/);
    assert.match(block, /a\/one#1 — `owner-approval-pending`, age unknown/);
  });

  it("unlanded-eligible", () => {
    const stranded = unlandedEligible([undated(1)], [row(1, "enqueue", "mergestate:CLEAN")], {
      now: NOW,
    });
    assert.deepEqual(
      stranded.map((r) => r.ageHours),
      [null],
      "control: the gate admits the undated row",
    );
    const block = renderUnlandedEligible("a/one", stranded);
    assert.match(block, /^unlanded-eligible \(judgeable >\d+h or undated,/);
    assert.match(block, /a\/one#1 — `mergestate:CLEAN`, age unknown/);
  });

  it("cap-starved", () => {
    const prs = [undated(1, { timeline: [] })];
    const starved = capStarved(prs, [row(1, "skip", `cap:${MAX_ENQUEUES_PER_FIRE}-per-fire`)], {
      now: NOW,
    });
    assert.deepEqual(
      starved.map((r) => r.ageHours),
      [null],
      "control: the gate admits the undated row",
    );
    const block = renderCapStarved("a/one", starved);
    assert.match(block, /^cap-starved \(judgeable >\d+h or undated,/);
    assert.match(block, /a\/one#1 — `cap:\d+-per-fire`, age unknown/);
  });

  it("the never-once-queued sub-block, whose own floor is the one PEN-6363 shipped", () => {
    const prs = [undated(1, { timeline: [] })];
    const stranded = unlandedEligible(prs, [row(1, "enqueue", "mergestate:CLEAN")], { now: NOW });
    const neverQueued = unlandedNeverQueued(prs, stranded);
    assert.deepEqual(neverQueued, [1], "control: the gate admits the undated row");
    const block = renderUnlandedEligible("a/one", stranded, { neverQueued });
    assert.match(block, /never once queued \(>\d+h judgeable or undated, no /);
    assert.match(block, /a\/one#1 — `mergestate:CLEAN`, age unknown .*, never once queued/);
  });

  it("⛔ the `--alarm` summary does not claim the marking is universal", () => {
    // Carrier A, and the only one of the five with a wrong ACTION behind it.
    // The sentence used to read "...which marks every row that has never once
    // been offered a queue slot". `unlandedNeverQueued` marks such a row only
    // past CAP_STARVED_HOURS (12) while the cohort starts at
    // UNLANDED_ELIGIBLE_HOURS (6), so a never-queued row in the 6-12h band is
    // in the block and UNMARKED — and a reader who trusts "every" reads that
    // unmarked row as one that HAS been queued, which is the exact inverse of
    // its state and sends them looking downstream of a queue it never entered.
    //
    // Pinned as source text because the sentence lives inside `main`, which is
    // not exported and self-invokes under `isMainModule` — the same seam the
    // suite below works around, and with the same limits: this catches the
    // regression, not a behavioural equivalent of it.
    const SOURCE = readFileSync(new URL("./land-clean-prs.mjs", import.meta.url), "utf8");
    // Shared-token control. A mistyped path or a short read yields a SOURCE in
    // which every pattern below is absent, and absence is what two of these
    // three assertions are looking for — so without this the test passes on a
    // file it never read.
    assert.match(SOURCE, /See the unlanded-eligible block above/, "control: the file was read");
    assert.doesNotMatch(SOURCE, /which marks every/);
    // Ally on #3645: the caveat must NOT be narrowed back to "an unmarked row
    // THERE", i.e. to the 6-12h band. `unlandedNeverQueued` also leaves a row
    // unmarked when its timeline could not be read (`everOfferedQueueSlot ===
    // null`, the posture its own comment records), and an unread timeline
    // happens past 12h too. So an unmarked row past the clock is not proof of
    // a queue offer either, and a reader who takes "there" literally draws the
    // wrong inference on exactly the undated arm this suite exists to protect.
    assert.doesNotMatch(SOURCE, /unmarked row there/);
    // Matched on text INSIDE one template literal, never across the
    // concatenation seam. The earlier form pinned the line break after
    // `are past " +`, so re-wrapping a sentence that was still correct would
    // have redded this test; verified on #3645 against a collapsed seam.
    assert.match(SOURCE, /judgeable or undated\. A never-queued row INSIDE/);
  });
});

describe("main's alarm wiring is pinned at the CALL SITE (PEN-5391 + PEN-5442 + PEN-5314)", () => {
  // `alarmExitCode` is exported and heavily covered — but every one of those
  // tests passes the cohorts in BY HAND. `main` is NOT exported, it
  // self-invokes under `isMainModule`, and there is no seam to inject. So
  // dropping a cohort from `main`'s own call site fails nothing above.
  //
  // That is not a hypothetical gap, it is the exact hazard this file was in:
  // PEN-5442 added `alarmExitCode(stranded, unreadable)` and PEN-5391 added
  // `alarmExitCode(stranded, starved)` concurrently. Because the function
  // returns 1 when ANY term is non-empty, a merge resolution that keeps one
  // name and drops the other COMPILES, passes every direct test, and silently
  // retires an alarm arm. Git flags nothing — the two edits are textually
  // identical in shape.
  //
  // ⚠ What this proves, and what it does not. It pins the TEXT of the call
  // sites, not their behaviour: it cannot catch a cohort that is passed but
  // never populated, and a rename of `main`'s local bindings will fail it for
  // a cosmetic reason. It is deliberately the weakest check that still fails
  // on the one regression it exists to catch. The mutation controls in the
  // third test are what keep it from silently matching nothing.
  const SOURCE = readFileSync(new URL("./land-clean-prs.mjs", import.meta.url), "utf8");

  const EXIT_CALL = /process\.exit\(\s*alarmExitCode\(([^)]*)\)\s*\)/;
  // ⛔ ANCHORED AT THE CALL SITE, and the anchor is load-bearing (PEN-5536).
  // `repoRunner` is now declared `export const repoRunner = (options) => {`,
  // so a bare /repoRunner\(/ matches the DECLARATION — which is ~400 lines
  // EARLIER in the file, and a non-global match returns the first occurrence.
  // The probe would then pin the parameter list of the thing it is supposed to
  // be checking the call to, and pass forever.
  //
  // The anchor is `sweepOrder\(targetRepos\(\)`, not a bare `sweepRepos\(`:
  // `sweepRepos` has a DECLARATION too, so that weaker prefix let the lazy
  // span run from the declaration all the way down to the call and matched
  // anyway — measured while writing this. `sweepOrder(targetRepos())` appears
  // exactly once in the file and only ever as an argument, which is what makes
  // it a call-site anchor rather than a name. Same job `process.exit\(` does
  // for EXIT_CALL. The retarget control below is what proves it.
  const RUNNER_CALL = /sweepOrder\(targetRepos\(\)[\s\S]*?repoRunner\(\{([^}]*)\}\s*\)/;
  // The cohorts collected BY REFERENCE, which are the keys whose absence is
  // silent. `run` and `notify` are seams and `apply`/`settleMinutes` are
  // ordinary inputs; none of them read as health when dropped.
  const COHORT_KEYS = ["rotted", "stranded", "unreadable", "starved", "queued"];
  const UNMEASURED_CALL = /reportUnmeasured\(\s*sweepError,\s*stranded,\s*\{([^}]*)\}\s*\)/;
  const argsOf = (re, src) => {
    const match = src.match(re);
    return match ? match[1].split(",").map((arg) => arg.trim()) : null;
  };

  it("hands `alarmExitCode` all FOUR cohorts, in order", () => {
    assert.deepEqual(
      argsOf(EXIT_CALL, SOURCE),
      ["stranded", "unreadable", "starved", "queued"],
      "a cohort dropped here is an alarm arm that can never fire again",
    );
  });

  it("hands `repoRunner` EVERY collected-by-reference cohort", () => {
    // The other half: a cohort reaching `alarmExitCode` but never handed to
    // the sweep is an array that stays `[]` forever, which reads as health.
    //
    // Asserted as the exact SET rather than as membership plus an index.
    // PEN-5536 replaced the positional vector with a named bag, so "is the 8th
    // and last" no longer means anything — and a set equality is strictly
    // stronger than the two `includes` it replaces, because it also fails on a
    // cohort that was added to the bag and never collected anywhere.
    const args = argsOf(RUNNER_CALL, SOURCE);
    assert.ok(args, "main still builds its per-repo step through repoRunner");
    assert.deepEqual(
      args.filter((key) => COHORT_KEYS.includes(key)),
      COHORT_KEYS,
      "a cohort dropped here is an array that stays empty forever, which reads as health",
    );
  });

  it("hands `reportUnmeasured` the cap-starved cohort as well (PEN-5314)", () => {
    // Same hazard, third cohort: `starved` is collected by reference exactly
    // like `stranded`, so leaving it out of the partial report makes "here is
    // what I found before I stopped" quietly untrue for that arm.
    const keys = argsOf(UNMEASURED_CALL, SOURCE);
    assert.ok(keys, "main still reports the unmeasured run");
    assert.ok(keys.includes("alarm"), "`alarm` still gates the cohort report");
    assert.ok(keys.includes("starved"), "`starved` is reported, not silently dropped");
    assert.ok(keys.includes("queued"), "`queued` is reported, not silently dropped");
  });

  it("⛔ the probes are LIVE — each one fails against a source missing its term", () => {
    // Negative controls. Without these, a regex that had quietly stopped
    // matching anything would leave both tests above passing forever — the
    // same silence-means-health shape the whole row exists to remove.
    const dropped = SOURCE.replace(
      "alarmExitCode(stranded, unreadable, starved, queued)",
      "alarmExitCode(stranded, unreadable)",
    );
    assert.notEqual(dropped, SOURCE, "control: the mutation actually applied");
    assert.deepEqual(
      argsOf(EXIT_CALL, dropped),
      ["stranded", "unreadable"],
      "the probe SEES dropped terms rather than matching nothing",
    );

    const unthreaded = SOURCE.replace(
      "        unreadable,\n        starved,\n        queued,\n      }),",
      "        unreadable,\n        queued,\n      }),",
    );
    assert.notEqual(unthreaded, SOURCE, "control: the mutation actually applied");
    assert.ok(
      !argsOf(RUNNER_CALL, unthreaded).includes("starved"),
      "the probe SEES an unthreaded cohort",
    );

    // ⛔ THE RETARGET CONTROL (PEN-5536), and it is the one the other controls
    // cannot stand in for. Every assertion above is satisfied by a probe that
    // matched `repoRunner`'s own PARAMETER LIST instead of `main`'s call —
    // the declaration comes first in the file, so a probe that lost its
    // call-site anchor silently pins the wrong occurrence and stays green.
    // Delete the call and the probe must find NOTHING, never fall back.
    const uncalled = SOURCE.replace("sweepOrder(targetRepos()", "sweepOrder(noSuchRepos()");
    assert.notEqual(uncalled, SOURCE, "control: the mutation actually applied");
    assert.equal(
      argsOf(RUNNER_CALL, uncalled),
      null,
      "the probe is anchored at the CALL SITE and cannot retarget to the declaration",
    );

    const unreported = SOURCE.replace(
      "reportUnmeasured(sweepError, stranded, { alarm, starved, queued });",
      "reportUnmeasured(sweepError, stranded, { alarm });",
    );
    assert.notEqual(unreported, SOURCE, "control: the mutation actually applied");
    assert.ok(
      !argsOf(UNMEASURED_CALL, unreported).includes("starved"),
      "the probe SEES an unreported cohort",
    );
  });
});
/**
 * PEN-5279. A PR enqueued DIRECTLY — which is what a queue-enabled base
 * produces once checks go green — carries `autoMergeRequest: null`. Verified
 * live 2026-11-02 on five PRs sitting in `MQ_kwDOSc-KOc4AA6vt`: #3241, #3255,
 * #3275, #3288 and #3268, every one of them with a null `autoMergeRequest`.
 *
 * The `already-enqueued` branch used to key on that field alone, so those PRs
 * missed it, re-classified `enqueue` every fire, and spent a cap slot on a
 * re-enqueue GitHub no-ops at exit 0.
 */
describe("merge-queue membership is read, not inferred from autoMergeRequest (PEN-5279)", () => {
  const queued = (overrides = {}) => ({
    position: 2,
    state: "AWAITING_CHECKS",
    enqueuedAt: "2026-09-13T11:00:00Z",
    ...overrides,
  });

  it("reports a directly-enqueued PR as already-enqueued, with autoMergeRequest null", () => {
    const row = classify({ autoMergeRequest: null, mergeQueueEntry: queued() });
    assert.equal(row.action, "already-enqueued");
    assert.match(row.reason, /queue position 2/);
  });

  it("decides it from the listing alone, so the PR never pays for checks and reviews", () => {
    const row = classifyFromListing(
      pr({ autoMergeRequest: null, mergeQueueEntry: queued() }),
      { now: NOW },
    );
    assert.equal(row.action, "already-enqueued");
  });

  it(`reports a HEAD-OF-QUEUE entry older than ${STALE_ENQUEUE_HOURS}h as stale-queued, not stale-enqueue`, () => {
    // Its own action, because `stale-enqueue`'s remedy is `--disable-auto`,
    // which on a directly-enqueued PR disarms nothing and would post a comment
    // claiming a disarm that never happened.
    const row = classify({
      mergeQueueEntry: queued({ position: 1, enqueuedAt: "2026-09-12T22:00:00Z" }),
    });
    assert.equal(row.action, "stale-queued");
  });

  it("does NOT report a deep-position entry past the threshold — depth is not wedging", () => {
    // `enqueuedAt` dates entry into the queue, not time stuck. A 40-deep queue
    // against 18-34 merges/day puts a perfectly healthy PR past
    // STALE_ENQUEUE_HOURS, and the obvious response to a staleness report —
    // dequeue and re-enqueue — forfeits the position it has already waited for.
    for (const position of [2, 7, 40]) {
      const row = classify({
        mergeQueueEntry: queued({ position, enqueuedAt: "2026-09-12T22:00:00Z" }),
      });
      assert.equal(row.action, "already-enqueued", `position ${position} should not read stale`);
    }
  });

  it("does not treat an unreadable position as head-of-queue", () => {
    // Unread must not manufacture a finding.
    for (const position of [null, undefined, "1"]) {
      const row = classify({
        mergeQueueEntry: queued({ position, enqueuedAt: "2026-09-12T22:00:00Z" }),
      });
      assert.equal(row.action, "already-enqueued");
    }
  });

  it("does not report a FRESH head-of-queue entry as stale", () => {
    const row = classify({ mergeQueueEntry: queued({ position: 1 }) });
    assert.equal(row.action, "already-enqueued");
  });

  it("reads an unparseable enqueuedAt as fresh, matching the auto-merge clock", () => {
    // Treating it as infinitely old would report a staleness finding the data
    // does not support. Fresh leaves the PR alone, which is recoverable.
    const row = classify({ mergeQueueEntry: queued({ enqueuedAt: "not-a-date" }) });
    assert.equal(row.action, "already-enqueued");
  });

  it("still names the queue when the entry carries no position", () => {
    const row = classify({ mergeQueueEntry: queued({ position: null }) });
    assert.equal(row.action, "already-enqueued");
    assert.match(row.reason, /in merge queue/);
  });

  it("is NOT keyed on mergeStateStatus, which flaps under load", () => {
    // Measured 2026-11-02: #3241/#3255 read CLEAN while queued at 09:0xZ and
    // UNKNOWN at 09:2xZ; #3275/#3288 read UNKNOWN while queued at 23:3xZ. The
    // verdict must not move with it.
    for (const mergeStateStatus of ["CLEAN", "UNKNOWN", "BLOCKED"]) {
      const row = classify({ mergeStateStatus, mergeQueueEntry: queued() });
      assert.equal(row.action, "already-enqueued");
    }
  });

  it("leaves a PR that is in no queue exactly as it was", () => {
    // The whole fix must be inert on the common case.
    const withField = classify({ mergeQueueEntry: null, mergeStateStatus: "CLEAN" });
    const without = classify({ mergeStateStatus: "CLEAN" });
    assert.equal(withField.action, "enqueue");
    assert.deepEqual(withField, without);
  });
});

/**
 * PEN-5279 done-when 2. The cap exists to be a ceiling on work actually
 * requested; spending it on PRs already in the queue starves the PRs that need
 * it, and does so hardest exactly when the queue is deepest.
 */
describe("a queued PR does not consume a per-fire enqueue slot (PEN-5279)", () => {
  it("spends no slot, leaving the whole budget for PRs that need enqueuing", () => {
    const queuedPrs = Array.from({ length: MAX_ENQUEUES_PER_FIRE }, (_, i) =>
      pr({
        number: 100 + i,
        mergeStateStatus: "CLEAN",
        mergeQueueEntry: { position: i + 1, state: "QUEUED", enqueuedAt: "2026-09-13T11:00:00Z" },
      }),
    );
    const needsEnqueue = pr({ number: 999, mergeStateStatus: "CLEAN" });

    const rows = classifyAll([...queuedPrs, needsEnqueue], { now: NOW });

    assert.equal(rows.filter((r) => r.action === "already-enqueued").length, MAX_ENQUEUES_PER_FIRE);
    // Before the fix every one of those classified `enqueue`, exhausting the
    // budget and rewriting this last row to `skip`/`cap:`.
    const last = rows.at(-1);
    assert.equal(last.action, "enqueue");
    assert.equal(rows.filter((r) => r.action === "enqueue").length, 1);
  });

  it("is excluded from the unlanded-eligible cohort rather than alarming on it", () => {
    // `unlandedEligible`'s predicate is `action !== "enqueue"`, so a queued PR
    // used to be INSIDE the cohort — and `--alarm` exits non-zero on a
    // non-empty one.
    const queuedPr = pr({
      number: 42,
      mergeStateStatus: "CLEAN",
      mergeQueueEntry: { position: 1, state: "QUEUED", enqueuedAt: "2026-09-13T11:00:00Z" },
      statusCheckRollup: [
        { name: "verify", conclusion: "SUCCESS", completedAt: "2026-09-10T05:00:00Z" },
      ],
    });
    const rows = classifyAll([queuedPr], { now: NOW });
    assert.equal(rows[0].action, "already-enqueued");
    assert.deepEqual(unlandedEligible([queuedPr], rows, { now: NOW }), []);
  });
});

/**
 * PEN-5279. `fetchMergeQueueEntries` has the same two-valued contract as
 * `fetchCodeownerRules` and the same reason for it: an empty Map is the
 * measured "nothing is queued here", `null` is UNREAD.
 *
 * The directions are asymmetric and only one of them is dangerous. A `null`
 * degrades to the pre-PEN-5279 behaviour — one wasted no-op enqueue and one
 * wasted cap slot. A Map that is merely INCOMPLETE claims a PR is not queued
 * when it is, which classifies it `enqueue`... which is also the old
 * behaviour. The genuinely unsafe direction is the reverse — claiming a PR IS
 * queued when it is not, since `already-enqueued` is in `NON_HOLD_ACTIONS` and
 * carved out of `unlandedEligible`, so nothing would ever age it.
 */
describe("fetchMergeQueueEntries keeps 'unread' distinguishable from 'empty' (PEN-5279)", () => {
  function ghError(stderr) {
    return Object.assign(new Error("Command failed"), { stderr: Buffer.from(stderr) });
  }

  const page = (nodes, { hasNextPage = false, endCursor = null } = {}) =>
    JSON.stringify({
      data: {
        repository: { mergeQueue: { entries: { pageInfo: { hasNextPage, endCursor }, nodes } } },
      },
    });

  const entry = (number, position) => ({
    position,
    state: "QUEUED",
    enqueuedAt: "2026-09-13T11:00:00Z",
    pullRequest: { number },
  });

  it("maps the queue by PR number", () => {
    const queue = fetchMergeQueueEntries("Blockcast/paperclip", "master", () =>
      page([entry(3275, 1), entry(3288, 2)]),
    );
    assert.equal(queue.size, 2);
    assert.equal(queue.get(3288).position, 2);
    assert.equal(queue.get(9999), undefined);
  });

  it("returns an EMPTY map, not null, for a branch with no queue configured", () => {
    // `mergeQueue(branch:)` answers null for an unqueued branch. Verified live
    // 2026-11-02. That is a measurement: no PR on this base is queued.
    const queue = fetchMergeQueueEntries("Blockcast/paperclip", "some-branch", () =>
      JSON.stringify({ data: { repository: { mergeQueue: null } } }),
    );
    assert.equal(queue.size, 0);
    assert.notEqual(queue, null);
  });

  it("returns null when the read throws", () => {
    assert.equal(
      fetchMergeQueueEntries("Blockcast/paperclip", "master", () => {
        throw ghError("gh: Internal Server Error (HTTP 500)\n");
      }),
      null,
    );
  });

  it("returns null on a GraphQL 200 that carries errors", () => {
    // A 200 with a null payload and an `errors` array is an unread queue, not
    // an empty one.
    assert.equal(
      fetchMergeQueueEntries("Blockcast/paperclip", "master", () =>
        JSON.stringify({ data: { repository: null }, errors: [{ message: "RATE_LIMITED" }] }),
      ),
      null,
    );
  });

  it("returns null rather than a PREFIX when the page budget runs out", () => {
    // A truncated queue is a Map whose absent entries are indistinguishable
    // from "not queued". Hand back nothing rather than a partial answer.
    let calls = 0;
    const queue = fetchMergeQueueEntries("Blockcast/paperclip", "master", () => {
      calls += 1;
      return page([entry(calls, calls)], { hasNextPage: true, endCursor: `c${calls}` });
    });
    assert.equal(queue, null);
    assert.ok(calls > 1 && calls <= 10, `paged ${calls} times, expected a bounded loop`);
  });

  it("returns null when hasNextPage is set but no cursor follows it", () => {
    assert.equal(
      fetchMergeQueueEntries("Blockcast/paperclip", "master", () =>
        page([entry(1, 1)], { hasNextPage: true, endCursor: null }),
      ),
      null,
    );
  });

  it("follows the cursor and accumulates across pages", () => {
    const pages = [
      page([entry(1, 1)], { hasNextPage: true, endCursor: "c1" }),
      page([entry(2, 2)]),
    ];
    const seen = [];
    const queue = fetchMergeQueueEntries("Blockcast/paperclip", "master", (args) => {
      seen.push(args.join(" "));
      return pages.shift();
    });
    assert.equal(queue.size, 2);
    assert.match(seen[1], /cursor=c1/);
  });

  it("returns null for a malformed repo slug rather than querying nonsense", () => {
    assert.equal(fetchMergeQueueEntries("not-a-slug", "master", () => assert.fail("queried")), null);
    assert.equal(
      fetchMergeQueueEntries("Blockcast/paperclip", "", () => assert.fail("queried")),
      null,
    );
  });
});

/**
 * PEN-5279 done-when 4. The bulk queue read happens once at the top of the
 * fire; something else can enqueue the PR before `applyRow` reaches it.
 * GitHub answers the re-enqueue `! Pull request #N is already queued to merge`
 * at EXIT 0, so nothing throws and the row keeps its `enqueue` action — which
 * is the predicate BOTH `sweepRepos`'s cap and `unlandedEligible` key on.
 */
describe("applyRow does not spend a slot re-enqueuing a queued PR (PEN-5279)", () => {
  const enqueueRow = () => ({
    number: 1418,
    headSha: HEAD,
    action: "enqueue",
    reason: "mergestate:CLEAN",
    detail: null,
  });

  /** Answers the head re-read, the queue probe, and records every call. */
  function runner({ queued }, calls = []) {
    return (args) => {
      calls.push(args.join(" "));
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ headRefOid: HEAD });
      if (args[0] === "api" && args[1] === "graphql") {
        return JSON.stringify({
          data: { repository: { pullRequest: { mergeQueueEntry: queued } } },
        });
      }
      return "";
    };
  }

  it("renames the row to already-enqueued instead of re-issuing the merge", () => {
    const calls = [];
    const row = enqueueRow();
    applyRow("Blockcast/paperclip", row, runner({ queued: { position: 3 } }, calls));

    assert.equal(row.action, "already-enqueued");
    assert.match(row.detail, /queue position 3/);
    // The accounting is the point: `sweepRepos` counts `enqueue` rows.
    assert.equal([row].filter((r) => r.action === "enqueue").length, 0);
    assert.ok(
      !calls.some((c) => c.startsWith("pr merge")),
      `expected no merge call, got: ${calls.join(" | ")}`,
    );
  });

  it("enqueues normally when the PR is not in the queue", () => {
    const calls = [];
    const row = enqueueRow();
    const outcome = applyRow("Blockcast/paperclip", row, runner({ queued: null }, calls));

    assert.equal(row.action, "enqueue");
    assert.equal(outcome, "merge requested");
    assert.ok(calls.some((c) => c.startsWith("pr merge")));
  });

  it("enqueues when the queue probe fails — an unreadable probe must not hold a PR", () => {
    // The opposite of `fetchMergeQueueEntries`'s contract, deliberately: here
    // `null` means "go ahead", so a failed probe costs one wasted no-op rather
    // than stranding a PR nothing has enqueued.
    const calls = [];
    const row = enqueueRow();
    applyRow("Blockcast/paperclip", row, (args) => {
      calls.push(args.join(" "));
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ headRefOid: HEAD });
      if (args[0] === "api") throw new Error("graphql exploded");
      return "";
    });

    assert.equal(row.action, "enqueue");
    assert.ok(calls.some((c) => c.startsWith("pr merge")));
  });

  it("still fails closed on a moved head, before the queue is ever probed", () => {
    // PEN-4887's guard must keep precedence: a head that moved invalidates
    // every verdict in the row, queued or not.
    assert.throws(
      () =>
        applyRow("Blockcast/paperclip", enqueueRow(), (args) =>
          args[1] === "view" ? JSON.stringify({ headRefOid: OTHER }) : "",
        ),
      /head moved since classification/,
    );
  });
});

/** PEN-5279: `liveMergeQueueEntry` answers "not queued" on anything it could not read. */
describe("liveMergeQueueEntry fails toward enqueuing (PEN-5279)", () => {
  it("returns the entry when GitHub reports one", () => {
    const entry = liveMergeQueueEntry("Blockcast/paperclip", 3275, () =>
      JSON.stringify({
        data: { repository: { pullRequest: { mergeQueueEntry: { position: 1 } } } },
      }),
    );
    assert.equal(entry.position, 1);
  });

  it("returns null on a throw, on GraphQL errors, and on a malformed slug", () => {
    assert.equal(
      liveMergeQueueEntry("Blockcast/paperclip", 1, () => {
        throw new Error("boom");
      }),
      null,
    );
    assert.equal(
      liveMergeQueueEntry("Blockcast/paperclip", 1, () =>
        JSON.stringify({ data: null, errors: [{ message: "RATE_LIMITED" }] }),
      ),
      null,
    );
    assert.equal(liveMergeQueueEntry("nope", 1, () => assert.fail("queried")), null);
  });
});

/**
 * PEN-5279, Ally review on #3307. The `stale-queued` comment must not
 * prescribe a remedy that costs the PR its queue position. A head-of-queue
 * entry has the most to lose from a dequeue, and it is the only entry that can
 * reach this action at all.
 */
describe("the stale-queued comment never prescribes forfeiting the queue position (PEN-5279)", () => {
  function capture(calls) {
    return (args) => {
      calls.push(args);
      // The `commentOnce` existence probe: no prior comment.
      if (args[0] === "api") return "[]";
      return "";
    };
  }

  const posted = (calls) =>
    String(calls.find((a) => a[0] === "pr" && a[1] === "comment")?.at(-1) ?? "");

  it("states the finding without telling the reader to dequeue and re-enqueue", () => {
    const calls = [];
    applyRow(
      "Blockcast/paperclip",
      {
        number: 1418,
        headSha: HEAD,
        action: "stale-queued",
        reason: "queue position 1, enqueued 14.0h ago",
        detail: "queue position 1, enqueued 14.0h ago",
      },
      capture(calls),
    );

    const body = posted(calls);
    assert.ok(body.length > 0, "expected a comment to be posted");
    // The exact phrasing Ally flagged, and the generic form of it.
    assert.doesNotMatch(body, /dequeue and re-?enqueue it/i);
    assert.match(body, /forfeits this PR's place/i);
    // It must still say what it found, and that it did nothing.
    assert.match(body, /FRONT of the merge queue/);
    assert.match(body, /has taken no action/i);
  });

  it("does not act on the queue — comment only, no merge or dequeue call", () => {
    const calls = [];
    applyRow(
      "Blockcast/paperclip",
      { number: 1418, headSha: HEAD, action: "stale-queued", reason: "r", detail: "d" },
      capture(calls),
    );
    assert.ok(
      !calls.some((a) => a[0] === "pr" && a[1] === "merge"),
      "stale-queued must never issue a merge/disable-auto call",
    );
  });
});

/**
 * PEN-5536. `stale-queued` promoted from "detected, commented once, alarmed on
 * by nobody" to its own alarm cohort.
 *
 * The predicate itself is NOT re-tested here — it belongs to PEN-5279 and is
 * covered above (position 1 strictly, a non-numeric position refused, the
 * 13h clock). What is new is the COLLECTION and the ALARM, so that is what
 * these pin, plus the two negatives proving the cohort inherits the
 * predicate's conservatism instead of re-deriving a looser one.
 */
describe("a wedged front-of-queue entry is its own alarm cohort (PEN-5536)", () => {
  const NOW_ISO = "2026-09-13T12:00:00Z";
  const atNow = (fn) => {
    const real = Date.now;
    Date.now = () => Date.parse(NOW_ISO);
    try {
      return fn();
    } finally {
      Date.now = real;
    }
  };
  const hush = (fn) => {
    const log = console.log;
    const err = console.error;
    const lines = [];
    console.log = (line) => lines.push(String(line));
    console.error = (line) => lines.push(String(line));
    try {
      return { value: fn(), printed: lines.join("\n") };
    } finally {
      console.log = log;
      console.error = err;
    }
  };

  // Drives the REAL classifier, through the shared `pr()` fixture so the early
  // rules (author, labels, draft, reviews) are satisfied the same way every
  // other suite satisfies them. A stubbed `classify` would let this whole
  // suite pass over a predicate that had stopped producing `stale-queued`.
  const queuedPr = (number, { position, enqueuedAt }) =>
    pr({
      number,
      autoMergeRequest: null,
      mergeQueueEntry: { position, state: "AWAITING_CHECKS", enqueuedAt },
    });
  const WEDGED = { position: 1, enqueuedAt: "2026-09-12T22:00:00Z" };

  const sweep = (prs, { landable = true } = {}) => {
    const queued = [];
    hush(() =>
      atNow(() =>
        runRepo({
          repo: "a/one",
          apply: false,
          settleMinutes: 0,
          spent: 0,
          rotted: [],
          stranded: [],
          starved: [],
          queued,
          fetch: () => prs,
          landable,
          state: () => {},
        }),
      ),
    );
    return queued;
  };

  it("collects a head-of-queue entry past the threshold", () => {
    assert.deepEqual(sweep([queuedPr(3389, WEDGED)]), ["a/one#3389"]);
  });

  it("⛔ spends the alarm code, which is the whole point of the promotion", () => {
    // Before this cohort the same finding produced one comment, once, from an
    // applying fire on the `45 */6` cadence — up to ~6h after the hourly
    // detector had already seen it — and `alarmExitCode` never heard about it.
    assert.equal(alarmExitCode([], [], [], ["a/one#3389"]), 1);
    assert.equal(alarmExitCode([], [], []), 0, "control: the term still defaults quiet");
    assert.equal(
      alarmExitCode([], ["a/broken (HTTP 502)"], [], ["a/one#3389"]),
      1,
      "a measured alarm outranks an unreadable repo, as for the sibling cohorts",
    );
    assert.equal(alarmExitCode([], [], [], []), 0, "and an empty cohort is not an alarm");
  });

  it("names the cohort in its own ALARM block, not inside another one", () => {
    const SOURCE = readFileSync(new URL("./land-clean-prs.mjs", import.meta.url), "utf8");
    assert.match(SOURCE, /ALARM: \$\{queued\.length\} PR\(s\) have been at the FRONT/);
    assert.match(SOURCE, /if \(alarm && queued\.length > 0\) \{/);
  });

  it("stays quiet for a healthy queued PR that is NOT at the front", () => {
    // Depth is not wedging. `enqueuedAt` dates entry into the queue, not time
    // stuck, so a deep entry crosses 13h while progressing perfectly well —
    // and the obvious response to a staleness report, dequeue and re-enqueue,
    // forfeits the position it has already waited for.
    for (const position of [2, 7, 40]) {
      assert.deepEqual(
        sweep([queuedPr(3389, { position, enqueuedAt: WEDGED.enqueuedAt })]),
        [],
        `position ${position} must not read as the front`,
      );
    }
  });

  it("does not manufacture a finding from an absent or non-numeric position", () => {
    // Unread must not become a finding. `"1"` is the one that matters: it is
    // the shape a JSON field drifts into, and it LOOKS like the front.
    for (const position of [null, undefined, "1"]) {
      assert.deepEqual(
        sweep([queuedPr(3389, { position, enqueuedAt: WEDGED.enqueuedAt })]),
        [],
        `position ${JSON.stringify(position)} must not read as the front`,
      );
    }
  });

  it("stays quiet for a FRESH head-of-queue entry", () => {
    assert.deepEqual(sweep([queuedPr(3389, { position: 1, enqueuedAt: NOW_ISO })]), []);
  });

  it("⛔ MUTATION PAIR: alarms in a land repo, silent in a notify-only one", () => {
    // This is the pair, and neither half means anything alone. The first
    // assertion alone stays green if the `landable` gate is deleted; the
    // second alone stays green if the cohort stops collecting entirely. Only
    // together do they pin that the gate exists AND that it is the gate doing
    // the work rather than an absent detector.
    //
    // It matters more here than for the sibling cohorts because this is the
    // file's FIRST land-scoping that is a visible check. `stranded` and
    // `starved` are scoped as CONSEQUENCES — the first by
    // `demoteMergeActions`' rename defeating its `enqueue` predicate, the
    // second by `maxEnqueues: Infinity` making a `cap:` row unreachable — so
    // deleting their scoping means deleting load-bearing machinery and
    // everything goes red. Deleting one `if (landable)` costs nothing without
    // this test.
    const prs = [queuedPr(3389, WEDGED)];
    assert.deepEqual(sweep(prs, { landable: true }), ["a/one#3389"], "land repo: alarms");
    assert.deepEqual(sweep(prs, { landable: false }), [], "notify-only repo: silent");
  });

  it("the notify-only repo still PRINTS the finding it does not alarm on", () => {
    // Not alarming on a guest repo's wedged queue is the decision; refusing to
    // report it is not. This is why the gate is an `if` at the collection site
    // rather than an entry in MERGE_MUTATING_ACTIONS, which would rename the
    // row to `notify-only` and erase it from the receipt too.
    const { printed } = hush(() =>
      atNow(() =>
        runRepo({
          repo: "a/one",
          apply: false,
          settleMinutes: 0,
          spent: 0,
          rotted: [],
          stranded: [],
          starved: [],
          queued: [],
          fetch: () => [queuedPr(3389, WEDGED)],
          landable: false,
          state: () => {},
        }),
      ),
    );
    assert.match(printed, /stale-queued/, "the receipt still names it");
  });
});


describe("a PR stacked on a feature branch is out of scope (PEN-5469)", () => {
  const MASTER = "master";
  // The measured instance: #3366, stacked on #3353's branch.
  const STACK_BASE = "fix/land-clean-prs-oldest-first-blo-51664";

  const landable = (overrides = {}) => pr({ baseRefName: MASTER, repoDefaultBranch: MASTER, ...overrides });
  const stacked = (overrides = {}) => landable({ baseRefName: STACK_BASE, ...overrides });

  it("⛔ does not spend a cap slot on a stacked PR; the slot goes to the oldest DEFAULT-base PR", () => {
    // Done-when 2, and the fixture is built to discriminate rather than to
    // pass. The stacked PR is the OLDER of the two, so under the BLO-51664
    // ascending-number allocation it wins the single slot outright if it is
    // eligible at all — which is exactly what #3366 did in the 22:32Z and
    // 23:33Z fires on 2026-11-03 while ten `master` PRs read `cap:10-per-fire`
    // beneath it. Against the pre-PEN-5469 code this asserts the opposite of
    // what the code does, in both columns.
    // Three candidates for ONE slot, listed newest-first as `gh pr list`
    // returns them, so the fixture can tell "oldest default-base PR" apart
    // from "first listed" as well as from "oldest overall".
    const rows = classifyAll(
      [landable({ number: 3400 }), stacked({ number: 3100 }), landable({ number: 3200 })],
      { now: NOW, maxEnqueues: 1 },
    );
    assert.deepEqual(
      rows.map((row) => [row.number, row.action]),
      [
        [3400, "skip"],
        [3100, NON_DEFAULT_BASE_ACTION],
        // The OLDEST default-base PR takes the slot — not #3100, which is
        // older still but stacked, and not #3400, which is listed first.
        [3200, "enqueue"],
      ],
    );
    assert.equal(rows[0].reason, "cap:1-per-fire", "the deferred one is deferred BY THE CAP");
    // The stacked PR is not merely ranked last — it is not a cap participant
    // at all, so it never reads as a deferral the next fire might honour.
    assert.equal(rows[1].reason, `base:${STACK_BASE}`);
    assert.equal(rows.filter((row) => /^cap:/.test(String(row.reason ?? ""))).length, 1);
  });

  it("names the branch it is stacked on, in the reason and in the detail", () => {
    const row = classifyFromListing(stacked(), { now: NOW });
    assert.equal(row.action, NON_DEFAULT_BASE_ACTION);
    assert.equal(row.reason, `base:${STACK_BASE}`);
    assert.match(row.detail, new RegExp(STACK_BASE.replace(/[/-]/g, "\\$&")));
    assert.match(row.detail, /move that branch's head/);
  });

  describe("an ARMED stacked PR is named in the receipt, because nothing else can reach it", () => {
    // This rule returns ahead of the `autoMergeRequest` branch, so a stacked
    // PR armed by an earlier fire can never reach `stale-enqueue` and its
    // `--disable-auto` remedy. Returning first is correct; leaving the arming
    // unsaid is not, and is the same blind spot PEN-5469 is about. The
    // receipt names it so a human can disarm by hand — this routine issues no
    // write against a non-default base.
    it("says so when auto-merge is still armed", () => {
      const armedPr = stacked({ autoMergeRequest: { enabledAt: "2026-09-13T10:00:00Z" } });
      const row = classifyFromListing(armedPr, { now: NOW });
      assert.equal(row.action, NON_DEFAULT_BASE_ACTION, "still out of scope, armed or not");
      assert.match(row.detail, /auto-merge still ARMED/);
      assert.match(row.detail, /disarm by hand/);
    });

    it("stays silent about arming when the PR is not armed", () => {
      // Without this the note would read as boilerplate and carry no signal.
      const row = classifyFromListing(stacked({ autoMergeRequest: null }), { now: NOW });
      assert.equal(row.action, NON_DEFAULT_BASE_ACTION);
      assert.doesNotMatch(row.detail, /ARMED/);
    });

    it("still does not spend a cap slot, armed or not", () => {
      const rows = classifyAll(
        [
          stacked({ number: 3100, autoMergeRequest: { enabledAt: "2026-09-13T10:00:00Z" } }),
          landable({ number: 3200 }),
        ],
        { now: NOW, maxEnqueues: 1 },
      );
      assert.deepEqual(
        rows.map((row) => [row.number, row.action]),
        [[3100, NON_DEFAULT_BASE_ACTION], [3200, "enqueue"]],
      );
    });
  });

  it("is SCOPE, so it is decided ahead of every readiness rule", () => {
    // Deliberately pinned: a stacked PR is not ours whatever else is true of
    // it, and the verdict must not be reachable-around by removing a label or
    // marking the PR ready. `do-not-merge` is today's manual control for
    // exactly this case, so the two necessarily overlap.
    const row = classifyFromListing(
      stacked({ labels: [{ name: "do-not-merge" }], isDraft: true, autoMergeRequest: {} }),
      { now: NOW },
    );
    assert.equal(row.action, NON_DEFAULT_BASE_ACTION);
  });

  it("leaves a PR that targets the default branch completely alone", () => {
    assert.equal(classifyFromListing(landable(), { now: NOW }), null, "falls through to classifyPr");
    assert.equal(classifyPr(landable(), { now: NOW }).action, "enqueue");
  });

  describe("⛔ an UNPROVEN base must not skip — the skip is the unrecoverable direction", () => {
    // A wrongly-skipped PR is stranded on every fire forever and no detector
    // ages it (the action is in NON_HOLD_ACTIONS). Not skipping degrades to
    // the pre-PEN-5469 behaviour, which is wasteful but cannot stall anything.
    for (const [why, overrides] of [
      ["the default branch could not be read", { repoDefaultBranch: null }],
      ["the default branch is absent from the row", { repoDefaultBranch: undefined }],
      ["the default branch came back empty", { repoDefaultBranch: "" }],
      ["the listing carried no base", { baseRefName: undefined }],
      ["the base came back empty", { baseRefName: "" }],
    ]) {
      it(`still enqueues when ${why}`, () => {
        const row = classifyPr(stacked(overrides), { now: NOW });
        assert.equal(row.action, "enqueue", `${why}: must not skip on an unproven base`);
      });
    }
  });

  describe("it is a POLICY hold, so no staleness cohort may age it", () => {
    // The `notify-only` argument: the hold clears when the AUTHOR retargets,
    // never because this routine waited. Aging it would comment on every
    // stacked PR every fire, forever.
    const rows = [
      { number: 3100, action: NON_DEFAULT_BASE_ACTION, reason: `base:${STACK_BASE}` },
      { number: 3400, action: "skip", reason: "checks:FAILURE" },
    ];
    const prs = [stacked({ number: 3100 }), landable({ number: 3400 })];

    it("stalledHolds skips it while still aging an ordinary hold", () => {
      const held = stalledHolds(prs, rows, { now: NOW, staleHours: 0 });
      assert.deepEqual(held.map((h) => h.number), [3400], "only the ordinary skip is aged");
    });

    it("unlandedEligible and capStarved do not see it either", () => {
      assert.deepEqual(unlandedEligible(prs, rows, { now: NOW, staleHours: 0 }), []);
      assert.deepEqual(capStarved(prs, rows, { now: NOW, staleHours: 0 }), []);
    });
  });

  it("does not change the per-fire cap (done-when 4)", () => {
    assert.equal(MAX_ENQUEUES_PER_FIRE, 10);
  });
});

describe("fetchDefaultBranch reads one branch per repo and fails to UNREAD (PEN-5469)", () => {
  it("returns the default branch name", () => {
    const seen = [];
    const name = fetchDefaultBranch("a/one", (args) => {
      seen.push(args);
      return JSON.stringify({ defaultBranchRef: { name: "master" } });
    });
    assert.equal(name, "master");
    assert.deepEqual(seen, [["repo", "view", "a/one", "--json", "defaultBranchRef"]]);
  });

  for (const [why, run] of [
    ["gh throws", () => { throw new Error("HTTP 502"); }],
    ["the body is not JSON", () => "not json"],
    ["the ref is absent", () => JSON.stringify({ defaultBranchRef: null })],
    ["the name is empty", () => JSON.stringify({ defaultBranchRef: { name: "" } })],
    ["the name is not a string", () => JSON.stringify({ defaultBranchRef: { name: 7 } })],
  ]) {
    it(`returns null — never a value to compare bases against — when ${why}`, () => {
      assert.equal(fetchDefaultBranch("a/one", run), null);
    });
  }

  it("never throws, so an unreadable default branch cannot abort a whole fire", () => {
    assert.doesNotThrow(() => fetchDefaultBranch("a/one", () => { throw new Error("boom"); }));
  });

  it("fetchOpenPrs hydrates it onto every row, reading it ONCE for the repo", () => {
    const listing = [
      { number: 11, headRefOid: "1".repeat(40), author: { login: "kkroo", is_bot: false }, labels: [], isDraft: false, autoMergeRequest: null, reviewRequests: [], baseRefName: "master" },
      { number: 22, headRefOid: "2".repeat(40), author: { login: "kkroo", is_bot: false }, labels: [], isDraft: false, autoMergeRequest: null, reviewRequests: [], baseRefName: "feature/x" },
    ];
    let reads = 0;
    const prs = fetchOpenPrs("a/one", {
      run: (args) => {
        if (args[0] === "pr" && args[1] === "list") return JSON.stringify(listing);
        throw new Error(`unexpected gh call: ${args.join(" ")}`);
      },
      mergeStates: () => new Map([[11, "CLEAN"], [22, "CLEAN"]]),
      defaultBranch: () => (reads += 1, "master"),
    });
    assert.equal(reads, 1, "one read per repo, not one per PR");
    assert.deepEqual(prs.map((row) => row.repoDefaultBranch), ["master", "master"]);
  });

  it("asks the listing for baseRefName, which the whole rule depends on", () => {
    const seen = [];
    fetchOpenPrs("a/one", {
      run: (args) => {
        seen.push(args);
        if (args[0] === "pr" && args[1] === "list") return JSON.stringify([]);
        throw new Error(`unexpected gh call: ${args.join(" ")}`);
      },
      mergeStates: () => new Map(),
      defaultBranch: () => "master",
    });
    const list = seen.find((args) => args[0] === "pr" && args[1] === "list");
    assert.ok(list[list.indexOf("--json") + 1].includes("baseRefName"));
  });
});

describe("only a LISTING failure is skippable (PEN-5482)", () => {
  const quietly = (fn) => {
    const log = console.log;
    const lines = [];
    console.log = (line) => lines.push(String(line));
    try {
      return { value: fn(), lines: lines.join("\n") };
    } finally {
      console.log = log;
    }
  };

  it("⛔ an untagged throw propagates instead of being reported as unlistable", () => {
    // The defect this pins: PEN-5442's catch sits around the WHOLE of
    // `runRepo`, not around the list call it was written for. `classifyAll`,
    // the apply loop, the hold comments and the receipt all throw through it,
    // and a throw from any of them used to be swallowed into the `unreadable`
    // cohort. Two separate wrongs from that one catch:
    //
    //  - the operator is told the repo "could not be listed", which is false,
    //    and sends them to GitHub availability instead of to the real bug;
    //  - `return []` reports zero spend for a repo whose apply loop may have
    //    ALREADY enqueued, so later repos in the same fire run past
    //    `MAX_ENQUEUES_PER_FIRE`.
    //
    // Latent when written — everything downstream of the apply loop is
    // in-memory rendering and the one real write already catches its own
    // failure — which is the point: a too-wide catch hides the NEXT bug, and
    // the next bug is the one nobody is looking for.
    const unreadable = [];
    const swept = [];
    const run = ({ repo }) => {
      if (repo === "a/broken") throw new Error("applyOne blew up after enqueuing #1");
      swept.push(repo);
      return [{ number: 1, action: "enqueue" }];
    };
    const { lines } = quietly(() =>
      assert.throws(
        () =>
          sweepRepos(
            ["a/broken", "a/fine"],
            repoRunner({
              apply: true,
              settleMinutes: 0,
              rotted: [],
              stranded: [],
              run,
              notify: new Set(),
              unreadable,
              starved: [],
              queued: [],
            }),
          ),
        /applyOne blew up after enqueuing #1/,
        "an apply-loop failure must reach the operator as itself",
      ),
    );
    assert.deepEqual(unreadable, [], "and must never be filed as a repo that could not be listed");
    assert.deepEqual(swept, [], "the fire ends there rather than carrying a spend it cannot vouch for");
    assert.doesNotMatch(lines, /could not be listed/, "nor claim so on stdout");
  });

  it("⛔ the real runRepo tags its listing failure, so the real pair still skips", () => {
    // The seam tests above assert `repoRunner`'s half. This one composes the
    // REAL `runRepo` with the REAL `repoRunner`, so deleting the tag from
    // `runRepo`'s fetch catch fails a test rather than quietly turning every
    // 502 back into a fire-ending throw.
    const unreadable = [];
    const swept = [];
    const run = (bag) =>
      runRepo({
        ...bag,
        fetch: () => {
          if (bag.repo === "a/broken") {
            throw Object.assign(new Error("gh failed"), { stderr: "HTTP 502: 502 Bad Gateway" });
          }
          swept.push(bag.repo);
          return [];
        },
      });
    const { lines } = quietly(() =>
      sweepRepos(
        ["a/broken", "a/fine"],
        repoRunner({
          apply: false,
          settleMinutes: 0,
          rotted: [],
          stranded: [],
          run,
          notify: new Set(),
          unreadable,
          starved: [],
          queued: [],
        }),
      ),
    );
    assert.deepEqual(unreadable, ["a/broken (HTTP 502: 502 Bad Gateway)"], "listed as unreadable, with its reason");
    assert.deepEqual(swept, ["a/fine"], "and the readable repo was still read");
    assert.match(lines, /Skipped a\/broken/);
  });

  it("⛔ a wiring fault raised under the fetch seam is not laundered into a skip", () => {
    // The composition of the two guards in `repoRunner`'s catch, and the
    // reason identity is consulted FIRST rather than folded into the tag
    // allowlist. `runRepo`'s fetch catch tags whatever it caught WITHOUT
    // asking what it was, so a `WiringError` raised from under `fetch` — a
    // bagged helper called by a future read path, say — reaches `repoRunner`
    // already carrying the listing tag and would otherwise buy the skip it is
    // least entitled to. PEN-5536's rule holds unconditionally: a wiring fault
    // is never recorded as a repo-readability fact, whatever tagged it.
    const unreadable = [];
    const run = (bag) =>
      runRepo({
        ...bag,
        fetch: () => {
          throw new WiringError("someReadHelper: unknown option `rotted`.");
        },
      });
    quietly(() =>
      assert.throws(
        () =>
          sweepRepos(
            ["a/one"],
            repoRunner({
              apply: false,
              settleMinutes: 0,
              rotted: [],
              stranded: [],
              run,
              notify: new Set(),
              unreadable,
              starved: [],
              queued: [],
            }),
          ),
        (error) => error instanceof WiringError,
        "a wiring fault stays a wiring fault even once the fetch catch has tagged it",
      ),
    );
    assert.deepEqual(unreadable, [], "and is never filed as a repo that could not be listed");
  });

  it("⛔ a foreign `collectFailed` property does not buy the skip", () => {
    // Ally review, PR #3376. The tag is a module-private `Symbol`, not a string
    // key, so no other throw site — and no error object from a library that
    // happens to carry that name — can opt itself into the skip. A string key
    // would collide in the fail-OPEN direction, which is the one direction this
    // whole change exists to close.
    const unreadable = [];
    const run = () => {
      throw Object.assign(new Error("not a listing failure"), {
        stderr: "HTTP 502: 502 Bad Gateway",
        collectFailed: true,
      });
    };
    quietly(() =>
      assert.throws(
        () =>
          sweepRepos(
            ["a/one"],
            repoRunner({
              apply: true,
              settleMinutes: 0,
              rotted: [],
              stranded: [],
              run,
              notify: new Set(),
              unreadable,
              starved: [],
              queued: [],
            }),
          ),
        /not a listing failure/,
        "only this module's symbol tags a listing failure",
      ),
    );
    assert.deepEqual(unreadable, [], "and it is not filed as a repo that could not be listed");
  });

  it("leaves an untaggable error alone rather than failing in the catch", () => {
    // `markCollectFailure` declines to tag a non-extensible error instead of
    // assigning to it: this file is a module, so a frozen-object assignment
    // throws, and a `TypeError` raised INSIDE the catch would replace the real
    // error with one naming the wrong line entirely. Untagged then means the
    // fire ends loudly — the pre-PEN-5442 behaviour, and the safe direction.
    const unreadable = [];
    const frozen = Object.freeze(
      Object.assign(new Error("gh failed"), { stderr: "HTTP 502: 502 Bad Gateway" }),
    );
    const run = (bag) =>
      runRepo({
        ...bag,
        fetch: () => {
          throw frozen;
        },
      });
    let thrown;
    const { lines } = quietly(() => {
      try {
        sweepRepos(
          ["a/broken"],
          repoRunner({
            apply: false,
            settleMinutes: 0,
            rotted: [],
            stranded: [],
            run,
            notify: new Set(),
            unreadable,
            starved: [],
            queued: [],
          }),
        );
      } catch (error) {
        thrown = error;
      }
    });
    // Identity, not just the message: a `TypeError` raised by the tagging would
    // also have escaped the sweep, and would also have been "an error".
    assert.equal(thrown, frozen, "the original error object, not a TypeError from the tagging");
    assert.doesNotMatch(lines, /could not be listed/, "and not reported as unlistable");
    assert.deepEqual(Object.getOwnPropertySymbols(frozen), [], "never tagged");
    assert.deepEqual(unreadable, [], "so it is not filed as a mere skip");
  });
});

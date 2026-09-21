import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHECK_SETTLE_MINUTES,
  MAX_ENQUEUES_PER_FIRE,
  STALE_ENQUEUE_HOURS,
  allyVerdictAtHead,
  approvalLanes,
  checkSettlement,
  classifyAll,
  classifyFromListing,
  classifyPr,
  failingChecks,
  isFatalGhError,
  isMainModule,
  latestCheckStates,
  settleMinutesFrom,
  targetRepos,
  unsatisfiedOwners,
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

  it("enqueues once the code owner has APPROVED at the current head", () => {
    const row = classify({
      reviewRequests: [{ login: "kkroo" }],
      reviews: [
        review(),
        { id: 2, state: "APPROVED", user: { login: "kkroo", id: 1845185, type: "User" }, commit_id: HEAD, body: "lgtm" },
      ],
    });
    assert.equal(row.action, "enqueue");
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

  it("does not spend cap on PRs that were not enqueueable anyway", () => {
    const rows = classifyAll([pr({ number: 1, mergeStateStatus: "DIRTY" }), pr({ number: 2 })], {
      now: NOW,
      maxEnqueues: 1,
    });
    assert.equal(rows[1].action, "enqueue");
  });

  it("carries spend across repos, so the cap is per FIRE and not per repo", () => {
    // `runRepo` calls `classifyAll` once per swept repo. Without `spent` the
    // counter restarts each call and the real ceiling is `cap x repos` — the
    // blast radius scaling with the multi-repo knob that makes a classifier
    // bug reach further in the first place.
    const clean = () => Array.from({ length: 3 }, (_, i) => pr({ number: 200 + i }));
    let spent = 0;
    const perRepo = [];
    for (const _repo of ["a/one", "a/two", "a/three"]) {
      const rows = classifyAll(clean(), { now: NOW, maxEnqueues: 4, spent });
      const armed = rows.filter((r) => r.action === "enqueue").length;
      spent += armed;
      perRepo.push(armed);
    }
    assert.deepEqual(perRepo, [3, 1, 0], "repo 2 gets the remainder, repo 3 gets nothing");
    assert.equal(spent, 4, "total armed never exceeds the cap");
  });
});

describe("settle floor from the environment", () => {
  // `Number("15m")` is NaN and `ageMinutes < NaN` is false, so an unparseable
  // value reported every rollup as settled — the guard disarming itself in the
  // fail-OPEN direction, silently.
  it("falls back to the default for values that are not a number of minutes", () => {
    for (const bad of ["15m", "banana", "", "   ", undefined, null, "-5", "NaN"]) {
      assert.equal(settleMinutesFrom(bad), CHECK_SETTLE_MINUTES, `bad input: ${String(bad)}`);
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
    assert.deepEqual(targetRepos(""), ["Blockcast/paperclip"]);
    assert.deepEqual(targetRepos(undefined), ["Blockcast/paperclip"]);
    assert.deepEqual(targetRepos("Blockcast/paperclip,,  "), ["Blockcast/paperclip"]);
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

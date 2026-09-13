import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_ENQUEUES_PER_FIRE,
  STALE_ENQUEUE_HOURS,
  allyVerdictAtHead,
  classifyAll,
  classifyFromListing,
  classifyPr,
  failingChecks,
  isFatalGhError,
  isMainModule,
  latestCheckStates,
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

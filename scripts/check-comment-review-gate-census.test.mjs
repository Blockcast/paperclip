import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  admitsNothingEvaluated,
  findPrViolations,
  findViolations,
  isMainModule,
  isReviewNamespacedContext,
  statusesAsOfMerge,
  violatingPrCount,
} from "./check-comment-review-gate-census.mjs";

const HEAD = "a".repeat(40);
const MERGED_AT = "2026-08-22T02:46:06Z";

function status(overrides = {}) {
  return {
    context: "review/ally-comment",
    state: "success",
    description: "No Ally consolidated-review comment attests to reviewing this head.",
    updated_at: "2026-08-22T02:40:00Z",
    ...overrides,
  };
}

function pr(statuses, overrides = {}) {
  return { number: 1473, headRefOid: HEAD, mergedAt: MERGED_AT, statuses, ...overrides };
}

describe("isReviewNamespacedContext", () => {
  it("matches the review/ namespace case-insensitively", () => {
    assert.equal(isReviewNamespacedContext("review/ally-comment"), true);
    assert.equal(isReviewNamespacedContext("  Review/Ally-Complete "), true);
  });

  it("does not match a gate/ context or a lookalike prefix", () => {
    assert.equal(isReviewNamespacedContext("gate/ally-comment-findings"), false);
    assert.equal(isReviewNamespacedContext("reviewer/ally"), false);
    assert.equal(isReviewNamespacedContext(undefined), false);
  });
});

describe("admitsNothingEvaluated", () => {
  it("recognizes every not-evaluated description the gate emits", () => {
    assert.equal(
      admitsNothingEvaluated("No Ally consolidated-review comment attests to reviewing this head."),
      true,
    );
    assert.equal(admitsNothingEvaluated("No head SHA was supplied to evaluate against."), true);
    assert.equal(
      admitsNothingEvaluated(
        "The only comment attesting this head is the PR author's own; nothing independent reviewed it.",
      ),
      true,
    );
    assert.equal(
      admitsNothingEvaluated(
        "The PR author is unknown, so this head's attestation cannot be shown to be independent.",
      ),
      true,
    );
  });

  it("does not claim another repo's review script by a generic substring", () => {
    // This predicate runs against every green `review/`-namespaced status on a
    // merged PR, not only this gate's context. Shortening an alternative to a
    // common phrase — `PR author` was the one that motivated this — makes the
    // census flag wording it does not own. Fails if any alternative is
    // narrowed back to a fragment short enough to appear in a sentence this
    // module never wrote.
    assert.equal(admitsNothingEvaluated("The PR author has not requested a review yet."), false);
    assert.equal(admitsNothingEvaluated("octocat approved head abc1234 as the PR author."), false);
  });

  it("does not flag a genuine reviewed-and-clean description", () => {
    assert.equal(
      admitsNothingEvaluated(
        "Ally's most recent consolidated-review comment for this head reports no unresolved findings.",
      ),
      false,
    );
  });
});

describe("statusesAsOfMerge", () => {
  it("ignores a write that landed after the merge", () => {
    // The post-merge mutation this census exists to defeat: a green write one
    // second after merge would otherwise erase the violation.
    const asOf = statusesAsOfMerge(
      [
        status({ state: "failure", updated_at: "2026-08-22T02:40:00Z" }),
        status({ state: "success", updated_at: "2026-08-22T02:46:07Z" }),
      ],
      MERGED_AT,
    );

    assert.equal(asOf.length, 1);
    assert.equal(asOf[0].state, "failure");
  });

  it("keeps the latest write at or before the merge instant", () => {
    const asOf = statusesAsOfMerge(
      [
        status({ description: "older", updated_at: "2026-08-22T01:00:00Z" }),
        status({ description: "newer", updated_at: "2026-08-22T02:00:00Z" }),
      ],
      MERGED_AT,
    );

    assert.equal(asOf.length, 1);
    assert.equal(asOf[0].description, "newer");
  });

  it("collapses per context rather than across contexts", () => {
    const asOf = statusesAsOfMerge(
      [status({ context: "review/ally-comment" }), status({ context: "review/ally-complete" })],
      MERGED_AT,
    );

    assert.deepEqual(
      asOf.map((entry) => entry.context).sort(),
      ["review/ally-comment", "review/ally-complete"],
    );
  });

  it("rejects an unparseable mergedAt rather than silently passing", () => {
    assert.throws(() => statusesAsOfMerge([status()], "not-a-date"), /Unparseable mergedAt/);
  });
});

describe("findPrViolations", () => {
  it("flags a green review/ status that admits nothing evaluated the head", () => {
    const violations = findPrViolations(pr([status()]));

    assert.equal(violations.length, 1);
    assert.equal(violations[0].context, "review/ally-comment");
    assert.match(violations[0].detail, /green at merge while admitting/);
  });

  it("does not flag the same verdict outside the review/ namespace", () => {
    assert.deepEqual(findPrViolations(pr([status({ context: "gate/ally-comment-findings" })])), []);
  });

  it("does not flag a non-green state, nor a reviewed-and-clean green", () => {
    assert.deepEqual(findPrViolations(pr([status({ state: "failure" })])), []);
    assert.deepEqual(
      findPrViolations(
        pr([
          status({
            description:
              "Ally's most recent consolidated-review comment for this head reports no unresolved findings.",
          }),
        ]),
      ),
      [],
    );
  });

  it("treats a PR with no statuses at all as clean for this invariant", () => {
    assert.deepEqual(findPrViolations(pr([])), []);
  });

  // BLO-34742. The gate also writes a retirement pointer over the old
  // `review/ally-comment` context, mirroring the live state. For a
  // not-evaluated verdict that mirror is a green `review/`-namespaced row on a
  // head nothing reviewed — a violation by this census's own definition — and
  // it was worded past the pattern, so the row was admitted at the state check
  // and then silently skipped at the description check. BLO-34316 made that
  // blind spot matter: `not_evaluated` went from "PRs Ally has not reviewed
  // yet" to every agent PR carrying only a self-attestation.
  //
  // These fixtures carry the gate's wording verbatim. The binding cross-check
  // that the gate still emits it lives in the server suite
  // (`pr-comment-review-gate.test.ts`), which asserts against this module's own
  // `admitsNothingEvaluated` rather than against a copy of these strings.
  it("flags the retired mirror of a not-evaluated verdict", () => {
    const violations = findPrViolations(
      pr([
        status({
          description:
            'Retired. No independent Ally consolidated-review comment attests this head; "gate/ally-comment-findings" carries the verdict.',
        }),
      ]),
    );

    assert.equal(violations.length, 1);
    assert.equal(violations[0].context, "review/ally-comment");
  });

  it("does not flag the retired mirror of a clean verdict", () => {
    assert.deepEqual(
      findPrViolations(
        pr([
          status({
            description:
              'Retired. Comment-shaped review findings now publish to "gate/ally-comment-findings".',
          }),
        ]),
      ),
      [],
    );
  });
});

describe("findViolations", () => {
  it("aggregates across PRs and tolerates an empty census", () => {
    assert.equal(findViolations([pr([status()]), pr([status()], { number: 1390 })]).length, 2);
    assert.deepEqual(findViolations([]), []);
    assert.deepEqual(findViolations(undefined), []);
  });
});

describe("violatingPrCount", () => {
  // The headline reads "N of M merged PRs", so N counts PRs and the per-row
  // detail lines count rows. Counting rows there was harmless while at most one
  // `review/` row per PR could match; making the retired mirror countable makes
  // several rows per PR routine, and a row count can then exceed M.
  it("counts distinct PRs, not rows", () => {
    const rows = findViolations([
      pr([status(), status({ context: "review/ally-complete" })]),
      pr([status()], { number: 1390 }),
    ]);

    assert.equal(rows.length, 3);
    assert.equal(violatingPrCount(rows), 2);
  });

  it("is zero for an empty or missing list", () => {
    assert.equal(violatingPrCount([]), 0);
    assert.equal(violatingPrCount(undefined), 0);
  });
});

describe("isMainModule", () => {
  it("is false when the entrypoint is a different file", () => {
    assert.equal(isMainModule("/some/other/entrypoint.mjs", import.meta.url), false);
  });

  it("is true when the entrypoint is the module itself", () => {
    assert.equal(isMainModule(fileURLToPath(import.meta.url), import.meta.url), true);
  });
});

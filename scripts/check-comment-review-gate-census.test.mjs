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
  it("recognizes both not-evaluated descriptions the gate emits", () => {
    assert.equal(
      admitsNothingEvaluated("No Ally consolidated-review comment attests to reviewing this head."),
      true,
    );
    assert.equal(admitsNothingEvaluated("No head SHA was supplied to evaluate against."), true);
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
});

describe("findViolations", () => {
  it("aggregates across PRs and tolerates an empty census", () => {
    assert.equal(findViolations([pr([status()]), pr([status()], { number: 1390 })]).length, 2);
    assert.deepEqual(findViolations([]), []);
    assert.deepEqual(findViolations(undefined), []);
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

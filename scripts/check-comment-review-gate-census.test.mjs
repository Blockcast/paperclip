import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  admitsNothingEvaluated,
  classifyAuditedContext,
  findPrViolations,
  findViolations,
  isMainModule,
  isReviewNamespacedContext,
  parseGateContexts,
  statusesAsOfMerge,
  summarizeViolations,
  violatingPrCount,
  violationsBySurface,
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

    // PEN-5565. These two are the regression guard for the shortest pair of
    // alternatives, which used to read `The PR author is unknown` and `no head
    // SHA was supplied`. Both sentences are ones an unrelated status could
    // plausibly write, and under the PEN-5781 all-namespace audit a match puts
    // the foreign row in `unclassified` — the bucket that reports a RENAME.
    // Each case below is green only while the alternative quotes enough of the
    // gate's own sentence to exclude it.
    assert.equal(admitsNothingEvaluated("The PR author is unknown to this changelog bot."), false);
    assert.equal(
      admitsNothingEvaluated("Skipped: no head SHA was supplied by the workflow dispatch."),
      false,
    );
  });

  it("does not flag a genuine reviewed-and-clean description", () => {
    assert.equal(
      admitsNothingEvaluated(
        "Ally's most recent consolidated-review comment for this head reports no unresolved findings, per its structured ally-verdict block.",
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
    assert.equal(violations[0].surface, "review-namespace");
    assert.match(violations[0].detail, /green at merge while admitting/);
  });

  // PEN-5781. THIS ASSERTION USED TO READ THE OTHER WAY — "does not flag the
  // same verdict outside the review/ namespace" — and that is how the blindness
  // survived review: the census's scope was pinned to the namespace the gate had
  // already been moved OUT of (BLO-33657), so the one context that actually gates
  // merge was asserted to be invisible.
  //
  // Measured 2026-11-06 over the 12 most recently merged PRs on Blockcast/paperclip:
  // the old predicate found 10 violations, every one of them the retired mirror,
  // and none on `gate/ally-comment-findings` — then the SOLE ruleset-required
  // status context on master (ruleset 25827389).
  it("flags the same verdict on the required gate context, outside review/", () => {
    const violations = findPrViolations(pr([status({ context: "gate/ally-comment-findings" })]));

    assert.equal(violations.length, 1);
    assert.equal(violations[0].context, "gate/ally-comment-findings");
    assert.equal(violations[0].surface, "required-gate");
  });

  // The rename tripwire. A context in neither audited set still counts, so the
  // next rename cannot make this census silent again — only mislabel the bucket.
  it("flags a renamed context it has never heard of, as unclassified", () => {
    const violations = findPrViolations(pr([status({ context: "verify/ally-findings-v2" })]));

    assert.equal(violations.length, 1);
    assert.equal(violations[0].surface, "unclassified");
  });

  it("still requires this gate's own wording, whatever the context is called", () => {
    assert.deepEqual(
      findPrViolations(
        pr([status({ context: "ci/some-other-system", description: "Build succeeded." })]),
      ),
      [],
    );
  });

  it("does not flag a non-green state, nor a reviewed-and-clean green", () => {
    assert.deepEqual(findPrViolations(pr([status({ state: "failure" })])), []);
    assert.deepEqual(
      findPrViolations(
        pr([
          status({
            description:
              "Ally's most recent consolidated-review comment for this head reports no unresolved findings, per its structured ally-verdict block.",
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
    // PEN-5781 done-when #2, decided: the retirement row STAYS a violation.
    // BLO-34742 worded it to trip this pattern on purpose ("the retired mirror
    // of a not-evaluated verdict always was one"), so it is not reclassified as
    // benign here. It is bucketed apart from the required gate instead, because
    // it MIRRORS that verdict rather than being an independent instance.
    assert.equal(violations[0].surface, "review-namespace");
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

describe("classifyAuditedContext", () => {
  it("separates the required gate from the review/ namespace", () => {
    assert.equal(classifyAuditedContext("gate/ally-comment-findings"), "required-gate");
    assert.equal(classifyAuditedContext("  Gate/Ally-Comment-Findings "), "required-gate");
    assert.equal(classifyAuditedContext("review/ally-comment"), "review-namespace");
    assert.equal(classifyAuditedContext("review/ally-complete"), "review-namespace");
  });

  it("falls back to unclassified rather than to silence", () => {
    assert.equal(classifyAuditedContext("verify"), "unclassified");
    assert.equal(classifyAuditedContext("reviewer/ally"), "unclassified");
    assert.equal(classifyAuditedContext(undefined), "unclassified");
  });

  it("honours an operator-supplied gate context set", () => {
    const contexts = parseGateContexts("gate/renamed-findings");
    assert.equal(classifyAuditedContext("gate/renamed-findings", contexts), "required-gate");
    // The old name is not silently retained; it degrades to the tripwire bucket.
    assert.equal(classifyAuditedContext("gate/ally-comment-findings", contexts), "unclassified");
  });
});

describe("parseGateContexts", () => {
  it("defaults to the pinned live context when unset or blank", () => {
    for (const raw of [undefined, null, "", "   ", ",, ,"]) {
      assert.deepEqual([...parseGateContexts(raw)], ["gate/ally-comment-findings"]);
    }
  });

  it("parses, trims and lowercases a comma-separated override", () => {
    assert.deepEqual(
      [...parseGateContexts(" Gate/One , gate/two ")],
      ["gate/one", "gate/two"],
    );
  });
});

describe("violationsBySurface", () => {
  // The reason this exists rather than a single total: on today's deployment
  // every not-evaluated PR emits BOTH rows, so summing the buckets reports
  // twice as many PRs in trouble as there are.
  it("counts PRs per surface without summing the mirror into the gate", () => {
    const rows = findViolations([
      pr([status(), status({ context: "gate/ally-comment-findings" })]),
      pr([status(), status({ context: "gate/ally-comment-findings" })], { number: 1390 }),
    ]);

    const bySurface = violationsBySurface(rows);
    assert.equal(rows.length, 4);
    assert.equal(violatingPrCount(rows), 2);
    assert.equal(bySurface.get("required-gate").prs.size, 2);
    assert.equal(bySurface.get("review-namespace").prs.size, 2);
  });

  it("is empty for an empty or missing list", () => {
    assert.equal(violationsBySurface([]).size, 0);
    assert.equal(violationsBySurface(undefined).size, 0);
  });
});

describe("summarizeViolations", () => {
  // The property the scheduled job depends on: the rename tripwire is readable
  // on its own, so the job can red on it WITHOUT redding on the known-open
  // PEN-5565 population and becoming a permanently-red auditor (PEN-2847).
  it("reports the rename bucket separately from the known-open populations", () => {
    const rows = findViolations([
      pr([status(), status({ context: "gate/ally-comment-findings" })]),
      pr([status({ context: "verify/ally-findings-v2" })], { number: 1390 }),
    ]);

    const summary = summarizeViolations(rows, 12);
    assert.equal(summary.prsExamined, 12);
    assert.equal(summary.violatingPrs, 2);
    assert.equal(summary.surfaces["required-gate"].prs, 1);
    assert.equal(summary.surfaces["review-namespace"].prs, 1);
    assert.equal(summary.unclassifiedPrs, 1);
  });

  it("reports zero rename instances when every context is recognized", () => {
    const rows = findViolations([pr([status(), status({ context: "gate/ally-comment-findings" })])]);

    assert.equal(summarizeViolations(rows, 12).unclassifiedPrs, 0);
  });

  it("is well-formed for a clean census", () => {
    const summary = summarizeViolations([], 60);
    assert.deepEqual(summary, { prsExamined: 60, violatingPrs: 0, surfaces: {}, unclassifiedPrs: 0 });
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

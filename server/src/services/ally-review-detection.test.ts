import { describe, expect, it } from "vitest";
import {
  classifyPriorDisposition,
  extractAllyPriorFindingDispositions,
  extractAllyReviewedHeadSha,
  hasActionablePrReviewFeedback,
  hasAllyConsolidatedReviewHeading,
} from "./ally-review-detection.js";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

const body = (attest: string, extra = "") =>
  `## Ally — Consolidated PR Review
${attest}
### Critical Issues (0)
### Important Issues (0)
${extra}
### Recommended Action
Land.`;

describe("extractAllyReviewedHeadSha", () => {
  it("accepts the plain form", () => {
    expect(extractAllyReviewedHeadSha(body(`Reviewed head: ${SHA}`))).toBe(SHA);
  });

  it("accepts single emphasis or backtick wrappers", () => {
    expect(extractAllyReviewedHeadSha(body(`Reviewed head: \`${SHA}\``))).toBe(SHA);
    expect(extractAllyReviewedHeadSha(body(`_Reviewed head: ${SHA}_`))).toBe(SHA);
    expect(extractAllyReviewedHeadSha(body(`**Reviewed head: ${SHA}**`))).toBe(SHA);
  });

  // The gap this suite was written to close, and the reason it is stated here
  // rather than in the module: the plan for this task attributed the failure to
  // the backtick, but a backticked SHA already parsed. What failed was an
  // emphasis run and whitespace *both* sitting between the label and the SHA
  // ("**Reviewed head:** `<sha>`"), because only one emphasis run was allowed
  // there and it could not be followed by a space. Keep the two cases separate
  // so a future narrowing of the wrapper class fails loudly on the right one.
  it("accepts an emphasised label followed by whitespace and a wrapped SHA", () => {
    expect(extractAllyReviewedHeadSha(body(`**Reviewed head:** \`${SHA}\``))).toBe(SHA);
    expect(extractAllyReviewedHeadSha(body(`**Reviewed head:** ${SHA}`))).toBe(SHA);
    expect(extractAllyReviewedHeadSha(body(`_Reviewed head:_ \`${SHA}\``))).toBe(SHA);
  });

  // REGRESSION (CTO review of 539864f). Matching emphasis and whitespace as one
  // bounded run is what admits the case above, but a bound of six also *removes*
  // three forms the pre-widening pattern accepted, because ordinary space runs
  // are no longer matched by an unbounded `[ \t]*`. That is a narrowing wearing a
  // widening's clothes, and here it fails open — an attestation that stops
  // parsing makes a real review invisible, which is the BLO-31730 bug class. The
  // fix keeps the bounded wrapper and restores the unbounded whitespace runs on
  // either side of it; these three cases are what hold that fix in place, so do
  // not fold them into the case above.
  it("accepts whitespace runs longer than the wrapper bound", () => {
    expect(extractAllyReviewedHeadSha(body(`Reviewed head:${" ".repeat(7)}${SHA}`))).toBe(SHA);
    expect(extractAllyReviewedHeadSha(body(`Reviewed head:${" ".repeat(30)}${SHA}`))).toBe(SHA);
    expect(extractAllyReviewedHeadSha(body(`Reviewed head: ${SHA}${" ".repeat(9)}`))).toBe(SHA);
  });

  it("lowercases", () => {
    expect(extractAllyReviewedHeadSha(body(`Reviewed head: ${SHA.toUpperCase()}`))).toBe(SHA);
  });

  it("returns null for two attestations, a 39-hex, or none", () => {
    expect(
      extractAllyReviewedHeadSha(
        body(`Reviewed head: ${SHA}
Reviewed head: ${OTHER}`),
      ),
    ).toBeNull();
    expect(extractAllyReviewedHeadSha(body(`Reviewed head: ${SHA.slice(1)}`))).toBeNull();
    expect(extractAllyReviewedHeadSha(body(""))).toBeNull();
    expect(extractAllyReviewedHeadSha(null)).toBeNull();
  });

  // The wrapper class is bounded and the line anchored on both ends, so
  // widening it must not turn a prose mention or an indented code block into an
  // attestation. These are the controls for that.
  it("still requires a standalone, non-code attestation line", () => {
    expect(extractAllyReviewedHeadSha(body(`Reviewed head: ${SHA} (stale)`))).toBeNull();
    expect(extractAllyReviewedHeadSha(body(`see Reviewed head: ${SHA}`))).toBeNull();
    expect(extractAllyReviewedHeadSha(body(`    Reviewed head: ${SHA}`))).toBeNull();
    expect(extractAllyReviewedHeadSha(body(`\tReviewed head: ${SHA}`))).toBeNull();
    expect(extractAllyReviewedHeadSha(body(`Reviewed head: ${SHA}a`))).toBeNull();
  });

  it("does not read a SHA quoted inside a request comment", () => {
    const quoted = `Please re-review.
> ## Ally — Consolidated PR Review
> Reviewed head: ${SHA}`;
    expect(hasAllyConsolidatedReviewHeading(quoted)).toBe(false);
    // A quoted line starts with ">" and never matches the attestation start anchor.
    expect(extractAllyReviewedHeadSha(quoted)).toBeNull();
  });
});

describe("hasActionablePrReviewFeedback", () => {
  it("is false for (0) sections and true for Important (1)", () => {
    expect(hasActionablePrReviewFeedback(body(`Reviewed head: ${SHA}`))).toBe(false);
    expect(
      hasActionablePrReviewFeedback(
        body(`Reviewed head: ${SHA}`).replace("Important Issues (0)", "Important Issues (1)"),
      ),
    ).toBe(true);
  });

  it("is true for a changes_requested review state regardless of body", () => {
    expect(hasActionablePrReviewFeedback("looks fine", "CHANGES_REQUESTED")).toBe(true);
  });

  // BLO-34160. The last clause of carriesBlockingFeedback() matches Recommended
  // Action prose and has no negation guard, so a review that transcribes the
  // directive boilerplate reds gate/ally-comment-findings with no finding for
  // the author to dispose of. Measured on paperclip#1859 @3326c2da (boilerplate
  // -> failure) vs #1861 @fa7cfa93 (clean form -> success), identical 0/0
  // counts. The reviewer template is the half that was fixed; the three cases
  // below pin the contract it must keep satisfying.
  //
  // Every fixture here is deliberately BUCKETLESS. Counted buckets make these
  // assertions merge-order-dependent: BLO-31446's fix (#1657) lets an explicit
  // Critical(0) + Important(0) short-circuit before the prose clause is ever
  // reached, so an all-zero body returns `false` there whatever its Recommended
  // Action says. Measured against both modules: with buckets, every input below
  // flips (or goes vacuous) across #1657; without buckets, every one is
  // identical on both. So a bucketless body is the only fixture that keeps the
  // prose clause reachable -- and reachable is what these tests exist to pin.
  // The 0/0 precedence itself belongs in #1657, and its sibling assertion
  // `keeps the prose fallback live when no bucket is declared`
  // (server/src/__tests__/pr-comment-review-gate.test.ts) covers it from the
  // gate side; keep both, they are in different files on purpose.
  const proseOnly = (recommendedAction: string) =>
    `## Ally — Consolidated PR Review
Reviewed head: ${SHA}

### Recommended Action
${recommendedAction}`;

  it("does not block a review whose Recommended Action is count-derived", () => {
    expect(
      hasActionablePrReviewFeedback(
        proseOnly(
          "1. No blocking changes requested.\n2. Merge once the remaining required CI checks finish green.",
        ),
      ),
    ).toBe(false);
  });

  it("still blocks a review that transcribes the directive boilerplate", () => {
    // Guards against "fixing" BLO-34160 by deleting the prose clause: a body
    // that narrates a blocking action must keep failing closed, per the
    // fail-safe documented on hasActionablePrReviewFeedback.
    expect(
      hasActionablePrReviewFeedback(
        proseOnly("1. Fix Critical issues before merge.\n2. Address Important issues this cycle."),
      ),
    ).toBe(true);
  });

  // CHARACTERIZATION, not desired behaviour. The clause is a bare
  // `Recommended Action ... \bfix\b ... before merg` window with no negation
  // guard, so a review that says it found nothing still blocks -- the same
  // false RED as BLO-34160, reached through prose instead of through the
  // template. `No fixes required` escapes only because `\bfix\b` does not match
  // "fixes"; that is the entire width of the boundary, and it is written down
  // nowhere else.
  //
  // Two measured notes for whoever closes it, because the obvious fix is a
  // no-op. Wrapping the clause in hasNonNegatedMatch() changes NOTHING here:
  // the match begins at "Recommended Action", and the lookback only inspects
  // the words BEFORE the match start, so the negation -- which sits inside the
  // matched window -- is never seen. Re-anchoring the match at `\bfix\b`
  // instead does flip three of these four to false, but not "Nothing to fix
  // before merge.", because NEGATION_CUE_REGEX has no "nothing" cue. Both
  // measured by mutating carriesBlockingFeedback() against these cases.
  const nearMisses: [action: string, blocks: boolean][] = [
    ["Nothing to fix before merge.", true],
    ["No Critical issues to fix before merging.", true],
    ["No blocking changes to fix before merge.", true],
    ["No Critical or Important issues — nothing to fix before merge.", true],
    ["No fixes required before merge.", false],
  ];
  it.each(nearMisses)("negated near-miss %j blocks: %s", (action, blocks) => {
    expect(hasActionablePrReviewFeedback(proseOnly(action))).toBe(blocks);
  });
});

describe("prior-finding dispositions", () => {
  it("classifies still-present as blocks and fixed as retires", () => {
    expect(classifyPriorDisposition("still-present")).toBe("blocks");
    expect(classifyPriorDisposition("fixed")).toBe("retires");
    expect(classifyPriorDisposition("no-longer-applicable")).toBe("retires");
    expect(classifyPriorDisposition("maybe")).toBe("unrecognized");
  });

  it("extracts a blocks entry from the ledger", () => {
    const ledger = `### Prior Findings Dispositioned
- **prior:${OTHER.slice(0, 7)} important 1** — still-present — the null check is still missing`;
    const entries = extractAllyPriorFindingDispositions(body(`Reviewed head: ${SHA}`, ledger));
    expect(entries.some((e) => e.kind === "blocks")).toBe(true);
  });
});

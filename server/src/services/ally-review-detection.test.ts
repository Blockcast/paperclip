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
  // Action prose and has no negation guard, so an all-zero review that
  // transcribes the directive boilerplate reds gate/ally-comment-findings with
  // no finding for the author to dispose of. Measured on paperclip#1859
  // @3326c2da (boilerplate -> failure) vs #1861 @fa7cfa93 (clean form ->
  // success), identical 0/0 counts. The reviewer template is the half that was
  // fixed; these pin the contract it must keep satisfying.
  it("does not block an all-zero review whose Recommended Action is count-derived", () => {
    const clean = body(`Reviewed head: ${SHA}`).replace(
      "Land.",
      "1. No blocking changes requested.\n2. Merge once the remaining required CI checks finish green.",
    );
    expect(hasActionablePrReviewFeedback(clean)).toBe(false);
  });

  it("still blocks an all-zero review that transcribes the directive boilerplate", () => {
    // Guards against "fixing" BLO-34160 by deleting the prose clause: a body
    // that narrates a blocking action while declaring (0) must keep failing
    // closed, per the fail-safe documented on hasActionablePrReviewFeedback.
    const boilerplate = body(`Reviewed head: ${SHA}`).replace(
      "Land.",
      "1. Fix Critical issues before merge.\n2. Address Important issues this cycle.",
    );
    expect(hasActionablePrReviewFeedback(boilerplate)).toBe(true);
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

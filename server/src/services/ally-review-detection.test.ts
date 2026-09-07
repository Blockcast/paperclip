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

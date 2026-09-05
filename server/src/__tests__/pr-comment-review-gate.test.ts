import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain-JS census script; imported for its own predicate so
// the retirement description is checked against the real thing, not a copy.
import { admitsNothingEvaluated } from "../../../scripts/check-comment-review-gate-census.mjs";

import { hasActionablePrReviewFeedback } from "../services/ally-review-detection.js";

import {
  extractAllyPriorFindingDispositions,
  extractAllyReportedFindingRefs,
  extractAllyReviewedHeadSha,
  hasActionablePrReviewFeedback,
  hasAllyConsolidatedReviewHeading,
} from "../services/ally-review-detection.js";
import {
  commentReviewGateRetirementDescription,
  commentReviewGateRetirementStatus,
  commentReviewGateVerdictIsMisreadable,
  evaluateCommentReviewGate,
  retiredCommentReviewGateContexts,
} from "../services/pr-comment-review-gate.js";

const OLD_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CURRENT_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const INTERMEDIATE_HEAD = "cccccccccccccccccccccccccccccccccccccccc";
const ALLY_BOT_LOGIN = "allyblockcast[bot]";

function reviewBody(headSha: string, lines: string[]): string {
  return ["## Ally — Consolidated PR Review", `Reviewed head: ${headSha}`, ...lines].join("\n");
}

function blockingReview(headSha: string): string {
  return reviewBody(headSha, [
    "### Critical Issues (0)",
    "### Important Issues (1)",
    "- The queue can merge this head before its review finding is resolved.",
    "### Recommended Action",
    "Fix the gate before merge.",
  ]);
}

function cleanReview(headSha: string): string {
  return reviewBody(headSha, ["### Critical Issues (0)", "### Important Issues (0)", "No findings."]);
}

function allyComment(body: string, createdAt: string) {
  return { authorLogin: ALLY_BOT_LOGIN, body, createdAt };
}

/**
 * A clean review that also carries a prior-findings ledger entry, in the shape
 * Ally emits: `- **prior:<short sha> <severity> <n>** — <verb> — <detail>`.
 */
function dispositioningReview(headSha: string, priorHeadSha: string, disposition: string): string {
  return reviewBody(headSha, [
    "### Prior Findings Dispositioned (1)",
    `- **prior:${priorHeadSha.slice(0, 7)} important 1** — ${disposition} — re-checked against this head.`,
    "### Critical Issues (0)",
    "### Important Issues (0)",
  ]);
}

describe("evaluateCommentReviewGate", () => {
  it("fails the #1022 shape: an Ally comment finding for the current head", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [allyComment(blockingReview(CURRENT_HEAD), "2026-08-04T20:09:19Z")],
    });

    expect(verdict.state).toBe("failure");
    if (verdict.state === "failure") {
      expect(verdict.commentCreatedAt).toBe("2026-08-04T20:09:19.000Z");
    }
  });

  it("lets a later clean review of the same head clear an earlier finding", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(blockingReview(CURRENT_HEAD), "2026-08-04T20:09:19Z"),
        allyComment(cleanReview(CURRENT_HEAD), "2026-08-04T21:09:19Z"),
      ],
    });

    expect(verdict).toMatchObject({ state: "success" });
  });

  it("carries an undispositioned finding forward across a replacement head", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [allyComment(blockingReview(OLD_HEAD), "2026-08-04T20:09:19Z")],
    });

    // Replacing the head does not disposition the finding, so the gate must not
    // go green on it (BLO-29711).
    expect(verdict).toMatchObject({ state: "failure", outcome: "carried_finding" });
    if (verdict.outcome === "carried_finding") {
      expect(verdict.carriedFromHeadSha).toBe(OLD_HEAD);
    }
  });

  it("clears a carried finding once Ally attests the replacement head", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(blockingReview(OLD_HEAD), "2026-08-04T20:09:19Z"),
        allyComment(cleanReview(CURRENT_HEAD), "2026-08-04T21:09:19Z"),
      ],
    });

    expect(verdict).toMatchObject({ state: "success", outcome: "clean" });
  });

  it("does not carry forward when the newest attestation of an earlier head is clean", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(blockingReview(OLD_HEAD), "2026-08-04T20:09:19Z"),
        allyComment(cleanReview(OLD_HEAD), "2026-08-04T21:09:19Z"),
      ],
    });

    expect(verdict).toMatchObject({ state: "success", outcome: "not_evaluated" });
  });

  it("keeps carrying a finding when the clean review attests a different head", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(blockingReview(OLD_HEAD), "2026-08-04T20:09:19Z"),
        allyComment(cleanReview(INTERMEDIATE_HEAD), "2026-08-04T21:09:19Z"),
      ],
    });

    // A(blocking) -> B(clean) -> C(unattested). B's clean review examined a
    // different tree, so it does not disposition A's finding: comment
    // chronology is not commit ancestry. Reading only the globally newest
    // attestation dropped A silently.
    expect(verdict).toMatchObject({ state: "failure", outcome: "carried_finding" });
    if (verdict.outcome === "carried_finding") {
      expect(verdict.carriedFromHeadSha).toBe(OLD_HEAD);
      expect(verdict.commentCreatedAt).toBe("2026-08-04T20:09:19.000Z");
    }
  });

  it("carries the newest of several undispositioned heads", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(blockingReview(OLD_HEAD), "2026-08-04T20:09:19Z"),
        allyComment(blockingReview(INTERMEDIATE_HEAD), "2026-08-04T21:09:19Z"),
      ],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "carried_finding" });
    if (verdict.outcome === "carried_finding") {
      expect(verdict.carriedFromHeadSha).toBe(INTERMEDIATE_HEAD);
    }
  });

  it("still clears when every attested head was re-reviewed clean", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(blockingReview(OLD_HEAD), "2026-08-04T20:09:19Z"),
        allyComment(blockingReview(INTERMEDIATE_HEAD), "2026-08-04T20:39:19Z"),
        allyComment(cleanReview(OLD_HEAD), "2026-08-04T21:09:19Z"),
        allyComment(cleanReview(INTERMEDIATE_HEAD), "2026-08-04T21:39:19Z"),
      ],
    });

    // Per-head disposition must not become a ratchet that no clean review can
    // release: each head's own newest attestation is clean here.
    expect(verdict).toMatchObject({ state: "success", outcome: "not_evaluated" });
  });

  it("lets a clean review of the current head disposition every earlier finding", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(blockingReview(OLD_HEAD), "2026-08-04T20:09:19Z"),
        allyComment(blockingReview(INTERMEDIATE_HEAD), "2026-08-04T20:39:19Z"),
        allyComment(cleanReview(CURRENT_HEAD), "2026-08-04T21:09:19Z"),
      ],
    });

    // Ally examined the exact tree being merged and found nothing. That is the
    // strongest evidence available, so it releases the carry.
    expect(verdict).toMatchObject({ state: "success", outcome: "clean" });
  });

  it("does not mistake a prior-head disposition ledger for a new finding", () => {
    // Shape taken from a real Ally re-review (PR #1441 @d7cdeb75): the body
    // dispositions earlier findings by head and severity while reporting zero
    // open issues. Counting those bullets as findings would make every
    // re-review permanently blocking.
    const body = reviewBody(CURRENT_HEAD, [
      `- **prior:${OLD_HEAD.slice(0, 7)} critical 1** — fixed — the terminator is gone.`,
      `- **prior:${OLD_HEAD.slice(0, 7)} important 1** — fixed — the assertion is back.`,
      "### Critical Issues (0)",
      "### Important Issues (0)",
    ]);

    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [allyComment(body, "2026-08-04T21:09:19Z")],
    });

    expect(verdict).toMatchObject({ state: "success", outcome: "clean" });
  });

  it("lets a later review's ledger disposition a finding from a head it replaced", () => {
    // The Blockcast/libmmt#362 shape. Ally found a Critical on OLD_HEAD, the
    // author fixed it, Ally reviewed INTERMEDIATE_HEAD clean and recorded
    // `prior:<old> — fixed`, then the author pushed once more. Ally's ledger is
    // a direct assertion that it re-checked that finding, which is exactly the
    // evidence a merely-clean review of an unrelated head lacks. Without this,
    // #362 sat red on a finding its own reviewer had already closed.
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(blockingReview(OLD_HEAD), "2026-08-04T20:09:19Z"),
        allyComment(dispositioningReview(INTERMEDIATE_HEAD, OLD_HEAD, "fixed"), "2026-08-04T21:09:19Z"),
      ],
    });

    expect(verdict).toMatchObject({ state: "success", outcome: "not_evaluated" });
  });

  it("does not let a still-present disposition clear the finding it reports", () => {
    // `still-present` asserts the opposite of `fixed`; the sibling consistency
    // guard treats it as a blocking verdict (I2c). Reading the ledger without
    // reading the verb would invert its meaning.
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(blockingReview(OLD_HEAD), "2026-08-04T20:09:19Z"),
        allyComment(
          dispositioningReview(INTERMEDIATE_HEAD, OLD_HEAD, "still-present"),
          "2026-08-04T21:09:19Z",
        ),
      ],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "carried_finding" });
    if (verdict.outcome === "carried_finding") {
      expect(verdict.carriedFromHeadSha).toBe(OLD_HEAD);
    }
  });

  it("does not let an unrecognized disposition verb clear a finding", () => {
    // Fail closed on vocabulary we have not seen: a new word in Ally's ledger
    // must not silently unblock a merge before anyone decides that it should.
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(blockingReview(OLD_HEAD), "2026-08-04T20:09:19Z"),
        allyComment(
          dispositioningReview(INTERMEDIATE_HEAD, OLD_HEAD, "acknowledged"),
          "2026-08-04T21:09:19Z",
        ),
      ],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "carried_finding" });
  });

  it("does not let a ledger entry disposition a finding raised after it", () => {
    // Ally re-raising a finding on a head it previously cleared is the newer
    // fact. A ledger entry can only speak to findings that existed when it was
    // written.
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(dispositioningReview(INTERMEDIATE_HEAD, OLD_HEAD, "fixed"), "2026-08-04T20:09:19Z"),
        allyComment(blockingReview(OLD_HEAD), "2026-08-04T21:09:19Z"),
      ],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "carried_finding" });
    if (verdict.outcome === "carried_finding") {
      expect(verdict.carriedFromHeadSha).toBe(OLD_HEAD);
    }
  });

  it("matches the ledger's abbreviated SHA as a prefix, not a substring", () => {
    // SUFFIX_MATCH_HEAD contains `d4d4d4d` seven characters in. Matching the
    // abbreviated SHA anywhere in the head would clear a finding the ledger
    // never named — git abbreviations identify a commit by its leading
    // characters, so only a prefix match means "this commit".
    const suffixMatchHead = `eeeeeee${"d4d4d4d"}${"f".repeat(26)}`;

    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(blockingReview(suffixMatchHead), "2026-08-04T20:09:19Z"),
        allyComment(
          dispositioningReview(INTERMEDIATE_HEAD, "d4d4d4d4d4d4d4d4", "fixed"),
          "2026-08-04T21:09:19Z",
        ),
      ],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "carried_finding" });
    if (verdict.outcome === "carried_finding") {
      expect(verdict.carriedFromHeadSha).toBe(suffixMatchHead);
    }
  });

  it("keeps a head carried when its ledger retires only some of its findings", () => {
    // A head can raise several findings, and Ally numbers them within their
    // severity bucket. Matching the ledger on the head alone would let a single
    // `fixed` entry clear all of them, dropping an unresolved Important finding
    // out of a merge gate.
    const twoFindings = reviewBody(OLD_HEAD, [
      "### Critical Issues (1)",
      "- The terminator is missing.",
      "### Important Issues (1)",
      "- The assertion was deleted.",
    ]);
    const partialLedger = reviewBody(INTERMEDIATE_HEAD, [
      "### Prior Findings Dispositioned (1)",
      `- **prior:${OLD_HEAD.slice(0, 7)} critical 1** — fixed — the terminator is back.`,
      "### Critical Issues (0)",
      "### Important Issues (0)",
    ]);

    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(twoFindings, "2026-08-04T20:09:19Z"),
        allyComment(partialLedger, "2026-08-04T21:09:19Z"),
      ],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "carried_finding" });
    if (verdict.outcome === "carried_finding") {
      expect(verdict.carriedFromHeadSha).toBe(OLD_HEAD);
    }
  });

  it("clears a head once its ledger retires every finding it raised", () => {
    const twoFindings = reviewBody(OLD_HEAD, [
      "### Critical Issues (1)",
      "- The terminator is missing.",
      "### Important Issues (1)",
      "- The assertion was deleted.",
    ]);
    const fullLedger = reviewBody(INTERMEDIATE_HEAD, [
      "### Prior Findings Dispositioned (2)",
      `- **prior:${OLD_HEAD.slice(0, 7)} critical 1** — fixed — the terminator is back.`,
      `- **prior:${OLD_HEAD.slice(0, 7)} important 1** — fixed — the assertion is back.`,
      "### Critical Issues (0)",
      "### Important Issues (0)",
    ]);

    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(twoFindings, "2026-08-04T20:09:19Z"),
        allyComment(fullLedger, "2026-08-04T21:09:19Z"),
      ],
    });

    expect(verdict).toMatchObject({ state: "success", outcome: "not_evaluated" });
  });

  it("does not disposition a head whose findings cannot be enumerated", () => {
    // Blocking feedback from prose rather than a counted bucket yields no
    // finding identities for a ledger to name, so the head stays carried
    // rather than being cleared by an unrelated entry.
    const uncounted = reviewBody(OLD_HEAD, [
      "### Recommended Action",
      "Fix the gate before merge.",
    ]);
    const ledger = reviewBody(INTERMEDIATE_HEAD, [
      "### Prior Findings Dispositioned (1)",
      `- **prior:${OLD_HEAD.slice(0, 7)} critical 1** — fixed — re-checked.`,
      "### Critical Issues (0)",
      "### Important Issues (0)",
    ]);

    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(uncounted, "2026-08-04T20:09:19Z"),
        allyComment(ledger, "2026-08-04T21:09:19Z"),
      ],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "carried_finding" });
  });

  it("retires a prior finding marked no-longer-applicable", () => {
    // The third verb in Ally's vocabulary: the finding does not apply to this
    // code, often because it was incorrect as filed. It retires without
    // implying anything changed. Observed in Blockcast/onprem-k8s#2881,
    // Blockcast/paperclip#1126 and Blockcast/go-amt#93.
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(blockingReview(OLD_HEAD), "2026-08-04T20:09:19Z"),
        allyComment(
          dispositioningReview(INTERMEDIATE_HEAD, OLD_HEAD, "no-longer-applicable"),
          "2026-08-04T21:09:19Z",
        ),
      ],
    });

    expect(verdict).toMatchObject({ state: "success", outcome: "not_evaluated" });
  });

  it("keeps unrelated findings when no-longer-applicable retires only one", () => {
    // The retiring verbs must stay per-finding. `no-longer-applicable` gets the
    // same identity matching as `fixed`, so it cannot clear a sibling finding
    // the ledger never named.
    const twoFindings = reviewBody(OLD_HEAD, [
      "### Critical Issues (1)",
      "- The selector is inverted.",
      "### Important Issues (1)",
      "- The assertion was deleted.",
    ]);
    const partialLedger = reviewBody(INTERMEDIATE_HEAD, [
      "### Prior Findings Dispositioned (1)",
      `- **prior:${OLD_HEAD.slice(0, 7)} critical 1** — no-longer-applicable — the policy does not select that target.`,
      "### Critical Issues (0)",
      "### Important Issues (0)",
    ]);

    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(twoFindings, "2026-08-04T20:09:19Z"),
        allyComment(partialLedger, "2026-08-04T21:09:19Z"),
      ],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "carried_finding" });
    if (verdict.outcome === "carried_finding") {
      expect(verdict.carriedFromHeadSha).toBe(OLD_HEAD);
    }
  });

  it("names the unrecognized verb that left a finding unretired", () => {
    // Failing closed on an unknown verb is correct, but the ordinary reason
    // says the finding is "undispositioned" while Ally's ledger visibly
    // dispositions it — leaving a reader no way to tell vocabulary drift from
    // a genuinely open finding. The missing `no-longer-applicable` verb was
    // expensive to diagnose for exactly this reason.
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(blockingReview(OLD_HEAD), "2026-08-04T20:09:19Z"),
        allyComment(dispositioningReview(INTERMEDIATE_HEAD, OLD_HEAD, "deferred"), "2026-08-04T21:09:19Z"),
      ],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "carried_finding" });
    expect(verdict.reason).toContain('unrecognized ledger verb "deferred"');
    expect(verdict.reason).toContain(OLD_HEAD.slice(0, 7));
  });

  it("keeps the ordinary reason when no unrecognized verb is involved", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [allyComment(blockingReview(OLD_HEAD), "2026-08-04T20:09:19Z")],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "carried_finding" });
    expect(verdict.reason).toContain("is still undispositioned");
    expect(verdict.reason).not.toContain("unrecognized");
  });

  it("does not blame an unrecognized verb for a finding it never named", () => {
    // `still-present` is a known verb, and the head is also held by a second,
    // unmentioned finding. Neither is vocabulary drift, so the diagnostic must
    // stay quiet rather than attach itself to any unretired finding it can see.
    const twoFindings = reviewBody(OLD_HEAD, [
      "### Critical Issues (1)",
      "- The terminator is missing.",
      "### Important Issues (1)",
      "- The assertion was deleted.",
    ]);
    const ledger = reviewBody(INTERMEDIATE_HEAD, [
      "### Prior Findings Dispositioned (1)",
      `- **prior:${OLD_HEAD.slice(0, 7)} critical 1** — still-present — the terminator is still gone.`,
      "### Critical Issues (0)",
      "### Important Issues (0)",
    ]);

    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [allyComment(twoFindings, "2026-08-04T20:09:19Z"), allyComment(ledger, "2026-08-04T21:09:19Z")],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "carried_finding" });
    expect(verdict.reason).not.toContain("unrecognized");
  });

  it("keeps every carried reason inside GitHub's 140-character status cap", () => {
    // The reason becomes the commit-status description, which GitHub truncates
    // at 140 characters. A diagnostic that gets cut off is the failure this
    // branch exists to fix, so pin the budget with a maximal verb.
    const longVerb = "superseded-by-a-later-architectural-decision-recorded-elsewhere";
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(blockingReview(OLD_HEAD), "2026-08-04T20:09:19Z"),
        allyComment(dispositioningReview(INTERMEDIATE_HEAD, OLD_HEAD, longVerb), "2026-08-04T21:09:19Z"),
      ],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "carried_finding" });
    expect(verdict.reason.length).toBeLessThanOrEqual(140);
    // Truncating the verb must not cost the reader the head it applies to.
    expect(verdict.reason).toContain(OLD_HEAD.slice(0, 7));
  });

  it("does not blame an unrecognized verb that names a finding this head never raised", () => {
    // `blockingReview` reports Important (1) and Critical (0), so the ledger's
    // `critical 1` entry corresponds to no finding here. The head is carried
    // because of the Important finding, which the ledger never mentions — so
    // the unknown verb is not the reason and must not be offered as one.
    const ledger = reviewBody(INTERMEDIATE_HEAD, [
      "### Prior Findings Dispositioned (1)",
      `- **prior:${OLD_HEAD.slice(0, 7)} critical 1** — deferred — names a finding this head never raised.`,
      "### Critical Issues (0)",
      "### Important Issues (0)",
    ]);

    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(blockingReview(OLD_HEAD), "2026-08-04T20:09:19Z"),
        allyComment(ledger, "2026-08-04T21:09:19Z"),
      ],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "carried_finding" });
    expect(verdict.reason).not.toContain("unrecognized");
  });

  it("prefers an explicit still-present over an unrecognized verb for the same finding", () => {
    // Two later reviews disposition the same finding differently: one says it
    // still stands, one uses a verb this parser does not know. `still-present`
    // is an explicit answer, so it is the real reason the head is blocked.
    // Naming the unknown verb here would blame vocabulary drift for a finding
    // Ally deliberately left open — a wrong explanation, which is worse than
    // the bare one this diagnostic replaces.
    const stillPresent = reviewBody(INTERMEDIATE_HEAD, [
      "### Prior Findings Dispositioned (1)",
      `- **prior:${OLD_HEAD.slice(0, 7)} important 1** — still-present — the assertion is still missing.`,
      "### Critical Issues (0)",
      "### Important Issues (0)",
    ]);
    const unknownVerb = reviewBody("d".repeat(40), [
      "### Prior Findings Dispositioned (1)",
      `- **prior:${OLD_HEAD.slice(0, 7)} important 1** — deferred — revisit next cycle.`,
      "### Critical Issues (0)",
      "### Important Issues (0)",
    ]);

    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(blockingReview(OLD_HEAD), "2026-08-04T20:09:19Z"),
        allyComment(stillPresent, "2026-08-04T21:09:19Z"),
        allyComment(unknownVerb, "2026-08-04T22:09:19Z"),
      ],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "carried_finding" });
    expect(verdict.reason).not.toContain("unrecognized");
    expect(verdict.reason).not.toContain("deferred");
  });

  it("reports not_evaluated rather than clean when nothing attests the head", () => {
    const verdict = evaluateCommentReviewGate({ headSha: CURRENT_HEAD, comments: [] });

    // A green status must not be mistakable for review evidence. Under a
    // review/-prefixed context that reading is false (BLO-29711).
    expect(verdict).toMatchObject({ state: "success", outcome: "not_evaluated" });
    expect(commentReviewGateVerdictIsMisreadable(verdict, "review/ally-comment")).toBe(true);
    expect(commentReviewGateVerdictIsMisreadable(verdict, "gate/ally-comment-findings")).toBe(false);
  });

  it("distinguishes a reviewed-and-clean head from a not-evaluated one", () => {
    const clean = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [allyComment(cleanReview(CURRENT_HEAD), "2026-08-04T21:09:19Z")],
    });

    expect(clean).toMatchObject({ state: "success", outcome: "clean" });
    expect(commentReviewGateVerdictIsMisreadable(clean, "review/ally-comment")).toBe(false);
  });

  it("requires the configured GitHub App identity, not a same-shaped contributor comment", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        {
          authorLogin: "allyblockcast",
          body: blockingReview(CURRENT_HEAD),
          createdAt: "2026-08-04T20:09:19Z",
        },
      ],
    });

    expect(verdict).toMatchObject({ state: "success", outcome: "not_evaluated" });
  });

  it("requires one unambiguous exact-head attestation", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(
          [
            "## Ally — Consolidated PR Review",
            `Reviewed head: ${CURRENT_HEAD}`,
            `Reviewed head: ${OLD_HEAD}`,
            "### Important Issues (1)",
          ].join("\n"),
          "2026-08-04T20:09:19Z",
        ),
      ],
    });

    // An ambiguous attestation cannot be tied to any head, so it neither
    // establishes a review nor carries forward.
    expect(verdict).toMatchObject({ state: "success", outcome: "not_evaluated" });
  });

  it("uses comment chronology rather than contributor-controlled commit metadata", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [allyComment(blockingReview(CURRENT_HEAD), "2020-01-01T00:00:00Z")],
    });

    expect(verdict).toMatchObject({ state: "failure" });
  });
});

/**
 * Quoting a review must never be mistaken for emitting one.
 *
 * The gate's only identity check is the author login, and every agent in the
 * fleet comments as that same App. So before this suite existed, an agent
 * pasting the review it was replying to published a merge-visible verdict
 * about a head nothing had examined — in both directions.
 */
describe("evaluateCommentReviewGate — quoted review bodies", () => {
  const fenced = (body: string, info = ""): string =>
    ["Quoting the review I am replying to:", "", `\`\`\`${info}`, body, "```", "", "Nothing addressed yet."].join("\n");

  it("does not let a fenced paste of a clean review attest the head", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [allyComment(fenced(cleanReview(CURRENT_HEAD)), "2026-09-05T00:00:00Z")],
    });

    // Not merely "not clean": `clean` is the one outcome that asserts positive
    // evidence of review, which is exactly what a quote is not.
    expect(verdict).toMatchObject({ state: "success", outcome: "not_evaluated" });
  });

  it("does not let a fenced paste of a finding redden a head Ally never reviewed", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [allyComment(fenced(blockingReview(CURRENT_HEAD), "markdown"), "2026-09-05T00:00:00Z")],
    });

    expect(verdict).toMatchObject({ state: "success", outcome: "not_evaluated" });
  });

  it("does not let a quoted ledger entry retire a live finding", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(blockingReview(OLD_HEAD), "2026-09-05T00:00:00Z"),
        allyComment(fenced(dispositioningReview(CURRENT_HEAD, OLD_HEAD, "fixed")), "2026-09-05T01:00:00Z"),
      ],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "carried_finding" });
  });

  it("still reads a genuine review that itself contains a fenced code block", () => {
    const withSuggestion = reviewBody(CURRENT_HEAD, [
      "### Critical Issues (0)",
      "### Important Issues (1)",
      "- Prefer the guarded form:",
      "```ts",
      "if (!ok) return;",
      "```",
      "### Recommended Action",
      "Fix the guard before merge.",
    ]);

    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [allyComment(withSuggestion, "2026-09-05T00:00:00Z")],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "blocking_finding" });
  });

  it("keeps a finding visible when an unbalanced fence would blank the rest of the body", () => {
    // Fail-closed guard: hasActionablePrReviewFeedback reads the raw body too,
    // so a malformed fence cannot silently clear a PR.
    const unbalanced = reviewBody(CURRENT_HEAD, [
      "### Critical Issues (0)",
      "```ts",
      "const oops = true;",
      "### Important Issues (1)",
      "- The unterminated fence above swallows this line when rendered.",
    ]);

    expect(hasActionablePrReviewFeedback(unbalanced)).toBe(true);
  });

  /**
   * The unit assertion above passes while the gate still goes green, because
   * detecting a finding and enumerating which findings exist are separate
   * predicates. Enumerating from fence-stripped text alone dropped the bucket
   * that followed an unbalanced fence, so retiring the surviving one retired
   * the whole head — a silent green with a live finding on it.
   */
  it("does not drop a finding bucket that an unbalanced fence swallows", () => {
    const swallowed = reviewBody(OLD_HEAD, [
      "### Critical Issues (1)",
      "- **[code]** the terminator is missing.",
      "```ts",
      "const unterminated = true;",
      "### Important Issues (1)",
      "- **[code]** this bucket follows the unbalanced fence.",
    ]);

    // Both buckets are enumerated, so a ledger must name both to retire the head.
    expect(extractAllyReportedFindingRefs(swallowed)).toEqual([
      { severity: "critical", index: 1 },
      { severity: "important", index: 1 },
    ]);

    const retiresOnlyTheFirst = reviewBody(INTERMEDIATE_HEAD, [
      "### Prior Findings Dispositioned (1)",
      `- **prior:${OLD_HEAD.slice(0, 7)} critical 1** — fixed — the terminator is back.`,
      "### Critical Issues (0)",
      "### Important Issues (0)",
    ]);

    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(swallowed, "2026-09-05T00:00:00Z"),
        allyComment(retiresOnlyTheFirst, "2026-09-05T01:00:00Z"),
      ],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "carried_finding" });
  });

  it("does not let a 4-space-indented ledger entry retire a live finding", () => {
    // Indentation is the other way to quote a ledger, and stripping fenced
    // spans alone left it readable as emitted structure.
    const quotesLedgerByIndent = reviewBody(CURRENT_HEAD, [
      "The earlier review's ledger read:",
      "",
      `    - **prior:${OLD_HEAD.slice(0, 7)} important 1** — fixed — re-checked.`,
      "",
      "### Critical Issues (0)",
      "### Important Issues (0)",
    ]);

    expect(extractAllyPriorFindingDispositions(quotesLedgerByIndent)).toEqual([]);

    const verdict = evaluateCommentReviewGate({
      headSha: INTERMEDIATE_HEAD,
      comments: [
        allyComment(blockingReview(OLD_HEAD), "2026-09-05T00:00:00Z"),
        allyComment(quotesLedgerByIndent, "2026-09-05T01:00:00Z"),
      ],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "carried_finding" });
  });

  it("still reads the unindented ledger entry Ally actually emits", () => {
    // The guard above must not cost a real retirement: every ledger entry in
    // the sampled corpus is unindented.
    expect(
      extractAllyPriorFindingDispositions(dispositioningReview(CURRENT_HEAD, OLD_HEAD, "fixed")),
    ).toMatchObject([{ shortSha: OLD_HEAD.slice(0, 7), disposition: "fixed", kind: "retires" }]);
  });

  it("ignores a 4-space-indented paste, which the heading and attestation once disagreed about", () => {
    const indented = [
      "For reference, the earlier review said:",
      "",
      "    ## Ally — Consolidated PR Review",
      `    Reviewed head: ${CURRENT_HEAD}`,
      "    ### Critical Issues (0)",
      "    ### Important Issues (0)",
    ].join("\n");

    expect(extractAllyReviewedHeadSha(indented)).toBeNull();
    expect(
      evaluateCommentReviewGate({
        headSha: CURRENT_HEAD,
        comments: [allyComment(indented, "2026-09-05T00:00:00Z")],
      }),
    ).toMatchObject({ state: "success", outcome: "not_evaluated" });
  });
});

/**
 * Ally wraps the attested SHA in whatever emphasis it happens to choose. The
 * suite previously built every fixture with a bare SHA, so it asserted the
 * parser correct only on the one shape it already handled (BLO-31730).
 */
describe("extractAllyReviewedHeadSha — attestation delimiters", () => {
  // Verbatim from paperclip#1637's `cce8d6b0` review, the review whose
  // invisibility carried a resolved finding forward against a dead head.
  it("parses the backticked form that made a real review invisible", () => {
    expect(
      extractAllyReviewedHeadSha(
        ["## Ally — Consolidated PR Review", `Reviewed head: \`${CURRENT_HEAD}\``, ""].join("\n"),
      ),
    ).toBe(CURRENT_HEAD);
  });

  it.each([
    ["bare", `Reviewed head: ${CURRENT_HEAD}`],
    ["backticked sha", `Reviewed head: \`${CURRENT_HEAD}\``],
    ["bold sha", `Reviewed head: **${CURRENT_HEAD}**`],
    ["bold and backticked", `Reviewed head: **\`${CURRENT_HEAD}\`**`],
    ["italicized line", `_Reviewed head: ${CURRENT_HEAD}_`],
  ])("accepts the %s attestation", (_label, line) => {
    expect(extractAllyReviewedHeadSha(`## Ally — Consolidated PR Review\n${line}\n`)).toBe(CURRENT_HEAD);
  });

  it("preserves the ambiguity guard that keeps a check from being set on a guess", () => {
    expect(
      extractAllyReviewedHeadSha(
        [`Reviewed head: \`${CURRENT_HEAD}\``, `Reviewed head: **${OLD_HEAD}**`].join("\n"),
      ),
    ).toBeNull();
    expect(extractAllyReviewedHeadSha("## Ally — Consolidated PR Review\nno attestation\n")).toBeNull();
  });

  it("does not treat a mid-line prose mention as an attestation", () => {
    expect(extractAllyReviewedHeadSha(`The status says Reviewed head: ${CURRENT_HEAD} which is stale.`)).toBeNull();
  });

  it("does not treat a fenced SHA as an attestation", () => {
    expect(
      extractAllyReviewedHeadSha(["```", `Reviewed head: ${CURRENT_HEAD}`, "```"].join("\n")),
    ).toBeNull();
  });

  /**
   * A tab advances to the next four-column stop, so it starts an indented code
   * block however few spaces precede it. The heading pattern already rejected
   * this shape; the attestation accepted it, which is the same two-parsers
   * disagreement in miniature.
   */
  it.each([
    ["four spaces", "    "],
    ["a tab", "\t"],
    ["spaces then a tab", "   \t"],
  ])("rejects an attestation indented by %s", (_label, indent) => {
    expect(extractAllyReviewedHeadSha(`context\n${indent}Reviewed head: ${CURRENT_HEAD}\n`)).toBeNull();
  });

  it("still accepts the up-to-three-space indentation Markdown treats as a paragraph", () => {
    expect(extractAllyReviewedHeadSha(`context\n   Reviewed head: ${CURRENT_HEAD}\n`)).toBe(CURRENT_HEAD);
  });

  /**
   * The converse of the quoting tests above, and the one direction that fails
   * open: blanking can also remove a *genuine* attestation. A review whose
   * attestation is swallowed attests no head, so it is never an attesting
   * comment and its findings go untracked.
   *
   * This is the residual the module header accepts rather than closes — Ally's
   * template leaves nothing fenceable above these lines, so reaching it needs a
   * malformed body. Pinning it keeps the residual executable instead of merely
   * described, and fails loudly if the attestation is ever moved below a
   * fenceable region.
   */
  it.each([
    ["an unbalanced backtick fence", "```ts"],
    ["a stray tilde fence", "~~~ts"],
  ])("loses a genuine attestation to %s above it", (_label, fence) => {
    const body = ["## Ally — Consolidated PR Review", fence, "", `Reviewed head: ${CURRENT_HEAD}`].join(
      "\n",
    );
    expect(extractAllyReviewedHeadSha(body)).toBeNull();
    // The body still reads as an actionable Ally review — only the attestation
    // is lost, which is precisely what makes this direction fail open.
    expect(hasAllyConsolidatedReviewHeading(body)).toBe(true);
  });
});

// BLO-29711 AC#1. The deployed context moved out of the `review/` namespace so
// a green can no longer be misread as review evidence. Because commit statuses
// cannot be deleted, the pre-rename rows have to be superseded in place.
describe("retired context supersede", () => {
  const LIVE = "gate/ally-comment-findings";

  it("excludes the live context so a retirement pointer cannot overwrite a real verdict", () => {
    expect(retiredCommentReviewGateContexts(["review/ally-comment", LIVE], LIVE)).toEqual([
      "review/ally-comment",
    ]);
    // Case and padding are how an operator typo actually looks.
    expect(retiredCommentReviewGateContexts([" Gate/Ally-Comment-Findings "], LIVE)).toEqual([]);
  });

  it("drops blanks and duplicates", () => {
    expect(
      retiredCommentReviewGateContexts(
        ["review/ally-comment", "  ", "review/ally-comment", ""],
        LIVE,
      ),
    ).toEqual(["review/ally-comment"]);
    expect(retiredCommentReviewGateContexts(undefined, LIVE)).toEqual([]);
  });

  it("points at the live context without claiming anything about review", () => {
    const description = commentReviewGateRetirementDescription(LIVE);

    expect(description).toContain(LIVE);
    // Asserted against the census's own predicate rather than a copy of its
    // regex, so the two cannot drift apart: if the census ever broadens what it
    // treats as a not-evaluated admission, this fails instead of silently
    // leaving AC#1 failing under the retired context name.
    expect(admitsNothingEvaluated(description)).toBe(false);
  });

  // The retired context may still be a *required* check on a deployment that
  // has not yet switched the requirement to the live context — BLO-26602 is
  // that migration, and this code cannot read branch protection to find out.
  // A fixed green here would satisfy the required legacy check while the live
  // context reports a blocking finding, letting a PR merge with unresolved
  // Critical/Important findings: the fail-open of this very issue, restored
  // through the cleanup path.
  it("never writes a green retirement row while the live verdict is blocking", () => {
    for (const verdict of [
      { state: "failure", outcome: "blocking_finding" },
      { state: "failure", outcome: "carried_finding" },
    ] as const) {
      const retirement = commentReviewGateRetirementStatus(LIVE, verdict);

      expect(retirement.state).toBe("failure");
      expect(retirement.description).toContain(LIVE);
      // Still a pointer, and still no not-evaluated claim under the retired
      // `review/`-prefixed name.
      expect(admitsNothingEvaluated(retirement.description)).toBe(false);
    }
  });

  it("mirrors a clean live verdict rather than inventing a state", () => {
    for (const outcome of ["clean", "not_evaluated"] as const) {
      const retirement = commentReviewGateRetirementStatus(LIVE, { state: "success", outcome });

      expect(retirement.state).toBe("success");
      expect(admitsNothingEvaluated(retirement.description)).toBe(false);
    }
  });

  it("keeps the pointer intact within GitHub's 140-character description limit", () => {
    // GitHub truncates at 140. The context name is the whole point of the
    // pointer, so it must survive rather than being cut mid-name.
    const longContext = `gate/${"x".repeat(120)}`;

    expect(commentReviewGateRetirementDescription(LIVE).length).toBeLessThanOrEqual(140);
    expect(commentReviewGateRetirementDescription(longContext).length).toBeLessThanOrEqual(140);
    expect(commentReviewGateRetirementDescription(LIVE, "failure").length).toBeLessThanOrEqual(140);
    expect(
      commentReviewGateRetirementDescription(longContext, "failure").length,
    ).toBeLessThanOrEqual(140);

    // Length alone was the weaker half of this promise: slicing the rendered
    // sentence also satisfies it, while severing the name and dropping the
    // closing quote — the exact "cut in half" outcome the fallback exists to
    // prevent. Assert the sentence stays well-formed: the name is elided with
    // an ellipsis and the quoted pointer still closes.
    for (const state of ["success", "failure"] as const) {
      const description = commentReviewGateRetirementDescription(longContext, state);
      expect(description.length).toBeLessThanOrEqual(140);
      expect(description).toMatch(/"[^"]*…"\.$/);
      expect(description.split('"').length - 1).toBe(2);
    }
  });
});

/**
 * BLO-31446 — Ally's clean-review boilerplate must not read as a blocking
 * finding.
 *
 * `hasActionablePrReviewFeedback` ended with an unguarded `Recommended Action`
 * … `fix` … `before merge` prose fallback. Ally's own 0-findings closing lines
 * supply all three tokens, so the cleaner the review, the likelier the red.
 *
 * Two distinct costs, and they are not equally severe — an earlier draft of
 * this comment called the whole thing permanent, which is wrong for the first:
 *
 *   - Carried case (an older head is the one misread): self-clears as soon as
 *     any clean attestation of the *current* head lands, because
 *     `evaluateCommentReviewGate` short-circuits on a current-head attestation
 *     before it ever consults the carry-forward. Cost is one review cycle of
 *     red. Observed at ~22 minutes on paperclip#1651.
 *   - Same-head case (the head being merged is the one misread): genuinely
 *     unclearable. A 0/0 body yields no finding identities, so no
 *     `Prior Findings Dispositioned` entry can name the finding to retire it,
 *     and the only exit is a fresh commit.
 *
 * Measured over the 68 Ally consolidated reviews on the 25 most recent
 * `Blockcast/paperclip` pull requests: this fix flips exactly 7, every one of
 * them `true` → `false`, every one of them yielding zero finding identities.
 * Zero flips in the other direction, and all 40 reviews carrying real findings
 * still block.
 *
 * The bodies below are the load-bearing lines of five real reviews, verbatim.
 * They are trimmed to the counted buckets plus the exact `Recommended Action`
 * lines rather than reproducing several KB of prose; the full verbatim
 * multicast#589 and paperclip#1651 bodies were executed against both the pre-
 * and post-fix module and classify identically to their trimmed forms here, so
 * the trim is measured, not assumed.
 */
describe("clean-review precedence over the Recommended Action prose fallback", () => {
  const CLEAN_BUCKETS = ["### Critical Issues (0)", "### Important Issues (0)"];

  // Each of the five differs in where and how the negation is phrased, which is
  // why the fix is precedence rather than another regex: `hasNonNegatedMatch`
  // only inspects the words *preceding* a match within its sentence, so the
  // paperclip#1605 body's trailing `_(None.)_` is invisible to any look-back
  // guard however its cue list is tuned.
  //
  // The paperclip#1651 body is the shape that rules out the other candidate
  // narrowing — confining the fallback's `[\s\S]{0,400}` spans to a single
  // paragraph. There the three trigger tokens are three *unrelated* list items:
  // the heading, then `fix` as a **noun naming the PR**, then a `before
  // merging` that belongs to a rebase instruction. Nothing about that span is
  // an instruction to fix anything, and no lexical guard can tell, because
  // every token is used in good faith. Only the reviewer's own 0/0 tally
  // settles it.
  const realCleanReviews: Array<[string, string[]]> = [
    ["paperclip#1618 @999cc70", ["1. No Critical issues to fix before merge."]],
    ["paperclip#1612 @383f074", ["1. No Critical issues — nothing to fix before merge."]],
    ["multicast#589 @ef7a43a", ["1. No Critical or Important issues — nothing to fix before merge."]],
    ["paperclip#1605 @123e1d2", ["1. Fix Critical issues before merge. _(None.)_"]],
    [
      "paperclip#1651 @2b6763f6",
      [
        "1. Nothing blocks merge on correctness. Zero Critical, zero Important, and the one prior blocker is withdrawn by me.",
        "2. With BLO-31836 cancelled as not-a-defect, this PR is the whole fix and BLO-23197 can close on it.",
        "3. The branch is `mergeable_state: behind` — update it before merging.",
      ],
    ],
  ];

  for (const [source, recommendedAction] of realCleanReviews) {
    it(`does not treat a 0/0 review as blocking: ${source}`, () => {
      const body = reviewBody(CURRENT_HEAD, [
        ...CLEAN_BUCKETS,
        "### Recommended Action",
        ...recommendedAction,
      ]);

      expect(hasActionablePrReviewFeedback(body)).toBe(false);
    });
  }

  // The fix must narrow only the prose fallback. Every other blocking signal
  // stays live at 0/0, so a reviewer who explicitly asks for changes is still
  // heard even when both buckets are empty.
  const explicitChangeRequests: Array<[string, string[], string | undefined]> = [
    ["decision: changes_requested", ["decision: changes_requested"], undefined],
    ["a bare `changes requested`", ["Changes requested on this head."], undefined],
    ["a bare `request changes`", ["I request changes here."], undefined],
    ["a formal CHANGES_REQUESTED state", [], "changes_requested"],
  ];

  for (const [label, lines, state] of explicitChangeRequests) {
    it(`still blocks a 0/0 review carrying ${label}`, () => {
      const body = reviewBody(CURRENT_HEAD, [...CLEAN_BUCKETS, ...lines]);

      expect(hasActionablePrReviewFeedback(body, state)).toBe(true);
    });
  }

  it("still blocks an uncounted findings heading at 0/0", () => {
    // An uncounted heading is not a count, so a body can carry both. The
    // heading wins: it is a finding the reviewer did not tally.
    const body = reviewBody(CURRENT_HEAD, [...CLEAN_BUCKETS, "### Critical Issues", "- a real one"]);

    expect(hasActionablePrReviewFeedback(body)).toBe(true);
  });

  it("keeps the prose fallback live when only one bucket is declared", () => {
    // Precedence requires an explicit statement about *both* severities. One
    // bucket at zero says nothing about the other, so this is not a 0/0
    // declaration and the fallback must still apply.
    const body = reviewBody(CURRENT_HEAD, [
      "### Critical Issues (0)",
      "### Recommended Action",
      "Fix it before merge.",
    ]);

    expect(hasActionablePrReviewFeedback(body)).toBe(true);
  });

  it("keeps the prose fallback live when no bucket is declared", () => {
    // Pins the same contract as the prose-only case further up this file: the
    // fallback is load-bearing precisely where no counted bucket exists.
    const body = reviewBody(CURRENT_HEAD, ["### Recommended Action", "Fix the gate before merge."]);

    expect(hasActionablePrReviewFeedback(body)).toBe(true);
  });

  // `still-present` is the ledger verb for "this prior finding still stands",
  // and `classifyPriorDisposition` already returns `blocks` for it. The
  // contract says such a finding is mirrored into the current buckets, which
  // would make a count non-zero and block here anyway — these two cases pin the
  // defence for when that mirroring is omitted, which the precedence fix would
  // otherwise turn from a heuristic red into a deterministic green.
  it("still blocks a 0/0 review whose ledger asserts a prior finding is still-present", () => {
    const body = [
      dispositioningReview(CURRENT_HEAD, OLD_HEAD, "still-present"),
      "### Recommended Action",
      "1. No Critical issues to fix before merge.",
    ].join("\n");

    expect(hasActionablePrReviewFeedback(body)).toBe(true);
  });

  it("clears a 0/0 review whose ledger only retires prior findings", () => {
    // The control for the case above: `fixed` classifies as `retires`, so it
    // must not block. Without this, the still-present guard could be satisfied
    // by any ledger entry at all and the fix would silently stop working.
    const body = [
      dispositioningReview(CURRENT_HEAD, OLD_HEAD, "fixed"),
      "### Recommended Action",
      "1. No Critical issues to fix before merge.",
    ].join("\n");

    expect(hasActionablePrReviewFeedback(body)).toBe(false);
  });

  it("clears a 0/0 review whose ledger carries a verb this parser does not know", () => {
    // Deliberate, and the asymmetry with the carry-forward path is the point.
    // There the question is "was this prior finding retired?", so an
    // `unrecognized` verb fails closed — `isRetired` demands `retires`. Here the
    // question is "does this review report findings against *this* head?", and
    // the 0/0 answers it directly. Only `still-present` is excluded, because it
    // is the one verb that positively asserts a finding still stands and so
    // contradicts the tally beside it. Widening this to `unrecognized` would
    // block on a typo, which is why it is pinned rather than left ambiguous.
    const body = [
      dispositioningReview(CURRENT_HEAD, OLD_HEAD, "deferred"),
      "### Recommended Action",
      "1. No Critical issues to fix before merge.",
    ].join("\n");

    expect(hasActionablePrReviewFeedback(body)).toBe(false);
  });

  it("fails the gate at the current head when a still-present ledger entry rides a 0/0 body", () => {
    // The unit assertions above cannot reach this. `evaluateCommentReviewGate`
    // short-circuits on a current-head attestation before it consults the
    // carry-forward, so the still-present entry is never re-examined there —
    // the existing still-present test in this file attests INTERMEDIATE_HEAD
    // and therefore exercises the carry-forward path instead.
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(
          [
            dispositioningReview(CURRENT_HEAD, OLD_HEAD, "still-present"),
            "### Recommended Action",
            "1. No Critical issues to fix before merge.",
          ].join("\n"),
          "2026-09-05T20:00:00Z",
        ),
      ],
    });

    expect(verdict).toMatchObject({ state: "failure", outcome: "blocking_finding" });
  });

  it("still counts a non-zero bucket alongside clean prose", () => {
    const body = reviewBody(CURRENT_HEAD, [
      "### Critical Issues (0)",
      "### Important Issues (1)",
      "- a real finding",
      "### Recommended Action",
      "1. No Critical issues to fix before merge.",
    ]);

    expect(hasActionablePrReviewFeedback(body)).toBe(true);
  });

  it("reports a clean verdict end to end for a boilerplate-carrying review", () => {
    // The user-visible outcome, not just the predicate: before the fix this
    // head was carried forward as `carried_finding` with no ledger entry able
    // to retire it.
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [
        allyComment(
          reviewBody(CURRENT_HEAD, [
            ...CLEAN_BUCKETS,
            "### Recommended Action",
            "1. No Critical or Important issues — nothing to fix before merge.",
          ]),
          "2026-09-04T03:11:21Z",
        ),
      ],
    });

    expect(verdict).toMatchObject({ state: "success", outcome: "clean" });
  });
});

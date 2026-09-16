import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain-JS census script; imported for its own predicate so
// the retirement description is checked against the real thing, not a copy.
import { admitsNothingEvaluated } from "../../../scripts/check-comment-review-gate-census.mjs";

import {
  extractAllyPriorFindingDispositions,
  extractAllyReportedFindingRefs,
  extractAllyReviewedHeadSha,
  hasActionablePrReviewFeedback,
  hasAllyConsolidatedReviewHeading,
} from "../services/ally-review-detection.js";
import {
  commentReviewGateCheckConclusion,
  commentReviewGateCheckTitle,
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

describe("commentReviewGateCheckConclusion", () => {
  const notEvaluated = evaluateCommentReviewGate({ headSha: CURRENT_HEAD, comments: [] });
  const clean = evaluateCommentReviewGate({
    headSha: CURRENT_HEAD,
    comments: [allyComment(cleanReview(CURRENT_HEAD), "2026-08-04T21:09:19Z")],
  });
  const blocking = evaluateCommentReviewGate({
    headSha: CURRENT_HEAD,
    comments: [allyComment(blockingReview(CURRENT_HEAD), "2026-08-04T20:09:19Z")],
  });
  const carried = evaluateCommentReviewGate({
    headSha: CURRENT_HEAD,
    comments: [allyComment(blockingReview(OLD_HEAD), "2026-08-04T20:09:19Z")],
  });

  it("renders not-evaluated differently from reviewed-and-clean without reading the description", () => {
    // The defect this exists to close: on the commit-status surface both of
    // these are `success`, so the only thing separating "reviewed, clean" from
    // "nothing reviewed this head" is prose nobody reads (BLO-33657).
    expect(notEvaluated.state).toBe(clean.state);

    expect(commentReviewGateCheckConclusion(clean)).toBe("success");
    expect(commentReviewGateCheckConclusion(notEvaluated)).toBe("neutral");
    expect(commentReviewGateCheckConclusion(notEvaluated)).not.toBe(
      commentReviewGateCheckConclusion(clean),
    );
  });

  it("keeps the not-evaluated conclusion non-blocking", () => {
    // BLO-29711's constraint, pinned so a later change cannot answer the
    // distinguishability requirement by reintroducing pending/failure-on-absence
    // and deadlocking every formally-reviewed PR.
    expect(["success", "neutral"]).toContain(commentReviewGateCheckConclusion(notEvaluated));
  });

  it("still blocks on a finding, at this head or carried from an earlier one", () => {
    expect(commentReviewGateCheckConclusion(blocking)).toBe("failure");
    expect(commentReviewGateCheckConclusion(carried)).toBe("failure");
  });

  it("covers every not-established shape, not just the empty-comment one", () => {
    const cases = [
      // No head supplied to evaluate against.
      evaluateCommentReviewGate({ headSha: "", comments: [] }),
      // An Ally review that attests some other head.
      evaluateCommentReviewGate({
        headSha: CURRENT_HEAD,
        comments: [allyComment(cleanReview(INTERMEDIATE_HEAD), "2026-08-04T21:09:19Z")],
      }),
      // A clean review of this head from someone who is not the reviewer.
      evaluateCommentReviewGate({
        headSha: CURRENT_HEAD,
        comments: [
          { authorLogin: "someone-else", body: cleanReview(CURRENT_HEAD), createdAt: "2026-08-04T21:09:19Z" },
        ],
      }),
    ];

    for (const verdict of cases) {
      expect(verdict).toMatchObject({ state: "success", outcome: "not_evaluated" });
      expect(commentReviewGateCheckConclusion(verdict)).toBe("neutral");
    }
  });

  it("gives each outcome its own title so the conclusion is legible unopened", () => {
    const titles = [notEvaluated, clean, blocking, carried].map(commentReviewGateCheckTitle);

    expect(new Set(titles).size).toBe(titles.length);
    expect(commentReviewGateCheckTitle(notEvaluated)).toMatch(/not evaluated/i);
  });
});

describe("commit-status description budget", () => {
  // GitHub caps a commit-status description at 140 characters and
  // `githubPostCommitStatusDetailed` slices to that before the POST, so an
  // overlong reason is never rejected — it is silently cut. What gets cut is
  // the tail, and the tail of the clean reason is the source attribution, the
  // one field that says whether the structured block or the prose fallback
  // produced the green (BLO-32695). Losing it is exactly the silent regression
  // the attribution exists to make visible.
  const MAX = 140;

  // Both branches of the `source` ternary, driven through the real evaluator
  // rather than re-rendered here: a copy of the sentence would keep passing
  // after the real one grew.
  const structured = evaluateCommentReviewGate({
    headSha: CURRENT_HEAD,
    comments: [
      allyComment(
        [
          "## Ally — Consolidated PR Review",
          "",
          "<!-- ally-verdict:1",
          JSON.stringify({
            head: CURRENT_HEAD,
            findings: { critical: 0, important: 0, suggestions: 0 },
            dispositions: [],
          }),
          "-->",
          "",
          `Reviewed head: ${CURRENT_HEAD}`,
        ].join("\n"),
        "2026-08-04T21:09:19Z",
      ),
    ],
  });
  const prose = evaluateCommentReviewGate({
    headSha: CURRENT_HEAD,
    comments: [allyComment(cleanReview(CURRENT_HEAD), "2026-08-04T21:09:19Z")],
  });

  it("keeps both clean descriptions inside GitHub's cap", () => {
    // Positive control: assert we actually exercised both branches, so a
    // regression that collapses them to one phrasing cannot pass vacuously.
    expect(structured).toMatchObject({ state: "success", outcome: "clean" });
    expect(prose).toMatchObject({ state: "success", outcome: "clean" });
    expect(structured.reason).not.toBe(prose.reason);

    for (const verdict of [structured, prose]) {
      expect(verdict.reason.length).toBeLessThanOrEqual(MAX);
    }
  });
});

/**
 * A finding's identity is `(head, severity, index)`, so a review that MIRRORS
 * an earlier finding — re-stating it in its own counts — gives it a second,
 * independent identity at the mirroring head. Nothing in the block links the
 * two: extractAllyReportedFindingRefs mints refs from the counts alone. So a
 * ledger that retires only the original leaves the mirroring head carrying a
 * ref no verb ever names, and isFullyDispositioned carries the whole head.
 *
 * Reconstructed from Blockcast/trafficcontrol#1707 (BLO-34249): the ebae10f
 * review mirrored `prior:195e6e2 important 1` as its own Important 1, the
 * 78107bf4 review retired `195e6e2 important 1` and `ebae10f important 2`, and
 * ebae10f stayed red on the mirror it had no way to name.
 *
 * The fix is producer-side and needs no schema change — the consumer already
 * retires per (head, severity, index), so a second entry under the mirroring
 * head retires the mirror exactly. These cases pin that, in the structured
 * block, at `ally-verdict:1`.
 */
describe("mirrored findings retire under both identities (#1707)", () => {
  const RAISED = "195e6e2".padEnd(40, "0");
  const MIRRORING = "ebae10fe77bd".padEnd(40, "0");
  // A second mirroring head, spliced in only by the `mirroredAgain` knob, so a
  // chain can be longer than the two heads #1707 itself had.
  const MIRRORED_AGAIN = "c0ffee1".padEnd(40, "0");
  const DISPOSITIONING = "78107bf4".padEnd(40, "0");
  // Ally has not reviewed this one yet — the gap between reviews where a
  // carried finding is the only thing the gate has to go on.
  const UNATTESTED = "e".repeat(40);

  function verdictReview(
    headSha: string,
    findings: { critical?: number; important?: number },
    dispositions: { head: string; severity: string; index: number; verb: string }[],
  ): string {
    return [
      "## Ally — Consolidated PR Review",
      "",
      "<!-- ally-verdict:1",
      JSON.stringify({
        head: headSha,
        findings: { critical: 0, important: 0, suggestions: 0, ...findings },
        dispositions,
      }),
      "-->",
      "",
      `Reviewed head: ${headSha}`,
    ].join("\n");
  }

  const fixed = (headSha: string, index: number, severity = "important") => ({
    head: headSha.slice(0, 7),
    severity,
    index,
    verb: "fixed",
  });

  /**
   * The #1707 sequence, with whatever ledger the final review carried.
   *
   * `counts` fixes how many findings each of the first two reviews reports,
   * which is what decides whether the mirror's two ordinals coincide. The
   * default is #1707 itself: RAISED reports one Important, MIRRORING mirrors
   * it as its own Important 1 and adds a new Important 2.
   *
   * `mirroredAgain` splices a THIRD reporting head between MIRRORING and
   * DISPOSITIONING, so the chain is longer than the two heads #1707 had.
   * Default `0` omits it, leaving every pre-existing case a 2-head sequence.
   */
  function history(
    dispositions: ReturnType<typeof fixed>[],
    counts: {
      raised?: number;
      mirroring?: number;
      mirroringCritical?: number;
      mirroredAgain?: number;
    } = {},
  ) {
    const { raised = 1, mirroring = 2, mirroringCritical = 0, mirroredAgain = 0 } = counts;
    return [
      allyComment(verdictReview(RAISED, { important: raised }, []), "2026-09-10T10:00:00Z"),
      allyComment(
        verdictReview(MIRRORING, { important: mirroring, critical: mirroringCritical }, []),
        "2026-09-11T10:00:00Z",
      ),
      ...(mirroredAgain
        ? [
            allyComment(
              verdictReview(MIRRORED_AGAIN, { important: mirroredAgain }, []),
              "2026-09-11T22:00:00Z",
            ),
          ]
        : []),
      allyComment(verdictReview(DISPOSITIONING, {}, dispositions), "2026-09-12T10:00:00Z"),
    ];
  }

  it("negative control: retiring only the original leaves the mirroring head carried", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: UNATTESTED,
      reviewerBotLogin: ALLY_BOT_LOGIN,
      comments: history([fixed(RAISED, 1), fixed(MIRRORING, 2)]),
    });

    expect(verdict).toMatchObject({
      state: "failure",
      outcome: "carried_finding",
      carriedFromHeadSha: MIRRORING,
    });
  });

  it("clears once the mirror is also dispositioned under the mirroring head", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: UNATTESTED,
      reviewerBotLogin: ALLY_BOT_LOGIN,
      comments: history([fixed(RAISED, 1), fixed(MIRRORING, 2), fixed(MIRRORING, 1)]),
    });

    expect(verdict).toMatchObject({ state: "success", outcome: "not_evaluated" });
  });

  /**
   * #1707 is DEGENERATE for the rule's ordinal clause: the mirror is Important
   * 1 at both heads, so `fixed(MIRRORING, 1)` above is what a correct producer
   * emits AND what one that wrongly reuses the original's ordinal emits. The
   * pair above therefore pins the mechanism (two entries, one per identity)
   * but not the clause "recover the mirror's ordinal from the review that
   * minted it rather than reusing the original's".
   *
   * Diverging the two ordinals makes that clause testable: RAISED reports two
   * Importants and MIRRORING mirrors RAISED's SECOND as its own FIRST. The
   * direction matters — mirroring first-as-second would leave both ordinals
   * retired under either ledger, and would not discriminate.
   *
   * SCOPE: these controls fail by naming an index the head never reported, so
   * what they pin is "one distinct IN-RANGE index per resolved finding, per
   * head" — the most the consumer can enforce. A within-range mis-assignment
   * (mirror at important 2, ledger says important 1, a sibling at important 1)
   * is undetectable by construction: refs are minted from counts alone and
   * carry no content, so retirement is a set-cover over 1..N and any
   * permutation of in-range indices produces the same verdict. The ordinal
   * discipline above that is for ledger readability and for a consumer that
   * later attaches content — don't read a swapped-index case going green as
   * the consumer being broken.
   */
  describe("the mirror's index is its ordinal at its OWN head", () => {
    const diverged = (dispositions: ReturnType<typeof fixed>[]) =>
      history(dispositions, { raised: 2, mirroring: 1 });

    it("clears when the mirror is retired at the ordinal its own head gave it", () => {
      const verdict = evaluateCommentReviewGate({
        headSha: UNATTESTED,
        reviewerBotLogin: ALLY_BOT_LOGIN,
        comments: diverged([fixed(RAISED, 1), fixed(RAISED, 2), fixed(MIRRORING, 1)]),
      });

      expect(verdict).toMatchObject({ state: "success", outcome: "not_evaluated" });
    });

    it("negative control: reusing the original's ordinal leaves the mirror carried", () => {
      const verdict = evaluateCommentReviewGate({
        headSha: UNATTESTED,
        reviewerBotLogin: ALLY_BOT_LOGIN,
        // `fixed(MIRRORING, 2)` names an index MIRRORING never reported, so the
        // mirror it actually carries — MIRRORING important 1 — stays unretired.
        comments: diverged([fixed(RAISED, 1), fixed(RAISED, 2), fixed(MIRRORING, 2)]),
      });

      expect(verdict).toMatchObject({
        state: "failure",
        outcome: "carried_finding",
        carriedFromHeadSha: MIRRORING,
      });
    });
  });

  /**
   * Ordinals are namespaced PER SEVERITY: `extractAllyReportedFindingRefs`
   * numbers `1..count` inside a per-severity loop, and `namesFinding` matches
   * on severity AND index. So a Critical ahead of the mirror does not shift
   * the mirror's Important ordinal — only another Important does.
   *
   * MIRRORING reports one new Critical plus the mirror as its own Important 1.
   * A producer reading the rule's divergence clause as "any earlier finding
   * shifts the ordinal" emits `important 2` and dangles.
   */
  describe("a higher-severity finding does not shift the mirror's ordinal", () => {
    const acrossSeverities = (dispositions: ReturnType<typeof fixed>[]) =>
      history(dispositions, { raised: 1, mirroring: 1, mirroringCritical: 1 });

    it("clears when the mirror keeps important 1 despite a Critical ahead of it", () => {
      const verdict = evaluateCommentReviewGate({
        headSha: UNATTESTED,
        reviewerBotLogin: ALLY_BOT_LOGIN,
        comments: acrossSeverities([
          fixed(RAISED, 1),
          fixed(MIRRORING, 1, "critical"),
          fixed(MIRRORING, 1),
        ]),
      });

      expect(verdict).toMatchObject({ state: "success", outcome: "not_evaluated" });
    });

    it("negative control: counting the Critical against the Important ordinal dangles", () => {
      const verdict = evaluateCommentReviewGate({
        headSha: UNATTESTED,
        reviewerBotLogin: ALLY_BOT_LOGIN,
        // `fixed(MIRRORING, 2)` names an Important index MIRRORING never
        // reported — its Critical does not occupy the Important bucket.
        comments: acrossSeverities([
          fixed(RAISED, 1),
          fixed(MIRRORING, 1, "critical"),
          fixed(MIRRORING, 2),
        ]),
      });

      expect(verdict).toMatchObject({
        state: "failure",
        outcome: "carried_finding",
        carriedFromHeadSha: MIRRORING,
      });
    });

    // Retirement is per-(head, severity, index), not per-head: clearing the
    // Important mirror does not clear the head while its Critical dangles.
    it("negative control: one severity retired at a head does not clear the other", () => {
      const verdict = evaluateCommentReviewGate({
        headSha: UNATTESTED,
        reviewerBotLogin: ALLY_BOT_LOGIN,
        comments: acrossSeverities([fixed(RAISED, 1), fixed(MIRRORING, 1)]),
      });

      expect(verdict).toMatchObject({
        state: "failure",
        outcome: "carried_finding",
        carriedFromHeadSha: MIRRORING,
      });
    });
  });

  /**
   * A chain is the steady state: a finding survives every push until it is
   * fixed, and each surviving review re-states it. #1707 is only the shortest
   * such chain, so every case above is a 2-head sequence — and at two heads
   * "the intermediate link" does not exist to be got wrong.
   *
   * These two extend it to H1 -> H2 -> H3 -> H4-disposes, which is what makes
   * the rule's "three, not two" clause testable. `headsWithUndispositionedFinding`
   * filters each attesting head through `isFullyDispositioned` independently,
   * so H2 is carried by its own unretired ref regardless of H1 and H3 being
   * clean — a consumer that treated a chain as endpoints-only, or let H3's
   * retirement cascade backwards, goes green here.
   */
  describe("every link in a chain needs its own entry", () => {
    const chained = (dispositions: ReturnType<typeof fixed>[]) =>
      history(dispositions, { raised: 1, mirroring: 1, mirroredAgain: 1 });

    it("clears when all three reporting heads are retired", () => {
      const verdict = evaluateCommentReviewGate({
        headSha: UNATTESTED,
        reviewerBotLogin: ALLY_BOT_LOGIN,
        comments: chained([fixed(RAISED, 1), fixed(MIRRORING, 1), fixed(MIRRORED_AGAIN, 1)]),
      });

      expect(verdict).toMatchObject({ state: "success", outcome: "not_evaluated" });
    });

    it("negative control: skipping the INTERMEDIATE head carries it alone", () => {
      const verdict = evaluateCommentReviewGate({
        headSha: UNATTESTED,
        reviewerBotLogin: ALLY_BOT_LOGIN,
        // Both ends of the chain retired, the middle link forgotten — the
        // shape a producer reaches by dispositioning "the original and the
        // mirror" when there were two mirrors.
        comments: chained([fixed(RAISED, 1), fixed(MIRRORED_AGAIN, 1)]),
      });

      expect(verdict).toMatchObject({
        state: "failure",
        outcome: "carried_finding",
        carriedFromHeadSha: MIRRORING,
      });
    });
  });
});

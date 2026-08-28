import { describe, expect, it } from "vitest";

// @ts-expect-error -- plain-JS census script; imported for its own predicate so
// the retirement description is checked against the real thing, not a copy.
import { admitsNothingEvaluated } from "../../../scripts/check-comment-review-gate-census.mjs";

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
  });
});

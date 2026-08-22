import { describe, expect, it } from "vitest";

import {
  commentReviewGateVerdictIsMisreadable,
  evaluateCommentReviewGate,
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

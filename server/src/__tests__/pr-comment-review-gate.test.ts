import { describe, expect, it } from "vitest";

import { evaluateCommentReviewGate } from "../services/pr-comment-review-gate.js";

const OLD_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CURRENT_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
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

  it("does not carry a finding across a replacement head", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [allyComment(blockingReview(OLD_HEAD), "2026-08-04T20:09:19Z")],
    });

    // Deliberate: only an exact-head attestation gates, so a stale comment cannot
    // block a head that may already contain the fix (BLO-21907 / #1262).
    expect(verdict).toMatchObject({ state: "success" });
    expect(verdict.reason).toMatch(/does not carry over/i);
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

    expect(verdict).toMatchObject({ state: "success" });
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

    expect(verdict).toMatchObject({ state: "success" });
  });

  it("uses comment chronology rather than contributor-controlled commit metadata", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [allyComment(blockingReview(CURRENT_HEAD), "2020-01-01T00:00:00Z")],
    });

    expect(verdict).toMatchObject({ state: "failure" });
  });
});

// BLO-28988. The gate published `success` alongside the description "No Ally
// consolidated-review comment attests to reviewing this head." — a pass whose
// own reason reads as an assertion that nothing reviewed the head. These pin the
// state each surface case yields and, crucially, that no `success` reason can be
// read as reporting a deficiency.
describe("evaluateCommentReviewGate state/description consistency", () => {
  const CASES = [
    {
      name: "(a) comment-shaped review at the exact head, clean",
      comments: [allyComment(cleanReview(CURRENT_HEAD), "2026-08-04T20:09:19Z")],
      state: "success",
    },
    {
      name: "(b) comment-shaped review at a stale head only",
      comments: [allyComment(cleanReview(OLD_HEAD), "2026-08-04T20:09:19Z")],
      state: "success",
    },
    {
      name: "(c) no comment-shaped review (Ally reviewed formally instead)",
      comments: [],
      state: "success",
    },
    {
      name: "(d) comment-shaped review at the exact head carrying a finding",
      comments: [allyComment(blockingReview(CURRENT_HEAD), "2026-08-04T20:09:19Z")],
      state: "failure",
    },
  ] as const;

  for (const testCase of CASES) {
    it(`yields ${testCase.state} for ${testCase.name}`, () => {
      const verdict = evaluateCommentReviewGate({
        headSha: CURRENT_HEAD,
        comments: [...testCase.comments],
      });

      expect(verdict.state).toBe(testCase.state);
      // The regression: a success must never explain itself as an absence of
      // attestation. Only a non-success state may report that nothing attests.
      if (verdict.state === "success") {
        expect(verdict.reason).not.toMatch(/no ally consolidated-review comment attests/i);
        expect(verdict.reason).not.toMatch(/attests to reviewing this head/i);
      }
    });
  }

  it("reports pending, never success, when the surface cannot be evaluated", () => {
    const verdict = evaluateCommentReviewGate({ headSha: "", comments: [] });

    expect(verdict.state).toBe("pending");
    expect(verdict.reason).toMatch(/not evaluated/i);
  });

  it("distinguishes a superseded earlier review from a surface never engaged", () => {
    const superseded = evaluateCommentReviewGate({
      headSha: CURRENT_HEAD,
      comments: [allyComment(cleanReview(OLD_HEAD), "2026-08-04T20:09:19Z")],
    });
    const neverEngaged = evaluateCommentReviewGate({ headSha: CURRENT_HEAD, comments: [] });

    expect(superseded.state).toBe("success");
    expect(neverEngaged.state).toBe("success");
    expect(superseded.reason).not.toBe(neverEngaged.reason);
  });
});

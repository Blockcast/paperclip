import { describe, expect, it } from "vitest";
import { evaluatePrReviewGate } from "../services/pr-review-gate.js";

// Live fixture: Blockcast/magma#1655 (BLO-19411 / BLO-22574). `GET
// repos/Blockcast/magma/pulls/1655/reviews` returns `[]` even today, on a
// merged, demonstrably-reviewed PR — captured 2026-08-07 to keep this test
// reproducible without hitting the network.
const MAGMA_1655_HEAD_SHA = "95425d577ee57b11488bd2030a54764c8148b15d";
const MAGMA_1655_ALLY_COMMENT = {
  authorLogin: "allyblockcast[bot]",
  createdAt: "2026-08-04T23:31:47Z",
  body:
    "## Ally — Consolidated PR Review\n\n" +
    "_Lenses: pr-review-toolkit (code, tests, comments, errors, types) + gstack/review + native-codex._\n" +
    `Reviewed head: ${MAGMA_1655_HEAD_SHA}\n\n` +
    "Looks good. No Critical or Important issues found.\n\n" +
    "### Suggestions (1)\n" +
    "- **[tests]** add a focused Helm render assertion.\n",
};

describe("evaluatePrReviewGate", () => {
  it("(a) satisfied via a formal pull_request_review object", () => {
    const result = evaluatePrReviewGate({
      headSha: "abc123",
      reviews: [
        { authorLogin: "someone", commitSha: "abc123", submittedAt: "2026-08-01T00:00:00Z" },
      ],
      comments: [],
    });
    expect(result.satisfied).toBe(true);
    expect(result.surface).toBe("formal_review");
  });

  it("(b) satisfied via a comment-shaped Ally review with no formal review object — the magma#1655 shape", () => {
    // This is the exact live shape from Blockcast/magma#1655: `reviews`
    // is empty, and the only evidence of review is the issue comment.
    // Must fail on today's master, where no evaluator applies this check.
    const result = evaluatePrReviewGate({
      headSha: MAGMA_1655_HEAD_SHA,
      reviews: [],
      comments: [MAGMA_1655_ALLY_COMMENT],
    });
    expect(result.satisfied).toBe(true);
    expect(result.surface).toBe("comment_review");
    expect(result.reviewedHeadSha).toBe(MAGMA_1655_HEAD_SHA);
    expect(result.stale).toBe(false);
  });

  it("(c) unsatisfied when neither surface has a response", () => {
    const result = evaluatePrReviewGate({
      headSha: "abc123",
      reviews: [],
      comments: [],
    });
    expect(result.satisfied).toBe(false);
    expect(result.surface).toBe("none");
  });

  it("stays unsatisfied when the only comment is not Ally-headed", () => {
    const result = evaluatePrReviewGate({
      headSha: "abc123",
      reviews: [],
      comments: [
        { authorLogin: "kkroo", createdAt: "2026-08-01T00:00:00Z", body: "lgtm, merging" },
      ],
    });
    expect(result.satisfied).toBe(false);
    expect(result.surface).toBe("none");
  });

  it("treats a formal review at a stale commit as unsatisfied", () => {
    const result = evaluatePrReviewGate({
      headSha: "new-head",
      reviews: [
        { authorLogin: "someone", commitSha: "old-head", submittedAt: "2026-08-01T00:00:00Z" },
      ],
      comments: [],
    });
    expect(result.satisfied).toBe(false);
    expect(result.stale).toBe(true);
  });

  it("determines comment-review staleness from the captured head, not the comment timestamp — a fresh-looking comment reading a stale head is still unsatisfied", () => {
    const newHead = "2222222222222222222222222222222222222222";
    const oldHead = "1111111111111111111111111111111111111111";
    const result = evaluatePrReviewGate({
      headSha: newHead,
      reviews: [],
      comments: [
        {
          authorLogin: "allyblockcast[bot]",
          // Recent timestamp, but the captured head is stale — timestamp
          // recency must not override the head comparison (BLO-22574).
          createdAt: "2026-08-06T00:00:00Z",
          body: `## Ally — Consolidated PR Review\nReviewed head: ${oldHead}\n\nLGTM.`,
        },
      ],
    });
    expect(result.satisfied).toBe(false);
    expect(result.stale).toBe(true);
    expect(result.reviewedHeadSha).toBe(oldHead);
  });

  it("falls back to timestamp-vs-push only when the Reviewed head capture is genuinely empty", () => {
    const stale = evaluatePrReviewGate({
      headSha: "new-head",
      headPushedAt: "2026-08-05T00:00:00Z",
      reviews: [],
      comments: [
        {
          authorLogin: "allyblockcast[bot]",
          createdAt: "2026-08-01T00:00:00Z", // before the push
          body: "## Ally — Consolidated PR Review\n\nLGTM.", // no Reviewed head line
        },
      ],
    });
    expect(stale.satisfied).toBe(false);
    expect(stale.stale).toBe(true);

    const fresh = evaluatePrReviewGate({
      headSha: "new-head",
      headPushedAt: "2026-08-05T00:00:00Z",
      reviews: [],
      comments: [
        {
          authorLogin: "allyblockcast[bot]",
          createdAt: "2026-08-06T00:00:00Z", // after the push
          body: "## Ally — Consolidated PR Review\n\nLGTM.",
        },
      ],
    });
    expect(fresh.satisfied).toBe(true);
  });

  it("takes the latest entry per surface — reviews is not returned sorted by GitHub", () => {
    const result = evaluatePrReviewGate({
      headSha: "head-2",
      reviews: [
        { authorLogin: "a", commitSha: "head-2", submittedAt: "2026-08-03T00:00:00Z" },
        { authorLogin: "b", commitSha: "head-1", submittedAt: "2026-08-01T00:00:00Z" },
      ],
      comments: [],
    });
    expect(result.satisfied).toBe(true);
    expect(result.reviewedHeadSha).toBe("head-2");
  });

  describe("Blockcast/magma#1655 replay (BLO-22574 acceptance criteria)", () => {
    it("replaying at 2026-08-04T23:12:09Z (the monitor's only check, before Ally's comment) yields unsatisfied", () => {
      // At this instant nothing had been posted yet: reviews == [] and no
      // comments existed. This is the literal monitorNotes recorded live:
      // "state=BLOCKED/REVIEW_REQUIRED reviews=0 head=95425d577e".
      const result = evaluatePrReviewGate({
        headSha: MAGMA_1655_HEAD_SHA,
        reviews: [],
        comments: [],
      });
      expect(result.satisfied).toBe(false);
    });

    it("replaying at 2026-08-04T23:32:00Z (after Ally posted comment 5185758901) yields satisfied", () => {
      const asOf = "2026-08-04T23:32:00Z";
      const visibleComments = [MAGMA_1655_ALLY_COMMENT].filter((c) => c.createdAt <= asOf);
      const result = evaluatePrReviewGate({
        headSha: MAGMA_1655_HEAD_SHA,
        reviews: [], // still [] today, per the live repro in BLO-22574
        comments: visibleComments,
      });
      expect(result.satisfied).toBe(true);
      expect(result.surface).toBe("comment_review");
    });
  });
});

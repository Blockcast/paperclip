/**
 * BLO-21907: evaluateCommentReviewGate — the gate deciding whether a PR's
 * comment-shaped Ally review blocks its current head, replaying the live
 * Blockcast/paperclip#1022 sequence that exposed the hole.
 *
 * On #1022: Ally posted an Important finding as a bare comment at 20:09:19Z
 * ("Make Lane C progress past an unclaimable oldest page before merge"), a
 * formal review APPROVED the PR at 21:14:37Z on "no unresolved review
 * threads" (vacuously true — Ally's comment opened none), and the PR entered
 * the merge queue with the finding still outstanding. This predicate is blind
 * to the formal-review surface by design (see the module docstring), so these
 * fixtures only ever populate `comments`.
 */
import { describe, expect, it } from "vitest";

import { evaluateCommentReviewGate } from "../services/pr-comment-review-gate.js";

const PUSH_1022 = "2026-08-04T18:00:00Z";
const ALLY_FINDING_1022 = "2026-08-04T20:09:19Z";

const IMPORTANT_FINDING_BODY = [
  "## Ally — Consolidated PR Review",
  "### Important Issues (1)",
  "- Lane C's oldest page is unclaimable under the current dispatch order.",
  "### Recommended Action",
  "Make Lane C progress past an unclaimable oldest page before merge.",
].join("\n");

const CLEAN_REVIEW_BODY = [
  "## Ally — Consolidated PR Review",
  "### Critical Issues (0)",
  "### Important Issues (0)",
  "",
  "LGTM, no further findings from this pass.",
].join("\n");

describe("evaluateCommentReviewGate — #1022 fixture", () => {
  it("rejects the #1022 sequence: comment-shaped Important finding after the last push", () => {
    const verdict = evaluateCommentReviewGate({
      lastPushAt: PUSH_1022,
      comments: [{ body: IMPORTANT_FINDING_BODY, createdAt: ALLY_FINDING_1022 }],
    });
    expect(verdict.state).toBe("failure");
    if (verdict.state === "failure") {
      expect(verdict.commentCreatedAt).toBe(new Date(ALLY_FINDING_1022).toISOString());
    }
  });

  it("is unmoved by a later formal APPROVED review — that surface is out of scope here", () => {
    // The formal review isn't a `comments` entry at all (it's a
    // pull_request_review, not an issue comment), so passing only the
    // blocking comment reproduces #1022's actual gate input regardless of
    // what the reviews array said.
    const verdict = evaluateCommentReviewGate({
      lastPushAt: PUSH_1022,
      comments: [{ body: IMPORTANT_FINDING_BODY, createdAt: ALLY_FINDING_1022 }],
    });
    expect(verdict.state).toBe("failure");
  });

  it("accepts an addressed-then-re-reviewed sequence: a push clears the old finding, a clean re-review after it passes", () => {
    const secondPush = "2026-08-05T03:20:00Z";
    const reReview = "2026-08-05T10:00:00Z";
    const verdict = evaluateCommentReviewGate({
      lastPushAt: secondPush,
      comments: [
        { body: IMPORTANT_FINDING_BODY, createdAt: ALLY_FINDING_1022 }, // predates secondPush
        { body: CLEAN_REVIEW_BODY, createdAt: reReview }, // postdates secondPush
      ],
    });
    expect(verdict.state).toBe("success");
  });

  it("does not block when the only unresolved finding predates the last push", () => {
    const secondPush = "2026-08-05T03:20:00Z";
    const verdict = evaluateCommentReviewGate({
      lastPushAt: secondPush,
      comments: [{ body: IMPORTANT_FINDING_BODY, createdAt: ALLY_FINDING_1022 }], // predates secondPush, no re-review yet
    });
    expect(verdict.state).toBe("success");
    expect(verdict.reason).toMatch(/no ally consolidated-review comment/i);
  });

  it("does not block a PR with no Ally comment at all — formal-review-only PRs are unaffected", () => {
    const verdict = evaluateCommentReviewGate({ lastPushAt: PUSH_1022, comments: [] });
    expect(verdict.state).toBe("success");
  });

  it("ignores a non-Ally comment even if it uses similar blocking language", () => {
    const verdict = evaluateCommentReviewGate({
      lastPushAt: PUSH_1022,
      comments: [
        {
          body: "### Important Issues (1)\nFix before merge.",
          createdAt: ALLY_FINDING_1022,
        },
      ],
    });
    expect(verdict.state).toBe("success");
  });

  it("treats a comment exactly at the push timestamp as predating it, not superseding it", () => {
    const verdict = evaluateCommentReviewGate({
      lastPushAt: ALLY_FINDING_1022,
      comments: [{ body: IMPORTANT_FINDING_BODY, createdAt: ALLY_FINDING_1022 }],
    });
    expect(verdict.state).toBe("success");
  });

  it("resolves on the most recent Ally comment since the push, not the first one", () => {
    const verdict = evaluateCommentReviewGate({
      lastPushAt: PUSH_1022,
      comments: [
        { body: CLEAN_REVIEW_BODY, createdAt: "2026-08-04T19:00:00Z" },
        { body: IMPORTANT_FINDING_BODY, createdAt: ALLY_FINDING_1022 },
      ],
    });
    expect(verdict.state).toBe("failure");
  });

  it("clears a blocking finding when a later Ally pass over the same head reports it dispositioned", () => {
    const verdict = evaluateCommentReviewGate({
      lastPushAt: PUSH_1022,
      comments: [
        { body: IMPORTANT_FINDING_BODY, createdAt: ALLY_FINDING_1022 },
        { body: CLEAN_REVIEW_BODY, createdAt: "2026-08-04T21:00:00Z" },
      ],
    });
    expect(verdict.state).toBe("success");
  });
});

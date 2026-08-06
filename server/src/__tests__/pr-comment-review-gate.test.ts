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
 *
 * Bound to the current head via each comment's own immutable `Reviewed head:
 * <sha>` attestation rather than a "posted after the last push" timestamp
 * heuristic — a contributor-controlled commit `committer.date` cannot be used
 * to hide or backdate a finding relative to a real head.
 */
import { describe, expect, it } from "vitest";

import { evaluateCommentReviewGate } from "../services/pr-comment-review-gate.js";

const OLD_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ALLY_FINDING_1022 = "2026-08-04T20:09:19Z";
const ALLY_BOT_LOGIN = "allyblockcast[bot]";

function reviewBody(lines: string[], headSha: string): string {
  return ["## Ally — Consolidated PR Review", `Reviewed head: ${headSha}`, ...lines].join("\n");
}

function importantFindingBody(headSha: string): string {
  return reviewBody(
    [
      "### Important Issues (1)",
      "- Lane C's oldest page is unclaimable under the current dispatch order.",
      "### Recommended Action",
      "Make Lane C progress past an unclaimable oldest page before merge.",
    ],
    headSha,
  );
}

function cleanReviewBody(headSha: string): string {
  return reviewBody(
    ["### Critical Issues (0)", "### Important Issues (0)", "", "LGTM, no further findings from this pass."],
    headSha,
  );
}

function allyComment(body: string, createdAt: string) {
  return { authorLogin: ALLY_BOT_LOGIN, body, createdAt };
}

describe("evaluateCommentReviewGate — #1022 fixture", () => {
  it("rejects the #1022 sequence: a comment-shaped Important finding attesting to the current head", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: NEW_HEAD,
      comments: [allyComment(importantFindingBody(NEW_HEAD), ALLY_FINDING_1022)],
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
      headSha: NEW_HEAD,
      comments: [allyComment(importantFindingBody(NEW_HEAD), ALLY_FINDING_1022)],
    });
    expect(verdict.state).toBe("failure");
  });

  it("accepts an addressed-then-re-reviewed sequence: a push clears the old finding, a clean re-review of the new head passes", () => {
    const reReview = "2026-08-05T10:00:00Z";
    const verdict = evaluateCommentReviewGate({
      headSha: NEW_HEAD,
      comments: [
        allyComment(importantFindingBody(OLD_HEAD), ALLY_FINDING_1022), // attests to the superseded head
        allyComment(cleanReviewBody(NEW_HEAD), reReview), // attests to the current head
      ],
    });
    expect(verdict.state).toBe("success");
  });

  it("does not block when the only unresolved finding attests to a superseded head", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: NEW_HEAD,
      comments: [allyComment(importantFindingBody(OLD_HEAD), ALLY_FINDING_1022)], // no comment yet for NEW_HEAD
    });
    expect(verdict.state).toBe("success");
    expect(verdict.reason).toMatch(/no ally consolidated-review comment/i);
  });

  it("does not block a PR with no Ally comment at all — formal-review-only PRs are unaffected", () => {
    const verdict = evaluateCommentReviewGate({ headSha: NEW_HEAD, comments: [] });
    expect(verdict.state).toBe("success");
  });

  it("ignores a non-Ally comment even if it uses similar blocking language", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: NEW_HEAD,
      comments: [
        {
          authorLogin: "human-reviewer",
          body: `Reviewed head: ${NEW_HEAD}\n### Important Issues (1)\nFix before merge.`,
          createdAt: ALLY_FINDING_1022,
        },
      ],
    });
    expect(verdict.state).toBe("success");
  });

  it("does not block when the comment carries no parseable head attestation", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: NEW_HEAD,
      comments: [
        {
          authorLogin: ALLY_BOT_LOGIN,
          body: "## Ally — Consolidated PR Review\n### Important Issues (1)\nFix before merge.",
          createdAt: ALLY_FINDING_1022,
        },
      ],
    });
    expect(verdict.state).toBe("success");
  });

  it("resolves on the most recent Ally comment for the head, not the first one", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: NEW_HEAD,
      comments: [
        allyComment(cleanReviewBody(NEW_HEAD), "2026-08-04T19:00:00Z"),
        allyComment(importantFindingBody(NEW_HEAD), ALLY_FINDING_1022),
      ],
    });
    expect(verdict.state).toBe("failure");
  });

  it("clears a blocking finding when a later Ally pass over the same head reports it dispositioned", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: NEW_HEAD,
      comments: [
        allyComment(importantFindingBody(NEW_HEAD), ALLY_FINDING_1022),
        allyComment(cleanReviewBody(NEW_HEAD), "2026-08-04T21:00:00Z"),
      ],
    });
    expect(verdict.state).toBe("success");
  });

  it("ignores spoofed consolidated-review headings from non-Ally authors", () => {
    const verdict = evaluateCommentReviewGate({
      headSha: NEW_HEAD,
      comments: [
        allyComment(importantFindingBody(NEW_HEAD), ALLY_FINDING_1022),
        {
          authorLogin: "some-contributor",
          body: cleanReviewBody(NEW_HEAD),
          createdAt: "2026-08-04T21:00:00Z",
        },
      ],
    });
    expect(verdict.state).toBe("failure");
  });

  it("cannot be fooled by a future-dated commit: a comment attesting to the current head still blocks regardless of createdAt ordering against commit metadata", () => {
    // Simulates the critical finding this replaces a "since last push" time
    // boundary for: a contributor-controlled committer date could otherwise
    // make this comment look like it predates the push. Head-attestation
    // matching never looks at commit metadata at all.
    const verdict = evaluateCommentReviewGate({
      headSha: NEW_HEAD,
      comments: [allyComment(importantFindingBody(NEW_HEAD), "2020-01-01T00:00:00Z")],
    });
    expect(verdict.state).toBe("failure");
  });
});

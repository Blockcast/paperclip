import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/github-app-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/github-app-auth.js")>();
  return { ...actual, githubFetchPrAuthorLogin: vi.fn() };
});

import { githubFetchPrAuthorLogin } from "../services/github-app-auth.js";
import { resolvePrReviewEvidenceWithGithubAuthor } from "../services/heartbeat.js";

const fetchAuthor = vi.mocked(githubFetchPrAuthorLogin);

// An assignment-sourced reviewer wake: carries the PR target but NOT the author.
// `issue-assignment-wakeup.ts` builds exactly this shape, and
// `mergeCoalescedContextSnapshot` strips `githubPrAuthorLogin` on a
// different-PR coalesce, so this is the common case, not an edge case.
const AUTHORLESS_CONTEXT = {
  reviewKind: "pr_review",
  prRole: "reviewer",
  githubPrNumber: 3121,
  githubRepoFullName: "Blockcast/pim-multicast-gateway",
};

// Phrasing taken from a real Ally self-skip run (BLO-9293).
const SELF_SKIP_OUTPUT = {
  summary:
    "PR author is `app/allyblockcast`, so self-review is not allowed. " +
    "Exiting without posting a review on Blockcast/pim-multicast-gateway#3121.",
  resultJson: null,
};

const MISSING = {
  status: "missing" as const,
  errorCode: "pr_review_output_missing",
  errorMessage: "PR reviewer run exited successfully but did not leave durable evidence",
};

describe("resolvePrReviewEvidenceWithGithubAuthor (self-review skip on author-less wakes)", () => {
  beforeEach(() => fetchAuthor.mockReset());

  it("upgrades `missing` to `self_review_skipped` once GitHub supplies the author", async () => {
    fetchAuthor.mockResolvedValue("allyblockcast[bot]");

    const result = await resolvePrReviewEvidenceWithGithubAuthor(
      AUTHORLESS_CONTEXT,
      SELF_SKIP_OUTPUT,
      MISSING,
    );

    expect(result.status).toBe("self_review_skipped");
    expect(fetchAuthor).toHaveBeenCalledWith({
      repoFullName: "Blockcast/pim-multicast-gateway",
      prNumber: 3121,
    });
  });

  it("leaves `missing` alone when GitHub cannot supply the author", async () => {
    fetchAuthor.mockResolvedValue(null);

    const result = await resolvePrReviewEvidenceWithGithubAuthor(
      AUTHORLESS_CONTEXT,
      SELF_SKIP_OUTPUT,
      MISSING,
    );

    expect(result.status).toBe("missing");
  });

  // The corroboration requirement is the point of the gate: a run must not be
  // able to talk its way out of a missing review by claiming a self-skip for a
  // PR somebody else authored.
  it("does not honour a self-skip claim when the real author is a different login", async () => {
    fetchAuthor.mockResolvedValue("kkroo");

    const result = await resolvePrReviewEvidenceWithGithubAuthor(
      AUTHORLESS_CONTEXT,
      SELF_SKIP_OUTPUT,
      MISSING,
    );

    expect(result.status).toBe("missing");
  });

  it("never spends a GitHub call on a verdict that is not `missing`", async () => {
    const posted = { status: "posted_review" as const };

    const result = await resolvePrReviewEvidenceWithGithubAuthor(
      AUTHORLESS_CONTEXT,
      SELF_SKIP_OUTPUT,
      posted,
    );

    expect(result).toBe(posted);
    expect(fetchAuthor).not.toHaveBeenCalled();
  });

  it("does not re-fetch when the wake already carried the author", async () => {
    const result = await resolvePrReviewEvidenceWithGithubAuthor(
      { ...AUTHORLESS_CONTEXT, githubPrAuthorLogin: "allyblockcast[bot]" },
      SELF_SKIP_OUTPUT,
      MISSING,
    );

    expect(fetchAuthor).not.toHaveBeenCalled();
    expect(result.status).toBe("missing");
  });
});

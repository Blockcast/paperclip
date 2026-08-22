import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cfg: {
    prCommentReviewGateStatusContext: "",
    prReviewerBotLogin: "allyblockcast[bot]",
  } as Record<string, string>,
}));

vi.mock("../config.js", () => ({ loadConfig: () => h.cfg }));

const mockListComments = vi.hoisted(() => vi.fn());
const mockListReviews = vi.hoisted(() => vi.fn());
const mockFetchHeadSha = vi.hoisted(() => vi.fn());
const mockPostStatus = vi.hoisted(() => vi.fn());

vi.mock("../services/github-app-auth.js", () => ({
  githubFetchPrHeadSha: mockFetchHeadSha,
  githubListIssueCommentsWithTimestamps: mockListComments,
  githubListPrReviewsWithTimestamps: mockListReviews,
  githubPostCommitStatusDetailed: mockPostStatus,
  githubReviewerIdentityMatches: (login: string, configuredLogin: string) => {
    const candidate = login.trim().toLowerCase().replace(/^@/, "");
    const configured = configuredLogin.trim().toLowerCase().replace(/^@/, "");
    const appSlug = configured.endsWith("[bot]")
      ? configured.slice(0, -"[bot]".length)
      : configured.startsWith("app/")
        ? configured.slice("app/".length)
        : "";
    return candidate === `${appSlug}[bot]` || candidate === `app/${appSlug}`;
  },
}));

import { runPrCommentReviewGateCheck } from "../services/pr-comment-review-gate.js";

const TARGET = {
  repoFullName: "Blockcast/paperclip",
  prNumber: 1022,
  headSha: "1234567890abcdef1234567890abcdef12345678",
  prUrl: "https://github.com/Blockcast/paperclip/pull/1022",
};

function blockingCommentFor(headSha: string) {
  return {
    login: "allyblockcast[bot]",
    body: `## Ally — Consolidated PR Review\nReviewed head: ${headSha}\n### Important Issues (1)\nFix before merge.`,
    createdAt: "2026-08-04T20:09:19Z",
  };
}

beforeEach(() => {
  h.cfg.prCommentReviewGateStatusContext = "review/ally-comment-gate";
  h.cfg.prReviewerBotLogin = "allyblockcast[bot]";
  mockListComments.mockReset();
  mockListReviews.mockReset();
  mockFetchHeadSha.mockReset();
  mockPostStatus.mockReset();
  // Default both surfaces to empty; each test overrides the one it exercises.
  mockListComments.mockResolvedValue([]);
  mockListReviews.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runPrCommentReviewGateCheck", () => {
  it("is inert when the status context is unconfigured", async () => {
    h.cfg.prCommentReviewGateStatusContext = "";

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toEqual({ posted: false, reason: "not_configured" });
    expect(mockListComments).not.toHaveBeenCalled();
    expect(mockPostStatus).not.toHaveBeenCalled();
  });

  it("posts a failure for an actionable Ally comment on the current head", async () => {
    mockListComments.mockResolvedValue([blockingCommentFor(TARGET.headSha)]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    const result = await runPrCommentReviewGateCheck(TARGET);

    expect(result).toMatchObject({ posted: true, verdict: { state: "failure" } });
    expect(mockPostStatus).toHaveBeenCalledWith(expect.objectContaining({
      repoFullName: TARGET.repoFullName,
      sha: TARGET.headSha,
      context: "review/ally-comment-gate",
      state: "failure",
      targetUrl: TARGET.prUrl,
    }));
  });

  it("resolves the current head for an issue_comment webhook", async () => {
    const { headSha: _headSha, ...withoutHeadSha } = TARGET;
    mockFetchHeadSha.mockResolvedValue(TARGET.headSha);
    mockListComments.mockResolvedValue([]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    await expect(runPrCommentReviewGateCheck(withoutHeadSha)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "success" },
    });
    expect(mockFetchHeadSha).toHaveBeenCalledWith({
      repoFullName: TARGET.repoFullName,
      prNumber: TARGET.prNumber,
    });
  });

  it("retries a transient status-write failure", async () => {
    mockListComments.mockResolvedValue([]);
    mockPostStatus
      .mockResolvedValueOnce({ ok: false, retryable: true, reason: "commit_status_write_http_500" })
      .mockResolvedValueOnce({ ok: true, statusCode: 201 });

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({ posted: true });
    expect(mockPostStatus).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("serializes overlapping evaluations for one PR/context", async () => {
    const events: string[] = [];
    let releaseFirstFetch!: () => void;
    const firstFetch = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    let fetchCalls = 0;
    mockListComments.mockImplementation(async () => {
      fetchCalls += 1;
      events.push("fetch");
      if (fetchCalls === 1) await firstFetch;
      return [];
    });
    mockPostStatus.mockImplementation(async () => {
      events.push("post");
      return { ok: true, statusCode: 201 };
    });

    const first = runPrCommentReviewGateCheck(TARGET);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = runPrCommentReviewGateCheck(TARGET);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual(["fetch"]);
    releaseFirstFetch();
    await Promise.all([first, second]);
    expect(events).toEqual(["fetch", "post", "fetch", "post"]);
  });

  // BLO-29711: Ally files its consolidated review as a COMMENTED
  // pull_request_review, not an issue comment. Measured over the 25 most recent
  // PRs in this repo: 33 of 33 consolidated reviews were reviews-API objects and
  // zero were issue comments. A gate reading only issue comments therefore never
  // observed a review, and published a green not-evaluated verdict every time.
  it("reads the reviews surface, where Ally actually files its review", async () => {
    mockListComments.mockResolvedValue([]);
    mockListReviews.mockResolvedValue([blockingCommentFor(TARGET.headSha)]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "failure", outcome: "blocking_finding" },
    });
    expect(mockListReviews).toHaveBeenCalledWith({
      repoFullName: TARGET.repoFullName,
      prNumber: TARGET.prNumber,
    });
  });

  it("merges both surfaces by chronology rather than preferring one", async () => {
    // A blocking review on the reviews surface, superseded by a later clean
    // issue comment for the same head. Newest attestation wins regardless of
    // which surface carried it.
    mockListReviews.mockResolvedValue([blockingCommentFor(TARGET.headSha)]);
    mockListComments.mockResolvedValue([
      {
        login: "allyblockcast[bot]",
        body: `## Ally — Consolidated PR Review\nReviewed head: ${TARGET.headSha}\n### Critical Issues (0)\n### Important Issues (0)`,
        createdAt: "2026-08-04T22:09:19Z",
      },
    ]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "success", outcome: "clean" },
    });
  });

  it("leaves the prior status untouched when the reviews surface cannot be read", async () => {
    // Half the history is not a verdict. Symmetric with the issue-comment path.
    mockListComments.mockResolvedValue([]);
    mockListReviews.mockResolvedValue(null);

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toEqual({
      posted: false,
      reason: "fetch_failed",
    });
    expect(mockPostStatus).not.toHaveBeenCalled();
  }, 10_000);
});

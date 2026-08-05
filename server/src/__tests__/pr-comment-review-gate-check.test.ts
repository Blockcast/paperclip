/**
 * BLO-21907: runPrCommentReviewGateCheck — the live orchestration that fetches
 * a PR's comments + last-push timestamp from GitHub, evaluates
 * evaluateCommentReviewGate (covered in isolation by pr-comment-review-gate.
 * test.ts), and posts the required-check status.
 *
 * These tests mock the GitHub fetch primitives and config, so they assert the
 * wiring — what gets fetched, what gets posted, and how failures at each step
 * are reported — not GitHub HTTP behavior or the gate predicate itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cfg: {
    prCommentReviewGateStatusContext: "",
    prReviewerBotLogin: "allyblockcast[bot]",
  } as Record<string, string>,
}));

vi.mock("../config.js", () => ({ loadConfig: () => h.cfg }));

const mockListComments = vi.hoisted(() => vi.fn());
const mockGetCommittedAt = vi.hoisted(() => vi.fn());
const mockPostStatus = vi.hoisted(() => vi.fn());
const mockFetchHeadSha = vi.hoisted(() => vi.fn());

vi.mock("../services/github-app-auth.js", () => ({
  githubListIssueCommentsWithTimestamps: mockListComments,
  githubGetCommitCommittedAt: mockGetCommittedAt,
  githubPostCommitStatusDetailed: mockPostStatus,
  githubFetchPrHeadSha: mockFetchHeadSha,
  githubReviewerIdentityMatches: (login: string, configuredLogin: string) => {
    const candidate = login.trim().toLowerCase().replace(/^@/, "");
    const configured = configuredLogin.trim().toLowerCase().replace(/^@/, "");
    const appSlug = configured.endsWith("[bot]")
      ? configured.slice(0, -"[bot]".length)
      : configured.startsWith("app/")
        ? configured.slice("app/".length)
        : "";
    return Boolean(appSlug && (candidate === `${appSlug}[bot]` || candidate === `app/${appSlug}`));
  },
}));

import { runPrCommentReviewGateCheck } from "../services/pr-comment-review-gate.js";

const TARGET = {
  repoFullName: "Blockcast/paperclip",
  prNumber: 1022,
  headSha: "1eeab90ae1eeab90ae1eeab90ae1eeab90ae1ee",
  prUrl: "https://github.com/Blockcast/paperclip/pull/1022",
};

beforeEach(() => {
  h.cfg.prCommentReviewGateStatusContext = "review/ally-comment-gate";
  h.cfg.prReviewerBotLogin = "allyblockcast[bot]";
  mockListComments.mockReset();
  mockGetCommittedAt.mockReset();
  mockPostStatus.mockReset();
  mockFetchHeadSha.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runPrCommentReviewGateCheck", () => {
  it("is inert when no context is configured, so the feature ships off", async () => {
    h.cfg.prCommentReviewGateStatusContext = "";
    const result = await runPrCommentReviewGateCheck(TARGET);
    expect(result).toEqual({ posted: false, reason: "not_configured" });
    expect(mockListComments).not.toHaveBeenCalled();
    expect(mockGetCommittedAt).not.toHaveBeenCalled();
    expect(mockPostStatus).not.toHaveBeenCalled();
  });

  it("posts failure and returns the verdict when the latest Ally comment since the push is blocking", async () => {
    mockGetCommittedAt.mockResolvedValue("2026-08-04T18:00:00Z");
    mockListComments.mockResolvedValue([
      {
        login: "allyblockcast[bot]",
        body: "## Ally — Consolidated PR Review\n### Important Issues (1)\nFix before merge.",
        createdAt: "2026-08-04T20:09:19Z",
      },
    ]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    const result = await runPrCommentReviewGateCheck(TARGET);

    expect(result.posted).toBe(true);
    if (result.posted) expect(result.verdict.state).toBe("failure");
    expect(mockFetchHeadSha).not.toHaveBeenCalled();
    expect(mockPostStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: TARGET.repoFullName,
        sha: TARGET.headSha,
        context: "review/ally-comment-gate",
        state: "failure",
        targetUrl: TARGET.prUrl,
      }),
    );
  });

  it("posts success when nothing blocking has landed since the push", async () => {
    mockGetCommittedAt.mockResolvedValue("2026-08-05T00:00:00Z");
    mockListComments.mockResolvedValue([]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    const result = await runPrCommentReviewGateCheck(TARGET);

    expect(result.posted).toBe(true);
    if (result.posted) expect(result.verdict.state).toBe("success");
    expect(mockPostStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "success" }));
  });

  it("ignores spoofed consolidated-review comments from non-Ally authors before posting a verdict", async () => {
    mockGetCommittedAt.mockResolvedValue("2026-08-04T18:00:00Z");
    mockListComments.mockResolvedValue([
      {
        login: "some-contributor",
        body: "## Ally — Consolidated PR Review\n### Important Issues (1)\nFix before merge.",
        createdAt: "2026-08-04T20:09:19Z",
      },
    ]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    const result = await runPrCommentReviewGateCheck(TARGET);

    expect(result.posted).toBe(true);
    if (result.posted) expect(result.verdict.state).toBe("success");
    expect(mockPostStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "success" }));
  });

  it("reports fetch_failed and posts nothing when GitHub fetch fails, rather than guessing a verdict", async () => {
    mockGetCommittedAt.mockResolvedValue(null);
    mockListComments.mockResolvedValue([]);

    const result = await runPrCommentReviewGateCheck(TARGET);

    expect(result).toEqual({ posted: false, reason: "fetch_failed" });
    expect(mockPostStatus).not.toHaveBeenCalled();
  });

  it("reports post_failed with the underlying reason when the status write fails", async () => {
    mockGetCommittedAt.mockResolvedValue("2026-08-05T00:00:00Z");
    mockListComments.mockResolvedValue([]);
    mockPostStatus.mockResolvedValue({ ok: false, retryable: true, reason: "commit_status_write_http_500" });

    const result = await runPrCommentReviewGateCheck(TARGET);

    expect(result).toEqual({
      posted: false,
      reason: "post_failed",
      postFailure: "commit_status_write_http_500",
    });
  });

  it("resolves the current head SHA when the caller has none — the issue_comment trigger path", async () => {
    const { headSha: _omit, ...withoutHeadSha } = TARGET;
    mockFetchHeadSha.mockResolvedValue(TARGET.headSha);
    mockGetCommittedAt.mockResolvedValue("2026-08-05T00:00:00Z");
    mockListComments.mockResolvedValue([]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    const result = await runPrCommentReviewGateCheck(withoutHeadSha);

    expect(mockFetchHeadSha).toHaveBeenCalledWith({
      repoFullName: TARGET.repoFullName,
      prNumber: TARGET.prNumber,
    });
    expect(mockGetCommittedAt).toHaveBeenCalledWith(
      expect.objectContaining({ sha: TARGET.headSha }),
    );
    expect(result.posted).toBe(true);
  });

  it("reports fetch_failed when the head SHA cannot be resolved, rather than guessing a commit to post against", async () => {
    const { headSha: _omit, ...withoutHeadSha } = TARGET;
    mockFetchHeadSha.mockResolvedValue(null);

    const result = await runPrCommentReviewGateCheck(withoutHeadSha);

    expect(result).toEqual({ posted: false, reason: "fetch_failed" });
    expect(mockGetCommittedAt).not.toHaveBeenCalled();
    expect(mockPostStatus).not.toHaveBeenCalled();
  });
});

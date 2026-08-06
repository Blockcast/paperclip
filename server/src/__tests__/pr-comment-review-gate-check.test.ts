/**
 * BLO-21907: runPrCommentReviewGateCheck — the live orchestration that fetches
 * a PR's comments + current head SHA from GitHub, evaluates
 * evaluateCommentReviewGate (covered in isolation by pr-comment-review-gate.
 * test.ts), and posts the required-check status.
 *
 * These tests mock the GitHub fetch primitives and config, so they assert the
 * wiring — what gets fetched, what gets posted, how failures at each step are
 * reported and retried, and that overlapping evaluations for the same
 * (repo, PR, context) serialize rather than race — not GitHub HTTP behavior
 * or the gate predicate itself.
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
const mockPostStatus = vi.hoisted(() => vi.fn());
const mockFetchHeadSha = vi.hoisted(() => vi.fn());

vi.mock("../services/github-app-auth.js", () => ({
  githubListIssueCommentsWithTimestamps: mockListComments,
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
    expect(mockPostStatus).not.toHaveBeenCalled();
  });

  it("posts failure and returns the verdict when the latest Ally comment for this head is blocking", async () => {
    mockListComments.mockResolvedValue([blockingCommentFor(TARGET.headSha)]);
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

  it("posts success when nothing blocking has landed for this head", async () => {
    mockListComments.mockResolvedValue([]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    const result = await runPrCommentReviewGateCheck(TARGET);

    expect(result.posted).toBe(true);
    if (result.posted) expect(result.verdict.state).toBe("success");
    expect(mockPostStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "success" }));
  });

  it("ignores spoofed consolidated-review comments from non-Ally authors before posting a verdict", async () => {
    mockListComments.mockResolvedValue([{ ...blockingCommentFor(TARGET.headSha), login: "some-contributor" }]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    const result = await runPrCommentReviewGateCheck(TARGET);

    expect(result.posted).toBe(true);
    if (result.posted) expect(result.verdict.state).toBe("success");
    expect(mockPostStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "success" }));
  });

  it("does not block on a comment attesting to a different (superseded) head", async () => {
    mockListComments.mockResolvedValue([blockingCommentFor("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    const result = await runPrCommentReviewGateCheck(TARGET);

    expect(result.posted).toBe(true);
    if (result.posted) expect(result.verdict.state).toBe("success");
  });

  it("resolves the current head SHA when the caller has none — the issue_comment trigger path", async () => {
    const { headSha: _omit, ...withoutHeadSha } = TARGET;
    mockFetchHeadSha.mockResolvedValue(TARGET.headSha);
    mockListComments.mockResolvedValue([]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    const result = await runPrCommentReviewGateCheck(withoutHeadSha);

    expect(mockFetchHeadSha).toHaveBeenCalledWith({
      repoFullName: TARGET.repoFullName,
      prNumber: TARGET.prNumber,
    });
    expect(result.posted).toBe(true);
  });

  it("reports fetch_failed when the head SHA cannot be resolved after retrying, rather than guessing a commit to post against", async () => {
    const { headSha: _omit, ...withoutHeadSha } = TARGET;
    mockFetchHeadSha.mockResolvedValue(null);

    const result = await runPrCommentReviewGateCheck(withoutHeadSha);

    expect(result).toEqual({ posted: false, reason: "fetch_failed" });
    expect(mockFetchHeadSha.mock.calls.length).toBeGreaterThan(1);
    expect(mockListComments).not.toHaveBeenCalled();
    expect(mockPostStatus).not.toHaveBeenCalled();
  }, 10_000);

  it("retries a transient comment-fetch failure and succeeds once GitHub recovers", async () => {
    mockListComments.mockResolvedValueOnce(null).mockResolvedValueOnce([]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    const result = await runPrCommentReviewGateCheck(TARGET);

    expect(mockListComments).toHaveBeenCalledTimes(2);
    expect(result.posted).toBe(true);
  });

  it("reports fetch_failed and posts nothing after exhausting retries on a persistent comment-fetch failure", async () => {
    mockListComments.mockResolvedValue(null);

    const result = await runPrCommentReviewGateCheck(TARGET);

    expect(result).toEqual({ posted: false, reason: "fetch_failed" });
    expect(mockListComments.mock.calls.length).toBeGreaterThan(1);
    expect(mockPostStatus).not.toHaveBeenCalled();
  }, 10_000);

  it("retries a retryable status-write failure and eventually posts", async () => {
    mockListComments.mockResolvedValue([]);
    mockPostStatus
      .mockResolvedValueOnce({ ok: false, retryable: true, reason: "commit_status_write_http_500" })
      .mockResolvedValueOnce({ ok: true, statusCode: 201 });

    const result = await runPrCommentReviewGateCheck(TARGET);

    expect(mockPostStatus).toHaveBeenCalledTimes(2);
    expect(result.posted).toBe(true);
  });

  it("reports post_failed with the underlying reason when the status write fails non-retryably", async () => {
    mockListComments.mockResolvedValue([]);
    mockPostStatus.mockResolvedValue({ ok: false, retryable: false, reason: "commit_status_write_http_422" });

    const result = await runPrCommentReviewGateCheck(TARGET);

    expect(result).toEqual({
      posted: false,
      reason: "post_failed",
      postFailure: "commit_status_write_http_422",
    });
    expect(mockPostStatus).toHaveBeenCalledTimes(1);
  });

  it("serializes overlapping evaluations for the same repo/PR/context so a slow run cannot fetch before an earlier one has posted", async () => {
    const events: string[] = [];
    let releaseFirstFetch!: () => void;
    const firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    let fetchCalls = 0;

    mockListComments.mockImplementation(async () => {
      fetchCalls += 1;
      events.push("fetch-comments");
      if (fetchCalls === 1) await firstFetchGate;
      return [];
    });
    mockPostStatus.mockImplementation(async () => {
      events.push("post-status");
      return { ok: true, statusCode: 201 };
    });

    const call1 = runPrCommentReviewGateCheck(TARGET);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const call2 = runPrCommentReviewGateCheck(TARGET);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // call2 must not have started its own fetch yet — it's waiting for call1's
    // full fetch+post critical section to finish first.
    expect(events).toEqual(["fetch-comments"]);

    releaseFirstFetch();
    await Promise.all([call1, call2]);

    expect(events).toEqual(["fetch-comments", "post-status", "fetch-comments", "post-status"]);
  });

  it("does not serialize evaluations for different PRs", async () => {
    mockListComments.mockResolvedValue([]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    const [resultA, resultB] = await Promise.all([
      runPrCommentReviewGateCheck(TARGET),
      runPrCommentReviewGateCheck({ ...TARGET, prNumber: TARGET.prNumber + 1 }),
    ]);

    expect(resultA.posted).toBe(true);
    expect(resultB.posted).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cfg: {
    prCommentReviewGateStatusContext: "",
    prCommentReviewGateRetiredStatusContexts: [] as string[],
    prReviewerBotLogin: "allyblockcast[bot]",
  } as Record<string, unknown> & {
    prCommentReviewGateStatusContext: string;
    prCommentReviewGateRetiredStatusContexts: string[];
    prReviewerBotLogin: string;
  },
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
  h.cfg.prCommentReviewGateRetiredStatusContexts = [];
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

// BLO-29711 AC#1. The gate moved off `review/ally-comment` to
// `gate/ally-comment-findings`, but commit statuses cannot be deleted: every
// head already stamped with the old context keeps showing its fail-open green
// forever (42 of 43 open penstock PRs, measured 2026-08-22). Only the
// credential that wrote those rows can overwrite them, which is this App's
// installation token — so the supersede has to ride the gate's own evaluations.
describe("retired status contexts", () => {
  beforeEach(() => {
    h.cfg.prCommentReviewGateStatusContext = "gate/ally-comment-findings";
    h.cfg.prCommentReviewGateRetiredStatusContexts = ["review/ally-comment"];
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });
  });

  function postFor(context: string) {
    return mockPostStatus.mock.calls.map(([arg]) => arg).find((arg) => arg.context === context);
  }

  it("supersedes the retired context with a pointer carrying no not-evaluated claim", async () => {
    // The exact pre-rename state: nothing attests the head, so the live gate
    // legitimately goes green under `gate/`. The stale `review/` row must stop
    // asserting that nothing reviewed the head.
    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "success", outcome: "not_evaluated" },
    });

    expect(postFor("gate/ally-comment-findings")).toMatchObject({
      state: "success",
      description: "No Ally consolidated-review comment attests to reviewing this head.",
    });

    const retired = postFor("review/ally-comment");
    expect(retired).toMatchObject({ sha: TARGET.headSha, state: "success" });
    // This is what the census greps for. A retirement pointer that still
    // admitted "nothing attests" would leave AC#1 failing under the old name.
    expect(retired?.description).not.toMatch(
      /no Ally consolidated-review comment attests|no head SHA was supplied/i,
    );
    expect(retired?.description).toContain("gate/ally-comment-findings");
    expect(retired?.description.length).toBeLessThanOrEqual(140);
  });

  it("does not overwrite the live verdict when the live context is also listed as retired", async () => {
    // A misconfiguration that would otherwise replace a real `failure` with a
    // green pointer — the exact fail-open this issue exists to remove.
    h.cfg.prCommentReviewGateRetiredStatusContexts = [
      "review/ally-comment",
      "gate/ally-comment-findings",
    ];
    mockListReviews.mockResolvedValue([blockingCommentFor(TARGET.headSha)]);

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "failure", outcome: "blocking_finding" },
    });

    const liveWrites = mockPostStatus.mock.calls
      .map(([arg]) => arg)
      .filter((arg) => arg.context === "gate/ally-comment-findings");
    expect(liveWrites).toHaveLength(1);
    expect(liveWrites[0]).toMatchObject({ state: "failure" });
  });

  it("still publishes the live verdict when superseding a retired context fails", async () => {
    // Cleanup of a superseded row must never be able to break the live signal.
    mockPostStatus.mockImplementation(async ({ context }: { context: string }) =>
      context === "review/ally-comment"
        ? { ok: false, retryable: false, reason: "commit_status_write_http_403" }
        : { ok: true, statusCode: 201 },
    );

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({ posted: true });
    expect(postFor("gate/ally-comment-findings")).toBeDefined();
  });

  it("writes nothing extra when no context is retired", async () => {
    h.cfg.prCommentReviewGateRetiredStatusContexts = [];

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({ posted: true });
    expect(mockPostStatus).toHaveBeenCalledTimes(1);
  });
});

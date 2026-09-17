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
const mockFetchPrAuthor = vi.hoisted(() => vi.fn());
const mockPostStatus = vi.hoisted(() => vi.fn());
const mockPostCheckRun = vi.hoisted(() => vi.fn());
const mockStatusDeliveryLock = vi.hoisted(() => vi.fn());

// Only the network calls are mocked. The identity predicates are imported for
// real via `importOriginal`: they are pure, and the hand-rolled copy this mock
// used to carry could drift from the shipped one — which is precisely the class
// of bug this suite exists to catch.
vi.mock("../services/github-app-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/github-app-auth.js")>()),
  githubFetchPrHeadSha: mockFetchHeadSha,
  githubFetchPrAuthorLogin: mockFetchPrAuthor,
  githubListIssueCommentsWithTimestamps: mockListComments,
  githubListPrReviewsWithTimestamps: mockListReviews,
  githubPostCommitStatusDetailed: mockPostStatus,
  githubPostCheckRun: mockPostCheckRun,
}));

vi.mock("../services/github-status-delivery-outbox.js", () => ({
  withGithubStatusDeliveryLock: mockStatusDeliveryLock,
}));

import { runPrCommentReviewGateCheck } from "../services/pr-comment-review-gate.js";

// `db` is required on the input: the gate takes the shared delivery lock
// unconditionally, so every caller — including these tests — must supply a
// handle. The lock itself is mocked above, so a stub is sufficient here.
const TARGET = {
  repoFullName: "Blockcast/paperclip",
  prNumber: 1022,
  headSha: "1234567890abcdef1234567890abcdef12345678",
  prUrl: "https://github.com/Blockcast/paperclip/pull/1022",
  db: {} as never,
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
  mockFetchPrAuthor.mockReset();
  mockPostStatus.mockReset();
  mockPostCheckRun.mockReset();
  mockStatusDeliveryLock.mockReset();
  mockStatusDeliveryLock.mockImplementation(async (_db, _key, operation) => operation());
  // Default both surfaces to empty; each test overrides the one it exercises.
  mockListComments.mockResolvedValue([]);
  mockListReviews.mockResolvedValue([]);
  // A PR author who is not the reviewer identity, so the existing fixtures keep
  // their meaning; the self-attestation tests override it (BLO-34316).
  mockFetchPrAuthor.mockResolvedValue("some-contributor");
  mockPostCheckRun.mockResolvedValue({ ok: true, statusCode: 201 });
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

  it("reads and evaluates evidence inside the shared delivery lock", async () => {
    const events: string[] = [];
    mockStatusDeliveryLock.mockImplementation(async (_db, _key, operation) => {
      events.push("lock");
      return operation();
    });
    mockListComments.mockImplementation(async () => {
      events.push("fetch-comments");
      return [blockingCommentFor(TARGET.headSha)];
    });
    mockPostStatus.mockImplementation(async () => {
      events.push("post");
      return { ok: true, statusCode: 201 };
    });

    await runPrCommentReviewGateCheck({ ...TARGET, db: {} as never });

    expect(events).toEqual(["lock", "fetch-comments", "post"]);
  });

  it("refuses to publish unsynchronized when db is missing", async () => {
    mockListComments.mockResolvedValue([]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    // The old shape fell through to an unlocked publish() whenever db was
    // absent, so a caller could silently reopen the out-of-order-verdict race.
    // Absence must now fail closed: no lock, no status write, and a loud error
    // rather than a green nobody serialized.
    await expect(
      runPrCommentReviewGateCheck({ ...TARGET, db: undefined } as never),
    ).rejects.toThrow(/requires `db`/);

    expect(mockStatusDeliveryLock).not.toHaveBeenCalled();
    expect(mockPostStatus).not.toHaveBeenCalled();
  });

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

  it("publishes neutral, not success, when the PR author wrote the attestation", async () => {
    // BLO-34316. The live shape: agent PRs and agent reviews carry the same App
    // identity, so the author's own comment reached the gate's strongest green.
    mockFetchPrAuthor.mockResolvedValue("allyblockcast[bot]");
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
      verdict: { state: "success", outcome: "not_evaluated" },
    });
    expect(mockFetchPrAuthor).toHaveBeenCalledWith({
      repoFullName: TARGET.repoFullName,
      prNumber: TARGET.prNumber,
    });
    expect(mockPostCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: "neutral" }),
    );
    // Non-blocking on the status surface (BLO-29711): never pending/failure.
    expect(mockPostStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "success" }));
  });

  it("leaves the prior status untouched when the PR author cannot be read", async () => {
    // Publishing on incomplete evidence would overwrite a correct earlier
    // verdict with a weaker one on a transient failure. Same shape as an
    // unreadable comment surface. The comment must be a CLEAN attestation:
    // that is the only outcome whose verdict depends on the author, so it is
    // the only one where an unreadable author may withhold a publish.
    mockFetchPrAuthor.mockResolvedValue(null);
    mockListComments.mockResolvedValue([
      {
        login: "allyblockcast[bot]",
        body: `## Ally — Consolidated PR Review\nReviewed head: ${TARGET.headSha}\n### Critical Issues (0)\n### Important Issues (0)`,
        createdAt: "2026-08-04T22:09:19Z",
      },
    ]);

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toEqual({
      posted: false,
      reason: "fetch_failed",
    });
    expect(mockPostStatus).not.toHaveBeenCalled();
  }, 10_000);

  it("still publishes a red when the PR author cannot be read", async () => {
    // Regression: the author fetch was an unconditional precondition for
    // publishing ANY verdict, so a transient failure on `GET /pulls/{n}` —
    // while the comment surfaces stayed healthy — dropped a `failure` the
    // previous code published. No status had ever existed for the head, so the
    // merge surface showed the finding as absent rather than red.
    mockFetchPrAuthor.mockResolvedValue(null);
    mockListComments.mockResolvedValue([blockingCommentFor(TARGET.headSha)]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "failure", outcome: "blocking_finding" },
    });
    expect(mockPostStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "failure" }));
    // Both reds are author-blind, so the fetch is never even attempted.
    expect(mockFetchPrAuthor).not.toHaveBeenCalled();
  });

  it("still publishes a carried finding when the PR author cannot be read", async () => {
    // The other author-blind red. A finding raised against an earlier head
    // carries forward (BLO-29711); it must not go silent on an author fetch.
    mockFetchPrAuthor.mockResolvedValue(null);
    mockListComments.mockResolvedValue([blockingCommentFor("0".repeat(40))]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "failure", outcome: "carried_finding" },
    });
    expect(mockFetchPrAuthor).not.toHaveBeenCalled();
  });

  it("does not fetch the PR author when nothing attests the head", async () => {
    // `not_evaluated` for "no comment attests this head" is reached from the
    // comment surfaces alone, so it costs no request inside the serialized lock.
    mockListComments.mockResolvedValue([]);
    mockListReviews.mockResolvedValue([]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "success", outcome: "not_evaluated" },
    });
    expect(mockFetchPrAuthor).not.toHaveBeenCalled();
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

  it("reports retirement failure after publishing the live verdict", async () => {
    // Cleanup of a superseded row must never overwrite the live signal, but a
    // failed retirement write must remain visible so a later webhook can retry
    // it instead of silently leaving a required legacy row stale.
    mockPostStatus.mockImplementation(async ({ context }: { context: string }) =>
      context === "review/ally-comment"
        ? { ok: false, retryable: false, reason: "commit_status_write_http_403" }
        : { ok: true, statusCode: 201 },
    );

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: false,
      // `retirement_failed`, not `post_failed`: the live verdict below DID
      // publish. The two states must be distinguishable without inspecting
      // `retirementDeliveries`.
      reason: "retirement_failed",
      postFailure: "review/ally-comment: commit_status_write_http_403",
    });
    expect(postFor("gate/ally-comment-findings")).toBeDefined();
  });

  it("writes nothing extra when no context is retired", async () => {
    h.cfg.prCommentReviewGateRetiredStatusContexts = [];

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({ posted: true });
    expect(mockPostStatus).toHaveBeenCalledTimes(1);
  });
});

describe("check-run mirror (BLO-33657)", () => {
  const clean = {
    login: "allyblockcast[bot]",
    body:
      `## Ally — Consolidated PR Review\nReviewed head: ${TARGET.headSha}\n` +
      "### Critical Issues (0)\n### Important Issues (0)",
    createdAt: "2026-09-13T05:00:00Z",
  };

  it("mirrors the verdict as a check-run alongside the commit status", async () => {
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });
    mockListComments.mockResolvedValue([clean]);

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({ posted: true });

    expect(mockPostCheckRun).toHaveBeenCalledTimes(1);
    expect(mockPostCheckRun.mock.calls[0][0]).toMatchObject({
      sha: TARGET.headSha,
      name: "review/ally-comment-gate",
      conclusion: "success",
    });
  });

  it("publishes neutral, not success, when nothing attests the head", async () => {
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({ posted: true });

    // The commit status is green here and has to stay green — going non-green
    // on absence deadlocks formally-reviewed PRs (BLO-29711). The check-run is
    // what carries the distinction.
    expect(mockPostStatus.mock.calls[0][0]).toMatchObject({ state: "success" });
    expect(mockPostCheckRun.mock.calls[0][0]).toMatchObject({ conclusion: "neutral" });
  });

  it("does not fail the check when the check-run write is refused", async () => {
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });
    mockPostCheckRun.mockResolvedValue({ ok: false, retryable: false, reason: "check_run_write_http_403" });

    // An installation without `checks: write` must keep the working status
    // surface rather than losing it to the surface that is only nicer.
    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({ posted: true });
  });

  it("does not fail the check when the check-run write throws", async () => {
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });
    mockPostCheckRun.mockRejectedValue(new Error("githubPostCheckRun is not a function"));

    // "Best-effort" has to survive a thrown error too, not just a classified
    // failure result — otherwise the rejection escapes and takes down the
    // commit status that was already published.
    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({ posted: true });
    expect(mockPostStatus).toHaveBeenCalled();
  });
});

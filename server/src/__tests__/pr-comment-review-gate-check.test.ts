import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { admitsNothingEvaluated } from "../../../scripts/check-comment-review-gate-census.mjs";

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
const mockFetchCommitAuthorEmail = vi.hoisted(() => vi.fn());
const mockPostStatus = vi.hoisted(() => vi.fn());
const mockPostCheckRun = vi.hoisted(() => vi.fn());
const mockListOpenPrsAtHead = vi.hoisted(() => vi.fn());
const mockStatusDeliveryLock = vi.hoisted(() => vi.fn());

// Only the network calls are mocked. The identity predicates are imported for
// real via `importOriginal`: they are pure, and the hand-rolled copy this mock
// used to carry could drift from the shipped one — which is precisely the class
// of bug this suite exists to catch.
vi.mock("../services/github-app-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/github-app-auth.js")>()),
  githubFetchPrHeadSha: mockFetchHeadSha,
  githubFetchPrAuthorLogin: mockFetchPrAuthor,
  githubFetchCommitAuthorEmail: mockFetchCommitAuthorEmail,
  githubListIssueCommentsWithTimestamps: mockListComments,
  githubListPrReviewsWithTimestamps: mockListReviews,
  githubPostCommitStatusDetailed: mockPostStatus,
  githubPostCheckRun: mockPostCheckRun,
  githubListOpenPullRequestsForHeadSha: mockListOpenPrsAtHead,
}));

vi.mock("../services/github-status-delivery-outbox.js", () => ({
  withGithubStatusDeliveryLock: mockStatusDeliveryLock,
}));

import { admitsNothingEvaluated } from "../../../scripts/check-comment-review-gate-census.mjs";
import { gitHubIdentityFieldRedaction, scrubOutboundGitHubText } from "../services/github-app-auth.js";
import {
  ALLY_HEAD_ATTESTED_CHECK_NAME,
  allyHeadAttestedCheckConclusion,
  allyHeadAttestedCheckSummary,
  allyHeadAttestedCheckTitle,
  commentReviewGateCheckConclusion,
  commentReviewGateCheckTitle,
  commentReviewGateRetirementStatus,
  evaluateCommentReviewGate,
  runPrCommentReviewGateCheck,
  type CommentReviewGateVerdict,
} from "../services/pr-comment-review-gate.js";

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

function cleanCommentFor(headSha: string, createdAt = "2026-08-04T22:09:19Z") {
  return {
    login: "allyblockcast[bot]",
    body: `## Ally — Consolidated PR Review\nReviewed head: ${headSha}\n### Critical Issues (0)\n### Important Issues (0)`,
    createdAt,
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
  mockFetchCommitAuthorEmail.mockReset();
  mockPostStatus.mockReset();
  mockPostCheckRun.mockReset();
  mockListOpenPrsAtHead.mockReset();
  mockStatusDeliveryLock.mockReset();
  mockStatusDeliveryLock.mockImplementation(async (_db, _key, operation) => operation());
  // Default both surfaces to empty; each test overrides the one it exercises.
  mockListComments.mockResolvedValue([]);
  mockListReviews.mockResolvedValue([]);
  // A PR author who is not the reviewer identity, so the existing fixtures keep
  // their meaning; the self-attestation tests override it (BLO-34316).
  mockFetchPrAuthor.mockResolvedValue("some-contributor");
  // Throws rather than resolving, so a future lane-declaring case that forgets
  // to stub it fails loudly and IMMEDIATELY. Left unstubbed it resolves
  // `undefined`, which is `== null`, so it burned 1.25 s of real sleep in
  // `withBoundedRetry` and then took the credit-the-retirement path — the one
  // outcome a lane test must never reach by accident. `withBoundedRetry` does
  // not catch, so a throw costs neither a retry nor a sleep (Ally review of
  // #2498). Matches the same dep's default in `evidence-truth.test.ts`.
  mockFetchCommitAuthorEmail.mockImplementation(() => {
    throw new Error("githubFetchCommitAuthorEmail: this case declares a reviewer lane and did not stub the fetch");
  });
  mockPostCheckRun.mockResolvedValue({ ok: true, statusCode: 201 });
  // The ordinary shape: this PR is the only open one at its head, so the
  // SHA-scoped sweep (PEN-3818) finds no peer and leaves the verdict alone.
  // Stubbed as a DEFAULT rather than per-case because the sweep runs on every
  // `success`, and an unstubbed enumeration would fail closed and silently turn
  // each of this suite's green cases into `fetch_failed`.
  mockListOpenPrsAtHead.mockResolvedValue({
    pullRequests: [{ number: TARGET.prNumber, url: TARGET.prUrl }],
  });
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

  it("a later clean issue comment cannot displace a blocking review submission", async () => {
    // The displacement hole (Ally, #2875 at 5359c08e, Important 1). Narrowing
    // what a body may CLAIM was not enough on its own: ordering decided WHICH
    // body is read, it was keyed on recency alone, and displacing is retiring
    // by another name. So a clean issue comment posted after a blocking review
    // at the same head took the head's slot, the blocking branch never ran,
    // and an `issues: write` principal still moved the merge-facing status off
    // `failure` — only the label moved, from `clean` to `not_evaluated`.
    //
    // Half one: the blocking review is newer-surface, so it keeps the slot and
    // the finding is still reported, whatever arrives after it on the weaker
    // surface.
    const cleanBody = `## Ally — Consolidated PR Review\nReviewed head: ${TARGET.headSha}\n### Critical Issues (0)\n### Important Issues (0)`;
    mockListReviews.mockResolvedValue([blockingCommentFor(TARGET.headSha)]);
    mockListComments.mockResolvedValue([
      { login: "allyblockcast[bot]", body: cleanBody, createdAt: "2026-08-04T22:09:19Z" },
    ]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "failure", outcome: "blocking_finding" },
    });

    // Half two, the mirror: the SAME two bodies with their surfaces swapped.
    // Here the later clean body is a review submission and the older blocking
    // one is an issue comment, so the review legitimately disposes it and the
    // gate reaches `clean`. This is what keeps half one honest — it pins the
    // rule to the surface precedence rather than to "a finding always wins".
    mockListReviews.mockResolvedValue([
      { login: "allyblockcast[bot]", body: cleanBody, createdAt: "2026-08-04T22:09:19Z" },
    ]);
    mockListComments.mockResolvedValue([blockingCommentFor(TARGET.headSha)]);

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "success", outcome: "clean" },
    });
  });

  it("an issue comment carrying a finding still blocks a clean review it post-dates", async () => {
    // The guard on the fix above: the surface rank decides only who may make
    // the POSITIVE claim. A finding blocks from either surface, so an issue
    // comment NEWER than the winning review submission stays eligible to
    // carry one. Without this, ranking review submissions first would have
    // bought the displacement fix at the price of a fresh fail-open in the
    // other direction.
    mockListReviews.mockResolvedValue([cleanCommentFor(TARGET.headSha, "2026-08-04T20:09:19Z")]);
    mockListComments.mockResolvedValue([
      {
        ...blockingCommentFor(TARGET.headSha),
        createdAt: "2026-08-04T22:09:19Z",
      },
    ]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "failure", outcome: "blocking_finding" },
    });
  });

  it("a later clean issue comment cannot retire a finding carried from an earlier head", async () => {
    // The same displacement mechanism reaching BACK a head, which is the half
    // that survives a push: the gate is evaluating the current head, and the
    // finding it must carry was raised against OLD. A clean issue comment
    // attesting OLD displaced OLD's blocking review inside the per-head pick,
    // so OLD dropped out of the carry set and the red disappeared — without
    // anything ever claiming the current head was reviewed.
    const OLD = "0".repeat(40);
    mockListReviews.mockResolvedValue([blockingCommentFor(OLD)]);
    mockListComments.mockResolvedValue([cleanCommentFor(OLD, "2026-08-04T22:09:19Z")]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "failure", outcome: "carried_finding", carriedFromHeadSha: OLD },
    });
  });

  it("a tracked ledger line in an issue comment cannot clear a carried red", async () => {
    // Ally, #2875 at 5359c08e, Important 2. `deferred_finding` is only less
    // positive than `clean`; against `carried_finding` it is a PROMOTION, and
    // it was RETURNED rather than held, so `headsWithUndispositionedFinding`
    // never ran. One issue comment attesting the current head and carrying a
    // single `tracked` line therefore turned an earlier head's red green —
    // `countAllyDeferredPriorFindings` counts the line whether or not it names
    // a real finding, and the ledger that correctly REFUSES that entry off the
    // issue-comment surface was downstream of the return.
    const OLD = "0".repeat(40);
    mockFetchPrAuthor.mockResolvedValue("some-contributor");
    mockListReviews.mockResolvedValue([blockingCommentFor(OLD)]);
    mockListComments.mockResolvedValue([
      {
        login: "allyblockcast[bot]",
        body: [
          "## Ally — Consolidated PR Review",
          `Reviewed head: ${TARGET.headSha}`,
          "### Prior Findings Dispositioned (1)",
          `- **prior:${OLD.slice(0, 7)} important 1** — tracked — accepted onto a follow-up.`,
          "### Critical Issues (0)",
          "### Important Issues (0)",
        ].join("\n"),
        createdAt: "2026-08-04T22:09:19Z",
      },
    ]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "failure", outcome: "carried_finding" },
    });
  });

  it("still reports a deferral off the issue-comment surface once nothing carries", async () => {
    // The other half of holding rather than suppressing it. With no carried
    // red to outrank, the held deferral is returned unchanged — so the
    // evidence probe still hears the veto it reads on a clean vouch, and the
    // `ci/ally-head-attested` schedule signal still sees an attested head.
    // Suppressing the deferral off this surface would have been a fail-OPEN,
    // which is the direction this module must not get wrong.
    const OLD = "0".repeat(40);
    mockFetchPrAuthor.mockResolvedValue("some-contributor");
    mockListReviews.mockResolvedValue([]);
    mockListComments.mockResolvedValue([
      {
        login: "allyblockcast[bot]",
        body: [
          "## Ally — Consolidated PR Review",
          `Reviewed head: ${TARGET.headSha}`,
          "### Prior Findings Dispositioned (1)",
          `- **prior:${OLD.slice(0, 7)} important 1** — tracked — accepted onto a follow-up.`,
          "### Critical Issues (0)",
          "### Important Issues (0)",
        ].join("\n"),
        createdAt: "2026-08-04T22:09:19Z",
      },
    ]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "success", outcome: "deferred_finding" },
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

  it("clears a carried finding when a DISTINCT author's comment attests the head", async () => {
    // BLO-34316 regression. The carried-finding branch consumes the withheld
    // positive, so gating the author fetch on `outcome === "not_evaluated"`
    // never fetched here — and `clean` is unreachable on the author-blind pass
    // by construction. Result was a green->red flip on a merge-blocking status
    // for a head an independent reviewer did attest.
    mockFetchPrAuthor.mockResolvedValue("some-contributor");
    // On the reviews surface: this case is about the AUTHOR, and after
    // PEN-4431 a positive claim needs a review submission, so carrying it as
    // an issue comment would make the fixture fail for a reason that has
    // nothing to do with what it tests.
    mockListReviews.mockResolvedValue([
      blockingCommentFor("0".repeat(40)),
      cleanCommentFor(TARGET.headSha),
    ]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "success", outcome: "clean" },
    });
    expect(mockFetchPrAuthor).toHaveBeenCalledWith({
      repoFullName: TARGET.repoFullName,
      prNumber: TARGET.prNumber,
    });
  });

  it("tells a self-attesting author why their attestation did not clear the carry", async () => {
    // Same input, author == reviewer identity. The red is correct here, but it
    // must name the real reason: before the fetch reached this route the tail
    // always rendered "not known to be independent", asserting the author was
    // unreadable when it had simply never been requested.
    mockFetchPrAuthor.mockResolvedValue("allyblockcast[bot]");
    mockListComments.mockResolvedValue([
      blockingCommentFor("0".repeat(40)),
      cleanCommentFor(TARGET.headSha),
    ]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "failure", outcome: "carried_finding" },
    });
    expect(mockPostStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "failure",
        description: expect.stringContaining("the only comment attesting it is the PR author's own"),
      }),
    );
  });

  it("publishes a carried finding whose author fetch failed rather than going silent", async () => {
    // The fetch is now reached on a `failure` too, so its failure handling has
    // to branch on `verdict.state`: withholding a red on an unreadable author
    // would drop a finding the comment surfaces already justify.
    mockFetchPrAuthor.mockResolvedValue(null);
    mockListComments.mockResolvedValue([
      blockingCommentFor("0".repeat(40)),
      cleanCommentFor(TARGET.headSha),
    ]);
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "failure", outcome: "carried_finding" },
    });
    expect(mockFetchPrAuthor).toHaveBeenCalled();
  }, 10_000);

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

  // ── PEN-3818: the verdict is a property of the SHA, not of one pull request ──
  //
  // A commit status is keyed by SHA; the verdict was computed from one PR's
  // review history. Opening any PR at a victim's head SHA therefore published
  // that new PR's legitimately fail-open green over the victim's red findings
  // gate. Reproduced against production on 2026-10-05 with one `gh pr create`,
  // and it did not self-heal — closing the probe PR left the false green
  // standing.
  describe("SHA-scoped verdict (PEN-3818)", () => {
    const PROBE_PR = { number: 2247, url: "https://github.com/Blockcast/paperclip/pull/2247" };
    const VICTIM_PR = { number: 2202, url: "https://github.com/Blockcast/paperclip/pull/2202" };

    it("refuses to clear a peer PR's red findings gate from a probe PR at the same head", async () => {
      // The exact reproduction. The probe is #2247: brand new, no review of any
      // kind, so its own history reaches "No Ally consolidated-review comment
      // attests to reviewing this head" — a true statement about #2247 and a
      // `success`. #2202 shares the head and carries an unresolved finding.
      mockListOpenPrsAtHead.mockResolvedValue({ pullRequests: [PROBE_PR, VICTIM_PR] });
      mockListComments.mockImplementation(async ({ prNumber }: { prNumber: number }) =>
        prNumber === VICTIM_PR.number ? [blockingCommentFor(TARGET.headSha)] : [],
      );
      mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

      const result = await runPrCommentReviewGateCheck({
        ...TARGET,
        prNumber: PROBE_PR.number,
        prUrl: PROBE_PR.url,
      });

      expect(result).toMatchObject({ posted: true, verdict: { state: "failure" } });
      expect(mockPostStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          sha: TARGET.headSha,
          context: "review/ally-comment-gate",
          state: "failure",
          // Retargeted at the PR whose review justifies the red, so a reader
          // following the status lands on #2202 and not on the throwaway that
          // happened to evaluate last.
          targetUrl: VICTIM_PR.url,
        }),
      );
    });

    it("retargets every artifact at this head, not only the commit status", async () => {
      h.cfg.prCommentReviewGateRetiredStatusContexts = ["review/ally-comment"];
      mockListOpenPrsAtHead.mockResolvedValue({ pullRequests: [PROBE_PR, VICTIM_PR] });
      mockListComments.mockImplementation(async ({ prNumber }: { prNumber: number }) =>
        prNumber === VICTIM_PR.number ? [blockingCommentFor(TARGET.headSha)] : [],
      );
      mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

      await runPrCommentReviewGateCheck({ ...TARGET, prNumber: PROBE_PR.number, prUrl: PROBE_PR.url });

      // The retired context is mirrored from the same verdict, so it must carry
      // the adopted red too: it may still be the required check somewhere
      // (BLO-26602), and leaving it green there would reopen the bypass through
      // the legacy context.
      expect(mockPostStatus).toHaveBeenCalledWith(
        expect.objectContaining({ context: "review/ally-comment", state: "failure", targetUrl: VICTIM_PR.url }),
      );
      for (const call of mockPostCheckRun.mock.calls) {
        expect(call[0]).toMatchObject({ sha: TARGET.headSha, detailsUrl: VICTIM_PR.url });
      }
    });

    it("leaves a lone PR's green exactly as it was", async () => {
      // The overwhelmingly common case, and the regression guard: with no peer
      // at this head the sweep must be invisible.
      mockListOpenPrsAtHead.mockResolvedValue({ pullRequests: [{ number: TARGET.prNumber, url: TARGET.prUrl }] });
      mockListComments.mockResolvedValue([cleanCommentFor(TARGET.headSha)]);
      mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

      await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
        posted: true,
        verdict: { state: "success" },
      });
      expect(mockPostStatus).toHaveBeenCalledWith(
        expect.objectContaining({ state: "success", targetUrl: TARGET.prUrl }),
      );
      // Only this PR's own two surfaces were read.
      expect(mockListComments).toHaveBeenCalledTimes(1);
    });

    it("does not sweep when its own verdict is already red", async () => {
      // A `failure` is the strictest outcome this gate has, so no peer could
      // change it. Skipping the sweep keeps the red path at its current cost and
      // its current failure surface — a red going silent is the one outcome this
      // module must never produce.
      mockListComments.mockResolvedValue([blockingCommentFor(TARGET.headSha)]);
      mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

      await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
        posted: true,
        verdict: { state: "failure" },
      });
      expect(mockListOpenPrsAtHead).not.toHaveBeenCalled();
    });

    it("withholds the green when the peer enumeration cannot be read", async () => {
      // Fails CLOSED, and the direction matters: coercing an unreadable
      // enumeration to "no peers" restores the whole bypass on the quiet path
      // where no status changes state. Not publishing leaves the prior verdict
      // standing and the next webhook re-evaluates.
      mockListOpenPrsAtHead.mockResolvedValue({ error: "pull_request_http_403" });
      mockListComments.mockResolvedValue([]);
      mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

      await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toEqual({
        posted: false,
        reason: "fetch_failed",
      });
      expect(mockPostStatus).not.toHaveBeenCalled();
    }, 10_000);

    it("withholds the green when a peer's own review history cannot be read", async () => {
      // An unreadable peer is not a clean one. Same refusal, same reason.
      mockListOpenPrsAtHead.mockResolvedValue({ pullRequests: [PROBE_PR, VICTIM_PR] });
      mockListComments.mockImplementation(async ({ prNumber }: { prNumber: number }) =>
        prNumber === VICTIM_PR.number ? null : [],
      );
      mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

      await expect(
        runPrCommentReviewGateCheck({ ...TARGET, prNumber: PROBE_PR.number, prUrl: PROBE_PR.url }),
      ).resolves.toEqual({ posted: false, reason: "fetch_failed" });
      expect(mockPostStatus).not.toHaveBeenCalled();
    }, 10_000);

    it("keeps a green when the only peer at this head is green too", async () => {
      // Strictest-wins, not peer-exists-wins: a sibling PR at the same head
      // whose review is clean must not redden anything.
      mockListOpenPrsAtHead.mockResolvedValue({ pullRequests: [PROBE_PR, VICTIM_PR] });
      mockListComments.mockResolvedValue([cleanCommentFor(TARGET.headSha)]);
      mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

      await expect(
        runPrCommentReviewGateCheck({ ...TARGET, prNumber: PROBE_PR.number, prUrl: PROBE_PR.url }),
      ).resolves.toMatchObject({ posted: true, verdict: { state: "success" } });
      expect(mockPostStatus).toHaveBeenCalledWith(
        expect.objectContaining({ state: "success", targetUrl: PROBE_PR.url }),
      );
    });

    it("does not adopt a peer's carried red that a distinct author's attestation clears", async () => {
      // Ally's review of #3091. The author-blind pass is NOT sufficient for a
      // peer: `carried_finding` comes back with `authorUnknown` when an at-head
      // attestation exists but the author is unread, and a DISTINCT author
      // clears that carry outright. Adopting it would publish, onto a shared
      // head, a red the peer's own evaluation would never publish — and the
      // peer's next webhook would flip it back, so the gate would oscillate
      // with webhook order. The mirror image of the bypass, reachable the same
      // cheap way.
      mockListOpenPrsAtHead.mockResolvedValue({ pullRequests: [PROBE_PR, VICTIM_PR] });
      mockFetchPrAuthor.mockResolvedValue("some-contributor");
      mockListReviews.mockImplementation(async ({ prNumber }: { prNumber: number }) =>
        prNumber === VICTIM_PR.number
          ? [blockingCommentFor("0".repeat(40)), cleanCommentFor(TARGET.headSha)]
          : [],
      );
      mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

      await expect(
        runPrCommentReviewGateCheck({ ...TARGET, prNumber: PROBE_PR.number, prUrl: PROBE_PR.url }),
      ).resolves.toMatchObject({ posted: true, verdict: { state: "success" } });
      expect(mockFetchPrAuthor).toHaveBeenCalledWith({
        repoFullName: TARGET.repoFullName,
        prNumber: VICTIM_PR.number,
      });
      expect(mockPostStatus).toHaveBeenCalledWith(
        expect.objectContaining({ state: "success", targetUrl: PROBE_PR.url }),
      );
    });

    it("still adopts a peer's carried red once the author is known not to clear it", async () => {
      // The other half: same fixture, author IS the reviewer identity, so the
      // attestation is self-attested and the carry stands. Without this the
      // test above could be satisfied by never adopting a carried red at all.
      mockListOpenPrsAtHead.mockResolvedValue({ pullRequests: [PROBE_PR, VICTIM_PR] });
      mockFetchPrAuthor.mockResolvedValue("allyblockcast[bot]");
      mockListReviews.mockImplementation(async ({ prNumber }: { prNumber: number }) =>
        prNumber === VICTIM_PR.number
          ? [blockingCommentFor("0".repeat(40)), cleanCommentFor(TARGET.headSha)]
          : [],
      );
      mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

      await expect(
        runPrCommentReviewGateCheck({ ...TARGET, prNumber: PROBE_PR.number, prUrl: PROBE_PR.url }),
      ).resolves.toMatchObject({
        posted: true,
        verdict: { state: "failure", outcome: "carried_finding" },
      });
      expect(mockPostStatus).toHaveBeenCalledWith(
        expect.objectContaining({ state: "failure", targetUrl: VICTIM_PR.url }),
      );
    });

    it("withholds rather than adopting when a peer's author cannot be read", async () => {
      // The OPPOSITE call from the main path's on the same flag, deliberately.
      // There an unresolved author leaves a PR's own red standing, because the
      // author can only soften it. Here the red is not ours, so adopting it on
      // an unread author paints this PR and the shared head red on evidence we
      // could not confirm. The peer still publishes its own red if it has one.
      mockListOpenPrsAtHead.mockResolvedValue({ pullRequests: [PROBE_PR, VICTIM_PR] });
      mockFetchPrAuthor.mockResolvedValue(null);
      mockListReviews.mockImplementation(async ({ prNumber }: { prNumber: number }) =>
        prNumber === VICTIM_PR.number
          ? [blockingCommentFor("0".repeat(40)), cleanCommentFor(TARGET.headSha)]
          : [],
      );
      mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

      await expect(
        runPrCommentReviewGateCheck({ ...TARGET, prNumber: PROBE_PR.number, prUrl: PROBE_PR.url }),
      ).resolves.toEqual({ posted: false, reason: "fetch_failed" });
      expect(mockPostStatus).not.toHaveBeenCalled();
    }, 10_000);

    it("spends no author fetch on a peer whose red the author cannot change", async () => {
      // A plain at-head `blocking_finding` carries no `authorUnknown`, so the
      // sweep must adopt it without a `GET /pulls/{n}` — the cost guard for the
      // route the fix above added.
      mockListOpenPrsAtHead.mockResolvedValue({ pullRequests: [PROBE_PR, VICTIM_PR] });
      mockListComments.mockImplementation(async ({ prNumber }: { prNumber: number }) =>
        prNumber === VICTIM_PR.number ? [blockingCommentFor(TARGET.headSha)] : [],
      );
      mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

      await expect(
        runPrCommentReviewGateCheck({ ...TARGET, prNumber: PROBE_PR.number, prUrl: PROBE_PR.url }),
      ).resolves.toMatchObject({ posted: true, verdict: { state: "failure" } });
      expect(mockFetchPrAuthor).not.toHaveBeenCalled();
    });

    it("ignores a peer whose head is a different commit", async () => {
      // The enumeration endpoint returns every PR the commit is associated
      // with, including ones that merely contain it. A review of a LATER head
      // says nothing about this tree, so only exact-head peers may contribute —
      // the filter lives in `parseOpenPullRequestsAtHeadPayload`, and this
      // pins that the gate does not re-admit what the parser dropped.
      mockListOpenPrsAtHead.mockResolvedValue({ pullRequests: [PROBE_PR] });
      mockListComments.mockResolvedValue([]);
      mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });

      await expect(
        runPrCommentReviewGateCheck({ ...TARGET, prNumber: PROBE_PR.number, prUrl: PROBE_PR.url }),
      ).resolves.toMatchObject({ posted: true, verdict: { state: "success" } });
      expect(mockListComments).toHaveBeenCalledTimes(1);
    });
  });
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

  it("supersedes the retired context with a pointer the census can count", async () => {
    // The exact pre-rename state: nothing attests the head, so the live gate
    // legitimately goes green under `gate/`.
    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "success", outcome: "not_evaluated" },
    });

    expect(postFor("gate/ally-comment-findings")).toMatchObject({
      state: "success",
      description: "No Ally consolidated-review comment attests to reviewing this head.",
    });

    const retired = postFor("review/ally-comment");
    // Still green, because the retired row mirrors the live state and a red
    // here would block a PR the live gate is deliberately not blocking
    // (BLO-29711's anti-deadlock constraint).
    expect(retired).toMatchObject({ sha: TARGET.headSha, state: "success" });
    // BLO-34742. This assertion used to demand the opposite, on the reasoning
    // that a retirement pointer matching the census pattern would "leave AC#1
    // failing under the old name". That had it backwards: the row IS a green
    // `review/`-namespaced status on a head nothing reviewed, so wording it
    // past the census did not make it safe, it made it uncountable. Asserted
    // via the census's own predicate rather than a local copy of its regex,
    // which is how the previous version of this test drifted from the one in
    // `pr-comment-review-gate.test.ts`.
    expect(admitsNothingEvaluated(retired?.description)).toBe(true);
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

  // The mirror is the check-run NAMED FOR THE GATE CONTEXT. The gate also
  // publishes a second, differently named check-run (the `ci/ally-head-attested`
  // schedule signal, covered below), so counting every check-run would pin the
  // wrong thing: it would go red the day a third one is added, and stay green if
  // the mirror itself were published twice.
  function mirrorRuns(context: string) {
    return mockPostCheckRun.mock.calls.map(([arg]) => arg).filter((arg) => arg.name === context);
  }

  it("mirrors the verdict as a check-run alongside the commit status", async () => {
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });
    // Reviews surface: the subject is the check-run mirror, not the surface.
    mockListReviews.mockResolvedValue([clean]);

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({ posted: true });

    const mirrors = mirrorRuns("review/ally-comment-gate");
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0]).toMatchObject({
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
    expect(mirrorRuns("review/ally-comment-gate")[0]).toMatchObject({ conclusion: "neutral" });
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

// Ally-gated heavy CI, design 4.0b. `ci/ally-head-attested` is a SCHEDULE
// signal: it says WHEN a heavy-CI dispatcher may run a lane at this head, never
// WHETHER the change may merge. It exists because the gate's own check-run is
// `success` only for `clean`, and `clean` is withheld for every PR the App
// authors (BLO-34316) — so a dispatcher reading that check-run alone would
// starve on the whole App-authored population. Everything below is a property of
// what is PUBLISHED, because the signal has no other surface.
describe("ci/ally-head-attested schedule signal", () => {
  const SIGNAL = "ci/ally-head-attested";
  const GATE = "gate/ally-comment-findings";
  const ALLY = "allyblockcast[bot]";
  const HEAD = TARGET.headSha;
  const OLD_HEAD = "0".repeat(40);
  const OK = { ok: true, statusCode: 201 };

  beforeEach(() => {
    // The live Blockcast context, so the gate's check-run and the signal are
    // told apart by name exactly as they are in production.
    h.cfg.prCommentReviewGateStatusContext = GATE;
    mockPostStatus.mockResolvedValue(OK);
  });

  const reviewOf = (headSha: string, lines: string[], createdAt: string) => ({
    login: ALLY,
    body: ["## Ally — Consolidated PR Review", `Reviewed head: ${headSha}`, ...lines].join("\n"),
    createdAt,
  });
  const cleanAt = (headSha: string, createdAt = "2026-10-08T10:00:00Z") =>
    reviewOf(headSha, ["### Critical Issues (0)", "### Important Issues (0)"], createdAt);
  const blockingAt = (headSha: string, createdAt = "2026-10-08T09:00:00Z") =>
    reviewOf(
      headSha,
      [
        "### Critical Issues (0)",
        "### Important Issues (1)",
        "- The queue can merge this head before its review finding is resolved.",
        "### Recommended Action",
        "Fix the gate before merge.",
      ],
      createdAt,
    );
  const trackedAt = (headSha: string, priorHeadSha: string, createdAt = "2026-10-08T10:00:00Z") =>
    reviewOf(
      headSha,
      [
        "### Prior Findings Dispositioned (1)",
        `- **prior:${priorHeadSha.slice(0, 7)} important 1** — tracked — accepted onto a follow-up.`,
        "### Critical Issues (0)",
        "### Important Issues (0)",
      ],
      createdAt,
    );
  const unreadableAt = (headSha: string, createdAt = "2026-10-08T10:00:00Z") => ({
    login: ALLY,
    body: [
      "## Ally — Consolidated PR Review",
      "<!-- ally-verdict:1",
      "{ this is not json",
      "-->",
      `Reviewed head: ${headSha}`,
    ].join("\n"),
    createdAt,
  });

  /** Every check-run written under `name`, in call order. */
  function runsNamed(name: string) {
    return mockPostCheckRun.mock.calls.map(([arg]) => arg).filter((arg) => arg.name === name);
  }
  /** The one check-run written under `name`: an evaluation writes each exactly once. */
  function onlyRunNamed(name: string) {
    const runs = runsNamed(name);
    expect(runs, `exactly one "${name}" check-run per evaluation`).toHaveLength(1);
    return runs[0];
  }

  it("App-authored PR, self-attested clean: the signal is success while the gate check-run stays neutral", async () => {
    // The population the signal exists for. The review is Ally's, the PR is the
    // App's, so BLO-34316 withholds `clean` and the gate publishes `neutral`.
    mockFetchPrAuthor.mockResolvedValue(ALLY);
    mockListComments.mockResolvedValue([cleanAt(HEAD)]);

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "success", outcome: "not_evaluated", headAttested: true },
    });

    expect(onlyRunNamed(GATE)).toMatchObject({ sha: HEAD, conclusion: "neutral" });
    expect(onlyRunNamed(SIGNAL)).toMatchObject({
      repoFullName: TARGET.repoFullName,
      sha: HEAD,
      conclusion: "success",
      detailsUrl: TARGET.prUrl,
      title: expect.stringMatching(/^Schedule signal:/),
    });
    // The signal is a check-run and only a check-run. A commit status under its
    // name would be a second, differently-shaped thing for a rule to require.
    expect(mockPostStatus.mock.calls.map(([arg]) => arg.context)).toEqual([GATE]);
  });

  it("bare-slug seat author, self-attested clean: the same branch, the same signal", async () => {
    // `githubSharesReviewerIdentity`, not the strict predicate: the user seat and
    // the App are one agent, so a PR opened by the seat is still self-attested.
    mockFetchPrAuthor.mockResolvedValue("allyblockcast");
    mockListComments.mockResolvedValue([cleanAt(HEAD)]);

    await runPrCommentReviewGateCheck(TARGET);

    expect(onlyRunNamed(GATE)).toMatchObject({ conclusion: "neutral" });
    expect(onlyRunNamed(SIGNAL)).toMatchObject({ conclusion: "success" });
  });

  it("unattested head: the signal is neutral", async () => {
    mockListComments.mockResolvedValue([]);

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "success", outcome: "not_evaluated" },
    });

    expect(onlyRunNamed(SIGNAL)).toMatchObject({ sha: HEAD, conclusion: "neutral" });
    expect(onlyRunNamed(GATE)).toMatchObject({ conclusion: "neutral" });
    expect(mockFetchPrAuthor).not.toHaveBeenCalled();
  });

  it("an attestation of a DIFFERENT head does not attest this one", async () => {
    // Head-bound. Ally cleared an earlier tree; nothing says anything about this
    // one, and a signal that carried over would schedule heavy CI at a head no
    // reviewer has seen.
    mockFetchPrAuthor.mockResolvedValue(ALLY);
    mockListComments.mockResolvedValue([cleanAt(OLD_HEAD)]);

    await runPrCommentReviewGateCheck(TARGET);

    expect(onlyRunNamed(SIGNAL)).toMatchObject({ sha: HEAD, conclusion: "neutral" });
  });

  it("blocking finding: the signal is neutral, never failure, while the gate check-run is failure", async () => {
    mockListComments.mockResolvedValue([blockingAt(HEAD)]);

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "failure", outcome: "blocking_finding" },
    });

    // The gate's own check-run carries the finding. A second red here would be a
    // duplicate nobody can clear separately.
    expect(onlyRunNamed(GATE)).toMatchObject({ conclusion: "failure" });
    expect(onlyRunNamed(SIGNAL)).toMatchObject({ conclusion: "neutral" });
    expect(mockPostStatus).toHaveBeenCalledWith(expect.objectContaining({ context: GATE, state: "failure" }));
  });

  // The whole truth table, so "never failure" and "head-bound" are properties of
  // every outcome rather than of the three above.
  const AUTHOR = "some-contributor";
  it.each([
    {
      name: "independent clean",
      author: AUTHOR,
      comments: [cleanAt(HEAD)],
      outcome: "clean",
      gate: "success",
      signal: "success",
    },
    {
      name: "independent, tracked residual (deferred)",
      author: AUTHOR,
      comments: [blockingAt(OLD_HEAD), trackedAt(HEAD, OLD_HEAD)],
      outcome: "deferred_finding",
      gate: "neutral",
      signal: "success",
    },
    {
      name: "App-authored, self-attested clean",
      author: ALLY,
      comments: [cleanAt(HEAD)],
      outcome: "not_evaluated",
      gate: "neutral",
      signal: "success",
    },
    {
      name: "no comment at all",
      author: AUTHOR,
      comments: [],
      outcome: "not_evaluated",
      gate: "neutral",
      signal: "neutral",
    },
    {
      name: "clean review of an earlier head only",
      author: ALLY,
      comments: [cleanAt(OLD_HEAD)],
      outcome: "not_evaluated",
      gate: "neutral",
      signal: "neutral",
    },
    {
      name: "blocking finding at this head",
      author: AUTHOR,
      comments: [blockingAt(HEAD)],
      outcome: "blocking_finding",
      gate: "failure",
      signal: "neutral",
    },
    {
      name: "blocking finding at this head, App-authored PR",
      author: ALLY,
      comments: [blockingAt(HEAD)],
      outcome: "blocking_finding",
      gate: "failure",
      signal: "neutral",
    },
    {
      name: "finding carried from an earlier head, nothing attests this one",
      author: AUTHOR,
      comments: [blockingAt(OLD_HEAD)],
      outcome: "carried_finding",
      gate: "failure",
      signal: "neutral",
    },
    {
      // The one row where a comment DOES attest the head non-blockingly and the
      // signal is still neutral: an earlier head's finding is undispositioned, so
      // the gate is red, and the red is the gate's to carry.
      name: "self-attested clean at this head over a carried finding",
      author: ALLY,
      comments: [blockingAt(OLD_HEAD), cleanAt(HEAD)],
      outcome: "carried_finding",
      gate: "failure",
      signal: "neutral",
    },
    {
      name: "unreadable verdict block at this head",
      author: AUTHOR,
      comments: [unreadableAt(HEAD)],
      outcome: "unreadable_verdict",
      gate: "failure",
      signal: "neutral",
    },
    // What counts as an attestation at all. The signal asks the same two
    // questions the gate does and no looser ones: WHO wrote it (the App
    // identity) and WHAT it names (one standalone, complete `Reviewed head:`
    // line, which is `extractAllyReviewedHeadSha`'s to decide). A signal that
    // answered either more loosely would schedule heavy CI off text a PR author
    // can post.
    {
      name: "App exposed as app/<slug> attests this head",
      author: ALLY,
      comments: [{ ...cleanAt(HEAD), login: "app/allyblockcast" }],
      outcome: "not_evaluated",
      gate: "neutral",
      signal: "success",
    },
    {
      name: "Ally's format, written by a human account",
      author: AUTHOR,
      comments: [{ ...cleanAt(HEAD), login: "some-contributor" }],
      outcome: "not_evaluated",
      gate: "neutral",
      signal: "neutral",
    },
    {
      name: "Ally's format, written by the bare-slug user seat and not the App",
      author: AUTHOR,
      comments: [{ ...cleanAt(HEAD), login: "allyblockcast" }],
      outcome: "not_evaluated",
      gate: "neutral",
      signal: "neutral",
    },
    {
      name: "head named in prose only, no attestation line",
      author: ALLY,
      comments: [
        {
          login: ALLY,
          body: [
            "## Ally — Consolidated PR Review",
            `I looked at ${HEAD} and found nothing.`,
            "### Critical Issues (0)",
            "### Important Issues (0)",
          ].join("\n"),
          createdAt: "2026-10-08T10:00:00Z",
        },
      ],
      outcome: "not_evaluated",
      gate: "neutral",
      signal: "neutral",
    },
    {
      name: "abbreviated head in the attestation line",
      author: ALLY,
      comments: [
        reviewOf(HEAD.slice(0, 7), ["### Critical Issues (0)", "### Important Issues (0)"], "2026-10-08T10:00:00Z"),
      ],
      outcome: "not_evaluated",
      gate: "neutral",
      signal: "neutral",
    },
  ])("truth table: $name -> gate $gate, signal $signal", async ({ author, comments, outcome, gate, signal }) => {
    mockFetchPrAuthor.mockResolvedValue(author);
    // Fed through the REVIEWS surface. The table's subject is the
    // outcome -> check-run mapping, and two of its rows make a positive claim
    // (`clean`, `deferred_finding`), which after PEN-4431 requires a review
    // submission. Carrying the table on the issue-comment surface would
    // collapse those two rows onto `not_evaluated` and quietly stop testing
    // the mapping they are there for. It is also the realistic surface: 83 of
    // 83 Ally consolidated reviews measured on `Blockcast/paperclip`
    // (2026-10-20) were review submissions.
    mockListReviews.mockResolvedValue(comments);

    // `outcome` is asserted too, so a fixture that stops reaching the branch it
    // names fails here instead of passing on the wrong one.
    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { outcome },
    });

    expect(onlyRunNamed(GATE).conclusion).toBe(gate);
    expect(onlyRunNamed(SIGNAL).conclusion).toBe(signal);
    // Never failure, whatever the verdict.
    expect(["success", "neutral"]).toContain(onlyRunNamed(SIGNAL).conclusion);
    expect(mockPostStatus.mock.calls.map(([arg]) => arg.context)).not.toContain(SIGNAL);
  });

  it("is published after the commit status, the gate check-run and every retirement write", async () => {
    // The signal's `success` is an event a dispatcher wakes on, and the
    // dispatcher then reads the gate's check-run at this head. Written first, it
    // could wake the dispatcher while that check-run still showed an earlier
    // evaluation's `failure`; the dispatcher would read "blocked" and nothing
    // would wake it again, because a `neutral` gate check-run (the App-authored
    // population) is not a wake event.
    //
    // And AFTER retirement, last of all. The retirement write is merge-facing: it
    // mirrors a blocking verdict onto a legacy context that may still be a
    // required check, so a stale green cannot satisfy it. The signal is a
    // best-effort schedule hint. A degraded Checks API must cost the hint its
    // latency, never delay or lose the merge-facing write that sits behind it
    // inside the delivery lock's 120s hold cap.
    h.cfg.prCommentReviewGateRetiredStatusContexts = ["review/ally-comment"];
    const order: string[] = [];
    mockPostStatus.mockImplementation(async ({ context }: { context: string }) => {
      order.push(`status:${context}`);
      return OK;
    });
    mockPostCheckRun.mockImplementation(async ({ name }: { name: string }) => {
      order.push(`check-run:${name}`);
      return OK;
    });
    mockFetchPrAuthor.mockResolvedValue(ALLY);
    mockListComments.mockResolvedValue([cleanAt(HEAD)]);

    await runPrCommentReviewGateCheck(TARGET);

    expect(order).toEqual([
      `status:${GATE}`,
      `check-run:${GATE}`,
      "status:review/ally-comment",
      `check-run:${SIGNAL}`,
    ]);
  });

  it("writes the retirement status before a hung signal write completes, and gives the signal one attempt", async () => {
    // The degraded Checks API: every check-run call hangs to the 30s fetch
    // deadline and then returns the retryable failure shape the real client
    // returns. A blocking verdict is mirrored onto the retired context, and that
    // mirror is merge-facing. With the signal ahead of it (and retried), the
    // mirror landed at t=182.5s against a 120s lock hold cap; it must not wait
    // on the signal at all.
    vi.useFakeTimers();
    let run: Promise<unknown> | undefined;
    try {
      h.cfg.prCommentReviewGateRetiredStatusContexts = ["review/ally-comment"];
      const log: string[] = [];
      let signalAttempts = 0;
      mockPostStatus.mockImplementation(async ({ context }: { context: string }) => {
        log.push(`status:${context}`);
        return OK;
      });
      mockPostCheckRun.mockImplementation(async ({ name }: { name: string }) => {
        if (name !== SIGNAL) return OK;
        signalAttempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        log.push("signal:gave-up");
        return { ok: false, retryable: true, reason: "check_run_write_fetch_failed" };
      });
      mockFetchPrAuthor.mockResolvedValue(ALLY);
      mockListComments.mockResolvedValue([blockingAt(HEAD)]);

      run = runPrCommentReviewGateCheck(TARGET);
      // Nothing has timed out yet: the signal write is still in flight.
      await vi.advanceTimersByTimeAsync(0);
      expect(signalAttempts).toBe(1);
      expect(log).toEqual([`status:${GATE}`, "status:review/ally-comment"]);

      await vi.advanceTimersByTimeAsync(120_000);
      await expect(run).resolves.toMatchObject({ posted: true });
      // One attempt: the 250ms and 1s backoffs and two more 30s hangs would have
      // spent another 61s of the lock's 120s cap on a best-effort hint.
      expect(signalAttempts).toBe(1);
      expect(log).toEqual([`status:${GATE}`, "status:review/ally-comment", "signal:gave-up"]);
    } finally {
      // Settle the evaluation before the real timers come back. A failed
      // assertion above would otherwise leave it pending on a fake timer that
      // never fires, and the per-PR evaluation chain would then hold every later
      // test in this file behind it until each one timed out.
      await vi.advanceTimersByTimeAsync(400_000);
      await run?.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("still publishes the signal when the retirement write throws", async () => {
    // Unconditional, not "unless retirement failed": a retirement that throws
    // rejects the publish, and the signal still has to have been written.
    h.cfg.prCommentReviewGateRetiredStatusContexts = ["review/ally-comment"];
    mockPostStatus.mockImplementation(async ({ context }: { context: string }) => {
      if (context === "review/ally-comment") throw new Error("retirement write blew up");
      return OK;
    });
    mockFetchPrAuthor.mockResolvedValue(ALLY);
    mockListComments.mockResolvedValue([cleanAt(HEAD)]);

    await expect(runPrCommentReviewGateCheck(TARGET)).rejects.toThrow("retirement write blew up");

    expect(onlyRunNamed(SIGNAL)).toMatchObject({ conclusion: "success" });
  });

  it("still publishes when a retirement write fails, because the signal does not depend on it", async () => {
    h.cfg.prCommentReviewGateRetiredStatusContexts = ["review/ally-comment"];
    mockPostStatus.mockImplementation(async ({ context }: { context: string }) =>
      context === "review/ally-comment"
        ? { ok: false, retryable: false, reason: "commit_status_write_http_403" }
        : OK,
    );
    mockFetchPrAuthor.mockResolvedValue(ALLY);
    mockListComments.mockResolvedValue([cleanAt(HEAD)]);

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: false,
      reason: "retirement_failed",
    });

    expect(onlyRunNamed(SIGNAL)).toMatchObject({ conclusion: "success" });
  });

  it("republishes neutral when a later evaluation of the same head no longer attests it", async () => {
    // Written on EVERY evaluation, not only when it is `success`. Check-runs are
    // read newest-first, so a review that was dismissed after it attested the
    // head has to be able to supersede the earlier `success`; staying silent
    // would leave it standing for a dispatcher to act on.
    mockFetchPrAuthor.mockResolvedValue(ALLY);
    mockListComments.mockResolvedValueOnce([cleanAt(HEAD)]).mockResolvedValueOnce([]);

    await runPrCommentReviewGateCheck(TARGET);
    await runPrCommentReviewGateCheck(TARGET);

    expect(runsNamed(SIGNAL).map((run) => run.conclusion)).toEqual(["success", "neutral"]);
  });

  it("publishes nothing, the signal included, while the PR author cannot be read", async () => {
    // The signal follows the gate's own evidence rules. Here the gate withholds
    // its whole publish rather than overwrite a correct earlier verdict on a
    // transient 5xx, and the signal must not run ahead of it.
    mockFetchPrAuthor.mockResolvedValue(null);
    mockListComments.mockResolvedValue([cleanAt(HEAD)]);

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toEqual({
      posted: false,
      reason: "fetch_failed",
    });

    expect(mockPostCheckRun).not.toHaveBeenCalled();
  }, 10_000);

  it("publishes no signal when the commit status itself could not be written", async () => {
    mockPostStatus.mockResolvedValue({ ok: false, retryable: false, reason: "commit_status_write_http_403" });
    mockFetchPrAuthor.mockResolvedValue(ALLY);
    mockListComments.mockResolvedValue([cleanAt(HEAD)]);

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: false,
      reason: "post_failed",
    });

    // The status is the authoritative surface and its durable retry re-runs the
    // whole evaluation, which publishes the signal then. Publishing it now would
    // run ahead of a gate that has not spoken.
    expect(mockPostCheckRun).not.toHaveBeenCalled();
  });

  it("a refused signal write leaves the commit status and the gate check-run published", async () => {
    mockPostCheckRun.mockImplementation(async ({ name }: { name: string }) =>
      name === SIGNAL ? { ok: false, retryable: false, reason: "check_run_write_http_403" } : OK,
    );
    mockFetchPrAuthor.mockResolvedValue(ALLY);
    mockListComments.mockResolvedValue([cleanAt(HEAD)]);

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({ posted: true });

    expect(mockPostStatus).toHaveBeenCalledWith(expect.objectContaining({ context: GATE }));
    expect(onlyRunNamed(GATE)).toMatchObject({ conclusion: "neutral" });
    expect(runsNamed(SIGNAL)).toHaveLength(1);
  });

  it("a thrown signal write is contained the same way", async () => {
    mockPostCheckRun.mockImplementation(async ({ name }: { name: string }) => {
      if (name === SIGNAL) throw new Error("githubPostCheckRun is not a function");
      return OK;
    });
    mockFetchPrAuthor.mockResolvedValue(ALLY);
    mockListComments.mockResolvedValue([cleanAt(HEAD)]);

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({ posted: true });
    expect(mockPostStatus).toHaveBeenCalledWith(expect.objectContaining({ context: GATE }));
    expect(onlyRunNamed(GATE)).toMatchObject({ conclusion: "neutral" });
  });

  it("does not retry a transient signal write: it is one best-effort attempt", async () => {
    // Unlike the status and the gate's own check-run, the signal is not retried.
    // It runs inside the delivery lock's 120s hold cap, a retried hung write can
    // spend 91s of it, and the next evaluation of the head republishes the hint.
    let signalAttempts = 0;
    mockPostCheckRun.mockImplementation(async ({ name }: { name: string }) => {
      if (name !== SIGNAL) return OK;
      signalAttempts += 1;
      return { ok: false, retryable: true, reason: "check_run_write_http_502" };
    });
    mockFetchPrAuthor.mockResolvedValue(ALLY);
    mockListComments.mockResolvedValue([cleanAt(HEAD)]);

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({ posted: true });

    expect(signalAttempts).toBe(1);
  });

  it("names a refused signal write once per repo, and says what it costs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockPostCheckRun.mockImplementation(async ({ name }: { name: string }) =>
      name === SIGNAL ? { ok: false, retryable: false, reason: "check_run_write_http_403" } : OK,
    );
    // A repo no other test in this file writes to: the once-per-repo memory is
    // module state, so sharing a repo would make this order-dependent.
    const target = { ...TARGET, repoFullName: "Blockcast/signal-warn-probe" };

    await runPrCommentReviewGateCheck(target);
    await runPrCommentReviewGateCheck(target);

    const messages = warn.mock.calls.map(([message]) => String(message)).filter((m) => m.includes(SIGNAL));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Blockcast/signal-warn-probe");
    expect(messages[0]).toContain("check_run_write_http_403");
    expect(messages[0]).toContain("checks: write");
  });

  describe("what is published", () => {
    it("says in the summary that it is a schedule signal and never a required context", async () => {
      mockFetchPrAuthor.mockResolvedValue(ALLY);

      for (const comments of [[cleanAt(HEAD)], [], [blockingAt(HEAD)]]) {
        mockPostCheckRun.mockClear();
        mockListComments.mockResolvedValue(comments);
        await runPrCommentReviewGateCheck(TARGET);

        const { summary } = onlyRunNamed(SIGNAL);
        // The sentence the deployment test also pins, from the other side: this
        // is the text a reader sees on the check, in every conclusion.
        expect(summary).toContain("Schedule signal only");
        expect(summary).toContain("must never be added to required contexts");
        expect(summary).toContain(`"${GATE}"`);
        // A different artifact from the gate's own check-run, not a copy of it:
        // the gate's reason ("nothing independent reviewed it") would contradict
        // a `success` here.
        expect(summary).not.toBe(onlyRunNamed(GATE).summary);
      }
    });

    it("tells the two conclusions apart by title, and both are labelled a schedule signal", () => {
      const success = allyHeadAttestedCheckTitle("success");
      const neutral = allyHeadAttestedCheckTitle("neutral");

      expect(success).not.toBe(neutral);
      expect(success).toMatch(/^Schedule signal:/);
      expect(neutral).toMatch(/^Schedule signal:/);
      // "Findings" is the gate's vocabulary: this title must not read as a verdict.
      expect(`${success} ${neutral}`).not.toMatch(/finding|review(ed)? (clean|passed)/i);
    });

    it("is published under a name the egress boundary leaves untouched", () => {
      // `githubPostCheckRun` REFUSES an identity field the scrub would change
      // (PEN-3391) and redacts prose that it would. Either would silently drop
      // the signal, or the sentence that says it is never required.
      const verdicts: CommentReviewGateVerdict[] = [
        { state: "success", outcome: "clean", reason: "r" },
        { state: "success", outcome: "not_evaluated", reason: "r", headAttested: true },
        { state: "success", outcome: "not_evaluated", reason: "r" },
        { state: "failure", outcome: "blocking_finding", reason: "r", commentCreatedAt: "2026-10-08T10:00:00Z" },
      ];

      expect(gitHubIdentityFieldRedaction(ALLY_HEAD_ATTESTED_CHECK_NAME, "check-run name")).toBeNull();
      for (const verdict of verdicts) {
        const summary = allyHeadAttestedCheckSummary(verdict, GATE);
        expect(scrubOutboundGitHubText(summary, "check-run summary")).toBe(summary);
      }
    });
  });

  describe("the conclusion, from the typed verdict", () => {
    // Every outcome the gate can return, built by hand so this does not depend on
    // the evaluator reaching it. `Record<Outcome, ...>` makes a new outcome a
    // compile error here too, not only in the function under test.
    const SAMPLE_VERDICTS: Record<CommentReviewGateVerdict["outcome"], CommentReviewGateVerdict> = {
      clean: { state: "success", outcome: "clean", reason: "r" },
      deferred_finding: { state: "success", outcome: "deferred_finding", reason: "r" },
      not_evaluated: { state: "success", outcome: "not_evaluated", reason: "r" },
      blocking_finding: { state: "failure", outcome: "blocking_finding", reason: "r", commentCreatedAt: "t" },
      carried_finding: {
        state: "failure",
        outcome: "carried_finding",
        reason: "r",
        commentCreatedAt: "t",
        carriedFromHeadSha: OLD_HEAD,
      },
      unreadable_verdict: { state: "failure", outcome: "unreadable_verdict", reason: "r", commentCreatedAt: "t" },
    };

    it("is success only where a comment attests the head and nothing at it blocks", () => {
      const conclusions = Object.fromEntries(
        Object.entries(SAMPLE_VERDICTS).map(([outcome, verdict]) => [outcome, allyHeadAttestedCheckConclusion(verdict)]),
      );
      expect(conclusions).toEqual({
        clean: "success",
        deferred_finding: "success",
        not_evaluated: "neutral",
        blocking_finding: "neutral",
        carried_finding: "neutral",
        unreadable_verdict: "neutral",
      });
    });

    it("reads a not_evaluated as attested only through the typed marker", () => {
      const attested: CommentReviewGateVerdict = {
        state: "success",
        outcome: "not_evaluated",
        // Wording that says nothing is attested: the conclusion must follow the
        // marker, not the prose.
        reason: "No Ally consolidated-review comment attests to reviewing this head.",
        headAttested: true,
      };
      const unattested: CommentReviewGateVerdict = {
        state: "success",
        outcome: "not_evaluated",
        // Wording that says something IS attested: and the conclusion must not
        // follow that either.
        reason: "The only comment attesting this head is the PR author's own; nothing independent reviewed it.",
      };

      expect(allyHeadAttestedCheckConclusion(attested)).toBe("success");
      expect(allyHeadAttestedCheckConclusion(unattested)).toBe("neutral");
    });

    it("the marker changes nothing a merge surface publishes", () => {
      // `headAttested` says a comment EXISTS that attests the head. It does not
      // say anyone independent of the PR author examined it, which is the claim
      // the gate's own check-run and commit status exist to make (BLO-34316). So
      // the marker may move the schedule signal and nothing else: the two verdicts
      // below differ ONLY in it, and every merge-facing rendering of them must be
      // identical.
      const plain: CommentReviewGateVerdict = { state: "success", outcome: "not_evaluated", reason: "r" };
      const attested: CommentReviewGateVerdict = { ...plain, headAttested: true };

      expect(commentReviewGateCheckConclusion(attested)).toBe("neutral");
      expect(commentReviewGateCheckConclusion(attested)).toBe(commentReviewGateCheckConclusion(plain));
      expect(commentReviewGateCheckTitle(attested)).toBe(commentReviewGateCheckTitle(plain));
      expect(commentReviewGateRetirementStatus(GATE, attested)).toEqual(commentReviewGateRetirementStatus(GATE, plain));
      // ...while the schedule signal is the one thing it does move.
      expect(allyHeadAttestedCheckConclusion(attested)).not.toBe(allyHeadAttestedCheckConclusion(plain));
    });

    it("the evaluator sets the marker on exactly the withheld-positive branches", () => {
      const run = (prAuthorLogin: string | null, comments: ReturnType<typeof cleanAt>[]) =>
        evaluateCommentReviewGate({
          headSha: HEAD,
          prAuthorLogin,
          comments: comments.map((c) => ({
            authorLogin: c.login,
            body: c.body,
            createdAt: c.createdAt,
            surface: "pull_request_review" as const,
          })),
        });

      // The two withheld routes: shared identity, and an author nobody could read.
      expect(run(ALLY, [cleanAt(HEAD)])).toMatchObject({ outcome: "not_evaluated", headAttested: true });
      expect(run("allyblockcast", [cleanAt(HEAD)])).toMatchObject({ outcome: "not_evaluated", headAttested: true });
      expect(run(null, [cleanAt(HEAD)])).toMatchObject({
        outcome: "not_evaluated",
        headAttested: true,
        authorUnknown: true,
      });

      // Everything else that is `not_evaluated` must NOT carry it.
      expect(run(AUTHOR, [])).not.toHaveProperty("headAttested");
      expect(run(ALLY, [cleanAt(OLD_HEAD)])).not.toHaveProperty("headAttested");
      expect(run(null, [])).not.toHaveProperty("headAttested");

      // And the verdicts that are attested on their own terms do not need it.
      expect(run(AUTHOR, [cleanAt(HEAD)])).toMatchObject({ outcome: "clean" });
      expect(run(AUTHOR, [cleanAt(HEAD)])).not.toHaveProperty("headAttested");
    });
  });
});

/**
 * The author-lane fetch (BLO-43550).
 *
 * BLO-34389 shipped `prAuthorLane` exercised by tests in
 * `pr-comment-review-gate.test.ts` and hardcoded `null` at every production
 * call site, so the exclusion could not fire against a real review. These cases
 * cover the ORCHESTRATION that supplies it — which lives in
 * `runPrCommentReviewGateCheck`, not in the pure evaluator — and so they live
 * here, in the suite that already stubs the network, rather than in the pure
 * suite BLO-43550's verifying signal names. That suite has no mocks at all by
 * design, and a stubbed commit fetch is exactly what these need.
 *
 * ⚠ What this control does and does not do. `reviewer` is a SELF-DECLARATION.
 * These cases pin that the gate reads a declared lane and refuses a retirement
 * matching the head commit's author — they do not pin, and the feature does not
 * provide, any obstacle to an author that omits or misspells the field. The
 * ceiling is pinned directly in the pure suite ("credits an author-lane
 * retirement that declares no lane at all").
 */
describe("author-lane fetch (BLO-43550)", () => {
  const AUTHOR_LANE = "staff-engineer@paperclip.blockcast.net";
  const OTHER_LANE = "ally@paperclip.blockcast.net";
  const OLD_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const INTERMEDIATE_HEAD = "cccccccccccccccccccccccccccccccccccccccc";

  /** Ally raising one Important finding at `headSha`. */
  const blockingAt = (headSha: string, createdAt: string) => ({
    login: "allyblockcast[bot]",
    body: `## Ally — Consolidated PR Review\nReviewed head: ${headSha}\n### Important Issues (1)\nFix before merge.`,
    createdAt,
  });

  /**
   * Ally retiring `priorHeadSha`'s finding, optionally declaring `lane` as the
   * review's own author.
   *
   * The structured block must AGREE with the prose beside it — head, counts and
   * ledger alike — or `parseAllyVerdictBlock` fails closed on the disagreement
   * and these cases would be measuring that instead of the lane.
   */
  const retiringAt = (headSha: string, priorHeadSha: string, lane: string | null, createdAt: string) => ({
    login: "allyblockcast[bot]",
    body: [
      "## Ally — Consolidated PR Review",
      "",
      "<!-- ally-verdict:1",
      JSON.stringify({
        head: headSha,
        findings: { critical: 0, important: 0 },
        dispositions: [{ head: priorHeadSha.slice(0, 7), severity: "important", index: 1, verb: "fixed" }],
        ...(lane === null ? {} : { reviewer: lane }),
      }),
      "-->",
      "",
      `Reviewed head: ${headSha}`,
      "### Prior Findings Dispositioned (1)",
      `- **prior:${priorHeadSha.slice(0, 7)} important 1** — fixed — re-checked against this head.`,
      "### Critical Issues (0)",
      "### Important Issues (0)",
    ].join("\n"),
    createdAt,
  });

  /** A finding raised at OLD_HEAD and retired at INTERMEDIATE_HEAD, judged at TARGET.headSha. */
  const carryThenRetire = (lane: string | null) => [
    blockingAt(OLD_HEAD, "2026-08-04T20:09:19Z"),
    retiringAt(INTERMEDIATE_HEAD, OLD_HEAD, lane, "2026-08-04T21:09:19Z"),
  ];

  beforeEach(() => {
    mockPostStatus.mockResolvedValue({ ok: true, statusCode: 201 });
  });

  // THE END-TO-END AC. The head commit is authored by lane L and the review
  // retiring the only carried finding declares `reviewer: L`, so the retirement
  // is refused and the gate stays red — the production behaviour BLO-34389
  // could not reach with `prAuthorLane` hardcoded.
  it("refuses a retirement declaring the head commit author's own lane", async () => {
    mockListComments.mockResolvedValue(carryThenRetire(AUTHOR_LANE));
    mockFetchCommitAuthorEmail.mockResolvedValue(AUTHOR_LANE);

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "failure", outcome: "carried_finding", carriedFromHeadSha: OLD_HEAD },
    });
    expect(mockFetchCommitAuthorEmail).toHaveBeenCalledWith(
      expect.objectContaining({ repoFullName: TARGET.repoFullName, sha: TARGET.headSha }),
    );
    // The description has to name the refused retirement. A reader who sees
    // only this string must not be told the head is merely unattested — that is
    // true of the head and false about the cause, and it routes the author into
    // posting another comment rather than reopening the finding.
    expect(mockPostStatus.mock.calls[0][0].description).toContain("the PR author's own lane");
  });

  // THE NEGATIVE CONTROL, and the reason this cannot be a login comparison.
  // Byte-identical to the case above but for the declared lane: same comments,
  // same timestamps, same single `allyblockcast[bot]` login on both sides. A
  // gate that reds this one has no route to green at all (BLO-29711).
  it("still retires when the review declares a lane other than the commit author's", async () => {
    // Reviews surface: the subject is the declared LANE. A retirement carried
    // as an issue comment is refused on its surface (PEN-4431), which would
    // mask the lane behaviour this case exists to pin.
    mockListReviews.mockResolvedValue(carryThenRetire(OTHER_LANE));
    mockFetchCommitAuthorEmail.mockResolvedValue(AUTHOR_LANE);

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "success", outcome: "not_evaluated" },
    });
  });

  // THE ZERO-EXTRA-CALLS AC, as a test rather than a claim. The fetch is gated
  // on a DECLARED lane, not on the verdict outcome, so until a producer emits
  // `reviewer` this costs nothing — which is what lets the consumer land ahead
  // of the producer with no ordering constraint in either direction.
  //
  // Reverting that gate to an unconditional fetch fails here and only here.
  it("issues no commit fetch when no comment declares a lane", async () => {
    mockListComments.mockResolvedValue(carryThenRetire(null));

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({ posted: true });
    expect(mockFetchCommitAuthorEmail).not.toHaveBeenCalled();
  });

  // An unreadable fetch leaves the lane `null`, which CREDITS the retirement —
  // today's behaviour, and the anti-deadlock direction. Refusing on an unknown
  // author instead would red every open PR whose finding Ally has retired.
  it("credits the retirement when the commit fetch cannot be read", async () => {
    mockListReviews.mockResolvedValue(carryThenRetire(AUTHOR_LANE));
    mockFetchCommitAuthorEmail.mockResolvedValue(null);

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "success", outcome: "not_evaluated" },
    });
  });

  // The other half of that AC, and the direction this module must not get
  // wrong: a red already justified author-blind must still PUBLISH when the
  // lane fetch fails. The fetch sits after the author-blind pass precisely so
  // an unreadable `GET` can never turn a finding into silence.
  it("publishes a red the author-blind pass justified even when the commit fetch fails", async () => {
    mockListComments.mockResolvedValue([
      ...carryThenRetire(AUTHOR_LANE),
      blockingAt(TARGET.headSha, "2026-08-04T22:09:19Z"),
    ]);
    mockFetchCommitAuthorEmail.mockResolvedValue(null);

    await expect(runPrCommentReviewGateCheck(TARGET)).resolves.toMatchObject({
      posted: true,
      verdict: { state: "failure", outcome: "blocking_finding" },
    });
    expect(mockFetchCommitAuthorEmail).toHaveBeenCalled();
    expect(mockPostStatus.mock.calls[0][0]).toMatchObject({ state: "failure" });
  });
});

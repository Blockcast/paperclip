import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BLO-28920: the run-output attestation pinned the wake's *dispatch-time* head,
 * while the reviewer is required to review the PR's *live* head. On any PR
 * pushed to in between, a valid review sat on the PR and the run was still
 * failed `pr_review_output_missing` — then retried with the same stale head
 * (`githubHeadSha` is a `GITHUB_PR_CONTEXT_KEYS` coalescing key), so the retry
 * was deterministic rather than transient and re-posted a duplicate review.
 *
 * These tests drive the REAL `githubHasReviewerEvidenceForPr` against a faked
 * GitHub at the `fetch` boundary rather than mocking the predicate out. That is
 * deliberate: three of the four acceptance cases below (stale-head review,
 * user-seat review, no review) differ *only* inside that predicate, so mocking
 * it would collapse them into a single indistinguishable assertion and prove
 * nothing about the identity and head checks they exist to pin.
 */

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const h = vi.hoisted(() => ({ key: "" }));
h.key = PRIVATE_KEY_PEM;

vi.mock("../config.js", async () => {
  const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
  return {
    ...actual,
    loadConfig: () => ({
      ...actual.loadConfig(),
      githubAppId: "3966421",
      githubAppInstallationId: "12345678",
      githubAppPrivateKey: h.key,
      prReviewerBotLogin: "allyblockcast[bot]",
    }),
  };
});

import { probeStaleKillReviewEvidence, verifyGithubReviewerEvidence } from "../services/heartbeat.js";
import { _resetInstallationTokenCache } from "../services/github-app-auth.js";

// Live reproduction on 2026-09-12: Blockcast/magma#2003. LIVE_HEAD is the PR's
// real head, carrying two `COMMENTED` reviews by allyblockcast[bot]; four
// consecutive runs were failed `pr_review_output_missing` against it anyway.
const REPO = "Blockcast/magma";
const PR_NUMBER = 2003;
const LIVE_HEAD = "ddfda0a5376607e7b31f346ae00ee34e60d4b417";
// The wake's pinned head. Synthetic — the incident's exact dispatch-time SHA was
// not recovered — but its only load-bearing property is "a valid 40-hex SHA that
// is not LIVE_HEAD", which this has.
const WAKE_HEAD = "1111111111111111111111111111111111111111";
// A third, unrelated commit: neither the wake head nor the live head. A review
// here must still fail, or the stale-review guard is gone.
const THIRD_HEAD = "2222222222222222222222222222222222222222";

const APP_LOGIN = "allyblockcast[bot]"; // id 290875700 — the trusted App identity
const USER_SEAT_LOGIN = "allyblockcast"; // id 296676656 — a DIFFERENT principal

const FUTURE_ISO = "2999-01-01T00:00:00Z";

function jsonResponse(data: unknown, ok = true, status = 200): Response {
  return { ok, status, headers: new Headers(), json: async () => data } as unknown as Response;
}

type FakeReview = { user: { login: string }; commit_id: string; state: string };

/** Fake GitHub. `prHead` is what `/pulls/{n}` reports as the CURRENT head. */
function stubGithub(routes: { reviews?: FakeReview[]; comments?: unknown[]; prHead?: string }) {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/access_tokens")) return jsonResponse({ token: "ghs_test", expires_at: FUTURE_ISO });
    if (u.includes("/pulls/") && u.includes("/reviews")) return jsonResponse(routes.reviews ?? []);
    if (u.includes("/issues/") && u.includes("/comments")) return jsonResponse(routes.comments ?? []);
    if (u.includes("/pulls/")) return jsonResponse({ head: { sha: routes.prHead ?? LIVE_HEAD } });
    throw new Error(`unexpected url ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function snapshot(headSha: string | null) {
  return {
    reviewKind: "pr_review",
    githubRepoFullName: REPO,
    githubPrNumber: PR_NUMBER,
    ...(headSha === null ? {} : { githubHeadSha: headSha }),
  };
}

function consolidatedReviewComment(login: string, headSha: string) {
  return {
    user: { login },
    body: `## Ally — Consolidated PR Review\n\nReviewed head: ${headSha}\n\nNo blocking findings.`,
  };
}

beforeEach(() => {
  _resetInstallationTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BLO-28920: reviewer-evidence attestation accepts the live head as well as the wake's pinned head", () => {
  // (a) The regression itself.
  it("(a) credits a trusted COMMENTED review at the LIVE head when the wake pinned an older one", async () => {
    stubGithub({
      prHead: LIVE_HEAD,
      reviews: [{ user: { login: APP_LOGIN }, commit_id: LIVE_HEAD, state: "COMMENTED" }],
    });

    await expect(verifyGithubReviewerEvidence(snapshot(WAKE_HEAD))).resolves.toMatchObject({
      status: "found",
      via: "review",
      viaLiveHead: true,
      repoFullName: REPO,
      prNumber: PR_NUMBER,
      // The reported head stays the wake's, so the run event still records what
      // this run was asked about; `viaLiveHead` is what says they differed.
      headSha: WAKE_HEAD,
    });
  });

  it("(a') credits a comment-shaped review at the LIVE head too — the second surface", async () => {
    stubGithub({
      prHead: LIVE_HEAD,
      reviews: [],
      comments: [consolidatedReviewComment(APP_LOGIN, LIVE_HEAD)],
    });

    await expect(verifyGithubReviewerEvidence(snapshot(WAKE_HEAD))).resolves.toMatchObject({
      status: "found",
      via: "comment",
      viaLiveHead: true,
    });
  });

  // (b) The stale-review guard must survive the widening.
  it("(b) still fails when the only review is at a THIRD commit — neither wake nor live head", async () => {
    stubGithub({
      prHead: LIVE_HEAD,
      reviews: [{ user: { login: APP_LOGIN }, commit_id: THIRD_HEAD, state: "COMMENTED" }],
      comments: [consolidatedReviewComment(APP_LOGIN, THIRD_HEAD)],
    });

    await expect(verifyGithubReviewerEvidence(snapshot(WAKE_HEAD))).resolves.toMatchObject({
      status: "not_found",
    });
  });

  // (c) Identity boundary: the user seat is not the App (BLO-24056 / R4).
  it("(c) still fails when the only live-head review is from the USER seat, not the App", async () => {
    stubGithub({
      prHead: LIVE_HEAD,
      reviews: [{ user: { login: USER_SEAT_LOGIN }, commit_id: LIVE_HEAD, state: "APPROVED" }],
      comments: [consolidatedReviewComment(USER_SEAT_LOGIN, LIVE_HEAD)],
    });

    await expect(verifyGithubReviewerEvidence(snapshot(WAKE_HEAD))).resolves.toMatchObject({
      status: "not_found",
    });
  });

  // (d) The genuine failure this predicate exists to catch is unchanged.
  it("(d) still fails when the run posted nothing at either head", async () => {
    stubGithub({ prHead: LIVE_HEAD, reviews: [], comments: [] });

    await expect(verifyGithubReviewerEvidence(snapshot(WAKE_HEAD))).resolves.toMatchObject({
      status: "not_found",
    });
  });

  it("does not credit an unsubmitted PENDING draft at the live head", async () => {
    // A run that dies mid-MCP-review-flow leaves exactly this; crediting it
    // would let that run self-attest.
    stubGithub({
      prHead: LIVE_HEAD,
      reviews: [{ user: { login: APP_LOGIN }, commit_id: LIVE_HEAD, state: "PENDING" }],
    });

    await expect(verifyGithubReviewerEvidence(snapshot(WAKE_HEAD))).resolves.toMatchObject({
      status: "not_found",
    });
  });

  it("takes the wake head's own match without consulting the live head at all", async () => {
    const fetchMock = stubGithub({
      prHead: LIVE_HEAD,
      reviews: [{ user: { login: APP_LOGIN }, commit_id: WAKE_HEAD, state: "COMMENTED" }],
    });

    await expect(verifyGithubReviewerEvidence(snapshot(WAKE_HEAD))).resolves.toMatchObject({
      status: "found",
      via: "review",
    });
    // No `viaLiveHead` key, and no PR-head lookup: the second pass never ran.
    await expect(verifyGithubReviewerEvidence(snapshot(WAKE_HEAD))).resolves.not.toHaveProperty("viaLiveHead");
    expect(fetchMock.mock.calls.some(([url]) => /\/pulls\/\d+(\?|$)/.test(String(url)))).toBe(false);
  });

  it("does not re-run the second pass when the wake carried no head (the first pass already resolved live)", async () => {
    const fetchMock = stubGithub({ prHead: LIVE_HEAD, reviews: [], comments: [] });

    await expect(verifyGithubReviewerEvidence(snapshot(null))).resolves.toMatchObject({ status: "not_found" });

    // One reviews fetch, not two: a null pinned head already resolved live, so a
    // re-check would be byte-identical work.
    const reviewFetches = fetchMock.mock.calls.filter(([url]) => String(url).includes("/reviews"));
    expect(reviewFetches).toHaveLength(1);
  });

  it("reports a first-pass fetch failure as unavailable rather than credited or denied", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/access_tokens")) return jsonResponse({ token: "ghs_test", expires_at: FUTURE_ISO });
        if (u.includes("/reviews")) return jsonResponse({ message: "boom" }, false, 500);
        throw new Error(`unexpected url ${u}`);
      }),
    );

    await expect(verifyGithubReviewerEvidence(snapshot(WAKE_HEAD))).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("does not let a FAILING second pass convert a clean first-pass not_found into a retry", async () => {
    // The wake head genuinely has no evidence; the live-head re-check then
    // errors. Reporting `unavailable` here would turn a correct terminal
    // failure into an unbounded retry — the defect's own shape, inverted.
    let reviewsCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/access_tokens")) return jsonResponse({ token: "ghs_test", expires_at: FUTURE_ISO });
        if (u.includes("/pulls/") && u.includes("/reviews")) {
          reviewsCalls += 1;
          return reviewsCalls === 1 ? jsonResponse([]) : jsonResponse({ message: "boom" }, false, 500);
        }
        if (u.includes("/issues/") && u.includes("/comments")) return jsonResponse([]);
        if (u.includes("/pulls/")) return jsonResponse({ head: { sha: LIVE_HEAD } });
        throw new Error(`unexpected url ${u}`);
      }),
    );

    await expect(verifyGithubReviewerEvidence(snapshot(WAKE_HEAD))).resolves.toMatchObject({
      status: "not_found",
    });
  });
});

describe("BLO-18030: the stale-kill probe stays wake-head-only", () => {
  // The shared predicate has a caller that wants the OPPOSITE of the widening
  // above: a false negative there authorizes a retry, i.e. a double review. This
  // asserts the divergence rather than leaving it to inspection.
  it("reports no-evidence for a review that exists only at the live head", async () => {
    const fetchMock = stubGithub({
      prHead: LIVE_HEAD,
      reviews: [{ user: { login: APP_LOGIN }, commit_id: LIVE_HEAD, state: "COMMENTED" }],
    });

    await expect(probeStaleKillReviewEvidence({ contextSnapshot: snapshot(WAKE_HEAD) })).resolves.toBe(false);
    // It never asked GitHub what the live head was.
    expect(fetchMock.mock.calls.some(([url]) => /\/pulls\/\d+(\?|$)/.test(String(url)))).toBe(false);
  });

  it("still finds a review at the wake's own head", async () => {
    stubGithub({
      prHead: LIVE_HEAD,
      reviews: [{ user: { login: APP_LOGIN }, commit_id: WAKE_HEAD, state: "COMMENTED" }],
    });

    await expect(probeStaleKillReviewEvidence({ contextSnapshot: snapshot(WAKE_HEAD) })).resolves.toBe(true);
  });
});

import { generateKeyPairSync, createVerify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutable fake config the module reads via loadConfig(). vi.hoisted so the
// vi.mock factory (hoisted above imports) can reference it.
const h = vi.hoisted(() => ({
  cfg: {
    githubAppId: "",
    githubAppInstallationId: "",
    githubAppPrivateKey: "",
    prReviewerBotLogin: "allyblockcast[bot]",
  } as Record<string, string>,
}));

vi.mock("../config.js", () => ({ loadConfig: () => h.cfg }));

import {
  mintAppJwt,
  getInstallationToken,
  getInstallationTokenResult,
  githubHasReviewerEvidenceForPr,
  githubGetLatestCommitStatusForContext,
  githubPostCommitStatus,
  githubPostCommitStatusDetailed,
  githubReviewerAppSlug,
  githubReviewerIdentityMatches,
  normalizeGithubLogin,
  _resetInstallationTokenCache,
} from "../services/github-app-auth.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

function decodeB64UrlJson(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"));
}

function jsonResponse(data: unknown, ok = true, status = 200, headers: Record<string, string> = {}): Response {
  return { ok, status, headers: new Headers(headers), json: async () => data } as unknown as Response;
}

const FUTURE_ISO = "2999-01-01T00:00:00Z";

function setCreds() {
  h.cfg.githubAppId = "3966421";
  h.cfg.githubAppInstallationId = "12345678";
  h.cfg.githubAppPrivateKey = PRIVATE_KEY_PEM;
  h.cfg.prReviewerBotLogin = "allyblockcast[bot]";
}

function clearCreds() {
  h.cfg.githubAppId = "";
  h.cfg.githubAppInstallationId = "";
  h.cfg.githubAppPrivateKey = "";
  h.cfg.prReviewerBotLogin = "allyblockcast[bot]";
}

beforeEach(() => {
  _resetInstallationTokenCache();
  clearCreds();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normalizeGithubLogin", () => {
  it("strips @, app/, and [bot], lowercasing", () => {
    expect(normalizeGithubLogin("allyblockcast[bot]")).toBe("allyblockcast");
    expect(normalizeGithubLogin("app/AllyBlockcast")).toBe("allyblockcast");
    expect(normalizeGithubLogin("@Ally")).toBe("ally");
  });
});

describe("githubReviewerIdentityMatches", () => {
  it("extracts only unambiguous App-form reviewer configuration", () => {
    expect(githubReviewerAppSlug("allyblockcast[bot]")).toBe("allyblockcast");
    expect(githubReviewerAppSlug("app/AllyBlockcast")).toBe("allyblockcast");
    expect(githubReviewerAppSlug("allyblockcast")).toBeNull();
    expect(githubReviewerAppSlug("")).toBeNull();
  });

  it("accepts the App API variants but rejects the same-slug user seat", () => {
    expect(githubReviewerIdentityMatches("allyblockcast[bot]", "allyblockcast[bot]")).toBe(true);
    expect(githubReviewerIdentityMatches("app/AllyBlockcast", "allyblockcast[bot]")).toBe(true);
    expect(githubReviewerIdentityMatches("allyblockcast", "allyblockcast[bot]")).toBe(false);
    expect(githubReviewerIdentityMatches("allyblockcast", "allyblockcast")).toBe(false);
  });
});

describe("mintAppJwt", () => {
  it("returns null when app id / private key are unconfigured", () => {
    expect(mintAppJwt()).toBeNull();
  });

  it("mints a verifiable RS256 JWT with iss=appId and a forward exp", () => {
    setCreds();
    const nowMs = 1_700_000_000_000;
    const jwt = mintAppJwt(nowMs);
    expect(jwt).not.toBeNull();
    const [header, payload, signature] = jwt!.split(".");
    expect(decodeB64UrlJson(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decodeB64UrlJson(payload);
    expect(claims.iss).toBe("3966421");
    expect(claims.iat).toBe(Math.floor(nowMs / 1000) - 30);
    expect(claims.exp).toBe(Math.floor(nowMs / 1000) + 540);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    verifier.end();
    const sig = Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    expect(verifier.verify(PUBLIC_KEY_PEM, sig)).toBe(true);
  });
});

describe("getInstallationToken", () => {
  it("returns null without creds", async () => {
    await expect(getInstallationToken()).resolves.toBeNull();
  });

  it("mints, returns, and caches the installation token", async () => {
    setCreds();
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain("/app/installations/12345678/access_tokens");
      return jsonResponse({ token: "ghs_test", expires_at: FUTURE_ISO });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getInstallationToken()).resolves.toBe("ghs_test");
    // Second call is served from cache — no extra fetch.
    await expect(getInstallationToken()).resolves.toBe("ghs_test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null on a non-OK token response", async () => {
    setCreds();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "bad" }, false, 401)));
    await expect(getInstallationToken()).resolves.toBeNull();
  });

  it("classifies GitHub App token 403 rate limits as retryable", async () => {
    setCreds();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { message: "API rate limit exceeded for installation" },
          false,
          403,
          { "retry-after": "30" },
        ),
      ),
    );
    await expect(getInstallationTokenResult()).resolves.toMatchObject({
      ok: false,
      retryable: true,
      reason: "github_app_token_rate_limited",
      statusCode: 403,
    });
  });
});

describe("githubHasReviewerEvidenceForPr", () => {
  const repoFullName = "Blockcast/trafficcontrol";
  const prNumber = 752;
  const headSha = "45eb633e348a826f43dc68b0c25fe83a96300cea";

  function stubGithub(routes: {
    reviews?: unknown[];
    reviewsStatus?: number;
    reviewsBody?: unknown;
    reviewsHeaders?: Record<string, string>;
    comments?: unknown[];
    prHead?: string;
    // BLO-10878 cause #2: map of "base...head" → compare status ("ahead" |
    // "behind" | "identical" | "diverged"). Absent pairs 404 (unknown SHA).
    compares?: Record<string, string>;
  }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/access_tokens")) return jsonResponse({ token: "ghs_test", expires_at: FUTURE_ISO });
        if (u.includes("/compare/")) {
          const seg = decodeURIComponent(u.split("/compare/")[1]!.split("?")[0]!);
          const status = routes.compares?.[seg];
          return status ? jsonResponse({ status }) : jsonResponse({}, false, 404);
        }
        if (u.includes("/pulls/") && u.includes("/reviews")) {
          if (routes.reviewsStatus && routes.reviewsStatus >= 400) {
            return jsonResponse(
              routes.reviewsBody ?? [],
              false,
              routes.reviewsStatus,
              routes.reviewsHeaders,
            );
          }
          return jsonResponse(routes.reviews ?? []);
        }
        // BLO-10878: bare PR fetch used to resolve a missing head SHA.
        if (u.includes("/pulls/")) {
          return jsonResponse(routes.prHead !== undefined ? { head: { sha: routes.prHead } } : {});
        }
        if (u.includes("/issues/") && u.includes("/comments")) return jsonResponse(routes.comments ?? []);
        throw new Error(`unexpected url ${u}`);
      }),
    );
  }

  it("errors (no_token) when creds are absent so the caller falls back", async () => {
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      error: "no_token",
    });
  });

  it("rejects a bare-user reviewer configuration before querying GitHub", async () => {
    setCreds();
    h.cfg.prReviewerBotLogin = "allyblockcast";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      error: "bot_login_not_app_form",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finds a bot review at the exact head commit", async () => {
    setCreds();
    stubGithub({ reviews: [{ user: { login: "allyblockcast[bot]" }, commit_id: headSha }] });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      found: true,
      via: "review",
    });
  });

  it("rejects same-slug user-seat reviews without approved consolidated attestation", async () => {
    setCreds();
    stubGithub({
      reviews: [
        {
          user: { login: "allyblockcast" },
          commit_id: headSha,
          state: "COMMENTED",
          body: `## Ally — Consolidated PR Review\n\nReviewed head: ${headSha}\n\nNo findings.`,
        },
        {
          user: { login: "allyblockcast" },
          commit_id: headSha,
          state: "APPROVED",
          body: "Looks good.",
        },
      ],
      comments: [],
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      found: false,
    });
  });

  it("accepts an approved same-slug user-seat review with exact-head consolidated attestation", async () => {
    setCreds();
    stubGithub({
      reviews: [
        {
          user: { login: "allyblockcast" },
          commit_id: headSha,
          state: "APPROVED",
          body: `## Ally — Consolidated PR Review\n\nReviewed head: ${headSha}\n\nNo findings.`,
        },
      ],
      comments: [],
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      found: true,
      via: "review",
    });
  });

  it("accepts the App-prefixed reviewer identity variant", async () => {
    setCreds();
    stubGithub({ reviews: [{ user: { login: "app/allyblockcast" }, commit_id: headSha }] });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      found: true,
      via: "review",
    });
  });

  it("finds a canonical bot comment with one exact-head attestation", async () => {
    setCreds();
    stubGithub({
      reviews: [],
      comments: [
        {
          user: { login: "allyblockcast[bot]" },
          body: `## Ally — Consolidated PR Review\n\nReviewed head: ${headSha}\n\nNo findings.`,
        },
      ],
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      found: true,
      via: "comment",
    });
  });

  it("rejects a bot-authored review request even when it contains the exact head SHA", async () => {
    setCreds();
    stubGithub({
      reviews: [],
      comments: [
        {
          user: { login: "allyblockcast[bot]" },
          body: `@ally review exact head ${headSha}`,
        },
      ],
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      found: false,
    });
  });

  it("rejects a consolidated comment with duplicate full-SHA attestations", async () => {
    setCreds();
    stubGithub({
      reviews: [],
      comments: [
        {
          user: { login: "allyblockcast[bot]" },
          body: `## Ally — Consolidated PR Review\nReviewed head: ${headSha}\nReviewed head: ${headSha}`,
        },
      ],
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      found: false,
    });
  });

  it("BLO-10878: matches a comment-mode review when the head SHA is wrapped in markdown italics (trailing _)", async () => {
    setCreds();
    // Real paperclip#458 shape: Ally's consolidated review embeds the head SHA in
    // an italic run (`_reviewed head: <sha>_`), so a `_` sits immediately after the
    // final hex digit. `_` is a `\w` char, so a `\b…\b`-anchored pattern finds no
    // trailing word boundary and the review is mis-flagged as missing.
    stubGithub({
      reviews: [],
      comments: [
        { user: { login: "allyblockcast[bot]" }, body: `## Ally — Consolidated PR Review\n_reviewed head: ${headSha}_` },
      ],
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      found: true,
      via: "comment",
    });
  });

  it("BLO-10878: falls back to the PR head when the wake carried no head SHA, then matches a comment-mode review", async () => {
    setCreds();
    stubGithub({
      prHead: headSha,
      reviews: [],
      comments: [{ user: { login: "allyblockcast[bot]" }, body: `## Ally — Consolidated PR Review\n_reviewed head: ${headSha}_` }],
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha: null })).resolves.toEqual({
      found: true,
      via: "comment",
    });
  });

  it("BLO-10878: keeps the lenient any-bot-review fallback when the head SHA can't be resolved", async () => {
    setCreds();
    // No head SHA on the wake and the PR fetch yields no head → the formal-review
    // loop still rescues on any bot review (unchanged pre-existing leniency).
    stubGithub({ reviews: [{ user: { login: "allyblockcast[bot]" }, commit_id: null }] });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha: null })).resolves.toEqual({
      found: true,
      via: "review",
    });
  });

  it("BLO-10878: returns not-found when the resolved PR head has no bot review or comment", async () => {
    setCreds();
    stubGithub({
      prHead: headSha,
      reviews: [],
      comments: [{ user: { login: "someone-else" }, body: headSha }],
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha: null })).resolves.toEqual({
      found: false,
    });
  });

  it("does not match a review by a different author or at a different head", async () => {
    setCreds();
    stubGithub({
      reviews: [
        { user: { login: "someone-else" }, commit_id: headSha },
        { user: { login: "allyblockcast[bot]" }, commit_id: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
      ],
      comments: [{ user: { login: "allyblockcast[bot]" }, body: "no sha referenced here" }],
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      found: false,
    });
  });

  // BLO-10878 cause #2 — at-or-newer head: the bot frequently reviews a DESCENDANT
  // of the wake head (the PR advanced between wake and review). An exact-head match
  // fails, so fall back to a `compare` check and credit a review/comment whose head
  // is the wake head or a descendant ("ahead"/"identical"), but not older/diverged.
  const DESCENDANT = "aaaaaaaa1111111111111111111111111111aaaa";
  const ANCESTOR = "bbbbbbbb2222222222222222222222222222bbbb";
  const DIVERGED = "cccccccc3333333333333333333333333333cccc";

  it("BLO-10878: credits a bot formal review at a descendant head (at-or-newer)", async () => {
    setCreds();
    stubGithub({
      reviews: [{ user: { login: "allyblockcast[bot]" }, commit_id: DESCENDANT }],
      comments: [],
      compares: { [`${headSha}...${DESCENDANT}`]: "ahead" },
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      found: true,
      via: "review",
    });
  });

  it("BLO-10878: credits a comment-mode review embedding a descendant head (at-or-newer)", async () => {
    setCreds();
    stubGithub({
      reviews: [],
      comments: [
        { user: { login: "allyblockcast[bot]" }, body: `## Ally — Consolidated PR Review\n_reviewed head: ${DESCENDANT}_` },
      ],
      compares: { [`${headSha}...${DESCENDANT}`]: "ahead" },
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      found: true,
      via: "comment",
    });
  });

  it("BLO-10878: does NOT credit a bot review at a strictly-older head (behind)", async () => {
    setCreds();
    stubGithub({
      reviews: [{ user: { login: "allyblockcast[bot]" }, commit_id: ANCESTOR }],
      comments: [],
      compares: { [`${headSha}...${ANCESTOR}`]: "behind" },
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      found: false,
    });
  });

  it("BLO-10878: does NOT credit a diverged head", async () => {
    setCreds();
    stubGithub({
      reviews: [{ user: { login: "allyblockcast[bot]" }, commit_id: DIVERGED }],
      comments: [],
      compares: { [`${headSha}...${DIVERGED}`]: "diverged" },
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      found: false,
    });
  });

  it("BLO-10878: skips a candidate whose compare 404s (bogus hex) without erroring", async () => {
    setCreds();
    stubGithub({
      reviews: [{ user: { login: "allyblockcast[bot]" }, commit_id: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }],
      comments: [],
      // no `compares` entry → the candidate 404s and is skipped (not a fatal error).
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      found: false,
    });
  });

  it("returns an error on a non-OK reviews response (caller keeps heuristic verdict)", async () => {
    setCreds();
    stubGithub({ reviewsStatus: 500 });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      error: "reviews_http_500",
    });
  });

  it("classifies rate-limited review fetches distinctly so callers can retry", async () => {
    setCreds();
    stubGithub({
      reviewsStatus: 403,
      reviewsBody: { message: "You have exceeded a secondary rate limit" },
      reviewsHeaders: { "retry-after": "30" },
    });
    await expect(githubHasReviewerEvidenceForPr({ repoFullName, prNumber, headSha })).resolves.toEqual({
      error: "reviews_rate_limited",
    });
  });
});

describe("githubGetLatestCommitStatusForContext (BLO-17456)", () => {
  const repoFullName = "Blockcast/hang";
  const sha = "45eb633e348a826f43dc68b0c25fe83a96300cea";
  const context = "review/ally-complete";

  it("paginates commit statuses until the target context is found", async () => {
    setCreds();
    const otherStatuses = Array.from({ length: 100 }, (_value, index) => ({
      context: `other/context-${index}`,
      state: "success",
      created_at: "2026-07-31T10:00:00Z",
    }));
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/access_tokens")) return jsonResponse({ token: "ghs_test", expires_at: FUTURE_ISO });
      if (u.includes("/statuses?per_page=100&page=1")) return jsonResponse(otherStatuses);
      if (u.includes("/statuses?per_page=100&page=2")) {
        return jsonResponse([
          {
            context,
            state: "success",
            created_at: "2026-07-31T10:01:00Z",
            target_url: "https://github.com/Blockcast/hang/pull/7",
          },
        ]);
      }
      throw new Error(`unexpected url ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(githubGetLatestCommitStatusForContext({ repoFullName, sha, context })).resolves.toEqual({
      ok: true,
      status: {
        context,
        state: "success",
        createdAt: "2026-07-31T10:01:00Z",
        targetUrl: "https://github.com/Blockcast/hang/pull/7",
      },
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/statuses?")).length).toBe(2);
  });

  it("classifies 403 rate-limited status reads as retryable", async () => {
    setCreds();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/access_tokens")) return jsonResponse({ token: "ghs_test", expires_at: FUTURE_ISO });
        if (u.includes("/statuses?")) {
          return jsonResponse({ message: "You have exceeded a secondary rate limit" }, false, 403);
        }
        throw new Error(`unexpected url ${u}`);
      }),
    );

    await expect(githubGetLatestCommitStatusForContext({ repoFullName, sha, context })).resolves.toMatchObject({
      ok: false,
      retryable: true,
      reason: "commit_status_read_rate_limited",
      statusCode: 403,
    });
  });
});

describe("githubPostCommitStatus (BLO-17456)", () => {
  const repoFullName = "Blockcast/hang";
  const sha = "45eb633e348a826f43dc68b0c25fe83a96300cea";
  const context = "review/ally-complete";

  function stubStatusPost(ok = true, status = 201) {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/access_tokens")) return jsonResponse({ token: "ghs_test", expires_at: FUTURE_ISO });
      if (u.includes("/statuses/")) return jsonResponse({ id: 1 }, ok, status);
      throw new Error(`unexpected url ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("does not write when creds are absent, so an unmounted app never posts", async () => {
    const fetchMock = stubStatusPost();
    await expect(
      githubPostCommitStatus({ repoFullName, sha, context, state: "failure" }),
    ).resolves.toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/statuses/"))).toBe(false);
  });

  it("POSTs state + context to the exact head SHA", async () => {
    setCreds();
    const fetchMock = stubStatusPost();
    await expect(
      githubPostCommitStatus({
        repoFullName,
        sha,
        context,
        state: "failure",
        description: "reviewer exhausted retries",
        targetUrl: "https://github.com/Blockcast/hang/pull/7",
      }),
    ).resolves.toBe(true);

    const post = fetchMock.mock.calls.find(([url]) => String(url).includes("/statuses/"));
    expect(String(post?.[0])).toContain(`/repos/${repoFullName}/statuses/${sha}`);
    const init = post?.[1] as { method?: string; body?: string };
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body ?? "{}")).toEqual({
      state: "failure",
      context,
      description: "reviewer exhausted retries",
      target_url: "https://github.com/Blockcast/hang/pull/7",
    });
  });

  it("omits description/target_url when not supplied", async () => {
    setCreds();
    const fetchMock = stubStatusPost();
    await githubPostCommitStatus({ repoFullName, sha, context, state: "failure", targetUrl: null });
    const post = fetchMock.mock.calls.find(([url]) => String(url).includes("/statuses/"));
    expect(JSON.parse((post?.[1] as { body?: string }).body ?? "{}")).toEqual({
      state: "failure",
      context,
    });
  });

  it("truncates the description to GitHub's 140-char limit", async () => {
    setCreds();
    const fetchMock = stubStatusPost();
    await githubPostCommitStatus({ repoFullName, sha, context, state: "failure", description: "x".repeat(200) });
    const post = fetchMock.mock.calls.find(([url]) => String(url).includes("/statuses/"));
    expect(JSON.parse((post?.[1] as { body?: string }).body ?? "{}").description).toHaveLength(140);
  });

  it("returns false on a non-OK write (e.g. the App lacks statuses:write)", async () => {
    setCreds();
    stubStatusPost(false, 403);
    await expect(
      githubPostCommitStatus({ repoFullName, sha, context, state: "failure" }),
    ).resolves.toBe(false);
  });

  it("classifies 403 rate-limited status writes as retryable", async () => {
    setCreds();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/access_tokens")) return jsonResponse({ token: "ghs_test", expires_at: FUTURE_ISO });
        if (u.includes("/statuses/")) {
          return jsonResponse(
            { message: "API rate limit exceeded for installation" },
            false,
            403,
            { "x-ratelimit-remaining": "0" },
          );
        }
        throw new Error(`unexpected url ${u}`);
      }),
    );

    await expect(
      githubPostCommitStatusDetailed({ repoFullName, sha, context, state: "failure" }),
    ).resolves.toMatchObject({
      ok: false,
      retryable: true,
      reason: "commit_status_write_rate_limited",
      statusCode: 403,
    });
  });

  it("returns false rather than throwing when the write rejects", async () => {
    setCreds();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).includes("/access_tokens")) {
          return jsonResponse({ token: "ghs_test", expires_at: FUTURE_ISO });
        }
        throw new Error("network down");
      }),
    );
    await expect(
      githubPostCommitStatus({ repoFullName, sha, context, state: "failure" }),
    ).resolves.toBe(false);
  });
});

/**
 * Minimal GitHub App auth + PR-review evidence verification (BLO-10448).
 *
 * The PR-review completion guard (`evaluatePrReviewCompletionEvidence` in
 * heartbeat.ts) is a text heuristic over the agent's free-text summary; it
 * flags `pr_review_output_missing` whenever the summary lacks a recognized
 * posted-review / skip marker. In practice that misfires on legitimate runs
 * (for example, an idempotency skip or a formal App approval) — the PR *was*
 * reviewed, but the phrasing wasn't matched. This module lets the server check
 * the authoritative source — GitHub — before keeping that `missing` verdict.
 *
 * The server has no ambient GitHub token, so we mint short-lived **installation
 * tokens** from the GitHub App creds (`paperclip-github-app-creds`, surfaced via
 * GITHUB_APP_ID / GITHUB_APP_INSTALLATION_ID / GITHUB_APP_PRIVATE_KEY). Uses only
 * node:crypto for the RS256 App JWT — no extra dependency. When creds are absent
 * every entrypoint degrades to null/`{error}`. Callers distinguish an
 * unavailable verification service from a definitive missing-evidence result,
 * but neither outcome can authorize a locally claimed review.
 */
import { createSign } from "node:crypto";

import { loadConfig } from "../config.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";

const GITHUB_HOST = "github.com";
const GITHUB_API_HEADERS = { accept: "application/vnd.github+json" } as const;
// Refresh the installation token this long before its stated expiry so an
// in-flight request never races the 1h boundary.
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Normalize a GitHub author handle to a bare slug: strips a leading `@` or
 * `app/`, a trailing `[bot]`, and lowercases. Mirrors the heuristic guard's
 * `normalizeGithubAuthorHandle` (kept local to avoid a heartbeat.ts import cycle).
 */
export function normalizeGithubLogin(login: string): string {
  return login
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/^app\//, "")
    .replace(/\[bot\]$/, "")
    .trim();
}

function exactGithubLogin(login: string): string {
  return login.trim().toLowerCase().replace(/^@/, "");
}

/** Return the slug from an unambiguous GitHub App login, or null for a user login. */
export function githubReviewerAppSlug(configuredLogin: string): string | null {
  const configured = exactGithubLogin(configuredLogin);
  if (configured.startsWith("app/")) {
    return configured.slice("app/".length) || null;
  }
  if (configured.endsWith("[bot]")) {
    return configured.slice(0, -"[bot]".length) || null;
  }
  return null;
}

/**
 * Match only the configured GitHub App identity. GitHub can expose that App as
 * either `<slug>[bot]` or `app/<slug>` depending on the API surface, but the
 * bare `<slug>` user seat is a distinct principal and must never count as the
 * reviewer bot.
 */
export function githubReviewerIdentityMatches(login: string, configuredLogin: string): boolean {
  const candidate = exactGithubLogin(login);
  const appSlug = githubReviewerAppSlug(configuredLogin);
  if (!candidate || !appSlug) return false;

  // GitHub usernames cannot contain `[`/`]` or `/`, so a user account cannot
  // register either accepted App representation and collide with this match.
  return candidate === `${appSlug}[bot]` || candidate === `app/${appSlug}`;
}

/**
 * Mint an RS256 GitHub App JWT (valid ~9 min). Returns null when the App id or
 * private key is unconfigured.
 */
export function mintAppJwt(nowMs: number = Date.now()): string | null {
  const cfg = loadConfig();
  const appId = cfg.githubAppId.trim();
  const privateKey = cfg.githubAppPrivateKey;
  if (!appId || !privateKey.trim()) return null;

  const nowSec = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat back-dated 30s to tolerate minor clock skew; exp +9 min (GitHub caps at 10).
  const payload = base64Url(JSON.stringify({ iat: nowSec - 30, exp: nowSec + 540, iss: appId }));
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    signer.end();
    return `${header}.${payload}.${base64Url(signer.sign(privateKey))}`;
  } catch {
    return null;
  }
}

let cachedInstallationToken: { token: string; expiresAtMs: number } | null = null;

/** Test-only: drop the cached installation token. */
export function _resetInstallationTokenCache(): void {
  cachedInstallationToken = null;
}

export type GitHubInstallationTokenResult =
  | { ok: true; token: string }
  | { ok: false; retryable: boolean; reason: string; statusCode?: number };

function isRetryableGithubHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

type ClassifiedGithubHttpFailure = { retryable: boolean; reason: string };

async function githubRateLimitSignal(res: Response): Promise<boolean> {
  const retryAfter = res.headers?.get("retry-after");
  if (retryAfter && retryAfter.trim().length > 0) return true;
  if (res.headers?.get("x-ratelimit-remaining") === "0") return true;

  const body = await res.json().catch(() => null) as unknown;
  const bodyText = JSON.stringify(body ?? "").toLowerCase();
  return bodyText.includes("rate limit") || bodyText.includes("secondary rate limit") || bodyText.includes("abuse detection");
}

async function classifyGithubHttpFailure(prefix: string, res: Response): Promise<ClassifiedGithubHttpFailure> {
  if (res.status === 403 && await githubRateLimitSignal(res)) {
    return { retryable: true, reason: `${prefix}_rate_limited` };
  }
  const status = res.status;
  if (isRetryableGithubHttpStatus(status)) {
    return { retryable: true, reason: `${prefix}_http_${status}` };
  }
  return { retryable: false, reason: `${prefix}_http_${status}` };
}

export function githubAppCredentialsConfigured(): boolean {
  const cfg = loadConfig();
  return Boolean(
    cfg.githubAppId.trim() &&
    cfg.githubAppInstallationId.trim() &&
    cfg.githubAppPrivateKey.trim(),
  );
}

/**
 * Return a cached or freshly-minted installation access token, or null when
 * creds are absent or the GitHub API call fails.
 */
export async function getInstallationTokenResult(nowMs: number = Date.now()): Promise<GitHubInstallationTokenResult> {
  if (cachedInstallationToken && cachedInstallationToken.expiresAtMs - TOKEN_REFRESH_SKEW_MS > nowMs) {
    return { ok: true, token: cachedInstallationToken.token };
  }
  const cfg = loadConfig();
  const installationId = cfg.githubAppInstallationId.trim();
  const jwt = mintAppJwt(nowMs);
  if (!githubAppCredentialsConfigured()) {
    return { ok: false, retryable: false, reason: "missing_github_app_credentials" };
  }
  if (!jwt) return { ok: false, retryable: false, reason: "invalid_github_app_private_key" };
  if (!installationId) return { ok: false, retryable: false, reason: "missing_github_app_installation_id" };

  const url = `${gitHubApiBase(GITHUB_HOST)}/app/installations/${installationId}/access_tokens`;
  let res: Response;
  try {
    res = await ghFetch(url, {
      method: "POST",
      headers: { ...GITHUB_API_HEADERS, authorization: `Bearer ${jwt}` },
    });
  } catch {
    return { ok: false, retryable: true, reason: "github_app_token_fetch_failed" };
  }
  if (!res.ok) {
    const classified = await classifyGithubHttpFailure("github_app_token", res);
    return { ok: false, ...classified, statusCode: res.status };
  }
  const body = (await res.json().catch(() => null)) as { token?: string; expires_at?: string } | null;
  if (!body?.token) return { ok: false, retryable: true, reason: "github_app_token_missing" };

  const parsedExpiry = body.expires_at ? Date.parse(body.expires_at) : NaN;
  cachedInstallationToken = {
    token: body.token,
    expiresAtMs: Number.isFinite(parsedExpiry) ? parsedExpiry : nowMs + 30 * 60 * 1000,
  };
  return { ok: true, token: cachedInstallationToken.token };
}

export async function getInstallationToken(nowMs: number = Date.now()): Promise<string | null> {
  const result = await getInstallationTokenResult(nowMs);
  return result.ok ? result.token : null;
}

export type ReviewerEvidenceResult =
  | { found: true; via: "review" }
  | { found: false }
  | { error: string };

export type PullRequestGateResult =
  | { state: "open" | "closed"; merged: boolean }
  | { error: string };

export async function githubGetPullRequestGate(input: {
  repoFullName: string;
  prNumber: number;
}): Promise<PullRequestGateResult> {
  const tokenResult = await getInstallationTokenResult();
  if (!tokenResult.ok) return { error: tokenResult.reason };

  const apiBase = gitHubApiBase(GITHUB_HOST);
  let res: Response;
  try {
    res = await ghFetch(`${apiBase}/repos/${input.repoFullName}/pulls/${input.prNumber}`, {
      headers: { ...GITHUB_API_HEADERS, authorization: `Bearer ${tokenResult.token}` },
    });
  } catch {
    return { error: "pull_request_fetch_failed" };
  }
  if (!res.ok) {
    const classified = await classifyGithubHttpFailure("pull_request", res);
    return { error: classified.reason };
  }
  const body = (await res.json().catch(() => null)) as {
    state?: string;
    merged?: boolean;
  } | null;
  if (body?.state !== "open" && body?.state !== "closed") {
    return { error: "pull_request_state_missing" };
  }
  return { state: body.state, merged: body.merged === true };
}

/** Extract the leading 7-40 hex chars of a head SHA, or null. */
function headShaHex(headSha: string | null | undefined): string | null {
  if (!headSha) return null;
  return headSha.match(/^[0-9a-f]{7,40}/i)?.[0]?.toLowerCase() ?? null;
}

/**
 * Fetch the PR's current head SHA when the reviewer wake omitted one. The App
 * gate is tied to that exact commit; a missing/unreadable PR head therefore
 * fails closed rather than accepting review evidence for an arbitrary commit.
 */
async function fetchPrHeadSha(
  apiBase: string,
  repoFullName: string,
  prNumber: number,
  headers: Record<string, string>,
): Promise<string | null> {
  try {
    const res = await ghFetch(`${apiBase}/repos/${repoFullName}/pulls/${prNumber}`, { headers });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { head?: { sha?: string } } | null;
    const sha = body?.head?.sha;
    return typeof sha === "string" ? headShaHex(sha) : null;
  } catch {
    return null;
  }
}

/**
 * Authoritatively check whether the reviewer GitHub App approved THIS PR's
 * required head before a claimed PR-review run can complete.
 *
 * Found only when an APPROVED formal review from the configured App is recorded
 * on the exact wake head, or on the PR's resolved current head when the wake
 * omitted it. The same-slug user seat is a separate team-evidence lane; issue
 * comments and descendant reviews cannot satisfy this App gate.
 *
 * Returns `{error}` on invalid configuration, missing creds/token, or any non-OK
 * or failed reviews fetch. Callers fail completion closed with a retryable
 * verification-unavailable error. An unresolved required head returns
 * `{found:false}` and never accepts arbitrary review evidence.
 */
export async function githubHasReviewerEvidenceForPr(input: {
  repoFullName: string;
  prNumber: number;
  headSha: string | null;
}): Promise<ReviewerEvidenceResult> {
  const cfg = loadConfig();
  const botLogin = cfg.prReviewerBotLogin.trim();
  if (!botLogin) return { error: "no_bot_login" };
  if (!githubReviewerAppSlug(botLogin)) return { error: "bot_login_not_app_form" };

  const token = await getInstallationToken();
  if (!token) return { error: "no_token" };

  const headers = { ...GITHUB_API_HEADERS, authorization: `Bearer ${token}` };
  const apiBase = gitHubApiBase(GITHUB_HOST);
  const headSha =
    headShaHex(input.headSha) ?? (await fetchPrHeadSha(apiBase, input.repoFullName, input.prNumber, headers));
  if (!headSha) return { found: false };

  // Only a formal APPROVED review from the configured App at the required exact
  // head can satisfy the protected App lane.
  try {
    for (let page = 1; page <= 10; page += 1) {
      const url = `${apiBase}/repos/${input.repoFullName}/pulls/${input.prNumber}/reviews?per_page=100&page=${page}`;
      const res = await ghFetch(url, { headers });
      if (!res.ok) {
        const classified = await classifyGithubHttpFailure("reviews", res);
        return { error: classified.reason };
      }
      const batch = (await res.json()) as Array<{
        user?: { login?: string };
        commit_id?: string | null;
        state?: string | null;
      }>;
      for (const review of batch) {
        const authorLogin = review.user?.login ?? "";
        const commitId = headShaHex(review.commit_id);
        if (githubReviewerIdentityMatches(authorLogin, botLogin)) {
          if ((review.state ?? "").toUpperCase() !== "APPROVED") continue;
          if (commitId === headSha) return { found: true, via: "review" };
        }
      }
      if (batch.length < 100) break;
    }
  } catch {
    return { error: "reviews_fetch_failed" };
  }

  return { found: false };
}

/**
 * List issue/PR comment bodies (first page, up to 100) for dedup scans.
 * Returns null when GitHub App creds are absent or the fetch fails — callers
 * treat null as "can't tell" and skip any write, so an inert app never
 * blind-posts. A PR→issue back-link is posted at PR-open time (the earliest
 * comment), so page 1 in GitHub's oldest-first order always contains its marker
 * once posted. (BLO-13353)
 */
export async function githubListIssueCommentBodies(input: {
  repoFullName: string;
  prNumber: number;
}): Promise<string[] | null> {
  const token = await getInstallationToken();
  if (!token) return null;
  const headers = { ...GITHUB_API_HEADERS, authorization: `Bearer ${token}` };
  const apiBase = gitHubApiBase(GITHUB_HOST);
  try {
    const url = `${apiBase}/repos/${input.repoFullName}/issues/${input.prNumber}/comments?per_page=100&page=1`;
    const res = await ghFetch(url, { headers });
    if (!res.ok) return null;
    const batch = (await res.json()) as Array<{ body?: string | null }>;
    return batch.map((c) => c.body ?? "");
  } catch {
    return null;
  }
}

export type GitHubCommitStatusState = "error" | "failure" | "pending" | "success";

export type GitHubCommitStatusPostResult =
  | { ok: true; statusCode: number }
  | { ok: false; retryable: boolean; reason: string; statusCode?: number };

export type GitHubCommitStatusLookupResult =
  | {
      ok: true;
      status: {
        state: GitHubCommitStatusState;
        context: string;
        createdAt: string | null;
        targetUrl: string | null;
      } | null;
    }
  | { ok: false; retryable: boolean; reason: string; statusCode?: number };

function asCommitStatusFailure(result: Extract<GitHubInstallationTokenResult, { ok: false }>): GitHubCommitStatusPostResult {
  return {
    ok: false,
    retryable: result.retryable,
    reason: result.reason,
    ...(result.statusCode ? { statusCode: result.statusCode } : {}),
  };
}

/**
 * Read the latest commit status for a single context. The REST list is sorted
 * here by created_at so callers do not depend on GitHub response ordering.
 */
export async function githubGetLatestCommitStatusForContext(input: {
  repoFullName: string;
  sha: string;
  context: string;
}): Promise<GitHubCommitStatusLookupResult> {
  const token = await getInstallationTokenResult();
  if (!token.ok) return asCommitStatusFailure(token) as GitHubCommitStatusLookupResult;
  const headers = { ...GITHUB_API_HEADERS, authorization: `Bearer ${token.token}` };
  const apiBase = gitHubApiBase(GITHUB_HOST);
  try {
    const candidates: Array<{
      state: GitHubCommitStatusState;
      context: string;
      createdAt: string | null;
      targetUrl: string | null;
    }> = [];
    for (let page = 1; page <= 10; page += 1) {
      const url = `${apiBase}/repos/${input.repoFullName}/commits/${input.sha}/statuses?per_page=100&page=${page}`;
      const res = await ghFetch(url, { headers });
      if (!res.ok) {
        const classified = await classifyGithubHttpFailure("commit_status_read", res);
        return { ok: false, ...classified, statusCode: res.status };
      }
      const body = (await res.json().catch(() => [])) as Array<{
        context?: string;
        state?: string;
        created_at?: string | null;
        target_url?: string | null;
      }>;
      candidates.push(
        ...body
          .filter((status) => status.context === input.context)
          .map((status) => ({
            state: status.state as GitHubCommitStatusState,
            context: status.context ?? "",
            createdAt: typeof status.created_at === "string" ? status.created_at : null,
            targetUrl: typeof status.target_url === "string" ? status.target_url : null,
          }))
          .filter((status) =>
            status.state === "error" ||
            status.state === "failure" ||
            status.state === "pending" ||
            status.state === "success",
          ),
      );
      if (body.length < 100) break;
    }
    candidates.sort((left, right) => {
      const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
      const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
      return rightTime - leftTime;
    });
    return { ok: true, status: candidates[0] ?? null };
  } catch {
    return { ok: false, retryable: true, reason: "commit_status_read_fetch_failed" };
  }
}

/**
 * Post a commit status as the GitHub App with a classified result so callers
 * can retry transient failures and surface permanent configuration/permission
 * failures separately.
 */
export async function githubPostCommitStatusDetailed(input: {
  repoFullName: string;
  sha: string;
  context: string;
  state: GitHubCommitStatusState;
  description?: string;
  targetUrl?: string | null;
}): Promise<GitHubCommitStatusPostResult> {
  const token = await getInstallationTokenResult();
  if (!token.ok) return asCommitStatusFailure(token);
  const headers = {
    ...GITHUB_API_HEADERS,
    authorization: `Bearer ${token.token}`,
    "content-type": "application/json",
  };
  const apiBase = gitHubApiBase(GITHUB_HOST);
  try {
    const url = `${apiBase}/repos/${input.repoFullName}/statuses/${input.sha}`;
    const res = await ghFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        state: input.state,
        context: input.context,
        // GitHub truncates at 140 chars; trim here so the message we intend is
        // the message that lands rather than an arbitrary server-side cut.
        ...(input.description ? { description: input.description.slice(0, 140) } : {}),
        ...(input.targetUrl ? { target_url: input.targetUrl } : {}),
      }),
    });
    if (res.ok) return { ok: true, statusCode: res.status };
    const classified = await classifyGithubHttpFailure("commit_status_write", res);
    return { ok: false, ...classified, statusCode: res.status };
  } catch {
    return { ok: false, retryable: true, reason: "commit_status_write_fetch_failed" };
  }
}

/**
 * Boolean compatibility wrapper for existing call sites.
 */
export async function githubPostCommitStatus(input: {
  repoFullName: string;
  sha: string;
  context: string;
  state: GitHubCommitStatusState;
  description?: string;
  targetUrl?: string | null;
}): Promise<boolean> {
  const result = await githubPostCommitStatusDetailed(input);
  return result.ok;
}

/**
 * Post an issue/PR comment as the GitHub App. Returns false when creds are
 * absent or the write fails — the caller logs and continues; a back-link post
 * failure must never break the webhook wake path. (BLO-13353)
 */
export async function githubPostIssueComment(input: {
  repoFullName: string;
  prNumber: number;
  body: string;
}): Promise<boolean> {
  const token = await getInstallationToken();
  if (!token) return false;
  const headers = {
    ...GITHUB_API_HEADERS,
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const apiBase = gitHubApiBase(GITHUB_HOST);
  try {
    const url = `${apiBase}/repos/${input.repoFullName}/issues/${input.prNumber}/comments`;
    const res = await ghFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: input.body }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

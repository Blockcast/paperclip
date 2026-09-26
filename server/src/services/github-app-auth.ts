/**
 * Minimal GitHub App auth + PR-review evidence verification (BLO-10448).
 *
 * The PR-review completion guard (`evaluatePrReviewCompletionEvidence` in
 * heartbeat.ts) is a text heuristic over the agent's free-text summary; it
 * flags `pr_review_output_missing` whenever the summary lacks a recognized
 * posted-review / skip marker. In practice that misfires on legitimate runs
 * (an idempotency skip, or a comment-shaped review whose phrasing wasn't
 * matched) — the PR *was* reviewed. This module lets the server check
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

import { scrubGitHubEgressText } from "@paperclipai/adapter-utils";

import { loadConfig } from "../config.js";
import {
  extractAllyReviewedHeadSha,
  hasAllyConsolidatedReviewHeading,
} from "./ally-review-detection.js";
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
export async function getInstallationTokenResult(
  nowMs: number = Date.now(),
  options: { signal?: AbortSignal } = {},
): Promise<GitHubInstallationTokenResult> {
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
      signal: options.signal,
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
  | { found: true; via: "review" | "comment" }
  | { found: false }
  | { error: string };

export type PullRequestGateResult =
  | { state: "open" | "closed"; merged: boolean }
  | { error: string };

export type GitHubCommitEvidenceResult =
  | { found: true }
  | { found: false }
  | { error: string };

export async function githubHasCommitEvidence(input: {
  repoFullName: string;
  sha: string;
}): Promise<GitHubCommitEvidenceResult> {
  const tokenResult = await getInstallationTokenResult();
  if (!tokenResult.ok) return { error: tokenResult.reason };
  try {
    const res = await ghFetch(
      `${gitHubApiBase(GITHUB_HOST)}/repos/${input.repoFullName}/commits/${input.sha}`,
      { headers: { ...GITHUB_API_HEADERS, authorization: `Bearer ${tokenResult.token}` } },
    );
    if (res.ok) return { found: true };
    const classified = await classifyGithubHttpFailure("commit", res);
    return classified.retryable ? { error: classified.reason } : { found: false };
  } catch {
    return { error: "commit_fetch_failed" };
  }
}

export async function githubGetPullRequestGate(input: {
  repoFullName: string;
  prNumber: number;
  signal?: AbortSignal;
}): Promise<PullRequestGateResult> {
  const tokenResult = await getInstallationTokenResult();
  if (!tokenResult.ok) return { error: tokenResult.reason };

  const apiBase = gitHubApiBase(GITHUB_HOST);
  let res: Response;
  try {
    res = await ghFetch(`${apiBase}/repos/${input.repoFullName}/pulls/${input.prNumber}`, {
      headers: { ...GITHUB_API_HEADERS, authorization: `Bearer ${tokenResult.token}` },
      signal: input.signal,
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

/**
 * Terminal-state lookup for a single Actions run, used to decide whether a board
 * approval card that points at that run is still worth a human's attention.
 *
 * The three outcomes are kept distinct on purpose (BLO-29359). A card must only be
 * closed on positive evidence that its gate is over: `not_found` is that evidence
 * (the run is gone), `error` explicitly is NOT — a rate-limited or 5xx lookup must
 * leave the card alone and retry, or a throttled GitHub would silently retire live
 * gates.
 *
 * A raw 404 is *not* by itself that positive evidence: GitHub returns it for an
 * inaccessible repository as readily as for a deleted run. `not_found` is therefore
 * only returned once the repository has been confirmed readable — see
 * `classifyWorkflowRunNotFound`.
 */
export type WorkflowRunLookup =
  | { outcome: "found"; status: string; conclusion: string | null; htmlUrl: string | null }
  | { outcome: "not_found" }
  | { outcome: "error"; retryable: boolean; reason: string };

/**
 * Disambiguate a 404 on a workflow-run lookup.
 *
 * GitHub returns 404 both for a run that has genuinely been deleted *and* for a
 * repository the installation token cannot see — an App that was never installed on
 * it, had its access revoked, or a private repo outside the installation. Those are
 * opposite facts with opposite consequences: `not_found` is the single outcome that
 * closes an approval card, so treating an access failure as a deleted run would
 * irreversibly cancel every live gate in that repository, which is exactly the bulk
 * retirement `githubGetWorkflowRun`'s contract forbids.
 *
 * So probe the repository itself. A readable repo makes the run's absence positive
 * evidence; anything else is ambiguous and must defer instead of closing.
 */
async function classifyWorkflowRunNotFound(input: {
  apiBase: string;
  repoFullName: string;
  token: string;
}): Promise<WorkflowRunLookup> {
  let res: Response;
  try {
    res = await ghFetch(`${input.apiBase}/repos/${input.repoFullName}`, {
      headers: { ...GITHUB_API_HEADERS, authorization: `Bearer ${input.token}` },
    });
  } catch {
    return { outcome: "error", retryable: true, reason: "workflow_run_repo_probe_failed" };
  }
  // The repo is readable, so the run really is gone.
  if (res.ok) return { outcome: "not_found" };
  if (res.status === 404 || res.status === 403 || res.status === 401) {
    // Not retryable in the sense that waiting will not fix it — it needs an
    // installation or permission change. Deferring (never closing) is the safe
    // direction: a stale card costs a queue row, a wrongly-cancelled one costs a
    // production deploy gate that cannot be un-cancelled.
    return {
      outcome: "error",
      retryable: false,
      reason: `workflow_run_repo_inaccessible_${res.status}`,
    };
  }
  const classified = await classifyGithubHttpFailure("workflow_run_repo", res);
  return { outcome: "error", retryable: classified.retryable, reason: classified.reason };
}

export async function githubGetWorkflowRun(input: {
  repoFullName: string;
  runId: number;
}): Promise<WorkflowRunLookup> {
  const tokenResult = await getInstallationTokenResult();
  if (!tokenResult.ok) {
    return { outcome: "error", retryable: tokenResult.retryable, reason: tokenResult.reason };
  }

  const apiBase = gitHubApiBase(GITHUB_HOST);
  let res: Response;
  try {
    res = await ghFetch(`${apiBase}/repos/${input.repoFullName}/actions/runs/${input.runId}`, {
      headers: { ...GITHUB_API_HEADERS, authorization: `Bearer ${tokenResult.token}` },
    });
  } catch {
    return { outcome: "error", retryable: true, reason: "workflow_run_fetch_failed" };
  }
  if (res.status === 404) {
    return await classifyWorkflowRunNotFound({
      apiBase,
      repoFullName: input.repoFullName,
      token: tokenResult.token,
    });
  }
  if (!res.ok) {
    const classified = await classifyGithubHttpFailure("workflow_run", res);
    return { outcome: "error", retryable: classified.retryable, reason: classified.reason };
  }
  const body = (await res.json().catch(() => null)) as {
    status?: string;
    conclusion?: string | null;
    html_url?: string;
  } | null;
  if (typeof body?.status !== "string") {
    // A 200 without a status is not evidence of anything; treat as retryable so a
    // malformed response cannot retire a live gate.
    return { outcome: "error", retryable: true, reason: "workflow_run_status_missing" };
  }
  return {
    outcome: "found",
    status: body.status,
    conclusion: typeof body.conclusion === "string" ? body.conclusion : null,
    htmlUrl: typeof body.html_url === "string" ? body.html_url : null,
  };
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
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const res = await ghFetch(`${apiBase}/repos/${repoFullName}/pulls/${prNumber}`, {
      headers,
      signal,
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { head?: { sha?: string } } | null;
    const sha = body?.head?.sha;
    return typeof sha === "string" ? headShaHex(sha) : null;
  } catch {
    return null;
  }
}

/** Fetch the current SHA for a pull request when a webhook payload lacks it. */
export async function githubFetchPrHeadSha(input: {
  repoFullName: string;
  prNumber: number;
  signal?: AbortSignal;
}): Promise<string | null> {
  const token = await getInstallationToken();
  if (!token) return null;
  return fetchPrHeadSha(
    gitHubApiBase(GITHUB_HOST),
    input.repoFullName,
    input.prNumber,
    { ...GITHUB_API_HEADERS, authorization: `Bearer ${token}` },
    input.signal,
  );
}

/**
 * Fetch a pull request's author login, for wake paths that carry the PR target
 * but not the author.
 *
 * `prReviewOutputHasSelfReviewSkip` refuses to honour a self-review skip unless
 * it can corroborate the claim against a PR author it did not get from the run's
 * own text (BLO-9293). The webhook supplies that fact; assignment-sourced
 * reviewer wakes do not, and `mergeCoalescedContextSnapshot` drops it on a
 * different-PR coalesce. Resolving it from GitHub keeps the corroboration
 * trustworthy — the author still never comes from the agent's summary.
 */
export async function githubFetchPrAuthorLogin(input: {
  repoFullName: string;
  prNumber: number;
  signal?: AbortSignal;
}): Promise<string | null> {
  const token = await getInstallationToken();
  if (!token) return null;
  try {
    const res = await ghFetch(
      `${gitHubApiBase(GITHUB_HOST)}/repos/${input.repoFullName}/pulls/${input.prNumber}`,
      {
        headers: { ...GITHUB_API_HEADERS, authorization: `Bearer ${token}` },
        signal: input.signal,
      },
    );
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { user?: { login?: string } } | null;
    const login = body?.user?.login;
    return typeof login === "string" && login.trim().length > 0 ? login : null;
  } catch {
    return null;
  }
}

/**
 * Whether a comment is Ally emitting a consolidated review that attests to this
 * exact head. Both halves are required: a request comment can quote an arbitrary
 * SHA, so a loose substring match is not durable evidence the review side effect
 * happened.
 *
 * This delegates to `ally-review-detection.ts` rather than carrying a second
 * copy of the grammar. That copy accepted `\s*` around the label and the SHA,
 * which crosses newlines; the shared grammar uses horizontal whitespace only, so
 * an attestation split across two lines no longer parses. That narrowing is
 * deliberate and is pinned by a test below: no live Ally attestation uses the
 * split form (104/104 sampled bare by Ally on PRs 1400-1440/997/1562; 2/2
 * same-line and 0 split across a 60-PR re-sample), and a newline-crossing match
 * would let a bare `Reviewed head:` line bind to an unrelated 40-hex on the
 * following line — setting a required check on a guess, which is the one thing
 * the exactly-one rule exists to prevent.
 */
const commentAttestsHead = (body: string, head: string): boolean =>
  hasAllyConsolidatedReviewHeading(body) && extractAllyReviewedHeadSha(body) === head;

/**
 * Whether one formal review is evidence the reviewer read THIS head.
 *
 * `commitId` alone cannot answer that. GitHub re-anchors `reviews[].commit_id`
 * FORWARD onto the new head when the branch is updated, so the comparison fails
 * OPEN: it does not reject a stale review, it accepts one that never saw the
 * head being credited. Measured n=128 (BLO-27234): 8 confirmed re-anchorings,
 * all 8 APPROVED, 6 not even the latest review. Live instance at the time of
 * writing — `pim-multicast-gateway#3354` review 5318980026: `APPROVED`,
 * `commit_id` equal to the head, body attesting `c01651f5`, six commits back.
 *
 * So when the body states which head it read, that statement wins in BOTH
 * directions — it is immutable, where `commit_id` is not. This is a
 * DISAGREEMENT rule, deliberately not an absence rule:
 *
 *   - marker present, names a different head -> reject, whatever `commit_id` says
 *   - marker present, names this head        -> accept, whatever `commit_id` says
 *   - no usable marker                       -> unchanged, credit `commit_id`
 *
 * The third arm is load-bearing and must stay. Requiring a marker would be the
 * right answer for MERGE AUTHORIZATION, where an unproven review costs only a
 * wait, and the wrong one for run-output attestation, which is the only
 * question this predicate is asked: failing it closed is BLO-28920, ~66 paid
 * retries in 3h. `extractAllyReviewedHeadSha` already returns null for zero or
 * several attestations and ignores quoted text, so every ambiguous body lands
 * on the unchanged arm rather than on a guess.
 *
 * No `hasAllyConsolidatedReviewHeading` guard here, unlike `commentAttestsHead`
 * above. The asymmetry is deliberate: a review object is itself proof a review
 * happened, so the marker is read only for WHICH head, whereas a comment has no
 * such proof and needs the heading to be told apart from ordinary PR chatter.
 * Do not harmonise the two — adding the guard here would send every review whose
 * body Ally shapes differently back onto bare `commit_id`, i.e. straight back
 * into the fail-open above.
 *
 * Applied per review, never across the set: one lying review must not suppress
 * a different, honest review at the same head.
 */
const reviewAttestsHead = (review: ReviewerReview, head: string): boolean => {
  const attested = extractAllyReviewedHeadSha(review.body);
  return attested === null ? review.commitId === head : attested === head;
};

/**
 * Page cap for BOTH evidence surfaces below. Deliberately far smaller than
 * `GITHUB_COMMENT_PAGINATION_HARD_LIMIT_PAGES` (500), because this predicate runs
 * on every reviewer-run completion and so its request budget is a hot path,
 * whereas the comment-review gate that owns that constant runs rarely.
 *
 * What it DOES share with that constant is the contract that matters: reaching
 * the cap returns an `{error}`, never a silently truncated `{found:false}`. A
 * truncated negative here would re-raise `pr_review_output_missing` and post a
 * false "reviewer never finished" status — i.e. it would reproduce BLO-28920,
 * merely gated on thread length instead of review state. These threads do get
 * long (28 stacked marker requests on one PR), so the cap is reachable.
 */
const REVIEWER_EVIDENCE_MAX_PAGES = 10;

/** One SUBMITTED review by the configured reviewer App, at whatever head it names. */
export interface ReviewerReview {
  login: string;
  body: string;
  state: string;
  commitId: string | null;
  submittedAt: string | null;
}

/** One issue comment by the configured reviewer App. */
export interface ReviewerComment {
  login: string;
  body: string;
  createdAt: string;
}

/**
 * Both surfaces Ally reviews on. Each is individually blind to the other, so a
 * consumer deciding "was this reviewed?" must read both — see the note on
 * `githubHasReviewerEvidenceForPr`.
 */
export interface ReviewerSurfaces {
  reviews: ReviewerReview[];
  comments: ReviewerComment[];
}

/**
 * Page one reviewer-evidence surface, filtered to the configured App identity.
 *
 * Reaching the cap returns an `{error}`, never a silently truncated list. A
 * truncated negative would be read as "the reviewer never finished" and re-raise
 * `pr_review_output_missing` — i.e. reproduce BLO-28920, merely gated on thread
 * length instead of review state. These threads do get long (28 stacked marker
 * requests on one PR), so the cap is reachable.
 */
async function listReviewerSurface<T>(input: {
  url: (page: number) => string;
  headers: Record<string, string>;
  botLogin: string;
  signal?: AbortSignal;
  prefix: string;
  select: (row: { user?: { login?: string } }, login: string) => T | null;
}): Promise<T[] | { error: string }> {
  const out: T[] = [];
  try {
    for (let page = 1; page <= REVIEWER_EVIDENCE_MAX_PAGES; page += 1) {
      const res = await ghFetch(input.url(page), { headers: input.headers, signal: input.signal });
      if (!res.ok) {
        const classified = await classifyGithubHttpFailure(input.prefix, res);
        return { error: classified.reason };
      }
      const batch = (await res.json()) as Array<{ user?: { login?: string } }>;
      for (const row of batch) {
        const login = row.user?.login ?? "";
        if (!githubReviewerIdentityMatches(login, input.botLogin)) continue;
        const picked = input.select(row, login);
        if (picked !== null) out.push(picked);
      }
      if (batch.length < 100) break;
      if (page === REVIEWER_EVIDENCE_MAX_PAGES) return { error: `${input.prefix}_pagination_exhausted` };
    }
  } catch {
    return { error: `${input.prefix}_fetch_failed` };
  }
  return out;
}

function listReviewerReviews(input: {
  apiBase: string;
  repoFullName: string;
  prNumber: number;
  headers: Record<string, string>;
  botLogin: string;
  signal?: AbortSignal;
}): Promise<ReviewerReview[] | { error: string }> {
  return listReviewerSurface<ReviewerReview>({
    ...input,
    prefix: "reviews",
    url: (page) =>
      `${input.apiBase}/repos/${input.repoFullName}/pulls/${input.prNumber}/reviews?per_page=100&page=${page}`,
    // PENDING is an unsubmitted draft, returned by GitHub only to the identity
    // that created it — which is this App. A run that dies mid-flow leaves
    // exactly such a draft; keeping it would let that run self-attest.
    select: (row, login) => {
      const r = row as {
        body?: string | null;
        state?: string | null;
        commit_id?: string | null;
        submitted_at?: string | null;
      };
      const state = (r.state ?? "").toUpperCase();
      if (state === "PENDING") return null;
      return {
        login,
        body: r.body ?? "",
        state,
        commitId: headShaHex(r.commit_id),
        submittedAt: r.submitted_at ?? null,
      };
    },
  });
}

function listReviewerComments(input: {
  apiBase: string;
  repoFullName: string;
  prNumber: number;
  headers: Record<string, string>;
  botLogin: string;
  signal?: AbortSignal;
}): Promise<ReviewerComment[] | { error: string }> {
  return listReviewerSurface<ReviewerComment>({
    ...input,
    prefix: "comments",
    url: (page) =>
      `${input.apiBase}/repos/${input.repoFullName}/issues/${input.prNumber}/comments?per_page=100&page=${page}`,
    select: (row, login) => {
      const c = row as { body?: string | null; created_at?: string };
      return { login, body: c.body ?? "", createdAt: c.created_at ?? "" };
    },
  });
}

/**
 * Both reviewer surfaces at once, for consumers that must judge the *content* of
 * a review rather than merely whether one exists — the evidence gate's truth
 * probe needs the bodies to ask whether the review was clean.
 *
 * Fails closed as a unit: either surface erroring returns `{error}`, because a
 * partial read cannot distinguish "Ally left no finding" from "we did not see
 * the comment that carries it". `githubHasReviewerEvidenceForPr` deliberately
 * does NOT use this composition — see the note there.
 */
export async function githubListReviewerSurfacesAtPr(input: {
  repoFullName: string;
  prNumber: number;
  signal?: AbortSignal;
}): Promise<ReviewerSurfaces | { error: string }> {
  const botLogin = loadConfig().prReviewerBotLogin.trim();
  if (!botLogin) return { error: "no_bot_login" };
  // A bare user-seat login (`allyblockcast`) is not the App identity, so
  // `githubReviewerIdentityMatches` would filter EVERY row out and hand back
  // empty surfaces — a misconfiguration that reads to the caller as "Ally
  // reviewed and found nothing". Fail closed, as the predicate below does.
  if (!githubReviewerAppSlug(botLogin)) return { error: "bot_login_not_app_form" };
  const token = await getInstallationToken();
  if (!token) return { error: "no_token" };
  const args = {
    apiBase: gitHubApiBase(GITHUB_HOST),
    repoFullName: input.repoFullName,
    prNumber: input.prNumber,
    headers: { ...GITHUB_API_HEADERS, authorization: `Bearer ${token}` },
    botLogin,
    signal: input.signal,
  };
  const reviews = await listReviewerReviews(args);
  if ("error" in reviews) return { error: reviews.error };
  const comments = await listReviewerComments(args);
  if ("error" in comments) return { error: comments.error };
  return { reviews, comments };
}

/**
 * Authoritatively check whether the reviewer GitHub App actually REVIEWED this
 * PR's required head — a *run-output attestation*, not a *merge authorization*.
 *
 * BLO-28920 — READ THIS BEFORE TIGHTENING THE PREDICATE. These two questions
 * look alike and are not:
 *
 *  - *Merge authorization* ("may this PR merge?") legitimately demands an
 *    `APPROVED` review. That gate lives elsewhere (`githubGetPullRequestGate`).
 *  - *Run-output attestation* ("did the reviewer run do its job?") must accept
 *    `COMMENTED`, because that is Ally's correct output for a review carrying
 *    findings — and because GitHub bars a PR's author from APPROVE /
 *    REQUEST_CHANGES on its own PR. Agent PRs are authored by the App itself, so
 *    requiring `APPROVED` here is structurally unsatisfiable for the dominant
 *    case: n=1,962 App-authored PRs carry zero App approvals (BLO-24056).
 *
 * Applying the merge bar to this attestation is exactly the regression that
 * 4c7e23d9c shipped by collapsing the App-identity branch into the user-seat
 * branch: reviewer runs that had posted a valid exact-head `COMMENTED` review
 * were failed `pr_review_output_missing` and retried in a paid loop (~66 runs /
 * 3h). Every caller of this function asks the attestation question — completion
 * verification, the stale-kill double-post probe, and the gate-status outbox —
 * so state, not approval, is what it must key on.
 *
 * Found when the configured App identity left EITHER surface at the exact head,
 * because Ally posts on either and each surface is individually blind to the
 * other:
 *  - a formal SUBMITTED review that attests this head, in any submitted
 *    state (`COMMENTED` / `CHANGES_REQUESTED` / `APPROVED` / `DISMISSED` — a
 *    dismissed review still happened, it was only disposed of afterwards).
 *    "Attests" is `reviewAttestsHead`: the body's own `Reviewed head:` line
 *    when it has exactly one, else `commit_id`. The body wins because
 *    `commit_id` re-anchors FORWARD onto a new head and so fails OPEN
 *    (BLO-35545); the `commit_id` fallback stays for bodyless reviews because
 *    requiring an attestation here is the BLO-28920 paid-retry loop; or
 *  - an issue comment carrying the canonical consolidated-review heading and a
 *    single `Reviewed head:` attestation equal to that head (comment-mode
 *    reviews file no review object and so carry no `commit_id`).
 *
 * Deliberately NOT accepted, so a genuinely missing review still fails:
 *  - the same-slug bare user seat (a distinct principal — see
 *    `githubReviewerIdentityMatches`);
 *  - any review at a head other than the required one;
 *  - a `PENDING` review. That is an *unsubmitted draft*, returned by GitHub only
 *    to the identity that created it — which is this App — and it already
 *    carries a `commit_id`. The MCP review flow is `create pending` → `add
 *    comments` → `submit`, so a run that dies mid-flow leaves exactly such a
 *    draft; accepting it would let that run self-attest and would defeat the
 *    one case this predicate exists to catch.
 *
 * Returns `{error}` on invalid configuration, missing creds/token, any non-OK
 * or failed reviews/comments fetch, or an exhausted pagination cap. Callers fail
 * completion closed with a retryable verification-unavailable error. An
 * unresolved required head returns `{found:false}` and never accepts arbitrary
 * review evidence.
 */
/** One PR commit, reduced to the fields foreign-commit detection decides on (BLO-19528). */
export type GitHubPullRequestCommit = {
  sha: string;
  authorEmail: string | null;
  authorName: string | null;
  parentCount: number;
};

/**
 * `truncated` means "this listing is not provably complete" -- see
 * {@link GITHUB_PR_COMMITS_ENDPOINT_LIMIT}. It is NOT an error: the commits
 * that were read are still usable, and dropping them would notify about
 * nothing rather than about most things. Callers must surface it, because a
 * silently short list is indistinguishable from a PR with no foreign commits.
 */
export type GitHubPullRequestCommitsResult =
  | { commits: GitHubPullRequestCommit[]; truncated: boolean }
  | { error: string };

/** Cap on `/pulls/{n}/commits` pages. GitHub itself truncates this endpoint at 250 commits. */
export const GITHUB_PR_COMMITS_MAX_PAGES = 3;

/**
 * GitHub's own ceiling on `/pulls/{n}/commits`: "Lists a maximum of 250
 * commits for a pull request." It is announced nowhere in the response -- the
 * endpoint just stops, so a 250-commit page-out looks exactly like a PR that
 * has 250 commits and no more. This ceiling, not {@link
 * GITHUB_PR_COMMITS_MAX_PAGES}, is what actually truncates in practice: 250 <
 * 3 * 100, so the page loop always breaks on a short page first and never
 * reaches its own cap. Both are still checked -- the page cap is the one that
 * bites if `per_page` or the cap is ever retuned.
 */
export const GITHUB_PR_COMMITS_ENDPOINT_LIMIT = 250;

/**
 * List a PR's commits with their **git author** identity (BLO-19528).
 *
 * Reads `commit.author.email`, not `author.login`: every agent pod pushes with
 * the same shared App credential, so the login names the App for all of them
 * alike, while the git author email is provisioned per agent (BLO-23894).
 *
 * `parents.length` is carried through so the caller can exclude merge/squash
 * commits, which the GitHub merge API creates and legitimately App-attributes.
 *
 * Returns `truncated: true` when the listing cannot be proven complete. A
 * truncated read is *unproven*, never absence -- the caller still gets every
 * commit that was read and must report the gap rather than treat the short
 * list as the whole PR.
 */
export async function githubListPullRequestCommits(input: {
  repoFullName: string;
  prNumber: number;
}): Promise<GitHubPullRequestCommitsResult> {
  const token = await getInstallationToken();
  if (!token) return { error: "no_token" };

  const headers = { ...GITHUB_API_HEADERS, authorization: `Bearer ${token}` };
  const apiBase = gitHubApiBase(GITHUB_HOST);
  const commits: GitHubPullRequestCommit[] = [];
  let truncated = false;

  for (let page = 1; page <= GITHUB_PR_COMMITS_MAX_PAGES; page += 1) {
    const url =
      `${apiBase}/repos/${input.repoFullName}/pulls/${input.prNumber}/commits`
      + `?per_page=100&page=${page}`;
    let res: Response;
    try {
      res = await ghFetch(url, { headers });
    } catch {
      return { error: "pr_commits_fetch_failed" };
    }
    if (!res.ok) {
      const classified = await classifyGithubHttpFailure("pr_commits", res);
      return { error: classified.reason };
    }

    let batch: Array<Record<string, unknown>>;
    try {
      batch = (await res.json()) as Array<Record<string, unknown>>;
    } catch {
      return { error: "pr_commits_parse_failed" };
    }
    if (!Array.isArray(batch)) return { error: "pr_commits_unexpected_shape" };

    for (const entry of batch) {
      const sha = typeof entry.sha === "string" ? entry.sha : null;
      if (!sha) continue;
      const commit = entry.commit as Record<string, unknown> | undefined;
      const author = commit?.author as Record<string, unknown> | undefined;
      const parents = Array.isArray(entry.parents) ? entry.parents : [];
      commits.push({
        sha,
        authorEmail: typeof author?.email === "string" ? author.email : null,
        authorName: typeof author?.name === "string" ? author.name : null,
        parentCount: parents.length,
      });
    }

    if (batch.length < 100) break;
    // A full last page with no pages left: our own cap cut the listing short.
    if (page === GITHUB_PR_COMMITS_MAX_PAGES) truncated = true;
  }

  // GitHub's 250 ceiling reports itself as a short page, so the loop above
  // exits believing it read to the end. Landing on the ceiling is the only
  // signal there is, and it is deliberately fail-closed: a PR with exactly
  // 250 commits is flagged too, because nothing in the response distinguishes
  // it from one with 400.
  if (commits.length >= GITHUB_PR_COMMITS_ENDPOINT_LIMIT) truncated = true;

  return { commits, truncated };
}

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

  const args = { apiBase, repoFullName: input.repoFullName, prNumber: input.prNumber, headers, botLogin };

  // The two surfaces are read in sequence and SHORT-CIRCUIT, rather than via
  // `githubListReviewerSurfacesAtPr`, even though that would be the tidier
  // composition. Two reasons, both regressions if you collapse them:
  //
  //  - Fetching both unconditionally would turn a review match whose comments
  //    fetch then failed into `{error}`, where this predicate used to — and must
  //    — return `{found:true}`. Its callers fail completion closed on `{error}`,
  //    so that is a false `pr_review_output_missing` on a PR that WAS reviewed:
  //    BLO-28920 again, gated on an unrelated surface's availability.
  //  - This runs on every reviewer-run completion, so its request budget is a
  //    hot path; the common case (a formal review at head) must cost one page,
  //    not two.
  //
  // Failing closed is still correct for the probe, which needs both bodies to
  // judge cleanliness and cannot treat an unread surface as "no findings".

  // 1) Formal reviews — the configured App at this exact head, in any SUBMITTED
  // state. `COMMENTED` counts: see the merge-authorization vs attestation note
  // above. `reviewAttestsHead` prefers the body's own immutable statement of
  // which head it read over the forward-re-anchoring `commit_id`.
  const reviews = await listReviewerReviews(args);
  if ("error" in reviews) return { error: reviews.error };
  if (reviews.some((review) => reviewAttestsHead(review, headSha))) return { found: true, via: "review" };

  // 2) Comment-shaped reviews — the second surface. Ally frequently reviews by
  // posting a consolidated comment and files no review object at all, so a PR it
  // demonstrably reviewed can report zero reviews on surface (1).
  const comments = await listReviewerComments(args);
  if ("error" in comments) return { error: comments.error };
  if (comments.some((comment) => commentAttestsHead(comment.body, headSha))) {
    return { found: true, via: "comment" };
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

// A comment-review gate cannot safely authorize from a prefix of a long-lived
// PR discussion: a later consolidated review may block or clear the head.
// This is only a runaway-loop backstop; reaching it returns null rather than a
// silently truncated result.
export const GITHUB_COMMENT_PAGINATION_HARD_LIMIT_PAGES = 500;

/**
 * Fetch the complete issue-comment history needed by the comment-review gate.
 * Returns null when credentials or any page cannot be read, including the
 * safety backstop, so callers can leave the prior status untouched instead of
 * publishing a verdict from partial history.
 */
export async function githubListIssueCommentsWithTimestamps(input: {
  repoFullName: string;
  prNumber: number;
}): Promise<Array<{ login: string | null; body: string; createdAt: string }> | null> {
  const token = await getInstallationToken();
  if (!token) return null;
  const headers = { ...GITHUB_API_HEADERS, authorization: `Bearer ${token}` };
  const apiBase = gitHubApiBase(GITHUB_HOST);
  const comments: Array<{ login: string | null; body: string; createdAt: string }> = [];

  try {
    for (let page = 1; page <= GITHUB_COMMENT_PAGINATION_HARD_LIMIT_PAGES; page += 1) {
      const url = `${apiBase}/repos/${input.repoFullName}/issues/${input.prNumber}/comments?per_page=100&page=${page}`;
      const response = await ghFetch(url, { headers });
      if (!response.ok) return null;
      const batch = (await response.json()) as Array<{
        user?: { login?: string | null } | null;
        body?: string | null;
        created_at?: string | null;
      }>;

      for (const comment of batch) {
        if (typeof comment.created_at !== "string") continue;
        comments.push({
          login: comment.user?.login ?? null,
          body: comment.body ?? "",
          createdAt: comment.created_at,
        });
      }

      if (batch.length < 100) return comments;
      if (page === GITHUB_COMMENT_PAGINATION_HARD_LIMIT_PAGES) return null;
    }
    return comments;
  } catch {
    return null;
  }
}

/**
 * Fetch the submitted-review history for the comment-review gate.
 *
 * Ally emits its consolidated review as a `pull_request_review` in the
 * `COMMENTED` state, not as an issue comment (BLO-29711). `COMMENTED` reviews
 * are invisible to GitHub's `reviewDecision`, which is exactly why the gate
 * exists — but they live on `/pulls/{n}/reviews`, so a gate reading only
 * `/issues/{n}/comments` never observes one. `githubHasReviewerEvidenceForPr`
 * already reads both surfaces for the same reason.
 *
 * `PENDING` reviews are skipped: an unsubmitted draft is visible only to its
 * creator and carries no `submitted_at`.
 *
 * `DISMISSED` reviews are skipped too, and the contrast with
 * `githubHasReviewerEvidenceForPr` — which deliberately *accepts* them — is the
 * point rather than an inconsistency (BLO-29711). That function asks whether a
 * review run happened; a dismissed review still happened. This one supplies the
 * verdict a merge gate is computed from, and dismissal is precisely an
 * authorized actor withdrawing a verdict from operation, by hand or via branch
 * protection's `dismiss_stale_reviews`. GitHub keeps the body but stops counting
 * it toward `reviewDecision`, so reading it here re-animates a retraction, in
 * both directions: a dismissed *blocking* review wedges a PR whose only escape
 * hatch is the dismissal being ignored, and a dismissed *clean* review
 * dispositions findings it no longer vouches for. Not theoretical —
 * `Blockcast/paperclip#937` carries six DISMISSED head-attested Ally reviews.
 *
 * Returns null on any unreadable page so callers leave the prior status
 * untouched rather than publishing a verdict from partial history.
 */
export async function githubListPrReviewsWithTimestamps(input: {
  repoFullName: string;
  prNumber: number;
}): Promise<Array<{ login: string | null; body: string; createdAt: string }> | null> {
  const token = await getInstallationToken();
  if (!token) return null;
  const headers = { ...GITHUB_API_HEADERS, authorization: `Bearer ${token}` };
  const apiBase = gitHubApiBase(GITHUB_HOST);
  const reviews: Array<{ login: string | null; body: string; createdAt: string }> = [];

  try {
    for (let page = 1; page <= GITHUB_COMMENT_PAGINATION_HARD_LIMIT_PAGES; page += 1) {
      const url = `${apiBase}/repos/${input.repoFullName}/pulls/${input.prNumber}/reviews?per_page=100&page=${page}`;
      const response = await ghFetch(url, { headers });
      if (!response.ok) return null;
      const batch = (await response.json()) as Array<{
        user?: { login?: string | null } | null;
        body?: string | null;
        state?: string | null;
        submitted_at?: string | null;
      }>;

      for (const review of batch) {
        const state = (review.state ?? "").toUpperCase();
        if (state === "PENDING" || state === "DISMISSED") continue;
        if (typeof review.submitted_at !== "string") continue;
        reviews.push({
          login: review.user?.login ?? null,
          body: review.body ?? "",
          createdAt: review.submitted_at,
        });
      }

      if (batch.length < 100) return reviews;
      if (page === GITHUB_COMMENT_PAGINATION_HARD_LIMIT_PAGES) return null;
    }
    return reviews;
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
 * Strip credential-shaped material from one free-text field bound for GitHub
 * (PEN-3157).
 *
 * ## Why this sits in the write helpers and not at each call site
 *
 * The same gap has now been found twice — PEN-2527 covered the `gh` binary and
 * missed the MCP server; PEN-3152 covered both wrappers and missed `server/`
 * entirely. Both times the cause was the same: a scrub applied per-caller, so
 * closing it required every future caller to remember. These write helpers are
 * how `paperclip-api` puts authored text on GitHub, so scrubbing here makes the
 * control a property of the boundary rather than of the caller's diligence. A
 * new caller of any helper is covered the day it is written.
 *
 * Exported for the one writer that cannot use those helpers:
 * `github-review-gate-authority.ts` builds its own request because it carries a
 * caller-supplied token and an abort signal that `githubPostCommitStatusDetailed`
 * does not model. Rather than leave a structural exception, it calls this
 * directly — so the write set has no member outside the scrub.
 *
 * ## Why not at `ghFetch`
 *
 * `ghFetch` is the wider boundary but the wrong altitude: it sees an opaque
 * request body and cannot tell a prose field from protocol. Scrubbing a
 * serialized payload there risks rewriting GraphQL text or an id, and the
 * detectors are tuned for prose. Here the free-text fields are named by the
 * signature, so each one is scrubbed for exactly what it is.
 *
 * The scrub returns its input byte-for-byte when nothing matches, so ordinary
 * gate prose is never reformatted. When something does match we log the
 * *classes* and never the text — a log line quoting the match would re-publish
 * the secret into the very transcripts PEN-3139 is narrowing.
 */
export function scrubOutboundGitHubText(value: string, field: string): string {
  const result = scrubGitHubEgressText(value);
  if (result.redacted) {
    console.warn(
      `[github-egress] Redacted credential-shaped material from an outbound GitHub ${field}: ` +
        `${result.classes.join(", ")}. The write proceeded with redaction markers in place.`,
    );
  }
  return result.text;
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
  // GitHub truncates a description at 140 chars; trim here so the message we
  // intend is the message that lands rather than an arbitrary server-side cut.
  // Scrub BEFORE that trim, never after: trimming first can cut a vendor-key
  // prefix or a PEM header in half, and half a token matches no detector while
  // the surviving half is still most of the secret.
  const description = input.description
    ? scrubOutboundGitHubText(input.description, "commit-status description").slice(0, 140)
    : undefined;
  const context = scrubOutboundGitHubText(input.context, "commit-status context");
  const targetUrl = input.targetUrl
    ? scrubOutboundGitHubText(input.targetUrl, "commit-status target_url")
    : input.targetUrl;
  try {
    const url = `${apiBase}/repos/${input.repoFullName}/statuses/${input.sha}`;
    const res = await ghFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        state: input.state,
        context,
        ...(description ? { description } : {}),
        ...(targetUrl ? { target_url: targetUrl } : {}),
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
 * Conclusions a completed check-run may carry. Only the three this codebase
 * publishes are listed; the rest of GitHub's enum is unused here.
 *
 * `neutral` is the reason check-runs exist in this file at all. A legacy commit
 * status has only success/failure/pending/error, so a verdict that is neither
 * "reviewed and clean" nor "blocking" has no honest state to occupy: `pending`
 * and `failure` block merge, and `success` is indistinguishable from a real
 * pass. `neutral` renders distinctly and does not block (BLO-33657).
 */
export type GitHubCheckRunConclusion = "success" | "failure" | "neutral";

/**
 * Publish a completed check-run as the GitHub App.
 *
 * Requires the installation's `checks: write` permission — a commit status is
 * `statuses: write` and the two are independent, so a deployment that can post
 * statuses is not thereby able to post check-runs.
 *
 * ponytail: creates a new run per call rather than looking up and PATCHing the
 * existing one for this name+sha. GitHub takes the latest per name, and commit
 * statuses already append the same way, so repeated evaluations of one head
 * leave several rows. Switch to find-then-PATCH if that noise ever matters.
 */
export async function githubPostCheckRun(input: {
  repoFullName: string;
  sha: string;
  name: string;
  conclusion: GitHubCheckRunConclusion;
  title: string;
  summary: string;
  detailsUrl?: string | null;
}): Promise<GitHubCommitStatusPostResult> {
  const token = await getInstallationTokenResult();
  if (!token.ok) return asCommitStatusFailure(token);
  const headers = {
    ...GITHUB_API_HEADERS,
    authorization: `Bearer ${token.token}`,
    "content-type": "application/json",
  };
  const apiBase = gitHubApiBase(GITHUB_HOST);
  // `summary` is the same verdict prose a commit-status description carries,
  // and a check-run has no 140-char cap — so it publishes MORE of it. Scrubbed
  // here like every other free-text field this file writes, so the helper's
  // callers inherit the control rather than each remembering it (PEN-3157).
  const name = scrubOutboundGitHubText(input.name, "check-run name");
  const title = scrubOutboundGitHubText(input.title, "check-run title");
  const summary = scrubOutboundGitHubText(input.summary, "check-run summary");
  const detailsUrl = input.detailsUrl
    ? scrubOutboundGitHubText(input.detailsUrl, "check-run details_url")
    : input.detailsUrl;
  try {
    const res = await ghFetch(`${apiBase}/repos/${input.repoFullName}/check-runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name,
        head_sha: input.sha,
        status: "completed",
        conclusion: input.conclusion,
        output: { title, summary },
        ...(detailsUrl ? { details_url: detailsUrl } : {}),
      }),
    });
    if (res.ok) return { ok: true, statusCode: res.status };
    const classified = await classifyGithubHttpFailure("check_run_write", res);
    return { ok: false, ...classified, statusCode: res.status };
  } catch {
    return { ok: false, retryable: true, reason: "check_run_write_fetch_failed" };
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
 *
 * `body` is an arbitrary string by signature, which is what makes this the
 * widest server-side egress surface in the repo. Its only caller today passes a
 * template over an issue identifier and a URL, so the exposure is latent rather
 * than live — but "benign by its current caller" is not a property anyone can
 * rely on, and a PR comment is the highest-visibility thing this service can
 * publish. Scrubbed here so the next caller inherits the control (PEN-3157).
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
  const body = scrubOutboundGitHubText(input.body, "issue-comment body");
  try {
    const url = `${apiBase}/repos/${input.repoFullName}/issues/${input.prNumber}/comments`;
    const res = await ghFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ body }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

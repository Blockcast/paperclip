import { createHash } from "node:crypto";
import { unprocessable } from "../errors.js";
import {
  recordGithubApiHeld,
  recordGithubApiRefusal,
  recordGithubApiRequest,
  type GithubApiRefusalReason,
} from "./metrics.js";

function isGitHubDotCom(hostname: string) {
  const h = hostname.toLowerCase();
  return h === "github.com" || h === "www.github.com";
}

export function gitHubApiBase(hostname: string) {
  return isGitHubDotCom(hostname) ? "https://api.github.com" : `https://${hostname}/api/v3`;
}

/**
 * GitHub's GraphQL endpoint.
 *
 * It is NOT a child of the REST base: on github.com it hangs off the API apex
 * (`/graphql`), and on GHES it is `/api/graphql`, a SIBLING of `/api/v3` rather
 * than a path under it. Deriving it from {@link gitHubApiBase} gets the GHES
 * form wrong, which is why it is built here from the same `isGitHubDotCom`
 * test instead.
 *
 * Both forms are already recognised downstream -- `classifyGithubApiRoute`
 * labels them `graphql`, and `inferRateLimitResource` buckets them under the
 * `graphql` rate-limit resource -- so a caller that goes through `ghFetch`
 * keeps its metrics label and its per-resource hold without any further work.
 */
export function gitHubGraphQlUrl(hostname: string) {
  return isGitHubDotCom(hostname) ? "https://api.github.com/graphql" : `https://${hostname}/api/graphql`;
}

export function resolveRawGitHubUrl(hostname: string, owner: string, repo: string, ref: string, filePath: string) {
  const p = filePath.replace(/^\/+/, "");
  return isGitHubDotCom(hostname)
    ? `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`
    : `https://${hostname}/raw/${owner}/${repo}/${ref}/${p}`;
}

/**
 * No GitHub call may outlive this, even when the caller threads no signal.
 * undici's own default is ~300s, long enough for an inline webhook call to
 * outlast GitHub's delivery timeout and earn a redelivery storm against a
 * handler that is still working (BLO-38257). A default here bounds every hop,
 * including the ones no caller threads a signal into — notably the installation
 * token mint, which is the first of two network calls in most helpers.
 */
export const GITHUB_FETCH_DEADLINE_MS = 30_000;

/**
 * Request-blocking paths (webhook handlers) bound tighter than the safety net,
 * because they must answer GitHub rather than be redelivered.
 */
export const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

let deadlineMs: number = GITHUB_FETCH_DEADLINE_MS;

/**
 * Test-only: shrink the deadline so a unit test can observe it firing without
 * waiting 30s. Vitest fake timers do NOT drive `AbortSignal.timeout` (measured,
 * not assumed — it is internal to Node, not the global `setTimeout`), so a real
 * short deadline is the only way to assert on elapsed time rather than on a
 * suite timeout.
 */
export function _setGhFetchDeadlineMsForTest(ms: number = GITHUB_FETCH_DEADLINE_MS) {
  deadlineMs = ms;
}

/**
 * An abort is not a connect failure, and the two aborts are not each other
 * (BLO-38257). A caller's own abort is theirs to recognise, so it comes back
 * untouched; the default deadline firing is reported as a timeout, so a GitHub
 * slowdown does not send on-call to check URL configuration. Returns null for
 * anything that is not an abort, which each phase then reports in its own words.
 *
 * The result is WRAPPED rather than returned bare (BLO-38471): a caller may
 * abort with a falsy reason — `abort(null)`, `abort(0)`, `abort("")` — and a
 * truthiness test on a bare return would send that straight to the "Could not
 * connect" message, which is the exact misdiagnosis this function exists to
 * remove. The wrapper makes "an abort whose reason is falsy" and "not an abort"
 * two different values instead of one.
 */
function abortFailure(url: string, err: unknown, callerSignal?: AbortSignal | null): { failure: unknown } | null {
  if (callerSignal?.aborted) return { failure: err };
  if ((err as { name?: unknown } | null)?.name === "TimeoutError") {
    return { failure: unprocessable(`GitHub request to ${new URL(url).hostname} timed out after ${deadlineMs}ms`) };
  }
  return null;
}

/**
 * How much of a refusal body is scanned for the secondary-limit marker.
 *
 * GitHub's API error payloads are a few hundred bytes, so this only bounds the
 * pathological case — an HTML error page from a proxy in front of a GHE host.
 * It bounds the SCAN, not the read: `text()` has already materialized the body
 * by the time this applies. That is acceptable at this call site and nowhere
 * else, because the only bodies that reach it are 403/429 responses whose
 * headers already failed to classify them.
 */
const REFUSAL_BODY_SCAN_LIMIT = 4_096;

/**
 * GitHub's secondary-limit wording, as the body reports it.
 *
 * This is the fallback, not the primary signal — `retry-after` is checked
 * first. It exists because `retry-after` is documented as present on secondary
 * limits but is NOT guaranteed on all of them, and the direction of that gap is
 * the dangerous one: an unmatched secondary limit would be classified
 * `forbidden`, which reads as a permission problem and silently removes a real
 * quota refusal from PEN-3852's acceptance test. Octokit's own throttling
 * plugin pairs the same two signals for the same reason.
 *
 * Matches both spellings GitHub has used ("secondary rate limit", and the older
 * "abuse detection mechanism").
 */
const SECONDARY_LIMIT_BODY = /secondary rate limit|abuse detection mechanism/i;

/**
 * Read a header without trusting the object to be a real `Response`.
 *
 * Test doubles across this repo stub `fetch` with object literals cast to
 * `Response`, many of which carry no `headers` at all. A classifier that
 * assumed the full interface would turn an unrelated suite's fake 403 into a
 * TypeError thrown from inside `ghFetch` — converting an instrument into an
 * outage. Returns null for anything it cannot read, which classifies as
 * `forbidden` rather than inventing a quota refusal.
 */
function refusalHeader(response: Response, name: string): string | null {
  try {
    return response.headers?.get(name) ?? null;
  } catch {
    return null;
  }
}

/**
 * The refusal body, or "" if it cannot be read without disturbing the caller.
 *
 * Reads a CLONE. The caller must receive the same unconsumed `Response` it does
 * today, so the original body is never touched; `clone()` tees it, and the few
 * hundred bytes of a GitHub error payload are buffered until the caller reads
 * their side or drops it.
 *
 * Routed through {@link ghReadBody} like every other body read in this module,
 * rather than exempted from that convention (BLO-38471). The deadline is still
 * armed here — a slow refusal body aborts mid-read exactly as a slow success
 * body does — and the fact that this particular caller swallows the result is
 * not a reason to let a raw `TimeoutError` be what it swallows. If anyone ever
 * stops swallowing, they inherit the structured error the rest of the module
 * promises.
 *
 * Every failure is swallowed deliberately. A stubbed response with no `clone`,
 * a body already disturbed by something else, or the deadline firing mid-read
 * must all degrade to "could not classify from the body" — never to a throw
 * from a code path whose entire job is to observe.
 */
async function refusalBody(url: string, response: Response): Promise<string> {
  try {
    if (typeof response.clone !== "function") return "";
    const text = await ghReadBody(url, () => response.clone().text());
    return typeof text === "string" ? text.slice(0, REFUSAL_BODY_SCAN_LIMIT) : "";
  } catch {
    return "";
  }
}

/**
 * How much of a GraphQL response is parsed when looking for a budget refusal.
 *
 * Bounds the pathological case only. GitHub's own error envelope is a few
 * hundred bytes; the limit exists so that an HTML error page from a proxy, or
 * an unusually large query RESULT that happens to reach the parse below, is
 * abandoned rather than parsed.
 */
const GRAPHQL_REFUSAL_BODY_PARSE_LIMIT = 1_000_000;

/**
 * GitHub's GraphQL endpoint, in either of the two shapes {@link gitHubGraphQlUrl}
 * builds. Shared with {@link inferRateLimitResource} rather than spelled twice,
 * so the budget a GraphQL call is held under and the detector below can never
 * disagree about what counts as GraphQL. Guarded because the detector's whole
 * job is to observe, and an unparseable URL must degrade to "not GraphQL".
 */
function isGraphQlEndpoint(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith("/graphql");
  } catch {
    return false;
  }
}

/**
 * Did GitHub refuse this GraphQL read for want of primary budget? (PEN-6341)
 *
 * GraphQL does not report an exhausted primary budget the way REST does. It
 * answers **HTTP 200**, carrying `errors: [{ type: "RATE_LIMITED" }]` and a
 * null `data`. Every status-keyed signal in this module therefore misses it:
 * {@link classifyGithubRefusal} returns null, so the refusal never reaches the
 * counter, and `rememberRateLimitHold` returns before it reads a header, so
 * the spent bucket is re-sent into by every subsequent call for the rest of
 * the window — which is the exact behaviour the hold exists to remove, in the
 * one budget it could not see. That cost nothing while no caller here spoke
 * GraphQL. `githubHeadChecksSettlement` now does.
 *
 * ## Why the body read is gated on the header, and why the gate admits ABSENT
 *
 * Cloning and buffering a body on every GraphQL 200 would put a full rollup
 * payload through this path for nothing, so the header is consulted first. The
 * gate admits `0` — the exhausted case — and ALSO an absent or empty header.
 * That second arm is the load-bearing one: that GitHub sets
 * `x-ratelimit-remaining: 0` alongside the error is a documented expectation
 * that nobody has yet observed against a live exhausted `graphql` bucket.
 * REQUIRING it would make this detector silently INERT if the expectation is
 * wrong, and an inert detector is indistinguishable from a healthy budget. The
 * extra arm costs a body read only on responses carrying no rate-limit headers
 * at all, which in practice means test doubles.
 *
 * ## Why the error is matched structurally and never lexically
 *
 * A regex for `RATE_LIMITED` over the raw text would also match a query
 * RESULT that contains the string — a PR body or an issue title quoting it —
 * and a false positive here holds EVERY GraphQL call for up to an hour, which
 * is a self-inflicted outage in a budget that was never spent. So the body is
 * parsed and the `errors` array inspected; anything that is not a GraphQL
 * error envelope is not a refusal.
 *
 * Never throws. The caller's response must survive a failure to observe it,
 * and this runs inside `ghFetch`'s try, where an escape would be reported as a
 * connection failure against a host that answered perfectly well.
 */
async function graphQlPrimaryBudgetRefusal(url: string, response: Response): Promise<boolean> {
  try {
    if (response?.status !== 200) return false;
    if (!isGraphQlEndpoint(url)) return false;
    const remaining = refusalHeader(response, "x-ratelimit-remaining")?.trim() ?? "";
    if (remaining !== "" && remaining !== "0") return false;
    if (typeof response.clone !== "function") return false;
    const text = await ghReadBody(url, () => response.clone().text());
    if (typeof text !== "string" || text.length === 0) return false;
    if (text.length > GRAPHQL_REFUSAL_BODY_PARSE_LIMIT) return false;
    const errors = (JSON.parse(text) as { errors?: unknown } | null)?.errors;
    return Array.isArray(errors) && errors.some((e) => (e as { type?: unknown } | null)?.type === "RATE_LIMITED");
  } catch {
    return false;
  }
}

/**
 * Why GitHub refused this response, or null if it did not refuse it.
 *
 * Signals are consulted cheapest-first, and the ORDER is load-bearing rather
 * than incidental:
 *
 * 1. `x-ratelimit-remaining: 0` means the primary installation budget is spent.
 *    Checked first and unconditionally, because a response can carry both this
 *    and `retry-after`, and primary exhaustion is the condition PEN-3852's
 *    done-when is about — classifying it as the secondary mechanism would move
 *    a real budget refusal out of the term that tests for it. Compared as a
 *    TRIMMED STRING rather than parsed: `Number(null)` and `Number("")` are
 *    both 0, so a numeric test would read a MISSING header as an exhausted
 *    budget and manufacture the outage this metric exists to detect. The trim
 *    covers header whitespace without reopening that hole.
 * 2. `retry-after` without an exhausted budget is the secondary mechanism.
 * 3. Only then the body, which is the one case that costs a read.
 * 4. Anything left is a permission refusal.
 *
 * Statuses other than 403/429 are NOT refusals and return null — a 404 on a
 * private repo, a 422 on a bad payload and a 500 are all different failures
 * with different remedies, and folding them in would make the counter a generic
 * error rate that no quota question can be asked of.
 *
 * The ONE exception is passed in rather than derived here:
 * `graphQlBudgetSpent` reports a GraphQL 200 that carries a `RATE_LIMITED`
 * error (PEN-6341). That is a refusal GitHub chose to deliver with a success
 * status, and it is reported under the same `rate_limited` reason as its REST
 * equivalent — the `resource` label, read separately, is what tells an operator
 * `graphql` from `core`. It is a parameter because detecting it costs a body
 * read that `ghFetch` already has to make for the hold, and reading it twice
 * would clone the body twice.
 *
 * Exported for the unit tests: classification is the part with real GitHub
 * protocol knowledge in it, and it is worth pinning directly rather than only
 * through the counter.
 */
export async function classifyGithubRefusal(
  url: string,
  response: Response,
  graphQlBudgetSpent = false,
): Promise<GithubApiRefusalReason | null> {
  if (graphQlBudgetSpent) return "rate_limited";
  const status = response?.status;
  if (status !== 403 && status !== 429) return null;
  if (refusalHeader(response, "x-ratelimit-remaining")?.trim() === "0") return "rate_limited";
  if (refusalHeader(response, "retry-after") !== null) return "secondary_limit";
  if (SECONDARY_LIMIT_BODY.test(await refusalBody(url, response))) return "secondary_limit";
  return "forbidden";
}

/**
 * WHICH GitHub budget this refusal was drawn against, as GitHub reported it,
 * or null when the response did not say (PEN-3852).
 *
 * Split from {@link classifyGithubRefusal} rather than folded into its return
 * value. The two answer different questions and fail differently: the reason is
 * DERIVED here, from several signals in a load-bearing order, and a wrong
 * derivation sends an operator to the wrong remedy; the resource is simply
 * REPORTED by GitHub, and the only way to get it wrong is to not read it.
 * Keeping the derivation's signature narrow also keeps its unit tests — which
 * pin the one piece of real GitHub protocol knowledge in this module — reading
 * as assertions about classification rather than about a tuple.
 *
 * Read unconditionally for every refusal, not just `rate_limited`: a
 * `forbidden` on `search` and a `forbidden` on `core` are different findings
 * too, and the header costs nothing to carry.
 *
 * Returned RAW. The closed label set lives next to the counter that enforces
 * it, in `metrics.ts`, so this module never has to be the place somebody looks
 * to find out which values are allowed.
 */
export function classifyGithubRefusalResource(response: Response): string | null {
  return refusalHeader(response, "x-ratelimit-resource");
}

const REPO_ROUTE_SEGMENTS = new Set([
  "actions", "branches", "check-runs", "check-suites", "collaborators", "commits", "compare",
  "contents", "deployments", "environments", "git", "hooks", "issues", "labels", "merges",
  "pulls", "releases", "rules", "rulesets", "statuses", "tags",
]);
// Third-level resources under repos/:o/:r/<seg>/:id/<sub>, and actions/<sub>.
const REPO_ROUTE_SUBRESOURCES = new Set([
  "approve", "attempts", "check-runs", "check-suites", "comments", "commits", "events", "files",
  "jobs", "logs", "merge", "pending_deployments", "pulls", "requested_reviewers", "rerun",
  "reviews", "runs", "status", "statuses", "timeline", "workflows",
]);
const TOP_ROUTE_SEGMENTS = new Set(["app", "graphql", "installation", "orgs", "rate_limit", "search", "user", "users"]);

/**
 * Closed route template for `paperclip_github_api_requests_by_route_total`
 * (BLO-53662). Every value is built only from the sets above, so owner, repo,
 * numbers and SHAs can never become label values. Exported for its test.
 */
export function classifyGithubApiRoute(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "other";
  }
  if (parsed.hostname === "raw.githubusercontent.com") return "raw";
  const segs = parsed.pathname.split("/").filter(Boolean);
  if (segs[0] === "api" && segs[1] === "graphql") return "graphql"; // GHES graphql
  if (segs[0] === "api" && segs[1] === "v3") segs.splice(0, 2); // GHES REST prefix
  const top = segs[0];
  if (!top) return "other";
  if (top !== "repos") return TOP_ROUTE_SEGMENTS.has(top) ? top : "other";
  const seg = segs[3];
  if (!seg) return "repos";
  if (!REPO_ROUTE_SEGMENTS.has(seg)) return "repos/other";
  const sub = seg === "actions" ? segs[4] : segs[5];
  return sub && REPO_ROUTE_SUBRESOURCES.has(sub) ? `repos/${seg}/${sub}` : `repos/${seg}`;
}

/**
 * Count one attempt. Never throws.
 *
 * Guarded for the same reason the response side is, and deliberately NOT left
 * bare on the assumption that `ensureRegistry` cannot fail: this runs before
 * the request leaves, on the only path 79 call sites reach GitHub through —
 * including the installation-token mint every other call depends on. A
 * first-call registry fault here would not produce a missing data point, it
 * would produce a control plane that cannot talk to GitHub at all. The
 * asymmetry of protecting only the half that already had a try/catch is not
 * worth the two lines it saves.
 */
function countGithubApiAttempt(url: string): void {
  try {
    recordGithubApiRequest(classifyGithubApiRoute(url));
  } catch {
    // Observation is best-effort; the caller's request is not.
  }
}

/**
 * Count one call answered by a local rate-limit hold, instead of by GitHub
 * (PEN-6243). Never throws.
 *
 * Guarded for the same reason the attempt counter is, and it matters slightly
 * more here: this runs on the path taken when the shared installation is
 * already exhausted, i.e. the one minute an operator is most likely to be
 * reading these series through. An observation fault must lose the
 * observation, never the caller's 403.
 */
function countGithubApiHeld(url: string, resource: string): void {
  try {
    recordGithubApiHeld(resource, classifyGithubApiRoute(url));
  } catch {
    // Observation is best-effort; the caller's response is not.
  }
}

/**
 * Classify and count one response. Never throws, never alters the response.
 *
 * Wrapped rather than inlined so that a defect in classification — or in the
 * registry underneath it — cannot propagate into `ghFetch`'s return path. This
 * module's contract is that it returns what GitHub said; an observation that
 * fails must lose the observation, not the call.
 */
async function countGithubRefusal(url: string, response: Response, graphQlBudgetSpent: boolean): Promise<void> {
  try {
    const reason = await classifyGithubRefusal(url, response, graphQlBudgetSpent);
    if (reason) recordGithubApiRefusal(reason, classifyGithubRefusalResource(response));
  } catch {
    // Observation is best-effort; the caller's response is not.
  }
}

/**
 * Primary-budget exhaustion, remembered until GitHub's own reset (BLO-53662).
 *
 * Once GitHub answers `x-ratelimit-remaining: 0` for a credential and budget,
 * every further call on that pair is refused until `x-ratelimit-reset`. Sending
 * them anyway buys nothing and is not free: measured 2026-11-05, this process
 * sent ~8.1k such calls in 24h while the shared installation sat at zero, every
 * one of them landing in the same minutes every other consumer was dark. So the
 * hold answers them locally with the same 403 shape GitHub would have sent, and
 * each caller takes the rate-limit path it already has — no caller can re-fire
 * inside the exhausted window, whatever its own retry loop does.
 *
 * Keyed on the host, a hash of the Authorization header (never the token
 * itself) and the budget, so one installation's exhaustion never blocks another
 * credential, `search` never blocks `core`, and an exhausted `api.github.com`
 * never blocks `raw.githubusercontent.com` or a GHES host — which matters most
 * for unauthenticated callers, who all share the empty-header hash. The request-side budget is inferred from the
 * URL; a wrong inference only means no hold, which is today's behaviour.
 * Secondary limits (`retry-after`) are not held here.
 */
const rateLimitHolds = new Map<string, { resetMs: number; resource: string }>();

/** Never trust a reset further out than one primary window. */
const RATE_LIMIT_HOLD_MAX_MS = 60 * 60 * 1000;

export function _resetGhFetchRateLimitHoldsForTest() {
  rateLimitHolds.clear();
}

function inferRateLimitResource(url: string): string {
  if (isGraphQlEndpoint(url)) return "graphql";
  const path = new URL(url).pathname;
  if (path.includes("/search/code")) return "code_search";
  if (path.includes("/search/")) return "search";
  return "core";
}

function rateLimitHoldKey(url: string, init: RequestInit | undefined, resource: string): string {
  let auth = "";
  try {
    auth = new Headers(init?.headers).get("authorization") ?? "";
  } catch {
    // Unreadable headers: hold under the anonymous key, as an unauthenticated call would be.
  }
  return `${new URL(url).host}:${createHash("sha256").update(auth).digest("hex").slice(0, 16)}:${resource}`;
}

function heldResponse(resetMs: number, resource: string): Response {
  return new Response(
    JSON.stringify({
      message: "API rate limit exceeded (held locally until x-ratelimit-reset; BLO-53662)",
    }),
    {
      status: 403,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.ceil(resetMs / 1000)),
        "x-ratelimit-resource": resource,
      },
    },
  );
}

function rememberRateLimitHold(
  url: string,
  init: RequestInit | undefined,
  response: Response,
  inferredResource: string,
  graphQlBudgetSpent: boolean,
): void {
  // `graphQlBudgetSpent` is the only way a 200 reaches the rest of this
  // function (PEN-6341). Everything below it is unchanged and still has to
  // hold: a GraphQL refusal that arrives without `x-ratelimit-reset` arms
  // NOTHING, because there is no reset to trust and inventing one would hold a
  // live budget shut. That refusal is still counted, so an exhaustion this
  // cannot hold is visible rather than silent.
  if (response?.status !== 403 && response?.status !== 429 && !graphQlBudgetSpent) return;
  if (refusalHeader(response, "x-ratelimit-remaining")?.trim() !== "0") return;
  const resetSec = Number(refusalHeader(response, "x-ratelimit-reset"));
  if (!Number.isFinite(resetSec) || resetSec <= 0) return;
  const now = Date.now();
  const resetMs = Math.min(resetSec * 1000, now + RATE_LIMIT_HOLD_MAX_MS);
  if (resetMs <= now) return;
  // Falling back to the INFERRED budget rather than the literal "core": the
  // lookup side of this map keys on `inferRateLimitResource`, so a refusal that
  // omits the header must be remembered under the same name the next call will
  // ask for. Hardcoding "core" armed a hold that a `graphql` or `search` caller
  // could never find — it did not fail loudly, it just never held anything.
  const resource = refusalHeader(response, "x-ratelimit-resource") ?? inferredResource;
  // Rotated tokens never look their old key up again; sweep so the map stays bounded.
  for (const [key, hold] of rateLimitHolds) if (hold.resetMs <= now) rateLimitHolds.delete(key);
  rateLimitHolds.set(rateLimitHoldKey(url, init, resource), { resetMs, resource });
}

export async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  // Compose, never replace: a caller-supplied signal must still abort earlier
  // than the default, and the default must still bound a caller that passes none.
  const deadline = AbortSignal.timeout(deadlineMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  // A held call never reaches GitHub, so it is deliberately absent from BOTH
  // counters below: it is not an attempt against GitHub, and the 403 it gets is
  // not one GitHub issued. It is counted in its own series instead (PEN-6243) --
  // until that series existed the hold's own work was in no counter anywhere,
  // which made `paperclip_github_api_refusals_total` read as roughly one refusal
  // per (credential, budget, reset window) rather than as blocked work.
  const inferredResource = inferRateLimitResource(url);
  const holdKey = rateLimitHoldKey(url, init, inferredResource);
  const hold = rateLimitHolds.get(holdKey);
  if (hold) {
    if (hold.resetMs > Date.now()) {
      countGithubApiHeld(url, hold.resource);
      return heldResponse(hold.resetMs, hold.resource);
    }
    rateLimitHolds.delete(holdKey);
  }
  // Before the request leaves, so the denominator counts attempts and keeps
  // advancing when GitHub is unreachable rather than merely unhappy (PEN-3852).
  countGithubApiAttempt(url);
  try {
    const response = await fetch(url, { ...init, signal });
    // Read once and threaded into both observers: the GraphQL refusal signal
    // lives in the body, and each of them would otherwise clone it separately.
    const graphQlBudgetSpent = await graphQlPrimaryBudgetRefusal(url, response);
    await countGithubRefusal(url, response, graphQlBudgetSpent);
    rememberRateLimitHold(url, init, response, inferredResource, graphQlBudgetSpent);
    return response;
  } catch (err) {
    const aborted = abortFailure(url, err, init?.signal);
    if (aborted) throw aborted.failure;
    throw unprocessable(`Could not connect to ${new URL(url).hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`);
  }
}

/**
 * Read a `ghFetch` response body under the same failure contract. The deadline
 * stays armed until the body is consumed, so a slow transfer aborts mid-read,
 * outside `ghFetch`'s own try/catch; unwrapped, that escapes as a raw
 * `TimeoutError` instead of the structured error the caller throws for every
 * other failure. For callers that thread no signal of their own.
 */
export async function ghReadBody<T>(url: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    const aborted = abortFailure(url, err);
    throw aborted ? aborted.failure : err;
  }
}

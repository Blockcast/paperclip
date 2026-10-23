import { unprocessable } from "../errors.js";
import {
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
 * Exported for the unit tests: classification is the part with real GitHub
 * protocol knowledge in it, and it is worth pinning directly rather than only
 * through the counter.
 */
export async function classifyGithubRefusal(
  url: string,
  response: Response,
): Promise<GithubApiRefusalReason | null> {
  const status = response?.status;
  if (status !== 403 && status !== 429) return null;
  if (refusalHeader(response, "x-ratelimit-remaining")?.trim() === "0") return "rate_limited";
  if (refusalHeader(response, "retry-after") !== null) return "secondary_limit";
  if (SECONDARY_LIMIT_BODY.test(await refusalBody(url, response))) return "secondary_limit";
  return "forbidden";
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
function countGithubApiAttempt(): void {
  try {
    recordGithubApiRequest();
  } catch {
    // Observation is best-effort; the caller's request is not.
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
async function countGithubRefusal(url: string, response: Response): Promise<void> {
  try {
    const reason = await classifyGithubRefusal(url, response);
    if (reason) recordGithubApiRefusal(reason);
  } catch {
    // Observation is best-effort; the caller's response is not.
  }
}

export async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  // Compose, never replace: a caller-supplied signal must still abort earlier
  // than the default, and the default must still bound a caller that passes none.
  const deadline = AbortSignal.timeout(deadlineMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  // Before the request leaves, so the denominator counts attempts and keeps
  // advancing when GitHub is unreachable rather than merely unhappy (PEN-3852).
  countGithubApiAttempt();
  try {
    const response = await fetch(url, { ...init, signal });
    await countGithubRefusal(url, response);
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

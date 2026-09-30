import { unprocessable } from "../errors.js";

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

export async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  // Compose, never replace: a caller-supplied signal must still abort earlier
  // than the default, and the default must still bound a caller that passes none.
  const deadline = AbortSignal.timeout(deadlineMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  try {
    return await fetch(url, { ...init, signal });
  } catch {
    throw unprocessable(`Could not connect to ${new URL(url).hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`);
  }
}

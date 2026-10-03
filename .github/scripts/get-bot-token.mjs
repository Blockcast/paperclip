#!/usr/bin/env node
/**
 * get-bot-token.mjs
 * Generates a short-lived GitHub installation token for the commitperclip app.
 * Reads COMMITPERCLIP_KEY env var (PEM content of private key).
 * Prints the token to stdout.
 *
 * Also exports: generateJWT(privateKey), ghFetch(path, token, options)
 * These are used by all other gate scripts.
 */
import { createSign } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Upstream's commitperclip app by default; forks point this at their own
// GitHub App (Blockcast: allyblockcast) via env since the upstream app's
// private key is not distributable.
const APP_ID = process.env.COMMITPERCLIP_APP_ID || '3718661';
const OWNER_PATTERN = /^[a-zA-Z0-9_.-]+$/;
const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export function generateJWT(privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 10, exp: now + 60, iss: APP_ID };
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const sig = createSign('RSA-SHA256').update(data).sign(privateKey, 'base64url');
  return `${data}.${sig}`;
}

// Per-call timeout so a single slow/hung GitHub endpoint cannot eat the entire
// workflow budget. Overridable via options.timeoutMs for callers that need
// different bounds.
export const GH_FETCH_DEFAULT_TIMEOUT_MS = 15_000;

// GitHub's documented guidance for a rate-limited response carrying neither
// `retry-after` nor `x-ratelimit-reset`: wait at least 60s before retrying.
export const RATE_LIMIT_MIN_WAIT_MS = 60_000;

// The deadline is checked BEFORE sleeping, so funding n retries of a
// *headerless* rate-limit response needs a budget strictly greater than
// n × RATE_LIMIT_MIN_WAIT_MS. 45s — the review-gate-action default that
// BLO-28906 was filed against — funds ZERO and leaves the machinery inert.
// 120s funds exactly one. Sized to one and not more because the
// commitperclip-review job caps at 10 minutes and a cold ARC runner already
// spends several of them on Dependency Review + setup-node.
export const RATE_LIMIT_RETRY_BUDGET_MS = 120_000;

// Marker on the thrown error and in its message so a rate-limit exhaustion is
// never read as a quality or security verdict on the diff.
export const RATE_LIMIT_NOT_EVALUATED = 'RATE_LIMIT_NOT_EVALUATED';

// Same marker idea for a transient upstream failure (PEN-3760). A 5xx and an
// exhausted rate limit evaluate exactly the same amount of the diff — nothing —
// but only the rate limit used to say so, and the 5xx was reported as a
// verdict. Separate constant because the two have different remedies: a rate
// limit says "wait for the window", a 5xx says "re-run now".
export const TRANSIENT_UPSTREAM_NOT_EVALUATED = 'TRANSIENT_UPSTREAM_NOT_EVALUATED';

// A plain 403 is a permission denial and must NOT be retried, so a rate-limit
// signal is required on top of the status.
export function isRateLimited(status, headers, body) {
  if (status !== 403 && status !== 429) return false;
  return (
    headers.get('retry-after') !== null ||
    headers.get('x-ratelimit-remaining') === '0' ||
    /rate limit/i.test(body)
  );
}

// 5xx is GitHub failing to answer, not an answer about the diff. Status alone
// decides it: unlike isRateLimited there is no header or body corroboration to
// look for, and no 5xx is a statement about the request's content. This only
// classifies — it deliberately does not make the request retryable, because
// sizing retries against the step budget is a separate judgement (see the
// qualityRetryBudgetMs docblock) and mislabelling is the defect being fixed.
export function isTransientUpstreamFailure(status) {
  return status >= 500 && status <= 599;
}

export function rateLimitWaitMs(headers, now = Date.now()) {
  const retryAfter = Number(headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    // A reset already at or behind our clock (skew, or a second limit after an
    // earlier sleep) must not become a zero wait: that re-requests at full rate
    // against an API that is refusing us. Fall back to the headerless floor.
    const wait = reset * 1000 - now;
    return wait > 0 ? wait : RATE_LIMIT_MIN_WAIT_MS;
  }
  return RATE_LIMIT_MIN_WAIT_MS;
}

export async function ghFetch(path, token, options = {}) {
  const {
    timeoutMs = GH_FETCH_DEFAULT_TIMEOUT_MS,
    signal: externalSignal,
    retryBudgetMs = RATE_LIMIT_RETRY_BUDGET_MS,
    sleep = delay,
    ...fetchOptions
  } = options;
  const method = fetchOptions.method ?? 'GET';
  const deadline = Date.now() + retryBudgetMs;

  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`ghFetch timeout after ${timeoutMs}ms: ${path}`)), timeoutMs);
    const abortOnExternal = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) abortOnExternal();
      else externalSignal.addEventListener('abort', abortOnExternal, { once: true });
    }
    let res;
    let text;
    try {
      res = await fetch(`https://api.github.com${path}`, {
        ...fetchOptions,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...fetchOptions.headers,
        },
      });
      text = await res.text();
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', abortOnExternal);
    }
    if (res.ok) return JSON.parse(text);

    // READ PATH ONLY. A POST/PATCH here carries no idempotency key — the
    // comment upsert, the check-run POST and the advisory sync all append or
    // overwrite — so a response-lost retry can write this run's stale verdict
    // over a newer run's. BLO-19827 re-baselined on exactly this: retry reads,
    // never writes.
    if (method !== 'GET' || !isRateLimited(res.status, res.headers, text)) {
      const err = new Error(`GitHub API ${method} ${path} → ${res.status}: ${text}`);
      // A GET that 5xx'd returned no data, so whatever the caller was going to
      // evaluate it never got to evaluate (PEN-3760). Mark it so exitFatal says
      // "did not evaluate" instead of letting the workflow assert a finding and
      // point at a commitperclip comment that was never posted.
      //
      // GET only, matching the read/write split above: a failed write can
      // follow a verdict that WAS computed, so relabelling it would replace one
      // misreport with its mirror image.
      if (method === 'GET' && isTransientUpstreamFailure(res.status)) {
        err.notEvaluated =
          `${TRANSIENT_UPSTREAM_NOT_EVALUATED}: GitHub returned ${res.status} for ${path}, so the read never ` +
          'completed and no gate ran. This is an upstream failure, not a finding — re-run the job.';
      }
      throw err;
    }

    const waitMs = rateLimitWaitMs(res.headers);
    // Pre-sleep check: a primary installation-limit exhaustion resets up to an
    // hour out, so fail fast with a distinguishable outcome rather than stall.
    const remainingMs = deadline - Date.now();
    if (waitMs > remainingMs) {
      const err = new Error(
        `${RATE_LIMIT_NOT_EVALUATED}: GitHub API ${method} ${path} → ${res.status} rate limited. ` +
        `Next retry needs ${Math.round(waitMs / 1000)}s but only ${Math.max(0, Math.round(remainingMs / 1000))}s of ` +
        `the ${Math.round(retryBudgetMs / 1000)}s budget remains. The request never completed.`
      );
      err.rateLimited = true;
      throw err;
    }
    console.warn(`[ghFetch] ${path} → ${res.status} rate limited; retrying in ${Math.round(waitMs / 1000)}s`);
    // Pass the caller's signal so an abort (e.g. an expired advisory budget)
    // ends the wait at once instead of after it, and clears its timer.
    await sleep(waitMs, undefined, { signal: externalSignal });
  }
}

// Every gate script funnels its fatal path through here so a failure that
// evaluated nothing cannot be read as a verdict on the code: a rate-limit
// exhaustion (ghFetch sets err.rateLimited), a transient upstream 5xx on a read
// (ghFetch sets err.notEvaluated, PEN-3760), or any error a caller marks with
// err.notEvaluated = '<why no gate ran>'. Without this the failing check is
// indistinguishable from a genuine finding (BLO-37010).
export function exitFatal(err, gateLabel, exit = process.exit, outputFile = process.env.GITHUB_OUTPUT) {
  console.error(err.message);
  const why = err?.rateLimited
    ? 'A GitHub rate limit outlived the retry budget, so no gate ran. Re-run the job once the limit clears.'
    : err?.notEvaluated;
  if (why) {
    console.error(`::error::${gateLabel} DID NOT EVALUATE THE DIFF. ${why} This is NOT a quality or security finding.`);
    // A later workflow step reports this step's failure in its own words; the
    // output lets it say "did not run" instead of re-asserting "failed".
    if (outputFile) appendFileSync(outputFile, 'not_evaluated=true\n');
  }
  exit(1);
}

export async function resolveInstallationId(fetchInstallation, token, repo, owner) {
  if (repo) {
    if (!REPO_PATTERN.test(repo)) {
      throw new Error('ERROR: GH_REPO/GITHUB_REPOSITORY must be in owner/repo format.');
    }

    const installation = await fetchInstallation(`/repos/${repo}/installation`, token);
    return installation.id;
  }

  const installations = await fetchInstallation('/app/installations', token);
  if (!installations.length) {
    throw new Error(
      'ERROR: No installations found for commitperclip. Install URL: https://github.com/apps/commitperclip/installations/new'
    );
  }

  if (owner) {
    if (!OWNER_PATTERN.test(owner)) {
      throw new Error('ERROR: GITHUB_REPOSITORY_OWNER must be a valid GitHub owner name.');
    }

    const match = installations.find(
      installation => installation.account?.login?.toLowerCase() === owner.toLowerCase()
    );

    if (match) {
      return match.id;
    }
  }

  if (installations.length === 1) {
    return installations[0].id;
  }

  throw new Error(
    'ERROR: Multiple commitperclip installations found. Set GH_REPO or GITHUB_REPOSITORY so the correct installation can be selected.'
  );
}

async function main() {
  const privateKey = process.env.COMMITPERCLIP_KEY;
  if (!privateKey) {
    console.error('ERROR: COMMITPERCLIP_KEY env var not set.');
    console.error('Add to ~/.bash_profile: export COMMITPERCLIP_KEY="$(cat ~/.config/commitperclip/private-key.pem)"');
    process.exit(1);
  }

  const jwt = generateJWT(privateKey);
  const repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY;
  const owner = process.env.GITHUB_REPOSITORY_OWNER ?? repo?.split('/')[0];

  const installationId = await resolveInstallationId(ghFetch, jwt, repo, owner);

  const { token } = await ghFetch(
    `/app/installations/${installationId}/access_tokens`,
    jwt,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } }
  );

  if (!token) {
    console.error('ERROR: Failed to get installation token from GitHub API.');
    process.exit(1);
  }

  process.stdout.write(token);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => exitFatal(e, 'commitperclip token generation'));
}

#!/usr/bin/env node

/**
 * Guards against inert CODEOWNERS rules landing on master.
 *
 * GitHub silently ignores a CODEOWNERS entry naming an account without write
 * access to the repo — the rule parses fine and enforces nothing: no
 * auto-requested review, no code-owner gate. BLO-22899 found all 13 rules on
 * master invalid this way, inherited wholesale from an upstream merge
 * (c204d117) that named two read-only accounts. Nothing checked, so nothing
 * caught it until someone happened to read the raw API response.
 *
 * This asserts GitHub's own `codeowners/errors` endpoint — the exact surface
 * that silently failed — returns zero errors for the given ref.
 *
 * ## Exit codes, and why there are three (PEN-5314)
 *
 * This guard reports its verdict through its exit code, and it runs on cron
 * (`codeowners-guard.yml`, hourly). Before PEN-5314's Done-when 4 it made one
 * unretried `gh` call, so a transient 5xx threw, the process died non-zero,
 * and the scheduled run went red — with the SAME integer a real violation
 * spends. A reader seeing it red could not tell "a CODEOWNERS rule is inert"
 * from "GitHub returned a 502 and this guard never looked at the file".
 *
 * That is the defect PEN-5314 was filed for, in `land-clean-prs.mjs`. The
 * remedy there is mirrored here deliberately, down to the integer, so the two
 * scheduled guards speak one language:
 *
 *   0  measured, and the ref is sound
 *   1  measured, and a rule is inert — act on it
 *   3  COULD NOT MEASURE — this run asserts nothing about the ref
 *
 * `EXIT_UNMEASURED` is non-zero on purpose. A read that failed must not print
 * a pass, so the step still fails the job and the schedule still goes red;
 * what changes is that the red now says which kind of red it is.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// PEN-5314 Done-when 4 asked for the SHARED helper rather than another
// bespoke retry loop. `land-clean-prs.mjs` already imports `withRetry` from
// this module; this is the second caller, not a second implementation.
import { withRetry } from "./mirror-comment-review-gate-to-merge-group.mjs";

export const EXIT_VIOLATION = 1;
export const EXIT_UNMEASURED = 3;

/**
 * @param {{line: number, kind: string, suggestion?: string}[]} errors
 * @returns {string[]} human-readable violations; empty when the ref is sound
 */
export function summarizeErrors(errors) {
  return (errors ?? []).map((error) => {
    const suggestion = error.suggestion ? ` — ${error.suggestion}` : "";
    return `line ${error.line}: ${error.kind}${suggestion}`;
  });
}

/**
 * `execFileSync` puts the useful text on `stderr`, not `message`, so a caller
 * classifying a failure has to look at both. Kept separate from the predicate
 * below so a test can prove which field was read.
 */
export function ghErrorText(error) {
  return String(error?.stderr || error?.message || error || "");
}

/**
 * A `gh` failure worth another attempt.
 *
 * Deliberately a POSITIVE allowlist rather than a subtraction, which is the
 * opposite shape from `land-clean-prs.mjs`'s `isFatalGhError`, and the
 * difference is intentional: that file retries writes and needs to name what
 * must never be retried, whereas this one issues exactly one idempotent read
 * and can afford to retry only what it positively recognises. Anything it
 * cannot identify falls through unretried and lands on `EXIT_UNMEASURED`,
 * which is the honest answer for an error class nobody has classified.
 *
 * Note what is NOT here: `HTTP 404` (a bad ref — retrying cannot make it
 * exist), rate limits, and bad credentials. Those are all genuinely
 * unmeasured, so they skip the backoff and go straight to exit 3.
 */
export function isTransientGhError(message) {
  return /HTTP 5\d\d|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up/i.test(
    String(message ?? ""),
  );
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function fetchCodeownersErrors(repo, ref, { run = gh, retry = withRetry } = {}) {
  const raw = retry(
    `codeowners/errors for ${repo}@${ref}`,
    () => run(["api", `repos/${repo}/codeowners/errors?ref=${ref}`]),
    { shouldRetry: (error) => isTransientGhError(ghErrorText(error)) },
  );
  return JSON.parse(raw).errors ?? [];
}

/**
 * The whole guard as a function of its inputs, returning the exit code rather
 * than spending it. `main` is then a thin shell, and the three-way contract
 * above is pinnable by a test without spawning a process.
 */
export function runGuard({
  repo,
  ref,
  fetch = fetchCodeownersErrors,
  log = console.log,
  logError = console.error,
} = {}) {
  let errors;
  try {
    errors = fetch(repo, ref);
  } catch (error) {
    logError(
      `CODEOWNERS guard DID NOT MEASURE ${repo}@${ref}: ${ghErrorText(error).split("\n")[0]}`,
    );
    logError(
      "This run asserts nothing about the ref — it is not a statement that the " +
        "rules are sound, and it is not a violation. See PEN-5314.",
    );
    return EXIT_UNMEASURED;
  }

  const summary = summarizeErrors(errors);

  if (summary.length > 0) {
    logError(
      `CODEOWNERS guard FAILED for ${repo}@${ref} (${summary.length} error(s)):\n`,
    );
    for (const line of summary) logError(`  ${line}`);
    logError(
      "\nEach error names a rule GitHub will silently ignore — no auto-requested " +
        "review, no code-owner gate. See BLO-22899.",
    );
    return EXIT_VIOLATION;
  }

  log(`CODEOWNERS guard passed: 0 errors for ${repo}@${ref}.`);
  return 0;
}

function main() {
  const repo =
    process.env.CODEOWNERS_GUARD_REPO ||
    process.env.GITHUB_REPOSITORY ||
    "Blockcast/paperclip";
  const ref = process.env.CODEOWNERS_GUARD_REF || process.env.GITHUB_SHA || "master";

  const code = runGuard({ repo, ref });
  if (code !== 0) process.exit(code);
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  return Boolean(argvPath) && resolve(argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModule()) {
  main();
}

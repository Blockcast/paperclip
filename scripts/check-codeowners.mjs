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

/**
 * The files that can SILENCE the `secret_scan` lane, and therefore must carry a
 * code owner (PEN-6393).
 *
 * `.github/**` owns the lane that RUNS gitleaks; it does not reach these, which
 * live at the repo root. gitleaks resolves its config from the working tree, so
 * an allowlist entry added by a PR takes effect on that same PR — and the lane's
 * own failure comment tells the author to add one. `.gitleaksignore` is a second
 * channel that needs no config edit at all: gitleaks v8.28.0 auto-loads it from
 * `--source` and drops findings by fingerprint.
 *
 * Listed by exact name because that is how `.github/CODEOWNERS` lists them: a
 * config under a NEW name is not covered, and adding one means adding a line
 * there and here together.
 */
export const SECRET_SCAN_SILENCING_PATHS = [
  ".gitleaks.toml",
  ".gitleaks-staging.toml",
  ".gitleaksignore",
];

/**
 * Splits CODEOWNERS text into `{line, pattern, owners}`, dropping comments and
 * blank lines. An owner-less rule is kept, with `owners: []` — that is not noise,
 * it is how CODEOWNERS REMOVES ownership, and the coverage check below depends on
 * seeing it.
 *
 * Bound, stated because the parser looks more general than it is: a `#` anywhere
 * on a line starts a comment. CODEOWNERS has no escape for a literal `#`, and no
 * rule here contains one. That is GitHub's own documented behaviour rather than
 * an assumption about it: "About code owners" lists escaping a pattern starting
 * with `#` using a backslash among the gitignore rules that do NOT work, and its
 * example file shows `#` opening an inline comment too. (Re-checked 2026-11-11
 * for PEN-6444, which queried the absolute.)
 *
 * @param {string} text
 * @returns {{line: number, pattern: string, owners: string[]}[]}
 */
export function parseCodeownersRules(text) {
  const rules = [];
  String(text ?? "")
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const fields = raw.replace(/#.*$/, "").trim().split(/\s+/).filter(Boolean);
      if (fields.length === 0) return;
      const [pattern, ...owners] = fields;
      rules.push({ line: index + 1, pattern, owners });
    });
  return rules;
}

/**
 * Three-way verdict on whether a CODEOWNERS pattern can govern a ROOT-LEVEL file.
 *
 * The third value is the point of it. A two-way match/no-match answer has to
 * guess for every pattern shape this parser does not implement, and the cheap
 * guess is "does not match" — which the caller reads as "ownership unchanged",
 * i.e. still covered. Naming the undecidable case instead lets the caller fail
 * CLOSED on it.
 *
 * The semantics, from GitHub's "About code owners": a CODEOWNERS pattern follows
 * most gitignore rules; a leading `/` anchors to the repository root; a pattern
 * containing no slash matches that name at ANY depth, root included; a leading
 * globstar segment likewise reaches the root; a trailing `/` names a directory;
 * matching is case-sensitive. Negation with `!` and character ranges with `[ ]`
 * are documented as NOT working, so a pattern using either has undefined effect
 * rather than no effect — a reason to refuse to interpret it, not to ignore it.
 *
 * @param {string} pattern a CODEOWNERS pattern
 * @param {string} path a root-relative file name, e.g. `.gitleaks.toml`
 * @returns {"matches" | "cannot-match" | "unmodelled"}
 */
export function classifyRootPathMatch(pattern, path) {
  const target = String(path ?? "");
  // Everything below reasons about a file sitting AT the repository root, which
  // is all `SECRET_SCAN_SILENCING_PATHS` contains. Asked about anything else —
  // a nested path added to that list later — the model does not apply, and
  // saying so reds the guard instead of answering confidently and wrongly.
  if (target === "" || target.includes("/")) return "unmodelled";

  const raw = String(pattern ?? "");
  if (raw === "") return "cannot-match";

  let rest = raw.startsWith("/") ? raw.slice(1) : raw;
  // A leading globstar segment is the one slash-bearing shape that still reaches
  // a root-level file: `**` + `/name` matches `name` at any depth.
  if (rest.startsWith("**/")) rest = rest.slice(3);
  // Any surviving `/` demands a directory component the target does not have.
  // This subsumes the DIRECTORY form too — a pattern ending in `/` either keeps
  // a slash here or reduces to the empty string, and neither can equal a
  // non-empty root-level name. An explicit `raw.endsWith("/")` branch was
  // written first and dropped: it agreed with this line on all 690 verdicts of a
  // pattern corpus built to over-sample slash shapes, so no mutation could red
  // it, and a branch no test can kill is not a second layer of defence.
  if (rest.includes("/")) return "cannot-match";

  // `*` and `?` work on GitHub and are not modelled here; `[`, `]` and `!` do
  // not work there, so their effect is undefined. Both are reasons to refuse.
  if (/[*?[\]!]/.test(rest)) return "unmodelled";

  return rest === target ? "matches" : "cannot-match";
}

/**
 * Owners of a ROOT-LEVEL path under last-match-wins, or `null` when a rule this
 * parser does not model could have changed the answer.
 *
 * One pass in file order IS last-match-wins: a later `matches` replaces whatever
 * stood before it — including a `null` — and a later owner-less rule replaces an
 * owner with `[]`, which is how CODEOWNERS removes ownership.
 *
 * ⚠ `null` means "cannot tell", NOT "no owners". The caller has to fold it into
 * the UNCOVERED side; folding it into the covered side restores the fail-open
 * this function was written to close.
 */
export function ownersForRootPath(rules, path) {
  let owners = [];
  for (const rule of rules ?? []) {
    const verdict = classifyRootPathMatch(rule?.pattern, path);
    if (verdict === "matches") owners = rule?.owners ?? [];
    else if (verdict === "unmodelled") owners = null;
  }
  return owners;
}

/**
 * Which silencing paths have NO code owner. `[]` is the sound state.
 *
 * ## What this asserts, and what it deliberately leaves to the guard above
 *
 * This answers "does a rule exist for this path, with an owner". It does NOT
 * answer "is that owner real" — an entry naming an account without write access
 * parses fine and enforces nothing (BLO-22899), which is precisely the failure
 * `runGuard` exists to catch against GitHub's own `codeowners/errors` endpoint.
 *
 * ⛔ The two are NOT redundant and neither covers the other: a rule can exist
 * with a dead owner (this passes, `runGuard` fails) or be deleted outright
 * (`runGuard` passes — it only ever sees rules that are present — and this
 * fails). Removing either leaves a real hole, so each carries its own assertion.
 *
 * ## Where the pattern model stops, and which way it falls over (PEN-6444)
 *
 * Coverage used to be decided by comparing pattern STRINGS, which modelled
 * last-match-wins only for an IDENTICALLY SPELLED rule. A later anchored
 * `/.gitleaks.toml` carrying no owners — which GitHub resolves as REMOVING
 * ownership of the root file — is a different string, was never compared, and
 * this returned []. The check reported covered on a file GitHub had just left
 * unowned: fail-open, in a guard whose entire job is to notice that. The
 * docstring that stood here called the anchored form conservative, which was
 * true only when it was the sole rule for the path.
 *
 * `ownersForRootPath` resolves by what a pattern MEANS for a root-level file
 * instead, and answers `null` for any shape it does not model — a glob, a
 * character range, a nested target. That `null` is folded in as UNCOVERED below,
 * so a rule this parser cannot read reds the check instead of passing it. The
 * residual bound is therefore NOISE rather than silence: a glob landing after
 * one of these rules asks a human to look, which is the direction a security
 * guard should fail in. The cost is real and is the right trade — this guard
 * runs hourly on cron, so a spurious red is visible and fixable, where a
 * spurious green is neither.
 */
export function uncoveredSecretScanPaths(text, paths = SECRET_SCAN_SILENCING_PATHS) {
  const rules = parseCodeownersRules(text);
  // `?? []` is the line where "cannot tell" becomes "uncovered". Changing it to
  // treat `null` as covered re-opens PEN-6444. See `ownersForRootPath`.
  return paths.filter((path) => (ownersForRootPath(rules, path) ?? []).length === 0);
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

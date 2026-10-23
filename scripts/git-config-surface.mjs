// The agent image's git-config surface, as a predicate shared by the two
// checks that assert it (PEN-4541).
//
// WHY THIS EXISTS
// ---------------
// A narrowed agent seat loads exactly two git config scopes, and neither was
// checked by anything until this shipped (PEN-4517 -> PEN-4538 -> PEN-4541):
//
//   file:/etc/gitconfig   the agent image's system scope, written once by
//                         `Dockerfile.runtime`'s `git config --system`, and
//                         carrying the **gh** credential helper
//                         (`!/usr/bin/gh auth git-credential`).
//   command line:         the **paperclip** credential helper, injected as two
//                         `-c` flags by `docker/github-wrappers/git`, which
//                         shadows /usr/bin/git on PATH.
//
// Those are two different helpers in two different scopes. Do not let a check
// written against one be read as covering the other -- that conflation is
// correction C1/C2 on PEN-4541.
//
// THE MUTATION THIS IS BUILT AROUND (correction C3)
// -------------------------------------------------
// A `url.<attacker>.insteadOf = https://github.com/` rule silently reroutes
// every GitHub remote in every repo on every agent in the fleet. Planted as a
// `-c` flag on the wrapper's exec line it is fleet-wide by construction, and
// it was invisible to BOTH controls that looked anywhere near it:
//
//   * `git config --file /etc/gitconfig --get-regexp insteadof` reads the
//     SYSTEM scope only. It returns rc 1 -- clean -- with the rewrite live on
//     the command line.
//   * the existing wrapper guard in agent-egress-path.test.mjs counts
//     occurrences of IMAGE_WRAPPER_BIN (PEN-3748). That is a PATH-INTEGRITY
//     check, not a flag-set check: appending `-c url...insteadOf=...` adds
//     zero occurrences of that path, so the count stays 2 and the test passes.
//
// Hence every comparison here is an EQUALITY against a declared expectation,
// never a superset or an `.includes()`. A superset check is what makes C3
// possible: it can only ever observe that the good flags are still there, and
// the attack is an ADDED flag.
//
// SCOPE -- read before assuming this covers more than it does
// -----------------------------------------------------------
// This measures the artifact AT PRODUCTION: the sources in this repo, and the
// image as built, before it is promoted or rolled out. It does NOT cover
// mutation of an already-published image (a Harbor retag or overwrite of a tag
// this gate already passed) or drift of an already-running pod. Registry-side
// immutability is a separate control and is deliberately NOT assigned here
// (PEN-4541, "Explicitly OUT of scope"). Do not read a green run of either
// consumer as registry-side or runtime coverage.

// --- The credential-at-rest predicate --------------------------------------
//
// A faithful port of `residual_secrets()` from
// `Blockcast/onprem-k8s :: monitoring/git-credential-at-rest/workload/scrubber.py`.
// Ported rather than re-derived because that predicate is already the measured-
// correct one: it matched the 2026-10-19 `ghs_` token at rest exactly
// (PEN-4330) -- there the file set was wrong, not the predicate.
//
// The load-bearing property, and the reason it is a whole-text scan rather than
// a key-anchored one: it is NOT anchored to `url =` / `pushurl =` / `remote =`.
// A credential parked under a key nothing will auto-fix -- an `[http]` section,
// an `insteadOf`, or a `[url "..."]` SECTION NAME whose own text carries the
// credential -- still counts. The section-name shape is the one PEN-4541
// calls out specifically, and it is covered here only because this regex is
// unanchored; anchoring it to a key would silently drop that case.

// Any userinfo in front of the host: a "scheme://" prefix, then the userinfo,
// then the "@" that ends it.
const USERINFO = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/@]+)@/;

// Any credential-bearing URL anywhere in the text, whatever key or section
// name holds it.
const ANY_URL = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@\s]+@\S*/g;

// A bare-token userinfo has no colon. Real GitHub tokens are long (ghp_/gho_
// are 40, the ghs_ installation tokens measured on the PVC were 390); the
// benign usernames actually observed are short -- `git` is 3. Length, not
// entropy. Raise it only with a measured counter-example: a false positive
// here fails a build loudly, a false negative ships a credential.
export const MIN_BARE_SECRET_LEN = 20;

/**
 * True if `url` carries a secret in its userinfo.
 *
 * Distinguishes a credential from an SSH-style username; both shapes were live
 * on the PVC and only the first is an exposure:
 *
 *   userinfo "x-access-token:<installation-token>"  -> true
 *   userinfo "git"                                  -> false
 */
export function secretInUrl(url) {
  const match = USERINFO.exec(url);
  if (!match) return false;
  const userinfo = match[2];
  const colon = userinfo.indexOf(":");
  // `partition(":")` in the Python original: a colon means user:secret, and an
  // EMPTY secret after the colon is not a secret.
  if (colon !== -1) return userinfo.length - colon - 1 > 0;
  return userinfo.length >= MIN_BARE_SECRET_LEN;
}

/**
 * Replace the userinfo of every credential-bearing URL in `text` with a
 * placeholder, leaving everything else byte-identical.
 *
 * A port of `strip_userinfo()` from the same scrubber, applied text-wide and
 * for one purpose: DIAGNOSTIC OUTPUT. Every consumer of this module reports its
 * findings by printing the config it read, and the single worst thing a check
 * for credentials at rest can do is copy the credential it found into a CI log
 * that is retained longer and read by more people than the file was. This was
 * not hypothetical -- the first cut of the image checker printed a full
 * `ghs_`-shaped fixture token in its failure diff, and the positive control
 * below caught it.
 *
 * NEVER compare redacted text. Redaction is lossy by construction, so two
 * different credentials render identically; assert on the raw value and print
 * this.
 */
export function redactCredentials(text) {
  return text.replace(ANY_URL, (url) =>
    secretInUrl(url) ? url.replace(USERINFO, "$1<redacted>@") : url,
  );
}

/**
 * Build a credential-bearing URL from parts, for fixtures and for the
 * deliberately-bad control images.
 *
 * ASSEMBLED, NEVER WRITTEN AS A LITERAL, and that is a hard constraint rather
 * than a preference: a URL literal carrying a "user:secret" userinfo is
 * credential-shaped to the repository's own egress door, which refuses the
 * push outright and cannot redact a git object in flight. Writing these out
 * is what that door is for. Deriving them at runtime closes the finding
 * permanently instead of suppressing it, which is the remedy that door names
 * and the convention the existing fixtures in this repository follow.
 *
 * Omit `secret` for an SSH-style bare username (`git`), which is not a
 * credential; pass an empty string for the empty-secret edge case.
 */
export function credentialedUrl({
  user = "x-access-token",
  secret,
  host = "github.com",
  path = "/",
} = {}) {
  return ["https://", user, secret === undefined ? "" : `:${secret}`, "@", host, path].join("");
}

/** Count credential-bearing URLs anywhere in a config body. */
export function residualSecrets(text) {
  let n = 0;
  for (const match of text.matchAll(ANY_URL)) {
    if (secretInUrl(match[0])) n += 1;
  }
  return n;
}

// --- Reading what a wrapper actually executes ------------------------------

/**
 * The shell lines a `/bin/sh` wrapper execs, with comments removed, backslash
 * continuations joined, and whitespace runs collapsed.
 *
 * Comments are stripped FIRST and only whole-line comments are recognised. That
 * is deliberate and it is the conservative direction: an inline `#` inside a
 * quoted shell word is not a comment, so treating it as one would delete real
 * executed text and could hide a flag. A whole-line `#` cannot be anything but
 * a comment in sh.
 */
export function execLines(body) {
  const withoutComments = body
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const joined = withoutComments.replace(/\\\n\s*/g, " ");
  return joined
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line === "exec" || line.startsWith("exec "));
}

/**
 * The ordered list of values passed as `-c <value>` on a wrapper's exec lines.
 *
 * Scoped to exec lines on purpose: `-c` is not a git-only spelling. Two of
 * these wrappers legitimately run `stat -L -c %d` to compare filesystem
 * devices, and a body-wide `-c` scan reports `%d` as a git config override --
 * a false positive that would make this assertion untrustworthy and therefore
 * ignored. The exec line is also exactly where a `-c` reaches git.
 *
 * A config override planted somewhere OTHER than an exec line is not covered by
 * this function, and is not meant to be: `assertNoConfigInjectionEnv` and the
 * body-wide insteadOf scan in the consuming test are what cover that path.
 */
export function configFlags(body) {
  const flags = [];
  for (const line of execLines(body)) {
    const tokens = line.split(" ");
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i] === "-c" && i + 1 < tokens.length) flags.push(tokens[i + 1]);
    }
  }
  return flags;
}

// --- The declared surface ---------------------------------------------------
//
// EQUALITY, not a superset. These are small literals that change only when a
// wrapper's executed command changes, which is exactly when a human should
// re-read this file and PEN-4541.
//
// Every file in docker/github-wrappers/ must appear here. The consuming test
// enumerates the DIRECTORY and fails on anything undeclared, so a wrapper added
// later cannot be silently uncovered -- a hardcoded list would have been the
// obvious way to write this and it would quietly miss the next wrapper.
export const EXPECTED_WRAPPER_CONFIG_FLAGS = new Map([
  // The clear-then-set pair, IN THIS ORDER. Order is part of the equality: the
  // empty value resets any helper inherited from an outer scope (including
  // /etc/gitconfig's `gh` helper), and the second names the paperclip helper.
  // Reversed, the clear would wipe the helper it is meant to install, and git
  // treats "no credential helper" as a silent fallthrough rather than an error.
  [
    "git",
    [
      "credential.https://github.com.helper=",
      "credential.https://github.com.helper=/usr/local/libexec/paperclip/bin/github-token-credential-helper",
    ],
  ],
  // The rest pass no git config at all, and must not start.
  ["gh", []],
  ["github-mcp-server", []],
  ["github-token-credential-helper", []],
  ["paperclip-github-token-env", []],
]);

// The system scope, as `Dockerfile.runtime` writes it and as the built image
// must carry it. Byte-exact: this is the whole file, and it is 77 bytes --
// one section, one key -- which is both the declared surface and the
// wrong-machine detector for the image-level check. A CI runner's own
// /etc/gitconfig does not look like this, so a check that accidentally read the
// runner instead of the agent image fails here rather than passing forever.
export const EXPECTED_SYSTEM_GITCONFIG =
  '[credential "https://github.com"]\n\thelper = !/usr/bin/gh auth git-credential\n';

// The one `git config` invocation the agent image's whole build chain is
// allowed to contain, normalised the way `dockerfileGitConfigInvocations`
// returns it.
export const EXPECTED_DOCKERFILE_GIT_CONFIG =
  "git config --system credential.https://github.com.helper '!/usr/bin/gh auth git-credential'";

// The single key that scope may define, in `git config --list` spelling.
export const EXPECTED_SYSTEM_CONFIG_ENTRIES = [
  "credential.https://github.com.helper=!/usr/bin/gh auth git-credential",
];

// --- Shared sub-predicates --------------------------------------------------

// Environment variables that inject git config with exactly the force of a
// `-c` flag, and would therefore carry correction C3's mutation straight past a
// flag-set equality that only reads `-c`. GIT_CONFIG_COUNT/KEY_n/VALUE_n is the
// documented argv-free equivalent of `-c`; GIT_CONFIG_GLOBAL/SYSTEM repoint a
// whole scope at an attacker-chosen file. Named here so both consumers refuse
// them, rather than left as an unstated assumption that wrappers never set them.
const CONFIG_INJECTION_ENV =
  /\bGIT_CONFIG(?:_COUNT|_KEY_\d+|_VALUE_\d+|_GLOBAL|_SYSTEM|_NOSYSTEM)?\b/;

export function configInjectionEnv(text) {
  return CONFIG_INJECTION_ENV.exec(text)?.[0] ?? null;
}

// Any casing. `git` matches config keys case-insensitively, so `insteadof`,
// `insteadOf` and `INSTEADOF` are one rule with three spellings, and a
// case-sensitive scan is defeated by typing it differently.
export function insteadOfOccurrences(text) {
  return text.match(/insteadof/gi) ?? [];
}

/**
 * Every `git config` invocation in a Dockerfile, with comments stripped and
 * `\`-continuations joined, normalised to single-spaced one-liners.
 *
 * Returns the invocation substring from `git config` to end of logical line, so
 * the caller can compare the SET of them against what is declared above rather
 * than asserting that one known line is still present -- the same
 * equality-not-superset rule as the wrapper flags: the risk is a SECOND write,
 * and a presence check cannot see one.
 */
export function dockerfileGitConfigInvocations(dockerfile) {
  const withoutComments = dockerfile
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const joined = withoutComments.replace(/\\\n\s*/g, " ");
  const found = [];
  for (const line of joined.split("\n")) {
    const normalised = line.trim().replace(/\s+/g, " ");
    const at = normalised.indexOf("git config");
    if (at !== -1) found.push(normalised.slice(at));
  }
  return found;
}

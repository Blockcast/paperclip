export const REDACTED_COMMAND_TEXT_VALUE = "***REDACTED***";

const SECRET_NAME_PATTERN =
  String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|(?:access[-_]?|auth[-_]?)?token|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)[A-Za-z0-9_-]*`;

const COMMAND_CLI_SECRET_OPTION_RE = new RegExp(
  String.raw`(\B-{1,2}${SECRET_NAME_PATTERN}(?:\s+|=)(["']?))[^\s"'` + "`" + String.raw`]+(\2)`,
  "gi",
);
const COMMAND_ENV_SECRET_ASSIGNMENT_RE = new RegExp(
  String.raw`(\b${SECRET_NAME_PATTERN}\s*=\s*)(?:(["'])([^"'` + "`" + String.raw`\r\n]*)\2|([^\s"'` + "`" + String.raw`]+))`,
  "gi",
);
const COMMAND_AUTHORIZATION_BEARER_RE = /(\bAuthorization\s*:\s*Bearer\s+)[^\s"'`]+/gi;

/**
 * PEN-3139: vendor credential shapes matched by *value*, with no secret-shaped
 * key, flag or `Authorization:` header beside them.
 *
 * Every other pattern in this file is *name*-anchored — it needs a
 * `SECRET_KEY=`, a `--secret-flag`, or a `"secret_field":` to fire. Free text
 * carries none of those: a run-log chunk is a tool-result summary, and the
 * credential sits bare in prose. This list is the only thing that can catch it,
 * and it was the shortest of the three credential-shape lists this repo owns
 * (`KNOWN_SECRET_PREFIX_RE` in `server/src/redaction.ts` and
 * `CREDENTIAL_VALUE_RES` in `@paperclipai/shared` are both longer), so five
 * major vendor formats reached the run-log store in the clear.
 *
 * Parity with `CREDENTIAL_VALUE_RES` is enforced by a test, not by convention —
 * see `server/src/__tests__/pen3139-transcript-credential-shapes.test.ts`. Add a
 * shape there and here together.
 *
 * Deliberately NOT covered here: the generic high-entropy heuristic that
 * `isPlausiblySensitiveEnvValue` applies to env *values*. On a bounded value it
 * is safe; over free text it blanks commit SHAs, UUIDs, and base64 evidence —
 * the exact over-redaction the #943 review removed from `redaction.ts`. Named
 * shapes only. This is defence in depth, not a boundary: it cannot be complete
 * over unstructured text, so nothing may rely on it to decide who reads a
 * transcript.
 */
const COMMAND_OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
// SELF-SUFFICIENT (BLO-29553). The `(?:\.…)*` tail means this rule consumes a
// whole composite `ghs_<seg>.<b64>.<b64>` on its own, without depending on
// COMMAND_JWT_RE to cover the dotted remainder. That dependency was the leak:
// JWT requires every segment to be >=8 chars, so a composite with a short
// middle segment, or a 2-segment composite, has no JWT match at all and the
// tail went out in the clear. The tail class admits `-` because base64url
// payloads do; the prefix class does not, matching GitHub's own token alphabet.
//
// "Self-sufficient" is CONDITIONAL, not unconditional: it holds only while the
// token body stays inside `[A-Za-z0-9_]`. If GitHub ever issues a `gh*_` token
// containing a character outside that class (a `-`, or a second `.`), the
// `{20,}` run stops early and the damage depends on WHERE that character falls.
// At or after the 20th body character, this rule reverts to matching a PREFIX
// of the value, and the 2-of-3-segment leak this fix closed is back — a prefix
// replacement inserts `*` and destroys the structure the later rules match on.
// INSIDE the first 20 body characters it is strictly worse: `{20,}` fails
// outright, this rule matches NOTHING, and the `gh*_` head goes out in the clear
// alongside the whole tail. Measured — nothing in the chain redacts
// `ghs_NOTAREAL-TOKEN0123456789abcdef.ab.<sig>`, because JWT cannot cover it
// either (its `ab` segment is under 8 chars).
// Widen the body class in step with any such change, and re-run
// blo29553-composite-token-redaction.test.ts.
const COMMAND_GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}(?:\.[A-Za-z0-9_-]+)*\b/g;
/**
 * Fine-grained PAT. Deliberately its own rule rather than widening the class in
 * COMMAND_GITHUB_TOKEN_RE: that pattern is `gh[pousr]_`, and `github_pat_` has
 * `i` in the third position, so it matches nothing there and the prefix went out
 * in the clear (BLO-29553). Same self-sufficient tail, same conditional caveat.
 *
 * Landed ahead of this change by PEN-3139 (#1736), which copied it from the
 * BLO-29553 branch; the two are byte-identical here.
 */
const COMMAND_GITHUB_FINE_GRAINED_PAT_RE = /\bgithub_pat_[A-Za-z0-9_]{20,}(?:\.[A-Za-z0-9_-]+)*\b/g;
/**
 * `AKIA` (long-lived) and `ASIA` (STS session) are the two AWS prefixes that
 * denote an *access key ID*. The other `A…A` prefixes (`AIDA`, `AROA`, …) are
 * unique IDs for users and roles — identifiers, not credentials — and blanking
 * them would be the benign-identifier over-redaction this file warns about.
 */
const COMMAND_AWS_ACCESS_KEY_ID_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const COMMAND_GOOGLE_API_KEY_RE = /\bAIza[0-9A-Za-z_-]{20,}/g;
const COMMAND_SLACK_TOKEN_RE = /\bxox[baprs]-[A-Za-z0-9-]{10,}/g;
/**
 * Matches the header, the base64 body, and the footer when one is present.
 *
 * The footer is optional on purpose: run-log chunks are truncated
 * (`compactRunLogChunk`), so a key body can be split mid-block, and a pattern
 * requiring `-----END` would pass the leading half of the key straight through.
 *
 * Body segments tolerate literal `\n` / `\r` escapes because a PEM block
 * reaching a log inside a JSON tool result arrives escaped rather than as real
 * newlines.
 *
 * Two branches, tried in order, because "footer present" and "footer absent"
 * want opposite things:
 *
 * 1. Footer present: consume everything between the markers. Whatever the body
 *    is wrapped at, all of it goes. The lazy quantifier is bounded by the
 *    required `-----END` literal, so it cannot run past the block it belongs to.
 * 2. Footer absent (truncated mid-block): fall back to walking 16+ base64
 *    segments, so the scan stops at ordinary prose instead of swallowing it —
 *    plus at most one shorter trailing fragment, and only at end of chunk,
 *    which is where truncation puts it.
 *
 * Branch 1 exists because requiring 16+ chars of *every* segment left the final
 * line of a real key in the clear: PEM bodies wrap at 64 characters, so the last
 * line is a short remainder for all but exact multiples, and that line plus the
 * footer survived redaction. The 16+ floor is still right mid-chunk in branch 2,
 * where there is no footer to bound the scan — it is only wrong when applied to
 * a block whose end is already known, or to the final fragment of a cut key.
 *
 * The end-anchored fragment does mean a short ordinary word ending a chunk that
 * opened with a PEM header is redacted too. That is deliberate: over-redacting
 * <=15 characters of prose inside a chunk already carrying a private-key header
 * is strictly preferable to emitting that many characters of real key material.
 */
const COMMAND_PEM_PRIVATE_KEY_RE =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----(?:[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|(?:(?:\s|\\[rn])+[A-Za-z0-9+/=]{16,})*(?:(?:\s|\\[rn])+[A-Za-z0-9+/=]{1,15}(?:\s|\\[rn])*$)?)/g;
// The tail repetition is unbounded (`*`, not `?`). A 4-segment cap made JWT
// greedily consume the leftmost four segments of a longer dotted run and strand
// whatever followed, which in a run containing a token is a surviving token
// segment (BLO-29553).
const COMMAND_JWT_RE =
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})*\b/g;
const COMMAND_SECRET_HINTS = [
  "api",
  "key",
  "token",
  "auth",
  "bearer",
  "secret",
  "pass",
  "credential",
  "jwt",
  "private",
  "cookie",
  "connectionstring",
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  // PEN-3139: without these the value-shaped patterns above never run on a
  // chunk that carries a bare credential and no other secret-ish word. The
  // `command.includes(".")` fallback below rescues most real text, but not all
  // of it — a periodless tool-result line is exactly the carrier that leaked.
  // Hints only admit text to the matchers; they never redact on their own, so
  // a loose hint costs a regex pass, not a false positive.
  "akia",
  "asia",
  "aiza",
  "xox",
  "github_pat_",
] as const;

function maybeContainsSecretText(command: string) {
  const lower = command.toLowerCase();
  return COMMAND_SECRET_HINTS.some((hint) => lower.includes(hint)) || command.includes(".");
}

export function redactCommandText(command: string, redactedValue = REDACTED_COMMAND_TEXT_VALUE): string {
  if (!maybeContainsSecretText(command)) return command;
  return command
    .replace(COMMAND_AUTHORIZATION_BEARER_RE, `$1${redactedValue}`)
    .replace(COMMAND_CLI_SECRET_OPTION_RE, `$1${redactedValue}$3`)
    .replace(
      COMMAND_ENV_SECRET_ASSIGNMENT_RE,
      (_match, prefix: string, quote: string | undefined) =>
        quote ? `${prefix}${quote}${redactedValue}${quote}` : `${prefix}${redactedValue}`,
    )
    // ORDERING INVARIANT (BLO-29553) — self-sufficient prefix-anchored rules,
    // then JWT, then prefix rules that cover no dotted tail. `redactedValue`
    // contains `*`, which is outside `[A-Za-z0-9_-]`, so any replacement made
    // here can destroy a LATER rule's match. The three rules above each consume
    // their whole value, so they are safe in any order; the value-shape rules
    // below are not.
    //
    // The token `gh auth status` emits is a composite — `ghs_<seg>.<b64>.<b64>`.
    // Originally the prefix rules ran first and replaced only the `ghs_` head,
    // breaking the three-segment structure COMMAND_JWT_RE needed; payload and
    // signature persisted verbatim (2 of 3 segments surviving). Putting JWT
    // first fixed that case and opened two others, because JWT is shape-only: it
    // requires every segment to be >=8 chars and so stops mid-composite on a
    // short segment, and it cannot start on a 2-segment composite at all — in
    // both cases it strands the tail. Only a rule that knows where the token
    // begins AND carries its own dotted tail can own the whole run, which is why
    // the two GitHub rules are self-sufficient and sit ahead of JWT.
    //
    // COMMAND_OPENAI_KEY_RE stays LAST precisely because it is prefix-anchored
    // and NOT self-sufficient: ahead of JWT it would reintroduce the original
    // bug on a dotted value. `sk-` keys are not dotted, so it strands nothing.
    //
    // FOUR of the five PEN-3139 rules keep their relative position — AWS,
    // Google, Slack and PEM, before JWT and after the GitHub rules — exactly as
    // #1736 asked for on conflict. The fifth it shipped,
    // COMMAND_GITHUB_FINE_GRAINED_PAT_RE, moves up to sit beside
    // COMMAND_GITHUB_TOKEN_RE and is covered by "the two GitHub rules" above:
    // it is prefix-anchored and self-sufficient, and the two never compete for
    // the same run, because `gh[pousr]_` cannot match a prefix of `github_pat_`
    // (`i` is not in `[pousr]`), so their order relative to each other is free.
    // The four are self-sufficient too: the value each matches carries no dotted
    // tail (AWS, Google and Slack keys are undotted; a PEM body is base64, which
    // excludes `.`), so none strands a remainder for JWT and none is stranded by
    // it — which is why their order among themselves is free as well. The only
    // load-bearing positions are the two GitHub rules AHEAD of JWT and
    // COMMAND_OPENAI_KEY_RE AFTER it; both are pinned executably by the suite.
    //
    // Measured over the enumerated composite family (2-6 segments x short middle
    // segment x 0-2 context segments each side, 90 cases): this order leaves 0
    // surviving token segments; JWT first leaves 3. Do not reorder these without
    // re-running blo29553-composite-token-redaction.test.ts, which asserts the
    // invariant executably — a deliberately wrong order must leak.
    .replace(COMMAND_GITHUB_FINE_GRAINED_PAT_RE, redactedValue)
    .replace(COMMAND_GITHUB_TOKEN_RE, redactedValue)
    .replace(COMMAND_AWS_ACCESS_KEY_ID_RE, redactedValue)
    .replace(COMMAND_GOOGLE_API_KEY_RE, redactedValue)
    .replace(COMMAND_SLACK_TOKEN_RE, redactedValue)
    .replace(COMMAND_PEM_PRIVATE_KEY_RE, redactedValue)
    .replace(COMMAND_JWT_RE, redactedValue)
    .replace(COMMAND_OPENAI_KEY_RE, redactedValue);
}

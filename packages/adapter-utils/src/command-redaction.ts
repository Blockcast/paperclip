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
const COMMAND_OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
// SELF-SUFFICIENT (BLO-29553). The `(?:\.…)*` tail means this rule consumes a
// whole composite `ghs_<seg>.<b64>.<b64>` on its own, without depending on
// COMMAND_JWT_RE to cover the dotted remainder. That dependency was the leak:
// JWT requires every segment to be >=8 chars, so a composite with a short
// middle segment, or a 2-segment composite, has no JWT match at all and the
// tail went out in the clear. The tail class admits `-` because base64url
// payloads do; the prefix class does not, matching GitHub's own token alphabet.
const COMMAND_GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}(?:\.[A-Za-z0-9_-]+)*\b/g;
// Fine-grained PAT. Deliberately its own rule rather than widening the class in
// COMMAND_GITHUB_TOKEN_RE: that pattern is `gh[pousr]_`, and `github_pat_` has
// `i` in the third position, so it matches nothing there and the prefix went out
// in the clear (BLO-29553). Same self-sufficient tail, same reason.
const COMMAND_GITHUB_FINE_GRAINED_PAT_RE = /\bgithub_pat_[A-Za-z0-9_]{20,}(?:\.[A-Za-z0-9_-]+)*\b/g;
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
  // A bare fine-grained PAT carries none of the hint words above and no `.`, so
  // without this entry the prefilter short-circuits and no rule ever runs.
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
    // the two GitHub rules were made self-sufficient and moved ahead of JWT.
    //
    // COMMAND_OPENAI_KEY_RE stays LAST precisely because it is prefix-anchored
    // and NOT self-sufficient: ahead of JWT it would reintroduce the original
    // bug on a dotted value. `sk-` keys are not dotted, so it strands nothing.
    //
    // Measured over the enumerated composite family (2-6 segments x short middle
    // segment x 0-2 context segments each side, 90 cases): this order leaves 0
    // surviving token segments; JWT first leaves 3. Do not reorder these without
    // re-running blo29553-composite-token-redaction.test.ts.
    .replace(COMMAND_GITHUB_FINE_GRAINED_PAT_RE, redactedValue)
    .replace(COMMAND_GITHUB_TOKEN_RE, redactedValue)
    .replace(COMMAND_JWT_RE, redactedValue)
    .replace(COMMAND_OPENAI_KEY_RE, redactedValue);
}

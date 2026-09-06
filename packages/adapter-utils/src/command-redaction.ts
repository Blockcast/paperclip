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
const COMMAND_GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
// Fine-grained PAT. Deliberately its own rule rather than widening the class in
// COMMAND_GITHUB_TOKEN_RE: that pattern is `gh[pousr]_`, and `github_pat_` has
// `i` in the third position, so it matches nothing there and the prefix went out
// in the clear (BLO-29553).
const COMMAND_GITHUB_FINE_GRAINED_PAT_RE = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g;
const COMMAND_JWT_RE =
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g;
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
    // ORDERING INVARIANT (BLO-29553) — widest value shape first. `redactedValue`
    // contains `*`, which is outside `[A-Za-z0-9_-]`, so any replacement made
    // here can destroy a LATER rule's match. The three rules above each consume
    // their whole value, so they are safe in any order; the value-shape rules
    // below are not.
    //
    // The token `gh auth status` emits is a composite — `ghs_<seg>.<b64>.<b64>`.
    // With the prefix rules first, COMMAND_GITHUB_TOKEN_RE replaced only the
    // `ghs_` head, which broke the three-segment structure COMMAND_JWT_RE needs,
    // and the payload and signature were persisted verbatim (2 of 3 segments
    // surviving). JWT is the only shape here that can span another, so it must
    // run first. Do not reorder these without a composite-value test.
    .replace(COMMAND_JWT_RE, redactedValue)
    .replace(COMMAND_OPENAI_KEY_RE, redactedValue)
    .replace(COMMAND_GITHUB_FINE_GRAINED_PAT_RE, redactedValue)
    .replace(COMMAND_GITHUB_TOKEN_RE, redactedValue);
}

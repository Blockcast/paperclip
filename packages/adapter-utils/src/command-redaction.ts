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
const COMMAND_GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
/**
 * OVERLAPS OPEN PR #1683 (BLO-29553), which introduces this same constant and
 * the same `github_pat_` hint. The form here is copied from that PR — the
 * `(?:\.…)*` tail makes the rule self-sufficient over a dotted composite
 * instead of leaning on `COMMAND_JWT_RE` to finish it. If #1683 lands first,
 * take its version wholesale on conflict; the two are equivalent here and its
 * accompanying ordering invariant is the authority.
 *
 * Kept in this PR rather than deferred because this branch is master-based and
 * has to close `github_pat_` on its own: on master today the shape leaks.
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
 * newlines. Each segment must be 16+ base64 characters so the greedy body scan
 * stops at ordinary prose after an unterminated block instead of swallowing it.
 */
const COMMAND_PEM_PRIVATE_KEY_RE =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----(?:(?:\s|\\[rn])+[A-Za-z0-9+/=]{16,})*(?:(?:\s|\\[rn])*-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----)?/g;
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
    .replace(COMMAND_OPENAI_KEY_RE, redactedValue)
    .replace(COMMAND_GITHUB_TOKEN_RE, redactedValue)
    // PEN-3139 rules sit ahead of COMMAND_JWT_RE deliberately. `redactedValue`
    // contains `*`, which is outside `[A-Za-z0-9_-]`, so an earlier replacement
    // can destroy a later rule's match — ordering here is load-bearing. Each of
    // these five is self-sufficient: the value it matches carries no dotted
    // tail (AWS, Google and Slack keys are undotted; a PEM body is base64, which
    // excludes `.`), so none of them strands a remainder for JWT to finish, and
    // none can be stranded by JWT running later.
    //
    // Open PR #1683 (BLO-29553) rewrites this chain around the same invariant
    // and additionally moves COMMAND_OPENAI_KEY_RE last. That reordering is
    // theirs, measured against their 90-case suite; this PR does not touch it.
    // On conflict, take #1683's chain and re-insert these five in this relative
    // position — before JWT, after the GitHub rules.
    .replace(COMMAND_GITHUB_FINE_GRAINED_PAT_RE, redactedValue)
    .replace(COMMAND_AWS_ACCESS_KEY_ID_RE, redactedValue)
    .replace(COMMAND_GOOGLE_API_KEY_RE, redactedValue)
    .replace(COMMAND_SLACK_TOKEN_RE, redactedValue)
    .replace(COMMAND_PEM_PRIVATE_KEY_RE, redactedValue)
    .replace(COMMAND_JWT_RE, redactedValue);
}

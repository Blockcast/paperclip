import { redactCommandText } from "@paperclipai/adapter-utils";
import { envBindingSecretRefSchema, envBindingUserSecretRefSchema } from "@paperclipai/shared";

/**
 * Tier 1: key-name stems with no ambiguous benign reading (BLO-20810 / CEO
 * design constraint on #943). Any key matching one of these is redacted
 * unconditionally — no value gate, inherited by every descendant of the
 * matched value (object and array alike). A `credential`- or `password`-named
 * field is never prose; the tradeoff this accepts is that a field that merely
 * *contains* one of these words (e.g. `decision_3_traffic_ops_credential`)
 * keeps redacting even when the ask itself isn't secret material — the filer
 * is told which fields were scrubbed at create time (`redactedFields`) and
 * restates them in a comment instead.
 */
const SECRET_TIER1_STEMS =
  String.raw`api[-_]?key|access[-_]?token|auth(?:entication|orization|[-_]?token)|bearer|token|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring`;

/**
 * Tier 2: substrings that collide with ordinary words — bare `auth` catches
 * `author`/`authored`, bare `secret` catches sentence-shaped names like
 * `no_secrets_in_payload`, and `base_url` is a benign config field that
 * happens to contain `url`-adjacent text. These get a narrow positive
 * credential test (`looksLikeCredentialValue`) rather than unconditional
 * redaction, so `ask_2_author_identity` survives but `ask_2_author_identity:
 * "ghp_..."` still redacts.
 */
const SECRET_TIER2_STEMS = String.raw`auth|secret|base[-_]?url`;

const SECRET_FIELD_NAME_PATTERN =
  String.raw`[A-Za-z0-9_-]*(?:${SECRET_TIER1_STEMS}|${SECRET_TIER2_STEMS})[A-Za-z0-9_-]*`;

const SECRET_TIER1_KEY_RE = new RegExp(String.raw`[A-Za-z0-9_-]*(?:${SECRET_TIER1_STEMS})[A-Za-z0-9_-]*`, "i");
const SECRET_TIER2_KEY_RE = new RegExp(String.raw`[A-Za-z0-9_-]*(?:${SECRET_TIER2_STEMS})[A-Za-z0-9_-]*`, "i");

/**
 * `auth`/`secret` are Tier 2 because they collide with ordinary words
 * (`author`, `no_secrets_in_payload`), but as a *whole token* in a key
 * that otherwise reads as an identifier — not a sentence — they're never
 * that collision: `secret`, `client_secret`, `webhook_secret`,
 * `stripe_webhook_secret`, `auth` are ordinary credential field names, not
 * prose. Promote those to Tier 1 so a short value under them
 * (`{ secret: "hunter2" }`) doesn't fall through `looksLikeCredentialValue`'s
 * length/shape gate (BLO-20810 residual finding, #943 review).
 *
 * A flat token-count cap (originally <=2) under-promoted real three-token
 * field names like `stripe_webhook_secret` and `database_client_secret`
 * (#943 review, still-present finding). The count alone can't tell
 * `stripe_webhook_secret` (an identifier) from `secret_fields_must_stay_
 * redacted` (a sentence that happens to contain the word "secret") — but
 * *position* can: every sentence-shaped collision in this codebase's own
 * census (`secret_fields_must_stay_redacted`, `no_secret_values_in_this_
 * report`, `ask_2_author_identity`) has the trigger word somewhere in the
 * middle, never as the trailing token, because English sentences end on a
 * verb/object/adjective, not the subject noun. Real credential field names
 * follow the opposite convention (`*_secret`, `*_auth`). So: promote when
 * the trigger word is the *last* token regardless of total length, in
 * addition to the original short-key case (<=2 tokens, any position) so
 * `auth`/`secret` alone still promote. `author`/`authors` keep Tier 2
 * because "auth" isn't a whole token in them; `base_url` is excluded on
 * purpose — it is two tokens but never itself a credential value.
 */
const AMBIGUOUS_PROMOTABLE_TOKENS = new Set(["auth", "secret"]);

function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

function promotesTier2ToTier1(key: string): boolean {
  const tokens = keyTokens(key);
  if (tokens.length === 0) return false;
  if (tokens.length <= 2) return tokens.some((token) => AMBIGUOUS_PROMOTABLE_TOKENS.has(token));
  return AMBIGUOUS_PROMOTABLE_TOKENS.has(tokens[tokens.length - 1]);
}

/**
 * Single source of truth for a key's tier, used both for the top-level scan
 * in `sanitizeRecord` and to re-evaluate object children in
 * `sanitizeSecretMatchedValue` — a Tier-2 parent must not suppress a child
 * key that independently classifies as Tier 1 (BLO-20810 / #943 review
 * Critical: `{ authorInfo: { password: "hunter2" } }` used to inherit
 * `authorInfo`'s Tier 2 all the way down and never re-test `password`).
 */
function classifyKeyTier(key: string): 1 | 2 | null {
  if (SECRET_TIER1_KEY_RE.test(key)) return 1;
  if (SECRET_TIER2_KEY_RE.test(key)) return promotesTier2ToTier1(key) ? 1 : 2;
  return null;
}
const COMMAND_PAYLOAD_KEY_RE =
  /(^command$|^cmd$|command[-_]?line|resolved[-_]?command|PAPERCLIP_RESOLVED_COMMAND)/i;
const COMMAND_ARGS_PAYLOAD_KEY_RE = /^(commandArgs|command_?args|argv)$/i;
/**
 * `args` is the spelling real MCP stdio server configs use — see
 * `services/tool-access.ts` (`Array.isArray(server.args)`) — so the three
 * synonyms above covered every form except the one actually on the wire, and
 * `adapterConfig.mcpServers.*.args: ["--api-key", "…"]` went out in the clear
 * while `argv` carrying the identical value was masked (PEN-2747).
 *
 * Kept OUT of `COMMAND_ARGS_PAYLOAD_KEY_RE` and gated on `agentConfig`
 * on purpose: a bare `args` array in a *generic* event payload is not command
 * argv (tool-call arguments, job parameters), and treating it as such is an
 * exclusion this module already made deliberately — see the "does not treat
 * bare args payloads as command args" case in `redaction.test.ts`. Inside an
 * agent config the key is unambiguous, so widen there and only there.
 */
const AGENT_CONFIG_ARGS_KEY_RE = /^args$/i;
const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
const CLI_SECRET_FLAG_RE = new RegExp(String.raw`^-{1,2}${SECRET_FIELD_NAME_PATTERN}$`, "i");
const JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:"|')?${SECRET_FIELD_NAME_PATTERN}(?:"|')?\s*:\s*(?:"|'))[^"'` + "`" + String.raw`\r\n]+((?:"|'))`,
  "gi",
);
const ESCAPED_JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:\\")?${SECRET_FIELD_NAME_PATTERN}(?:\\")?\s*:\s*(?:\\"))[^\\\r\n]+((?:\\"))`,
  "gi",
);
const ENV_DUMP_SECRET_KEY_RE =
  /[A-Za-z_][A-Za-z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|SECRET|PASSWD|PASSWORD|CREDENTIAL|JWT|PRIVATE_KEY|COOKIE|BASE_URL)[A-Za-z0-9_]*/i;
const ENV_DUMP_SECRET_ASSIGNMENT_RE = new RegExp(
  String.raw`(^|[\r\n\x00])((?:export\s+|declare\s+-x\s+)?${ENV_DUMP_SECRET_KEY_RE.source}=)("[^"\r\n\x00]*"|'[^'\r\n\x00]*'|[^\r\n\x00]*)`,
  "gi",
);
// PEN-2370: a connection string carries its credential in the *value*, so it
// has to be reachable even when the surrounding text contains none of the
// name-shaped hints below (`redis://u:p@cache:6379` has no hint word and no
// dot). Gating on the scheme separator keeps URI-bearing text eligible.
const URI_SEPARATOR_HINT = "://";
// Value-shaped, deliberately name-blind: `scheme://user:secret@host`. The
// name-based allowlist in ENV_DUMP_SECRET_KEY_RE only reaches a DSN when the
// variable happens to be spelled *BASE_URL -- DATABASE_URL matches purely
// because it contains the substring "BASE_URL", while REDIS_URL and AMQP_URL
// do not match at all, and a DSN quoted inline in prose is not an assignment
// so no name rule can see it. Matching the value closes the class.
// The user component is preserved: knowing *which* principal is configured is
// the diagnostic value; the password after it is the secret.
//
// The userinfo quantifier is `*`, not `+`, and that is load-bearing rather than
// defensive: RFC 3986 makes the user optional, and `redis://:secret@host` is the
// ORDINARY spelling for Redis and AMQP, which authenticate with a password and
// no username at all (`requirepass`). A `+` here matches the textbook
// `user:pass@` form and misses the shape those two services actually emit --
// i.e. it would leak precisely the DSNs this rule was added for. Found by
// probing the rule for a way around it rather than re-reading it.
//
// The trailing `@` is what keeps this from over-matching: a credential-free
// URL (`https://example.com:8080/path`) has no `@`, and a bare userinfo URL
// (`https://user@host`) has no `:` before it, so neither can match.
const URI_CREDENTIAL_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]*):([^\s/@]+)@/gi;
/**
 * Replacing sibling of {@link URL_CREDENTIAL_QUERY_RE}, which is a detector
 * (boolean) used by the Tier-2 value gate. The boundary class includes `#` so a
 * fragment-borne credential (`…#access_token=…`, the OAuth2 implicit-flow
 * shape) is covered by the same rule as a query-borne one, rather than needing
 * the synthesized-`?` re-test `looksLikeCredentialValue` does.
 */
const URL_CREDENTIAL_PARAM_VALUE_RE =
  /([?&#](?:token|sig|signature|api[-_]?key|access[-_]?token|auth|passwd|password|credential|x-amz-signature)=)[^&\s#]+/gi;

const SECRET_TEXT_HINTS = [
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
  "base_url",
  "baseurl",
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
] as const;
export const REDACTED_EVENT_VALUE = "***REDACTED***";

function maybeContainsSecretText(input: string) {
  const lower = input.toLowerCase();
  return SECRET_TEXT_HINTS.some((hint) => lower.includes(hint))
    || lower.includes(URI_SEPARATOR_HINT)
    || input.includes(".");
}

/**
 * PEN-2747: value-shaped credential masking on the *structured* path.
 *
 * `sanitizeRecord`'s fallthrough hands an unrecognized key's string value back
 * verbatim, so credential material carried inside a URL escaped every rule in
 * this file. Three separate near-misses lined up:
 *
 *  - `url` is in no tier. `SECRET_TIER2_STEMS` spells `base[-_]?url`, which
 *    requires the literal `base`, so `baseUrl` matched and a plain `url` did
 *    not — nor did `endpoint`, `webhookUrl`, `serverUrl`, `proxyUrl`.
 *  - The repo already owned {@link URI_CREDENTIAL_RE} and never called it here:
 *    it was wired only into {@link redactSensitiveText}, which `sanitizeRecord`
 *    reaches only for keys matching `COMMAND_PAYLOAD_KEY_RE`.
 *  - The one test covering `mcpServers.*.url` used a credential-free fixture,
 *    so it asserted the pass-through as correct output.
 *
 * Fixed by matching the *value*, in one place, rather than by adding four more
 * key names: a key-name denylist fails open on the fifth spelling, and
 * `adapterConfig.mcpServers.*.url` is precisely where an agent's k8s MCP
 * upstream is swapped for a privileged (`ns-rw` / `admin`) tier.
 *
 * Deliberately surgical — only the credential component is masked, so scheme,
 * principal, host, port and path survive. Knowing *which* upstream and *which*
 * principal an agent is pointed at is the diagnostic value these read paths
 * exist for; blanking the whole URL would destroy it, and over-redaction is the
 * failure mode this module has been corrected for repeatedly (see the
 * `looksLikeReadableSlug` comments). It also means a credential-free URL still
 * round-trips byte-identical.
 *
 * Gated on the scheme separator so prose that merely contains `token=` is left
 * alone; a bare `user@host` (no `:`) and a credential-free
 * `https://host:8080/path` (no `@`) cannot match `URI_CREDENTIAL_RE` either.
 */
function redactUriCredentialsInValue(value: string): string {
  if (!value.includes(URI_SEPARATOR_HINT)) return value;
  return value
    .replace(URI_CREDENTIAL_RE, `$1$2:${REDACTED_EVENT_VALUE}@`)
    .replace(URL_CREDENTIAL_PARAM_VALUE_RE, `$1${REDACTED_EVENT_VALUE}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSecretPointerCandidate(value: unknown): value is Record<string, unknown> & { type: "secret_ref" | "user_secret_ref" } {
  return isPlainObject(value) && (value.type === "secret_ref" || value.type === "user_secret_ref");
}

/**
 * `agentConfig` switches on the structural rules described on
 * {@link redactAgentConfigPayload}. Off (the default) keeps the generic
 * key-name behaviour every other event payload relies on.
 */
type SanitizeOptions = { agentConfig?: boolean };

/**
 * A `secret_ref` / `user_secret_ref` binding is a pointer. Preserve only its
 * schema-owned pointer fields; a `value` or any other unknown field can only be
 * resolved plaintext or untrusted baggage riding along with it.
 */
function sanitizeSecretRefPointer(binding: Record<string, unknown>): Record<string, unknown> | null {
  const parsed = envBindingSecretRefSchema.safeParse(binding);
  if (!parsed.success) return null;
  const data = parsed.data;
  const pointer: Record<string, unknown> = {
    type: data.type,
    secretId: data.secretId,
  };
  for (const key of ["version", "projectionClass", "projectionAllowlistKey"] as const) {
    if (key in binding && data[key] !== undefined) pointer[key] = data[key];
  }
  return pointer;
}

function sanitizeUserSecretRefPointer(binding: Record<string, unknown>): Record<string, unknown> | null {
  const parsed = envBindingUserSecretRefSchema.safeParse(binding);
  if (!parsed.success) return null;
  const data = parsed.data;
  const pointer: Record<string, unknown> = {
    type: data.type,
    key: data.key,
  };
  for (const key of ["version", "required", "allowMissingOverride"] as const) {
    if (key in binding && data[key] !== undefined) pointer[key] = data[key];
  }
  return pointer;
}

function sanitizeValue(value: unknown, options?: SanitizeOptions): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, options));
  if (options?.agentConfig && isSecretPointerCandidate(value)) {
    return (
      value.type === "secret_ref"
        ? sanitizeSecretRefPointer(value)
        : sanitizeUserSecretRefPointer(value)
    ) ?? REDACTED_EVENT_VALUE;
  }
  if (isSecretRefBinding(value) || isUserSecretRefBinding(value)) {
    return value;
  }
  if (isPlainBinding(value)) {
    // In an agent config a plain binding IS credential material, by
    // construction — the key it hangs off tells us nothing.
    return options?.agentConfig
      ? { type: "plain", value: REDACTED_EVENT_VALUE }
      : { type: "plain", value: sanitizeValue(value.value, options) };
  }
  if (typeof value === "string") return redactUriCredentialsInValue(value);
  if (!isPlainObject(value)) return value;
  return sanitizeRecord(value, options);
}

/**
 * Every value of an `env` map is credential-bearing regardless of its key, so
 * mask the value and keep only safe shapes: a pointer stays a pointer, a plain
 * binding stays a redacted plain binding, and every legacy or malformed value
 * becomes the sentinel string.
 */
function sanitizeAgentEnvRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isSecretRefBinding(value)) {
      redacted[key] = sanitizeSecretRefPointer(value) ?? REDACTED_EVENT_VALUE;
      continue;
    }
    if (isUserSecretRefBinding(value)) {
      redacted[key] = sanitizeUserSecretRefPointer(value) ?? REDACTED_EVENT_VALUE;
      continue;
    }
    if (isPlainBinding(value)) {
      redacted[key] = { type: "plain", value: REDACTED_EVENT_VALUE };
      continue;
    }
    redacted[key] = REDACTED_EVENT_VALUE;
  }
  return redacted;
}

/**
 * The header map of an MCP server entry is credential-bearing by construction
 * in the same way an `env` map is, so it gets the same allowlist treatment
 * (PEN-2747). `Authorization` was masked only incidentally — "auth" is a Tier-1
 * stem — which left every differently-spelled credential header in the clear:
 * `X-Tenant-Signature`, `X-Gbrain-Bearer`, `Cookie`-adjacent vendor spellings.
 * A denylist over header names has no bounded vocabulary to enumerate; a
 * request header that is *not* content negotiation is, on this surface,
 * overwhelmingly authorization or tenant-routing material.
 *
 * The exemption list is deliberately short and closed: headers whose value can
 * never itself be a credential. Anything else masks, and the round-trip guard
 * in `routes/agents.ts` (`restoreRedactedAdapterValue`) puts the stored value
 * back if a caller PATCHes the redacted config in.
 */
const BENIGN_HEADER_NAMES = new Set([
  "accept",
  "accept-charset",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-type",
  "user-agent",
]);

function sanitizeAgentHeaderRecord(record: Record<string, unknown>, options?: SanitizeOptions): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    redacted[key] = BENIGN_HEADER_NAMES.has(key.trim().toLowerCase())
      ? sanitizeValue(value, options)
      : REDACTED_EVENT_VALUE;
  }
  return redacted;
}

function isSecretRefBinding(value: unknown): value is { type: "secret_ref"; secretId: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "secret_ref" && typeof value.secretId === "string";
}

function isUserSecretRefBinding(value: unknown): value is { type: "user_secret_ref"; key: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "user_secret_ref" && typeof value.key === "string";
}

function isPlainBinding(value: unknown): value is { type: "plain"; value: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "plain" && "value" in value;
}

function sanitizeCommandArgs(args: unknown[], options?: SanitizeOptions): unknown[] {
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED_EVENT_VALUE;
    }
    if (typeof arg !== "string") return sanitizeValue(arg, options);
    if (CLI_SECRET_FLAG_RE.test(arg.trim())) {
      redactNext = true;
      return arg;
    }
    return redactSensitiveText(arg);
  });
}

const OPAQUE_VALUE_SCHEME_PREFIX_RE = /^(?:bearer|basic|token)\s+/i;
const URL_LIKE_VALUE_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const PEM_BLOCK_RE = /-----BEGIN [A-Z0-9 ]+-----/;
const URL_USERINFO_RE = /:\/\/[^/\s@]+:[^/\s@]+@/;
const URL_CREDENTIAL_QUERY_RE = /[?&](?:token|sig|signature|api[-_]?key|access[-_]?token|auth|authentication|passwd|password|credential|x-amz-signature)=/i;
const KNOWN_SECRET_PREFIX_RE = /^(?:sk-|sk_live_|pk_live_|ghp_|gho_|ghu_|ghs_|ghr_|xox[baprs]-|AKIA|glpat-|gsk_)/i;
const JWT_LIKE_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MIN_OPAQUE_TOKEN_LENGTH = 20;

/**
 * A URL's total length trivially exceeds any opaque-token threshold, so a
 * whole-string length backstop is useless for URLs — nearly every real URL
 * would trip it (CTO finding, #943 review). Gate per path segment instead:
 * an ordinary URL's segments (`pull`, `1898`, `Blockcast`) are short, while a
 * capability/webhook URL that embeds its credential directly in the path
 * (no `user:pass@`, no `?token=`) puts the whole secret in a single segment,
 * e.g. `https://hooks.slack.test/services/T000/B000/<opaque-secret>`.
 *
 * Length alone over-redacts: a 40-char commit SHA or a canonical UUID is a
 * benign evidence identifier, not a capability, and length-only gating
 * blanks it right back (Important finding, #943 review — the exact
 * over-redaction this issue exists to remove, just relocated into the URL
 * branch). Exempt the two identifier shapes that are common, unambiguous,
 * and never themselves a bearer credential: bare hex (git SHAs, hex object
 * ids) and canonical UUIDs. Also exempt a segment that reads as a
 * human-authored slug — several short hyphen/underscore-joined words rather
 * than one unbroken blob.
 *
 * "Chunked into short parts" is NOT on its own evidence of readability
 * (Important finding, #1136 review, head b78bb2e9): a delimiter-chunked
 * opaque token such as `a1b2c3d4-e5f6g7h8-i9j0k1l2` is three parts of <=12
 * chars and passed a pure arity/length test, so the generic backstop that is
 * supposed to fail closed on unrecognized long values let it through. Judge
 * the parts *lexically* instead: a slug's parts are whole words
 * (`pending`, `merge`) or bare numbers (`20810`, an issue id), whereas the
 * signature of an opaque chunk is letters and digits interleaved *within*
 * one part. Require at least two word-shaped parts as well, so an all-numeric
 * chunking (`12345678-87654321-11223344`) stays fail-closed too.
 *
 * Residual, deliberately accepted: a secret chunked into purely alphabetic
 * parts (`abcdefgh-ijklmnop-qrstuvwx`) is still exempted. Separating that
 * from a real word list needs a dictionary; the alternative — dropping the
 * exemption — re-blanks the status slugs and evidence links this issue
 * exists to stop over-redacting, which is the more common and more costly
 * failure. Tier-1 keys never reach this test, so a value under a genuinely
 * secret-named field is redacted regardless of shape.
 */
const HEX_IDENTIFIER_RE = /^[0-9a-f]{20,64}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_WORD_PART_RE = /^[A-Za-z]+$/;
const SLUG_NUMERIC_PART_RE = /^[0-9]+$/;
const MAX_SLUG_PART_LENGTH = 12;

function looksLikeReadableSlug(segment: string): boolean {
  const parts = segment.split(/[-_]/).filter(Boolean);
  if (parts.length < 3) return false;
  let wordParts = 0;
  for (const part of parts) {
    if (part.length > MAX_SLUG_PART_LENGTH) return false;
    if (SLUG_WORD_PART_RE.test(part)) {
      wordParts += 1;
      continue;
    }
    // Bare numbers (issue ids, years, counts) are ordinary slug components.
    // Anything else — notably letters and digits mixed inside a single
    // part — is an opaque chunk, so fail closed.
    if (!SLUG_NUMERIC_PART_RE.test(part)) return false;
  }
  return wordParts >= 2;
}

function hasOpaqueUrlPathSegment(pathname: string): boolean {
  return pathname.split("/").some((rawSegment) => {
    if (!rawSegment) return false;
    let segment = rawSegment;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      // Malformed percent-encoding: judge the raw segment as-is.
    }
    if (/\s/.test(segment) || segment.length < MIN_OPAQUE_TOKEN_LENGTH) return false;
    if (HEX_IDENTIFIER_RE.test(segment) || UUID_RE.test(segment)) return false;
    if (looksLikeReadableSlug(segment)) return false;
    return true;
  });
}

/**
 * Tier 2's value gate (BLO-20810 / CEO design constraint on #943 review). This
 * is a *positive* credential test, not a benign-shape allowlist — the earlier
 * version of this function ("does it look like prose?") let real credentials
 * through whenever they happened to contain whitespace (a spaced passphrase)
 * or a scheme (a presigned/webhook URL, a Postgres DSN), because those are
 * properties real credentials can have too. Classify the *value* as
 * credential-shaped by matching known secret prefixes, JWT shape, PEM
 * blocks, URL userinfo/credential query params, a path-embedded opaque
 * segment, or (as a backstop for unrecognized formats) a long single opaque
 * token — rather than inferring "not a credential" from the absence of those
 * properties.
 *
 * A short single word ("octocat", "alice") is common under ambiguous
 * tier-2 keys like `author`/`authors` and is deliberately NOT treated as
 * credential-shaped (BLO-20810 Important finding) — real secrets this
 * function must catch either carry a recognizable prefix/shape or are long
 * enough that `MIN_OPAQUE_TOKEN_LENGTH` catches them.
 */
function looksLikeCredentialValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (PEM_BLOCK_RE.test(trimmed)) return true;
  if (URL_LIKE_VALUE_RE.test(trimmed)) {
    if (URL_USERINFO_RE.test(trimmed) || URL_CREDENTIAL_QUERY_RE.test(trimmed)) return true;
    try {
      const url = new URL(trimmed);
      // `url.search` is covered by the `trimmed` test above via
      // URL_CREDENTIAL_QUERY_RE, but a fragment (`#access_token=...`, the
      // OAuth2 implicit-flow shape) is not: its param never has a leading
      // `?`/`&` to match on, since it starts right after `#` (Critical
      // finding, #943 review). Re-run the same credential-param test against
      // the fragment with a synthesized `?` so the fragment's first param
      // matches the same way a query string's first param does.
      if (url.hash.length > 1 && URL_CREDENTIAL_QUERY_RE.test(`?${url.hash.slice(1)}`)) return true;
      return hasOpaqueUrlPathSegment(url.pathname);
    } catch {
      return false;
    }
  }
  if (OPAQUE_VALUE_SCHEME_PREFIX_RE.test(trimmed)) return true;
  const withoutScheme = trimmed.replace(OPAQUE_VALUE_SCHEME_PREFIX_RE, "");
  if (withoutScheme.length === 0) return false;
  if (KNOWN_SECRET_PREFIX_RE.test(withoutScheme)) return true;
  if (JWT_LIKE_VALUE_RE.test(withoutScheme)) return true;
  if (/\s/.test(withoutScheme)) return false;
  if (withoutScheme.length < MIN_OPAQUE_TOKEN_LENGTH) return false;
  // Same over-redaction as the URL path-segment case, one level up: a
  // whitespace-free length-20+ *status slug* (`pending_human_merge_review`)
  // is exactly as common under a Tier-2 collision key as a real opaque
  // token, and the length backstop alone can't tell them apart. Confirmed
  // live on a currently-pending card, not hypothetical: an
  // `authoritative_state` field (Tier 2 — "auth" is a substring of
  // "authoritative", the same collision class as "author") got blanked by
  // this exact branch post-#943-merge. Reuse the same
  // dictionary-word-shaped-parts exemption already applied to URL path
  // segments.
  return !looksLikeReadableSlug(withoutScheme);
}

/**
 * Applies key-based redaction to a value already known to sit under a
 * secret-ish-named key, without assuming the value is a bare string —
 * recurses into arrays *and* objects so a name collision on the parent key
 * (e.g. `ask_2_author_identity`, `links.PR_1898_app_authored`) doesn't
 * destroy structured or non-opaque content nested beneath it, and so a
 * genuinely secret parent (e.g. `authorization: { value, current }`) keeps
 * every descendant leaf covered by *at least* the parent's tier — a neutral
 * child key doesn't downgrade it — while a child key that independently
 * classifies as a *stronger* tier than the parent (e.g. `password` under the
 * ambiguous `authorInfo`) is redacted unconditionally rather than inheriting
 * the parent's weaker narrow-value-test tier (BLO-20810 / #943 review
 * Critical 2 — the object branch used to delegate to `sanitizeRecord`, which
 * re-tested each child key from scratch and silently dropped the parent's
 * sensitivity in the other direction; the array branch never had that bug,
 * so array and object must take the same path here).
 *
 * `tier === 1` mirrors the unconditional Tier-1 key match: every string leaf
 * is redacted regardless of shape. `tier === 2` applies the narrow
 * credential test (`looksLikeCredentialValue`) at every leaf, unless a child
 * key itself resolves to Tier 1.
 */
function sanitizeSecretMatchedValue(value: unknown, options: SanitizeOptions | undefined, tier: 1 | 2): unknown {
  if (isSecretRefBinding(value) || isUserSecretRefBinding(value)) {
    return sanitizeValue(value, options);
  }
  if (isPlainBinding(value)) {
    return { type: "plain", value: REDACTED_EVENT_VALUE };
  }
  if (typeof value === "string") {
    if (tier === 1) return REDACTED_EVENT_VALUE;
    return looksLikeCredentialValue(value) ? REDACTED_EVENT_VALUE : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeSecretMatchedValue(entry, options, tier));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // A child key's own classification only ever strengthens the
      // inherited tier (min(1, 2) = 1), never weakens it — a neutral child
      // (`value`, `current`) keeps the parent's tier, exactly as before.
      const childTier = classifyKeyTier(k);
      const effectiveTier = childTier !== null && childTier < tier ? childTier : tier;
      out[k] = sanitizeSecretMatchedValue(v, options, effectiveTier);
    }
    return out;
  }
  return value;
}

export function sanitizeRecord(record: Record<string, unknown>, options?: SanitizeOptions): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (options?.agentConfig && key === "env") {
      redacted[key] = isPlainObject(value) ? sanitizeAgentEnvRecord(value) : REDACTED_EVENT_VALUE;
      continue;
    }
    if (options?.agentConfig && key === "headers") {
      redacted[key] = isPlainObject(value) ? sanitizeAgentHeaderRecord(value, options) : REDACTED_EVENT_VALUE;
      continue;
    }
    const argsLikeKey =
      COMMAND_ARGS_PAYLOAD_KEY_RE.test(key)
      || (options?.agentConfig === true && AGENT_CONFIG_ARGS_KEY_RE.test(key));
    if (argsLikeKey && Array.isArray(value)) {
      redacted[key] = sanitizeCommandArgs(value, options);
      continue;
    }
    if (COMMAND_PAYLOAD_KEY_RE.test(key) && typeof value === "string") {
      redacted[key] = redactSensitiveText(value);
      continue;
    }
    const keyTier = classifyKeyTier(key);
    if (keyTier !== null) {
      redacted[key] = sanitizeSecretMatchedValue(value, options, keyTier);
      continue;
    }
    if (typeof value === "string" && JWT_VALUE_RE.test(value)) {
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    redacted[key] = sanitizeValue(value, options);
  }
  return redacted;
}

export function redactEventPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return null;
  if (!isPlainObject(payload)) return payload;
  return sanitizeRecord(payload);
}

/**
 * Stricter sibling of {@link redactEventPayload} for anything that embeds an
 * agent configuration: `adapterConfig`, `runtimeConfig`, a config-revision
 * snapshot, or a hire-approval payload.
 *
 * `redactEventPayload` decides what to mask from the key's *name*, which is the
 * wrong test here. A `{type:"plain",value}` binding in an agent config is
 * credential material by construction, so an ordinary-looking key kept its
 * plaintext on the wire — `runtimeConfig.modelProfiles.*.adapterConfig.env`
 * entries such as `SIGNING_MATERIAL`, or a bare `FOO`, were echoed verbatim
 * (BLO-18969).
 *
 * Two structural rules, applied at any depth, on top of the generic ones:
 *  - every `{type:"plain",value}` binding is masked;
 *  - every value of an `env` map is masked, covering the legacy bare-string
 *    form that `envBindingSchema` still accepts.
 *
 * `secret_ref` / `user_secret_ref` bindings stay readable — they are pointers —
 * but lose any resolved `value`.
 */
export function redactAgentConfigPayload(payload: unknown): Record<string, unknown> | null {
  if (!payload) return null;
  if (!isPlainObject(payload)) return payload as Record<string, unknown> | null;
  return sanitizeRecord(payload, { agentConfig: true });
}

export function redactApprovalPayloadByType(type: unknown, payload: unknown): Record<string, unknown> {
  if (!payload || !isPlainObject(payload)) return {};
  if (type === "hire_agent") return redactAgentConfigPayload(payload) ?? {};
  return redactEventPayload(payload) ?? {};
}

const WITHHELD_AGENT_CONFIG_KEYS = new Set(["adapterConfig", "runtimeConfig"]);

/**
 * Authorization filter for the approval read paths. Distinct in kind from the
 * redactors above: those decide what is *secret*, this decides what the caller
 * is *entitled to*.
 *
 * A `hire_agent` payload embeds the hire's `adapterConfig` / `runtimeConfig`.
 * `redactAgentConfigPayload` masks the credential values inside them but
 * deliberately keeps the config diagnosable, so the scheme, principal, host,
 * port and path of every `mcpServers.*.url` survive. That residue is the
 * agent's MCP upstream topology — which upstream a peer is pointed at and under
 * which principal — and `GET /agents/:id` only hands it to a caller holding
 * `agent_config:read` (`redactForRestrictedAgentView`). The approval card
 * reaches the same material under `company_scope:read`, which every
 * same-company agent is auto-allowed, so the weaker sibling path disclosed a
 * reconnaissance surface the gated one withheld (PEN-2777).
 *
 * Applied at any depth and to any shape: the payload already carries the pair
 * twice (`requestedConfigurationSnapshot.adapterConfig`), and a new copy — or a
 * caller-chosen shape under the same key — would otherwise reopen the hole
 * silently.
 *
 * Blanked to `{}` rather than `REDACTED_EVENT_VALUE` to match
 * `redactForRestrictedAgentView`'s restricted-agent shape, and to keep that
 * sentinel meaning "a scanner blanked this" rather than "you may not see this".
 *
 * Read projection only — the stored snapshot `activatePendingApproval` replays
 * over the agent row is untouched.
 */
export function withholdAgentConfigFromApprovalPayload(
  type: unknown,
  payload: Record<string, unknown>,
): { payload: Record<string, unknown>; withheldFields: string[] } {
  if (type !== "hire_agent" || !isPlainObject(payload)) return { payload, withheldFields: [] };
  return withholdAgentConfigKeys(payload);
}

/**
 * The entitlement filter itself, with no payload-type precondition, so every
 * read projection that reaches an agent's config pair under a weaker
 * entitlement than `agent_config:read` can share one implementation.
 *
 * Extracted from `withholdAgentConfigFromApprovalPayload` rather than copied.
 * This class propagates by copying: each of doors #7-#10 was the same
 * disclosure re-derived on a path whose author could not see the others, and
 * the array bypass Ally caught in #1574 is exactly the sort of correction a
 * second copy silently misses. One walk means a finding against it lands
 * everywhere at once.
 *
 * Callers, all reaching the pair under `company_scope:read`:
 * - `hire_agent` approval cards (PEN-2777)
 * - skill test-run `agentConfigSnapshot` (PEN-2839) — which additionally
 *   persisted the pair unredacted, so this read projection is what repairs
 *   rows already written.
 *
 * Read projection only: nothing here rewrites a stored row.
 */
export function withholdAgentConfigKeys(
  payload: Record<string, unknown>,
): { payload: Record<string, unknown>; withheldFields: string[] } {
  if (!isPlainObject(payload)) return { payload, withheldFields: [] };
  const withheldFields: string[] = [];

  function walk(value: unknown, path: string): unknown {
    if (Array.isArray(value)) return value.map((entry, index) => walk(entry, `${path}[${index}]`));
    if (!isPlainObject(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      // Entitlement cannot depend on shape. Every path that builds a hire card
      // server-side writes an object here, but `approvalPayloadSchema` is a
      // `.catchall(z.unknown())`, so `POST /companies/:companyId/approvals` and
      // the resubmit route persist whatever the filer sent, and
      // `normalizeHireApprovalPayloadForPersistence` passes a non-record through
      // untouched. An array of configs or a JSON-encoded string carries exactly
      // the topology this gate withholds, so an object-only test would let the
      // shape pick the authorization outcome. `null`/`undefined` stay readable:
      // they carry no topology and are the honest "no config was requested" the
      // board queue renders.
      if (WITHHELD_AGENT_CONFIG_KEYS.has(key) && entry !== null && entry !== undefined) {
        withheldFields.push(childPath);
        out[key] = {};
        continue;
      }
      out[key] = walk(entry, childPath);
    }
    return out;
  }

  return { payload: walk(payload, "") as Record<string, unknown>, withheldFields };
}

/**
 * Approval payloads are a human-facing escalation channel (BLO-20810), so a
 * field the scanner actually blanked must read differently from one the
 * filer simply left empty — a bare `***REDACTED***` is ambiguous on its own.
 * This walks the already-redacted output next to the untouched original —
 * never round-tripped back into approval decisions, see `services/approvals.ts`
 * `approve()`, which reads the raw DB row rather than this display payload —
 * and swaps each genuinely-scrubbed leaf for a message naming the field,
 * while also returning the list of paths so the filer can restate them in a
 * comment (comment bodies aren't scanned).
 *
 * Scoped to the generic, key-name-triggered redaction path only. `hire_agent`
 * goes through `redactAgentConfigPayload`'s unconditional structural rules
 * (BLO-18969: every `env` value and `plain` binding is credential material by
 * construction, not a name-collision false positive) and keeps the bare
 * sentinel — other code treats that exact string as a contract, e.g. the
 * `agents-pending-approval-config` test suite and the persistence guard in
 * `secrets.ts`.
 */
export function redactApprovalPayloadForDisplay(
  type: unknown,
  payload: unknown,
): { payload: Record<string, unknown>; redactedFields: string[] } {
  const redacted = redactApprovalPayloadByType(type, payload);
  if (type === "hire_agent") return { payload: redacted, redactedFields: [] };

  const redactedFields: string[] = [];
  const original = isPlainObject(payload) ? payload : {};

  function annotate(originalValue: unknown, redactedValue: unknown, path: string): unknown {
    if (redactedValue === REDACTED_EVENT_VALUE && originalValue !== REDACTED_EVENT_VALUE) {
      redactedFields.push(path);
      return `[redacted by secret scanner: ${path}]`;
    }
    if (Array.isArray(redactedValue) && Array.isArray(originalValue)) {
      return redactedValue.map((entry, i) => annotate(originalValue[i], entry, `${path}[${i}]`));
    }
    if (isPlainObject(redactedValue) && isPlainObject(originalValue)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(redactedValue)) {
        out[k] = annotate(originalValue[k], redactedValue[k], path ? `${path}.${k}` : k);
      }
      return out;
    }
    return redactedValue;
  }

  const displayPayload = annotate(original, redacted, "") as Record<string, unknown>;
  return { payload: displayPayload, redactedFields };
}

export function redactSensitiveText(input: string): string {
  if (!maybeContainsSecretText(input)) return input;
  const envRedacted = input
    .replace(ENV_DUMP_SECRET_ASSIGNMENT_RE, (_match, boundary, prefix, value) => {
      const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : "";
      return `${boundary}${prefix}${quote}${REDACTED_EVENT_VALUE}${quote}`;
    })
    .replaceAll("\0", "\n");
  return redactCommandText(
    envRedacted
      .replace(JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`)
      .replace(ESCAPED_JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`)
      .replace(URI_CREDENTIAL_RE, `$1$2:${REDACTED_EVENT_VALUE}@`),
    REDACTED_EVENT_VALUE,
  );
}

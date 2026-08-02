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
  String.raw`api[-_]?key|access[-_]?token|auth(?:orization|[-_]?token)|bearer|token|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring`;

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
 * (`author`, `no_secrets_in_payload`), but as a *whole token* in a short key
 * they're never that collision — `secret`, `client_secret`, `webhook_secret`,
 * `auth` are ordinary credential field names, not prose. Promote those to
 * Tier 1 so a short value under them (`{ secret: "hunter2" }`) doesn't fall
 * through `looksLikeCredentialValue`'s length/shape gate (BLO-20810 residual
 * finding, #943 review). `author`/`authors` keep Tier 2 because "auth" isn't
 * a whole token in them; `base_url` is excluded on purpose — it is two
 * tokens but never itself a credential value.
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
  return tokens.length > 0 && tokens.length <= 2 && tokens.some((token) => AMBIGUOUS_PROMOTABLE_TOKENS.has(token));
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
  return SECRET_TEXT_HINTS.some((hint) => lower.includes(hint)) || input.includes(".");
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
const URL_CREDENTIAL_QUERY_RE = /[?&](?:token|sig|signature|api[-_]?key|access[-_]?token|auth|x-amz-signature)=/i;
const KNOWN_SECRET_PREFIX_RE = /^(?:sk-|sk_live_|pk_live_|ghp_|gho_|ghu_|ghs_|ghr_|xox[baprs]-|AKIA|glpat-|gsk_)/i;
const JWT_LIKE_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MIN_OPAQUE_TOKEN_LENGTH = 20;

/**
 * Tier 2's value gate (BLO-20810 / CEO design constraint on #943 review). This
 * is a *positive* credential test, not a benign-shape allowlist — the earlier
 * version of this function ("does it look like prose?") let real credentials
 * through whenever they happened to contain whitespace (a spaced passphrase)
 * or a scheme (a presigned/webhook URL, a Postgres DSN), because those are
 * properties real credentials can have too. Classify the *value* as
 * credential-shaped by matching known secret prefixes, JWT shape, PEM
 * blocks, URL userinfo/credential query params, or (as a backstop for
 * unrecognized formats) a long single opaque token — rather than inferring
 * "not a credential" from the absence of those properties.
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
    return URL_USERINFO_RE.test(trimmed) || URL_CREDENTIAL_QUERY_RE.test(trimmed);
  }
  if (OPAQUE_VALUE_SCHEME_PREFIX_RE.test(trimmed)) return true;
  const withoutScheme = trimmed.replace(OPAQUE_VALUE_SCHEME_PREFIX_RE, "");
  if (withoutScheme.length === 0) return false;
  if (KNOWN_SECRET_PREFIX_RE.test(withoutScheme)) return true;
  if (JWT_LIKE_VALUE_RE.test(withoutScheme)) return true;
  if (/\s/.test(withoutScheme)) return false;
  return withoutScheme.length >= MIN_OPAQUE_TOKEN_LENGTH;
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
    if (COMMAND_ARGS_PAYLOAD_KEY_RE.test(key) && Array.isArray(value)) {
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
      .replace(ESCAPED_JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`),
    REDACTED_EVENT_VALUE,
  );
}

import { redactCommandText } from "@paperclipai/adapter-utils";

const SECRET_FIELD_NAME_PATTERN =
  String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring|base[-_]?url)[A-Za-z0-9_-]*`;

const SECRET_PAYLOAD_KEY_RE = new RegExp(SECRET_FIELD_NAME_PATTERN, "i");
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

/**
 * `agentConfig` switches on the structural rules described on
 * {@link redactAgentConfigPayload}. Off (the default) keeps the generic
 * key-name behaviour every other event payload relies on.
 */
type SanitizeOptions = { agentConfig?: boolean };

/**
 * A `secret_ref` / `user_secret_ref` binding is a pointer, and neither
 * `envBindingSecretRefSchema` nor `envBindingUserSecretRefSchema` has a `value`
 * field. So a `value` on one only ever means a resolved plaintext secret rode
 * along, whatever its `projectionClass` claims — drop it (BLO-18969 AC3).
 */
function stripResolvedSecretValue(binding: Record<string, unknown>): Record<string, unknown> {
  if (!("value" in binding)) return binding;
  const { value: _resolved, ...pointer } = binding;
  return pointer;
}

function sanitizeValue(value: unknown, options?: SanitizeOptions): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, options));
  if (isSecretRefBinding(value) || isUserSecretRefBinding(value)) {
    return options?.agentConfig ? stripResolvedSecretValue(value) : value;
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
 * mask the value and keep the shape: a binding stays a binding (the UI renders
 * it, and the write path restores it on round-trip), a legacy bare string —
 * still accepted by `envBindingSchema` — becomes the sentinel string.
 */
function sanitizeAgentEnvRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isSecretRefBinding(value) || isUserSecretRefBinding(value)) {
      redacted[key] = stripResolvedSecretValue(value);
      continue;
    }
    if (isPlainBinding(value)) {
      redacted[key] = { type: "plain", value: REDACTED_EVENT_VALUE };
      continue;
    }
    redacted[key] = typeof value === "string" ? REDACTED_EVENT_VALUE : sanitizeValue(value, { agentConfig: true });
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

function sanitizeCommandArgs(args: unknown[]): unknown[] {
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED_EVENT_VALUE;
    }
    if (typeof arg !== "string") return sanitizeValue(arg);
    if (CLI_SECRET_FLAG_RE.test(arg.trim())) {
      redactNext = true;
      return arg;
    }
    return redactSensitiveText(arg);
  });
}

export function sanitizeRecord(record: Record<string, unknown>, options?: SanitizeOptions): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (options?.agentConfig && key === "env" && isPlainObject(value)) {
      redacted[key] = sanitizeAgentEnvRecord(value);
      continue;
    }
    if (COMMAND_ARGS_PAYLOAD_KEY_RE.test(key) && Array.isArray(value)) {
      redacted[key] = sanitizeCommandArgs(value);
      continue;
    }
    if (COMMAND_PAYLOAD_KEY_RE.test(key) && typeof value === "string") {
      redacted[key] = redactSensitiveText(value);
      continue;
    }
    if (SECRET_PAYLOAD_KEY_RE.test(key)) {
      if (isSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value, options);
        continue;
      }
      if (isUserSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value, options);
        continue;
      }
      if (isPlainBinding(value)) {
        redacted[key] = { type: "plain", value: REDACTED_EVENT_VALUE };
        continue;
      }
      redacted[key] = REDACTED_EVENT_VALUE;
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

/**
 * @fileoverview Masks secret-bearing plugin instance-config values on the way
 * out of the operator-facing config API, and restores them on the way back in.
 *
 * `plugin_config.config_json` routinely holds live credentials — either as a
 * `secret_ref` pointer or, while the secret-ref path is unusable (BLO-20219),
 * as a raw inline string. `GET /api/plugins/:pluginId/config` used to return
 * that row verbatim (BLO-20794), so every reader of the config API received the
 * plaintext.
 *
 * Two operations make up the contract:
 *
 * - {@link maskPluginConfigJson} replaces secret-bearing plaintext with
 *   {@link PLUGIN_CONFIG_SECRET_MASK}. Secret *pointers* are preserved (reduced
 *   to their schema-owned fields) because a pointer carries no plaintext and the
 *   config form needs it to keep rendering the binding.
 * - {@link mergeMaskedPluginConfig} takes a posted config and restores the
 *   stored value anywhere the caller echoed the mask back unchanged. This makes
 *   a masked read → unmodified write round-trip lossless, and guarantees the
 *   sentinel itself is never persisted over a real secret.
 *
 * Masking happens at the route boundary only. Internal consumers — the worker
 * bridge, bootstrap, host services — keep reading `registry.getConfig()`
 * directly and still receive plaintext, which is what makes the plugin work.
 *
 * @module server/services/plugin-config-masking
 */

import { envBindingSecretRefSchema, envBindingUserSecretRefSchema } from "@paperclipai/shared";
import { isUuidSecretRef } from "./json-schema-secret-refs.js";

/**
 * Sentinel returned in place of a secret-bearing value. Chosen to be visually
 * obvious in the config form and impossible to confuse with a real credential.
 *
 * A posted value equal to this sentinel is always treated as "unchanged" and is
 * never written to storage — see {@link mergeMaskedPluginConfig}.
 */
export const PLUGIN_CONFIG_SECRET_MASK = "__redacted__";

/**
 * Word tokens that make a field credential-bearing on their own.
 *
 * This heuristic exists because a manifest cannot be assumed correct: the field
 * that prompted BLO-20794 (`webhookToken`) is declared `type: "string"` with no
 * secret marker at all, and plugins may write keys that appear in no schema.
 * Manifest authors who own a matching field that is genuinely not a secret can
 * opt out with `x-paperclip-secret: false`.
 *
 * Deliberately narrower than the log-redaction heuristic in `redaction.ts`:
 * over-masking is free in a log line, but here it would put the sentinel in
 * front of an operator editing real configuration. In particular `baseUrl` and
 * a bare `key` are *not* matched.
 */
const SECRET_WORDS = new Set([
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwords",
  "passwd",
  "passphrase",
  "credential",
  "credentials",
  "bearer",
  "authorization",
  "jwt",
]);

/** Two-word combinations that are credential-bearing only together. */
const SECRET_WORD_PAIRS = new Set([
  "api key",
  "access key",
  "private key",
  "signing key",
  "secret key",
  "encryption key",
  "client key",
  "consumer key",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Split a config key into lowercase words, handling camelCase, snake_case and
 * kebab-case alike — `webhookToken`, `webhook_token` and `WEBHOOK-TOKEN` all
 * yield `["webhook", "token"]`.
 */
function splitKeyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function matchesSecretFieldName(key: string): boolean {
  const words = splitKeyWords(key);
  if (words.some((word) => SECRET_WORDS.has(word))) return true;
  for (let index = 0; index < words.length - 1; index += 1) {
    if (SECRET_WORD_PAIRS.has(`${words[index]} ${words[index + 1]}`)) return true;
  }
  return false;
}

/**
 * A `secret_ref` / `user_secret_ref` binding is a pointer, not a secret. Keep
 * only its schema-owned fields so a stray `value` — resolved plaintext riding
 * along with the pointer — cannot survive the mask.
 *
 * Returns `null` when the object is not a well-formed pointer, in which case
 * the caller must treat it as opaque and mask it.
 */
function sanitizeSecretPointer(value: Record<string, unknown>): Record<string, unknown> | null {
  const asSecretRef = envBindingSecretRefSchema.safeParse(value);
  if (asSecretRef.success) {
    const data = asSecretRef.data;
    const pointer: Record<string, unknown> = { type: data.type, secretId: data.secretId };
    for (const key of ["version", "projectionClass", "projectionAllowlistKey"] as const) {
      if (key in value && data[key] !== undefined) pointer[key] = data[key];
    }
    return pointer;
  }

  const asUserSecretRef = envBindingUserSecretRefSchema.safeParse(value);
  if (asUserSecretRef.success) {
    const data = asUserSecretRef.data;
    const pointer: Record<string, unknown> = { type: data.type, key: data.key };
    for (const key of ["version", "required", "allowMissingOverride"] as const) {
      if (key in value && data[key] !== undefined) pointer[key] = data[key];
    }
    return pointer;
  }

  return null;
}

function isSecretPointerCandidate(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && (value.type === "secret_ref" || value.type === "user_secret_ref");
}

/**
 * Whether a schema node declares its value secret-bearing.
 *
 * Three markers are honoured, so a plain string field can be covered without
 * being converted to the (currently unusable) `secret-ref` path:
 *
 * - `format: "secret-ref"` — the existing pointer-valued declaration.
 * - `writeOnly: true` — the standard JSON Schema / OpenAPI keyword meaning
 *   "may be sent by the client, must not be returned in responses".
 * - `x-paperclip-secret: true` — explicit Paperclip marker for authors who do
 *   not want `writeOnly`'s other UI implications.
 */
function declaresSecret(node: Record<string, unknown>): boolean {
  return (
    node.format === "secret-ref" ||
    node.writeOnly === true ||
    node["x-paperclip-secret"] === true
  );
}

export interface PluginConfigSecretPaths {
  /** Dot-paths the manifest declares secret-bearing. */
  secret: Set<string>;
  /** Dot-paths the manifest explicitly declares NOT secret (`x-paperclip-secret: false`). */
  exempt: Set<string>;
}

/**
 * Collect the dot-paths a manifest marks secret-bearing (and those it
 * explicitly exempts), following `properties` plus the `allOf` / `anyOf` /
 * `oneOf` composition keywords — same traversal shape as
 * `collectSecretRefPaths`, widened to the markers in {@link declaresSecret}.
 */
export function collectSecretBearingPaths(
  schema: Record<string, unknown> | null | undefined,
): PluginConfigSecretPaths {
  const secret = new Set<string>();
  const exempt = new Set<string>();
  if (!schema || typeof schema !== "object") return { secret, exempt };

  function walk(node: Record<string, unknown>, prefix: string): void {
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        if (!isPlainRecord(branch)) continue;
        walk(branch, prefix);
      }
    }

    const properties = node.properties;
    if (!isPlainRecord(properties)) return;
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!isPlainRecord(propertySchema)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (declaresSecret(propertySchema)) {
        secret.add(path);
      } else if (propertySchema["x-paperclip-secret"] === false) {
        exempt.add(path);
      }
      walk(propertySchema, path);
    }
  }

  walk(schema, "");
  return { secret, exempt };
}

/**
 * Return a copy of `configJson` with every secret-bearing value replaced by
 * {@link PLUGIN_CONFIG_SECRET_MASK}.
 *
 * A value is secret-bearing when the manifest declares it (see
 * {@link declaresSecret}) or when its key name matches {@link SECRET_WORDS} /
 * {@link SECRET_WORD_PAIRS} and the manifest has not exempted it.
 *
 * Secret pointers are preserved rather than masked — they name a secret without
 * disclosing it, and dropping them would break the config form's binding
 * picker. Any non-pointer value at a declared-secret path is masked whatever its
 * type, so an unexpected shape cannot leak through.
 *
 * A *declared* secret is masked wholesale, because the author said so
 * explicitly. A field the heuristic merely suspects is treated more gently: its
 * structure survives and only the string leaves beneath it are masked, so
 * `credentials: { user, pass }` keeps its shape while `pass` is covered.
 */
export function maskPluginConfigJson(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): unknown {
  if (!isPlainRecord(configJson)) return configJson;
  const { secret, exempt } = collectSecretBearingPaths(schema);

  function maskRecord(
    record: Record<string, unknown>,
    prefix: string,
    inSecretContainer: boolean,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      const path = prefix ? `${prefix}.${key}` : key;
      result[key] = maskValue(key, value, path, inSecretContainer);
    }
    return result;
  }

  function maskValue(
    key: string,
    value: unknown,
    path: string,
    inSecretContainer: boolean,
  ): unknown {
    // A pointer names a secret without disclosing it — keep it, minus baggage.
    if (isSecretPointerCandidate(value)) {
      return sanitizeSecretPointer(value) ?? PLUGIN_CONFIG_SECRET_MASK;
    }

    if (secret.has(path)) {
      // A bare UUID at a declared-secret path is a legacy binding (see
      // `coerceLegacySecretRef`), i.e. a pointer, not a credential.
      if (typeof value === "string" && isUuidSecretRef(value)) return value;
      if (value === null || value === undefined) return value;
      return PLUGIN_CONFIG_SECRET_MASK;
    }

    // An explicit `x-paperclip-secret: false` wins over the heuristic, and over
    // a suspicious ancestor.
    const suspect = exempt.has(path)
      ? false
      : inSecretContainer || matchesSecretFieldName(key);

    if (isPlainRecord(value)) return maskRecord(value, path, suspect);

    if (Array.isArray(value)) {
      return value.map((entry, index) => {
        if (isPlainRecord(entry)) return maskRecord(entry, `${path}.${index}`, suspect);
        if (suspect && typeof entry === "string" && entry.length > 0) {
          return PLUGIN_CONFIG_SECRET_MASK;
        }
        return entry;
      });
    }

    if (suspect && typeof value === "string" && value.length > 0) {
      return PLUGIN_CONFIG_SECRET_MASK;
    }

    return value;
  }

  return maskRecord(configJson, "", false);
}

/**
 * Restore stored values anywhere the caller posted back
 * {@link PLUGIN_CONFIG_SECRET_MASK} unchanged, so a masked read followed by an
 * unmodified write does not clobber the stored secret.
 *
 * The sentinel is stripped at every path, not only declared-secret ones: it can
 * only have come from a masked read, and persisting the literal string is never
 * the caller's intent. When storage holds nothing at that path the key is
 * dropped rather than written, so the sentinel never reaches the database.
 *
 * Callers that supply a genuinely new value overwrite the stored secret as
 * before — only the exact sentinel is treated as "unchanged".
 */
export function mergeMaskedPluginConfig(
  incomingConfig: Record<string, unknown>,
  storedConfig: unknown,
): Record<string, unknown> {
  const stored = isPlainRecord(storedConfig) ? storedConfig : {};

  function mergeRecord(
    incoming: Record<string, unknown>,
    storedNode: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(incoming)) {
      const storedValue = storedNode[key];

      if (value === PLUGIN_CONFIG_SECRET_MASK) {
        // Nothing stored to restore — drop the key rather than persist the mask.
        if (storedValue === undefined) continue;
        result[key] = storedValue;
        continue;
      }

      if (isPlainRecord(value)) {
        result[key] = mergeRecord(value, isPlainRecord(storedValue) ? storedValue : {});
        continue;
      }

      if (Array.isArray(value)) {
        const storedArray = Array.isArray(storedValue) ? storedValue : [];
        result[key] = value
          .map((entry, index) => {
            const storedEntry = storedArray[index];
            if (entry === PLUGIN_CONFIG_SECRET_MASK) return storedEntry;
            if (isPlainRecord(entry)) {
              return mergeRecord(entry, isPlainRecord(storedEntry) ? storedEntry : {});
            }
            return entry;
          })
          .filter((entry) => entry !== undefined);
        continue;
      }

      result[key] = value;
    }
    return result;
  }

  return mergeRecord(incomingConfig, stored);
}

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

type SchemaNode = Record<string, unknown>;

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
function collectDiscardedPointerStringLeaves(
  value: Record<string, unknown>,
  preservedKeys: readonly string[],
  collector?: Set<string>,
): void {
  if (!collector) return;
  for (const [key, child] of Object.entries(value)) {
    if (!preservedKeys.includes(key)) collectStringLeaves(child, collector);
  }
}

function sanitizeSecretPointer(
  value: Record<string, unknown>,
  collector?: Set<string>,
): Record<string, unknown> | null {
  const asSecretRef = envBindingSecretRefSchema.safeParse(value);
  if (asSecretRef.success) {
    const data = asSecretRef.data;
    const pointer: Record<string, unknown> = { type: data.type, secretId: data.secretId };
    for (const key of ["version", "projectionClass", "projectionAllowlistKey"] as const) {
      if (key in value && data[key] !== undefined) pointer[key] = data[key];
    }
    collectDiscardedPointerStringLeaves(
      value,
      ["type", "secretId", "version", "projectionClass", "projectionAllowlistKey"],
      collector,
    );
    return pointer;
  }

  const asUserSecretRef = envBindingUserSecretRefSchema.safeParse(value);
  if (asUserSecretRef.success) {
    const data = asUserSecretRef.data;
    const pointer: Record<string, unknown> = { type: data.type, key: data.key };
    for (const key of ["version", "required", "allowMissingOverride"] as const) {
      if (key in value && data[key] !== undefined) pointer[key] = data[key];
    }
    collectDiscardedPointerStringLeaves(
      value,
      ["type", "key", "version", "required", "allowMissingOverride"],
      collector,
    );
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
function declaresSecret(node: SchemaNode): boolean {
  return (
    node.format === "secret-ref" || node.writeOnly === true || node["x-paperclip-secret"] === true
  );
}

/**
 * A node injected in place of a `$ref` that could not be resolved.
 *
 * Masking is fail-closed: an unresolvable reference means we cannot prove the
 * target is *not* secret, so we treat it as secret rather than emit plaintext.
 * This covers external refs (`https://…`, `other.json#/…`), refs into a missing
 * `$defs` entry, and reference cycles.
 */
const UNRESOLVED_REF_NODE: SchemaNode = Object.freeze({ "x-paperclip-secret": true });

/**
 * Resolve a local JSON-Pointer `$ref` (`#/$defs/credential`) against the root
 * schema. Returns `null` for anything non-local or unresolvable, which the
 * caller turns into {@link UNRESOLVED_REF_NODE}.
 */
function resolveLocalRef(ref: string, root: SchemaNode | null): SchemaNode | null {
  if (!root || ref === "#") return ref === "#" ? root : null;
  if (!ref.startsWith("#/")) return null; // external / non-pointer — fail closed

  let current: unknown = root;
  for (const rawToken of ref.slice(2).split("/")) {
    // RFC 6901 escaping: ~1 is "/", ~0 is "~" (in that order).
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return null;
      current = current[index];
      continue;
    }
    if (!isPlainRecord(current) || !(token in current)) return null;
    current = current[token];
  }

  return isPlainRecord(current) ? current : null;
}

/**
 * Flatten a set of schema nodes through the composition keywords and local
 * `$ref` indirection, so a marker sitting on an `allOf` / `anyOf` / `oneOf`
 * *branch node itself*, or on a `$defs` entry a field points at, is seen rather
 * than only markers on that branch's `properties`.
 *
 * Applicability is deliberately not evaluated: a value covered by any branch of
 * a composition is treated as covered by all of them. Masking is fail-closed —
 * a field that is secret in only one `oneOf` branch must not be emitted in the
 * clear just because another branch would have permitted it.
 *
 * `$ref` targets are resolved against `root`. A ref that is external, dangling,
 * or cyclic contributes {@link UNRESOLVED_REF_NODE} instead, so an unreadable
 * declaration masks rather than leaks.
 */
function expandSchemaNodes(nodes: SchemaNode[], root: SchemaNode | null = null): SchemaNode[] {
  const expanded: SchemaNode[] = [];
  const seen = new Set<SchemaNode>();
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!isPlainRecord(node)) continue;
    if (seen.has(node)) continue; // cycle or diamond — already accounted for
    seen.add(node);
    expanded.push(node);

    const ref = node.$ref;
    if (typeof ref === "string") {
      const target = resolveLocalRef(ref, root);
      if (target === null) {
        expanded.push(UNRESOLVED_REF_NODE);
      } else if (seen.has(target)) {
        // A cycle reached this target already; its markers are in `expanded`.
      } else {
        stack.push(target);
      }
    }

    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        if (isPlainRecord(branch)) stack.push(branch);
      }
    }
  }

  return expanded;
}

/**
 * Schema nodes that govern `record[key]`, honouring `properties`,
 * `patternProperties` and `additionalProperties` (the last only when neither of
 * the former claims the key, matching JSON Schema evaluation order).
 */
function childNodesForKey(nodes: SchemaNode[], key: string): SchemaNode[] {
  const children: SchemaNode[] = [];

  for (const node of nodes) {
    let claimed = false;

    const properties = node.properties;
    if (isPlainRecord(properties) && key in properties) {
      claimed = true;
      const declared = properties[key];
      if (isPlainRecord(declared)) children.push(declared);
    }

    const patternProperties = node.patternProperties;
    if (isPlainRecord(patternProperties)) {
      for (const [pattern, subSchema] of Object.entries(patternProperties)) {
        let matcher: RegExp;
        try {
          matcher = new RegExp(pattern);
        } catch {
          continue; // A manifest with an invalid pattern must not break masking.
        }
        if (!matcher.test(key)) continue;
        claimed = true;
        if (isPlainRecord(subSchema)) children.push(subSchema);
      }
    }

    const additionalProperties = node.additionalProperties;
    if (!claimed && isPlainRecord(additionalProperties)) children.push(additionalProperties);
  }

  return children;
}

/**
 * Schema nodes that govern `array[index]`, honouring the 2020-12 `prefixItems`
 * + `items` pair as well as the draft-07 tuple form (`items` as an array with
 * `additionalItems` for the tail).
 */
function childNodesForIndex(nodes: SchemaNode[], index: number): SchemaNode[] {
  const children: SchemaNode[] = [];

  for (const node of nodes) {
    let claimedByTuple = false;

    const prefixItems = node.prefixItems;
    if (Array.isArray(prefixItems) && index < prefixItems.length) {
      claimedByTuple = true;
      if (isPlainRecord(prefixItems[index])) children.push(prefixItems[index]);
    }

    const items = node.items;
    if (Array.isArray(items)) {
      if (index < items.length) {
        claimedByTuple = true;
        if (isPlainRecord(items[index])) children.push(items[index]);
      } else if (isPlainRecord(node.additionalItems)) {
        children.push(node.additionalItems);
      }
    } else if (isPlainRecord(items) && !claimedByTuple) {
      children.push(items);
    }
  }

  return children;
}

function nodesDeclareSecret(nodes: SchemaNode[]): boolean {
  return nodes.some(declaresSecret);
}

/**
 * Whether the value at this path is declared *specifically* as a secret-ref
 * pointer, rather than merely secret-bearing.
 *
 * Only `format: "secret-ref"` gets the bare-UUID passthrough in
 * {@link maskPluginConfigJson}. A UUID sitting in a `writeOnly` /
 * `x-paperclip-secret` field is an ordinary credential that happens to be
 * UUID-shaped — plenty of providers issue UUID API keys — and returning it in
 * the clear would defeat the masking entirely. The legacy-binding coercion that
 * passthrough exists to serve is itself gated on `format === "secret-ref"`
 * (`json-schema-secret-refs.ts`), so widening it here buys nothing.
 */
function nodesDeclareSecretRef(nodes: SchemaNode[]): boolean {
  return nodes.some((node) => node.format === "secret-ref");
}

function nodesDeclareNotSecret(nodes: SchemaNode[]): boolean {
  return nodes.some((node) => node["x-paperclip-secret"] === false);
}

/**
 * Add every string *leaf* reachable beneath `value` to `collector`.
 *
 * Used when a declared secret is masked wholesale: the container is replaced by
 * a single sentinel, but each plaintext string it held must still be known to
 * {@link redactSecretValuesDeep} so worker diagnostics cannot reflect it back.
 *
 * Object *keys* are deliberately not collected. Collected values feed an
 * unbounded substring replacement (see {@link redactSecretValuesFromText}), and
 * keys are schema-authored field names: collecting `host` from
 * `{ host, password }` would rewrite "localhost" to "__redactedname" in every
 * subsequent diagnostic. A credential used as a map key is still masked in the
 * GET response — only the narrower diagnostic-reflection path is uncovered, and
 * that is the better trade against corrupting operator-facing error text.
 */
function collectStringLeaves(value: unknown, collector: Set<string>): void {
  if (typeof value === "string") {
    if (value.length > 0) collector.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStringLeaves(entry, collector);
    return;
  }
  if (isPlainRecord(value)) {
    for (const child of Object.values(value)) collectStringLeaves(child, collector);
  }
}

/**
 * Return a copy of `configJson` with every secret-bearing value replaced by
 * {@link PLUGIN_CONFIG_SECRET_MASK}.
 *
 * A value is secret-bearing when the manifest declares it (see
 * {@link declaresSecret}) or when its key name matches {@link SECRET_WORDS} /
 * {@link SECRET_WORD_PAIRS} and the manifest has not exempted it.
 *
 * The schema is walked in lockstep with the value rather than pre-flattened into
 * dot-paths, so declarations reachable only through `items`, `prefixItems`,
 * `patternProperties`, `additionalProperties` or a composition branch are
 * honoured at every depth.
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
  schema?: SchemaNode | null,
  collector?: Set<string>,
): unknown {
  if (!isPlainRecord(configJson)) return configJson;

  const root = isPlainRecord(schema) ? schema : null;

  /**
   * Record the plaintext being masked, for
   * {@link collectPluginConfigSecretValues}.
   *
   * A *declared* secret is masked wholesale, so when the value is an object or
   * array we must still record every string leaf beneath it. Recording only
   * direct string inputs would leave `{ password: "live" }` uncollected, and
   * "live" would then pass unredacted through the worker-diagnostic scrubbing in
   * `POST /config/test`. Keys are left alone — see {@link collectStringLeaves}.
   */
  function mask(value: unknown): string {
    if (collector) collectStringLeaves(value, collector);
    return PLUGIN_CONFIG_SECRET_MASK;
  }

  function maskNode(
    value: unknown,
    key: string | null,
    nodes: SchemaNode[],
    inheritedSuspect: boolean,
  ): unknown {
    // A pointer names a secret without disclosing it — keep it, minus baggage.
    if (isSecretPointerCandidate(value)) {
      return sanitizeSecretPointer(value, collector) ?? mask(value);
    }

    if (nodesDeclareSecret(nodes)) {
      // A bare UUID under `format: "secret-ref"` is a legacy binding (see
      // `coerceLegacySecretRef`), i.e. a pointer, not a credential. That
      // passthrough is deliberately NOT extended to `writeOnly` /
      // `x-paperclip-secret`, where a UUID is just a UUID-shaped credential.
      if (
        typeof value === "string" &&
        isUuidSecretRef(value) &&
        nodesDeclareSecretRef(nodes)
      ) {
        return value;
      }
      if (value === null || value === undefined) return value;
      return mask(value);
    }

    // An explicit `x-paperclip-secret: false` wins over the heuristic, and over
    // a suspicious ancestor.
    const suspect = nodesDeclareNotSecret(nodes)
      ? false
      : inheritedSuspect || (key !== null && matchesSecretFieldName(key));

    if (isPlainRecord(value)) {
      const result: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        result[childKey] = maskNode(
          childValue,
          childKey,
          expandSchemaNodes(childNodesForKey(nodes, childKey), root),
          suspect,
        );
      }
      return result;
    }

    // Arrays recurse through the same entry point, so a nested array under a
    // credential-shaped key (`tokens: [["live"]]`) is covered at any depth.
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        maskNode(entry, null, expandSchemaNodes(childNodesForIndex(nodes, index), root), suspect),
      );
    }

    if (suspect && typeof value === "string" && value.length > 0) {
      return mask(value);
    }

    return value;
  }

  return maskNode(configJson, null, expandSchemaNodes(root ? [root] : [], root), false);
}

/**
 * Every plaintext string {@link maskPluginConfigJson} would replace in this
 * config.
 *
 * Deliberately implemented by running the real masking walk and recording what
 * it covers, rather than by a parallel reimplementation: any future change to
 * what counts as secret is picked up here for free, and the two can never drift
 * into disagreeing about a given field.
 */
export function collectPluginConfigSecretValues(
  configJson: unknown,
  schema?: SchemaNode | null,
): string[] {
  const collected = new Set<string>();
  maskPluginConfigJson(configJson, schema, collected);
  return [...collected];
}

/**
 * Replace every occurrence of a known secret value in free-form text with
 * {@link PLUGIN_CONFIG_SECRET_MASK}.
 *
 * Plugin workers receive restored plaintext (that is what makes `validateConfig`
 * useful), and their warnings/errors are author-controlled strings that flow
 * straight back to the client. A worker that interpolates the credential into
 * its own diagnostic — `"401 rejected for token sk-live-…"` — would otherwise
 * hand the plaintext back through the very endpoint that masks it (BLO-20871).
 *
 * Longest-first so that a secret which is a substring of another is not left
 * partially exposed by an earlier replacement. No minimum length: over-redacting
 * a diagnostic is harmless, under-redacting one is the bug.
 */
export function redactSecretValuesFromText<T extends string | undefined>(
  text: T,
  secretValues: readonly string[],
): T {
  if (typeof text !== "string" || text.length === 0) return text;

  let result: string = text;
  for (const secret of orderedSecrets(secretValues)) {
    result = result.split(secret).join(PLUGIN_CONFIG_SECRET_MASK);
  }
  return result as T;
}

/** Non-empty secrets, longest first. See {@link redactSecretValuesFromText}. */
function orderedSecrets(secretValues: readonly string[]): string[] {
  return secretValues.filter(Boolean).sort((a, b) => b.length - a.length);
}

/**
 * Deep-redact known secret values from an arbitrary JSON-ish payload, rewriting
 * string leaves (and object keys, which a worker could equally interpolate a
 * credential into).
 *
 * This must NOT be done by stringifying the payload, replacing, and re-parsing:
 * `JSON.stringify` escapes quotes and backslashes, so a credential containing
 * either appears in the serialized text in escaped form and a raw-string
 * replacement silently misses it — leaking exactly the value it was meant to
 * remove. Walking the structure compares against the real string values.
 */
export function redactSecretValuesDeep<T>(value: T, secretValues: readonly string[]): T {
  const secrets = orderedSecrets(secretValues);
  if (secrets.length === 0) return value;

  function walk(node: unknown): unknown {
    if (typeof node === "string") return redactSecretValuesFromText(node, secrets);
    if (Array.isArray(node)) return node.map(walk);
    if (isPlainRecord(node)) {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        result[redactSecretValuesFromText(key, secrets)] = walk(child);
      }
      return result;
    }
    return node;
  }

  return walk(value) as T;
}

/** Marks a key whose posted sentinel resolved to nothing, so it is dropped. */
const DROP_KEY = Symbol("plugin-config-mask-drop");

/**
 * Manifest keyword designating the property that immutably identifies an array
 * entry, e.g. `items: { "x-paperclip-identity": "id", … }`.
 *
 * Declaring it is a promise that the named property is stable for the lifetime
 * of the entry. That promise is what makes it safe to re-home a stored
 * credential onto a re-ordered or edited entry; see
 * {@link mergeMaskedPluginConfig} for why nothing weaker will do.
 */
const IDENTITY_KEYWORD = "x-paperclip-identity";

export interface MergeMaskedPluginConfigResult {
  /** The posted config with sentinels resolved against storage. */
  configJson: Record<string, unknown>;
  /**
   * Dot-paths where a posted sentinel could not be matched to a stored value
   * with confidence. Callers MUST reject the write when this is non-empty —
   * see {@link mergeMaskedPluginConfig}.
   */
  unresolvedMaskPaths: string[];
}

function containsMask(value: unknown): boolean {
  if (value === PLUGIN_CONFIG_SECRET_MASK) return true;
  if (Array.isArray(value)) return value.some(containsMask);
  if (isPlainRecord(value)) return Object.values(value).some(containsMask);
  return false;
}

/**
 * A value usable as an array entry's identity: a non-empty scalar that is not
 * itself masked (a masked identity would match everything).
 */
function identityValue(entry: Record<string, unknown>, key: string): string | number | undefined {
  const value = entry[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0 && value !== PLUGIN_CONFIG_SECRET_MASK) {
    return value;
  }
  return undefined;
}

/**
 * The immutable identity property the manifest designates for entries of this
 * array, from `x-paperclip-identity` on the array node or on its `items` node.
 *
 * Nothing is inferred. An inferred identity was the original bug: any unique
 * scalar was accepted, including a mutable `name`, so renaming one entry to a
 * deleted entry's name re-homed that entry's credential.
 */
function designatedIdentityKey(nodes: SchemaNode[], root: SchemaNode | null): string | null {
  const candidates: SchemaNode[] = [...nodes];
  for (const node of nodes) {
    // `items` describes the entries, so authors naturally put it there.
    if (isPlainRecord(node.items)) candidates.push(...expandSchemaNodes([node.items], root));
  }
  for (const node of candidates) {
    const declared = node[IDENTITY_KEYWORD];
    if (typeof declared === "string" && declared.length > 0) return declared;
  }
  return null;
}

/**
 * Whether `incoming` is `stored` with secrets blanked out — every non-masked
 * position deep-equals storage, and every masked position has something stored
 * to restore.
 *
 * This is the evidence that a masked entry really is the stored entry re-posted
 * rather than a different entry that happens to sit at the same index. It is
 * deliberately exact, including key sets: an entry the operator edited no longer
 * proves correspondence, and must be treated as unresolved rather than guessed
 * at.
 */
function matchesIgnoringMask(incoming: unknown, stored: unknown): boolean {
  if (incoming === PLUGIN_CONFIG_SECRET_MASK) return stored !== undefined;

  if (Array.isArray(incoming)) {
    if (!Array.isArray(stored) || stored.length !== incoming.length) return false;
    return incoming.every((entry, index) => matchesIgnoringMask(entry, stored[index]));
  }

  if (isPlainRecord(incoming)) {
    if (!isPlainRecord(stored)) return false;
    const incomingKeys = Object.keys(incoming);
    if (incomingKeys.length !== Object.keys(stored).length) return false;
    return incomingKeys.every(
      (key) => key in stored && matchesIgnoringMask(incoming[key], stored[key]),
    );
  }

  return incoming === stored;
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
 *
 * **Array entries are never restored by inferred identity or by bare
 * position.** Both re-home live credentials:
 *
 * - *Inferred identity.* Accepting any unique scalar as an entry's identity
 *   includes mutable fields. With `[{name:"a",token:X},{name:"b",token:Y}]`
 *   stored, deleting `a` and renaming `b` to `a` posts one entry named `a` with
 *   a masked token — and `X`, the deleted entry's credential, is restored onto
 *   it.
 * - *Position.* Reordering `[["x",mask],["y",mask]]` swaps which endpoint each
 *   credential belongs to.
 *
 * So a masked entry is restored only on one of two proofs:
 *
 * 1. The manifest designates an immutable identity property via
 *    `x-paperclip-identity`, and exactly one stored entry carries that identity.
 *    Declaring it asserts the property never changes for a given entry, which is
 *    what makes reorder and edit safe.
 * 2. Failing that, the arrays are the same length and the entry at the same
 *    index is exactly this entry with its secrets blanked
 *    ({@link matchesIgnoringMask}). Anything else — a reorder, an insertion, a
 *    deletion, or an edit to a non-secret field — is not proof and is refused.
 *
 * Rule 2 means an operator editing a sibling field of a masked secret must
 * re-enter that secret. That is the deliberate cost of not guessing; a manifest
 * that declares `x-paperclip-identity` gets the ergonomic path back.
 *
 * Unproven entries are reported in
 * {@link MergeMaskedPluginConfigResult.unresolvedMaskPaths} and the operator
 * must re-enter the secret. Callers MUST reject a write whose result carries
 * unresolved paths; the sentinel is dropped from the returned config as well, so
 * an unchecked caller still cannot persist it.
 *
 * @param schema - The plugin's `instanceConfigSchema`, walked in lockstep so
 *   `x-paperclip-identity` is found at any depth. Omitting it costs only the
 *   designated-identity path; rule 2 still applies.
 */
export function mergeMaskedPluginConfig(
  incomingConfig: Record<string, unknown>,
  storedConfig: unknown,
  schema?: SchemaNode | null,
): MergeMaskedPluginConfigResult {
  const stored = isPlainRecord(storedConfig) ? storedConfig : {};
  const root = isPlainRecord(schema) ? schema : null;
  const unresolvedMaskPaths: string[] = [];
  /**
   * Set while draining an entry already reported unresolved. Its descendants
   * resolve against nothing (so the sentinel is still dropped) but must not be
   * reported again — one path per unresolvable entry, matching how record-shaped
   * entries already behave.
   */
  let suppressUnresolvedReporting = false;

  function reportUnresolved(path: string): void {
    if (!suppressUnresolvedReporting) unresolvedMaskPaths.push(path);
  }

  function mergeValue(
    incoming: unknown,
    storedValue: unknown,
    path: string,
    nodes: SchemaNode[],
  ): unknown {
    if (incoming === PLUGIN_CONFIG_SECRET_MASK) {
      // Nothing stored to restore — drop the key rather than persist the mask.
      if (storedValue === undefined) return DROP_KEY;
      return storedValue;
    }

    // Valid secret pointers are canonicalized before validation, persistence, or
    // worker RPC. This prevents a plaintext field riding alongside a pointer
    // from reaching another component even if that component never emits it.
    if (isSecretPointerCandidate(incoming)) {
      const pointer = sanitizeSecretPointer(incoming);
      if (pointer) return pointer;
    }

    if (isPlainRecord(incoming)) {
      return mergeRecord(incoming, isPlainRecord(storedValue) ? storedValue : {}, path, nodes);
    }

    if (Array.isArray(incoming)) {
      return mergeArray(incoming, Array.isArray(storedValue) ? storedValue : [], path, nodes);
    }

    return incoming;
  }

  function mergeRecord(
    incoming: Record<string, unknown>,
    storedNode: Record<string, unknown>,
    path: string,
    nodes: SchemaNode[],
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(incoming)) {
      const childPath = path ? `${path}.${key}` : key;
      const merged = mergeValue(
        value,
        storedNode[key],
        childPath,
        expandSchemaNodes(childNodesForKey(nodes, key), root),
      );
      if (merged === DROP_KEY) continue;
      result[key] = merged;
    }
    return result;
  }

  function mergeArray(
    incoming: unknown[],
    storedArray: unknown[],
    path: string,
    nodes: SchemaNode[],
  ): unknown[] {
    const identityKey = designatedIdentityKey(nodes, root);

    return incoming
      .map((entry, index) => {
        const entryPath = `${path}.${index}`;
        const entryNodes = expandSchemaNodes(childNodesForIndex(nodes, index), root);

        // Entries carrying no sentinel need no stored counterpart at all, so a
        // structural change elsewhere in the array cannot invalidate them.
        if (!containsMask(entry)) return entry;

        let storedEntry: unknown;

        if (identityKey && isPlainRecord(entry)) {
          // Proof 1: a manifest-designated immutable identity, matched uniquely.
          const wanted = identityValue(entry, identityKey);
          const matches =
            wanted === undefined
              ? []
              : storedArray.filter(
                  (candidate) =>
                    isPlainRecord(candidate) && identityValue(candidate, identityKey) === wanted,
                );
          storedEntry = matches.length === 1 ? matches[0] : undefined;
        } else if (incoming.length === storedArray.length) {
          // Proof 2: same shape, same place, identical but for the secrets.
          const positional = storedArray[index];
          storedEntry = matchesIgnoringMask(entry, positional) ? positional : undefined;
        } else {
          storedEntry = undefined;
        }

        if (storedEntry === undefined) {
          reportUnresolved(entryPath);
          // Resolve against nothing: the sentinel is dropped, never persisted.
          const wasSuppressed = suppressUnresolvedReporting;
          suppressUnresolvedReporting = true;
          try {
            return mergeValue(entry, undefined, entryPath, entryNodes);
          } finally {
            suppressUnresolvedReporting = wasSuppressed;
          }
        }

        return mergeValue(entry, storedEntry, entryPath, entryNodes);
      })
      .filter((entry) => entry !== DROP_KEY);
  }

  const configJson = mergeRecord(
    incomingConfig,
    stored,
    "",
    expandSchemaNodes(root ? [root] : [], root),
  );
  return { configJson, unresolvedMaskPaths: [...new Set(unresolvedMaskPaths)] };
}

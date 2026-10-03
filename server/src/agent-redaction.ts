import { isPlainObject, redactAgentConfigPayload } from "./redaction.js";

/**
 * Containment helpers for anything that serializes an agent row.
 *
 * These live in a leaf module rather than inside the `agentRoutes` factory
 * because none of them touch factory state — they are pure functions of their
 * argument — and keeping them closure-private meant any surface outside
 * `routes/agents.ts` that embedded an agent row had no way to reach them.
 * `PATCH /agents/:agentId/budgets` in `routes/costs.ts` is the standing example:
 * it returns the full row and was accepted as board-gated *because* the fix
 * needed this extraction (PEN-3707 §5 / PEN-3726).
 */

// Sentinel substituted into adapter_config.env values by redactAgentSecrets()
// on the GET response. A naive UI/operator round-trip (read agent, edit, save)
// posts the sentinel back as the literal env value; without a guard it lands
// in the DB and breaks runs (BLO-5xxx: PATH=*** in opencode_k8s pods made
// runc fail to find sh and every Staff Engineer run died as StartError).
// Keep this in lockstep with the redactor.
export const REDACTED_ENV_SENTINEL = "***";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * The one admission gate for anything agent-config-shaped on its way out.
 *
 * `redactAgentConfigPayload` — and `sanitizeValue` beneath it — sanitize only
 * `isPlainObject` values and return anything else *by reference*. A caller
 * that admits on a weaker "is it an object" test, or hands the value straight
 * in with no gate, therefore has a fail-open the redactor cannot see: it gets
 * the raw value back and serializes it.
 *
 * The obvious repair — swap the caller's predicate to `isPlainObject` — does
 * not work where the assignment sits inside the gate, as in
 * `redactAgentSecrets`: a failing gate just leaves the raw value on the
 * `{ ...agent }` spread, so the same bytes reach the wire by a different
 * route. Containment has to be *written back*, which is why this returns a
 * value rather than answering a question.
 *
 *   `undefined` — not object-like (`null`, `undefined`, a primitive). No
 *                 config to contain; each caller keeps its own absence
 *                 contract for these.
 *   `{}`        — an object this file cannot sanitize (array or foreign
 *                 prototype). Withheld rather than emitted uncontained.
 *   otherwise   — the redacted record.
 */
export function containAgentConfig(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!isPlainObject(value)) return {};
  return redactAgentConfigPayload(value) ?? {};
}

/**
 * The fail-closed disposition for an ALREADY-SANITIZED `metadata` value.
 *
 * `metadata` is NOT coerced to a record the way the two config columns are: an
 * array-valued `metadata` must survive as the element-wise-sanitized array
 * `sanitizeValue` produced, not be flattened to `{}` or `null`. But it must
 * still fail closed. `metadata` matches no tier and no special case in
 * `sanitizeRecord`, so it reaches `sanitizeValue`, which returns a non-plain
 * non-array object BY REFERENCE — a foreign-prototype `metadata` arrives
 * unsanitized and has to be withheld rather than emitted. Arrays and plain
 * objects have been sanitized and pass; a primitive carries no binding for
 * `sanitizeValue` to have missed and any string has already been through
 * `redactUriCredentialsInValue`; everything else is withheld.
 *
 * Note `isPlainObject` admits a null prototype, so `Object.create(null)` is
 * sanitized and passes here — the withheld shape is a prototype that is
 * neither `Object.prototype` nor `null`.
 */
export function keepSanitizedAgentMetadata(meta: unknown): unknown {
  if (meta === null || meta === undefined) return null;
  if (typeof meta !== "object") return meta;
  return isPlainObject(meta) || Array.isArray(meta) ? meta : null;
}

/**
 * Sanitize a raw stored `metadata` on its way out of a spread-based redactor.
 *
 * `metadata` is the same admission problem `containAgentConfig` solves for the
 * two config columns, minus the ability to coerce the result. It is a
 * caller-writable open bag — `jsonb`, validated only as
 * `z.record(z.string(), z.unknown())` on create/patch — and unlike
 * `adapterConfig` it takes no secret-sentinel pass on write. Its intended
 * contents are markers (`paperclipBuiltInAgent`, `paperclipManagedResource`,
 * `pluginManagedAgent`) that callers read, so it cannot simply be dropped.
 *
 * Sanitize it under the key `metadata`, which is the key the config-revision
 * snapshot already sanitizes it under: `sanitizeRecord` resolves its
 * `env` / `headers` / args / key-tier special cases from the key NAME, so
 * wrapping under any other key would silently apply a different rule to the
 * identical column on two paths that must agree.
 *
 * `containAgentConfig` is deliberately NOT reused here: it answers for a config
 * *record* and returns `{}` for an array, which would flatten an array-valued
 * `metadata` instead of keeping the element-wise-sanitized array.
 *
 * Coverage is the sanitizer's, not this function's: `{type:"plain",value}`
 * bindings, `env` maps, Tier-1 key names at any depth, URI-embedded
 * credentials and JWT-shaped strings are masked. A bare string under an
 * innocuous key (`metadata.note = "sk-ant-…"`) matches no rule and survives —
 * closing that needs a write-side key allowlist, not a read-side redactor.
 */
export function containAgentMetadata(value: unknown): unknown {
  // `?? {}` is a type narrowing, not a live branch: the argument is always a
  // freshly built plain object, so `redactAgentConfigPayload` never returns null.
  return keepSanitizedAgentMetadata((redactAgentConfigPayload({ metadata: value }) ?? {}).metadata);
}

/**
 * Strip credential material out of an agent row before it goes on the wire.
 *
 * `adapterConfig` holds live secrets — `{type:"plain",value}` env bindings and
 * literal `Bearer …` values in `mcpServers.*.headers`. This used to be applied
 * only on the read paths, so a budget-only `PATCH /api/agents/:id` handed the
 * caller the agent's entire credential set, and it landed verbatim in agent
 * transcripts and run logs, which are read far more widely than the secret
 * store (BLO-18969).
 *
 * `secret_ref` / `user_secret_ref` bindings are pointers, not plaintext, so
 * they survive — minus any resolved `value`, which the schema has no field
 * for and which only ever means a secret leaked in.
 *
 * Redaction is structural, not key-name based: `redactAgentConfigPayload`
 * masks every plain binding and every `env` value at any depth, so a nested
 * `runtimeConfig.modelProfiles.*.adapterConfig.env` entry is covered too.
 *
 * Every response that serializes an agent MUST go through here,
 * `redactForRestrictedAgentView`, or `redactAgentConfiguration`. Adding an
 * agent-serializing route without one of them reopens this hole.
 */
export function redactAgentSecrets<
  T extends { adapterConfig?: unknown; runtimeConfig?: unknown; metadata?: unknown },
>(agent: T): T {
  const result = { ...agent };
  // `containAgentConfig`, not the local `asRecord`: `asRecord` admits any
  // non-array object, and for a foreign-prototype config the redactor handed
  // the argument straight back, so `result.adapterConfig` was assigned the
  // raw record. See the helper for why swapping the predicate alone would
  // have moved the leak rather than closed it.
  const rawConfig = agent.adapterConfig;
  const containedConfig = containAgentConfig(rawConfig);
  if (containedConfig) {
    const env = isPlainObject(rawConfig) ? asRecord(rawConfig.env) : null;
    if (env) {
      // The top-level env keeps the shorter `***` sentinel the UI and
      // `stripRedactedEnvBindingsFromAdapterConfig` have always round-tripped.
      const redactedEnv: Record<string, string> = {};
      for (const key of Object.keys(env)) {
        redactedEnv[key] = REDACTED_ENV_SENTINEL;
      }
      result.adapterConfig = { ...containedConfig, env: redactedEnv } as T["adapterConfig"];
    } else {
      result.adapterConfig = containedConfig as T["adapterConfig"];
    }
  }
  const containedRuntime = containAgentConfig(agent.runtimeConfig);
  if (containedRuntime) {
    result.runtimeConfig = containedRuntime as T["runtimeConfig"];
  }
  // `metadata` is an open bag with no write-side secret pass (PEN-3726). The
  // three projections that enumerate their output already decline to emit it
  // as stored; this spread and `redactForRestrictedAgentView` did not, which
  // left the same column sanitized on one path and inert on the two common
  // read paths. Guarded on presence so a caller whose `T` carries no
  // `metadata` does not acquire one.
  if ("metadata" in agent) {
    result.metadata = containAgentMetadata(agent.metadata) as T["metadata"];
  }
  return result;
}

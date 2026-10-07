import { REDACTED_EVENT_VALUE, isPlainObject, redactAgentConfigPayload } from "./redaction.js";

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

/* ---------------------------------------------------------------------------
 * Write side: undo this module's own masking on the way back in.
 *
 * These live beside the redactors above rather than in `routes/agents.ts`
 * because the mask and its inverse have to agree, and the inverse now has a
 * caller that is not a route. `activatePendingApproval`
 * (`services/agents.ts`) replays the board-approval snapshot over the agent
 * row, and that snapshot is masked — so the service layer needs the restore.
 * Reaching into `routes/agents.ts` from a service inverts the layering and
 * would close an import cycle (`routes/agents.ts` imports `services/agents.js`
 * already); this module imports only `./redaction.js`, so both sides can
 * depend on it (PEN-3757).
 * ------------------------------------------------------------------------- */

export function isRedactedEnvBinding(binding: unknown): boolean {
  if (typeof binding === "string") return binding === REDACTED_ENV_SENTINEL;
  if (binding && typeof binding === "object") {
    const b = binding as { type?: unknown; value?: unknown };
    return b.type === "plain" && b.value === REDACTED_ENV_SENTINEL;
  }
  return false;
}

const OMIT_REDACTED_ADAPTER_VALUE = Symbol("omit-redacted-adapter-value");

export function containsRedactedAdapterValue(value: unknown): boolean {
  if (typeof value === "string") return value.includes(REDACTED_EVENT_VALUE);
  if (Array.isArray(value)) return value.some(containsRedactedAdapterValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(containsRedactedAdapterValue);
}

/**
 * Exported for `restoreRedactedRuntimeConfigValues` in `routes/agents.ts`,
 * which restores `runtimeConfig` on the same rule. Prefer
 * {@link restoreRedactedAgentMetadata} or
 * {@link stripRedactedEnvBindingsFromAdapterConfig} where one fits — they pair
 * this with the `containsRedactedAdapterValue` short-circuit that keeps an
 * unmasked payload byte-identical.
 *
 * A masked scalar with an `undefined` prior has nothing to restore from, and
 * reports that as `undefined` rather than as the private
 * `OMIT_REDACTED_ADAPTER_VALUE` symbol: the walk below uses that symbol to tell
 * "drop this key" apart from "the stored value is `undefined`", but it is an
 * internal token and must not cross this boundary. Nested occurrences are
 * consumed by the object/array walk, so only the top-level one could ever
 * escape, and the wrapper here maps it. Every call site in this repo passes a
 * record for `existing`, so the case does not arise today — this keeps the
 * hazard unreachable by construction rather than by that fact, since the
 * failure mode is silent (a `Symbol` serialized into a config column) and this
 * is a leaf module's public surface (PEN-3759).
 */
export function restoreRedactedAdapterValue(incoming: unknown, existing: unknown): unknown {
  const restored = restoreRedactedAdapterValueInner(incoming, existing);
  return restored === OMIT_REDACTED_ADAPTER_VALUE ? undefined : restored;
}

function restoreRedactedAdapterValueInner(incoming: unknown, existing: unknown): unknown {
  // PEN-2747: the URI-credential rule masks only the credential *component* of
  // a URL, so the round-tripped value is `https://user:***REDACTED***@host/mcp`
  // — a string that merely CONTAINS the sentinel rather than equalling it. An
  // equality test misses it and persists a broken upstream URL, which is the
  // BLO-5xxx failure mode described above (a sentinel written back into live
  // config killed every run) with a different shape. Substring-test instead:
  // no legitimate configured value contains this sentinel.
  if (typeof incoming === "string" && incoming.includes(REDACTED_EVENT_VALUE)) {
    return existing === undefined ? OMIT_REDACTED_ADAPTER_VALUE : existing;
  }
  if (
    incoming
    && typeof incoming === "object"
    && !Array.isArray(incoming)
    && (incoming as { type?: unknown; value?: unknown }).type === "plain"
    && (incoming as { type?: unknown; value?: unknown }).value === REDACTED_EVENT_VALUE
  ) {
    return existing === undefined ? OMIT_REDACTED_ADAPTER_VALUE : existing;
  }
  if (Array.isArray(incoming)) {
    const existingArray = Array.isArray(existing) ? existing : [];
    return incoming.flatMap((value, index) => {
      const restored = restoreRedactedAdapterValueInner(value, existingArray[index]);
      return restored === OMIT_REDACTED_ADAPTER_VALUE ? [] : [restored];
    });
  }
  if (!incoming || typeof incoming !== "object") return incoming;

  const existingRecord =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const restored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
    const restoredValue = restoreRedactedAdapterValueInner(value, existingRecord[key]);
    if (restoredValue !== OMIT_REDACTED_ADAPTER_VALUE) restored[key] = restoredValue;
  }
  return restored;
}

// The legacy name is retained for call-site compatibility; this now restores
// both env sentinels and recursively redacted adapter values on API round-trips.
export function stripRedactedEnvBindingsFromAdapterConfig(
  incomingAdapterConfig: Record<string, unknown>,
  existingAdapterConfig: Record<string, unknown> | null,
): Record<string, unknown> {
  const restoredAdapterConfig = containsRedactedAdapterValue(incomingAdapterConfig)
    ? (restoreRedactedAdapterValue(
        incomingAdapterConfig,
        existingAdapterConfig ?? {},
      ) as Record<string, unknown>)
    : incomingAdapterConfig;
  const incomingEnv = restoredAdapterConfig.env;
  if (!incomingEnv || typeof incomingEnv !== "object" || Array.isArray(incomingEnv)) {
    return restoredAdapterConfig;
  }
  const existingEnv =
    existingAdapterConfig
    && typeof existingAdapterConfig.env === "object"
    && existingAdapterConfig.env !== null
    && !Array.isArray(existingAdapterConfig.env)
      ? (existingAdapterConfig.env as Record<string, unknown>)
      : {};
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incomingEnv as Record<string, unknown>)) {
    if (isRedactedEnvBinding(value)) {
      // UI round-trip: the GET response masks env values to the sentinel,
      // and a naive save sends them back. Preserve the prior binding if we
      // have one; drop the key entirely otherwise.
      if (Object.prototype.hasOwnProperty.call(existingEnv, key)) {
        cleaned[key] = existingEnv[key];
      }
    } else {
      cleaned[key] = value;
    }
  }
  return { ...restoredAdapterConfig, env: cleaned };
}

/**
 * Undo this module's own `metadata` masking on an API round-trip.
 *
 * Containing `metadata` on the read paths (PEN-3726) gave it the same
 * read-modify-write hazard `adapterConfig` has carried since BLO-5xxx, where a
 * sentinel written back into live config killed every run: `GET` now masks
 * credential-shaped values to `REDACTED_EVENT_VALUE`, `updateAgentSchema`
 * accepts `metadata`, and `svc.update` persists whatever arrives. So a client
 * that reads an agent, edits an unrelated field and `PATCH`es the object back
 * overwrites the stored value with the placeholder. `adapterConfig` is guarded
 * against exactly this by `stripRedactedEnvBindingsFromAdapterConfig`;
 * `metadata` had no analogue.
 *
 * This composes the *same* `containsRedactedAdapterValue` /
 * `restoreRedactedAdapterValue` pair rather than restating the sentinel rule.
 * Both columns are masked by the one redactor, so a parallel implementation
 * could drift from it — and a rule that drifts on the write side is how a
 * column ends up sanitized on one path and inert on another, which is the
 * defect PEN-3726 exists to close. In particular the PEN-2747 case (a URI
 * whose credential *component* alone is masked, so the value contains the
 * sentinel rather than equalling it) is handled because that helper
 * substring-tests; an equality test written fresh here would miss it.
 *
 * Absent prior value: `restoreRedactedAdapterValue` drops the key rather than
 * inventing one, so a masked key with nothing stored to restore is omitted
 * instead of persisting the placeholder. On a create there is no prior value at
 * all, so passing `null` there scrubs the whole payload on the same rule.
 *
 * Ceiling, inherited from that helper: arrays are matched to their prior values
 * **positionally** (`existingArray[index]`). A client that reorders or inserts
 * into an array holding a masked element restores the wrong stored element, and
 * elements past the end of the prior array are dropped — stored
 * `[secretA, secretB]` sent back as `[newItem, ***, ***]` yields
 * `[newItem, secretB]`. Index-matching is about all a restore can do for an
 * anonymous array, but it is worth knowing here specifically: unlike
 * `adapterConfig.env`, `metadata` supports array values as a first-class shape
 * (`keepSanitizedAgentMetadata` preserves them rather than flattening), so this
 * is reachable on this column in a way it is not on the one it was written for.
 *
 * That ceiling is scoped to the client `PATCH` round-trip, where the array the
 * caller sends back is whatever the caller chose to send. It is **not** reachable
 * on the hire-approval replay (`services/agents.ts`), because there the
 * "incoming" side is a `redactEventPayload` snapshot of the stored row, and every
 * array branch in that redactor is length-preserving: `sanitizeValue` and
 * `sanitizeSecretMatchedValue` both `.map()`, and `sanitizeCommandArgs` returns
 * the flag verbatim and masks the following element in place. Snapshot and row
 * therefore stay index-aligned by construction on that path. Keep the two apart
 * when reading this: only a caller-supplied array can misalign (PEN-3759).
 */
export function restoreRedactedAgentMetadata(incoming: unknown, existing: unknown): unknown {
  if (!containsRedactedAdapterValue(incoming)) return incoming;
  return restoreRedactedAdapterValue(incoming, existing ?? {});
}

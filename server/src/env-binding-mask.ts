import type { AgentEnvConfig, EnvBinding } from "@paperclipai/shared";
import { REDACTED_SENTINEL } from "./services/secret-sentinel.js";

/**
 * The env-binding disclosure primitives, shared by the route projections and by the services that
 * own the matching write paths.
 *
 * These began in `routes/project-env-response.ts` (PEN-3033, door #17), which still re-exports them
 * so every existing import keeps working. They moved here for PEN-3707 (door #18), which extends the
 * same boundary to `routines.env` — and routines normalize env INSIDE the service
 * (`services/routines.ts` `update`, `services/pipelines.ts` `updateStageAutomationEnv`), not in the
 * route the way projects do. The write half therefore has to be importable from the service layer,
 * and services do not import from `routes/` — the same reasoning that put
 * `restoreWithheldPipelineStageConfig` in `redaction.ts` rather than in `workspace-response.ts`.
 * Route-SHAPED wrappers stay in `routes/`; only these two shape-agnostic primitives live here.
 *
 * **The mask value must be exactly the shared sentinel.** Three rules match on it — the mask, the
 * merge below, and `normalizeEnvConfig`'s refusal to persist it — so a drifting private copy would
 * not fail loudly; it would silently stop the merge from matching and 422 every save. It is imported
 * from `services/secret-sentinel.ts`, never re-declared. That leaf, rather than `services/secrets.ts`,
 * is the source: `secrets.ts` is mocked by 19 test files whose factories return only what each needs,
 * so importing the constant from there breaks every test that reaches a masking route through a
 * mocked `secrets.js` — on mock bookkeeping, not behaviour.
 */
export const ENV_VALUE_MASK = REDACTED_SENTINEL;

/**
 * A "plain" binding is the only shape carrying a literal value. It has two spellings: the object
 * form and a bare string (`canonicalizeBinding` maps `"v"` to `{ type: "plain", value: "v" }`).
 * Rows written before canonicalization, or by a client sending the shorthand, still use the string
 * form, so both are handled everywhere in this module. `secret_ref` / `user_secret_ref` carry a
 * pointer rather than material and are passed through untouched.
 */
function plainValueOf(binding: EnvBinding): string | null {
  if (typeof binding === "string") return binding;
  if (binding && typeof binding === "object" && binding.type === "plain") {
    return typeof binding.value === "string" ? binding.value : String(binding.value);
  }
  return null;
}

function maskBinding(binding: EnvBinding): EnvBinding {
  // Shape-preserving: a string binding stays a string so the response keeps the shape the caller
  // stored, and the editor's `rowsFromValue` reads it the same way it always did.
  if (typeof binding === "string") return ENV_VALUE_MASK;
  if (binding && typeof binding === "object" && binding.type === "plain") {
    return { ...binding, value: ENV_VALUE_MASK };
  }
  return binding;
}

export function maskEnvBindings<T extends AgentEnvConfig | null | undefined>(env: T): T {
  if (!env || typeof env !== "object") return env;
  // Null-prototype accumulator: `ENV_KEY_RE` (`services/secrets.ts`) is /^[A-Za-z_][A-Za-z0-9_]*$/,
  // which admits `__proto__`, and JSON.parse hands it over as an ordinary own property. On a `{}`
  // accumulator `masked[key] = ...` would then be a PROTOTYPE write: the binding would vanish with
  // no own property and nothing serialized. A dropped binding discloses nothing, so this is a
  // correctness fix rather than a disclosure one — but silently losing a row is the wrong failure
  // mode for the module whose job is to round-trip every binding it is handed.
  const masked: AgentEnvConfig = Object.create(null);
  for (const [key, binding] of Object.entries(env)) {
    masked[key] = maskBinding(binding as EnvBinding);
  }
  return masked as T;
}

/**
 * Write half of the round trip: an incoming plain binding whose value is the mask means "keep what
 * is stored", not "set the literal string `***REDACTED***`".
 *
 * Deliberately narrow in two directions, because both loosenings would be silent:
 *
 * - It merges only when the STORED binding is also plain. If the stored binding is a secret
 *   reference, the incoming masked plain is left exactly as it arrived so `normalizeEnvConfig`
 *   still rejects it. Substituting the stored `secret_ref` there would silently change the
 *   binding's TYPE on the caller's behalf.
 * - A masked value for a key that is not stored at all is left untouched, and so still 422s. There
 *   is nothing to restore, and inventing an empty value would let the placeholder install itself
 *   as a real credential value.
 */
export function restoreMaskedEnvBindings(
  incoming: AgentEnvConfig,
  stored: AgentEnvConfig | null | undefined,
): AgentEnvConfig {
  if (!incoming || typeof incoming !== "object") return incoming;
  // Null-prototype for the same reason as the mask above, and one more specific to this half: the
  // stored lookup must be an OWN-property read. `stored["__proto__"]` on an ordinary object returns
  // `Object.prototype` rather than `undefined`, so an `!== undefined` guard treats "nothing stored"
  // as "something stored" and hands a non-binding to `plainValueOf`.
  const merged: AgentEnvConfig = Object.create(null);
  for (const [key, binding] of Object.entries(incoming)) {
    const incomingPlain = plainValueOf(binding as EnvBinding);
    if (incomingPlain !== ENV_VALUE_MASK) {
      merged[key] = binding as EnvBinding;
      continue;
    }
    const storedBinding = stored && Object.hasOwn(stored, key) ? stored[key] : undefined;
    if (storedBinding !== undefined && plainValueOf(storedBinding) !== null) {
      merged[key] = storedBinding;
      continue;
    }
    merged[key] = binding as EnvBinding;
  }
  return merged;
}

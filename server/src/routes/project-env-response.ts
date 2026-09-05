import type { AgentEnvConfig, EnvBinding } from "@paperclipai/shared";
import { REDACTED_SENTINEL } from "../services/secret-sentinel.js";

/**
 * PEN-3033 — disclosure boundary for project `env` bindings on response bodies.
 *
 * `routes/projects.ts` answered with the stored project row, and `normalizeEnvConfig`
 * (`services/secrets.ts`) persists a `{ type: "plain", value }` binding verbatim — it only refuses
 * one when `PAPERCLIP_SECRETS_STRICT_MODE` is on AND the key/value look sensitive, i.e. not by
 * default. So a plain value written by one actor was readable in the clear by every other actor who
 * passed `assertProjectReadAllowed`, which admits ordinary same-company agents. This is door #17 of
 * the PEN-2370 series, and the first one surfaced by a control rather than by an observer.
 *
 * Three properties drive the shape of this module:
 *
 * 1. **The mask is unconditional — it is deliberately NOT entitlement-gated.** The neighbouring
 *    `workspace-response.ts` withholds on `workspace_runtime:read`, and its own header records why
 *    the first attempt there (`runtime:manage`) was wrong: that action sits in the blanket
 *    same-company agent allow-list, so gating on it would have looked like a fix while disclosing
 *    to exactly the principals the ticket is about. Rather than hunt for an action that happens to
 *    exclude agents, nothing needs a plain value in a *response body* at all: execution reads
 *    bindings through `secretsSvc.resolveEnvBindings` (see `services/heartbeat.ts`), never through
 *    this projection. So the value never leaves, for anyone.
 *
 * 2. **Masking a read alone would destructively break project env editing**, which is why the mask
 *    ships with {@link restoreMaskedEnvBindings} and not on its own. The project env surface is a
 *    round-tripping editor, unlike the display-only agent surfaces that already mask:
 *    `valueFromRows` (`ui/src/components/environment-variables-editor/model.ts`) re-emits the
 *    ENTIRE map on save, untouched rows included. Masking the read without merging the write would
 *    PATCH the placeholder back for every other plain binding, and `normalizeEnvConfig` refuses to
 *    persist it — 422ing the whole save. No project env edit would be possible while any plain
 *    binding existed.
 *
 * 3. **The mask value must be exactly the shared sentinel.** Three rules match on it — this mask,
 *    the merge below, and `normalizeEnvConfig`'s refusal to persist it — so a drifting private copy
 *    would not fail loudly; it would silently stop the merge from matching and 422 every save. It is
 *    imported from `services/secret-sentinel.ts`, never re-declared. That leaf module, rather than
 *    `services/secrets.ts`, is the source: `secrets.ts` is mocked by 19 test files whose factories
 *    return only what each needs, so importing the constant from there breaks every test that
 *    reaches a masking route through a mocked `secrets.js` — on mock bookkeeping, not behaviour.
 */
export const PROJECT_ENV_VALUE_MASK = REDACTED_SENTINEL;

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
  if (typeof binding === "string") return PROJECT_ENV_VALUE_MASK;
  if (binding && typeof binding === "object" && binding.type === "plain") {
    return { ...binding, value: PROJECT_ENV_VALUE_MASK };
  }
  return binding;
}

export function maskEnvBindings<T extends AgentEnvConfig | null | undefined>(env: T): T {
  if (!env || typeof env !== "object") return env;
  const masked: AgentEnvConfig = {};
  for (const [key, binding] of Object.entries(env)) {
    masked[key] = maskBinding(binding as EnvBinding);
  }
  return masked as T;
}

/**
 * Masks `env` on any row that carries one.
 *
 * Constrained to `object` rather than to `{ env?: AgentEnvConfig | null }` for two reasons, both
 * load-bearing:
 *
 * - The bare deleted row returned by `svc.remove` has no `workspaces[]`, so it is outside
 *   `publicProject`'s generic constraint — but it still carries `env`.
 * - `routines.ts` passes a value DECLARED as `RoutineProjectSummary`, a five-field type with no
 *   `env` at all, which the service populates from a full-row `db.select()`. An `{ env?: ... }`
 *   constraint rejects that type outright under TypeScript's weak-type rule, and "the declared type
 *   says there is no env" is exactly the reasoning that let that leak survive. The runtime check
 *   below is therefore the authority here, not the declared shape.
 */
export function maskProjectEnv<T extends object>(project: T): T {
  if (!project || typeof project !== "object") return project;
  const env = (project as { env?: AgentEnvConfig | null }).env;
  if (!env) return project;
  return { ...project, env: maskEnvBindings(env) };
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
  const merged: AgentEnvConfig = {};
  for (const [key, binding] of Object.entries(incoming)) {
    const incomingPlain = plainValueOf(binding as EnvBinding);
    if (incomingPlain !== PROJECT_ENV_VALUE_MASK) {
      merged[key] = binding as EnvBinding;
      continue;
    }
    const storedBinding = stored?.[key];
    if (storedBinding !== undefined && plainValueOf(storedBinding) !== null) {
      merged[key] = storedBinding;
      continue;
    }
    merged[key] = binding as EnvBinding;
  }
  return merged;
}

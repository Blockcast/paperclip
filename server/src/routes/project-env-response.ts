import type { AgentEnvConfig } from "@paperclipai/shared";
import { ENV_VALUE_MASK, maskEnvBindings } from "../env-binding-mask.js";

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
 * 3. **The mask value must be exactly the shared sentinel**, for the reasons recorded on
 *    `ENV_VALUE_MASK` itself.
 *
 * PEN-3707 moved the two shape-agnostic primitives — {@link maskEnvBindings} and
 * {@link restoreMaskedEnvBindings} — down to `server/src/env-binding-mask.ts`, because the routine
 * surface normalizes env inside the SERVICE and services do not import from `routes/`. They are
 * re-exported here so every existing import path keeps working; only the project-row-shaped wrapper
 * below is still defined in this module.
 */
export { maskEnvBindings, restoreMaskedEnvBindings } from "../env-binding-mask.js";

/** Pre-PEN-3707 spelling of {@link ENV_VALUE_MASK}, kept so existing import sites keep working. */
export const PROJECT_ENV_VALUE_MASK = ENV_VALUE_MASK;

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

import type { AgentEnvConfig } from "@paperclipai/shared";
import { maskEnvBindings } from "../env-binding-mask.js";

/**
 * PEN-3707 — disclosure boundary for routine `env` bindings on response bodies. Door #18 of the
 * PEN-2370 series, and the sibling of `project-env-response.ts` (door #17, PEN-3033).
 *
 * `routines.env` is declared `jsonb(...).$type<RoutineEnvConfig>()`
 * (`packages/db/src/schema/routines.ts`), and `RoutineEnvConfig` is `Record<string, EnvBinding>` —
 * structurally the SAME union as the project/agent `AgentEnvConfig`, `{ type: "plain", value }`
 * member included. So the material `maskProjectEnv` exists to withhold was crossing verbatim on the
 * routine surface, which `assertCompanyAccess` admits every same-company agent to
 * (`routes/authz.ts`: an agent is refused only when `req.actor.companyId !== companyId`).
 *
 * Three things are worth knowing before editing this module.
 *
 * 1. **The mask belongs at the ROUTE layer, not in `services/routines.ts`.** The service's rows are
 *    not display-only: `createRoutineEnvFingerprint(input.routine.env)` (`services/routines.ts`)
 *    feeds dispatch de-duplication, `syncEnvBindingsForTarget` reconciles secret bindings from it,
 *    and `restoreRevision` writes `snapshot.routine.env` back to the row. Masking inside the service
 *    would corrupt all three. It is also what `project-env-response-boundary.test.ts` requires —
 *    that suite mocks `routineService` wholesale, so a mask living in the service never executes.
 *
 * 2. **The mask is unconditional, deliberately NOT entitlement-gated.** Its neighbour
 *    `publicPipelineStageConfig` (`workspace-response.ts`) opens with
 *    `if (viewer.revealRuntimeConfig) return config`, and that entitlement resolves from
 *    `workspace_runtime:read`. Nothing needs a plain value in a response body: execution resolves
 *    bindings through `secretsSvc.resolveEnvBindings`, never through this projection. So the mask
 *    must sit OUTSIDE any `revealRuntimeConfig` early return — see the call site in
 *    `routes/pipelines.ts`, where `env` is masked before `publicPipelineStageConfig` is applied
 *    rather than inside it.
 *
 * 3. **Masking a read alone would destroy the values it masks.** Both routine env editors re-emit
 *    the entire map on save — `ui/src/components/routine-sections/editable-sections.tsx` for
 *    `PATCH /routines/:id` and `ui/src/components/StageSecretsPanel.tsx` for
 *    `PATCH /pipelines/:id/stages/:id/automation-env` — so an untouched row arrives carrying the
 *    placeholder it was rendered with, and `normalizeEnvConfig` refuses to persist that
 *    (`services/secrets.ts`: "Refusing to persist redacted placeholder for key"). The read mask
 *    therefore ships with `restoreMaskedEnvBindings` applied on BOTH write paths. Unlike the project
 *    case, routines normalize env inside the service, so the restore lives there too —
 *    `services/routines.ts` `update` and `services/pipelines.ts` `updateStageAutomationEnv`.
 */

/** A row that carries an `env` column. Mirrors `maskProjectEnv`'s runtime-first contract. */
export function maskRoutineEnv<T extends object>(routine: T): T {
  if (!routine || typeof routine !== "object") return routine;
  const env = (routine as { env?: AgentEnvConfig | null }).env;
  if (!env) return routine;
  return { ...routine, env: maskEnvBindings(env) };
}

export function maskRoutineEnvList<T extends object>(routines: T[]): T[] {
  return Array.isArray(routines) ? routines.map((routine) => maskRoutineEnv(routine)) : routines;
}

/**
 * A revision carries the routine's env a second time, nested under `snapshot.routine.env`, because
 * `routineRevisionSnapshotRoutine` (`services/routines.ts`) copies `env: routine.env ?? null` into
 * every stored snapshot. Masking the row and not the snapshot would leave the same material on the
 * revision list, the restore response, and both trigger exits — which is exactly the
 * "one exit masked, another not" shape this series keeps finding.
 *
 * The snapshot is STORED with real values and is read back by `restoreRevision`, so this mask is
 * applied to the response copy only; nothing here writes to the stored snapshot.
 */
export function maskRoutineRevisionEnv<T extends object>(revision: T): T {
  if (!revision || typeof revision !== "object") return revision;
  const snapshot = (revision as { snapshot?: unknown }).snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return revision;
  const routine = (snapshot as { routine?: unknown }).routine;
  if (!routine || typeof routine !== "object" || Array.isArray(routine)) return revision;
  const env = (routine as { env?: AgentEnvConfig | null }).env;
  if (!env) return revision;
  return {
    ...revision,
    snapshot: { ...(snapshot as object), routine: maskRoutineEnv(routine as object) },
  };
}

export function maskRoutineRevisionEnvList<T extends object>(revisions: T[]): T[] {
  return Array.isArray(revisions)
    ? revisions.map((revision) => maskRoutineRevisionEnv(revision))
    : revisions;
}

/**
 * The `{ routine, revision, ... }` and `{ trigger, revision, ... }` envelopes returned by
 * `restoreRevision`, `createTrigger` and `rotateTriggerSecret`. Both members can carry env, and
 * `restoreRevision` returns both at once.
 *
 * `secretMaterial` / `secretMaterials` on those envelopes are deliberately left alone: a freshly
 * minted webhook secret is the one value the caller asked to be told, and it is show-once material
 * that exists nowhere else by the time the response is written.
 */
export function maskRoutineEnvelopeEnv<T extends object>(envelope: T): T {
  if (!envelope || typeof envelope !== "object") return envelope;
  let result: T = envelope;
  const routine = (envelope as { routine?: unknown }).routine;
  if (routine && typeof routine === "object") {
    result = { ...result, routine: maskRoutineEnv(routine as object) };
  }
  const revision = (envelope as { revision?: unknown }).revision;
  if (revision && typeof revision === "object") {
    result = { ...result, revision: maskRoutineRevisionEnv(revision as object) };
  }
  return result;
}

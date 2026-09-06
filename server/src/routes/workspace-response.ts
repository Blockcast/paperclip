import type { Request } from "express";
import type { AgentEnvConfig, ExecutionWorkspace, ProjectWorkspace } from "@paperclipai/shared";
import type { accessService } from "../services/index.js";
import { maskProjectEnv } from "./project-env-response.js";

/**
 * PEN-2852 — withholding boundary for workspace runtime configuration on response bodies.
 *
 * `workspaceRuntime` is an operator-authored `Record<string, unknown>` with no closed shape: it
 * routinely carries service commands, working directories and the environment those commands run
 * with. Until now every execution-workspace and project-workspace route answered with the raw row,
 * gated only on `company_scope:read` — which admits any same-company actor, including every agent.
 *
 * Two properties of the storage layout drive the shape of this module, and both are easy to get
 * wrong:
 *
 * 1. `config` / `runtimeConfig` are *derived views* over `metadata` — `metadata.config` and
 *    `metadata.runtimeConfig` respectively. Withholding the derived view while answering with
 *    `metadata` is a no-op: the same bytes leave one key over. Both exits must close together,
 *    which is why this module withholds them in a single function rather than at each call site.
 *
 * 2. Withholding must happen HERE, at the response boundary, and must never be pushed down into
 *    the service mappers. `routes/execution-workspaces.ts` (runtime commands, PATCH/archive),
 *    `services/heartbeat.ts` (workspace reuse) and `services/plugin-host-services.ts` all read
 *    `.metadata` off a service result and write it BACK to the row. A masked mapper would not
 *    merely hide the config — it would persist the masked value and destroy it.
 *
 * Entitlement: the raw value is disclosed on `workspace_runtime:read`, an action that exists for
 * exactly this disclosure and for nothing else.
 *
 * It is deliberately NOT `runtime:manage`, which was the first thing tried and was wrong. That
 * action reads like the right one — it is what gates *writing* this material — but it sits in the
 * standard same-company agent allow-list (`services/authorization.ts`, the `allow_company_agent`
 * branch) alongside `company_scope:read` and even `secrets:read`. Gating on it would have handed
 * every ordinary agent `revealRuntimeConfig: true`, withholding from nothing but low-trust and
 * task-bridge principals — i.e. it would have left the exact disclosure path this ticket is about
 * wide open while looking like a fix. The lesson generalizes: for an agent-facing boundary, the
 * question is never "is this action privileged-sounding" but "is this action in the blanket agent
 * allow-list".
 *
 * Who gets the raw value under the new action:
 *   - active non-viewer company members (so the workspace and project-workspace runtime EDITORS
 *     keep working — masking them unconditionally would break both), and instance admins;
 *   - nobody else by default: ordinary same-company agents, `viewer` members, `low_trust_review`
 *     agents, task-bridge keys and skill-test run tokens all get the withheld projection.
 *
 * Callers keep `hasWorkspaceRuntimeConfig` regardless of entitlement, so a UI that only needs to
 * know whether a runtime config exists never needs the contents. `runtimeServices` is unaffected:
 * it is a separately-typed, separately-populated field, not part of the withheld blob.
 */

export interface WorkspaceRuntimeViewer {
  /** True only for actors entitled to the raw `workspaceRuntime` / `metadata` values. */
  revealRuntimeConfig: boolean;
}

/** Withholds by default: any caller that cannot prove the entitlement gets the redacted view. */
export const WITHHELD_WORKSPACE_RUNTIME_VIEWER: WorkspaceRuntimeViewer = {
  revealRuntimeConfig: false,
};

export async function resolveWorkspaceRuntimeViewer(
  access: ReturnType<typeof accessService>,
  req: Request,
  companyId: string,
): Promise<WorkspaceRuntimeViewer> {
  const decision = await access.decide({
    actor: req.actor,
    action: "workspace_runtime:read",
    resource: { type: "company", companyId },
  });
  return { revealRuntimeConfig: decision.allowed };
}

export function publicExecutionWorkspace(
  workspace: ExecutionWorkspace,
  viewer: WorkspaceRuntimeViewer,
): ExecutionWorkspace {
  if (viewer.revealRuntimeConfig) return workspace;
  return {
    ...workspace,
    config: workspace.config === null ? null : { ...workspace.config, workspaceRuntime: null },
    metadata: null,
  };
}

/** The identity fields of an execution workspace — which workspace, and nothing about its runtime. */
export type ExecutionWorkspaceIdentity = Pick<
  ExecutionWorkspace,
  "closedAt" | "id" | "mode" | "name" | "status"
>;

/**
 * Narrows an execution-workspace row to its identity fields, for responses that must say WHICH
 * workspace a caller hit without disclosing anything about it — error bodies, chiefly.
 *
 * This is a narrowing, not a mask, so unlike `publicExecutionWorkspace` it takes no viewer: none of
 * the five fields is withheld from anyone. It exists as a function rather than a declared parameter
 * type because a declared type does not narrow at runtime. A handler typed
 * `Pick<ExecutionWorkspace, …>` still serializes every property of the full row it is handed —
 * TypeScript checks excess properties at literal-assignment sites and nowhere else. That is exactly
 * how the closed-workspace 409 in `routes/issues.ts` came to serve `workspaceRuntime`: the narrow
 * type made it read as already-projected, so nobody looked.
 */
export function executionWorkspaceIdentity(
  workspace: ExecutionWorkspaceIdentity,
): ExecutionWorkspaceIdentity {
  return {
    closedAt: workspace.closedAt,
    id: workspace.id,
    mode: workspace.mode,
    name: workspace.name,
    status: workspace.status,
  };
}

export function publicExecutionWorkspaces(
  workspaces: ExecutionWorkspace[],
  viewer: WorkspaceRuntimeViewer,
): ExecutionWorkspace[] {
  return workspaces.map((workspace) => publicExecutionWorkspace(workspace, viewer));
}

export function publicProjectWorkspace(
  workspace: ProjectWorkspace,
  viewer: WorkspaceRuntimeViewer,
): ProjectWorkspace {
  if (viewer.revealRuntimeConfig) return workspace;
  return {
    ...workspace,
    runtimeConfig:
      workspace.runtimeConfig === null ? null : { ...workspace.runtimeConfig, workspaceRuntime: null },
    metadata: null,
  };
}

export function publicProjectWorkspaces(
  workspaces: ProjectWorkspace[],
  viewer: WorkspaceRuntimeViewer,
): ProjectWorkspace[] {
  return workspaces.map((workspace) => publicProjectWorkspace(workspace, viewer));
}

/**
 * Project responses EMBED their workspaces (`workspaces[]` and `primaryWorkspace`), each built by
 * the same `toWorkspace` mapper — so a project read is a second exit for exactly the same material,
 * and `GET /companies/:companyId/projects` is the widest one in the codebase. Found by running this
 * ticket's own method clause against the workspace-route fix rather than by re-reading it.
 */
export function publicProject<T extends {
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
  env?: AgentEnvConfig | null;
}>(project: T, viewer: WorkspaceRuntimeViewer): T {
  // PEN-3033: the `env` mask is applied FIRST and is not gated on `viewer`. The runtime-config
  // withholding below is an entitlement decision; a plain env value is disclosed to nobody, so it
  // must not sit behind the `revealRuntimeConfig` early return — an entitled viewer would
  // otherwise take the raw row on the very next line.
  const masked = maskProjectEnv(project);
  if (viewer.revealRuntimeConfig) return masked;
  return {
    ...masked,
    workspaces: publicProjectWorkspaces(masked.workspaces, viewer),
    primaryWorkspace: masked.primaryWorkspace
      ? publicProjectWorkspace(masked.primaryWorkspace, viewer)
      : null,
  };
}

export function publicProjects<T extends {
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
  env?: AgentEnvConfig | null;
}>(projects: T[], viewer: WorkspaceRuntimeViewer): T[] {
  return projects.map((project) => publicProject(project, viewer));
}

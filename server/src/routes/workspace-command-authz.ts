import type { Request } from "express";
import { forbidden } from "../errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function prefixPath(prefix: string, key: string) {
  return prefix.length > 0 ? `${prefix}.${key}` : key;
}

function collectWorkspaceStrategyCommandPaths(raw: unknown, prefix: string): string[] {
  if (!isRecord(raw)) return [];
  const paths: string[] = [];
  if (hasOwn(raw, "provisionCommand")) {
    paths.push(prefixPath(prefix, "provisionCommand"));
  }
  if (hasOwn(raw, "teardownCommand")) {
    paths.push(prefixPath(prefix, "teardownCommand"));
  }
  return paths;
}

function collectExecutionWorkspaceConfigCommandPaths(raw: unknown, prefix: string): string[] {
  if (!isRecord(raw)) return [];
  const paths: string[] = [];
  if (hasOwn(raw, "provisionCommand")) {
    paths.push(prefixPath(prefix, "provisionCommand"));
  }
  if (hasOwn(raw, "teardownCommand")) {
    paths.push(prefixPath(prefix, "teardownCommand"));
  }
  if (hasOwn(raw, "cleanupCommand")) {
    paths.push(prefixPath(prefix, "cleanupCommand"));
  }
  return paths;
}

export function assertNoAgentHostWorkspaceCommandMutation(req: Request, paths: string[]) {
  if (req.actor.type !== "agent" || paths.length === 0) return;
  throw forbidden(
    `Agent keys cannot modify host-executed workspace commands (${paths.join(", ")}).`,
  );
}

export function collectAgentAdapterWorkspaceCommandPaths(
  adapterConfig: unknown,
  prefix = "adapterConfig",
): string[] {
  if (!isRecord(adapterConfig)) return [];
  return collectWorkspaceStrategyCommandPaths(
    adapterConfig.workspaceStrategy,
    `${prefix}.workspaceStrategy`,
  );
}

export function collectProjectExecutionWorkspaceCommandPaths(policy: unknown): string[] {
  if (!isRecord(policy)) return [];
  return collectWorkspaceStrategyCommandPaths(
    policy.workspaceStrategy,
    "executionWorkspacePolicy.workspaceStrategy",
  );
}

/**
 * PEN-5226 — `setupCommand` is guarded even though nothing executes it today.
 *
 * `cleanupCommand` reaches a shell: `services/workspace-runtime.ts` builds `cleanupCommands` from
 * `input.projectWorkspace?.cleanupCommand` and runs each through `recordWorkspaceCommandOperation`.
 * `setupCommand` has **no executor** — swept repo-wide, its only consumers are the service mapper
 * (`services/projects.ts`), two masked read projections (`publicProjectWorkspace`, and the
 * issue-detail projection in `routes/issues.ts`), portability import/export, the workspace UI edit
 * form and the CLI import. None of them hands it to a shell.
 *
 * It is collected here anyway, and that is deliberate — do NOT remove it as over-caution:
 *
 *   1. The rest of the codebase already treats the column as dangerous. The read side masks it
 *      (`routes/workspace-response.ts`, under the PEN-3073 rule that a string this control plane
 *      hands to a shell is withheld wherever it is stored), and `services/company-portability.ts`
 *      treats it as host-executed in BOTH directions — it refuses it on safe import and drops it
 *      from export when it carries an absolute path. Leaving it out of the write guard made this
 *      the one subsystem of three that called it inert, so an agent could set
 *      `project_workspaces.setup_command` and then could not read it back.
 *   2. `doc/plans/workspace-product-model-and-work-product.md` plans to execute it — "`setupCommand`
 *      and `cleanupCommand` should be allowed here for workspace-root bootstrap". The guard has to
 *      exist BEFORE the executor lands, not be remembered on the day it does.
 *
 * So the invariant this collector encodes is the write-side mirror of the read-side mask: the two
 * project-workspace command columns are agent-immutable as a pair. If a third command column is
 * added to `project_workspaces`, add it here in the same commit that adds it to the mask.
 *
 * This takes nothing away from board users or the workspace UI — neither passes through
 * `assertNoAgentHostWorkspaceCommandMutation`, which returns early for any non-agent actor.
 */
export function collectProjectWorkspaceCommandPaths(
  workspacePatch: unknown,
  prefix = "",
): string[] {
  if (!isRecord(workspacePatch)) return [];
  const paths: string[] = [];
  if (hasOwn(workspacePatch, "setupCommand")) {
    paths.push(prefixPath(prefix, "setupCommand"));
  }
  if (hasOwn(workspacePatch, "cleanupCommand")) {
    paths.push(prefixPath(prefix, "cleanupCommand"));
  }
  return paths;
}

export function collectIssueWorkspaceCommandPaths(input: {
  executionWorkspaceSettings?: unknown;
  assigneeAdapterOverrides?: unknown;
}): string[] {
  const paths: string[] = [];
  if (isRecord(input.executionWorkspaceSettings)) {
    paths.push(
      ...collectWorkspaceStrategyCommandPaths(
        input.executionWorkspaceSettings.workspaceStrategy,
        "executionWorkspaceSettings.workspaceStrategy",
      ),
    );
  }
  if (isRecord(input.assigneeAdapterOverrides)) {
    const adapterConfig = input.assigneeAdapterOverrides.adapterConfig;
    if (isRecord(adapterConfig)) {
      paths.push(
        ...collectWorkspaceStrategyCommandPaths(
          adapterConfig.workspaceStrategy,
          "assigneeAdapterOverrides.adapterConfig.workspaceStrategy",
        ),
      );
    }
  }
  return paths;
}

export function collectExecutionWorkspaceCommandPaths(input: {
  config?: unknown;
  metadata?: unknown;
}): string[] {
  const paths: string[] = [];
  if (input.config !== undefined) {
    paths.push(...collectExecutionWorkspaceConfigCommandPaths(input.config, "config"));
  }
  if (isRecord(input.metadata) && hasOwn(input.metadata, "config")) {
    paths.push(...collectExecutionWorkspaceConfigCommandPaths(input.metadata.config, "metadata.config"));
  }
  return paths;
}

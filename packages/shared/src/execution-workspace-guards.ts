import type { ExecutionWorkspace } from "./types/workspace-runtime.js";

type ExecutionWorkspaceGuardTarget = Pick<ExecutionWorkspace, "closedAt" | "mode" | "name" | "status">;

const CLOSED_EXECUTION_WORKSPACE_STATUSES = new Set<ExecutionWorkspace["status"]>(["archived", "cleanup_failed"]);

/**
 * Mode-independent: is this workspace closed, whatever kind it is?
 *
 * `ExecutionWorkspace.mode` persists five values, so the isolated-only variant
 * below reports `false` for four of them. Use this one whenever the reason you
 * care is "the directory may be gone" — that is true of an archived
 * `cloud_sandbox` or `shared_workspace` exactly as much as of an isolated
 * worktree.
 */
export function isClosedExecutionWorkspace(
  workspace: Pick<ExecutionWorkspaceGuardTarget, "closedAt" | "status"> | null | undefined,
): boolean {
  if (!workspace) return false;
  return workspace.closedAt != null || CLOSED_EXECUTION_WORKSPACE_STATUSES.has(workspace.status);
}

/**
 * Isolated-only. The `mode` narrowing is deliberate and load-bearing for the
 * "move it to an open workspace before commenting" path in `routes/issues.ts`,
 * which must not fire for shared or adapter-managed workspaces. If you only
 * care whether the directory still exists, use
 * {@link isClosedExecutionWorkspace} instead.
 */
export function isClosedIsolatedExecutionWorkspace(
  workspace: Pick<ExecutionWorkspaceGuardTarget, "closedAt" | "mode" | "status"> | null | undefined,
): boolean {
  if (!workspace) return false;
  if (workspace.mode !== "isolated_workspace") return false;
  return isClosedExecutionWorkspace(workspace);
}

export function getClosedIsolatedExecutionWorkspaceMessage(
  workspace: Pick<ExecutionWorkspaceGuardTarget, "name">,
): string {
  return `This issue is linked to the closed workspace "${workspace.name}". Move it to an open workspace before adding comments or resuming work.`;
}

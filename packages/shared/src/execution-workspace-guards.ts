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

// BLO-42036: the fields a patch may carry and still count as "detach this issue from its
// dead execution workspace" rather than as work inside it. Deliberately NOT the route's
// ISSUE_WORKSPACE_AUDIT_FIELDS, despite the overlap: that set decides what gets logged, so
// anything added to it for audit reasons would silently widen this security exemption.
const EXECUTION_WORKSPACE_DETACH_FIELDS = new Set([
  "executionWorkspaceId",
  "executionWorkspacePreference",
  "executionWorkspaceSettings",
]);

/**
 * BLO-42036. The closed-workspace 409 tells the caller to "move it to an open workspace",
 * and until this predicate existed no agent-reachable route could. The guard keys on
 * `closedAt`, which no exposed route accepts — the execution-workspace PATCH schema takes
 * `status`, and flipping that leaves `closedAt` set, so the issue kept 409ing while its
 * own error body read `status: "active"`. Archiving the workspace instead 409s the other
 * way ("still linked to an open issue"). A collected workspace therefore bricked its
 * source issue permanently, and alert rows were the common victim: they get isolated
 * workspaces, those get collected, and from then on the row could not even be commented
 * on during its own incident.
 *
 * True only when the patch's ONLY effect is detaching from (or rebinding off) the closed
 * workspace: it performs no work inside the dead workspace, and it cannot carry a comment,
 * a review request, or any other field along with it. Re-pinning the SAME closed workspace
 * is not a detach — otherwise the guard would be bypassable by echoing the current value.
 */
export function isExecutionWorkspaceDetachPatch(input: {
  updateFields: Record<string, unknown>;
  hasComment: boolean;
  hasReviewRequest: boolean;
  closedExecutionWorkspaceId: string;
}): boolean {
  if (input.hasComment || input.hasReviewRequest) return false;
  const keys = Object.keys(input.updateFields);
  if (!keys.every((key) => EXECUTION_WORKSPACE_DETACH_FIELDS.has(key))) return false;
  // Also covers the empty patch: `every` is vacuously true on no keys, and this rejects it.
  if (!Object.prototype.hasOwnProperty.call(input.updateFields, "executionWorkspaceId")) return false;
  return input.updateFields.executionWorkspaceId !== input.closedExecutionWorkspaceId;
}

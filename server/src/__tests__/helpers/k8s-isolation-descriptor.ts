import {
  buildK8sRunIsolationDescriptor,
  resolveK8sRunIsolationIdentity,
} from "../../services/heartbeat.ts";
import type { resolveExecutionWorkspaceMode } from "../../services/execution-workspace-policy.ts";

/**
 * BLO-31443: resolve an isolation identity from raw workspace inputs, then build
 * the descriptor from it — the two-step production does at
 * `resolveK8sRunIsolationIdentity` / `buildK8sRunIsolationDescriptor`.
 *
 * This lived inside `buildK8sRunIsolationDescriptor` as a fallback for callers
 * that omitted `isolationIdentity`. Production never omitted it, so the fallback
 * was reachable only from tests — and its `isWorkspaceIsolated` below is WIDER
 * than the `workspaceIsolationRequested` production feeds the same resolver, so
 * the two could disagree on `isolationMode` for equal input. It is a test
 * fixture, not a second production path: keep it here, where nothing can reach
 * it by accident, and never re-export it.
 *
 * `perIssueWorkspaceTreeKey` is always null: the tree key only ever reaches
 * `reservationKey`, and the descriptor has no reservation field to carry it.
 * Tests that care about the reservation key must assert on the identity.
 */
export function buildK8sRunIsolationDescriptorFromWorkspace(input: {
  adapterType: string | null | undefined;
  runId: string;
  companyId: string;
  agentId: string;
  taskKey: string | null;
  statelessPrReview: boolean;
  executionWorkspace: {
    cwd: string;
    source: string;
    strategy?: string | null;
  };
  persistedExecutionWorkspaceId?: string | null;
  persistedWorkspaceExplicitlySelected?: boolean;
  effectiveMaxConcurrentRuns?: number;
  effectiveExecutionWorkspaceMode: ReturnType<typeof resolveExecutionWorkspaceMode>;
}) {
  const isWorkspaceIsolated =
    input.effectiveExecutionWorkspaceMode === "isolated_workspace" ||
    input.effectiveExecutionWorkspaceMode === "operator_branch" ||
    input.executionWorkspace.source === "task_session" ||
    input.executionWorkspace.strategy === "git_worktree";
  return buildK8sRunIsolationDescriptor({
    runId: input.runId,
    companyId: input.companyId,
    agentId: input.agentId,
    taskKey: input.taskKey,
    statelessPrReview: input.statelessPrReview,
    executionWorkspace: input.executionWorkspace,
    persistedExecutionWorkspaceId: input.persistedExecutionWorkspaceId,
    isolationIdentity: resolveK8sRunIsolationIdentity({
      adapterType: input.adapterType,
      runId: input.runId,
      agentId: input.agentId,
      statelessPrReview: input.statelessPrReview,
      isWorkspaceIsolated,
      persistedExecutionWorkspaceId: input.persistedExecutionWorkspaceId,
      persistedWorkspaceExplicitlySelected: input.persistedWorkspaceExplicitlySelected,
      effectiveMaxConcurrentRuns: input.effectiveMaxConcurrentRuns ?? 1,
      perIssueWorkspaceTreeKey: null,
    }),
  });
}

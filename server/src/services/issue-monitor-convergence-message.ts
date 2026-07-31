import type { IssueMonitorGateSource } from "@paperclipai/shared";

/**
 * BLO-18294: rendering for the monitor convergence escalation.
 *
 * Kept out of the issues router because the point of this message is that the
 * next reader sees WHO can move the issue, not that a timer stopped — that is
 * worth testing directly rather than only through a route fixture.
 */
export type IssueUnblockOwner = {
  issueId: string;
  identifier: string | null;
  title: string | null;
  status: string;
  assigneeAgentId: string | null;
  assigneeAgentName: string | null;
  assigneeUserId: string | null;
};

export function monitorConvergenceComment(input: {
  convergence: { count: number; threshold: number; source: IssueMonitorGateSource };
  unblockOwners: IssueUnblockOwner[];
}): string {
  const { convergence, unblockOwners } = input;
  const lines = [
    `Monitor stopped re-arming: ${convergence.count} consecutive re-checks reported the same unresolved gate set ` +
      `(threshold ${convergence.threshold}, compared on \`${convergence.source}\`). ` +
      "Polling cannot narrow a gate that polling has already failed to narrow, so this issue is now `blocked`.",
    "",
  ];

  if (unblockOwners.length > 0) {
    lines.push("Unblock owners:");
    for (const owner of unblockOwners) {
      const who = owner.assigneeAgentId
        ? `[${owner.assigneeAgentName ?? "assignee"}](agent://${owner.assigneeAgentId})`
        : owner.assigneeUserId
          ? "a board user"
          : "**unassigned — needs an owner**";
      lines.push(
        `- ${owner.identifier ?? owner.issueId} (${owner.status}) — ${who}${owner.title ? `: ${owner.title}` : ""}`,
      );
    }
    return lines.join("\n");
  }

  // The notes-fallback path: nothing structured was ever declared, so there is
  // no owner to route to. Say what to do instead of leaving a dead end.
  lines.push(
    "No unresolved blocker edges are recorded on this issue, so there is no owner to route to. " +
      "Either model the real gate as a blocking issue (or declare it via `executionPolicy.monitor.gateSignals`) " +
      "and re-arm, or escalate it to a human — a human-only gate never resolves on a timer.",
  );
  return lines.join("\n");
}

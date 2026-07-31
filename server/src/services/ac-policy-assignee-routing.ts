/**
 * Filing-target selection for the weekly governance sweep (routine 8b764d66).
 *
 * The sweep reaches an issue's owner by filing a compliance issue against that
 * owner. When the owner cannot execute — `paused`, `terminated`,
 * `pending_approval`, or reporting through a broken org chain — the filing is a
 * wake nobody can answer, and the sweep regenerates it every Monday. BLO-19477
 * was filed against `Operator (devbox)`, a non-executing attribution agent that
 * has been `paused` with heartbeat disabled by design since 2026-05-29; the
 * issue also carried a populated `responsibleUserId`, so a reachable target
 * existed and was ignored (BLO-19598).
 *
 * Execution eligibility is `isAgentInvokable`, NOT `isAgentAssignableToWork`.
 * The two differ exactly on `paused`, which is assignable but never runs — and
 * `paused` is the status through which heartbeat-disabled agents manifest.
 *
 * This module only chooses a target. It creates nothing and mutates nothing.
 */
import {
  getAgentOrgChainHealth,
  getAgentWorkEligibility,
  isAgentInvokable,
  type AgentEligibilityAgent,
  type AgentEligibilityLifecycleReason,
} from "@paperclipai/shared";

export type AcPolicySweepAgent = AgentEligibilityAgent;

/** A non-executing agent passed over while resolving, nearest-first. */
export type AcPolicySkippedAgent = {
  id: string;
  name: string;
  status: string;
  /** Why it cannot execute, e.g. `paused`, `terminated`, `invalid_org_chain`. */
  reason: AgentEligibilityLifecycleReason;
};

export type AcPolicyAgentTargetReason = "assignee_executes" | "nearest_executing_manager";
export type AcPolicyUserTargetReason = "responsible_user";
export type AcPolicyUnroutableReason =
  | "no_executing_target"
  | "unknown_assignee"
  | "unassigned_and_unowned";

export type AcPolicyFilingTarget =
  | {
      kind: "agent";
      agentId: string;
      reason: AcPolicyAgentTargetReason;
      skipped: AcPolicySkippedAgent[];
    }
  | {
      kind: "user";
      userId: string;
      reason: AcPolicyUserTargetReason;
      skipped: AcPolicySkippedAgent[];
    }
  | {
      kind: "unroutable";
      reason: AcPolicyUnroutableReason;
      skipped: AcPolicySkippedAgent[];
    };

export type AcPolicyFilingTargetInput = {
  /** Owner of the non-compliant issue. */
  assigneeAgentId?: string | null;
  /** The issue's `responsibleUserId`, preferred over the manager chain. */
  responsibleUserId?: string | null;
  /** Every agent in the company — needed to walk `reportsTo` and judge org-chain health. */
  agents: AcPolicySweepAgent[];
};

function describeSkipped(
  agent: AcPolicySweepAgent,
  agents: AcPolicySweepAgent[],
): AcPolicySkippedAgent {
  return {
    id: agent.id,
    name: agent.name,
    status: String(agent.status),
    reason: getAgentWorkEligibility({ agent, agents }).invokabilityReason,
  };
}

/**
 * Choose who a compliance filing should go to.
 *
 * Precedence: the assignee when it can execute, else the issue's
 * `responsibleUserId`, else the nearest execution-eligible manager. Returns
 * `unroutable` rather than guessing when no reachable target exists — the sweep
 * reports those rows instead of filing against an agent that can never answer.
 */
export function resolveAcPolicyFilingTarget(
  input: AcPolicyFilingTargetInput,
): AcPolicyFilingTarget {
  const { assigneeAgentId = null, responsibleUserId = null, agents } = input;
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const assignee = assigneeAgentId ? (byId.get(assigneeAgentId) ?? null) : null;

  if (assignee && isAgentInvokable({ agent: assignee, agents })) {
    return { kind: "agent", agentId: assignee.id, reason: "assignee_executes", skipped: [] };
  }

  const skipped: AcPolicySkippedAgent[] = [];
  const seen = new Set<string>();
  if (assignee) {
    skipped.push(describeSkipped(assignee, agents));
    seen.add(assignee.id);
  }

  if (responsibleUserId) {
    return { kind: "user", userId: responsibleUserId, reason: "responsible_user", skipped };
  }

  if (assignee) {
    // `fullChain` is self-first then ancestors by increasing depth, and is
    // cycle-safe. Agents inside a cycle fail `isAgentInvokable` on org-chain
    // health, so a broken chain is never selected as a target.
    for (const entry of getAgentOrgChainHealth({ agent: assignee, agents }).fullChain) {
      if (entry.relation !== "ancestor") continue;
      const manager = byId.get(entry.id);
      // Synthetic `missing` / `cycle` placeholders have no agent record.
      if (!manager || seen.has(manager.id)) continue;
      if (isAgentInvokable({ agent: manager, agents })) {
        return {
          kind: "agent",
          agentId: manager.id,
          reason: "nearest_executing_manager",
          skipped,
        };
      }
      skipped.push(describeSkipped(manager, agents));
      seen.add(manager.id);
    }
  }

  if (!assigneeAgentId) {
    return { kind: "unroutable", reason: "unassigned_and_unowned", skipped };
  }
  return {
    kind: "unroutable",
    reason: assignee ? "no_executing_target" : "unknown_assignee",
    skipped,
  };
}

/** True when the sweep may file an issue against this owner as-is. */
export function isAcPolicyFilingTargetActionable(target: AcPolicyFilingTarget): boolean {
  return target.kind !== "unroutable";
}

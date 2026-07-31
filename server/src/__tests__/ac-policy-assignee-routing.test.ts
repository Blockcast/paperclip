import { describe, expect, it } from "vitest";
import {
  isAcPolicyFilingTargetActionable,
  resolveAcPolicyFilingTarget,
  type AcPolicySweepAgent,
} from "../services/ac-policy-assignee-routing.js";

const COMPANY = "aaced805-3491-4ee5-9b14-cdf70cb81d47";

function agent(
  id: string,
  status: string,
  reportsTo: string | null = null,
  name = id,
): AcPolicySweepAgent {
  return { id, companyId: COMPANY, name, status, reportsTo };
}

// Mirrors the real org shape from BLO-19598: a paused attribution agent
// reporting to a running CEO.
const CEO = agent("ceo", "running", null, "CEO");
const OPERATOR = agent("operator-devbox", "paused", "ceo", "Operator (devbox)");
const ENGINEER = agent("engineer", "idle", "ceo", "Engineer");

describe("AC-policy sweep filing-target selection", () => {
  it("leaves the target unchanged when the assignee can execute", () => {
    const target = resolveAcPolicyFilingTarget({
      assigneeAgentId: "engineer",
      responsibleUserId: null,
      agents: [CEO, OPERATOR, ENGINEER],
    });

    expect(target).toEqual({
      kind: "agent",
      agentId: "engineer",
      reason: "assignee_executes",
      skipped: [],
    });
  });

  it("prefers an executing assignee over a populated responsibleUserId", () => {
    const target = resolveAcPolicyFilingTarget({
      assigneeAgentId: "engineer",
      responsibleUserId: "user-1",
      agents: [CEO, OPERATOR, ENGINEER],
    });

    expect(target).toMatchObject({ kind: "agent", agentId: "engineer" });
  });

  it("routes a non-executing assignee to responsibleUserId when one is set", () => {
    // The BLO-19477 shape: the sweep filed against Operator (devbox) even
    // though the issue already carried a reachable responsibleUserId.
    const target = resolveAcPolicyFilingTarget({
      assigneeAgentId: "operator-devbox",
      responsibleUserId: "oAfDyNGXF5wi8ozojnxTheOPYGFsWDDQ",
      agents: [CEO, OPERATOR, ENGINEER],
    });

    expect(target).toEqual({
      kind: "user",
      userId: "oAfDyNGXF5wi8ozojnxTheOPYGFsWDDQ",
      reason: "responsible_user",
      skipped: [
        {
          id: "operator-devbox",
          name: "Operator (devbox)",
          status: "paused",
          reason: "paused",
        },
      ],
    });
  });

  it("routes a non-executing assignee with no responsibleUserId to the nearest executing manager", () => {
    const target = resolveAcPolicyFilingTarget({
      assigneeAgentId: "operator-devbox",
      responsibleUserId: null,
      agents: [CEO, OPERATOR, ENGINEER],
    });

    expect(target).toMatchObject({
      kind: "agent",
      agentId: "ceo",
      reason: "nearest_executing_manager",
    });
    expect(target.skipped.map((entry) => entry.id)).toEqual(["operator-devbox"]);
  });

  it("walks past a non-executing manager to the nearest executing ancestor", () => {
    const pausedLead = agent("lead", "paused", "ceo", "Lead");
    const target = resolveAcPolicyFilingTarget({
      assigneeAgentId: "operator-devbox",
      responsibleUserId: null,
      agents: [CEO, pausedLead, agent("operator-devbox", "paused", "lead", "Operator (devbox)")],
    });

    expect(target).toMatchObject({ kind: "agent", agentId: "ceo" });
    expect(target.skipped.map((entry) => entry.id)).toEqual(["operator-devbox", "lead"]);
  });

  it("treats terminated assignees as non-executing", () => {
    const target = resolveAcPolicyFilingTarget({
      assigneeAgentId: "gone",
      responsibleUserId: null,
      agents: [CEO, agent("gone", "terminated", "ceo", "Gone")],
    });

    expect(target).toMatchObject({ kind: "agent", agentId: "ceo" });
    expect(target.skipped[0]).toMatchObject({ id: "gone", reason: "terminated" });
  });

  it("reports unroutable when no ancestor can execute", () => {
    const target = resolveAcPolicyFilingTarget({
      assigneeAgentId: "operator-devbox",
      responsibleUserId: null,
      agents: [agent("ceo", "paused", null, "CEO"), OPERATOR],
    });

    expect(target).toMatchObject({ kind: "unroutable", reason: "no_executing_target" });
    expect(target.skipped.map((entry) => entry.id)).toEqual(["operator-devbox", "ceo"]);
    expect(isAcPolicyFilingTargetActionable(target)).toBe(false);
  });

  it("terminates on a reporting cycle instead of looping", () => {
    // Every agent in a cycle fails org-chain health, so none is selectable.
    const target = resolveAcPolicyFilingTarget({
      assigneeAgentId: "a",
      responsibleUserId: null,
      agents: [agent("a", "paused", "b"), agent("b", "idle", "a")],
    });

    expect(target).toMatchObject({ kind: "unroutable", reason: "no_executing_target" });
    expect(target.skipped.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("does not select a manager whose own org chain is broken", () => {
    // `lead` is idle but reports through a terminated ancestor.
    const target = resolveAcPolicyFilingTarget({
      assigneeAgentId: "operator-devbox",
      responsibleUserId: null,
      agents: [
        agent("root", "terminated", null, "Root"),
        agent("lead", "idle", "root", "Lead"),
        agent("operator-devbox", "paused", "lead", "Operator (devbox)"),
      ],
    });

    expect(target).toMatchObject({ kind: "unroutable", reason: "no_executing_target" });
    expect(target.skipped.map((entry) => entry.reason)).toEqual([
      "paused",
      "invalid_org_chain",
      "terminated",
    ]);
  });

  it("falls back to responsibleUserId when the assignee agent is unknown", () => {
    const target = resolveAcPolicyFilingTarget({
      assigneeAgentId: "ghost",
      responsibleUserId: "user-1",
      agents: [CEO],
    });

    expect(target).toMatchObject({ kind: "user", userId: "user-1", skipped: [] });
  });

  it("reports an unknown assignee with no responsibleUserId as unroutable", () => {
    const target = resolveAcPolicyFilingTarget({
      assigneeAgentId: "ghost",
      responsibleUserId: null,
      agents: [CEO],
    });

    expect(target).toMatchObject({ kind: "unroutable", reason: "unknown_assignee" });
  });

  it("routes an unassigned issue to responsibleUserId, else reports it unroutable", () => {
    expect(
      resolveAcPolicyFilingTarget({
        assigneeAgentId: null,
        responsibleUserId: "user-1",
        agents: [CEO],
      }),
    ).toMatchObject({ kind: "user", userId: "user-1" });

    expect(
      resolveAcPolicyFilingTarget({ assigneeAgentId: null, responsibleUserId: null, agents: [CEO] }),
    ).toMatchObject({ kind: "unroutable", reason: "unassigned_and_unowned" });
  });

  it("never returns a non-executing agent as the filing target", () => {
    const agents = [
      CEO,
      OPERATOR,
      ENGINEER,
      agent("terminated-ic", "terminated", "ceo"),
      agent("pending-ic", "pending_approval", "ceo"),
    ];

    for (const candidate of agents) {
      const target = resolveAcPolicyFilingTarget({
        assigneeAgentId: candidate.id,
        responsibleUserId: null,
        agents,
      });
      if (target.kind !== "agent") continue;
      const picked = agents.find((entry) => entry.id === target.agentId);
      expect(picked?.status).not.toBe("paused");
      expect(picked?.status).not.toBe("terminated");
      expect(picked?.status).not.toBe("pending_approval");
    }
  });
});

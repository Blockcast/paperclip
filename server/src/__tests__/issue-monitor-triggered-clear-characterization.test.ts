import { describe, expect, it } from "vitest";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.js";

/**
 * BLO-27586 AC1 — CHARACTERIZATION. These assertions pin the CURRENT, DEFECTIVE
 * behaviour so the defect is reproducible in one command. They are NOT a spec.
 *
 * When the monitor-only write path (BLO-18816) lands, the first case must be
 * INVERTED — a clear has to clear — not deleted. If you are reading this because
 * it started failing, that is probably the fix working.
 */
const agentId = "11111111-1111-4111-8111-111111111111";

// A monitor that has already fired: the trigger wrote executionState.monitor =
// triggered / nextCheckAt null AND stripped `monitor` out of executionPolicy
// (buildIssueMonitorTriggeredPatch -> stripMonitorFromExecutionPolicy, which
// returns null outright for a monitor-only policy).
const triggeredIssue = () => ({
  status: "in_progress",
  assigneeAgentId: agentId,
  assigneeUserId: null,
  executionPolicy: null,
  executionState: {
    status: "idle",
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: null,
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: {
      status: "triggered",
      nextCheckAt: null,
      lastTriggeredAt: "2026-08-06T10:00:00.000Z",
      attemptCount: 2,
      notes: "Awaiting CI + Copilot review on head b231d2d2d",
      scheduledBy: "assignee",
      clearedAt: null,
      clearReason: null,
    },
  } as never,
  monitorNextCheckAt: null,
  monitorLastTriggeredAt: new Date("2026-08-06T10:00:00.000Z"),
  monitorAttemptCount: 2,
  monitorNotes: "Awaiting CI + Copilot review on head b231d2d2d",
  monitorScheduledBy: "assignee",
});

const transition = (policy: unknown, monitorExplicitlyUpdated: boolean) =>
  applyIssueExecutionPolicyTransition({
    issue: triggeredIssue(),
    policy: normalizeIssueExecutionPolicy(policy as never),
    requestedAssigneePatch: {},
    actor: { agentId },
    unresolvedBlockerIssueIds: [],
    monitorExplicitlyUpdated,
  }).patch as {
    executionState?: { monitor?: { status?: string; notes?: string; clearReason?: string } };
    monitorNotes?: unknown;
    monitorNextCheckAt?: unknown;
  };

describe("BLO-27586 AC1 — clearing a `triggered` monitor", () => {
  it("PATCH {executionPolicy:{}} leaves the monitor byte-identical and keeps the stale notes", () => {
    // monitorExplicitlyUpdated is FALSE at the route: monitorPoliciesEqual
    // compares `policy.monitor ?? null` on both sides, and the trigger already
    // removed the monitor from executionPolicy -> null === null -> no change.
    const patch = transition({}, false);

    expect(patch.executionState?.monitor).toMatchObject({
      status: "triggered",
      clearReason: null,
      notes: "Awaiting CI + Copilot review on head b231d2d2d",
    });
    // No clear ran, so the armed-monitor columns are never nulled.
    expect(patch).not.toHaveProperty("monitorNotes");
    expect(patch).not.toHaveProperty("monitorNextCheckAt");
  });

  it("re-arming IS an escape — while the monitor has attempts left", () => {
    const patch = transition(
      { monitor: { nextCheckAt: "2026-12-01T00:00:00.000Z", scheduledBy: "assignee", maxAttempts: 5 } },
      true,
    );
    expect(patch.executionState?.monitor).toMatchObject({ status: "scheduled" });
  });

  it("re-arming is NOT an escape once attempts are exhausted — 422, so the row has no exit", () => {
    expect(() =>
      transition(
        { monitor: { nextCheckAt: "2026-12-01T00:00:00.000Z", scheduledBy: "assignee", maxAttempts: 2 } },
        true,
      ),
    ).toThrowError(/bounds|exhaust/i);
  });
});

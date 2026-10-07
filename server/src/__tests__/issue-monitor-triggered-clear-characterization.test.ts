import { describe, expect, it } from "vitest";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.js";

/**
 * BLO-27586 AC1 / BLO-18816 — a `triggered` monitor must have a clear path.
 *
 * This file began as a CHARACTERIZATION of the defect: a clear against a fired
 * monitor returned 200 with the monitor byte-identical and the stale notes
 * intact, because `buildIssueMonitorTriggeredPatch` had already stripped
 * `monitor` out of `executionPolicy`, so both clear gates read a field that was
 * gone. Case 1 is now INVERTED — a clear has to clear — and case 4 pins the
 * constraint that makes the fix safe.
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
  it("clears the monitor and drops the stale notes", () => {
    // `monitorExplicitlyUpdated` is TRUE here because the caller wrote the
    // monitor: via `DELETE /issues/:id/monitor`, which always sets it, or via
    // `PATCH {executionPolicy:{}}`, where the route now treats "explicit policy
    // write carrying no monitor while a live one exists" as a change rather
    // than diffing a field the trigger already deleted.
    const patch = transition({}, true);

    expect(patch.executionState?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "manual",
    });
    // PEN-1995: the armed-monitor columns are nulled, so the next run does not
    // inherit a retired monitor's notes as a live gate.
    expect(patch.monitorNotes).toBeNull();
    expect(patch.monitorNextCheckAt).toBeNull();
  });

  it("clears an EXHAUSTED triggered monitor, which the re-arm escape hatch cannot", () => {
    // attemptCount 2 survives a re-arm, so `maxAttempts: 2` 422s below. A clear
    // reads no bounds at all, so it is the exit that always exists.
    const patch = transition({}, true);
    expect(patch.executionState?.monitor).toMatchObject({ status: "cleared" });
  });

  it("re-arming IS an escape — while the monitor has attempts left", () => {
    const patch = transition(
      { monitor: { nextCheckAt: "2026-12-01T00:00:00.000Z", scheduledBy: "assignee", maxAttempts: 5 } },
      true,
    );
    expect(patch.executionState?.monitor).toMatchObject({ status: "scheduled" });
  });

  it("re-arming is NOT an escape once attempts are exhausted — 422", () => {
    expect(() =>
      transition(
        { monitor: { nextCheckAt: "2026-12-01T00:00:00.000Z", scheduledBy: "assignee", maxAttempts: 2 } },
        true,
      ),
    ).toThrowError(/bounds|exhaust/i);
  });

  it("leaves the `triggered` state intact when the monitor was NOT explicitly written", () => {
    // The constraint that makes the fix safe. `tickExpiredIssueMonitors` selects
    // on `triggered` to run the monitor's `recoveryPolicy`; if an incidental
    // carry-forward transition (a status-only return, a stage auto-approval)
    // cleared the monitor, that sweep would be silently cancelled — strictly
    // worse than the visible no-op this change removes.
    const patch = transition({}, false);

    expect(patch.executionState?.monitor).toMatchObject({
      status: "triggered",
      clearReason: null,
      notes: "Awaiting CI + Copilot review on head b231d2d2d",
    });
    expect(patch).not.toHaveProperty("monitorNotes");
    expect(patch).not.toHaveProperty("monitorNextCheckAt");
  });
});

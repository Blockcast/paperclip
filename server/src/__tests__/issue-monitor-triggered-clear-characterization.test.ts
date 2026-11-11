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

type MonitorPatch = {
  executionState?: { monitor?: { status?: string; notes?: string; clearReason?: string } };
  monitorNotes?: unknown;
  monitorNextCheckAt?: unknown;
};

const transitionWith = (
  policy: unknown,
  monitorExplicitlyUpdated: boolean,
  move: {
    requestedStatus?: string;
    requestedAssigneePatch?: { assigneeAgentId?: string | null; assigneeUserId?: string | null };
  } = {},
) =>
  applyIssueExecutionPolicyTransition({
    issue: triggeredIssue(),
    policy: normalizeIssueExecutionPolicy(policy as never),
    requestedAssigneePatch: move.requestedAssigneePatch ?? {},
    ...(move.requestedStatus === undefined ? {} : { requestedStatus: move.requestedStatus }),
    actor: { agentId },
    unresolvedBlockerIssueIds: [],
    monitorExplicitlyUpdated,
  }).patch as MonitorPatch;

const transition = (policy: unknown, monitorExplicitlyUpdated: boolean) =>
  transitionWith(policy, monitorExplicitlyUpdated);

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
      // PEN-5902: and the ARCHIVED copy too. This test was named "drops the
      // stale notes" while asserting only the column, which is exactly the
      // half-truth the tool description carried — the clear returned 200 and
      // left this field byte-identical.
      notes: null,
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

/**
 * PEN-6202 — the SERVICE-LAYER twin of `buildIssueMonitorEligibilityPatch`.
 *
 * The block above pins what a monitor write does to a FIRED monitor. This one
 * pins what an ORDINARY write does — one that moves status or assignee and
 * never mentions the monitor at all.
 *
 * Before the fix, `applyMonitorTransition` reached its clear only via
 * `previousPolicy.monitor` (stripped at trigger time) or
 * `monitorExplicitlyUpdated` (false here), so a `PATCH /api/issues/:id` that
 * demoted such a row out of `in_progress`/`in_review` left the monitor
 * `triggered` FOREVER: `tickExpiredIssueMonitors` is the only net that clears a
 * fired monitor and its outer `where` carries exactly the eligibility the row
 * had just lost.
 *
 * Measured across all 5,615 company rows on 2026-11-08: 19 non-terminal rows
 * held a permanently unclearable `triggered` monitor, 3 of them for 91-106 days,
 * every one watching a pull request that had already merged. The sharpest wrote
 * its final note seven minutes AFTER the merge it was reporting as still open.
 */
describe("PEN-6202 — an ordinary write that makes the row INELIGIBLE", () => {
  it("clears a fired monitor when the row is demoted out of the monitor window", () => {
    // The demotion a checkout release performs through the service layer. The
    // monitor is never mentioned: `monitorExplicitlyUpdated` is false and the
    // requested policy is empty.
    const patch = transitionWith({}, false, { requestedStatus: "todo" });

    expect(patch.executionState?.monitor).toMatchObject({
      status: "cleared",
      // NOT "manual" — the reason has to name what actually retired it, because
      // this row's attribution ledger reads `clearReason` to tell a scheduler
      // clear from an assignee's deliberate one.
      clearReason: "invalid_status",
    });
    expect(patch.monitorNextCheckAt).toBeNull();
  });

  it("clears a fired monitor when the row loses its agent assignee", () => {
    // The OTHER axis of ineligibility, and the one that stranded the single row
    // outside every agent intake surface (PEN-2077: `in_review`, human-held,
    // 91 days on a gate that had been satisfied the whole time). A fix keyed on
    // status alone does not reach it.
    const patch = transitionWith({}, false, {
      requestedAssigneePatch: { assigneeAgentId: null, assigneeUserId: null },
    });

    expect(patch.executionState?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "invalid_assignee",
    });
  });

  it("MUST NOT fire while the row is still ELIGIBLE — the recovery wake is not ours to cancel", () => {
    // The discrimination control, and the constraint that makes the fix safe.
    // `in_progress` -> `in_review` keeps the row inside the monitor window, so
    // `tickExpiredIssueMonitors` can still reach it and still owes it the
    // monitor's `recoveryPolicy`. Clearing here would trade a visible no-op for
    // a silent cancellation — strictly worse than the defect.
    //
    // Without this case the two above are satisfied by a transition that clears
    // UNCONDITIONALLY, which is the naive fix the comment at the call site
    // rejects.
    const patch = transitionWith({}, false, { requestedStatus: "in_review" });

    expect(patch.executionState?.monitor).toMatchObject({
      status: "triggered",
      clearReason: null,
      notes: "Awaiting CI + Copilot review on head b231d2d2d",
    });
  });

  it("MUST NOT change when `MONITOR_INVALID_MESSAGE` throws — the 422 arm is untouched", () => {
    // The widened `ineligibleReason` is computed unconditionally, but
    // `invalidReason` keeps its own `policy.monitor` gate, so the throwing arm
    // is reachable only with a LIVE `policy.monitor`. A fired monitor has none
    // by construction, so an ineligible demotion that carries no monitor must
    // still return a patch rather than a 422.
    expect(() => transitionWith({}, false, { requestedStatus: "done" })).not.toThrow();

    // ...while an EXPLICIT arm against an ineligible row still throws, exactly
    // as it did before. (`maxAttempts: 5` keeps the bounds arm out of the way,
    // so this asserts the invalid-status arm and not the exhausted one.)
    expect(() =>
      transitionWith(
        { monitor: { nextCheckAt: "2026-12-01T00:00:00.000Z", scheduledBy: "assignee", maxAttempts: 5 } },
        true,
        { requestedStatus: "todo" },
      ),
    ).toThrowError(/monitor/i);
  });
});

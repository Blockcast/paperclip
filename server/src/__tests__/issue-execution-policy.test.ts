import { describe, expect, it } from "vitest";
import { renewedIssueMonitorMaxAttempts } from "@paperclipai/shared";
import {
  DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS,
  applyIssueExecutionPolicyTransition,
  applyIssueMonitorPolicyTransition,
  buildIssueMonitorClearedPatch,
  buildIssueMonitorEligibilityPatch,
  derivePersistedMonitorState,
  exhaustedMonitorClearReason,
  isMonitorNextCheckAtLive,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
  stripMonitorFromExecutionPolicy,
} from "../services/issue-execution-policy.js";
import type { IssueExecutionPolicy, IssueExecutionState } from "@paperclipai/shared";

const coderAgentId = "11111111-1111-4111-8111-111111111111";
const qaAgentId = "22222222-2222-4222-8222-222222222222";
const ctoAgentId = "33333333-3333-4333-8333-333333333333";
const ctoUserId = "cto-user";
const boardUserId = "board-user";

describe("buildIssueMonitorEligibilityPatch", () => {
  it("clears an armed monitor after an agent assignee is removed", () => {
    const patch = buildIssueMonitorEligibilityPatch({
      status: "in_progress",
      assigneeAgentId: null,
      assigneeUserId: null,
      monitorNextCheckAt: new Date("2026-08-31T17:00:00.000Z"),
      executionPolicy: {
        monitor: { nextCheckAt: "2026-08-31T17:00:00.000Z", scheduledBy: "assignee" },
      },
    });

    expect(patch).toMatchObject({
      monitorNextCheckAt: null,
      monitorWakeRequestedAt: null,
      monitorNotes: null,
    });
    expect((patch.executionState as { monitor?: { status?: string; clearReason?: string } }).monitor)
      .toMatchObject({ status: "cleared", clearReason: "invalid_assignee" });
  });

  it("clears an armed monitor after an active issue is demoted", () => {
    const patch = buildIssueMonitorEligibilityPatch({
      status: "todo",
      assigneeAgentId: coderAgentId,
      assigneeUserId: null,
      monitorNextCheckAt: new Date("2026-08-31T17:00:00.000Z"),
      executionPolicy: {
        monitor: { nextCheckAt: "2026-08-31T17:00:00.000Z", scheduledBy: "assignee" },
      },
    });

    expect((patch.executionState as { monitor?: { status?: string; clearReason?: string } }).monitor)
      .toMatchObject({ status: "cleared", clearReason: "invalid_status" });
  });

  // BLO-29974: `escalateStrandedAssignedIssue` writes a *computed* status, and it is a
  // service-layer write, so nothing upstream clears a monitor the new status makes
  // undeliverable. The caller therefore has to evaluate eligibility against the status
  // it is about to write, not the one the row currently holds. Passing the unmodified
  // row is the silent-failure mode this pins: the row still reads `in_progress`, the
  // patch comes back `{}`, and the monitor survives as a false-live wake path.
  it("clears when evaluated against a post-write escalation status the row does not hold yet", () => {
    const armed = {
      status: "in_progress",
      assigneeAgentId: coderAgentId,
      assigneeUserId: null,
      monitorNextCheckAt: new Date("2026-09-19T10:07:00.000Z"),
      executionPolicy: {
        monitor: { nextCheckAt: "2026-09-19T10:07:00.000Z", scheduledBy: "assignee" },
      },
    };

    // Evaluated against the row as-is, there is nothing to do — this is the trap.
    expect(buildIssueMonitorEligibilityPatch(armed)).toEqual({});

    const patch = buildIssueMonitorEligibilityPatch({ ...armed, status: "blocked" });
    expect(patch.monitorNextCheckAt).toBeNull();
    expect((patch.executionState as { monitor?: { status?: string; clearReason?: string } }).monitor)
      .toMatchObject({ status: "cleared", clearReason: "invalid_status" });
  });

  // BLO-27635 leaves a capacity strand dispatchable rather than writing `blocked`. That
  // branch must keep its monitor, so the unconditional spread has to stay a no-op there.
  it("leaves the monitor armed when the escalation status still allows one", () => {
    expect(
      buildIssueMonitorEligibilityPatch({
        status: "in_review",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        monitorNextCheckAt: new Date("2026-09-19T10:07:00.000Z"),
        executionPolicy: {
          monitor: { nextCheckAt: "2026-09-19T10:07:00.000Z", scheduledBy: "assignee" },
        },
      }),
    ).toEqual({});
  });
});

// PEN-5343: `paperclip-plugin-alertmanager` cancels an alert row when its alert
// resolves and reopens it when the alert re-fires, so an alert row is a
// *recycled* row rather than a terminal one. Each cancel clears the assignee's
// armed monitor: 13 of 13 `issue.monitor_cleared_undeliverable` events on
// PEN-4365 and PEN-4261 paired with a plugin cancel within 3-26 s, and not one
// of those monitors had fired — they were destroyed between 1h01m and 14h43m
// early.
//
// Clearing is correct (a cancelled row genuinely cannot deliver a wake). What
// was wrong is that the due time was the one piece of the armed monitor the
// clear did not keep, so the row could not answer "was a wake owed here, and
// when" without a per-issue activity-feed pull. These pin the due time onto the
// row's own cleared state.
describe("buildIssueMonitorClearedPatch records the destroyed due time (PEN-5343)", () => {
  const armedAt = "2026-11-03T12:30:00.000Z";
  const armed = {
    status: "in_progress",
    assigneeAgentId: coderAgentId,
    assigneeUserId: null,
    monitorNextCheckAt: new Date(armedAt),
    monitorNotes: "re-check the PEN-5294 gate",
    executionPolicy: {
      monitor: { nextCheckAt: armedAt, scheduledBy: "assignee" as const, notes: "re-check the PEN-5294 gate" },
    },
  };

  const monitorOf = (patch: Record<string, unknown>) =>
    (patch.executionState as { monitor?: Record<string, unknown> }).monitor!;

  // `issueExecutionStateSchema` requires the whole stage block; a partial
  // object fails `safeParse` and `parseIssueExecutionState` hands back null,
  // which would silently make these assertions vacuous.
  const stateWithMonitor = (monitor: Record<string, unknown>) =>
    ({
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
      monitor,
    }) as unknown as IssueExecutionState;

  it("keeps the due time the plugin's cancel destroyed", () => {
    // The alert resolved while no run held the row: exactly the 11-02T21:46:42Z
    // cancel that took a monitor due 14h43m later.
    const monitor = monitorOf(buildIssueMonitorEligibilityPatch({ ...armed, status: "cancelled" }));

    expect(monitor).toMatchObject({
      status: "cleared",
      clearReason: "cancelled",
      // Still nulled — the monitor really is gone, and nothing should read
      // this row as holding a live wake.
      nextCheckAt: null,
      clearedNextCheckAt: armedAt,
    });
  });

  it("distinguishes a destroyed monitor from a row that never armed one", () => {
    const destroyed = monitorOf(buildIssueMonitorEligibilityPatch({ ...armed, status: "cancelled" }));
    expect(destroyed.clearedNextCheckAt).toBe(armedAt);

    // A row that never armed a monitor produces no patch at all, so there is
    // no cleared state to confuse with the above. This is the discrimination
    // the top-level columns cannot make: `monitorAttemptCount` reads 0 on both
    // (8 of the 9 PEN-4365 casualties were destroyed at attempt 0).
    expect(
      buildIssueMonitorEligibilityPatch({
        status: "cancelled",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        monitorNextCheckAt: null,
      }),
    ).toEqual({});
  });

  it("does not erase the original due time when an already-cleared monitor is re-cleared", () => {
    // The plugin flaps: 64 status transitions on PEN-4365 in 14 days, all
    // plugin-authored. A second clear arrives with `nextCheckAt` already null,
    // so a naive assignment would overwrite the record with null and lose the
    // only evidence that a wake was ever owed.
    const first = monitorOf(buildIssueMonitorEligibilityPatch({ ...armed, status: "cancelled" }));
    expect(first.clearedNextCheckAt).toBe(armedAt);

    const second = buildIssueMonitorClearedPatch({
      issue: {
        status: "cancelled",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        monitorNextCheckAt: null,
        executionState: stateWithMonitor(first),
      },
      policy: null,
      clearReason: "cancelled",
    });

    expect(monitorOf(second)).toMatchObject({
      status: "cleared",
      clearReason: "cancelled",
      clearedNextCheckAt: armedAt,
    });
  });

  it("leaves nothing owed on a fresh arm", () => {
    // Re-arming after a destroyed wake must not keep advertising the dead one:
    // PEN-4365 was re-armed for 12:30Z after the 21:47Z loss, and that new
    // monitor owes nothing to the old.
    const policy = normalizeIssueExecutionPolicy({
      stages: [],
      monitor: { nextCheckAt: "2099-11-04T09:00:00.000Z", scheduledBy: "assignee" },
    })!;

    const rearmed = applyIssueMonitorPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        executionPolicy: null,
        executionState: stateWithMonitor(
          monitorOf(buildIssueMonitorEligibilityPatch({ ...armed, status: "cancelled" })),
        ),
        monitorAttemptCount: 0,
        monitorNextCheckAt: null,
        monitorLastTriggeredAt: null,
        monitorNotes: null,
        monitorScheduledBy: "assignee",
      },
      policy,
      previousPolicy: null,
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      monitorExplicitlyUpdated: true,
    });

    expect(monitorOf(rearmed.patch)).toMatchObject({
      status: "scheduled",
      nextCheckAt: "2099-11-04T09:00:00.000Z",
      clearedNextCheckAt: null,
    });
  });

  // The field is only useful if "not recorded" and "nothing was owed" stay
  // apart. They are one `prefault(null)` away from collapsing: the validator
  // would fill the key in at parse time, `parseIssueExecutionState` runs every
  // stored blob through it, and the `cleared` branch of
  // `derivePersistedMonitorState` spreads the parsed state straight back out —
  // so the next write would materialise `null` on a row cleared before this
  // field existed, and a sweep would read a destroyed monitor as a clean one.
  // That is the false negative the field exists to remove, so pin it.
  describe("a row cleared before this field existed stays 'not recorded'", () => {
    // Verbatim shape of a pre-PEN-5343 cleared monitor: no `clearedNextCheckAt`
    // key at all.
    const legacyCleared = {
      status: "cleared",
      nextCheckAt: null,
      lastTriggeredAt: null,
      attemptCount: 0,
      notes: "re-check the PEN-5294 gate",
      scheduledBy: "assignee",
      clearedAt: "2026-11-02T21:47:03.771Z",
      clearReason: "cancelled",
    } as const;

    it("survives parseIssueExecutionState without materialising null", () => {
      const parsed = parseIssueExecutionState(stateWithMonitor({ ...legacyCleared }));

      expect(parsed?.monitor?.status).toBe("cleared");
      expect(parsed?.monitor && "clearedNextCheckAt" in parsed.monitor).toBe(false);
    });

    it("is not materialised by the re-persist path", () => {
      // This is the mechanism itself: the `cleared` branch of
      // `derivePersistedMonitorState` spreads the parsed state straight back
      // out, and `executionStateWithMonitor` re-persists that on any later
      // stage or monitor write. If the key were prefaulted in at parse time,
      // this is where the `null` would get written at rest.
      const parsed = parseIssueExecutionState(stateWithMonitor({ ...legacyCleared }));
      expect(parsed?.monitor?.status).toBe("cleared");

      const derived = derivePersistedMonitorState({
        issue: {
          status: "cancelled",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          monitorNextCheckAt: null,
          monitorLastTriggeredAt: null,
          monitorAttemptCount: 0,
          monitorNotes: null,
          monitorScheduledBy: "assignee",
        },
        state: parsed,
        policy: null,
      });

      expect(derived?.status).toBe("cleared");
      expect(derived && "clearedNextCheckAt" in derived).toBe(false);

      // And because `monitorStatesEqual` compares via `JSON.stringify`, which
      // drops absent keys, the untouched row still compares equal to itself —
      // so re-deriving it writes nothing rather than churning one row per clear.
      expect(JSON.stringify(derived)).toBe(JSON.stringify(parsed?.monitor));
    });

    it("is not invented by a re-clear that has no due time to record", () => {
      // The flap re-clears the row. `previous.nextCheckAt` is null and the
      // original was never recorded, so there is nothing to carry forward —
      // and writing `null` here would assert "no wake was owed" about a row
      // whose wake we simply never captured.
      const recleared = buildIssueMonitorClearedPatch({
        issue: {
          status: "cancelled",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          monitorNextCheckAt: null,
          executionState: stateWithMonitor({ ...legacyCleared }),
        },
        policy: null,
        clearReason: "done",
      });

      const monitor = monitorOf(recleared);
      expect(monitor.status).toBe("cleared");
      expect("clearedNextCheckAt" in monitor).toBe(false);
    });

    it("still records null when a clear genuinely finds nothing owed", () => {
      // The contrast case: a monitor that really was holding no due time. This
      // one must write `null`, not absence, or the two collapse the other way.
      const triggered = {
        ...legacyCleared,
        status: "triggered",
        clearedAt: null,
        clearReason: null,
        lastTriggeredAt: "2026-11-02T20:00:00.000Z",
        attemptCount: 1,
      } as const;

      const monitor = monitorOf(
        buildIssueMonitorClearedPatch({
          issue: {
            status: "cancelled",
            assigneeAgentId: coderAgentId,
            assigneeUserId: null,
            monitorNextCheckAt: null,
            executionState: stateWithMonitor({ ...triggered }),
          },
          policy: null,
          clearReason: "cancelled",
        }),
      );

      expect(monitor).toMatchObject({ status: "cleared", clearedNextCheckAt: null });
      expect("clearedNextCheckAt" in monitor).toBe(true);
    });
  });
});

function makePolicy(
  stages: Array<{ type: "review" | "approval"; participants: Array<{ type: "agent" | "user"; agentId?: string; userId?: string }> }>,
) {
  return normalizeIssueExecutionPolicy({ stages })!;
}

function twoStagePolicy() {
  return makePolicy([
    { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
    { type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
  ]);
}

function reviewOnlyPolicy() {
  return makePolicy([
    { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
  ]);
}

function approvalOnlyPolicy() {
  return makePolicy([
    { type: "approval", participants: [{ type: "user", userId: ctoUserId }] },
  ]);
}

/**
 * PEN-5346: `recoveryEmittedAt` is the persisted answer to "has the obligation
 * this clear destroyed been handed to a carrier that survives the clear?".
 * `reconcileCancelledIssueMonitorRecoveries` selects on it, so these four
 * assertions are what make that selection sound: a clear must owe a handoff, an
 * arm must owe nothing, a later clear must not inherit an earlier discharge,
 * and a row written before the field existed must read as owing one.
 */
describe("monitor recovery handoff bookkeeping (PEN-5346)", () => {
  const armedPolicy = () =>
    normalizeIssueExecutionPolicy({
      stages: [],
      monitor: { nextCheckAt: "2099-04-11T12:30:00.000Z", scheduledBy: "assignee", notes: "waiting on a merge" },
    })!;

  function monitorOf(state: unknown) {
    return (state as { monitor?: Record<string, unknown> } | null)?.monitor ?? null;
  }

  it("leaves a fresh cancel owing a handoff", () => {
    const policy = armedPolicy();
    const patch = buildIssueMonitorClearedPatch({
      issue: {
        status: "cancelled",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: null,
        monitorNextCheckAt: new Date("2099-04-11T12:30:00.000Z"),
      },
      policy,
      clearReason: "cancelled",
    });

    expect(monitorOf(patch.executionState)).toMatchObject({
      status: "cleared",
      clearReason: "cancelled",
      recoveryEmittedAt: null,
    });
  });

  it("does not let a later clear inherit an earlier clear's discharge", () => {
    // The flapping shape: handed back once, re-armed, cancelled again. The
    // second cancel destroys a DIFFERENT monitor and owes its own handoff —
    // inheriting the stamp would silently drop it.
    const policy = armedPolicy();
    const patch = buildIssueMonitorClearedPatch({
      issue: {
        status: "cancelled",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          monitor: {
            status: "cleared",
            clearedAt: "2026-11-02T23:33:08.000Z",
            clearReason: "cancelled",
            recoveryEmittedAt: "2026-11-02T23:34:00.000Z",
          },
        } as unknown as IssueExecutionState,
        monitorNextCheckAt: new Date("2099-04-11T12:30:00.000Z"),
      },
      policy,
      clearReason: "cancelled",
    });

    expect(monitorOf(patch.executionState)).toMatchObject({ recoveryEmittedAt: null });
  });

  it("owes nothing on an arm", () => {
    const policy = armedPolicy();
    const result = applyIssueMonitorPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        executionPolicy: null,
        executionState: {
          monitor: {
            status: "cleared",
            clearedAt: "2026-11-03T01:11:39.000Z",
            clearReason: "cancelled",
            recoveryEmittedAt: "2026-11-03T01:12:00.000Z",
          },
        } as unknown as IssueExecutionState,
      },
      policy,
      previousPolicy: null,
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      monitorExplicitlyUpdated: true,
    });

    expect(monitorOf(result.patch.executionState)).toMatchObject({
      status: "scheduled",
      recoveryEmittedAt: null,
    });
  });

  it("reads a pre-existing cleared row as still owing a handoff", () => {
    // The whole backfill population predates the field. Absent must derive to
    // null — "owed" — not be left absent, which would compare unequal to an
    // otherwise identical state under monitorStatesEqual and read as absent
    // rather than owed to anything scanning it.
    const derived = parseIssueExecutionState({
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
        status: "cleared",
        nextCheckAt: null,
        lastTriggeredAt: null,
        attemptCount: 0,
        notes: "waiting on a merge",
        scheduledBy: "assignee",
        clearedAt: "2026-11-03T01:11:39.000Z",
        clearReason: "cancelled",
      },
    });

    expect(derived?.monitor).toMatchObject({ clearReason: "cancelled", recoveryEmittedAt: null });
  });
});

/**
 * PEN-5902 — a cleared monitor's `notes` used to outlive it forever.
 *
 * `monitor.notes` is free prose the arming run addresses to the NEXT WAKING
 * RUN: what to check on wake, which gate is live, what not to touch. PEN-1995
 * nulled the `monitorNotes` column on every clear for exactly that reason, on
 * the stated premise that the copy on `executionState.monitor.notes` was a
 * harmless audit duplicate. It was not harmless — it is reachable by every
 * reader of the row, it is named identically to the live field, and no verb
 * could write to it. Measured on PEN-4929: `paperclipClearIssueMonitor`
 * returned 200, nulled the column, and left 500 characters of operating
 * instructions byte-identical on the state, including a rule that had been
 * void company-wide for two days.
 *
 * So the clear now scrubs the archived copy too. The exemption is keyed on
 * whether a clear has a DEFERRED reader of those notes, which is `cancelled`
 * alone — `reconcileCancelledIssueMonitorRecoveries` emits that row's recovery handoff
 * on a later tick, after the column is gone, and that recovery issue may be
 * the only surviving carrier of the obligation.
 */
describe("a clear scrubs the archived monitor notes (PEN-5902)", () => {
  const armedAt = "2099-04-11T12:30:00.000Z";
  const notes = "ON WAKE: merged -> crit6; else verify heads, change nothing.";

  const armedPolicy = () =>
    normalizeIssueExecutionPolicy({
      stages: [],
      monitor: { nextCheckAt: armedAt, scheduledBy: "assignee", notes },
    })!;

  const armedIssue = (overrides: Record<string, unknown> = {}) => ({
    status: "in_progress",
    assigneeAgentId: coderAgentId,
    assigneeUserId: null,
    monitorNextCheckAt: new Date(armedAt),
    monitorNotes: notes,
    executionState: null,
    ...overrides,
  });

  const monitorOf = (state: unknown) =>
    (state as { monitor?: Record<string, unknown> } | null)?.monitor ?? null;

  // `issueExecutionStateSchema` requires the whole stage block; a partial
  // object fails `safeParse`, `parseIssueExecutionState` hands back null, and
  // every assertion below would go vacuously true.
  const stateWithMonitor = (monitor: Record<string, unknown>) =>
    ({
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
      monitor,
    }) as unknown as IssueExecutionState;

  const clearedMonitor = (overrides: Record<string, unknown> = {}) => ({
    status: "cleared",
    nextCheckAt: null,
    lastTriggeredAt: null,
    attemptCount: 7,
    notes,
    scheduledBy: "assignee",
    clearedAt: "2026-11-06T20:07:29.721Z",
    clearReason: "manual",
    clearedNextCheckAt: armedAt,
    recoveryEmittedAt: null,
    ...overrides,
  });

  it("nulls the archived notes on an explicit clear, not just the column", () => {
    // The exact call the Security Engineer made: DELETE /issues/:id/monitor,
    // which always records `clearReason: "manual"`.
    const policy = armedPolicy();
    const result = applyIssueMonitorPolicyTransition({
      issue: armedIssue({ executionPolicy: policy }),
      policy: stripMonitorFromExecutionPolicy(policy),
      previousPolicy: policy,
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      monitorExplicitlyUpdated: true,
    });

    expect(result.patch.monitorNotes).toBeNull();
    expect(monitorOf(result.patch.executionState)).toMatchObject({
      status: "cleared",
      clearReason: "manual",
      notes: null,
      // The rest of the object is an audit record and survives — scrubbing
      // `notes` is not licence to blank the row's history.
      clearedNextCheckAt: armedAt,
    });
  });

  it("nulls them on a status-driven clear too", () => {
    // The commonest path by far, and the one that accumulates the carriers:
    // park on an external wait with notes, finish the work, set `done`.
    // Nobody calls the clear verb here at all.
    const patch = buildIssueMonitorEligibilityPatch(
      armedIssue({ status: "done", executionPolicy: armedPolicy() }),
    );

    expect(monitorOf(patch.executionState)).toMatchObject({ status: "cleared", notes: null });
  });

  it("keeps them for a cancelled clear, whose recovery handoff reads them later", () => {
    // `reconcileCancelledIssueMonitorRecoveries` runs on a LATER tick and rebuilds the
    // dispatch row as `{ ...row, monitorNotes: monitorState.notes }`. Scrub
    // here and that re-hydration silently reads null, so the recovery issue —
    // possibly the only surviving carrier, since the source row is cancelled —
    // loses the whole record of what was being waited on.
    const patch = buildIssueMonitorEligibilityPatch(
      armedIssue({ status: "cancelled", executionPolicy: armedPolicy() }),
    );

    expect(monitorOf(patch.executionState)).toMatchObject({
      status: "cleared",
      clearReason: "cancelled",
      notes,
      recoveryEmittedAt: null,
    });
  });

  it("retracts notes left behind by a clear that predates this behaviour", () => {
    // The retroactive half. Every row cleared before this change still holds
    // its notes, and the ordinary clear branch declines an already-cleared
    // monitor, so without this there is no write path to them at all — which
    // was the actual complaint on PEN-5902.
    const result = applyIssueMonitorPolicyTransition({
      issue: armedIssue({
        status: "todo",
        monitorNextCheckAt: null,
        monitorNotes: null,
        executionPolicy: null,
        executionState: stateWithMonitor(clearedMonitor()),
      }),
      policy: null,
      previousPolicy: null,
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      monitorExplicitlyUpdated: true,
    });

    expect(monitorOf(result.patch.executionState)).toMatchObject({
      notes: null,
      // Re-stamping these would falsify when and why the monitor actually
      // died, which is why this is a notes-only scrub and not a re-clear.
      clearedAt: "2026-11-06T20:07:29.721Z",
      clearReason: "manual",
      attemptCount: 7,
      clearedNextCheckAt: armedAt,
    });
  });

  it("declines the retraction while a cancelled handoff is still owed", () => {
    const result = applyIssueMonitorPolicyTransition({
      issue: armedIssue({
        status: "todo",
        monitorNextCheckAt: null,
        monitorNotes: null,
        executionPolicy: null,
        executionState: stateWithMonitor(
          clearedMonitor({ clearReason: "cancelled", recoveryEmittedAt: null }),
        ),
      }),
      policy: null,
      previousPolicy: null,
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      monitorExplicitlyUpdated: true,
    });

    expect(result.patch.executionState).toBeUndefined();
  });

  it("allows it once that handoff has been discharged", () => {
    const result = applyIssueMonitorPolicyTransition({
      issue: armedIssue({
        status: "todo",
        monitorNextCheckAt: null,
        monitorNotes: null,
        executionPolicy: null,
        executionState: stateWithMonitor(
          clearedMonitor({
            clearReason: "cancelled",
            recoveryEmittedAt: "2026-11-06T20:09:00.000Z",
          }),
        ),
      }),
      policy: null,
      previousPolicy: null,
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      monitorExplicitlyUpdated: true,
    });

    expect(monitorOf(result.patch.executionState)).toMatchObject({
      notes: null,
      clearReason: "cancelled",
      recoveryEmittedAt: "2026-11-06T20:09:00.000Z",
    });
  });

  it("writes nothing when the archived notes are already empty", () => {
    // Idempotence. Without this the retraction branch would rewrite
    // `executionState` on every clear of an already-clean cleared row, which
    // is a write the convergence and activity machinery would have to absorb.
    const result = applyIssueMonitorPolicyTransition({
      issue: armedIssue({
        status: "todo",
        monitorNextCheckAt: null,
        monitorNotes: null,
        executionPolicy: null,
        executionState: stateWithMonitor(clearedMonitor({ notes: null })),
      }),
      policy: null,
      previousPolicy: null,
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      monitorExplicitlyUpdated: true,
    });

    expect(result.patch.executionState).toBeUndefined();
  });

  it("does not let an incidental transition destroy the notes of a LIVE monitor", () => {
    // The guard that keeps the scrub honest: only a caller who explicitly
    // wrote the monitor clears it. A status-only carry-forward must leave an
    // armed monitor — and its notes — completely alone.
    const policy = armedPolicy();
    const result = applyIssueMonitorPolicyTransition({
      issue: armedIssue({ executionPolicy: policy }),
      policy,
      previousPolicy: policy,
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      monitorExplicitlyUpdated: false,
    });

    expect(result.patch.monitorNotes).not.toBeNull();
    expect(derivePersistedMonitorState({
      issue: armedIssue({ executionPolicy: policy }),
      state: null,
      policy,
    })).toMatchObject({ status: "scheduled", notes });
  });
});

describe("normalizeIssueExecutionPolicy", () => {
  it("returns null for null/undefined input", () => {
    expect(normalizeIssueExecutionPolicy(null)).toBeNull();
    expect(normalizeIssueExecutionPolicy(undefined)).toBeNull();
  });

  it("returns null when stages are empty", () => {
    expect(normalizeIssueExecutionPolicy({ stages: [] })).toBeNull();
  });

  // BLO-39945: the collapse guard directly above is the whole trap. A policy
  // carrying only the opt-out must survive, or `PATCH` returns 200, stores
  // null, and the opt-out silently never happened.
  it("keeps a policy carrying only productivityReviewDisabled", () => {
    const result = normalizeIssueExecutionPolicy({ productivityReviewDisabled: true });
    expect(result).not.toBeNull();
    expect(result?.productivityReviewDisabled).toBe(true);
    expect(result?.monitor).toBeUndefined();
    expect(result?.stages).toEqual([]);
  });

  it("still returns null when the flag is false and nothing else is set", () => {
    expect(normalizeIssueExecutionPolicy({ productivityReviewDisabled: false })).toBeNull();
  });

  // Emitted only when true, so no existing policy gains a field.
  it("omits the flag entirely from a policy that does not set it", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "agent", agentId: coderAgentId }] }],
    });
    expect(result).not.toBeNull();
    expect(result && "productivityReviewDisabled" in result).toBe(false);
  });

  it("preserves the flag when a monitor is stripped from a stageless policy", () => {
    const policy = normalizeIssueExecutionPolicy({
      productivityReviewDisabled: true,
      monitor: { nextCheckAt: "2026-08-31T17:00:00.000Z", scheduledBy: "assignee" },
    });
    expect(stripMonitorFromExecutionPolicy(policy)).toMatchObject({ productivityReviewDisabled: true });
    // Control: the same strip on a stageless policy without the flag still collapses to null.
    const bare = normalizeIssueExecutionPolicy({
      monitor: { nextCheckAt: "2026-08-31T17:00:00.000Z", scheduledBy: "assignee" },
    });
    expect(stripMonitorFromExecutionPolicy(bare)).toBeNull();
  });

  it("throws when all participants are invalid (missing agentId)", () => {
    expect(() =>
      normalizeIssueExecutionPolicy({
        stages: [{ type: "review", participants: [{ type: "agent" }] }],
      }),
    ).toThrow("Invalid execution policy");
  });

  it("deduplicates participants within a stage", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: qaAgentId },
          ],
        },
      ],
    });
    expect(result!.stages[0].participants).toHaveLength(1);
  });

  it("assigns UUIDs to stages and participants", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
      ],
    });
    expect(result!.stages[0].id).toBeDefined();
    expect(result!.stages[0].participants[0].id).toBeDefined();
  });

  it("always sets commentRequired to true", () => {
    const result = normalizeIssueExecutionPolicy({
      commentRequired: false,
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
      ],
    });
    expect(result!.commentRequired).toBe(true);
  });

  it("defaults mode to normal", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
      ],
    });
    expect(result!.mode).toBe("normal");
  });

  it("rejects approvalsNeeded values above 1", () => {
    expect(() =>
      normalizeIssueExecutionPolicy({
        stages: [
          {
            type: "review",
            approvalsNeeded: 2,
            participants: [{ type: "agent", agentId: qaAgentId }],
          },
        ],
      }),
    ).toThrow("Invalid execution policy");
  });

  it("throws for invalid input", () => {
    expect(() => normalizeIssueExecutionPolicy({ stages: [{ type: "invalid_type" }] })).toThrow();
  });

  it("keeps monitor-only policies", () => {
    const result = normalizeIssueExecutionPolicy({
      monitor: {
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        notes: "Check deployment",
        externalRef: "https://example.test/deploy?token=secret",
      },
      stages: [],
    });
    expect(result).toMatchObject({
      stages: [],
      monitor: {
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        notes: "Check deployment",
        scheduledBy: "assignee",
        externalRef: "[redacted]",
      },
    });
  });
});

describe("parseIssueExecutionState", () => {
  it("returns null for null/undefined", () => {
    expect(parseIssueExecutionState(null)).toBeNull();
    expect(parseIssueExecutionState(undefined)).toBeNull();
  });

  it("returns null for invalid shape", () => {
    expect(parseIssueExecutionState({ status: "bogus" })).toBeNull();
  });

  it("parses a valid state", () => {
    const state = parseIssueExecutionState({
      status: "pending",
      currentStageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: qaAgentId },
      returnAssignee: { type: "agent", agentId: coderAgentId },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    });
    expect(state).not.toBeNull();
    expect(state!.status).toBe("pending");
  });
});

describe("issue execution policy transitions", () => {
  describe("happy path: executor → review → approval → done", () => {
    const policy = twoStagePolicy();

    it("routes executor completion into review", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Implemented the feature",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBe(qaAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "review",
        returnAssignee: { type: "agent", agentId: coderAgentId },
      });
      expect(result.decision).toBeUndefined();
    });

    it("carries loose review instructions on the pending handoff", () => {
      const reviewInstructions = [
        "Please focus on whether the migration path is reversible.",
        "",
        "- Check failure handling",
        "- Call out any unclear operator instructions",
      ].join("\n");

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Implemented the migration",
        reviewRequest: { instructions: reviewInstructions },
      });

      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId },
        reviewRequest: { instructions: reviewInstructions },
      });
    });

    it("clears loose review instructions with explicit null during a stage transition", () => {
      const reviewStageId = policy.stages[0].id;
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            reviewRequest: { instructions: "Old review request" },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_review",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Ready for review",
        reviewRequest: null,
      });

      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId },
        reviewRequest: null,
      });
    });

    it("reviewer approves → advances to approval stage", () => {
      const reviewStageId = policy.stages[0].id;
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "QA signoff complete",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBeNull();
      expect(result.patch.assigneeUserId).toBe(ctoUserId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "approval",
        completedStageIds: [reviewStageId],
        currentParticipant: { type: "user", userId: ctoUserId },
      });
      expect(result.decision).toMatchObject({
        stageId: reviewStageId,
        stageType: "review",
        outcome: "approved",
      });
    });

    it("lets a reviewer provide loose instructions for the next approval stage", () => {
      const reviewStageId = policy.stages[0].id;
      const approvalInstructions = "Please decide whether this is ready to ship, with any launch caveats.";
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            reviewRequest: { instructions: "Review the implementation details." },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "QA signoff complete",
        reviewRequest: { instructions: approvalInstructions },
      });

      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: ctoUserId },
        reviewRequest: { instructions: approvalInstructions },
      });
    });

    it("approver approves → marks completed (allows done)", () => {
      const reviewStageId = policy.stages[0].id;
      const approvalStageId = policy.stages[1].id;
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: ctoUserId,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: approvalStageId,
            currentStageIndex: 1,
            currentStageType: "approval",
            currentParticipant: { type: "user", userId: ctoUserId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [reviewStageId],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { userId: ctoUserId },
        commentBody: "Approved, ship it",
      });

      expect(result.patch.executionState).toMatchObject({
        status: "completed",
        completedStageIds: expect.arrayContaining([reviewStageId, approvalStageId]),
        lastDecisionOutcome: "approved",
      });
      expect(result.decision).toMatchObject({
        stageId: approvalStageId,
        stageType: "approval",
        outcome: "approved",
      });
      // status should NOT be overridden — caller can set done
      expect(result.patch.status).toBeUndefined();
    });
  });

  describe("changes requested flow", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("reviewer requests changes → returns to executor", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "Needs another pass on edge cases",
      });

      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.assigneeAgentId).toBe(coderAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "changes_requested",
        currentStageType: "review",
        returnAssignee: { type: "agent", agentId: coderAgentId },
        lastDecisionOutcome: "changes_requested",
      });
      expect(result.decision).toMatchObject({
        stageId: reviewStageId,
        stageType: "review",
        outcome: "changes_requested",
      });
    });

    it("executor re-submits after changes → returns to same review stage", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "changes_requested",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: "changes_requested",
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Fixed edge cases",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBe(qaAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageId: reviewStageId,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: qaAgentId },
      });
    });
  });

  describe("review-only policy (no approval stage)", () => {
    const policy = reviewOnlyPolicy();
    const reviewStageId = policy.stages[0].id;

    it("reviewer approval completes the policy", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
        commentBody: "LGTM",
      });

      expect(result.patch.executionState).toMatchObject({
        status: "completed",
        completedStageIds: [reviewStageId],
        lastDecisionOutcome: "approved",
      });
      expect(result.decision).toMatchObject({
        stageType: "review",
        outcome: "approved",
      });
    });
  });

  describe("approval-only policy (no review stage)", () => {
    const policy = approvalOnlyPolicy();

    it("executor completion routes directly to approval", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeUserId).toBe(ctoUserId);
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "approval",
      });
    });
  });

  describe("access control", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("non-participant cannot advance the active stage", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: { assigneeUserId: boardUserId },
          actor: { agentId: coderAgentId },
          commentBody: "Trying to bypass review",
        }),
      ).toThrow("Only the active reviewer or approver can advance");
    });

    // BLO-36237: the measured BLO-31634 loop. The row sat in_review but was
    // assigned to the executor (drift), so `{status:"done"}` with the comment
    // posted separately fell into drift repair, was rewritten to in_review,
    // and returned 200 — indistinguishable from success.
    const driftedIssue = {
      status: "in_review",
      assigneeAgentId: coderAgentId,
      assigneeUserId: null,
      executionPolicy: policy,
      executionState: {
        status: "pending" as const,
        currentStageId: reviewStageId,
        currentStageIndex: 0,
        currentStageType: "review" as const,
        currentParticipant: { type: "agent" as const, agentId: qaAgentId },
        returnAssignee: { type: "agent" as const, agentId: coderAgentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };

    for (const requestedStatus of ["done", "cancelled"]) {
      it(`rejects ${requestedStatus} on a drifted stage instead of silently re-pending it`, () => {
        expect(() =>
          applyIssueExecutionPolicyTransition({
            issue: driftedIssue,
            policy,
            requestedStatus,
            requestedAssigneePatch: {},
            actor: { agentId: coderAgentId },
          }),
        ).toThrow(/Cannot move to .*in ONE PATCH/);
      });
    }

    it("still repairs a drifted stage on a comment-only update", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: driftedIssue,
        policy,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Approved, see PR",
      });
      expect(result.patch).toMatchObject({ status: "in_review", assigneeAgentId: qaAgentId });
      expect(result.decision).toBeUndefined();
    });

    it("non-participant can still post non-advancing updates", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Just a note",
      });

      // No error — just no patch modifications
      expect(result.patch).toEqual({});
    });

    // BLO-15942: a review/approval stage pinned to a participant whose mandate
    // excludes stage decisions (e.g. a PR-webhook-only reviewer bot) otherwise
    // deadlocks forever — only the participant can advance, and the "Only the
    // active reviewer or approver can advance" throw above fires for every
    // other actor, including an operator/adjudicator above the participant.
    // `overrideAuthorized` (set by the route only after a real
    // tasks:override_execution_stage authorization check — never derived here)
    // lets that actor force-complete or request-changes without the
    // mandate-bound participant ever acting.
    it("an authorized override force-completes a stage the participant cannot act on", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: ctoAgentId },
        commentBody: "Overriding: reviewer's mandate excludes stage decisions; verified independently.",
        overrideAuthorized: true,
      });

      // Advances past the review stage into the approval stage (two-stage
      // policy) — the override acts with the participant's stage authority,
      // it does not skip the workflow.
      expect(result.patch.executionState).toMatchObject({
        status: "pending",
        currentStageType: "approval",
        completedStageIds: [reviewStageId],
      });
      expect(result.decision).toMatchObject({
        stageId: reviewStageId,
        stageType: "review",
        outcome: "approved",
      });
    });

    it("overrideAuthorized alone does not bypass the comment requirement", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: {},
          actor: { agentId: ctoAgentId },
          commentBody: "",
          overrideAuthorized: true,
        }),
      ).toThrow("Approving a review or approval stage requires a comment");
    });
  });

  describe("comment requirements", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("approval without comment throws", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: "",
        }),
      ).toThrow("requires a comment");
    });

    it("changes requested without comment throws", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "in_progress",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: null,
        }),
      ).toThrow("requires a comment");
    });

    it("whitespace-only comment is treated as empty", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: { type: "agent", agentId: coderAgentId },
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "done",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: "   ",
        }),
      ).toThrow("requires a comment");
    });
  });

  describe("policy removal mid-flow", () => {
    it("clears execution state when policy removed and returns to executor", () => {
      // Use a real UUID for currentStageId so parseIssueExecutionState succeeds
      const stageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: {
            status: "pending",
            currentStageId: stageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy: null,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
      });

      expect(result.patch.executionState).toBeNull();
      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.assigneeAgentId).toBe(coderAgentId);
    });

    it("clears execution state without assignee change when not in_review", () => {
      const stageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: {
            status: "changes_requested",
            currentStageId: stageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: "changes_requested",
          },
        },
        policy: null,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch.executionState).toBeNull();
      // Not in_review, so no status/assignee change
      expect(result.patch.status).toBeUndefined();
    });
  });

  describe("reopening from done/cancelled clears state", () => {
    it("reopening a done issue clears execution state", () => {
      const policy = twoStagePolicy();
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "done",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "completed",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [policy.stages[0].id, policy.stages[1].id],
            lastDecisionId: null,
            lastDecisionOutcome: "approved",
          },
        },
        policy,
        requestedStatus: "todo",
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch.executionState).toBeNull();
    });
  });

  describe("no-op transitions", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;

    it("non-done status change without review context is a no-op", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "blocked",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toEqual({});
    });

    it("coerces a malformed executor in_review patch into the first policy stage", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "in_review",
        requestedAssigneePatch: { assigneeUserId: boardUserId },
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
        },
      });
    });

    it("reasserts the active stage when issue status drifted out of in_review", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: { assigneeAgentId: coderAgentId },
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId },
        },
      });
    });

    it("no policy and no state is a no-op", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: null,
        },
        policy: null,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch).toEqual({});
    });

    it("does not auto-start workflow when policy is added to an already in_review issue", () => {
      const reviewOnly = reviewOnlyPolicy();
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: boardUserId,
          executionPolicy: null,
          executionState: null,
        },
        policy: reviewOnly,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch).toEqual({});
    });
  });

  describe("multi-participant stages", () => {
    it("selects the preferred participant when explicitly requested", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: ctoAgentId },
          ],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: { assigneeAgentId: ctoAgentId },
        actor: { agentId: coderAgentId },
        commentBody: "Ready for review",
      });

      expect(result.patch.assigneeAgentId).toBe(ctoAgentId);
    });

    it("falls back to first participant when no preference given", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: ctoAgentId },
          ],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Ready for review",
      });

      expect(result.patch.assigneeAgentId).toBe(qaAgentId);
    });

    it("excludes the return assignee from participant selection", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: coderAgentId },
            { type: "agent", agentId: qaAgentId },
          ],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      // coderAgentId is the returnAssignee, so QA should be selected
      expect(result.patch.assigneeAgentId).toBe(qaAgentId);
    });

    it("skips a self-review-only stage and completes the workflow", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [{ type: "agent", agentId: coderAgentId }],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch).toMatchObject({
        executionState: {
          status: "completed",
          currentStageType: null,
          currentParticipant: null,
          returnAssignee: { type: "agent", agentId: coderAgentId },
          completedStageIds: [policy.stages[0].id],
        },
      });
      expect(result.patch.status).toBeUndefined();
      expect(result.patch.assigneeAgentId).toBeUndefined();
    });

    it("skips a self-review-only review stage and advances to approval", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [{ type: "agent", agentId: coderAgentId }],
        },
        {
          type: "approval",
          participants: [{ type: "user", userId: ctoUserId }],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: ctoUserId,
        executionState: {
          status: "pending",
          currentStageType: "approval",
          currentParticipant: { type: "user", userId: ctoUserId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
          completedStageIds: [policy.stages[0].id],
        },
      });
    });
  });

  describe("changes requested with no return assignee", () => {
    it("throws when requesting changes with no return assignee", () => {
      const policy = twoStagePolicy();
      const reviewStageId = policy.stages[0].id;
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: {
              status: "pending",
              currentStageId: reviewStageId,
              currentStageIndex: 0,
              currentStageType: "review",
              currentParticipant: { type: "agent", agentId: qaAgentId },
              returnAssignee: null,
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
            },
          },
          policy,
          requestedStatus: "in_progress",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: "Changes needed",
        }),
      ).toThrow("no return assignee");
    });
  });

  describe("approval stage changes requested → bounces back to executor", () => {
    it("approver requests changes during approval stage", () => {
      const policy = twoStagePolicy();
      const reviewStageId = policy.stages[0].id;
      const approvalStageId = policy.stages[1].id;
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: ctoUserId,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: approvalStageId,
            currentStageIndex: 1,
            currentStageType: "approval",
            currentParticipant: { type: "user", userId: ctoUserId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [reviewStageId],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { userId: ctoUserId },
        commentBody: "Not happy with the approach, needs rework",
      });

      expect(result.patch.status).toBe("in_progress");
      expect(result.patch.assigneeAgentId).toBe(coderAgentId);
      expect(result.patch.executionState).toMatchObject({
        status: "changes_requested",
        currentStageType: "approval",
        lastDecisionOutcome: "changes_requested",
      });
      expect(result.decision).toMatchObject({
        stageId: approvalStageId,
        stageType: "approval",
        outcome: "changes_requested",
      });
    });
  });

  describe("user participants", () => {
    it("handles user-type reviewer participant correctly", () => {
      const policy = makePolicy([
        { type: "review", participants: [{ type: "user", userId: boardUserId }] },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
        },
        policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        commentBody: "Done",
      });

      expect(result.patch.status).toBe("in_review");
      expect(result.patch.assigneeAgentId).toBeNull();
      expect(result.patch.assigneeUserId).toBe(boardUserId);
    });
  });

  describe("policy edits while a stage is active", () => {
    it("clears the active execution state when its stage is removed from the policy", () => {
      const reviewAndApproval = twoStagePolicy();
      const approvalOnly = approvalOnlyPolicy();

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: reviewAndApproval,
          executionState: {
            status: "pending",
            currentStageId: reviewAndApproval.stages[0].id,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy: approvalOnly,
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch).toMatchObject({
        status: "in_progress",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        executionState: null,
      });
    });

    it("reassigns the active stage when the current participant is removed", () => {
      const policy = makePolicy([
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: ctoAgentId },
          ],
        },
      ]);
      const updatedPolicy = makePolicy([
        {
          type: "review",
          participants: [{ type: "agent", agentId: ctoAgentId }],
        },
      ]);

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: policy.stages[0].id,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: qaAgentId },
            returnAssignee: { type: "agent", agentId: coderAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy: {
          ...updatedPolicy,
          stages: [{ ...updatedPolicy.stages[0], id: policy.stages[0].id }],
        },
        requestedStatus: undefined,
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
      });

      expect(result.patch).toMatchObject({
        status: "in_review",
        assigneeAgentId: ctoAgentId,
        assigneeUserId: null,
        executionState: {
          status: "pending",
          currentStageId: policy.stages[0].id,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: ctoAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
        },
      });
    });
  });

  describe("monitor policy", () => {
    it("schedules a one-shot monitor on an active agent-owned issue", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      })!;

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: null,
          monitorAttemptCount: 0,
          monitorNextCheckAt: null,
          monitorLastTriggeredAt: null,
          monitorNotes: null,
          monitorScheduledBy: null,
        },
        policy,
        previousPolicy: null,
        requestedAssigneePatch: {},
        actor: { userId: boardUserId },
        monitorExplicitlyUpdated: true,
      });

      expect(result.patch.monitorNextCheckAt).toEqual(new Date("2026-04-11T12:30:00.000Z"));
      expect(result.patch.monitorScheduledBy).toBe("board");
      expect(result.patch.executionState).toMatchObject({
        status: "idle",
        monitor: {
          status: "scheduled",
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      });
    });

    it("auto-clears a scheduled monitor when the issue moves to done", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "assignee",
        },
      })!;

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "idle",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnAssignee: null,
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
            monitor: {
              status: "scheduled",
              nextCheckAt: "2026-04-11T12:30:00.000Z",
              lastTriggeredAt: null,
              attemptCount: 0,
              notes: "Check deployment",
              scheduledBy: "assignee",
              clearedAt: null,
              clearReason: null,
            },
          },
          monitorAttemptCount: 0,
          monitorNextCheckAt: new Date("2026-04-11T12:30:00.000Z"),
          monitorLastTriggeredAt: null,
          monitorNotes: "Check deployment",
          monitorScheduledBy: "assignee",
        },
        policy,
        previousPolicy: policy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch.executionPolicy).toBeNull();
      expect(result.patch.monitorNextCheckAt).toBeNull();
      expect(result.patch.monitorNotes).toBeNull();
      expect(result.patch.executionState).toMatchObject({
        monitor: {
          status: "cleared",
          clearReason: "done",
        },
      });
    });

    // PEN-1995: the notes column describes the ARMED monitor. Every clear path
    // nulled nextCheckAt/wakeRequestedAt but left the notes, so a retired
    // monitor's notes survived as live-looking instructions — observed
    // outliving their monitor by four days and being read as an active gate.
    it("nulls monitorNotes when the monitor is cleared by removing it from the policy", () => {
      const armed = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Read lastHeartbeatAt after the capacity reset",
          scheduledBy: "assignee",
        },
      })!;

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: armed,
          executionState: {
            status: "idle",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnAssignee: null,
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
            monitor: {
              status: "scheduled",
              nextCheckAt: "2026-04-11T12:30:00.000Z",
              lastTriggeredAt: null,
              attemptCount: 0,
              notes: "Read lastHeartbeatAt after the capacity reset",
              scheduledBy: "assignee",
              clearedAt: null,
              clearReason: null,
            },
          },
          monitorAttemptCount: 0,
          monitorNextCheckAt: new Date("2026-04-11T12:30:00.000Z"),
          monitorLastTriggeredAt: null,
          monitorNotes: "Read lastHeartbeatAt after the capacity reset",
          monitorScheduledBy: "assignee",
        },
        // Monitor removed from the policy: the manual-clear path.
        policy: null,
        previousPolicy: armed,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        monitorExplicitlyUpdated: true,
      });

      expect(result.patch.monitorNextCheckAt).toBeNull();
      expect(result.patch.monitorNotes).toBeNull();
      expect(result.patch.executionState).toMatchObject({
        monitor: {
          status: "cleared",
          clearReason: "manual",
          // PEN-5902: this used to assert the opposite — that the audit copy
          // was retained on the state, which was what made nulling the column
          // "lossless". That copy was the defect's hiding place: same name as
          // the live field, on the surface every reader of the row reaches,
          // and no verb could write to it. What makes nulling the column
          // lossless is the `issue.monitor_cleared` activity entry, written
          // from the pre-clear row.
          notes: null,
        },
      });
    });

    it("nulls monitorNotes when a monitor is cleared as invalid for the issue state", () => {
      const armed = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Poll the deploy",
          scheduledBy: "assignee",
        },
      })!;

      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: armed,
          executionState: null,
          monitorAttemptCount: 0,
          monitorNextCheckAt: new Date("2026-04-11T12:30:00.000Z"),
          monitorLastTriggeredAt: null,
          monitorNotes: "Poll the deploy",
          monitorScheduledBy: "assignee",
        },
        policy: armed,
        previousPolicy: armed,
        // A monitor cannot be held on a blocked issue; this is the invalid-state clear.
        requestedStatus: "blocked",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch.monitorNextCheckAt).toBeNull();
      expect(result.patch.monitorNotes).toBeNull();
      expect(result.patch.executionState).toMatchObject({
        monitor: { status: "cleared" },
      });
    });

    it("records status suppression when recovery blocks an issue", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: { nextCheckAt: "2099-04-11T12:30:00.000Z", scheduledBy: "assignee" },
      })!;
      const result = buildIssueMonitorClearedPatch({
        issue: {
          status: "in_progress",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
          monitorNextCheckAt: new Date("2099-04-11T12:30:00.000Z"),
        },
        policy,
        clearReason: "suppressed_by_status",
      });
      expect(result.monitorNextCheckAt).toBeNull();
      expect(result.executionPolicy).toBeNull();
      expect(result.executionState).toMatchObject({
        monitor: { status: "cleared", clearReason: "suppressed_by_status" },
      });
    });

    it("rejects explicitly scheduling a monitor on an invalid issue state", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
        },
      })!;

      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "blocked",
            assigneeAgentId: coderAgentId,
            assigneeUserId: null,
            executionPolicy: null,
            executionState: null,
          },
          policy,
          previousPolicy: null,
          requestedAssigneePatch: {},
          actor: { agentId: coderAgentId },
          monitorExplicitlyUpdated: true,
        }),
      ).toThrow("Monitor can only be scheduled");
    });

    it("rejects explicitly re-arming a monitor after max attempts are exhausted", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2099-04-11T12:30:00.000Z",
          maxAttempts: 1,
          scheduledBy: "assignee",
        },
      })!;

      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: coderAgentId,
            assigneeUserId: null,
            executionPolicy: null,
            executionState: null,
            monitorAttemptCount: 1,
            monitorNextCheckAt: null,
            monitorLastTriggeredAt: null,
            monitorNotes: null,
            monitorScheduledBy: "assignee",
          },
          policy,
          previousPolicy: null,
          requestedAssigneePatch: {},
          actor: { agentId: coderAgentId },
          monitorExplicitlyUpdated: true,
        }),
      ).toThrow("Monitor bounds are already exhausted");
    });

    /**
     * PEN-3803 — THE DISCRIMINATING CASE.
     *
     * This test replaces one that asserted the opposite ("allows an explicit
     * re-arm without maxAttempts after the scheduler default ceiling"). That
     * test was not wrong about the behaviour; it was wrong about the behaviour
     * being correct. The arm returned 200 and the row then advertised a live
     * `monitorNextCheckAt` right up to the due second, when the scheduler —
     * which DOES apply `DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS` — cleared it as
     * `max_attempts_exhausted` without firing. Measured on PEN-3328: armed
     * 2026-10-03T23:50Z for 2026-10-04T23:30Z, cleared at the due instant with
     * `lastTriggeredAt` predating the arm, ~24h of phantom liveness.
     *
     * Asserting the 422 on an explicit `maxAttempts` at/below `attemptCount`
     * (the test above) is NOT sufficient coverage: that path was always correct.
     * The discriminating case is `maxAttempts: null`, which is the shape the
     * tool description used to recommend.
     *
     * NEGATIVE CONTROL: drop `defaultMaxAttempts` from the
     * `exhaustedMonitorClearReason` call in `applyMonitorTransition`
     * (issue-execution-policy.ts) and this test fails — the transition returns
     * a `scheduled` monitor instead of throwing.
     */
    it("refuses an explicit re-arm with maxAttempts: null once the scheduler default ceiling is reached", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2099-04-11T12:30:00.000Z",
          scheduledBy: "assignee",
        },
      })!;

      expect(policy.monitor?.maxAttempts ?? null).toBeNull();

      expect(() =>
        applyIssueMonitorPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: coderAgentId,
            assigneeUserId: null,
            executionPolicy: null,
            executionState: null,
            monitorAttemptCount: DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS,
            monitorNextCheckAt: null,
            monitorLastTriggeredAt: null,
            monitorNotes: null,
            monitorScheduledBy: "assignee",
          },
          policy,
          previousPolicy: null,
          requestedAssigneePatch: {},
          actor: { agentId: coderAgentId },
          monitorExplicitlyUpdated: true,
        }),
      ).toThrow("Monitor bounds are already exhausted");
    });

    it("carries the numbers and the remedy on the exhaustion refusal", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: { nextCheckAt: "2099-04-11T12:30:00.000Z", scheduledBy: "assignee" },
      })!;

      let thrown: unknown;
      try {
        applyIssueMonitorPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: coderAgentId,
            assigneeUserId: null,
            executionPolicy: null,
            executionState: null,
            monitorAttemptCount: DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS,
            monitorNextCheckAt: null,
            monitorLastTriggeredAt: null,
            monitorNotes: null,
            monitorScheduledBy: "assignee",
          },
          policy,
          previousPolicy: null,
          requestedAssigneePatch: {},
          actor: { agentId: coderAgentId },
          monitorExplicitlyUpdated: true,
        });
      } catch (err) {
        thrown = err;
      }

      const error = thrown as { status?: number; message?: string; details?: Record<string, unknown> };
      expect(error.status).toBe(422);
      // `maxAttemptsSource: "default"` is the load-bearing field: it tells a
      // caller the bound it just tripped is one it never set and cannot see on
      // the policy, which is why the old 200 was so hard to diagnose.
      expect(error.details).toMatchObject({
        clearReason: "max_attempts_exhausted",
        attemptCount: DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS,
        maxAttempts: DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS,
        maxAttemptsSource: "default",
        suggestedMaxAttempts: renewedIssueMonitorMaxAttempts(DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS),
      });
      // The remedy must be in the message, not only in the details: omitting is
      // what the circulating advice recommended, and it is the one move that
      // reproduces the defect.
      expect(error.message).toContain("maxAttempts");
      expect(error.message).toMatch(/Omitting `maxAttempts` does NOT grant more attempts/);
    });

    it("admits the same re-arm when an explicit maxAttempts exceeds the attempts already made", () => {
      const renewal = renewedIssueMonitorMaxAttempts(DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS);
      expect(renewal).toBe(DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS * 2);

      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2099-04-11T12:30:00.000Z",
          scheduledBy: "assignee",
          maxAttempts: renewal,
        },
      })!;

      const result = applyIssueMonitorPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: null,
          monitorAttemptCount: DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS,
          monitorNextCheckAt: null,
          monitorLastTriggeredAt: null,
          monitorNotes: null,
          monitorScheduledBy: "assignee",
        },
        policy,
        previousPolicy: null,
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        monitorExplicitlyUpdated: true,
      });

      // An explicit bound still wins over the fleet ceiling — that is what keeps
      // a deliberate, recorded budget extension possible, and it is the only
      // exit left now that omitting is refused and clearing does not reset the
      // counter.
      expect(result.patch.monitorNextCheckAt).toEqual(new Date("2099-04-11T12:30:00.000Z"));
      expect(result.patch.executionState).toMatchObject({
        monitor: { status: "scheduled", attemptCount: DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS },
      });
    });

    /**
     * PEN-3803 review follow-up — the ceiling is an ARM-TIME bound, and must not
     * leak onto the carry-forward path.
     *
     * The exhaustion predicate feeds two asymmetric consumers. An explicit arm
     * throws 422: loud, at the caller, nothing persisted. A NON-explicit
     * transition strips the monitor and records it cleared, with no activity row
     * and no `recoveryPolicy` — and it runs on every generic
     * `PATCH /api/issues/:id` that leaves `executionPolicy` alone, because
     * `nextExecutionPolicy` falls back to the stored policy and carries the
     * armed monitor in with `monitorExplicitlyUpdated` false.
     *
     * So supplying `defaultMaxAttempts` unconditionally would silently retire
     * the very rows this fix exists for: a legacy `maxAttempts: null` row at
     * `attemptCount >= 24` (what the old 200 path created, PEN-3328 included)
     * would lose its monitor to an unrelated priority edit, instead of reaching
     * the scheduler's `clearIssueMonitorAndRecover` — which retires it with
     * `issue.monitor_exhausted` plus the configured `recoveryPolicy`.
     *
     * NEGATIVE CONTROL: drop the `input.monitorExplicitlyUpdated` guard on
     * `defaultMaxAttempts` in `applyMonitorTransition` (issue-execution-policy.ts)
     * and this test fails — `monitorNextCheckAt` comes back `null` and the state
     * reads `cleared`/`max_attempts_exhausted`.
     */
    it("leaves an armed maxAttempts: null monitor at the ceiling untouched on a non-explicit transition", () => {
      const armed = {
        nextCheckAt: "2099-04-11T12:30:00.000Z",
        scheduledBy: "assignee" as const,
      };
      const policy = normalizeIssueExecutionPolicy({ stages: [], monitor: armed })!;
      expect(policy.monitor?.maxAttempts ?? null).toBeNull();

      const result = applyIssueMonitorPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          // The row is ALREADY armed, and the generic PATCH carries that same
          // policy straight back in as `nextExecutionPolicy`.
          executionPolicy: policy,
          executionState: null,
          monitorAttemptCount: DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS,
          monitorNextCheckAt: new Date(armed.nextCheckAt),
          monitorLastTriggeredAt: null,
          monitorNotes: null,
          monitorScheduledBy: "assignee",
        },
        policy,
        previousPolicy: policy,
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        // The whole point: an edit that never touched the monitor.
        monitorExplicitlyUpdated: false,
      });

      // Not stripped, and not recorded as cleared. The monitor stays on the row
      // so the scheduler is still the thing that retires it — loudly.
      //
      // Assert the armed instant itself rather than `not.toBeNull()`: the strip
      // path runs `clearArmedMonitorColumns`, which writes an explicit `null`
      // here, so the date IS the discriminator. (An earlier revision wrote
      // `result.patch.monitorNextCheckAt ?? armed.nextCheckAt`, which can never
      // fail — `null ?? x` is `x` — so it did not carry the negative control
      // the docblock above credits it with.)
      expect(result.patch.monitorNextCheckAt).toEqual(new Date(armed.nextCheckAt));
      expect(result.patch.executionState).not.toMatchObject({
        monitor: { status: "cleared", clearReason: "max_attempts_exhausted" },
      });
      expect(result.patch.executionPolicy).toBeUndefined();
    });

    /**
     * The guard above withholds the DEFAULT on a non-explicit transition. It must
     * not also withhold a bound the issue declared for itself: that strip predates
     * PEN-3803 and is unrelated to the fleet ceiling, so it has to survive the fix.
     */
    it("still strips a non-explicit monitor whose own declared maxAttempts is spent", () => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2099-04-11T12:30:00.000Z",
          scheduledBy: "assignee",
          maxAttempts: 3,
        },
      })!;

      const result = applyIssueMonitorPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: null,
          monitorAttemptCount: 3,
          monitorNextCheckAt: new Date("2099-04-11T12:30:00.000Z"),
          monitorLastTriggeredAt: null,
          monitorNotes: null,
          monitorScheduledBy: "assignee",
        },
        policy,
        previousPolicy: policy,
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
        monitorExplicitlyUpdated: false,
      });

      expect(result.patch.monitorNextCheckAt).toBeNull();
      expect(result.patch.executionState).toMatchObject({
        monitor: { status: "cleared", clearReason: "max_attempts_exhausted" },
      });
    });

    /**
     * PEN-3803 done-when #2: the arm-time path and the scheduler path must
     * reach the SAME verdict for the same row. Asserting the 422 alone cannot
     * show that — it only shows one path is strict. This table drives both
     * predicates over the boundary and asserts they agree at every point,
     * including the `maxAttempts: null` cases where they used to diverge.
     */
    it.each([
      { label: "null bound, one below the ceiling", maxAttempts: null, attemptCount: DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS - 1 },
      { label: "null bound, exactly at the ceiling", maxAttempts: null, attemptCount: DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS },
      { label: "null bound, past the ceiling", maxAttempts: null, attemptCount: DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS + 7 },
      { label: "explicit bound, below it", maxAttempts: 3, attemptCount: 2 },
      { label: "explicit bound, reached", maxAttempts: 3, attemptCount: 3 },
      { label: "explicit bound above a spent default", maxAttempts: 60, attemptCount: DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS + 7 },
    ])("arm-time and scheduler agree: $label", ({ maxAttempts, attemptCount }) => {
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: {
          nextCheckAt: "2099-04-11T12:30:00.000Z",
          scheduledBy: "assignee",
          ...(maxAttempts === null ? {} : { maxAttempts }),
        },
      })!;

      // The scheduler's question, verbatim: `heartbeat.ts` passes the row's real
      // attempt count and the fleet ceiling, then clears the monitor without
      // firing when this returns non-null.
      const schedulerWouldClear = exhaustedMonitorClearReason({
        monitor: policy.monitor!,
        attemptCount,
        now: new Date("2026-10-29T00:00:00.000Z"),
        defaultMaxAttempts: DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS,
      }) !== null;

      const arm = () =>
        applyIssueMonitorPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: coderAgentId,
            assigneeUserId: null,
            executionPolicy: null,
            executionState: null,
            monitorAttemptCount: attemptCount,
            monitorNextCheckAt: null,
            monitorLastTriggeredAt: null,
            monitorNotes: null,
            monitorScheduledBy: "assignee",
          },
          policy,
          previousPolicy: null,
          requestedAssigneePatch: {},
          actor: { agentId: coderAgentId },
          monitorExplicitlyUpdated: true,
        });

      if (schedulerWouldClear) {
        expect(arm).toThrow("Monitor bounds are already exhausted");
      } else {
        expect(arm().patch.monitorNextCheckAt).toEqual(new Date("2099-04-11T12:30:00.000Z"));
      }
    });
  });

  describe("blocked status correction from in_review (BLO-9316)", () => {
    const policy = twoStagePolicy();
    const reviewStageId = policy.stages[0].id;
    const pendingState: IssueExecutionState = {
      status: "pending",
      currentStageId: reviewStageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: qaAgentId },
      returnAssignee: { type: "agent", agentId: coderAgentId },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    };

    it("allows the current participant (reviewer) to transition to blocked: clears execution state, does not override to in_progress", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: pendingState,
        },
        policy,
        requestedStatus: "blocked",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
      });

      expect(result.patch.status).toBeUndefined();
      expect(result.patch.executionState).toBeNull();
    });

    it("allows a non-participant (implementer) to transition to blocked: clears execution state, does not throw stage-advance error", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: pendingState,
        },
        policy,
        requestedStatus: "blocked",
        requestedAssigneePatch: {},
        actor: { agentId: coderAgentId },
      });

      expect(result.patch.status).toBeUndefined();
      expect(result.patch.executionState).toBeNull();
    });

    it("does not treat blocked as requesting-changes: no comment required", () => {
      expect(() =>
        applyIssueExecutionPolicyTransition({
          issue: {
            status: "in_review",
            assigneeAgentId: qaAgentId,
            assigneeUserId: null,
            executionPolicy: policy,
            executionState: pendingState,
          },
          policy,
          requestedStatus: "blocked",
          requestedAssigneePatch: {},
          actor: { agentId: qaAgentId },
          commentBody: null,
        }),
      ).not.toThrow();
    });

    it("still rejects in_progress when unresolved blockers would be present (the guard is in issues.ts, not here, but in_progress is not overridden)", () => {
      const result = applyIssueExecutionPolicyTransition({
        issue: {
          status: "in_review",
          assigneeAgentId: qaAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: pendingState,
        },
        policy,
        requestedStatus: "blocked",
        requestedAssigneePatch: {},
        actor: { agentId: qaAgentId },
      });

      expect(result.patch.status).not.toBe("in_progress");
    });
  });
});

describe("isMonitorNextCheckAtLive", () => {
  // PEN-2853: one definition of "the monitor is still a live wake path", shared by the
  // stranded-assigned sweep and the in_review disposition validator. Before this, the
  // sweep required a future instant and the validator accepted any non-null one, so the
  // two disagreed about the same column in the direction that admits a row to in_review
  // while the sweep treats it as unattended.
  const nowMs = Date.parse("2026-09-01T12:00:00.000Z");

  it("counts an instant strictly in the future", () => {
    expect(isMonitorNextCheckAtLive(new Date(nowMs + 1), nowMs)).toBe(true);
    expect(isMonitorNextCheckAtLive("2026-09-01T13:00:00.000Z", nowMs)).toBe(true);
  });

  it("does not count a lapsed or exactly-now instant", () => {
    expect(isMonitorNextCheckAtLive(new Date(nowMs - 1), nowMs)).toBe(false);
    // Exactly `now` is not in the future. `>` matches the sweep's own comparison; a
    // `>=` here would re-open the divergence by one millisecond.
    expect(isMonitorNextCheckAtLive(new Date(nowMs), nowMs)).toBe(false);
    expect(isMonitorNextCheckAtLive("2026-08-25T12:00:00.000Z", nowMs)).toBe(false);
  });

  it("does not count an absent or unparseable instant", () => {
    expect(isMonitorNextCheckAtLive(null, nowMs)).toBe(false);
    expect(isMonitorNextCheckAtLive(undefined, nowMs)).toBe(false);
    expect(isMonitorNextCheckAtLive("", nowMs)).toBe(false);
    expect(isMonitorNextCheckAtLive("not a date", nowMs)).toBe(false);
    expect(isMonitorNextCheckAtLive(new Date("not a date"), nowMs)).toBe(false);
  });
});

// BLO-33728: an execution stage must not stay live on a terminal issue. The
// `done` half was already correct (`buildCompletedState` discharges on
// approval); the gap was `cancelled` from `changes_requested`, which reached
// no branch at all and returned an empty patch.
describe("stage discharge on terminal status", () => {
  const agentApprovalPolicy = () =>
    makePolicy([{ type: "approval", participants: [{ type: "agent", agentId: ctoAgentId }] }]);

  /** Drive the real transitions to a genuine `changes_requested` state. */
  function changesRequestedState(policy: IssueExecutionPolicy) {
    const pending = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: null,
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      commentBody: "Ready for approval",
    }).patch.executionState;

    const changesRequested = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: ctoAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: pending,
      },
      policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: ctoAgentId },
      commentBody: "Needs work",
    }).patch.executionState;

    return { pending, changesRequested };
  }

  it("records the approval, not the earlier downgrade, on approve-and-close", () => {
    const policy = agentApprovalPolicy();
    const { pending } = changesRequestedState(policy);

    const state = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: ctoAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: pending,
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: ctoAgentId },
      commentBody: "Approved",
    }).patch.executionState as IssueExecutionState;

    expect(state.lastDecisionOutcome).toBe("approved");
    // The negative the AC asks for: never a pre-approval `changes_requested`.
    expect(state.lastDecisionOutcome).not.toBe("changes_requested");
    expect(state.currentStageId).toBeNull();
    expect(state.currentParticipant).toBeNull();
  });

  it("discharges the stage when a changes_requested issue is cancelled", () => {
    const policy = agentApprovalPolicy();
    const { changesRequested } = changesRequestedState(policy);
    // Guard the fixture: the pre-state really does carry a live stage, so a
    // passing assertion below cannot be an artifact of an already-empty stage.
    expect((changesRequested as IssueExecutionState).currentStageId).not.toBeNull();

    const patch = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: changesRequested,
      },
      policy,
      requestedStatus: "cancelled",
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      commentBody: "Abandoning",
    }).patch;

    // The defect was an empty patch: the cancel reached no branch, so the stage
    // survived untouched. Name that here rather than dereferencing `undefined`.
    expect(patch.executionState, "cancel left executionState untouched").toBeDefined();
    const state = patch.executionState as IssueExecutionState;

    expect(state.currentStageId).toBeNull();
    expect(state.currentStageType).toBeNull();
    expect(state.currentParticipant).toBeNull();
    // A genuine decision is real history and must survive the cancel.
    expect(state.lastDecisionOutcome).toBe("changes_requested");
  });

  it("clears the discharged state on reopen so a review path can be rebuilt", () => {
    const policy = agentApprovalPolicy();
    const { changesRequested } = changesRequestedState(policy);

    const cancelled = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: changesRequested,
      },
      policy,
      requestedStatus: "cancelled",
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      commentBody: "Abandoning",
    }).patch.executionState;

    const reopened = applyIssueExecutionPolicyTransition({
      issue: {
        status: "cancelled",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: cancelled,
      },
      policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      commentBody: "Reopening",
    }).patch;

    expect(reopened.executionState).toBeNull();
  });
});

// PEN-6202 — a monitor that has already FIRED must be cleared by the same
// eligibility pass that clears an armed one.
//
// `buildIssueMonitorEligibilityPatch` used to open `if (!issue.monitorNextCheckAt)
// return {}`, deferring the fired case to BLO-25865 as "a different defect". It
// is a different defect, and BLO-25865's net cannot reach the rows this pass
// creates: `tickExpiredIssueMonitors` is the only thing that clears a fired
// monitor and its outer `where` carries
// `status in ('in_progress','in_review') and assignee_user_id is null` — exactly
// the eligibility the row has just lost. The two nets handed the case to each
// other and the demotion fell between them.
//
// Census over all 5615 company rows, 2026-11-08: 19 non-terminal rows held a
// permanently unclearable `triggered` monitor, 3 of them for 91-106 days, each
// watching a pull request that had already merged.
describe("buildIssueMonitorEligibilityPatch clears a FIRED monitor (PEN-6202)", () => {
  const triggeredState = (overrides: Record<string, unknown> = {}) =>
    ({
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
        lastTriggeredAt: "2026-07-25T00:22:27.000Z",
        attemptCount: 23,
        notes: "#824 remains open and mergeable at head 013b86d5",
        scheduledBy: "assignee",
        clearedAt: null,
        clearReason: null,
        ...overrides,
      },
    }) as unknown as IssueExecutionState;

  // A fired monitor, exactly as `buildIssueMonitorTriggeredPatch` leaves it:
  // `nextCheckAt` consumed, the trigger recorded in both the JSON and the
  // columns, and `monitor` stripped out of `executionPolicy`.
  const fired = {
    assigneeAgentId: coderAgentId,
    assigneeUserId: null,
    executionPolicy: null,
    executionState: triggeredState(),
    monitorNextCheckAt: null,
    monitorLastTriggeredAt: new Date("2026-07-25T00:22:27.000Z"),
    monitorAttemptCount: 23,
    monitorNotes: "#824 remains open and mergeable at head 013b86d5",
    monitorScheduledBy: "assignee",
  };

  const monitorOf = (patch: Record<string, unknown>) =>
    (patch.executionState as { monitor?: Record<string, unknown> }).monitor!;

  // PEN-1706 and PEN-2128: promoted on checkout, monitor armed, monitor fires,
  // the run ends and checkout release restores the row to `todo`. Both sat at
  // 106 and 91 days with `attemptCount` frozen.
  it("clears when a checkout release demotes the row out of the dispatch window", () => {
    const patch = buildIssueMonitorEligibilityPatch({ ...fired, status: "todo" });
    const patchNotes = patch.monitorNotes;
    const monitor = monitorOf(patch);

    expect(monitor).toMatchObject({ status: "cleared", clearReason: "invalid_status" });
    // The stale note is the thing a reader was being misled by — #824 had in
    // fact merged seven minutes BEFORE that note was written, and it then sat
    // on the row for 106 days reading as live work. Both copies go: the live
    // column, and the archive, because `clearedMonitorKeepsNotes` keeps notes
    // only for `cancelled` (PEN-5902). The durable record is the
    // `issue.monitor_cleared` activity entry.
    expect(patchNotes).toBeNull();
    expect(monitor.notes).toBeNull();
    // What a later reader DOES keep is the evidence the monitor ever fired,
    // which is what makes a stranded row diagnosable after the fact.
    expect(monitor).toMatchObject({ lastTriggeredAt: "2026-07-25T00:22:27.000Z", attemptCount: 23 });
  });

  it("clears on `blocked` too, not just `todo`", () => {
    expect(monitorOf(buildIssueMonitorEligibilityPatch({ ...fired, status: "blocked" })))
      .toMatchObject({ status: "cleared", clearReason: "invalid_status" });
  });

  // PEN-2077, and the reason this fix belongs in the shared pass rather than in
  // the restore: the clearing net also requires `assignee_user_id is null`, so a
  // monitor that outlives its agent assignee strands on a status the net WOULD
  // have admitted. That row was `in_review` and human-held — inside the status
  // window, outside every agent intake surface, dark for 91 days.
  it("clears when the row passes to a human assignee, on a status the net allows", () => {
    expect(
      monitorOf(
        buildIssueMonitorEligibilityPatch({
          ...fired,
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: ctoUserId,
        }),
      ),
    ).toMatchObject({ status: "cleared", clearReason: "invalid_assignee" });
  });

  // The discrimination that keeps BLO-35155 intact. A fired monitor on a row
  // that is STILL eligible is the normal in-flight case: the woken run may be
  // sitting in the dispatch queue, and `tickExpiredIssueMonitors` deliberately
  // waits out a grace window before reaping it. This pass must not pre-empt
  // that — it fires at the instant the row leaves eligibility, never before.
  it("leaves a fired monitor alone while the row can still be dispatched", () => {
    expect(buildIssueMonitorEligibilityPatch({ ...fired, status: "in_progress" })).toEqual({});
    expect(buildIssueMonitorEligibilityPatch({ ...fired, status: "in_review" })).toEqual({});
  });

  // Idempotence, and the falsification guard. `clearReason` is provenance — it
  // is what tells a later reader whether the scheduler retired this monitor or
  // an assignee stopped it — so a second pass over an already-cleared monitor
  // must not overwrite it with this pass's reason.
  it("does not rewrite a monitor that is already cleared", () => {
    const alreadyCleared = {
      ...fired,
      status: "todo",
      executionState: triggeredState({
        status: "cleared",
        clearedAt: "2026-07-26T00:00:00.000Z",
        clearReason: "max_attempts_exhausted",
      }),
    };

    expect(buildIssueMonitorEligibilityPatch(alreadyCleared)).toEqual({});

    // And the clear this pass produces is itself a fixed point.
    const cleared = buildIssueMonitorEligibilityPatch({ ...fired, status: "todo" });
    expect(
      buildIssueMonitorEligibilityPatch({
        ...fired,
        status: "todo",
        executionState: cleared.executionState as IssueExecutionState,
        monitorNotes: null,
      }),
    ).toEqual({});
  });

  // A row whose trigger survives only in the columns — no `executionState.monitor`
  // to read. `derivePersistedMonitorState` reaches `triggered` through
  // `monitorAttemptCount`/`monitorLastTriggeredAt`, and this is why the restore's
  // compare-and-swap guards on `is distinct from 'cleared'` rather than
  // `= 'triggered'`: keyed on the JSON alone, these rows would skip their own CAS.
  it("clears a legacy row whose trigger is recorded only in the columns", () => {
    expect(
      monitorOf(
        buildIssueMonitorEligibilityPatch({
          status: "todo",
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: null,
          monitorNextCheckAt: null,
          monitorLastTriggeredAt: new Date("2026-08-09T13:22:20.000Z"),
          monitorAttemptCount: 4,
        }),
      ),
    ).toMatchObject({ status: "cleared", clearReason: "invalid_status" });
  });

  // The no-op floor: widening the guard must not start producing patches for
  // rows that never held a monitor, at any of the nine call sites that spread
  // this unconditionally.
  it("still produces nothing for a row that never armed a monitor", () => {
    for (const status of ["todo", "blocked", "done", "cancelled", "in_progress"]) {
      expect(
        buildIssueMonitorEligibilityPatch({
          status,
          assigneeAgentId: coderAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: null,
          monitorNextCheckAt: null,
          monitorAttemptCount: 0,
        }),
      ).toEqual({});
    }
  });
});

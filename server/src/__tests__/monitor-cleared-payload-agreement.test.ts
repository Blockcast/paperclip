import { describe, expect, it } from "vitest";
import {
  buildIssueMonitorClear,
  buildIssueMonitorEligibilityClear,
  issueHoldsClearableMonitor,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.js";

/**
 * PEN-6577 — one `monitorCleared` key, one meaning, across three sibling
 * escalation payloads in `recovery/service.ts`.
 *
 * `escalateStrandedRecoveryIssueInPlace` and
 * `escalateZeroTokenStartupFailureIssue` reach `buildIssueMonitorClear`, which
 * is UNCONDITIONAL and so always produced a non-null `audit`.
 * `escalateStrandedAssignedIssue` reaches the nullable
 * `buildIssueMonitorEligibilityClear` and uses `null` to mean "this escalation
 * cleared nothing". Reporting `audit` on the first two therefore scored every
 * `suppressed_by_status` escalation as a clear, including those over rows that
 * held no monitor at all, while the sibling reported the same situation as
 * `null`.
 *
 * These tests pin the AGREEMENT, not one site's behaviour: the expressions
 * below are the ones the three payloads use verbatim.
 */

const agentId = "11111111-1111-4111-8111-111111111111";

/** The expression both `suppressed_by_status` payloads use. */
function suppressedByStatusPayloadValue(issue: Parameters<typeof issueHoldsClearableMonitor>[0]) {
  return buildIssueMonitorClear({
    issue,
    policy: normalizeIssueExecutionPolicy(issue.executionPolicy ?? null),
    clearReason: "suppressed_by_status",
  }).clearedAudit;
}

/** The expression the `escalateStrandedAssignedIssue` sibling uses. */
function eligibilityPayloadValue(issue: Parameters<typeof buildIssueMonitorEligibilityClear>[0]) {
  return buildIssueMonitorEligibilityClear(issue)?.clearedAudit ?? null;
}

const armed = {
  status: "in_progress",
  assigneeAgentId: agentId,
  assigneeUserId: null,
  monitorNextCheckAt: new Date("2026-11-12T17:00:00.000Z"),
  monitorNotes: "waiting on Blockcast/paperclip#3715",
  executionPolicy: {
    monitor: {
      nextCheckAt: "2026-11-12T17:00:00.000Z",
      scheduledBy: "assignee",
      notes: "waiting on Blockcast/paperclip#3715",
    },
  },
} as const;

/** Same row, with nothing armed: no due time, never triggered, no monitor state. */
const unarmed = {
  status: "in_progress",
  assigneeAgentId: agentId,
  assigneeUserId: null,
  monitorNextCheckAt: null,
  monitorLastTriggeredAt: null,
  monitorAttemptCount: 0,
  monitorNotes: null,
  executionPolicy: null,
  executionState: null,
} as const;

/**
 * A FIRED monitor carries no `monitorNextCheckAt`, so a predicate keyed on that
 * column alone reports this row as holding nothing. It holds a monitor, and a
 * clear here destroys a real note.
 */
const triggered = {
  status: "in_progress",
  assigneeAgentId: agentId,
  assigneeUserId: null,
  monitorNextCheckAt: null,
  monitorLastTriggeredAt: new Date("2026-11-12T12:00:00.000Z"),
  monitorAttemptCount: 3,
  monitorNotes: "fired, not yet re-armed",
  executionPolicy: null,
  executionState: {
    monitor: {
      status: "triggered",
      nextCheckAt: null,
      attemptCount: 3,
      notes: "fired, not yet re-armed",
      lastTriggeredAt: "2026-11-12T12:00:00.000Z",
      scheduledBy: "assignee",
    },
  },
} as const;

describe("monitorCleared agrees across the three recovery escalation payloads", () => {
  it("reports null on a row that held no monitor, from BOTH builders", () => {
    // The whole defect: these two disagreed, and only the second was null.
    expect(suppressedByStatusPayloadValue(unarmed)).toBeNull();
    expect(eligibilityPayloadValue({ ...unarmed, status: "blocked" })).toBeNull();
  });

  it("still reports the destroyed evidence when a monitor WAS held", () => {
    const value = suppressedByStatusPayloadValue(armed);
    expect(value).not.toBeNull();
    expect(value).toMatchObject({
      clearReason: "suppressed_by_status",
      notes: "waiting on Blockcast/paperclip#3715",
      nextCheckAt: "2026-11-12T17:00:00.000Z",
    });
  });

  it("reports a FIRED monitor as cleared, where a nextCheckAt-only predicate would not", () => {
    expect(triggered.monitorNextCheckAt).toBeNull();
    expect(issueHoldsClearableMonitor(triggered)).toBe(true);
    const value = suppressedByStatusPayloadValue(triggered);
    expect(value).not.toBeNull();
    expect(value).toMatchObject({ notes: "fired, not yet re-armed", attemptCount: 3 });
  });

  it("keeps `audit` unconditional — the narrowing is on `clearedAudit` alone", () => {
    // `audit` answers "what did this write replace?" and stays well-defined, so
    // `logIssueMonitorClearedUndeliverable` can keep taking a non-null audit.
    const clear = buildIssueMonitorClear({
      issue: unarmed,
      policy: null,
      clearReason: "suppressed_by_status",
    });
    expect(clear.audit).toMatchObject({ clearReason: "suppressed_by_status", attemptCount: 0 });
    expect(clear.clearedAudit).toBeNull();
  });

  it("derives both nullabilities from ONE predicate", () => {
    // `buildIssueMonitorEligibilityClear` returning null and `clearedAudit`
    // being null are the same question; drift between two copies is what
    // produced the two meanings in the first place.
    for (const issue of [armed, unarmed, triggered]) {
      const held = issueHoldsClearableMonitor(issue);
      expect(suppressedByStatusPayloadValue(issue) !== null).toBe(held);
      if (!held) expect(buildIssueMonitorEligibilityClear(issue)).toBeNull();
    }
  });
});

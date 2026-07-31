import { describe, expect, it } from "vitest";
import type { IssueExecutionPolicy } from "@paperclipai/shared";
import { DEFAULT_ISSUE_MONITOR_CONVERGENCE_THRESHOLD } from "@paperclipai/shared";
import {
  applyIssueExecutionPolicyTransition,
  buildIssueMonitorTriggeredPatch,
  computeIssueMonitorGateFingerprint,
  evaluateIssueMonitorConvergence,
  normalizeIssueExecutionPolicy,
  normalizeIssueMonitorConvergenceThreshold,
} from "../services/issue-execution-policy.js";

/**
 * BLO-18294 — the monitor convergence guard.
 *
 * Source incident: BLO-13266 ran an assignee-scheduled 30-minute monitor for
 * ~30h across ~52 signature revisions, each re-deriving "still blocked" without
 * the blocker set ever narrowing, for ~$197 and zero gate movement. Two defects
 * compounded: nothing counted consecutive no-progress re-checks, and the
 * "did state change?" read keyed partly on an unrelated staging
 * CrashLoopBackOff, so incidental churn defeated any naive dedupe.
 *
 * These tests drive full arm → fire → re-arm cycles through the real transition
 * functions, exactly as the PATCH route and the monitor dispatcher do.
 */

const assigneeAgentId = "11111111-1111-4111-8111-111111111111";
const BLOCKER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BLOCKER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type MonitorInput = {
  nextCheckAt: string;
  notes?: string | null;
  scheduledBy?: "assignee" | "board";
  kind?: "external_service" | null;
  gateSignals?: string[] | null;
};

type IssueFixture = {
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionPolicy: IssueExecutionPolicy | null;
  executionState: Record<string, unknown> | null;
  monitorNextCheckAt: Date | null;
  monitorLastTriggeredAt: Date | null;
  monitorAttemptCount: number;
  monitorNotes: string | null;
  monitorScheduledBy: string | null;
};

function newIssue(): IssueFixture {
  return {
    status: "in_progress",
    assigneeAgentId,
    assigneeUserId: null,
    executionPolicy: null,
    executionState: null,
    monitorNextCheckAt: null,
    monitorLastTriggeredAt: null,
    monitorAttemptCount: 0,
    monitorNotes: null,
    monitorScheduledBy: null,
  };
}

/**
 * One re-arm, applied the way the PATCH route applies it: the request's policy
 * lands on the row first, then the transition patch is layered over it.
 */
function arm(
  issue: IssueFixture,
  monitor: MonitorInput,
  options: {
    blockers?: string[] | null;
    threshold?: number;
    actor?: { agentId?: string | null; userId?: string | null };
  } = {},
) {
  const policy = normalizeIssueExecutionPolicy({
    stages: [],
    monitor: { scheduledBy: "assignee", ...monitor },
  })!;
  const unresolvedBlockerIssueIds = Object.prototype.hasOwnProperty.call(options, "blockers")
    ? options.blockers ?? null
    : [];
  const result = applyIssueExecutionPolicyTransition({
    issue,
    policy,
    previousPolicy: normalizeIssueExecutionPolicy(issue.executionPolicy),
    requestedAssigneePatch: {},
    actor: options.actor ?? { agentId: assigneeAgentId },
    monitorExplicitlyUpdated: true,
    unresolvedBlockerIssueIds,
    monitorConvergenceThreshold: options.threshold ?? null,
  });
  issue.executionPolicy = policy;
  Object.assign(issue, result.patch);
  return result;
}

/** The monitor firing, as `dispatchClaimedIssueMonitor` persists it. */
function fire(issue: IssueFixture, triggeredAt: string) {
  const patch = buildIssueMonitorTriggeredPatch({
    issue,
    policy: normalizeIssueExecutionPolicy(issue.executionPolicy),
    triggeredAt: new Date(triggeredAt),
  });
  Object.assign(issue, patch);
}

function monitorState(issue: IssueFixture) {
  return (issue.executionState as { monitor?: Record<string, unknown> } | null)?.monitor ?? null;
}

function checkAt(cycle: number) {
  return `2026-07-23T${String(cycle % 24).padStart(2, "0")}:30:00.000Z`;
}

describe("issue monitor convergence guard (BLO-18294)", () => {
  describe("consecutive identical re-checks", () => {
    it("stops re-arming and escalates to blocked once N re-checks report the same blocker set", () => {
      const issue = newIssue();
      const blockers = [BLOCKER_A, BLOCKER_B];

      // N re-checks that each re-derive the same unresolved blocker set.
      for (let cycle = 1; cycle <= DEFAULT_ISSUE_MONITOR_CONVERGENCE_THRESHOLD; cycle += 1) {
        const result = arm(issue, { nextCheckAt: checkAt(cycle), notes: `rev${cycle}` }, { blockers });
        expect(result.monitorConvergence?.converged).toBe(false);
        expect(result.monitorConvergence?.count).toBe(cycle);
        expect(issue.monitorNextCheckAt).toEqual(new Date(checkAt(cycle)));
        expect(issue.status).toBe("in_progress");
        fire(issue, checkAt(cycle));
      }

      // (a) the (N+1)th arm is refused — no further monitor is scheduled.
      const refused = arm(
        issue,
        { nextCheckAt: checkAt(DEFAULT_ISSUE_MONITOR_CONVERGENCE_THRESHOLD + 1), notes: "rev4" },
        { blockers },
      );

      expect(refused.monitorConvergence?.converged).toBe(true);
      expect(refused.monitorConvergence?.count).toBe(DEFAULT_ISSUE_MONITOR_CONVERGENCE_THRESHOLD + 1);
      expect(refused.patch.monitorNextCheckAt).toBeNull();
      expect(issue.monitorNextCheckAt).toBeNull();

      // (b) the issue is escalated to `blocked`...
      expect(refused.patch.status).toBe("blocked");

      // (c) ...and the recorded gate set is preserved on the cleared state so the
      // caller can name unblock owners from it.
      expect(monitorState(issue)).toMatchObject({
        status: "cleared",
        clearReason: "convergence_stalled",
        gateSource: "gates",
        convergenceCount: DEFAULT_ISSUE_MONITOR_CONVERGENCE_THRESHOLD + 1,
        convergenceStallCount: 1,
      });
      // The monitor is stripped from the policy, so nothing re-arms it implicitly.
      expect((refused.patch.executionPolicy as IssueExecutionPolicy | null)?.monitor ?? null).toBeNull();
    });

    it("counts identical re-checks when the gate set is declared via gateSignals and there are no blocker edges", () => {
      const issue = newIssue();
      const gateSignals = ["proxmox:donor-host-drain", "ceph:pg-rebalance"];

      for (let cycle = 1; cycle <= DEFAULT_ISSUE_MONITOR_CONVERGENCE_THRESHOLD; cycle += 1) {
        const result = arm(issue, { nextCheckAt: checkAt(cycle), gateSignals });
        expect(result.monitorConvergence).toMatchObject({ converged: false, source: "gates", count: cycle });
        fire(issue, checkAt(cycle));
      }

      const refused = arm(issue, { nextCheckAt: checkAt(9), gateSignals });
      expect(refused.monitorConvergence?.converged).toBe(true);
      expect(refused.patch.status).toBe("blocked");
    });

    it("honours a tuned threshold", () => {
      const issue = newIssue();
      const blockers = [BLOCKER_A];

      arm(issue, { nextCheckAt: checkAt(1) }, { blockers, threshold: 1 });
      fire(issue, checkAt(1));

      const refused = arm(issue, { nextCheckAt: checkAt(2) }, { blockers, threshold: 1 });
      expect(refused.monitorConvergence).toMatchObject({ converged: true, threshold: 1, count: 2 });
      expect(refused.patch.status).toBe("blocked");
    });
  });

  describe("what counts as progress", () => {
    it("does NOT reset the counter when a signal outside the declared gate set churns", () => {
      const issue = newIssue();
      const blockers = [BLOCKER_A, BLOCKER_B];

      // This is the BLO-13266 shape: the recorded signature mentions an unrelated
      // staging VIP reconciler that flaps on every re-check. The declared gates
      // never move, so the churn must not read as progress.
      const churnyNotes = [
        "drain pending; staging-blockcastd/multicast-vip-klrdv CrashLoopBackOff x41",
        "drain pending; staging-blockcastd/multicast-vip-klrdv CrashLoopBackOff x58",
        "drain pending; staging-blockcastd/multicast-vip-klrdv CrashLoopBackOff x72",
      ];

      churnyNotes.forEach((notes, index) => {
        const result = arm(issue, { nextCheckAt: checkAt(index + 1), notes }, { blockers });
        expect(result.monitorConvergence).toMatchObject({ source: "gates", count: index + 1, converged: false });
        fire(issue, checkAt(index + 1));
      });

      const refused = arm(
        issue,
        { nextCheckAt: checkAt(4), notes: "drain pending; staging-blockcastd/multicast-vip-klrdv CrashLoopBackOff x95" },
        { blockers },
      );
      expect(refused.monitorConvergence?.converged).toBe(true);
      expect(refused.patch.status).toBe("blocked");
    });

    it("resets the counter when the blocker set actually narrows", () => {
      const issue = newIssue();

      arm(issue, { nextCheckAt: checkAt(1) }, { blockers: [BLOCKER_A, BLOCKER_B] });
      fire(issue, checkAt(1));
      const second = arm(issue, { nextCheckAt: checkAt(2) }, { blockers: [BLOCKER_A, BLOCKER_B] });
      expect(second.monitorConvergence?.count).toBe(2);
      fire(issue, checkAt(2));

      // One blocker resolved: real progress, so the guard starts counting again.
      const narrowed = arm(issue, { nextCheckAt: checkAt(3) }, { blockers: [BLOCKER_A] });
      expect(narrowed.monitorConvergence).toMatchObject({ count: 1, converged: false });
      expect(issue.monitorNextCheckAt).toEqual(new Date(checkAt(3)));
    });

    it("treats blocker order as irrelevant", () => {
      const forward = computeIssueMonitorGateFingerprint({ unresolvedBlockerIssueIds: [BLOCKER_A, BLOCKER_B] });
      const reversed = computeIssueMonitorGateFingerprint({ unresolvedBlockerIssueIds: [BLOCKER_B, BLOCKER_A] });
      expect(forward.fingerprint).toBe(reversed.fingerprint);
      expect(forward.source).toBe("gates");
    });

    it("does not advance the counter on a re-arm with no intervening fire", () => {
      const issue = newIssue();
      const blockers = [BLOCKER_A];

      arm(issue, { nextCheckAt: checkAt(1) }, { blockers });
      fire(issue, checkAt(1));
      const second = arm(issue, { nextCheckAt: checkAt(2) }, { blockers });
      expect(second.monitorConvergence?.count).toBe(2);

      // Pushing the next check out without the monitor having fired is a
      // schedule adjustment, not another completed re-check.
      const adjusted = arm(issue, { nextCheckAt: checkAt(5) }, { blockers });
      expect(adjusted.monitorConvergence?.count).toBe(2);
      expect(adjusted.monitorConvergence?.converged).toBe(false);
      expect(issue.monitorNextCheckAt).toEqual(new Date(checkAt(5)));
    });
  });

  describe("scope of the guard", () => {
    it("exempts board-scheduled monitors", () => {
      const issue = newIssue();
      const blockers = [BLOCKER_A];

      for (let cycle = 1; cycle <= DEFAULT_ISSUE_MONITOR_CONVERGENCE_THRESHOLD + 3; cycle += 1) {
        const result = arm(issue, { nextCheckAt: checkAt(cycle), scheduledBy: "board" }, { blockers });
        // The guard does not apply at all, so no convergence bookkeeping is
        // recorded and nothing perturbs the persisted monitor state.
        expect(result.monitorConvergence).toBeNull();
        expect(issue.monitorNextCheckAt).toEqual(new Date(checkAt(cycle)));
        expect(result.patch.status).toBeUndefined();
        expect(monitorState(issue)).toMatchObject({ gateFingerprint: null, convergenceCount: 0 });
        fire(issue, checkAt(cycle));
      }
    });

    it("exempts external-service monitors even when the assignee scheduled them", () => {
      const issue = newIssue();
      const blockers = [BLOCKER_A];

      for (let cycle = 1; cycle <= DEFAULT_ISSUE_MONITOR_CONVERGENCE_THRESHOLD + 3; cycle += 1) {
        const result = arm(
          issue,
          { nextCheckAt: checkAt(cycle), kind: "external_service", gateSignals: ["provider-quota"] },
          { blockers },
        );

        expect(result.monitorConvergence).toBeNull();
        expect(issue.monitorNextCheckAt).toEqual(new Date(checkAt(cycle)));
        expect(result.patch.status).toBeUndefined();
        fire(issue, checkAt(cycle));
      }
    });

    it("ignores transitions that merely carry an existing monitor forward", () => {
      const issue = newIssue();
      const blockers = [BLOCKER_A];

      arm(issue, { nextCheckAt: checkAt(1) }, { blockers });
      fire(issue, checkAt(1));

      // A status-only return, or a stage auto-approval, re-sends the stored
      // policy without asking to re-arm. Those call sites carry no blocker edges,
      // so scoring them would reset the counter against an empty gate set.
      const policy = normalizeIssueExecutionPolicy({
        stages: [],
        monitor: { nextCheckAt: checkAt(2), scheduledBy: "assignee" },
      })!;
      const carried = applyIssueExecutionPolicyTransition({
        issue,
        policy,
        previousPolicy: policy,
        requestedAssigneePatch: {},
        actor: { agentId: assigneeAgentId },
        monitorExplicitlyUpdated: false,
      });

      expect(carried.monitorConvergence).toBeNull();
      expect(carried.patch.status).toBeUndefined();
      // The recorded fingerprint from the explicit arm is left untouched.
      expect(monitorState(issue)).toMatchObject({ convergenceCount: 1 });
    });

    it("skips scoring when blocker readiness is unavailable and preserves the previous gate bookkeeping", () => {
      const issue = newIssue();
      const blockers = [BLOCKER_A];

      arm(issue, { nextCheckAt: checkAt(1) }, { blockers });
      fire(issue, checkAt(1));
      const previousMonitorState = monitorState(issue);

      const skipped = arm(
        issue,
        { nextCheckAt: checkAt(2), gateSignals: ["new-signal"], notes: "changed notes" },
        { blockers: null },
      );

      expect(skipped.monitorConvergence).toBeNull();
      expect(skipped.patch.status).toBeUndefined();
      expect(monitorState(issue)).toMatchObject({
        status: "scheduled",
        gateSignals: previousMonitorState?.gateSignals ?? null,
        gateFingerprint: previousMonitorState?.gateFingerprint,
        gateSource: previousMonitorState?.gateSource,
        convergenceCount: previousMonitorState?.convergenceCount,
      });
    });

    it("lets a non-assignee reset stale consecutive bookkeeping after a stalled issue leaves blocked", () => {
      const issue = newIssue();
      const blockers = [BLOCKER_A];

      for (let cycle = 1; cycle <= DEFAULT_ISSUE_MONITOR_CONVERGENCE_THRESHOLD; cycle += 1) {
        arm(issue, { nextCheckAt: checkAt(cycle) }, { blockers });
        fire(issue, checkAt(cycle));
      }

      const refused = arm(issue, { nextCheckAt: checkAt(4) }, { blockers });
      expect(refused.patch.status).toBe("blocked");
      expect(monitorState(issue)).toMatchObject({
        status: "cleared",
        clearReason: "convergence_stalled",
        convergenceCount: DEFAULT_ISSUE_MONITOR_CONVERGENCE_THRESHOLD + 1,
      });

      issue.status = "in_progress";
      const rearmed = arm(issue, { nextCheckAt: checkAt(5) }, {
        blockers,
        actor: { userId: "board-user-1" },
      });

      expect(rearmed.monitorConvergence).toMatchObject({ count: 1, converged: false });
      expect(rearmed.patch.status).toBeUndefined();
      expect(issue.monitorNextCheckAt).toEqual(new Date(checkAt(5)));
      expect(monitorState(issue)).toMatchObject({
        status: "scheduled",
        clearReason: null,
        convergenceCount: 1,
        convergenceStallCount: 1,
      });
    });

    it("does not let the same assignee reset a previously stalled monitor budget", () => {
      const issue = newIssue();
      const blockers = [BLOCKER_A];

      for (let cycle = 1; cycle <= DEFAULT_ISSUE_MONITOR_CONVERGENCE_THRESHOLD; cycle += 1) {
        arm(issue, { nextCheckAt: checkAt(cycle) }, { blockers });
        fire(issue, checkAt(cycle));
      }

      const refused = arm(issue, { nextCheckAt: checkAt(4) }, { blockers });
      expect(refused.patch.status).toBe("blocked");
      expect(monitorState(issue)).toMatchObject({
        status: "cleared",
        clearReason: "convergence_stalled",
        convergenceStallCount: 1,
      });

      issue.status = "in_progress";
      expect(() => arm(issue, { nextCheckAt: checkAt(5) }, { blockers })).toThrow(
        /must be re-armed by a non-assignee actor/,
      );
    });

    it("falls back to the notes signature when nothing structured is declared", () => {
      const issue = newIssue();

      for (let cycle = 1; cycle <= DEFAULT_ISSUE_MONITOR_CONVERGENCE_THRESHOLD; cycle += 1) {
        const result = arm(issue, { nextCheckAt: checkAt(cycle), notes: "still waiting on the same approval" });
        expect(result.monitorConvergence).toMatchObject({ source: "notes", count: cycle, converged: false });
        fire(issue, checkAt(cycle));
      }

      const refused = arm(issue, { nextCheckAt: checkAt(4), notes: "still waiting on the same approval" });
      expect(refused.monitorConvergence?.converged).toBe(true);
      expect(refused.patch.status).toBe("blocked");
    });

    it("treats a changed notes signature as progress only when nothing structured is declared", () => {
      const issue = newIssue();

      arm(issue, { nextCheckAt: checkAt(1), notes: "checks: 3 pending" });
      fire(issue, checkAt(1));
      const moved = arm(issue, { nextCheckAt: checkAt(2), notes: "checks: 1 pending" });
      expect(moved.monitorConvergence).toMatchObject({ source: "notes", count: 1, converged: false });
    });

    it("normalizes whitespace and case so cosmetic notes edits are not progress", () => {
      const a = computeIssueMonitorGateFingerprint({ notes: "Waiting  on   Approval" });
      const b = computeIssueMonitorGateFingerprint({ notes: "waiting on approval" });
      expect(a.fingerprint).toBe(b.fingerprint);
      expect(a.source).toBe("notes");
    });
  });

  describe("BLO-13266 regression replay", () => {
    it("halts at or before rev47 when replaying the rev44 → rev52 signature sequence", () => {
      const issue = newIssue();
      // The real incident's gates: donor-host drain readiness, Proxmox, and Ceph.
      // Across rev44..rev52 none of them moved; only the unrelated staging VIP
      // CrashLoopBackOff counter changed, which is what kept the loop alive.
      const gateSignals = ["drain:donor-host", "proxmox:migration-window", "ceph:health-ok"];
      const revisions = [44, 45, 46, 47, 48, 49, 50, 51, 52];

      let haltedAt: number | null = null;
      for (const rev of revisions) {
        const result = arm(
          issue,
          {
            nextCheckAt: checkAt(rev),
            notes: `rev${rev}: staging-blockcastd/multicast-vip-klrdv CrashLoopBackOff x${rev * 3}`,
            gateSignals,
          },
          { blockers: [] },
        );
        if (result.monitorConvergence?.converged) {
          haltedAt = rev;
          break;
        }
        fire(issue, checkAt(rev));
      }

      expect(haltedAt).not.toBeNull();
      expect(haltedAt!).toBeLessThanOrEqual(47);
      expect(issue.status).not.toBe("in_progress");
    });
  });

  describe("threshold normalization", () => {
    it.each([
      [undefined, DEFAULT_ISSUE_MONITOR_CONVERGENCE_THRESHOLD],
      [null, DEFAULT_ISSUE_MONITOR_CONVERGENCE_THRESHOLD],
      [Number.NaN, DEFAULT_ISSUE_MONITOR_CONVERGENCE_THRESHOLD],
      [0, 1],
      [-5, 1],
      [2.7, 2],
      [10_000, 50],
    ])("normalizes %p to %p", (input, expected) => {
      expect(normalizeIssueMonitorConvergenceThreshold(input as number | null | undefined)).toBe(expected);
    });
  });

  describe("evaluateIssueMonitorConvergence", () => {
    it("reports the first observation of a gate set as count 1", () => {
      const result = evaluateIssueMonitorConvergence({
        monitor: normalizeIssueExecutionPolicy({
          stages: [],
          monitor: { nextCheckAt: checkAt(1), scheduledBy: "assignee" },
        })!.monitor!,
        previous: null,
        unresolvedBlockerIssueIds: [BLOCKER_A],
      });
      expect(result).toMatchObject({ count: 1, converged: false, source: "gates" });
    });
  });
});

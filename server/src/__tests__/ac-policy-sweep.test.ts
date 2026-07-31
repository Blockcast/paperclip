import { describe, expect, it } from "vitest";
import * as acPolicySweep from "../services/ac-policy-sweep.js";
import {
  formatAcPolicyStaleDashboardSections,
  partitionAcPolicyStaleCandidates,
  type AcPolicyStaleCandidate,
} from "../services/ac-policy-sweep.js";

describe("AC-policy stale candidate partitioning (report-only)", () => {
  it("routes stale agent-owned work to the report-only stale bucket from a mixed candidate fixture", () => {
    const candidates: AcPolicyStaleCandidate[] = [
      {
        id: "stale-agent-owned",
        identifier: "BLO-1",
        title: "Stale agent-owned task missing AC",
        status: "todo",
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        createdByUserId: null,
        originKind: "manual",
        blocks: [],
      },
      {
        id: "user-assigned-board-ask",
        identifier: "BLO-2",
        title: "Board ask: approve launch window",
        status: "todo",
        assigneeAgentId: null,
        assigneeUserId: "user-1",
        createdByUserId: "user-1",
        originKind: "manual",
        blocks: [],
      },
      {
        id: "productivity-review",
        identifier: "BLO-3",
        title: "[user-cover] productivity-review escalation: BLO-100",
        status: "todo",
        assigneeAgentId: null,
        assigneeUserId: "user-1",
        createdByUserId: null,
        originKind: "productivity_review_escalation",
        blocks: [],
      },
      {
        id: "active-blocker",
        identifier: "BLO-4",
        title: "Proof task currently blocking implementation",
        status: "todo",
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        createdByUserId: null,
        originKind: "manual",
        blocks: [{ id: "parent-1", identifier: "BLO-5", status: "blocked" }],
      },
    ];

    const partitioned = partitionAcPolicyStaleCandidates(candidates);

    expect(partitioned.staleNonCompliant.map((issue) => issue.id)).toEqual(["stale-agent-owned"]);
    expect(partitioned.needsHumanTriage.map((issue) => issue.id)).toEqual([
      "user-assigned-board-ask",
      "productivity-review",
      "active-blocker",
    ]);
    expect(partitioned.needsHumanTriage.find((issue) => issue.id === "user-assigned-board-ask")?.triageReasons).toEqual([
      "user_assigned",
      "user_owned_protected",
    ]);
    expect(partitioned.needsHumanTriage.find((issue) => issue.id === "productivity-review")?.triageReasons).toContain(
      "productivity_review_escalation",
    );
    expect(partitioned.needsHumanTriage.find((issue) => issue.id === "active-blocker")?.triageReasons).toEqual([
      "active_blocker_for_non_terminal_parent",
    ]);

    // The whole point of revision 7: every candidate lands in one of two report-only
    // buckets, and no candidate is anywhere else. Nothing is eligible for destruction.
    expect(partitioned.staleNonCompliant.length + partitioned.needsHumanTriage.length).toBe(
      candidates.length,
    );
  });

  it("exposes no destruction path at all — no batch planner, no safety cap", () => {
    // Regression guard for BLO-19484 / BLO-19487. The 2026-06-08 run of the retired
    // step destroyed user-assigned strategic issue PCL-354. Reintroducing a batch
    // planner requires a fresh CEO ruling, not a new export here.
    const exported = Object.keys(acPolicySweep);

    expect(exported).not.toContain("planAcPolicyAutoCancelBatch");
    expect(exported).not.toContain("DEFAULT_AC_POLICY_CANCEL_SAFETY_CAP");
    for (const name of exported) {
      expect(name.toLowerCase()).not.toContain("cancel");
    }

    const partitioned = partitionAcPolicyStaleCandidates([
      { id: "a", title: "Stale task", status: "todo", assigneeAgentId: "agent-1" },
    ]) as Record<string, unknown>;
    expect(Object.keys(partitioned).sort()).toEqual(["needsHumanTriage", "staleNonCompliant"]);
  });

  it("does not triage candidates that only block terminal parent work", () => {
    const candidates: AcPolicyStaleCandidate[] = [
      {
        id: "terminal-parent-blocker",
        identifier: "BLO-6",
        title: "Old proof task blocking completed parent",
        status: "todo",
        assigneeAgentId: "agent-1",
        blocks: [{ id: "parent-1", identifier: "BLO-7", status: "done" }],
      },
    ];

    const partitioned = partitionAcPolicyStaleCandidates(candidates);

    expect(partitioned.staleNonCompliant.map((issue) => issue.id)).toEqual(["terminal-parent-blocker"]);
    expect(partitioned.needsHumanTriage).toEqual([]);
  });

  it("triages user-created board asks even when currently assigned to an agent", () => {
    const candidates: AcPolicyStaleCandidate[] = [
      {
        id: "user-created-agent-assigned",
        identifier: "BLO-15",
        title: "Board ask assigned to CTO",
        status: "todo",
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        createdByUserId: "user-1",
      },
    ];

    const partitioned = partitionAcPolicyStaleCandidates(candidates);

    expect(partitioned.staleNonCompliant).toEqual([]);
    expect(partitioned.needsHumanTriage[0]?.triageReasons).toEqual(["user_owned_protected"]);
  });

  it("triages blockers with missing parent status instead of assuming unknown dependency work is dead", () => {
    const candidates: AcPolicyStaleCandidate[] = [
      {
        id: "unknown-parent-status",
        identifier: "BLO-8",
        title: "Old proof task with partial relation data",
        status: "todo",
        assigneeAgentId: "agent-1",
        blocks: [{ id: "parent-1", identifier: "BLO-9" }],
      },
    ];

    const partitioned = partitionAcPolicyStaleCandidates(candidates);

    expect(partitioned.staleNonCompliant).toEqual([]);
    expect(partitioned.needsHumanTriage[0]?.triageReasons).toEqual(["active_blocker_for_non_terminal_parent"]);
  });

  it("formats dashboard output with two report-only sections and an explicit zero-cancellation line", () => {
    const candidates: AcPolicyStaleCandidate[] = [
      {
        id: "safe-1",
        identifier: "BLO-13",
        title: "Stale task",
        status: "todo",
        assigneeAgentId: "agent-1",
      },
      {
        id: "triage-1",
        identifier: "BLO-14",
        title: "Board ask",
        status: "todo",
        assigneeUserId: "user-1",
      },
    ];

    const output = formatAcPolicyStaleDashboardSections(candidates);

    expect(output).toContain("### Stale non-compliant candidates — report only (1)");
    expect(output).toContain("- BLO-13 (safe-1) - Stale task");
    expect(output).toContain("### Needs-human-triage candidates — report only (1)");
    expect(output).toContain("- BLO-14 (triage-1) - Board ask (user_assigned)");
    expect(output).toContain("Issues cancelled by this sweep: 0");
    // No bucket in the rendered dashboard may advertise eligibility for destruction.
    expect(output.toLowerCase()).not.toContain("auto-cancel");
  });

  it("reports never-touched-by-a-human as its own condition, not as a large age", () => {
    // BLO-19484 amendment: a null human clock is worse than merely stale and must stay
    // visibly distinct. The clock itself is computed in human-gated-ageing.ts — this
    // module only renders what it is handed, so the two never drift apart.
    const output = formatAcPolicyStaleDashboardSections([
      {
        id: "never-touched",
        identifier: "BLO-20",
        title: "Never seen by a human",
        status: "todo",
        assigneeAgentId: "agent-1",
        humanClockAt: null,
      },
      {
        id: "touched",
        identifier: "BLO-21",
        title: "Seen once",
        status: "todo",
        assigneeAgentId: "agent-1",
        humanClockAt: new Date("2026-05-04T10:00:00.000Z"),
      },
    ]);

    expect(output).toContain("- BLO-20 (never-touched) - Never seen by a human [never touched by a human]");
    expect(output).toContain("- BLO-21 (touched) - Seen once [last human touch 2026-05-04]");
  });

  it("omits the human-clock annotation entirely when the caller supplies no clock", () => {
    const output = formatAcPolicyStaleDashboardSections([
      { id: "no-clock", identifier: "BLO-22", title: "No clock supplied", status: "todo" },
    ]);

    expect(output).toContain("- BLO-22 (no-clock) - No clock supplied");
    expect(output).not.toContain("never touched by a human");
  });
});

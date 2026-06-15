import { describe, expect, it } from "vitest";
import { partitionAcPolicyCancelCandidates, type AcPolicyCancelCandidate } from "../services/ac-policy-sweep.js";

describe("AC-policy auto-cancel candidate partitioning", () => {
  it("keeps only stale agent-owned work in auto-cancel-safe from a mixed candidate fixture", () => {
    const candidates: AcPolicyCancelCandidate[] = [
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

    const partitioned = partitionAcPolicyCancelCandidates(candidates);

    expect(partitioned.autoCancelSafe.map((issue) => issue.id)).toEqual(["stale-agent-owned"]);
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
  });
});

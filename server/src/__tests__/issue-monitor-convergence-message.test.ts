import { describe, expect, it } from "vitest";
import {
  monitorConvergenceComment,
  type IssueUnblockOwner,
} from "../services/issue-monitor-convergence-message.js";

const convergence = { count: 4, threshold: 3, source: "gates" as const };

function owner(overrides: Partial<IssueUnblockOwner> = {}): IssueUnblockOwner {
  return {
    issueId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    identifier: "PAP-9001",
    title: "Grant Proxmox migration window",
    status: "todo",
    assigneeAgentId: "44444444-4444-4444-8444-444444444444",
    assigneeAgentName: "Platform SRE",
    assigneeUserId: null,
    ...overrides,
  };
}

describe("monitorConvergenceComment (BLO-18294)", () => {
  it("leads with why the monitor stopped, including the counts that produced the decision", () => {
    const body = monitorConvergenceComment({ convergence, unblockOwners: [owner()] });
    expect(body).toContain("Monitor stopped re-arming");
    expect(body).toContain("4 consecutive re-checks");
    expect(body).toContain("threshold 3");
    expect(body).toContain("`gates`");
    expect(body).toContain("`blocked`");
  });

  it("names an agent owner as a clickable agent reference", () => {
    const body = monitorConvergenceComment({ convergence, unblockOwners: [owner()] });
    expect(body).toContain("Unblock owners:");
    expect(body).toContain("- PAP-9001 (todo) — [Platform SRE](agent://44444444-4444-4444-8444-444444444444): Grant Proxmox migration window");
  });

  it("distinguishes a board-user owner from an unassigned blocker", () => {
    const body = monitorConvergenceComment({
      convergence,
      unblockOwners: [
        owner({ identifier: "PAP-9002", assigneeAgentId: null, assigneeAgentName: null, assigneeUserId: "board-user" }),
        owner({ identifier: "PAP-9003", assigneeAgentId: null, assigneeAgentName: null, assigneeUserId: null, title: null }),
      ],
    });
    expect(body).toContain("- PAP-9002 (todo) — a board user");
    // An unassigned blocker is the worst case: nobody is going to move it.
    expect(body).toContain("- PAP-9003 (todo) — **unassigned — needs an owner**");
  });

  it("falls back to the issue id when a blocker has no identifier", () => {
    const body = monitorConvergenceComment({
      convergence,
      unblockOwners: [owner({ identifier: null })],
    });
    expect(body).toContain("- dddddddd-dddd-4ddd-8ddd-dddddddddddd (todo)");
  });

  it("tells the reader what to do when no blocker edges were ever recorded", () => {
    // This is the notes-fallback escalation: convergence fired off the notes
    // signature alone, so there is no owner to route to and the comment must
    // not dead-end.
    const body = monitorConvergenceComment({
      convergence: { ...convergence, source: "notes" },
      unblockOwners: [],
    });
    expect(body).not.toContain("Unblock owners:");
    expect(body).toContain("no owner to route to");
    expect(body).toContain("executionPolicy.monitor.gateSignals");
    expect(body).toContain("a human-only gate never resolves on a timer");
  });
});

import { describe, expect, it } from "vitest";
import {
  compareSweepWakeFrame,
  composeSweepWakeFramePage,
  parseSweepWakeFramePage,
  shouldForceSoftTtlRefresh,
  type SweepWakeFrame,
} from "./sweep-wake-preflight.js";

const baseFrame = {
  schemaVersion: 1,
  companyId: "company-1",
  agentId: "agent-1",
  agentName: "Staff Engineer",
  issueIdentifier: "BLO-6347",
  issueId: "issue-1",
  issueLastActivityAt: "2026-05-21T07:00:00.000Z",
  updatedAt: "2026-05-21T07:01:00.000Z",
  status: "blocked",
  blockedByIssueIds: ["blocker-a", "blocker-b"],
  disposition: "blocked_waiting_for_child",
  nextRefreshTriggers: ["blockers resolve"],
  consecutiveSkips: 0,
  body: "# Stable decision\nBody stays unchanged.",
} satisfies SweepWakeFrame;

const baseIssue = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "BLO-6347",
  status: "blocked",
  lastActivityAt: new Date("2026-05-21T07:00:00.000Z"),
  blockedByIssueIds: ["blocker-b", "blocker-a"],
};

describe("compareSweepWakeFrame", () => {
  it("skips a stable schema-v1 frame", () => {
    const decision = compareSweepWakeFrame({
      frame: baseFrame,
      issue: baseIssue,
      recentComments: [],
    });

    expect(decision).toEqual({ skip: true, verdict: "skip", frame: baseFrame });
  });

  it("falls open when the frame is missing or invalid", () => {
    expect(compareSweepWakeFrame({ frame: null, issue: baseIssue, recentComments: [] })).toMatchObject({
      skip: false,
      verdict: "missing_or_invalid_frame",
    });
    expect(compareSweepWakeFrame({
      frame: { ...baseFrame, schemaVersion: 2 },
      issue: baseIssue,
      recentComments: [],
    })).toMatchObject({ skip: false, verdict: "missing_or_invalid_frame" });
  });

  it("accepts ISO timestamps without millisecond precision", () => {
    expect(compareSweepWakeFrame({
      frame: {
        ...baseFrame,
        issueLastActivityAt: "2026-05-21T07:00:00Z",
        updatedAt: "2026-05-21T07:01:00Z",
      },
      issue: baseIssue,
      recentComments: [],
    })).toMatchObject({ skip: true, verdict: "skip" });
  });

  it("falls open when issue activity is newer than the frame", () => {
    expect(compareSweepWakeFrame({
      frame: baseFrame,
      issue: { ...baseIssue, lastActivityAt: new Date("2026-05-21T07:00:01.000Z") },
      recentComments: [],
    })).toMatchObject({ skip: false, verdict: "new_activity" });
  });

  it("ignores marker comments but falls open for newer non-marker comments", () => {
    expect(compareSweepWakeFrame({
      frame: baseFrame,
      issue: baseIssue,
      recentComments: [
        { body: "[gstack-preflight] frame stable", createdAt: new Date("2026-05-21T07:02:00.000Z") },
      ],
    })).toMatchObject({ skip: true, verdict: "skip" });

    expect(compareSweepWakeFrame({
      frame: baseFrame,
      issue: baseIssue,
      recentComments: [
        { body: "please re-check this", createdAt: new Date("2026-05-21T07:02:00.000Z") },
      ],
    })).toMatchObject({ skip: false, verdict: "new_comment" });
  });

  it("falls open for status or blocker-list drift", () => {
    expect(compareSweepWakeFrame({
      frame: baseFrame,
      issue: { ...baseIssue, status: "todo" },
      recentComments: [],
    })).toMatchObject({ skip: false, verdict: "status_changed" });

    expect(compareSweepWakeFrame({
      frame: baseFrame,
      issue: { ...baseIssue, blockedByIssueIds: ["blocker-a"] },
      recentComments: [],
    })).toMatchObject({ skip: false, verdict: "blocked_by_changed" });
  });
});

describe("sweep wake frame pages", () => {
  it("round-trips schema version, consecutive skips, arrays, and body", () => {
    const page = composeSweepWakeFramePage({
      ...baseFrame,
      consecutiveSkips: 5,
      body: "# Kept\nThe prose section is unchanged.",
    });

    expect(parseSweepWakeFramePage(page)).toEqual({
      ...baseFrame,
      consecutiveSkips: 5,
      body: "# Kept\nThe prose section is unchanged.",
    });
  });
});

describe("shouldForceSoftTtlRefresh", () => {
  it("forces every twenty-fourth consecutive skip", () => {
    expect(shouldForceSoftTtlRefresh({ ...baseFrame, consecutiveSkips: 23 })).toBe(true);
    expect(shouldForceSoftTtlRefresh({ ...baseFrame, consecutiveSkips: 22 })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  classifyHumanGatedWait,
  formatHumanGatedAgeingSections,
  humanClockAt,
  humanGatedAgeHistogram,
  humanSilenceDays,
  isHumanGatedOpenIssue,
  selectAgedHumanGatedIssues,
  type HumanGatedIssue,
} from "../services/human-gated-ageing.js";

const NOW = new Date("2026-07-31T00:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

/**
 * `createdAt` defaults far enough back that it never clamps a fixture's
 * `lastHumanTouchAt` — the clock is `max(humanTouch, createdAt)`, so a default
 * creation date newer than the touch date would silently flatten every age in
 * the suite to the same value. Tests that exercise the fallback or the clamp
 * pass `createdAt` explicitly.
 */
function issue(overrides: Partial<HumanGatedIssue> & Pick<HumanGatedIssue, "id">): HumanGatedIssue {
  return {
    identifier: overrides.id.toUpperCase(),
    title: `Issue ${overrides.id}`,
    status: "todo",
    priority: "medium",
    assigneeUserId: "user-1",
    createdAt: daysAgo(365),
    lastHumanTouchAt: null,
    ...overrides,
  };
}

describe("human-gated selection", () => {
  it("selects only open issues with a non-null assigneeUserId", () => {
    const rows = [
      issue({ id: "keep-user-assigned", assigneeUserId: "user-1", status: "todo" }),
      issue({ id: "drop-no-user", assigneeUserId: null }),
      issue({ id: "drop-empty-user", assigneeUserId: "" }),
      issue({ id: "drop-done", assigneeUserId: "user-1", status: "done" }),
      issue({ id: "drop-cancelled", assigneeUserId: "user-1", status: "cancelled" }),
      issue({ id: "keep-in-review", assigneeUserId: "user-1", status: "in_review" }),
      issue({ id: "keep-blocked", assigneeUserId: "user-1", status: "blocked" }),
    ];

    expect(rows.filter(isHumanGatedOpenIssue).map((row) => row.id)).toEqual([
      "keep-user-assigned",
      "keep-in-review",
      "keep-blocked",
    ]);

    const report = selectAgedHumanGatedIssues(rows, { now: NOW, escalateAfterDays: 0 });
    expect(report.scanned.map((row) => row.id)).toHaveLength(3);
    expect(report.scanned.every((row) => Boolean(row.assigneeUserId))).toBe(true);
  });

  it("returns rows ordered oldest human-touch first", () => {
    const report = selectAgedHumanGatedIssues(
      [
        issue({ id: "middle", lastHumanTouchAt: daysAgo(30) }),
        issue({ id: "newest", lastHumanTouchAt: daysAgo(2) }),
        issue({ id: "oldest", lastHumanTouchAt: daysAgo(64) }),
      ],
      { now: NOW, escalateAfterDays: 0 },
    );

    expect(report.scanned.map((row) => row.id)).toEqual(["oldest", "middle", "newest"]);
    expect(report.escalated.map((row) => row.id)).toEqual(["oldest", "middle", "newest"]);
    for (let i = 1; i < report.scanned.length; i += 1) {
      expect(report.scanned[i - 1]!.humanSilenceDays).toBeGreaterThan(
        report.scanned[i]!.humanSilenceDays,
      );
    }
  });
});

describe("the escalation clock ignores agent-movable timestamps", () => {
  // Regression guard for the defect this module exists to fix: `updatedAt` and
  // `lastActivityAt` are bumped by agent writes (migration
  // 0076_issues_last_activity_at.sql), so an agent comment on an abandoned
  // issue must not reset its age.
  it("does not read updatedAt or lastActivityAt even when present on the row", () => {
    const abandoned = {
      ...issue({ id: "abandoned", lastHumanTouchAt: daysAgo(64), createdAt: daysAgo(70) }),
      // An agent swept this issue 12 minutes ago and bumped both columns.
      updatedAt: daysAgo(0.008),
      lastActivityAt: daysAgo(0.008),
    } as HumanGatedIssue;

    expect(humanSilenceDays(abandoned, NOW)).toBeCloseTo(64, 5);

    const report = selectAgedHumanGatedIssues([abandoned], { now: NOW, escalateAfterDays: 30 });
    expect(report.totalOverThreshold).toBe(1);
    expect(report.escalated[0]!.id).toBe("abandoned");
  });

  it("falls back to createdAt when a human has never touched the issue", () => {
    const untouched = issue({
      id: "never-touched",
      createdAt: daysAgo(52),
      lastHumanTouchAt: null,
    });

    expect(humanClockAt(untouched).toISOString()).toBe(daysAgo(52));
    expect(humanSilenceDays(untouched, NOW)).toBeCloseTo(52, 5);

    const report = selectAgedHumanGatedIssues([untouched], { now: NOW, escalateAfterDays: 30 });
    expect(report.escalated[0]!.neverTouchedByHuman).toBe(true);
  });

  it("never lets the clock predate issue creation", () => {
    // Defensive: a human comment timestamp older than the issue itself is
    // nonsense, and must not manufacture extra age.
    const skewed = issue({
      id: "skewed",
      createdAt: daysAgo(5),
      lastHumanTouchAt: daysAgo(40),
    });
    expect(humanSilenceDays(skewed, NOW)).toBeCloseTo(5, 5);
  });
});

describe("threshold and reporting", () => {
  it("uses a strict comparison so an issue exactly at the threshold does not fire", () => {
    const exactly = issue({ id: "exactly-30d", lastHumanTouchAt: daysAgo(30) });
    const justOver = issue({ id: "just-over-30d", lastHumanTouchAt: daysAgo(30.5) });

    const report = selectAgedHumanGatedIssues([exactly, justOver], {
      now: NOW,
      escalateAfterDays: 30,
    });
    expect(report.escalated.map((row) => row.id)).toEqual(["just-over-30d"]);
  });

  it("caps the actionable list and reports the remainder as a count", () => {
    const rows = Array.from({ length: 25 }, (_, index) =>
      issue({ id: `aged-${String(index).padStart(2, "0")}`, lastHumanTouchAt: daysAgo(60 - index) }),
    );

    const report = selectAgedHumanGatedIssues(rows, {
      now: NOW,
      escalateAfterDays: 30,
      maxEscalated: 10,
    });

    expect(report.totalOverThreshold).toBe(25);
    expect(report.escalated).toHaveLength(10);
    expect(report.escalatedOmitted).toBe(15);
    // The cap keeps the oldest, not an arbitrary slice.
    expect(report.escalated[0]!.id).toBe("aged-00");
    expect(report.escalated[9]!.id).toBe("aged-09");
  });

  it("separates waiting-on-review from waiting-to-start", () => {
    expect(classifyHumanGatedWait("in_review")).toBe("waiting_on_review");
    expect(classifyHumanGatedWait("todo")).toBe("waiting_to_start");
    expect(classifyHumanGatedWait("backlog")).toBe("waiting_to_start");
    expect(classifyHumanGatedWait("in_progress")).toBe("waiting_in_flight");
    expect(classifyHumanGatedWait("blocked")).toBe("waiting_in_flight");

    const report = selectAgedHumanGatedIssues(
      [
        issue({ id: "review-1", status: "in_review", lastHumanTouchAt: daysAgo(50) }),
        issue({ id: "review-2", status: "in_review", lastHumanTouchAt: daysAgo(45) }),
        issue({ id: "start-1", status: "todo", lastHumanTouchAt: daysAgo(40) }),
        issue({ id: "start-2", status: "backlog", lastHumanTouchAt: daysAgo(35) }),
        issue({ id: "flight-1", status: "blocked", lastHumanTouchAt: daysAgo(33) }),
      ],
      { now: NOW, escalateAfterDays: 30 },
    );

    expect(report.countsByWaitKind).toEqual({
      waiting_on_review: 2,
      waiting_to_start: 2,
      waiting_in_flight: 1,
    });

    const rendered = formatHumanGatedAgeingSections(report);
    expect(rendered).toContain("Waiting on a reviewer");
    expect(rendered).toContain("Waiting for someone to start");
    // Review items must not be listed under the start heading.
    const startSection = rendered.slice(rendered.indexOf("Waiting for someone to start"));
    expect(startSection).not.toContain("REVIEW-1");
  });

  it("groups the rendered report by priority, most urgent first", () => {
    const report = selectAgedHumanGatedIssues(
      [
        issue({ id: "low-1", priority: "low", lastHumanTouchAt: daysAgo(60) }),
        issue({ id: "crit-1", priority: "critical", lastHumanTouchAt: daysAgo(40) }),
        issue({ id: "high-1", priority: "high", lastHumanTouchAt: daysAgo(50) }),
      ],
      { now: NOW, escalateAfterDays: 30 },
    );

    expect(report.countsByPriority).toEqual({ low: 1, critical: 1, high: 1 });

    const rendered = formatHumanGatedAgeingSections(report);
    expect(rendered.indexOf("**critical**")).toBeLessThan(rendered.indexOf("**high**"));
    expect(rendered.indexOf("**high**")).toBeLessThan(rendered.indexOf("**low**"));
  });

  it("reports an empty queue without inventing rows", () => {
    const report = selectAgedHumanGatedIssues(
      [issue({ id: "fresh", lastHumanTouchAt: daysAgo(1) })],
      { now: NOW, escalateAfterDays: 30 },
    );
    expect(report.totalOverThreshold).toBe(0);
    expect(formatHumanGatedAgeingSections(report)).toContain("- None.");
  });

  it("buckets ages into a histogram for threshold justification", () => {
    const report = selectAgedHumanGatedIssues(
      [
        issue({ id: "d3", lastHumanTouchAt: daysAgo(3) }),
        issue({ id: "d10", lastHumanTouchAt: daysAgo(10) }),
        issue({ id: "d16", lastHumanTouchAt: daysAgo(16) }),
        issue({ id: "d25", lastHumanTouchAt: daysAgo(25) }),
        issue({ id: "d40", lastHumanTouchAt: daysAgo(40) }),
        issue({ id: "d95", lastHumanTouchAt: daysAgo(95) }),
      ],
      { now: NOW, escalateAfterDays: 30 },
    );

    expect(humanGatedAgeHistogram(report.scanned)).toEqual([
      { label: "<7d", count: 1 },
      { label: "7-14d", count: 1 },
      { label: "14-21d", count: 1 },
      { label: "21-30d", count: 1 },
      { label: "30-45d", count: 1 },
      { label: "45-60d", count: 0 },
      { label: "60-90d", count: 0 },
      { label: "90d+", count: 1 },
    ]);
  });
});

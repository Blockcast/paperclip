import { describe, expect, it } from "vitest";
import {
  DEFAULT_ESCALATE_AFTER_DAYS_BY_PRIORITY,
  DEFAULT_MAX_ESCALATED,
  escalateAfterDaysFor,
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

/** Same threshold for every priority — for tests that are not about weighting. */
function flat(days: number): Record<string, number> {
  return { critical: days, high: days, medium: days, low: days, unset: days };
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

    const report = selectAgedHumanGatedIssues(rows, { now: NOW, escalateAfterDaysByPriority: flat(0) });
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
      { now: NOW, escalateAfterDaysByPriority: flat(0) },
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

    const report = selectAgedHumanGatedIssues([abandoned], { now: NOW, escalateAfterDaysByPriority: flat(30) });
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

    const report = selectAgedHumanGatedIssues([untouched], { now: NOW, escalateAfterDaysByPriority: flat(30) });
    expect(report.escalated[0]!.neverTouchedByHuman).toBe(true);
    expect(report.neverTouchedByHumanCount).toBe(1);
    expect(formatHumanGatedAgeingSections(report)).toContain(
      "Human-touch fallback: 1 of 1 scanned issues have no human touch timestamp.",
    );
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

describe("priority-weighted thresholds", () => {
  it("applies a different threshold per priority", () => {
    // All four have identical 20d silence; only those whose priority threshold
    // is under 20 should fire.
    const rows = [
      issue({ id: "crit", priority: "critical", lastHumanTouchAt: daysAgo(20) }),
      issue({ id: "high", priority: "high", lastHumanTouchAt: daysAgo(20) }),
      issue({ id: "med", priority: "medium", lastHumanTouchAt: daysAgo(20) }),
      issue({ id: "low", priority: "low", lastHumanTouchAt: daysAgo(20) }),
    ];

    const report = selectAgedHumanGatedIssues(rows, {
      now: NOW,
      escalateAfterDaysByPriority: DEFAULT_ESCALATE_AFTER_DAYS_BY_PRIORITY,
    });

    expect(report.escalated.map((row) => row.id).sort()).toEqual(["crit", "high"]);
    expect(report.countsByPriority).toEqual({ critical: 1, high: 1 });
  });

  it("keeps the long low-priority tail quiet until it is genuinely old", () => {
    // The distribution this module was built against: 55 of the 73 issues past
    // 30d are `low`. A flat 30d rule would make the report 75% low-priority.
    const lowAt35 = issue({ id: "low-35d", priority: "low", lastHumanTouchAt: daysAgo(35) });
    const lowAt50 = issue({ id: "low-50d", priority: "low", lastHumanTouchAt: daysAgo(50) });

    const weighted = selectAgedHumanGatedIssues([lowAt35, lowAt50], {
      now: NOW,
      escalateAfterDaysByPriority: DEFAULT_ESCALATE_AFTER_DAYS_BY_PRIORITY,
    });
    expect(weighted.escalated.map((row) => row.id)).toEqual(["low-50d"]);

    // Guard against a regression back to a flat rule: under flat-30d both fire.
    const flatRule = selectAgedHumanGatedIssues([lowAt35, lowAt50], {
      now: NOW,
      escalateAfterDaysByPriority: flat(30),
    });
    expect(flatRule.totalOverThreshold).toBe(2);
  });

  it("falls back to the most lenient threshold for an unrecognised priority", () => {
    // A new priority value must never silently escalate the whole queue.
    expect(escalateAfterDaysFor("critical", DEFAULT_ESCALATE_AFTER_DAYS_BY_PRIORITY)).toBe(14);
    expect(escalateAfterDaysFor("low", DEFAULT_ESCALATE_AFTER_DAYS_BY_PRIORITY)).toBe(45);
    expect(escalateAfterDaysFor("urgent-ish", DEFAULT_ESCALATE_AFTER_DAYS_BY_PRIORITY)).toBe(45);
    expect(escalateAfterDaysFor(null, DEFAULT_ESCALATE_AFTER_DAYS_BY_PRIORITY)).toBe(45);

    const report = selectAgedHumanGatedIssues(
      [issue({ id: "odd", priority: "urgent-ish", lastHumanTouchAt: daysAgo(20) })],
      { now: NOW, escalateAfterDaysByPriority: DEFAULT_ESCALATE_AFTER_DAYS_BY_PRIORITY },
    );
    expect(report.totalOverThreshold).toBe(0);
  });

  it("renders null and unrecognised priorities instead of dropping them from the digest", () => {
    const report = selectAgedHumanGatedIssues(
      [
        issue({ id: "unknown-priority", priority: "urgent-ish", lastHumanTouchAt: daysAgo(120) }),
        issue({ id: "unset-priority", priority: null, lastHumanTouchAt: daysAgo(90) }),
        issue({ id: "known-medium", priority: "medium", lastHumanTouchAt: daysAgo(60) }),
      ],
      { now: NOW, escalateAfterDaysByPriority: DEFAULT_ESCALATE_AFTER_DAYS_BY_PRIORITY },
    );

    expect(report.totalOverThreshold).toBe(3);
    expect(report.countsByPriority).toEqual({ "urgent-ish": 1, unset: 1, medium: 1 });

    const rendered = formatHumanGatedAgeingSections(report);
    expect(rendered).toContain("unset >45d");
    expect(rendered).toContain("**medium**");
    expect(rendered).toContain("**unset**");
    expect(rendered).toContain("**urgent-ish**");
    expect(rendered).toContain("UNKNOWN-PRIORITY");
    expect(rendered).toContain("UNSET-PRIORITY");
    expect(rendered).toContain("KNOWN-MEDIUM");
  });

  it("ships a default attention budget so an unbounded list cannot be published", () => {
    expect(DEFAULT_MAX_ESCALATED).toBeLessThanOrEqual(20);
    expect(DEFAULT_MAX_ESCALATED).toBeGreaterThan(0);
  });

  it("names its thresholds in the rendered report", () => {
    const report = selectAgedHumanGatedIssues(
      [issue({ id: "old", priority: "high", lastHumanTouchAt: daysAgo(65) })],
      { now: NOW, escalateAfterDaysByPriority: DEFAULT_ESCALATE_AFTER_DAYS_BY_PRIORITY },
    );
    const rendered = formatHumanGatedAgeingSections(report);
    expect(rendered).toContain("high >14d");
    expect(rendered).toContain("low >45d");
    expect(rendered).toContain("last human touch, not `updatedAt`");
  });
});

describe("threshold and reporting", () => {
  it("uses a strict comparison so an issue exactly at the threshold does not fire", () => {
    const exactly = issue({ id: "exactly-30d", lastHumanTouchAt: daysAgo(30) });
    const justOver = issue({ id: "just-over-30d", lastHumanTouchAt: daysAgo(30.5) });

    const report = selectAgedHumanGatedIssues([exactly, justOver], {
      now: NOW,
      escalateAfterDaysByPriority: flat(30),
    });
    expect(report.escalated.map((row) => row.id)).toEqual(["just-over-30d"]);
  });

  it("caps the actionable list and reports the remainder as a count", () => {
    const rows = Array.from({ length: 25 }, (_, index) =>
      issue({ id: `aged-${String(index).padStart(2, "0")}`, lastHumanTouchAt: daysAgo(60 - index) }),
    );

    const report = selectAgedHumanGatedIssues(rows, {
      now: NOW,
      escalateAfterDaysByPriority: flat(30),
      maxEscalated: 10,
    });

    expect(report.totalOverThreshold).toBe(25);
    expect(report.escalated).toHaveLength(10);
    expect(report.escalatedOmitted).toBe(15);
    // The cap keeps the oldest, not an arbitrary slice.
    expect(report.escalated[0]!.id).toBe("aged-00");
    expect(report.escalated[9]!.id).toBe("aged-09");
    expect(formatHumanGatedAgeingSections(report)).toContain("15 further issues");
  });

  it("treats snake_case human-touch input as malformed instead of falling back to createdAt", () => {
    const snakeCaseRow = {
      ...issue({
        id: "snake-case",
        createdAt: daysAgo(400),
      }),
      last_human_touch_at: daysAgo(2),
    } as HumanGatedIssue & { last_human_touch_at: string };
    delete (snakeCaseRow as { lastHumanTouchAt?: string | null }).lastHumanTouchAt;

    const report = selectAgedHumanGatedIssues([snakeCaseRow], {
      now: NOW,
      escalateAfterDaysByPriority: flat(30),
    });

    expect(report.totalOverThreshold).toBe(0);
    expect(report.escalated).toEqual([]);
    expect(report.malformed).toHaveLength(1);
    expect(report.malformed[0]?.reason).toContain("missing lastHumanTouchAt");

    const rendered = formatHumanGatedAgeingSections(report);
    expect(rendered).toContain("Skipped 1 malformed human-gated row");
    expect(rendered).toContain("SNAKE-CASE");
  });

  it("skips malformed rows without losing valid overdue rows", () => {
    const report = selectAgedHumanGatedIssues(
      [
        issue({ id: "valid", lastHumanTouchAt: daysAgo(80) }),
        issue({ id: "bad-created", createdAt: "not-a-date", lastHumanTouchAt: null }),
      ],
      { now: NOW, escalateAfterDaysByPriority: flat(30) },
    );

    expect(report.escalated.map((row) => row.id)).toEqual(["valid"]);
    expect(report.malformed).toHaveLength(1);
    expect(report.malformed[0]?.issue.id).toBe("bad-created");

    const rendered = formatHumanGatedAgeingSections(report);
    expect(rendered).toContain("VALID");
    expect(rendered).toContain("BAD-CREATED");
    expect(rendered).toContain("missing or unparseable createdAt");
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
      { now: NOW, escalateAfterDaysByPriority: flat(30) },
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
      { now: NOW, escalateAfterDaysByPriority: flat(30) },
    );

    expect(report.countsByPriority).toEqual({ low: 1, critical: 1, high: 1 });

    const rendered = formatHumanGatedAgeingSections(report);
    expect(rendered.indexOf("**critical**")).toBeLessThan(rendered.indexOf("**high**"));
    expect(rendered.indexOf("**high**")).toBeLessThan(rendered.indexOf("**low**"));
  });

  it("reports an empty queue without inventing rows", () => {
    const report = selectAgedHumanGatedIssues(
      [issue({ id: "fresh", lastHumanTouchAt: daysAgo(1) })],
      { now: NOW, escalateAfterDaysByPriority: flat(30) },
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
      { now: NOW, escalateAfterDaysByPriority: flat(30) },
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

/**
 * BLO-19777. The malformed-row guard originally ran *downstream* of
 * `isHumanGatedOpenIssue`, which reads `assigneeUserId` and `status`. A
 * mis-mapped row has neither, so the selection filter discarded it as "not
 * human-gated" before the validator could see it: badly overdue rows landed in
 * neither `scanned` nor `malformed`, and the digest published a clean all-clear
 * for input it could not read.
 *
 * The suite missed this because every earlier malformed-input test renamed one
 * field at a time, leaving the two selection keys intact. These tests rename the
 * whole row.
 */
describe("mis-mapped input is caught before the selection filter (BLO-19777)", () => {
  /** A hand-mapped SQL result that never got camelCased — every key renamed. */
  function fullySnakeCaseRow(overrides: {
    id: string;
    identifier: string;
    priority: string;
    status: string;
    createdAt: string;
  }): HumanGatedIssue {
    return {
      id: overrides.id,
      identifier: overrides.identifier,
      title: `Issue ${overrides.id}`,
      priority: overrides.priority,
      assignee_user_id: "user-1",
      issue_status: overrides.status,
      created_at: overrides.createdAt,
      last_human_touch_at: null,
    } as unknown as HumanGatedIssue;
  }

  it("classifies a fully snake_case batch of overdue rows as malformed, not as an all-clear", () => {
    const rows = [
      fullySnakeCaseRow({
        id: "snake-critical",
        identifier: "BLO-AAA",
        priority: "critical",
        status: "in_review",
        createdAt: daysAgo(200),
      }),
      fullySnakeCaseRow({
        id: "snake-high",
        identifier: "BLO-BBB",
        priority: "high",
        status: "todo",
        createdAt: daysAgo(310),
      }),
    ];

    const report = selectAgedHumanGatedIssues(rows, {
      now: NOW,
      escalateAfterDaysByPriority: DEFAULT_ESCALATE_AFTER_DAYS_BY_PRIORITY,
    });

    expect(report.malformed.length).toBeGreaterThan(0);
    expect(report.malformed).toHaveLength(2);
    expect(report.scanned).toEqual([]);
    expect(report.malformed[0]?.reason).toContain("missing assigneeUserId");

    const rendered = formatHumanGatedAgeingSections(report);
    expect(rendered).toContain("Skipped 2 malformed human-gated rows");
    expect(rendered).toContain("BLO-AAA");
    expect(rendered).toContain("BLO-BBB");
  });

  it("does not publish a bare all-clear when rows were skipped", () => {
    const report = selectAgedHumanGatedIssues(
      [
        fullySnakeCaseRow({
          id: "snake",
          identifier: "BLO-AAA",
          priority: "critical",
          status: "in_review",
          createdAt: daysAgo(200),
        }),
      ],
      { now: NOW, escalateAfterDaysByPriority: DEFAULT_ESCALATE_AFTER_DAYS_BY_PRIORITY },
    );

    const rendered = formatHumanGatedAgeingSections(report);
    // The unqualified "- None." line is what made the mapping failure read as
    // positive evidence of a clean input.
    expect(rendered).not.toContain("- None.");
    expect(rendered).toContain("not an all-clear");
  });

  it("catches a mis-mapped selection key even when the other one is intact", () => {
    const missingAssignee = {
      ...issue({ id: "no-assignee-key", createdAt: daysAgo(200) }),
      assignee_user_id: "user-1",
    } as HumanGatedIssue & { assignee_user_id: string };
    delete (missingAssignee as { assigneeUserId?: string | null }).assigneeUserId;

    const missingStatus = {
      ...issue({ id: "no-status-key", createdAt: daysAgo(200) }),
      issue_status: "todo",
    } as HumanGatedIssue & { issue_status: string };
    delete (missingStatus as { status?: string }).status;

    const report = selectAgedHumanGatedIssues([missingAssignee, missingStatus], {
      now: NOW,
      escalateAfterDaysByPriority: flat(30),
    });

    expect(report.scanned).toEqual([]);
    expect(report.malformed.map((entry) => entry.issue.id)).toEqual([
      "no-assignee-key",
      "no-status-key",
    ]);
    expect(report.malformed[0]?.reason).toContain("assignee_user_id");
    expect(report.malformed[1]?.reason).toContain("missing status");
  });

  it("keeps a present-and-null assigneeUserId a legitimate non-human-gated row", () => {
    // The absent-key vs present-and-null distinction: `assigneeUserId: null` is
    // the correct steady state for work that is not human-gated, so it is
    // filtered silently — never reported as a mapping failure.
    const report = selectAgedHumanGatedIssues(
      [
        issue({ id: "not-human-gated", assigneeUserId: null, createdAt: daysAgo(200) }),
        issue({ id: "human-gated", assigneeUserId: "user-1", lastHumanTouchAt: daysAgo(200) }),
      ],
      { now: NOW, escalateAfterDaysByPriority: flat(30) },
    );

    expect(report.malformed).toEqual([]);
    expect(report.scanned.map((row) => row.id)).toEqual(["human-gated"]);
  });

  it("reports no mapping problem for a well-formed batch with zero human-gated rows", () => {
    // Pins the false-positive guard: this is exactly the state a batch-level
    // `input > 0 && scanned === 0 && malformed === 0` heuristic would have
    // misread as broken input, including the variant narrowed to shape-valid
    // rows — both of these rows pass shape validation.
    const report = selectAgedHumanGatedIssues(
      [
        issue({ id: "unassigned", assigneeUserId: null, createdAt: daysAgo(200) }),
        issue({ id: "closed", assigneeUserId: "user-1", status: "done", createdAt: daysAgo(310) }),
      ],
      { now: NOW, escalateAfterDaysByPriority: DEFAULT_ESCALATE_AFTER_DAYS_BY_PRIORITY },
    );

    expect(report.malformed).toHaveLength(0);
    expect(report.scanned).toEqual([]);
    expect(report.totalOverThreshold).toBe(0);

    const rendered = formatHumanGatedAgeingSections(report);
    expect(rendered).not.toContain("malformed human-gated row");
    expect(rendered).not.toContain("fix the input mapping");
    expect(rendered).toContain("- None.");
  });
});

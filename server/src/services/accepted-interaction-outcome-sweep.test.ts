import { describe, expect, it } from "vitest";
import {
  buildAcceptedInteractionOutcomeReport,
  DEFAULT_UNOBSERVED_AFTER_MS,
  type ClassifiedRow,
} from "./accepted-interaction-outcome-sweep.js";

/**
 * PEN-4409 — bucketing rules for the accepted-interaction outcome sweep.
 *
 * The sibling `__tests__/accepted-interaction-outcome-sweep-postgres.test.ts`
 * pins the half this file cannot reach: that the SQL actually resolves a
 * declared reference against `issue_pull_requests` / `issues`. Splitting them
 * matters — a pure test of the bucketer passes just as happily when the query
 * feeding it matches nothing at all, which would make the whole sweep report
 * every card `unobserved` while this file stayed green.
 */
const NOW = new Date("2026-10-20T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function row(overrides: Partial<ClassifiedRow> = {}): ClassifiedRow {
  return {
    interactionId: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    issueId: "33333333-3333-4333-8333-333333333333",
    issueIdentifier: "PEN-4318",
    kind: "request_confirmation",
    outcomeKind: "github_pr_merged",
    source: "declared",
    resolvedAt: new Date(NOW.getTime() - HOUR).toISOString(),
    observed: false,
    ...overrides,
  };
}

describe("buildAcceptedInteractionOutcomeReport", () => {
  it("sorts each card into exactly one of the three buckets", () => {
    const report = buildAcceptedInteractionOutcomeReport([
      row({ interactionId: "a", source: "declared", observed: true }),
      row({ interactionId: "b", source: "declared", observed: false }),
      row({ interactionId: "c", source: "none", outcomeKind: null, observed: false }),
    ], { now: NOW });

    expect(report.buckets.observed.count).toBe(1);
    expect(report.buckets.unobserved.count).toBe(1);
    expect(report.buckets.untracked.count).toBe(1);
    const total = report.buckets.observed.count
      + report.buckets.unobserved.count
      + report.buckets.untracked.count;
    expect(total).toBe(3);
  });

  /**
   * AMENDMENT 2 on the issue, and the whole reason this bucket exists. The card
   * that motivated PEN-4409 declared nothing; a sweep that reported only the
   * cards carrying a reference would have been blind to it while reading clean.
   */
  it("reports a card that declared no outcome as untracked rather than dropping it", () => {
    const report = buildAcceptedInteractionOutcomeReport([
      row({ source: "none", outcomeKind: null }),
    ], { now: NOW });

    expect(report.buckets.untracked.count).toBe(1);
    expect(report.buckets.untracked.samples).toHaveLength(1);
    expect(report.buckets.untracked.samples[0]?.source).toBe("none");
    expect(report.buckets.observed.count).toBe(0);
    expect(report.buckets.unobserved.count).toBe(0);
  });

  it("treats a platform tool-action lifecycle as an outcome record, not as untracked", () => {
    const report = buildAcceptedInteractionOutcomeReport([
      row({ interactionId: "executed", source: "tool_action", outcomeKind: null, observed: true }),
      row({ interactionId: "failed", source: "tool_action", outcomeKind: null, observed: false }),
    ], { now: NOW });

    expect(report.buckets.untracked.count).toBe(0);
    expect(report.buckets.observed.count).toBe(1);
    expect(report.buckets.unobserved.count).toBe(1);
  });

  /**
   * The ambiguity direction that keeps this sweep honest. A declared outcome
   * the build has no observer for must read `unobserved`, never `observed`: a
   * false alarm costs a look, a false clear is worse than the silence this
   * replaces.
   */
  it("reports a declared-but-unobserved card as unobserved, never as observed", () => {
    const report = buildAcceptedInteractionOutcomeReport([
      row({ outcomeKind: "some_future_kind", observed: false }),
    ], { now: NOW });

    expect(report.buckets.unobserved.count).toBe(1);
    expect(report.buckets.observed.count).toBe(0);
  });

  /**
   * The threshold partitions the REPORT. A card younger than N stays counted in
   * its bucket — dropping it would reintroduce, as a time window, the silent
   * exclusion the untracked bucket exists to prevent.
   */
  it("keeps sub-threshold cards in the population and only flags them out of beyondThresholdCount", () => {
    const report = buildAcceptedInteractionOutcomeReport([
      row({ interactionId: "old", resolvedAt: new Date(NOW.getTime() - 30 * HOUR).toISOString() }),
      row({ interactionId: "fresh", resolvedAt: new Date(NOW.getTime() - 1 * HOUR).toISOString() }),
    ], { now: NOW, unobservedAfterMs: DEFAULT_UNOBSERVED_AFTER_MS });

    expect(report.buckets.unobserved.count).toBe(2);
    expect(report.buckets.unobserved.beyondThresholdCount).toBe(1);
    expect(report.buckets.unobserved.samples.map((s) => s.interactionId)).toEqual(["old", "fresh"]);
  });

  it("reports the oldest age per bucket and leaves an empty bucket null rather than zero", () => {
    const report = buildAcceptedInteractionOutcomeReport([
      row({ interactionId: "old", resolvedAt: new Date(NOW.getTime() - 5 * HOUR).toISOString() }),
      row({ interactionId: "new", resolvedAt: new Date(NOW.getTime() - 1 * HOUR).toISOString() }),
    ], { now: NOW });

    expect(report.buckets.unobserved.oldestAgeSeconds).toBe(5 * 60 * 60);
    // Zero here would read as "an acceptance made this instant", which is the
    // opposite of "there is nothing in this bucket".
    expect(report.buckets.observed.oldestAgeSeconds).toBeNull();
    expect(report.buckets.untracked.oldestAgeSeconds).toBeNull();
  });

  it("counts a card whose resolvedAt cannot be parsed but leaves it out of the age statistics", () => {
    const report = buildAcceptedInteractionOutcomeReport([
      row({ resolvedAt: "not-a-timestamp" }),
    ], { now: NOW });

    expect(report.buckets.unobserved.count).toBe(1);
    expect(report.buckets.unobserved.oldestAgeSeconds).toBeNull();
    expect(report.buckets.unobserved.beyondThresholdCount).toBe(0);
  });

  it("caps samples at ten and carries the oldest, which are the ones worth chasing", () => {
    const rows = Array.from({ length: 15 }, (_, index) => row({
      interactionId: `card-${index}`,
      resolvedAt: new Date(NOW.getTime() - (index + 1) * HOUR).toISOString(),
    }));

    const report = buildAcceptedInteractionOutcomeReport(rows, { now: NOW });

    expect(report.buckets.unobserved.count).toBe(15);
    expect(report.buckets.unobserved.samples).toHaveLength(10);
    expect(report.buckets.unobserved.samples[0]?.interactionId).toBe("card-14");
  });
});

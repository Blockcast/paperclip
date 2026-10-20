import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetAcceptedInteractionOutcomeLogStateForTest,
  buildAcceptedInteractionOutcomeReport,
  DEFAULT_RECENT_WINDOW_MS,
  DEFAULT_UNOBSERVED_AFTER_MS,
  refreshAcceptedInteractionOutcomeMetrics,
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
    acknowledged: false,
    ...overrides,
  };
}

describe("buildAcceptedInteractionOutcomeReport", () => {
  it("sorts each card into exactly one of the four buckets", () => {
    const report = buildAcceptedInteractionOutcomeReport([
      row({ interactionId: "a", source: "declared", observed: true }),
      row({ interactionId: "b", source: "declared", observed: false }),
      row({ interactionId: "c", source: "none", outcomeKind: null, observed: false }),
      row({ interactionId: "d", source: "declared", observed: false, acknowledged: true }),
    ], { now: NOW });

    expect(report.buckets.observed.count).toBe(1);
    expect(report.buckets.unobserved.count).toBe(1);
    expect(report.buckets.untracked.count).toBe(1);
    expect(report.buckets.acknowledged.count).toBe(1);
    const total = report.buckets.observed.count
      + report.buckets.unobserved.count
      + report.buckets.untracked.count
      + report.buckets.acknowledged.count;
    expect(total).toBe(4);
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
  /**
   * The clearing path. An acceptance is terminal, so `withdrawInteraction`
   * refuses it and a moot card had NO exit from `unobserved` at all. Because
   * the alert thresholds the oldest age in the bucket, one such card pinned the
   * warning on forever and masked every newer card behind it.
   */
  it("moves an acknowledged card out of unobserved so the oldest-age alert can clear", () => {
    const stuck = row({
      interactionId: "moot",
      resolvedAt: new Date(NOW.getTime() - 400 * HOUR).toISOString(),
      acknowledged: true,
    });
    const fresh = row({
      interactionId: "real",
      resolvedAt: new Date(NOW.getTime() - 30 * HOUR).toISOString(),
    });

    const report = buildAcceptedInteractionOutcomeReport([stuck, fresh], { now: NOW });

    expect(report.buckets.acknowledged.count).toBe(1);
    expect(report.buckets.unobserved.count).toBe(1);
    // The 400h card no longer sets the unobserved oldest age, so the newer card
    // is visible behind it instead of being masked.
    expect(report.buckets.unobserved.samples[0]?.interactionId).toBe("real");
    expect(report.buckets.unobserved.oldestAgeSeconds).toBeCloseTo(30 * 3600, 0);
  });

  it("clears an acknowledged card out of untracked too, not only out of unobserved", () => {
    const report = buildAcceptedInteractionOutcomeReport([
      row({ source: "none", outcomeKind: null, acknowledged: true }),
    ], { now: NOW });

    expect(report.buckets.untracked.count).toBe(0);
    expect(report.buckets.acknowledged.count).toBe(1);
  });

  /**
   * Observed outranks acknowledged: if the action demonstrably happened, that is
   * the better record, and filing it under "nobody is waiting" would misreport
   * a card whose action was in fact done.
   */
  it("reports an acknowledged card whose action did happen as observed", () => {
    const report = buildAcceptedInteractionOutcomeReport([
      row({ source: "declared", observed: true, acknowledged: true }),
    ], { now: NOW });

    expect(report.buckets.observed.count).toBe(1);
    expect(report.buckets.acknowledged.count).toBe(0);
  });

  /**
   * The adoption series. `count` and `oldestAgeSeconds` are all-time, and every
   * acceptance predating the feature is permanently untracked — so an alert on
   * either is true from the first tick after deploy and can never be cleared by
   * the adoption it asks for.
   */
  it("counts only acceptances inside the trailing window as recent", () => {
    const report = buildAcceptedInteractionOutcomeReport([
      row({ interactionId: "old", source: "none", outcomeKind: null,
        resolvedAt: new Date(NOW.getTime() - DEFAULT_RECENT_WINDOW_MS - HOUR).toISOString() }),
      row({ interactionId: "new", source: "none", outcomeKind: null,
        resolvedAt: new Date(NOW.getTime() - HOUR).toISOString() }),
    ], { now: NOW });

    expect(report.buckets.untracked.count).toBe(2);
    expect(report.buckets.untracked.recentCount).toBe(1);
  });

  it("leaves an undateable card out of recentCount rather than assuming it is recent", () => {
    const report = buildAcceptedInteractionOutcomeReport([
      row({ source: "none", outcomeKind: null, resolvedAt: "not-a-date" }),
    ], { now: NOW });

    expect(report.buckets.untracked.count).toBe(1);
    expect(report.buckets.untracked.recentCount).toBe(0);
  });
});

/**
 * The untracked population is every accepted confirmation ever filed with no
 * declaration, and none of them can acquire one retroactively — so the log
 * condition is permanently true in any installation with history. Unthrottled,
 * that meant a line carrying up to twenty nested sample objects on EVERY 15 s
 * collector tick, per replica, forever (~5.7k lines/day/replica), restating a
 * set that had not changed.
 */
describe("refreshAcceptedInteractionOutcomeMetrics logging", () => {
  const STALE = new Date("2026-01-01T00:00:00.000Z").toISOString();

  function dbReturning(rows: ClassifiedRow[]) {
    return { execute: async () => rows } as never;
  }

  function logger() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
  }

  beforeEach(() => {
    __resetAcceptedInteractionOutcomeLogStateForTest();
  });

  it("logs the first tick, then stays silent while the picture is unchanged", async () => {
    const rows = [row({ source: "none", outcomeKind: null, resolvedAt: STALE })];
    const log = logger();
    const db = dbReturning(rows);

    await refreshAcceptedInteractionOutcomeMetrics(db, { now: NOW, logger: log });
    await refreshAcceptedInteractionOutcomeMetrics(db, {
      now: new Date(NOW.getTime() + 15_000),
      logger: log,
    });
    await refreshAcceptedInteractionOutcomeMetrics(db, {
      now: new Date(NOW.getTime() + 30_000),
      logger: log,
    });

    expect((log as unknown as { info: { mock: { calls: unknown[] } } }).info.mock.calls).toHaveLength(1);
  });

  it("logs again when a card enters the bucket", async () => {
    const log = logger();
    const first = [row({ interactionId: "a", source: "none", outcomeKind: null, resolvedAt: STALE })];
    const second = [
      ...first,
      row({ interactionId: "b", source: "none", outcomeKind: null, resolvedAt: STALE }),
    ];

    await refreshAcceptedInteractionOutcomeMetrics(dbReturning(first), { now: NOW, logger: log });
    await refreshAcceptedInteractionOutcomeMetrics(dbReturning(second), {
      now: new Date(NOW.getTime() + 15_000),
      logger: log,
    });

    expect((log as unknown as { info: { mock: { calls: unknown[] } } }).info.mock.calls).toHaveLength(2);
  });

  it("restates a standing problem on the periodic floor so it cannot fall out of a log search", async () => {
    const rows = [row({ source: "none", outcomeKind: null, resolvedAt: STALE })];
    const log = logger();

    await refreshAcceptedInteractionOutcomeMetrics(dbReturning(rows), { now: NOW, logger: log });
    await refreshAcceptedInteractionOutcomeMetrics(dbReturning(rows), {
      now: new Date(NOW.getTime() + 61 * 60 * 1000),
      logger: log,
    });

    const calls = (log as unknown as { info: { mock: { calls: Array<[Record<string, unknown>, string]> } } })
      .info.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[0]?.reason).toBe("periodic");
  });

  it("stays silent when nothing is past the threshold at all", async () => {
    const log = logger();
    const rows = [row({
      source: "none",
      outcomeKind: null,
      resolvedAt: new Date(NOW.getTime() - HOUR).toISOString(),
    })];

    await refreshAcceptedInteractionOutcomeMetrics(dbReturning(rows), { now: NOW, logger: log });

    expect((log as unknown as { info: { mock: { calls: unknown[] } } }).info.mock.calls).toHaveLength(0);
  });
});

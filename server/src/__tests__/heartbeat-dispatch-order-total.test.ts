import { describe, expect, it } from "vitest";
import { compareQueuedRunDispatchOrder } from "../services/heartbeat.js";

/**
 * BLO-28886 ask 1. Deliberately a PURE test with no embedded Postgres: the
 * BLO-12990 suite that surfaced this (`heartbeat-dispatch-priority-sort`)
 * reports "skipped" on hosts without embedded Postgres, so the determinism
 * property it cares about was unverifiable anywhere but CI.
 */
describe("queued-run dispatch order is total (BLO-28886)", () => {
  const sameInstant = new Date("2026-09-21T00:00:00.000Z");
  const run = (id: string, createdAt = sameInstant) => ({ id, createdAt });

  // Every run equal-rank AND equal-createdAt: the exact tie that lane
  // concatenation used to resolve by admission order.
  const tied = ["ccc", "aaa", "bbb"].map((id) => run(id));
  const ranks = new Map(tied.map((r) => [r.id, 10]));

  const sortWith = (runs: typeof tied, promoted: string | null = null) =>
    [...runs]
      .sort((l, r) => compareQueuedRunDispatchOrder(l, r, ranks, promoted))
      .map((r) => r.id);

  it("breaks a rank+createdAt tie on id, independent of input order", () => {
    // The assertion that fails if the `|| left.id.localeCompare(right.id)` leg
    // is removed: without it the comparator returns 0 for every pair and the
    // stable sort just echoes each input permutation back.
    expect(sortWith(tied)).toEqual(["aaa", "bbb", "ccc"]);
    expect(sortWith([...tied].reverse())).toEqual(["aaa", "bbb", "ccc"]);
    expect(sortWith([tied[1]!, tied[2]!, tied[0]!])).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("still ranks first and ages second", () => {
    const older = run("zzz", new Date(sameInstant.getTime() - 1));
    const withRanks = new Map([...ranks, [older.id, 10]]);
    // Age beats id: zzz sorts ahead of aaa despite the later id.
    expect(
      [older, ...tied]
        .sort((l, r) => compareQueuedRunDispatchOrder(l, r, withRanks, null))
        .map((r) => r.id),
    ).toEqual(["zzz", "aaa", "bbb", "ccc"]);

    // Rank beats age: promote ccc's rank and it leads despite being newest-tied.
    const betterRank = new Map([...withRanks, ["ccc", 1]]);
    expect(
      [older, ...tied]
        .sort((l, r) => compareQueuedRunDispatchOrder(l, r, betterRank, null))
        .map((r) => r.id),
    ).toEqual(["ccc", "zzz", "aaa", "bbb"]);
  });

  it("keeps the PR-review fairness promotion ahead of everything", () => {
    expect(sortWith(tied, "ccc")).toEqual(["ccc", "aaa", "bbb"]);
  });

  it("is a consistent comparator: antisymmetric and reflexive-zero", () => {
    // A non-total comparator is also an inconsistent one, which is what lets
    // V8's sort produce different output for different input permutations.
    for (const left of tied) {
      expect(compareQueuedRunDispatchOrder(left, left, ranks, null)).toBe(0);
      for (const right of tied) {
        if (left.id === right.id) continue;
        expect(
          Math.sign(compareQueuedRunDispatchOrder(left, right, ranks, null)),
        ).toBe(-Math.sign(compareQueuedRunDispatchOrder(right, left, ranks, null)));
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import { serializeSweepInvocations } from "./service.js";

/**
 * BLO-29763 item 2: the backstop cursors are single mutable closure variables read before
 * the candidate query and written after it, so overlapping invocations can both read the
 * same cursor, rescan one page, and leave the next page unvisited for that cycle.
 *
 * The harness below reproduces exactly that shape -- read cursor, `await` a paginated
 * query, write cursor -- with the query suspended on an explicit gate so the interleaving
 * is deterministic rather than timing-dependent. The first test drives it unguarded and
 * asserts the page loss (the defect); the rest drive it through
 * `serializeSweepInvocations` and assert every candidate is visited exactly once per
 * sweep cycle.
 */
function createCursorSweepHarness(candidates: string[], pageLimit: number) {
  let cursor: string | null = null;
  let inFlight = 0;
  let maxInFlight = 0;
  const visits: string[] = [];
  const queryGates: Array<() => void> = [];

  // Mirrors the production query: `id > cursor` predicate, `limit`, and a
  // `count(*) over()` total evaluated after the cursor predicate.
  const queryCandidates = async (from: string | null) => {
    await new Promise<void>((resolve) => queryGates.push(resolve));
    const remaining = from === null ? candidates : candidates.slice(candidates.indexOf(from) + 1);
    return { rows: remaining.slice(0, pageLimit), totalCount: remaining.length };
  };

  const impl = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const cursorBeforeQuery = cursor; // READ
      const { rows, totalCount } = await queryCandidates(cursorBeforeQuery); // race window
      visits.push(...rows);
      const deferred = Math.max(0, totalCount - rows.length);
      const lastCandidate = rows[rows.length - 1] ?? null;
      cursor = deferred > 0 && lastCandidate ? lastCandidate : null; // WRITE
      return { visited: rows, deferred };
    } finally {
      inFlight -= 1;
    }
  };

  const releasePendingQueries = () => {
    while (queryGates.length > 0) queryGates.shift()?.();
  };

  /**
   * Releases gates until `settled` resolves. A serialized sweep only exposes one gate at a
   * time (invocation N+1 has not started yet), so the release has to be repeated rather
   * than done once up front.
   */
  const drain = async <T>(settled: Promise<T>): Promise<T> => {
    let done = false;
    const tracked = settled.finally(() => {
      done = true;
    });
    while (!done) {
      releasePendingQueries();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return tracked;
  };

  return {
    impl,
    visits,
    drain,
    releasePendingQueries,
    pendingQueryCount: () => queryGates.length,
    cursorValue: () => cursor,
    maxInFlight: () => maxInFlight,
  };
}

describe("backstop shared-cursor concurrency guard (BLO-29763)", () => {
  it("loses a page when two invocations interleave unguarded", async () => {
    // Negative control: this is the defect, asserted against the raw cursor sweep with no
    // serialization. If this test ever stops losing a page, the harness no longer models
    // the production read-modify-write and the guard tests below prove nothing.
    const harness = createCursorSweepHarness(["a", "b", "c", "d"], 2);

    const first = harness.impl();
    const second = harness.impl();
    // Both invocations reached the `await` having read the same cursor (null).
    expect(harness.pendingQueryCount()).toBe(2);
    expect(harness.maxInFlight()).toBe(2);

    harness.releasePendingQueries();
    await Promise.all([first, second]);

    expect(harness.visits).toEqual(["a", "b", "a", "b"]);
    // "c" and "d" were never visited in this cycle even though two ticks ran.
    expect(harness.visits).not.toContain("c");
    expect(harness.visits).not.toContain("d");
  });

  it("visits every candidate exactly once per sweep cycle when serialized", async () => {
    const harness = createCursorSweepHarness(["a", "b", "c", "d"], 2);
    const sweep = serializeSweepInvocations(harness.impl);

    const first = sweep();
    const second = sweep();
    const results = await harness.drain(Promise.all([first, second]));

    expect(harness.visits).toEqual(["a", "b", "c", "d"]);
    expect(new Set(harness.visits).size).toBe(harness.visits.length);
    expect(results[0]).toEqual({ visited: ["a", "b"], deferred: 2 });
    expect(results[1]).toEqual({ visited: ["c", "d"], deferred: 0 });
    // Concurrent entry was refused: the second invocation never started until the first settled.
    expect(harness.maxInFlight()).toBe(1);
    // Cursor reset on the drain tick, so the next cycle wraps to the head of the set.
    expect(harness.cursorValue()).toBeNull();
  });

  it("keeps coverage complete when more invocations overlap than there are pages", async () => {
    const harness = createCursorSweepHarness(["a", "b", "c", "d", "e"], 2);
    const sweep = serializeSweepInvocations(harness.impl);

    // Five overlapping ticks against a three-page set: pages 1-3 drain the cycle, then the
    // cursor wraps and the fourth/fifth ticks begin the next cycle from the head.
    const results = await harness.drain(Promise.all([sweep(), sweep(), sweep(), sweep(), sweep()]));

    expect(harness.visits.slice(0, 5)).toEqual(["a", "b", "c", "d", "e"]);
    expect(results.map((result) => result.visited)).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e"],
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(harness.maxInFlight()).toBe(1);
  });

  it("surfaces a rejection to its caller without wedging later invocations", async () => {
    // The tail swallows rejections so one failing sweep cannot stall every later tick,
    // but the caller must still see the failure.
    let attempt = 0;
    const sweep = serializeSweepInvocations(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("candidate query failed");
      return attempt;
    });

    const failing = sweep();
    const following = sweep();

    await expect(failing).rejects.toThrow("candidate query failed");
    await expect(following).resolves.toBe(2);
    await expect(sweep()).resolves.toBe(3);
  });

  it("passes arguments through to the wrapped sweep unchanged", async () => {
    const seen: Array<{ companyId?: string } | undefined> = [];
    const sweep = serializeSweepInvocations(async (opts?: { companyId?: string }) => {
      seen.push(opts);
      return opts?.companyId ?? null;
    });

    await expect(sweep({ companyId: "company-1" })).resolves.toBe("company-1");
    await expect(sweep()).resolves.toBeNull();
    expect(seen).toEqual([{ companyId: "company-1" }, undefined]);
  });
});

import { describe, expect, it } from "vitest";
import {
  createStrandedAttendancePrefetch,
  DEFAULT_STRANDED_ATTENDANCE_PREFETCH_TTL_MS,
  DEFAULT_STRANDED_ATTENDANCE_PREFETCH_WINDOW,
  type StrandedAttendanceWindow,
  type StrandedAttendanceWindowLoader,
} from "./stranded-attendance-prefetch.js";

type Candidate = { id: string; companyId: string };

function candidates(companyId: string, count: number, offset = 0): Candidate[] {
  return Array.from({ length: count }, (_, i) => ({ id: `i${offset + i}`, companyId }));
}

/**
 * Records every window it was asked for, so the assertions below can be about the
 * *round-trips taken* rather than about the answers — which is the whole subject of this
 * module. A loader that merely returned right answers would leave the saving unasserted.
 */
function recordingLoader(
  answer: (companyId: string, ids: readonly string[]) => StrandedAttendanceWindow = () => ({
    executionPath: new Map(),
    pendingWakeInteractionIssueIds: new Set(),
  }),
) {
  const calls: { companyId: string; ids: string[] }[] = [];
  const loader: StrandedAttendanceWindowLoader = async (companyId, ids) => {
    calls.push({ companyId, ids: [...ids] });
    return answer(companyId, ids);
  };
  return { loader, calls };
}

function windowWith(opts: {
  executionPath?: Record<string, { any: boolean; agentIds: string[] }>;
  pendingWake?: string[];
}): StrandedAttendanceWindow {
  return {
    executionPath: new Map(
      Object.entries(opts.executionPath ?? {}).map(([issueId, evidence]) => [
        issueId,
        { any: evidence.any, agentIds: new Set(evidence.agentIds) },
      ]),
    ),
    pendingWakeInteractionIssueIds: new Set(opts.pendingWake ?? []),
  };
}

describe("createStrandedAttendancePrefetch", () => {
  it("loads one window for a run of candidates instead of one read each", async () => {
    const rows = candidates("c1", 10);
    const { loader, calls } = recordingLoader();
    const prefetch = createStrandedAttendancePrefetch(loader, rows, {
      windowSize: 10,
      now: () => 0,
    });

    for (const row of rows) {
      await prefetch.hasActiveExecutionPath(row.companyId, row.id, null);
      await prefetch.hasPendingWakeInteraction(row.companyId, row.id);
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.ids).toEqual(rows.map((row) => row.id));
    // Two lookups per candidate; the first candidate's first lookup is the load.
    expect(prefetch.stats()).toEqual({
      liveReads: 1,
      prefetchHits: 19,
      windowExpiries: 0,
      idsLoaded: 10,
    });
  });

  it("reloads when the loop walks off the end of a window, without counting an expiry", async () => {
    const rows = candidates("c1", 9);
    const { loader, calls } = recordingLoader();
    const prefetch = createStrandedAttendancePrefetch(loader, rows, {
      windowSize: 4,
      now: () => 0,
    });

    for (const row of rows) await prefetch.hasActiveExecutionPath(row.companyId, row.id, null);

    expect(calls.map((call) => call.ids)).toEqual([
      ["i0", "i1", "i2", "i3"],
      ["i4", "i5", "i6", "i7"],
      ["i8"],
    ]);
    expect(prefetch.stats().windowExpiries).toBe(0);
  });

  it("never spans two companies in one window, because the loader is company-scoped", async () => {
    const rows = [...candidates("c1", 2), ...candidates("c2", 2, 2)];
    const { loader, calls } = recordingLoader();
    const prefetch = createStrandedAttendancePrefetch(loader, rows, {
      windowSize: 10,
      now: () => 0,
    });

    for (const row of rows) await prefetch.hasActiveExecutionPath(row.companyId, row.id, null);

    expect(calls).toEqual([
      { companyId: "c1", ids: ["i0", "i1"] },
      { companyId: "c2", ids: ["i2", "i3"] },
    ]);
  });

  it("expires a window once the TTL elapses, and says so separately from exhaustion", async () => {
    const rows = candidates("c1", 3);
    const { loader, calls } = recordingLoader();
    let clock = 0;
    const prefetch = createStrandedAttendancePrefetch(loader, rows, {
      windowSize: 10,
      ttlMs: 100,
      now: () => clock,
    });

    await prefetch.hasActiveExecutionPath("c1", "i0", null);
    clock = 99;
    await prefetch.hasActiveExecutionPath("c1", "i1", null);
    expect(calls).toHaveLength(1);

    clock = 100;
    await prefetch.hasActiveExecutionPath("c1", "i2", null);
    expect(calls).toHaveLength(2);
    expect(prefetch.stats().windowExpiries).toBe(1);
  });

  it("stamps the window's age BEFORE the load, so a load slower than the TTL is born expired", async () => {
    // The degraded-database case. It must fall back to one load per candidate rather
    // than serving an entry that is already older than its own freshness bound — the
    // direction the module's doc comment commits to.
    const rows = candidates("c1", 3);
    let clock = 0;
    const calls: string[][] = [];
    const loader: StrandedAttendanceWindowLoader = async (_companyId, ids) => {
      calls.push([...ids]);
      clock += 500; // the load itself outlives the 100 ms TTL
      return { executionPath: new Map(), pendingWakeInteractionIssueIds: new Set() };
    };
    const prefetch = createStrandedAttendancePrefetch(loader, rows, {
      windowSize: 10,
      ttlMs: 100,
      now: () => clock,
    });

    for (const row of rows) await prefetch.hasActiveExecutionPath(row.companyId, row.id, null);

    expect(calls).toHaveLength(3);
    expect(prefetch.stats().prefetchHits).toBe(0);
    expect(prefetch.stats().windowExpiries).toBe(2);
  });

  it("books a throwing load as a round-trip taken, and propagates it", async () => {
    // The stats-before-await rule. Counting on return would make the reading improve as
    // the database degraded, which is the one direction a saving metric must not move.
    const rows = candidates("c1", 2);
    let shouldThrow = true;
    const loader: StrandedAttendanceWindowLoader = async () => {
      if (shouldThrow) throw new Error("db down");
      return { executionPath: new Map(), pendingWakeInteractionIssueIds: new Set() };
    };
    const prefetch = createStrandedAttendancePrefetch(loader, rows, {
      windowSize: 2,
      now: () => 0,
    });

    await expect(prefetch.hasActiveExecutionPath("c1", "i0", null)).rejects.toThrow("db down");
    expect(prefetch.stats().liveReads).toBe(1);
    expect(prefetch.stats().prefetchHits).toBe(0);

    // And the failure left nothing addressable: the retry loads rather than serving a
    // window that was never populated.
    shouldThrow = false;
    expect(await prefetch.hasActiveExecutionPath("c1", "i0", null)).toBe(false);
    expect(prefetch.stats().liveReads).toBe(2);
  });

  it("reproduces the unfiltered and the agent-scoped predicate from one window", async () => {
    const rows = candidates("c1", 3);
    const { loader } = recordingLoader(() =>
      windowWith({
        executionPath: {
          i0: { any: true, agentIds: ["a1"] },
          // The nullable-agent shape: a row exists, but carries no agent id. The
          // unfiltered predicate must still see it; the agent-scoped one must not.
          i1: { any: true, agentIds: [] },
        },
      })
    );
    const prefetch = createStrandedAttendancePrefetch(loader, rows, { now: () => 0 });

    expect(await prefetch.hasActiveExecutionPath("c1", "i0", null)).toBe(true);
    expect(await prefetch.hasActiveExecutionPath("c1", "i0", "a1")).toBe(true);
    expect(await prefetch.hasActiveExecutionPath("c1", "i0", "a2")).toBe(false);

    expect(await prefetch.hasActiveExecutionPath("c1", "i1", null)).toBe(true);
    expect(await prefetch.hasActiveExecutionPath("c1", "i1", "a1")).toBe(false);

    expect(await prefetch.hasActiveExecutionPath("c1", "i2", null)).toBe(false);
    expect(await prefetch.hasActiveExecutionPath("c1", "i2", "a1")).toBe(false);

    // An empty-string agent id takes the UNFILTERED branch, matching the single-issue
    // form's `agentId ? eq(...) : sql`true``. Unreachable from today's sweep, pinned so
    // the two forms cannot quietly disagree about it.
    expect(await prefetch.hasActiveExecutionPath("c1", "i1", "")).toBe(true);
    expect(await prefetch.hasActiveExecutionPath("c1", "i2", "")).toBe(false);
  });

  it("answers the wake-interaction predicate from the same window the path check loaded", async () => {
    const rows = candidates("c1", 2);
    const { loader, calls } = recordingLoader(() => windowWith({ pendingWake: ["i1"] }));
    const prefetch = createStrandedAttendancePrefetch(loader, rows, { now: () => 0 });

    expect(await prefetch.hasActiveExecutionPath("c1", "i0", null)).toBe(false);
    expect(await prefetch.hasPendingWakeInteraction("c1", "i0")).toBe(false);
    expect(await prefetch.hasPendingWakeInteraction("c1", "i1")).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("falls back to a window of one for an id outside the candidate list", async () => {
    // Master's behaviour for that call is a single-issue read; the fallback must not be
    // an empty window, which would answer `false` for an issue nobody looked up.
    const { loader, calls } = recordingLoader(() =>
      windowWith({ executionPath: { stray: { any: true, agentIds: ["a1"] } } })
    );
    const prefetch = createStrandedAttendancePrefetch(loader, candidates("c1", 2), {
      now: () => 0,
    });

    expect(await prefetch.hasActiveExecutionPath("c1", "stray", null)).toBe(true);
    expect(calls).toEqual([{ companyId: "c1", ids: ["stray"] }]);
  });

  it("keeps the two published defaults at the values their freshness arguments were made for", () => {
    // `ttlMs` is the number a reviewer has to accept, and it is deliberately the same
    // 5 s already accepted for the pause-hold prefilter and the agent-roster memo.
    expect(DEFAULT_STRANDED_ATTENDANCE_PREFETCH_TTL_MS).toBe(5_000);
    expect(DEFAULT_STRANDED_ATTENDANCE_PREFETCH_WINDOW).toBe(64);
  });
});

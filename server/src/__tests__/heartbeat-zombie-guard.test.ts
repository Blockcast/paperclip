import { describe, expect, it } from "vitest";
import {
  isZombieRun,
  filterZombieCoalesceTarget,
  isCoalesceTargetPastHeartbeatInterval,
  filterIntervalOverrunCoalesceTarget,
  resolveStalledCoalesceBudgetMs,
  STALLED_COALESCE_INTERVAL_MULTIPLE,
  STALLED_COALESCE_MIN_BUDGET_MS,
} from "../services/heartbeat.ts";

// ---------------------------------------------------------------------------
// isZombieRun — the core predicate
// ---------------------------------------------------------------------------
describe("isZombieRun", () => {
  it("returns true for a running run not tracked in runningProcesses", () => {
    const run = { status: "running", id: "run-1" };
    const tracked = new Map<string, unknown>();

    expect(isZombieRun(run, tracked)).toBe(true);
  });

  it("returns false for a queued run not tracked in runningProcesses", () => {
    const run = { status: "queued", id: "run-2" };
    const tracked = new Map<string, unknown>();

    expect(isZombieRun(run, tracked)).toBe(false);
  });

  it("returns false for a running run that IS tracked in runningProcesses", () => {
    const run = { status: "running", id: "run-3" };
    const tracked = new Map<string, unknown>([["run-3", { pid: 12345 }]]);

    expect(isZombieRun(run, tracked)).toBe(false);
  });

  it("returns false for a failed run not tracked in runningProcesses", () => {
    const run = { status: "failed", id: "run-4" };
    const tracked = new Map<string, unknown>();

    expect(isZombieRun(run, tracked)).toBe(false);
  });

  it("returns false for a completed run not tracked in runningProcesses", () => {
    const run = { status: "completed", id: "run-5" };
    const tracked = new Map<string, unknown>();

    expect(isZombieRun(run, tracked)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterZombieCoalesceTarget — the coalescing guard used in both paths
//
// These tests exercise the BEHAVIOR described in spec AC2 and AC3:
// "Coalescing does not refresh updatedAt on zombie runs"
// When the target is a zombie, the filter returns null so the wakeup
// falls through to create a new queued run instead of merging into the dead one.
// ---------------------------------------------------------------------------
describe("filterZombieCoalesceTarget", () => {
  // Bug 1 scenario: a "running" run with no live process is a zombie.
  // Coalescing into it would refresh updatedAt, making it immortal.
  it("returns null for a zombie running run (the critical bug fix)", () => {
    const zombieRun = { status: "running", id: "zombie-1" };
    const emptyTracked = new Map<string, unknown>();

    expect(filterZombieCoalesceTarget(zombieRun, emptyTracked)).toBeNull();
  });

  // Legitimate running process — coalescing should proceed normally.
  it("passes through a legitimate running run that IS tracked", () => {
    const liveRun = { status: "running", id: "live-1" };
    const tracked = new Map<string, unknown>([["live-1", { pid: 99 }]]);

    expect(filterZombieCoalesceTarget(liveRun, tracked)).toBe(liveRun);
  });

  // Queued runs don't have processes yet — they must always pass through.
  // isZombieRun only flags "running" status, so queued runs are safe.
  it("passes through a queued run not tracked (queued runs are not zombies)", () => {
    const queuedRun = { status: "queued", id: "queued-1" };
    const emptyTracked = new Map<string, unknown>();

    expect(filterZombieCoalesceTarget(queuedRun, emptyTracked)).toBe(queuedRun);
  });

  // null target means no candidate to coalesce into — pass through.
  it("passes through null target unchanged", () => {
    const tracked = new Map<string, unknown>();

    expect(filterZombieCoalesceTarget(null, tracked)).toBeNull();
  });

  // Terminal states should never appear as coalesce targets, but if they do,
  // they should pass through (they're not zombies — they're done).
  it("passes through a failed run (terminal state, not a zombie)", () => {
    const failedRun = { status: "failed", id: "failed-1" };
    const emptyTracked = new Map<string, unknown>();

    expect(filterZombieCoalesceTarget(failedRun, emptyTracked)).toBe(failedRun);
  });

  it("passes through a completed run (terminal state, not a zombie)", () => {
    const completedRun = { status: "completed", id: "done-1" };
    const emptyTracked = new Map<string, unknown>();

    expect(filterZombieCoalesceTarget(completedRun, emptyTracked)).toBe(completedRun);
  });

  // Regression guard: after server restart, runningProcesses is empty.
  // Multiple zombie runs should all be filtered to null.
  it("filters multiple zombie runs independently (post-restart scenario)", () => {
    const emptyTracked = new Map<string, unknown>();
    const zombie1 = { status: "running", id: "z1" };
    const zombie2 = { status: "running", id: "z2" };

    expect(filterZombieCoalesceTarget(zombie1, emptyTracked)).toBeNull();
    expect(filterZombieCoalesceTarget(zombie2, emptyTracked)).toBeNull();
  });

  // Mixed scenario: one zombie, one live. Only the zombie is filtered.
  it("correctly distinguishes zombie from live when multiple runs exist", () => {
    const tracked = new Map<string, unknown>([["live-1", { pid: 42 }]]);
    const zombie = { status: "running", id: "zombie-1" };
    const live = { status: "running", id: "live-1" };

    expect(filterZombieCoalesceTarget(zombie, tracked)).toBeNull();
    expect(filterZombieCoalesceTarget(live, tracked)).toBe(live);
  });
});

// ---------------------------------------------------------------------------
// PEN-1995: the interval-overrun coalesce guard.
//
// `isZombieRun` only catches a run with no live in-memory execution. A run that
// stalls AFTER being registered in `activeRunExecutions` is tracked, so it is
// not a zombie, yet it silently swallows every later same-scope timer wake.
// These cover the budget arithmetic and both sides of the boundary.
// ---------------------------------------------------------------------------
const HOUR_MS = 60 * 60 * 1000;
const now = new Date("2026-09-13T12:00:00.000Z");
const agoMs = (ms: number) => new Date(now.getTime() - ms);

// Every source the wakeup path can carry that is NOT the periodic cadence tick.
// `on_demand` is also the DEFAULT (`opts.source ?? "on_demand"`), which is why
// the source gate is load-bearing rather than cosmetic.
const NON_TIMER_SOURCES = ["on_demand", "automation", "assignment"] as const;

describe("resolveStalledCoalesceBudgetMs", () => {
  it("uses 1.5x the interval once that exceeds the floor", () => {
    // 24h interval (the clamp maximum) -> 36h budget.
    expect(resolveStalledCoalesceBudgetMs(86_400)).toBe(
      86_400 * 1000 * STALLED_COALESCE_INTERVAL_MULTIPLE,
    );
  });

  it("floors a fast-cadence agent at the minimum budget", () => {
    // 30s (the clamp minimum) * 1.5 = 45s, far below the floor.
    expect(resolveStalledCoalesceBudgetMs(30)).toBe(STALLED_COALESCE_MIN_BUDGET_MS);
  });

  it("returns exactly the floor at the hourly default, where the two meet", () => {
    // 3600 * 1.5 = 5400s = 90 min, identical to the floor. This is the
    // measured population's threshold, so pin it explicitly.
    expect(resolveStalledCoalesceBudgetMs(3600)).toBe(STALLED_COALESCE_MIN_BUDGET_MS);
    expect(STALLED_COALESCE_MIN_BUDGET_MS).toBe(90 * 60 * 1000);
  });

  it("falls back to the floor for non-positive or non-finite intervals", () => {
    expect(resolveStalledCoalesceBudgetMs(0)).toBe(STALLED_COALESCE_MIN_BUDGET_MS);
    expect(resolveStalledCoalesceBudgetMs(-1)).toBe(STALLED_COALESCE_MIN_BUDGET_MS);
    expect(resolveStalledCoalesceBudgetMs(Number.NaN)).toBe(STALLED_COALESCE_MIN_BUDGET_MS);
  });
});

describe("isCoalesceTargetPastHeartbeatInterval", () => {
  it("is true for a running run past its budget", () => {
    const run = { status: "running", startedAt: agoMs(4 * HOUR_MS) };
    expect(isCoalesceTargetPastHeartbeatInterval({ run, source: "timer", intervalSec: 3600, now }))
      .toBe(true);
  });

  it("is false for a running run inside its budget", () => {
    const run = { status: "running", startedAt: agoMs(5 * 60 * 1000) };
    expect(isCoalesceTargetPastHeartbeatInterval({ run, source: "timer", intervalSec: 3600, now }))
      .toBe(false);
  });

  // The review finding this gate answers: only a periodic cadence tick can be
  // shown lost by elapsed time. A demand wake fires once, when something
  // happened, so its age proves nothing — and firing here would discard a live
  // target and mint a concurrent run for a manual or recovery wake.
  it("never fires for a non-timer wake, however far past the budget", () => {
    const run = { status: "running", startedAt: agoMs(48 * HOUR_MS) };
    for (const source of NON_TIMER_SOURCES) {
      expect(isCoalesceTargetPastHeartbeatInterval({ run, source, intervalSec: 3600, now }))
        .toBe(false);
    }
    // Same run, same age, same interval — only the source differs.
    expect(isCoalesceTargetPastHeartbeatInterval({ run, source: "timer", intervalSec: 3600, now }))
      .toBe(true);
  });

  it("fails closed on an unrecognised source rather than assuming cadence", () => {
    const run = { status: "running", startedAt: agoMs(48 * HOUR_MS) };
    for (const source of ["", "Timer", "heartbeat_timer", "some_future_source"]) {
      expect(isCoalesceTargetPastHeartbeatInterval({ run, source, intervalSec: 3600, now }))
        .toBe(false);
    }
  });

  it("is exclusive at the boundary — exactly at budget does not fire", () => {
    const exactly = { status: "running", startedAt: agoMs(STALLED_COALESCE_MIN_BUDGET_MS) };
    expect(
      isCoalesceTargetPastHeartbeatInterval({ run: exactly, source: "timer", intervalSec: 3600, now }),
    ).toBe(false);
    const oneMsPast = {
      status: "running",
      startedAt: agoMs(STALLED_COALESCE_MIN_BUDGET_MS + 1),
    };
    expect(
      isCoalesceTargetPastHeartbeatInterval({ run: oneMsPast, source: "timer", intervalSec: 3600, now }),
    ).toBe(true);
  });

  it("never fires for queued or scheduled_retry however old — they read fresh context on start", () => {
    const startedAt = agoMs(48 * HOUR_MS);
    for (const status of ["queued", "scheduled_retry"]) {
      expect(
        isCoalesceTargetPastHeartbeatInterval({
          run: { status, startedAt },
          source: "timer",
          intervalSec: 3600,
          now,
        }),
      ).toBe(false);
    }
  });

  it("never fires for terminal states", () => {
    const startedAt = agoMs(48 * HOUR_MS);
    for (const status of ["failed", "succeeded", "cancelled", "timed_out"]) {
      expect(
        isCoalesceTargetPastHeartbeatInterval({
          run: { status, startedAt },
          source: "timer",
          intervalSec: 3600,
          now,
        }),
      ).toBe(false);
    }
  });

  it("fails safe (false) when startedAt is missing or unparseable", () => {
    for (const startedAt of [null, "not-a-date"]) {
      expect(
        isCoalesceTargetPastHeartbeatInterval({
          run: { status: "running", startedAt },
          source: "timer",
          intervalSec: 3600,
          now,
        }),
      ).toBe(false);
    }
  });

  it("accepts an ISO string startedAt, as read back from the DB driver", () => {
    const run = { status: "running", startedAt: agoMs(4 * HOUR_MS).toISOString() };
    expect(isCoalesceTargetPastHeartbeatInterval({ run, source: "timer", intervalSec: 3600, now }))
      .toBe(true);
  });

  it("holds a 30s-cadence agent to the floor rather than 45s", () => {
    // The whole reason the floor exists: 1.5x alone would fire here.
    const run = { status: "running", startedAt: agoMs(20 * 60 * 1000) };
    expect(isCoalesceTargetPastHeartbeatInterval({ run, source: "timer", intervalSec: 30, now }))
      .toBe(false);
    expect(
      isCoalesceTargetPastHeartbeatInterval({
        run: { ...run, startedAt: agoMs(2 * HOUR_MS) },
        source: "timer",
        intervalSec: 30,
        now,
      }),
    ).toBe(true);
  });
});

describe("filterIntervalOverrunCoalesceTarget", () => {
  it("returns null for an overrunning running target on a timer wake", () => {
    const target = { status: "running", id: "stalled-1", startedAt: agoMs(4 * HOUR_MS) };
    expect(
      filterIntervalOverrunCoalesceTarget({ target, source: "timer", intervalSec: 3600, now }),
    ).toBeNull();
  });

  // Regression guard for the review finding: an aged running target must still
  // coalesce for every non-timer source, so manual/recovery wakes keep today's
  // behaviour and cannot mint a concurrent run.
  it("passes through an aged running target for every non-timer source", () => {
    const target = { status: "running", id: "stalled-2", startedAt: agoMs(48 * HOUR_MS) };
    for (const source of NON_TIMER_SOURCES) {
      expect(filterIntervalOverrunCoalesceTarget({ target, source, intervalSec: 3600, now }))
        .toBe(target);
    }
  });

  it("passes through a running target inside its budget", () => {
    const target = { status: "running", id: "live-1", startedAt: agoMs(5 * 60 * 1000) };
    expect(filterIntervalOverrunCoalesceTarget({ target, source: "timer", intervalSec: 3600, now }))
      .toBe(target);
  });

  it("passes through an aged queued target", () => {
    const target = { status: "queued", id: "queued-1", startedAt: agoMs(48 * HOUR_MS) };
    expect(filterIntervalOverrunCoalesceTarget({ target, source: "timer", intervalSec: 3600, now }))
      .toBe(target);
  });

  it("passes through a null target unchanged", () => {
    expect(
      filterIntervalOverrunCoalesceTarget({ target: null, source: "timer", intervalSec: 3600, now }),
    ).toBeNull();
  });
});

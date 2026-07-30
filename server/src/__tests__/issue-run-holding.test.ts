import { describe, expect, it } from "vitest";
import {
  RUN_STALE_SILENCE_MS,
  isIssueHeldByForeignRun,
  isRunHoldingIssue,
  runLastSignalMs,
} from "../services/issue-run-holding.js";

const NOW = Date.parse("2026-07-30T12:00:00.000Z");
const CALLER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function runAt(offsetMs: number, overrides: Record<string, unknown> = {}) {
  return {
    id: OTHER,
    status: "running",
    startedAt: new Date(NOW - offsetMs),
    lastOutputAt: null,
    lastUsefulActionAt: null,
    ...overrides,
  };
}

describe("runLastSignalMs", () => {
  it("prefers lastUsefulActionAt over lastOutputAt and startedAt", () => {
    const signal = runLastSignalMs({
      status: "running",
      startedAt: new Date(NOW - 9_000),
      lastOutputAt: new Date(NOW - 5_000),
      lastUsefulActionAt: new Date(NOW - 1_000),
    });
    expect(signal).toBe(NOW - 1_000);
  });

  it("falls back to lastOutputAt, then startedAt", () => {
    expect(
      runLastSignalMs({
        status: "running",
        startedAt: new Date(NOW - 9_000),
        lastOutputAt: new Date(NOW - 5_000),
      }),
    ).toBe(NOW - 5_000);
    expect(runLastSignalMs({ status: "running", startedAt: new Date(NOW - 9_000) })).toBe(
      NOW - 9_000,
    );
  });

  it("accepts ISO strings as well as Dates (JSON-hydrated rows)", () => {
    expect(
      runLastSignalMs({ status: "running", startedAt: new Date(NOW - 1_000).toISOString() }),
    ).toBe(NOW - 1_000);
  });

  it("returns null when the run has emitted no signal at all", () => {
    expect(runLastSignalMs({ status: "queued", startedAt: null })).toBeNull();
  });
});

describe("isRunHoldingIssue", () => {
  it("holds while the run is running and recently active", () => {
    expect(isRunHoldingIssue(runAt(60_000), NOW)).toBe(true);
  });

  it("stops holding once silent past the staleness window", () => {
    expect(isRunHoldingIssue(runAt(RUN_STALE_SILENCE_MS + 1_000), NOW)).toBe(false);
  });

  it("still holds exactly at the staleness boundary", () => {
    expect(isRunHoldingIssue(runAt(RUN_STALE_SILENCE_MS), NOW)).toBe(true);
  });

  it("does not hold when queued — a queued run owns no worktree", () => {
    expect(isRunHoldingIssue(runAt(60_000, { status: "queued" }), NOW)).toBe(false);
  });

  it("does not hold on a terminal status", () => {
    for (const status of ["completed", "failed", "cancelled"]) {
      expect(isRunHoldingIssue(runAt(60_000, { status }), NOW)).toBe(false);
    }
  });

  it("does not hold a running row that never emitted any signal", () => {
    // Indistinguishable from a run whose process died during startup; holding
    // the issue on that basis would strand it.
    expect(
      isRunHoldingIssue({ id: OTHER, status: "running", startedAt: null }, NOW),
    ).toBe(false);
  });

  it("counts a fresh lastUsefulActionAt even when startedAt is long past", () => {
    expect(
      isRunHoldingIssue(
        runAt(RUN_STALE_SILENCE_MS * 4, { lastUsefulActionAt: new Date(NOW - 30_000) }),
        NOW,
      ),
    ).toBe(true);
  });
});

describe("isIssueHeldByForeignRun", () => {
  it("withholds an issue held by a different live run — the BLO-19001 case", () => {
    expect(
      isIssueHeldByForeignRun({ activeRun: runAt(60_000), callerRunId: CALLER, nowMs: NOW }),
    ).toBe(true);
  });

  it("does not withhold the caller's own issue", () => {
    expect(
      isIssueHeldByForeignRun({
        activeRun: runAt(60_000, { id: CALLER }),
        callerRunId: CALLER,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("fails OPEN when the caller sent no run id", () => {
    // Failing closed would hide an agent's own in-progress issue from itself.
    for (const callerRunId of [null, undefined, ""]) {
      expect(
        isIssueHeldByForeignRun({ activeRun: runAt(60_000), callerRunId, nowMs: NOW }),
      ).toBe(false);
    }
  });

  it("releases a stale foreign run so its issue can be picked up again", () => {
    expect(
      isIssueHeldByForeignRun({
        activeRun: runAt(RUN_STALE_SILENCE_MS + 1_000),
        callerRunId: CALLER,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("does not withhold when there is no active run", () => {
    for (const activeRun of [null, undefined]) {
      expect(isIssueHeldByForeignRun({ activeRun, callerRunId: CALLER, nowMs: NOW })).toBe(
        false,
      );
    }
  });

  it("does not withhold on a merely queued foreign run", () => {
    expect(
      isIssueHeldByForeignRun({
        activeRun: runAt(60_000, { status: "queued" }),
        callerRunId: CALLER,
        nowMs: NOW,
      }),
    ).toBe(false);
  });
});

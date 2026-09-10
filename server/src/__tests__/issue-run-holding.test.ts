import { describe, expect, it } from "vitest";
import {
  RUN_STALE_SILENCE_MS,
  SCHEDULED_RETRY_HOLD_GRACE_MS,
  isIssueHeldByForeignRun,
  isIssueHeldByForeignScheduledRetry,
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

  it("keeps holding a running run past the heartbeat staleness window", () => {
    expect(isRunHoldingIssue(runAt(RUN_STALE_SILENCE_MS + 1_000), NOW)).toBe(true);
  });

  it("holds exactly at the heartbeat staleness boundary", () => {
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

  it("holds a running row that has not emitted a timestamp signal", () => {
    expect(isRunHoldingIssue({ id: OTHER, status: "running", startedAt: null }, NOW)).toBe(
      true,
    );
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

  it("withholds a stale-looking foreign run while it is still marked running", () => {
    expect(
      isIssueHeldByForeignRun({
        activeRun: runAt(RUN_STALE_SILENCE_MS + 1_000),
        callerRunId: CALLER,
        nowMs: NOW,
      }),
    ).toBe(true);
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

  // BLO-29965: this predicate is structurally blind to a parked retry, and that
  // is WHY isIssueHeldByForeignScheduledRetry exists. Pinned so nobody
  // "simplifies" the two into one and reintroduces the hole: activeRun is
  // hydrated from issues.executionRunId, which an autonomous retry chain never
  // sets, so the parked sibling is usually not even present here.
  it("is blind to a foreign run parked on a scheduled retry — covered separately", () => {
    expect(
      isIssueHeldByForeignRun({
        activeRun: runAt(60_000, { status: "scheduled_retry" }),
        callerRunId: CALLER,
        nowMs: NOW,
      }),
    ).toBe(false);
  });
});

describe("isIssueHeldByForeignScheduledRetry", () => {
  const armed = {
    scheduledRetryRunId: OTHER,
    callerRunId: CALLER,
    nowMs: NOW,
  };

  // The measured incident, BLO-31354 / paperclip#1612 (2026-09-03): run A parked
  // at 01:52Z with scheduledRetryAt 02:22:54Z; run B woke at 02:18Z — 4 min
  // before A's retry — read the row as unattended, did the same work, and had
  // its push rejected non-fast-forward when A's retry pushed at 02:33Z.
  it("withholds a row whose retry is armed and still in the future", () => {
    expect(
      isIssueHeldByForeignScheduledRetry({ ...armed, scheduledRetryAt: new Date(NOW + 4 * 60_000) }),
    ).toBe(true);
  });

  it("keeps withholding while the retry is merely LATE, not dead", () => {
    // BLO-28863 measured retries dispatching 25–74 min after their due time.
    // Releasing at the due instant would reopen the race in its likeliest window.
    expect(
      isIssueHeldByForeignScheduledRetry({ ...armed, scheduledRetryAt: new Date(NOW - 74 * 60_000) }),
    ).toBe(true);
  });

  it("withholds exactly at the lapse boundary", () => {
    expect(
      isIssueHeldByForeignScheduledRetry({
        ...armed,
        scheduledRetryAt: new Date(NOW - SCHEDULED_RETRY_HOLD_GRACE_MS),
      }),
    ).toBe(true);
  });

  // The mirror failure this bound exists to prevent: a retry that never fires
  // must not make the row permanently unpickable.
  it("releases a retry lapsed past the grace window so it cannot strand the row", () => {
    expect(
      isIssueHeldByForeignScheduledRetry({
        ...armed,
        scheduledRetryAt: new Date(NOW - SCHEDULED_RETRY_HOLD_GRACE_MS - 1_000),
      }),
    ).toBe(false);
  });

  it("never withholds the caller's OWN parked retry — that would strand its work", () => {
    expect(
      isIssueHeldByForeignScheduledRetry({
        ...armed,
        scheduledRetryRunId: CALLER,
        scheduledRetryAt: new Date(NOW + 4 * 60_000),
      }),
    ).toBe(false);
  });

  it("fails OPEN when the holder cannot be identified", () => {
    for (const scheduledRetryRunId of [null, undefined, ""]) {
      expect(
        isIssueHeldByForeignScheduledRetry({
          ...armed,
          scheduledRetryRunId,
          scheduledRetryAt: new Date(NOW + 4 * 60_000),
        }),
      ).toBe(false);
    }
  });

  it("fails OPEN when the caller sent no run id", () => {
    for (const callerRunId of [null, undefined, ""]) {
      expect(
        isIssueHeldByForeignScheduledRetry({
          ...armed,
          callerRunId,
          scheduledRetryAt: new Date(NOW + 4 * 60_000),
        }),
      ).toBe(false);
    }
  });

  it("fails OPEN when no retry is armed or the timestamp is unusable", () => {
    for (const scheduledRetryAt of [null, undefined, "not-a-date"]) {
      expect(isIssueHeldByForeignScheduledRetry({ ...armed, scheduledRetryAt })).toBe(false);
    }
  });

  it("accepts ISO strings as well as Dates (JSON-hydrated rows)", () => {
    expect(
      isIssueHeldByForeignScheduledRetry({
        ...armed,
        scheduledRetryAt: new Date(NOW + 4 * 60_000).toISOString(),
      }),
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { ISSUE_EXECUTION_LOCK_REAPABLE_NEVER_STARTED_RUN_STATUSES } from "../services/issue-execution-lock.js";
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
// The agent both CALLER and OTHER belong to: the sibling-run case this guard is
// for. OTHER_AGENT is the previous assignee in the reassignment case.
const AGENT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_AGENT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

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
    scheduledRetryAgentId: AGENT,
    callerRunId: CALLER,
    callerAgentId: AGENT,
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

  // BLO-29965 review round 3. "Sibling" means SAME AGENT; run-id inequality
  // alone does not establish it.
  //
  // Reassigning an issue from agent A to agent B leaves A's `scheduled_retry`
  // row untouched — `issues.update` nulls only the issue-side lock columns
  // (checkoutRunId/executionRunId) and never writes `heartbeat_runs`. So B's
  // inbox saw a retry run id that was merely not its own and hid B's own
  // freshly-assigned row for up to the grace window.
  //
  // Withholding it buys nothing: A's retry cannot run any more either, because
  // promotion gates on `issue.assigneeAgentId !== run.agentId` and cancels it
  // `issue_reassigned`. Worse, it is self-sustaining — the sweep that clears the
  // stale row runs from `enqueueWakeup`, and an agent whose inbox reads empty
  // exits without enqueuing anything.
  it("fails OPEN for a retry owned by a DIFFERENT agent — a reassigned row must not hide from its new assignee", () => {
    expect(
      isIssueHeldByForeignScheduledRetry({
        ...armed,
        scheduledRetryAgentId: OTHER_AGENT,
        scheduledRetryAt: new Date(NOW + 4 * 60_000),
      }),
    ).toBe(false);
  });

  it("still withholds a sibling run of the SAME agent — the case the guard exists for", () => {
    expect(
      isIssueHeldByForeignScheduledRetry({
        ...armed,
        scheduledRetryAgentId: AGENT,
        callerAgentId: AGENT,
        scheduledRetryAt: new Date(NOW + 4 * 60_000),
      }),
    ).toBe(true);
  });

  it("fails OPEN when either side's agent is unknown", () => {
    for (const missing of [null, undefined, ""]) {
      expect(
        isIssueHeldByForeignScheduledRetry({
          ...armed,
          scheduledRetryAgentId: missing,
          scheduledRetryAt: new Date(NOW + 4 * 60_000),
        }),
      ).toBe(false);
      expect(
        isIssueHeldByForeignScheduledRetry({
          ...armed,
          callerAgentId: missing,
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

  // BLO-29965 review round 2. Twice now a reviewer has proposed aligning this
  // predicate with `isReapableHeartbeatRunRow` — "fail open for a retry that
  // never started". Applying that verbatim turns this guard into a constant
  // `false` and silently reverts the whole fix, so the divergence is pinned
  // here rather than defended in a PR comment nobody reads next time.
  //
  // Why: a parked retry has `startedAt == null` BY CONSTRUCTION, always. All
  // four writers of that status are fresh INSERTs and none sets the column (the
  // continuation, ccrotate-capacity and dependency-blocked ladders in
  // heartbeat.ts, plus provider-quota recovery in recovery/service.ts), no
  // UPDATE ever moves an existing row into `scheduled_retry`, and
  // `heartbeat_runs.started_at` carries no database default. So "never started"
  // does not select an unusual retry — it selects EVERY retry.
  //
  // The two predicates answer deliberately different questions:
  //   - checkout    — "may a run that has DELIBERATELY ASKED for this row adopt
  //                   the lock?" Permissive: a parked retry owns no worktree,
  //                   and refusing here made WIP monotonic (BLO-20321).
  //   - this guard  — "may we SPONTANEOUSLY OFFER this row to a sibling that
  //                   asked for nothing?" Restrictive: that offer is the
  //                   measured generator of duplicate work.
  // Withholding never blocks recovery: explicit checkout, recovery actions and
  // monitor wakes all bypass the inbox, the holder's own retry fails open by
  // run id, and any strand is bounded by SCHEDULED_RETRY_HOLD_GRACE_MS.
  it("does NOT consult startedAt — every parked retry has none, so gating on it would disable the guard", () => {
    // The canonical parked-retry row shape, as the three INSERT sites write it.
    const parkedRetryRow = { status: "scheduled_retry", startedAt: null };

    // Checkout's side: this row is reclaimable-when-never-started, so a run that
    // explicitly asks for it may adopt the lock.
    expect(ISSUE_EXECUTION_LOCK_REAPABLE_NEVER_STARTED_RUN_STATUSES).toContain(parkedRetryRow.status);
    expect(parkedRetryRow.startedAt).toBeNull();

    // Self-selection's side: the very same row is still withheld from a sibling.
    // If these two ever agree, the guard is dead — see the comment above.
    expect(
      isIssueHeldByForeignScheduledRetry({ ...armed, scheduledRetryAt: new Date(NOW + 4 * 60_000) }),
    ).toBe(true);
  });
});

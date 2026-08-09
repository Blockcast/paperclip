import { describe, expect, it } from "vitest";
import { HEARTBEAT_RUN_STATUSES } from "@paperclipai/shared";
import {
  ISSUE_EXECUTION_LOCK_HOLDING_RUN_STATUSES,
  TERMINAL_HEARTBEAT_RUN_STATUSES,
  runStatusHoldsIssueExecutionLock,
} from "../services/issue-execution-lock.js";

/**
 * BLO-19749. The defect these tests pin was not a wrong value in one place — it
 * was the same notion open-coded as three literal arrays that drifted, so that
 * `GET /issues/{id}` reported `activeRun: null` on an issue whose `POST
 * /checkout` simultaneously 409'd naming the run that held it.
 *
 * "Holds the lock" and "terminal" MUST partition the run-status domain: the
 * checkout path releases a lock exactly when the named run is terminal, so any
 * status that is neither releases nothing and blocks nothing — an issue stuck in
 * that gap is invisible to every availability check while still un-checkoutable.
 */
describe("issue execution-lock run statuses", () => {
  it("partitions the canonical run-status domain: every status either holds or releases", () => {
    for (const status of HEARTBEAT_RUN_STATUSES) {
      const holds = (ISSUE_EXECUTION_LOCK_HOLDING_RUN_STATUSES as readonly string[]).includes(status);
      const terminal = TERMINAL_HEARTBEAT_RUN_STATUSES.has(status);
      expect(
        holds !== terminal,
        `"${status}" must be exactly one of holding/terminal, got holds=${holds} terminal=${terminal}`,
      ).toBe(true);
    }
  });

  it("treats scheduled_retry as holding the lock", () => {
    // The status the retry ladder parks runs in, and the exact one the old
    // ["queued","running"] activeRun filter dropped.
    expect(runStatusHoldsIssueExecutionLock("scheduled_retry")).toBe(true);
    expect(ISSUE_EXECUTION_LOCK_HOLDING_RUN_STATUSES).toContain("scheduled_retry");
  });

  it("holds for queued and running, releases for every terminal status", () => {
    expect(runStatusHoldsIssueExecutionLock("queued")).toBe(true);
    expect(runStatusHoldsIssueExecutionLock("running")).toBe(true);
    for (const status of ["succeeded", "interrupted", "failed", "cancelled", "timed_out"]) {
      expect(runStatusHoldsIssueExecutionLock(status), status).toBe(false);
    }
  });

  it("releases for dead statuses outside the canonical union, and for no run at all", () => {
    // Fail toward releasing: treating an unknown-but-dead status as holding
    // would strand the issue with no run able to clear it.
    expect(runStatusHoldsIssueExecutionLock("error")).toBe(false);
    expect(runStatusHoldsIssueExecutionLock("adapter_failed")).toBe(false);
    expect(runStatusHoldsIssueExecutionLock(null)).toBe(false);
    expect(runStatusHoldsIssueExecutionLock(undefined)).toBe(false);
  });

  it("holds the lock for any non-terminal status, so a new status cannot silently free a live issue", () => {
    // SQL availability checks must use this same terminal complement rather
    // than treating the known holding-status array as a closed enum.
    expect(runStatusHoldsIssueExecutionLock("some_future_live_status")).toBe(true);
    expect(ISSUE_EXECUTION_LOCK_HOLDING_RUN_STATUSES as readonly string[]).not.toContain(
      "some_future_live_status",
    );
  });
});

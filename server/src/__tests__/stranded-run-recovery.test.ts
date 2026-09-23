import { describe, expect, it } from "vitest";
import {
  evaluateStrandedRunRecovery,
  STRANDED_RUN_RECOVERY_MIN_AGE_MS,
} from "../services/stranded-run-recovery.js";

/**
 * BLO-21947. `evaluateStrandedRunRecovery` is the precondition that makes a
 * non-board cancel safe, so these tests pin the safety property rather than the
 * happy path: a run is recoverable by a managing agent ONLY when it demonstrably
 * never dispatched. `cancelRunInternal` skips process teardown entirely when no
 * process exists, so under this predicate the cancel kills nothing and loses no
 * work — it only releases the issue execution lock and kicks the dispatcher.
 */
describe("stranded run recovery eligibility", () => {
  const now = new Date("2026-08-08T12:00:00.000Z");
  const longAgo = new Date(now.getTime() - STRANDED_RUN_RECOVERY_MIN_AGE_MS - 60_000);

  function run(overrides: Partial<Parameters<typeof evaluateStrandedRunRecovery>[0]> = {}) {
    return {
      status: "queued",
      startedAt: null,
      createdAt: longAgo,
      processPid: null,
      processGroupId: null,
      ...overrides,
    };
  }

  it("allows recovery of a queued run that never dispatched and is past the age bound", () => {
    const result = evaluateStrandedRunRecovery(run(), now);
    expect(result.eligible).toBe(true);
    expect(result).toMatchObject({ queuedForMs: STRANDED_RUN_RECOVERY_MIN_AGE_MS + 60_000 });
  });

  it("allows recovery of a scheduled_retry run whose horizon expired", () => {
    // This is the exact shape of the run in the CEO's reproduction on this
    // issue: scheduled_retry, startedAt null, horizon long past.
    expect(evaluateStrandedRunRecovery(run({ status: "scheduled_retry" }), now).eligible).toBe(true);
  });

  it("refuses a running run at any age", () => {
    // The whole safety argument is that no work is destroyed. A running run has
    // in-flight work, so it stays board-only however long it has been alive.
    const result = evaluateStrandedRunRecovery(
      run({ status: "running", startedAt: longAgo }),
      now,
    );
    expect(result.eligible).toBe(false);
  });

  it("refuses a run that already started even if its status still reads queued", () => {
    // Defends against status/field skew: startedAt is the authoritative
    // evidence that a process was reached, not the status column.
    const result = evaluateStrandedRunRecovery(run({ startedAt: longAgo }), now);
    expect(result).toMatchObject({ eligible: false });
    expect((result as { reason: string }).reason).toContain("in-flight");
  });

  it("refuses a run bound to a process id", () => {
    expect(evaluateStrandedRunRecovery(run({ processPid: 4242 }), now).eligible).toBe(false);
    expect(evaluateStrandedRunRecovery(run({ processGroupId: 4242 }), now).eligible).toBe(false);
  });

  it("refuses a freshly queued run so a manager cannot race the dispatcher", () => {
    const result = evaluateStrandedRunRecovery(
      run({ createdAt: new Date(now.getTime() - 5_000) }),
      now,
    );
    expect(result).toMatchObject({ eligible: false });
    expect((result as { reason: string }).reason).toContain("threshold");
  });

  it("refuses a run sitting exactly at the age bound and allows one past it", () => {
    const atBound = new Date(now.getTime() - STRANDED_RUN_RECOVERY_MIN_AGE_MS);
    expect(evaluateStrandedRunRecovery(run({ createdAt: atBound }), now).eligible).toBe(true);
    const justUnder = new Date(now.getTime() - STRANDED_RUN_RECOVERY_MIN_AGE_MS + 1);
    expect(evaluateStrandedRunRecovery(run({ createdAt: justUnder }), now).eligible).toBe(false);
  });

  it("refuses terminal statuses", () => {
    for (const status of ["succeeded", "failed", "cancelled", "timed_out", "interrupted"]) {
      expect(evaluateStrandedRunRecovery(run({ status }), now).eligible).toBe(false);
    }
  });

  it("refuses a run with an unusable creation timestamp rather than defaulting open", () => {
    expect(evaluateStrandedRunRecovery(run({ createdAt: null }), now).eligible).toBe(false);
  });

  it("accepts ISO string timestamps as well as Date instances", () => {
    expect(evaluateStrandedRunRecovery(run({ createdAt: longAgo.toISOString() }), now).eligible)
      .toBe(true);
  });
});

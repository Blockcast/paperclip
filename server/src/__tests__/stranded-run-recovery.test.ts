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
 *
 * PEN-3622 adds the third conjunct: the run's dispatch window must also have
 * OPENED. A `scheduled_retry` row parked on a not-yet-due backoff is waiting by
 * design, and ageing it off `createdAt` reported it as stranded.
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
    expect(result).toMatchObject({ undispatchedForMs: STRANDED_RUN_RECOVERY_MIN_AGE_MS + 60_000 });
  });

  it("allows recovery of a scheduled_retry run whose horizon expired", () => {
    // This is the exact shape of the run in the CEO's reproduction on BLO-21947:
    // scheduled_retry, startedAt null, horizon long past.
    //
    // PEN-3622: the horizon is now spelled out in the fixture. Before this fix
    // the case passed WITHOUT a `scheduledRetryAt` at all, because eligibility
    // aged off `createdAt` — so this test's own name described a horizon the
    // fixture never set and the code never read. The assertion is unchanged;
    // what changed is that it now tests the thing it is named after.
    const result = evaluateStrandedRunRecovery(
      run({ status: "scheduled_retry", scheduledRetryAt: longAgo }),
      now,
    );
    expect(result.eligible).toBe(true);
    // Measured from the park's due time, not from row creation.
    expect(result).toMatchObject({ undispatchedForMs: STRANDED_RUN_RECOVERY_MIN_AGE_MS + 60_000 });
  });

  /**
   * PEN-3622 negative control. The defect was that a correctly-parked capacity
   * backoff — `ccrotate_capacity` is the live example — crossed the 30m bound on
   * row age while its park was still hours away, and was offered to a manager as
   * cancellable.
   *
   * The control is executable rather than asserted in prose: the fixture is
   * built so the OLD predicate (`now - createdAt`) is unambiguously past the
   * threshold, that premise is asserted, and only then is the new verdict
   * checked. If someone reverts the clock to `createdAt`, this test fails on the
   * verdict — it cannot pass by both readings.
   */
  it("refuses a scheduled_retry run whose park has not come due, however old the row", () => {
    const createdLongBefore = new Date(now.getTime() - 9 * 60 * 60 * 1000); // 9h old row
    const parkDueLater = new Date(now.getTime() + 2 * 60 * 60 * 1000); // due in 2h

    // Premise of the control: by the pre-fix clock this run was eligible.
    const ageByOldClock = now.getTime() - createdLongBefore.getTime();
    expect(ageByOldClock).toBeGreaterThan(STRANDED_RUN_RECOVERY_MIN_AGE_MS);

    const result = evaluateStrandedRunRecovery(
      run({
        status: "scheduled_retry",
        createdAt: createdLongBefore,
        scheduledRetryAt: parkDueLater,
      }),
      now,
    );
    expect(result).toMatchObject({ eligible: false });
    expect((result as { reason: string }).reason).toContain("waiting by design");
  });

  it("still reports a genuinely undispatched fresh queued run, so the fix is not bought by going blind", () => {
    // `queuedAt` is null by design on a fresh `queued` insert — `createdAt` IS
    // the queue-entry time there. The fallback keeps that case measurable.
    const result = evaluateStrandedRunRecovery(run({ queuedAt: null }), now);
    expect(result.eligible).toBe(true);
    expect(result).toMatchObject({ undispatchedForMs: STRANDED_RUN_RECOVERY_MIN_AGE_MS + 60_000 });
  });

  it("ages a promoted retry from its promotion instant, not from row creation", () => {
    // `promoteScheduledRetryRun` stamps `queuedAt` at the promotion instant
    // precisely so the preceding backoff is not read as dispatch wait
    // (BLO-21116). A run promoted 5s ago off a 9h-old row is not stranded.
    const result = evaluateStrandedRunRecovery(
      run({
        createdAt: new Date(now.getTime() - 9 * 60 * 60 * 1000),
        queuedAt: new Date(now.getTime() - 5_000),
      }),
      now,
    );
    expect(result).toMatchObject({ eligible: false });
    expect((result as { reason: string }).reason).toContain("threshold");
  });

  it("refuses a scheduled_retry run with no usable due time rather than overstating the span", () => {
    // Unmeasurable, not zero. Same discipline as the PEN-3607 reader, which
    // refuses a `coalesce` fallback that would overstate a span it cannot see.
    const result = evaluateStrandedRunRecovery(
      run({ status: "scheduled_retry", scheduledRetryAt: null }),
      now,
    );
    expect(result).toMatchObject({ eligible: false });
    expect((result as { reason: string }).reason).toContain("cannot be measured");
  });

  it("applies the age bound to a park from its due time", () => {
    const dueAtBound = new Date(now.getTime() - STRANDED_RUN_RECOVERY_MIN_AGE_MS);
    expect(
      evaluateStrandedRunRecovery(
        run({ status: "scheduled_retry", scheduledRetryAt: dueAtBound }),
        now,
      ).eligible,
    ).toBe(true);
    const dueJustUnder = new Date(now.getTime() - STRANDED_RUN_RECOVERY_MIN_AGE_MS + 1);
    expect(
      evaluateStrandedRunRecovery(
        run({ status: "scheduled_retry", scheduledRetryAt: dueJustUnder }),
        now,
      ).eligible,
    ).toBe(false);
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
    expect(
      evaluateStrandedRunRecovery(
        run({ status: "scheduled_retry", scheduledRetryAt: longAgo.toISOString() }),
        now,
      ).eligible,
    ).toBe(true);
  });
});

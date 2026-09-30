import { beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.fn();

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
  },
}));

const { heartbeatService } = await import("../services/heartbeat.js");

/**
 * BLO-21526 / BLO-35258. `crashRecoveryCandidateIndexPresent` is probed twice
 * per tick from two callers — the gauge publisher (registered above both
 * scheduler gates) and the periodic reconciliation gate — and its `catch` path
 * has NO latch, so an unreadable catalog warns once per caller per tick. Both
 * lines are about the same underlying failure, and an operator seeing two must
 * be able to tell that.
 *
 * Note this is specifically the CATCH path. The absent-transition warn above it
 * is latched, and that latch is atomic (the read and write share one
 * synchronous block and `setCrashRecoveryCandidateIndexPresent` is
 * synchronous), so that branch emits exactly one line per episode regardless of
 * caller — it is not what these assertions are about.
 *
 * The distinguishing pair is `source` PLUS the message: the gate's failure
 * skips a reconciliation tick, while the gauge publisher makes no
 * reconciliation decision at all and on a suppressed replica there is no
 * periodic reconciliation for it to be skipping. Collapsing the ternary at the
 * `catch`-path `logger.warn` back to a single string would silently restore the
 * misattribution, which is the whole finding this guards.
 */
describe("crash-recovery candidate-index probe tags its caller (BLO-35258)", () => {
  // Only `db.execute` is reached before the catch — the probe is a single
  // catalog lookup — so a stub that throws is the whole fixture. No Postgres.
  const throwingDb = {
    execute: vi.fn(async () => {
      throw new Error("catalog unreadable");
    }),
  } as unknown as Parameters<typeof heartbeatService>[0];

  const probeWarns = () =>
    warn.mock.calls.filter(
      ([, message]) => typeof message === "string" && message.includes("candidate index"),
    );

  beforeEach(() => {
    warn.mockClear();
  });

  it("tags the gauge publisher's probe failure and does not claim a skipped reconciliation", async () => {
    const heartbeat = heartbeatService(throwingDb, { skipQueuedRunDispatch: true });

    await heartbeat.publishCrashRecoveryCandidateIndexGauge();

    const [context, message] = probeWarns().at(-1) ?? [];
    expect(context).toMatchObject({ source: "gauge" });
    expect(message).toBe(
      "failed to probe worker-crash candidate index; candidate-index gauge cleared for this tick",
    );
  });

  it("tags the reconciliation gate's probe failure with the skipped-tick consequence", async () => {
    const heartbeat = heartbeatService(throwingDb, { skipQueuedRunDispatch: true });

    const result = await heartbeat.reconcileWorkerCrashedRuns({ requireCandidateIndex: true });

    // A probe failure means "we could not tell", so the gate skips this tick.
    expect(result.skippedReason).toBe("candidate_index_missing");

    const [context, message] = probeWarns().at(-1) ?? [];
    expect(context).toMatchObject({ source: "gate" });
    expect(message).toBe(
      "failed to probe worker-crash candidate index; skipping periodic reconciliation this tick",
    );
  });

  // The must-trip control. Each assertion above passes on its own if the
  // ternary is collapsed to whichever string that test happens to expect —
  // only comparing the two callers proves the branch still discriminates.
  it("gives the two callers different text, not just a different field", async () => {
    const heartbeat = heartbeatService(throwingDb, { skipQueuedRunDispatch: true });

    await heartbeat.publishCrashRecoveryCandidateIndexGauge();
    const gaugeMessage = probeWarns().at(-1)?.[1];

    await heartbeat.reconcileWorkerCrashedRuns({ requireCandidateIndex: true });
    const gateMessage = probeWarns().at(-1)?.[1];

    expect(gaugeMessage).toEqual(expect.any(String));
    expect(gateMessage).not.toBe(gaugeMessage);
  });
});

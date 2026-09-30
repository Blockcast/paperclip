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

const probeWarns = () =>
  warn.mock.calls.filter(
    ([, message]) => typeof message === "string" && message.includes("candidate index"),
  );

beforeEach(() => {
  warn.mockClear();
});

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

/**
 * BLO-36862. The `catch`-path cases above all stub `db.execute` to THROW, so
 * none of them reach the absent-transition warn — which carries its own
 * `source` and had no coverage at all. A reader of that branch's comment could
 * conclude the field was vestigial there (the latch is atomic, so it is not a
 * double-warn tag) and delete it with nothing failing.
 *
 * It is not vestigial. Exactly one line is emitted per absent episode, so the
 * caller that won IS the report: `source: "gauge"` means the gauge publisher —
 * registered above both scheduler gates — got there because the gate never ran,
 * i.e. the replica is suppressed and neither recovery path is active.
 * `source: "gate"` means reconciliation is running and skipping ticks. Same
 * message, opposite blast radius.
 */
describe("crash-recovery absent-transition warn tags its caller (BLO-36862)", () => {
  // Non-throwing, unlike the fixture above: an empty catalog result is
  // `present = false`, which is what drives the latched absent branch.
  const absentDb = {
    execute: vi.fn(async () => []),
  } as unknown as Parameters<typeof heartbeatService>[0];

  it("names which caller observed the index going absent", async () => {
    // One fresh service per caller. The latch lives in the `heartbeatService`
    // closure and fires once per episode, so a single instance can only ever
    // show one caller — which is exactly why the tag has to say which.
    await heartbeatService(absentDb, {
      skipQueuedRunDispatch: true,
    }).publishCrashRecoveryCandidateIndexGauge();

    const gate = heartbeatService(absentDb, { skipQueuedRunDispatch: true });
    const result = await gate.reconcileWorkerCrashedRuns({ requireCandidateIndex: true });
    expect(result.skippedReason).toBe("candidate_index_missing");

    const warns = probeWarns();
    // Pins the absent branch specifically — the catch path never says this.
    expect(warns.map(([, message]) => message)).toEqual([
      expect.stringContaining("periodic crash reconciliation is disabled"),
      expect.stringContaining("periodic crash reconciliation is disabled"),
    ]);
    // Deleting `source` gives [undefined, undefined]; collapsing it to a
    // constant gives a matched pair. Both turn this red.
    expect(warns.map(([context]) => (context as { source?: string }).source)).toEqual([
      "gauge",
      "gate",
    ]);
  });

  // The premise the case above rests on, which nothing else pinned. The
  // DB-backed suite covers the presence PROBE being re-run rather than cached
  // (heartbeat-worker-crash-marking.test.ts); the warn LATCH is separate, and
  // removing it leaves the case above green — two fresh services would still
  // emit one line each. Without this, "the winning caller is the whole report"
  // is documented and unguarded.
  it("emits exactly one absent warn per episode, however many callers probe", async () => {
    const heartbeat = heartbeatService(absentDb, { skipQueuedRunDispatch: true });

    await heartbeat.publishCrashRecoveryCandidateIndexGauge();
    await heartbeat.reconcileWorkerCrashedRuns({ requireCandidateIndex: true });

    expect(probeWarns()).toHaveLength(1);
  });
});

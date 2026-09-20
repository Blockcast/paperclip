import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetAgentStartLocksForTesting,
  describeHeldAgentStartLocks,
  withAgentStartLock,
} from "../services/agent-start-lock.js";
import {
  AGENT_START_LOCK_HELD_SECONDS_METRIC,
  __resetMetricsForTest,
  getMetricsRegistry,
  setAgentStartLockHeldMetrics,
} from "../services/metrics.js";
import { refreshAgentStartLockMetrics } from "../services/scrape-metrics-collector.js";
import { logger } from "../middleware/logger.js";

const coalesced = { onCoalesced: () => "coalesced" as const };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * PEN-3305. The start lock has no timeout by design — a timeout would let a
 * waiter run alongside the holder, which is the defect BLO-20396 removed. The
 * consequence is that a section which never settles holds its agent's lock
 * forever and that agent silently stops dispatching. These tests cover the
 * *observability* of that state, which is what was missing: the hold was
 * detected (one warn at t+30s) and then never reported again, so a 16-hour
 * wedge and a 31-second one left identical evidence.
 */
describe("agent start lock liveness reporting (PEN-3305)", () => {
  let warn!: ReturnType<typeof vi.spyOn<typeof logger, "warn">>;
  let error!: ReturnType<typeof vi.spyOn<typeof logger, "error">>;

  beforeEach(() => {
    // Every test here advances past LOCK_HELD_WARN_MS, so the overrun logging
    // fires in all of them. Stub it globally rather than per-test: an
    // unexpected line in the suite's output should be a signal, not noise
    // some tests happen to emit and others suppress.
    warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    error = vi.spyOn(logger, "error").mockImplementation(() => logger);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetAgentStartLocksForTesting();
  });

  it("reports a held lock, its rising age, and nothing once it is released", async () => {
    vi.useFakeTimers();
    const agentId = randomUUID();
    const gate = deferred<string>();

    expect(describeHeldAgentStartLocks()).toEqual([]);

    const held = withAgentStartLock(agentId, () => gate.promise, coalesced);
    await vi.advanceTimersByTimeAsync(0);

    expect(describeHeldAgentStartLocks()).toEqual([{ agentId, heldMs: 0 }]);

    await vi.advanceTimersByTimeAsync(90_000);
    expect(describeHeldAgentStartLocks()).toEqual([{ agentId, heldMs: 90_000 }]);

    gate.resolve("done");
    await held;

    // Released locks must vanish from the snapshot, not linger at their final
    // age — a retained series would hold a stall alert open forever.
    expect(describeHeldAgentStartLocks()).toEqual([]);
  });

  it("releases the snapshot entry when the section throws", async () => {
    vi.useFakeTimers();
    const agentId = randomUUID();
    const gate = deferred<string>();

    const held = withAgentStartLock(agentId, () => gate.promise, coalesced);
    await vi.advanceTimersByTimeAsync(0);
    expect(describeHeldAgentStartLocks()).toHaveLength(1);

    gate.reject(new Error("boom"));
    await expect(held).rejects.toThrow("boom");

    expect(describeHeldAgentStartLocks()).toEqual([]);
  });

  it("tracks each agent independently", async () => {
    vi.useFakeTimers();
    const agentA = randomUUID();
    const agentB = randomUUID();
    const gateA = deferred<string>();
    const gateB = deferred<string>();

    const heldA = withAgentStartLock(agentA, () => gateA.promise, coalesced);
    await vi.advanceTimersByTimeAsync(10_000);
    const heldB = withAgentStartLock(agentB, () => gateB.promise, coalesced);
    await vi.advanceTimersByTimeAsync(5_000);

    const snapshot = new Map(
      describeHeldAgentStartLocks().map((entry) => [entry.agentId, entry.heldMs]),
    );
    expect(snapshot.get(agentA)).toBe(15_000);
    expect(snapshot.get(agentB)).toBe(5_000);

    gateA.resolve("a");
    gateB.resolve("b");
    await Promise.all([heldA, heldB]);
    expect(describeHeldAgentStartLocks()).toEqual([]);
  });

  it("keeps warning for as long as the lock is held, instead of once at 30s", async () => {
    vi.useFakeTimers();
    const agentId = randomUUID();
    const gate = deferred<string>();

    const held = withAgentStartLock(agentId, () => gate.promise, coalesced);

    // Four warn intervals, all below the error threshold.
    await vi.advanceTimersByTimeAsync(120_000);

    const warnsForAgent = warn.mock.calls.filter(
      ([fields]) => (fields as { agentId?: string } | undefined)?.agentId === agentId,
    );
    // The pre-PEN-3305 one-shot setTimeout produced exactly 1 here regardless
    // of how long the section ran. That is the regression this asserts against.
    expect(warnsForAgent.length).toBe(4);
    expect(warnsForAgent.at(-1)?.[0]).toMatchObject({ agentId, heldMs: 120_000 });

    gate.resolve("done");
    await held;
  });

  it("escalates to error once the hold passes the 5m budget, and stops on release", async () => {
    vi.useFakeTimers();
    const agentId = randomUUID();
    const gate = deferred<string>();

    const held = withAgentStartLock(agentId, () => gate.promise, coalesced);

    const errorsForAgent = () =>
      error.mock.calls.filter(
        ([fields]) => (fields as { agentId?: string } | undefined)?.agentId === agentId,
      );

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(errorsForAgent()).toHaveLength(0);

    // t = 6m. The first error must land at the 5m tick, NOT at 10m: the
    // backoff below deliberately exempts it, because that is the line the
    // alert fires on and delaying it would push the first page to ~2x the
    // threshold. Exactly one, not "at least one" — a count of 2 here would
    // mean the backoff never engaged.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(errorsForAgent()).toHaveLength(1);
    expect(errorsForAgent()[0]?.[0]).toMatchObject({ agentId, errorAfterMs: 5 * 60_000 });

    // t = 6m30s: one more 30s warn tick, inside the backoff window. The
    // interval is still firing every 30s — this asserts that the handler
    // RETURNS rather than logging. Without the time comparison a multi-hour
    // hold emits ~120 error lines/hour per wedged agent.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(errorsForAgent()).toHaveLength(1);

    // t = 10m: the backoff window has elapsed, so the wedge re-announces
    // itself. Without this the hold would go quiet again after one line —
    // which is the original defect, just moved from 30s to 5m.
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 30_000);
    expect(errorsForAgent()).toHaveLength(2);
    expect(errorsForAgent()[1]?.[0]).toMatchObject({ agentId, heldMs: 10 * 60_000 });

    gate.resolve("done");
    await held;

    const warnsAfter = warn.mock.calls.length;
    const errorsAfter = error.mock.calls.length;
    // The interval must be cleared on release, or a completed section keeps
    // logging forever.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(warn.mock.calls.length).toBe(warnsAfter);
    expect(error.mock.calls.length).toBe(errorsAfter);
  });
});

/**
 * PEN-3305. The block above pins the *source* — `describeHeldAgentStartLocks()`
 * returns `[]` after release. That is not the same property as the *publication*
 * path, and the gap matters because `PaperclipAgentStartLockWedged` is
 * `severity: critical` with no freshness gate and no zero-fill to fall back on.
 *
 * Deleting `gauge.reset()` from `setAgentStartLockHeldMetrics` keeps the source
 * suite entirely green while the series freezes at its final age — a critical
 * page that fires for a healthy agent and never self-clears. "Nobody was paged"
 * has an inverse, and this is it. So the assertion that carries the contract is
 * the one below: after a release the series must be **absent**, not `0`.
 */
describe("agent start lock metrics publication (PEN-3305)", () => {
  beforeEach(() => {
    __resetMetricsForTest();
    _resetAgentStartLocksForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetAgentStartLocksForTesting();
  });

  /** agent_id -> published hold age in seconds, for whatever series exist. */
  async function publishedHoldSeconds(): Promise<Map<string, number>> {
    const metric = getMetricsRegistry().getSingleMetric(AGENT_START_LOCK_HELD_SECONDS_METRIC);
    expect(metric).toBeDefined();
    const data = (await metric!.get()) as {
      values: Array<{ labels: Record<string, string>; value: number }>;
    };
    return new Map(data.values.map((entry) => [entry.labels.agent_id, entry.value]));
  }

  it("publishes the hold age in seconds, then DROPS the series on release rather than zero-filling", async () => {
    expect(await publishedHoldSeconds()).toEqual(new Map());

    // 310s is deliberately just past the alert's 300s threshold: the gauge has
    // to carry the age in *seconds*, not milliseconds, or the alert compares
    // 310000 > 300 and pages on every hold.
    setAgentStartLockHeldMetrics([{ agentId: "agent-a", heldMs: 310_000 }]);
    expect((await publishedHoldSeconds()).get("agent-a")).toBe(310);

    setAgentStartLockHeldMetrics([]);

    // The whole reset-then-set / no-zero-fill contract, in two assertions.
    // `.get()` returning `undefined` is the point — a `0` here would still
    // satisfy "not 310" while leaving the series alive forever.
    const afterRelease = await publishedHoldSeconds();
    expect(afterRelease.has("agent-a")).toBe(false);
    expect(afterRelease.size).toBe(0);
  });

  it("drops only the released agent, keeping a still-held one published", async () => {
    setAgentStartLockHeldMetrics([
      { agentId: "still-held", heldMs: 400_000 },
      { agentId: "released", heldMs: 90_000 },
    ]);
    expect((await publishedHoldSeconds()).size).toBe(2);

    setAgentStartLockHeldMetrics([{ agentId: "still-held", heldMs: 430_000 }]);

    // reset() clears every series, so the re-set has to restore the survivor.
    // A reset with no re-set would silence a genuinely wedged agent — the
    // opposite failure from the one above, and equally invisible.
    const published = await publishedHoldSeconds();
    expect(published.get("still-held")).toBe(430);
    expect(published.has("released")).toBe(false);
  });

  it("clamps a nonsensical age instead of publishing NaN or a negative", async () => {
    // A NaN sample makes `> 300` false, so the alert goes permanently
    // unevaluable while looking healthy — a silent failure of the control,
    // which is why the clamp in setAgentStartLockHeldMetrics is not dead code.
    setAgentStartLockHeldMetrics([
      { agentId: "not-a-number", heldMs: Number.NaN },
      { agentId: "infinite", heldMs: Number.POSITIVE_INFINITY },
      { agentId: "negative", heldMs: -5_000 },
    ]);

    const published = await publishedHoldSeconds();
    expect(published.get("not-a-number")).toBe(0);
    expect(published.get("infinite")).toBe(0);
    expect(published.get("negative")).toBe(0);
  });

  it("publishes a real hold end to end through refreshAgentStartLockMetrics", async () => {
    // This is the `app.ts` scrape-path wiring: withAgentStartLock ->
    // describeHeldAgentStartLocks -> setAgentStartLockHeldMetrics -> registry.
    // Driving it whole is what stops the two halves agreeing only by
    // convention, which is the drift the source-only test cannot see.
    vi.spyOn(logger, "warn").mockImplementation(() => logger);
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    vi.useFakeTimers();

    const agentId = randomUUID();
    const gate = deferred<string>();
    const held = withAgentStartLock(agentId, () => gate.promise, coalesced);

    await vi.advanceTimersByTimeAsync(310_000);
    refreshAgentStartLockMetrics();
    expect((await publishedHoldSeconds()).get(agentId)).toBe(310);

    gate.resolve("done");
    await held;

    refreshAgentStartLockMetrics();
    const afterRelease = await publishedHoldSeconds();
    expect(afterRelease.has(agentId)).toBe(false);
    expect(afterRelease.size).toBe(0);
  });
});

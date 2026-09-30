import { beforeEach, describe, expect, it } from "vitest";
import {
  HEARTBEAT_TIMER_CHECKED_METRIC,
  HEARTBEAT_TIMER_ENQUEUED_METRIC,
  __resetMetricsForTest,
  recordHeartbeatTimerTick,
  renderMetrics,
} from "../services/metrics.js";

/**
 * Reads an unlabeled counter's value out of the Prometheus exposition body.
 * Returns `null` when the series is absent entirely — the distinction between
 * "absent" and "present and zero" is the whole point of BLO-32269, so the
 * assertions below must be able to tell them apart rather than collapsing both
 * to a falsy 0.
 */
async function readCounter(name: string): Promise<number | null> {
  const { body } = await renderMetrics();
  const match = new RegExp(`^${name} (\\S+)$`, "m").exec(body);
  return match ? Number(match[1]) : null;
}

describe("recordHeartbeatTimerTick", () => {
  beforeEach(() => {
    __resetMetricsForTest();
  });

  it("publishes both series at zero before any tick is recorded", async () => {
    // A dispatch-dark rule needs `sum(increase(...[15m])) == 0` to evaluate on a
    // freshly-booted worker. If the series only appeared after the first
    // non-zero tick, the rule would silently return no data during exactly the
    // window it is meant to cover.
    await expect(readCounter(HEARTBEAT_TIMER_CHECKED_METRIC)).resolves.toBe(0);
    await expect(readCounter(HEARTBEAT_TIMER_ENQUEUED_METRIC)).resolves.toBe(0);
  });

  it("advances checked while leaving enqueued at zero for a healthy idle pass", async () => {
    // The diagnostic case the pair exists for: the loop ran and deliberately
    // enqueued nothing. Indistinguishable from a dead loop if only the
    // enqueued half were exported.
    recordHeartbeatTimerTick({ checked: 22, enqueued: 0 });

    await expect(readCounter(HEARTBEAT_TIMER_CHECKED_METRIC)).resolves.toBe(22);
    await expect(readCounter(HEARTBEAT_TIMER_ENQUEUED_METRIC)).resolves.toBe(0);
  });

  it("accumulates monotonically across passes", async () => {
    recordHeartbeatTimerTick({ checked: 22, enqueued: 3 });
    recordHeartbeatTimerTick({ checked: 22, enqueued: 0 });
    recordHeartbeatTimerTick({ checked: 21, enqueued: 5 });

    await expect(readCounter(HEARTBEAT_TIMER_CHECKED_METRIC)).resolves.toBe(65);
    await expect(readCounter(HEARTBEAT_TIMER_ENQUEUED_METRIC)).resolves.toBe(8);
  });

  it("records a zero-candidate pass without disturbing either series", async () => {
    recordHeartbeatTimerTick({ checked: 0, enqueued: 0 });

    await expect(readCounter(HEARTBEAT_TIMER_CHECKED_METRIC)).resolves.toBe(0);
    await expect(readCounter(HEARTBEAT_TIMER_ENQUEUED_METRIC)).resolves.toBe(0);
  });

  it("drops non-finite and negative inputs rather than clamping them to zero", async () => {
    recordHeartbeatTimerTick({ checked: 7, enqueued: 2 });

    recordHeartbeatTimerTick({ checked: Number.NaN, enqueued: Number.NaN });
    recordHeartbeatTimerTick({ checked: -1, enqueued: -1 });
    recordHeartbeatTimerTick({ checked: Number.POSITIVE_INFINITY, enqueued: Number.POSITIVE_INFINITY });

    // Still exactly the one good pass. Clamping a bad value to 0 would have
    // fabricated the "loop ran, found nothing" reading out of a bug, and a
    // counter that can move backwards breaks `increase()` outright.
    await expect(readCounter(HEARTBEAT_TIMER_CHECKED_METRIC)).resolves.toBe(7);
    await expect(readCounter(HEARTBEAT_TIMER_ENQUEUED_METRIC)).resolves.toBe(2);
  });

  it("drops the pass as a unit when only one half of the pair is bad", async () => {
    // The three cases above are all symmetric, so they pass whether the guard
    // is per-field or per-pair. These are the asymmetric ones, and they are the
    // whole point: a per-field guard would move `checked` and leave `enqueued`
    // flat, which is indistinguishable from clamping the bad value to 0 and
    // lands on the `checked > 0, enqueued = 0` shape this pair documents as
    // *Healthy* — i.e. a fleet that has stopped enqueuing, reporting healthy on
    // the surface the dispatch-dark rule reads. `enqueued` is the likelier half
    // to break because `tickTimers` composes it from a single field.
    recordHeartbeatTimerTick({ checked: 7, enqueued: 2 });

    recordHeartbeatTimerTick({ checked: 5, enqueued: Number.NaN });
    recordHeartbeatTimerTick({ checked: Number.NaN, enqueued: 5 });
    recordHeartbeatTimerTick({ checked: 5, enqueued: -1 });
    recordHeartbeatTimerTick({ checked: -1, enqueued: 5 });

    // Both series flat at the one good pass. Flat reads as dispatch-dark, which
    // is the direction that alerts rather than the direction that reassures.
    await expect(readCounter(HEARTBEAT_TIMER_CHECKED_METRIC)).resolves.toBe(7);
    await expect(readCounter(HEARTBEAT_TIMER_ENQUEUED_METRIC)).resolves.toBe(2);
  });

  it("declares both series as counters so increase() is valid over them", async () => {
    const { body } = await renderMetrics();
    expect(body).toContain(`# TYPE ${HEARTBEAT_TIMER_CHECKED_METRIC} counter`);
    expect(body).toContain(`# TYPE ${HEARTBEAT_TIMER_ENQUEUED_METRIC} counter`);
  });
});

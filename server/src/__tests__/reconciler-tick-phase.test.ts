import { describe, expect, it } from "vitest";

import {
  APPROVAL_GATE_RECONCILER_TICK_PHASE,
  MEASURED_HEADROOM_BAND_MINUTES,
  MEASURED_RICH_BAND_MINUTES,
  MERGED_PR_RECONCILER_TICK_PHASE,
  PR_REVIEW_STATE_RECONCILER_TICK_PHASE,
  TERMINAL_GATE_RECONCILER_TICK_PHASE,
} from "../services/reconciler-tick-phase.js";
import {
  msUntilPhase,
  type WorkerSingletonStartPhase,
} from "../services/worker-singleton-supervisor.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * The minutes-of-hour a loop with this phase and this interval actually ticks
 * at, derived the way the running system derives them: resolve the first tick
 * with `msUntilPhase`, then step by the interval. Deriving rather than
 * asserting the literals is the point — it is what catches a phase whose offset
 * is right and whose grid is wrong.
 */
function tickMinutesOfHour(phase: WorkerSingletonStartPhase, intervalMs: number): number[] {
  // An arbitrary instant that is NOT already on any grid, so the first tick is
  // genuinely computed rather than inherited from the sample.
  const startMs = 7 * HOUR_MS + 31 * MINUTE_MS + 17_123;
  const firstTickMs = startMs + msUntilPhase(startMs, phase);
  const minutes = new Set<number>();
  for (let tick = 0; tick < Math.max(1, Math.round(HOUR_MS / Math.min(intervalMs, HOUR_MS))); tick++) {
    minutes.add(Math.floor((firstTickMs + tick * intervalMs) / MINUTE_MS) % 60);
  }
  return [...minutes].sort((a, b) => a - b);
}

const inBand = (minute: number, band: { first: number; last: number }) =>
  minute >= band.first && minute <= band.last;

/** The measured-exhausted band is the complement of the headroom band. */
const inExhaustedBand = (minute: number) => !inBand(minute, MEASURED_HEADROOM_BAND_MINUTES);

describe("reconciler tick phases (PEN-6750)", () => {
  const hourlyPhases = {
    "merged-pr-reconciler": MERGED_PR_RECONCILER_TICK_PHASE,
    "pr-review-state-reconciler": PR_REVIEW_STATE_RECONCILER_TICK_PHASE,
  };
  const tenMinutePhases = {
    "approval-gate-reconciler": APPROVAL_GATE_RECONCILER_TICK_PHASE,
    "terminal-gate-reconciler": TERMINAL_GATE_RECONCILER_TICK_PHASE,
  };

  it("lands every 360-minute GitHub sweep inside the measured headroom band", () => {
    for (const [name, phase] of Object.entries(hourlyPhases)) {
      const minutes = tickMinutesOfHour(phase, 360 * MINUTE_MS);
      expect(minutes, name).toHaveLength(1);
      expect(inBand(minutes[0], MEASURED_HEADROOM_BAND_MINUTES), `${name} @ :${minutes[0]}`).toBe(
        true,
      );
      expect(inBand(minutes[0], MEASURED_RICH_BAND_MINUTES), `${name} @ :${minutes[0]}`).toBe(true);
    }
  });

  it("gives the two 360-minute GitHub sweeps different tick instants", () => {
    // They share an interval, so a shared minute is a shared tick instant for
    // the life of the process. This is PEN-6750's second acceptance criterion.
    const [merged] = tickMinutesOfHour(hourlyPhases["merged-pr-reconciler"], 360 * MINUTE_MS);
    const [review] = tickMinutesOfHour(
      hourlyPhases["pr-review-state-reconciler"],
      360 * MINUTE_MS,
    );
    expect(merged).not.toBe(review);
  });

  it("gives the two 10-minute GitHub sweeps different tick instants", () => {
    const approval = tickMinutesOfHour(tenMinutePhases["approval-gate-reconciler"], 10 * MINUTE_MS);
    const terminal = tickMinutesOfHour(tenMinutePhases["terminal-gate-reconciler"], 10 * MINUTE_MS);
    expect(approval.filter((m) => terminal.includes(m))).toEqual([]);
  });

  it("keeps the 10-minute sweeps clear of the 360-minute sweeps' minutes", () => {
    const hourlyMinutes = Object.values(hourlyPhases).flatMap((p) =>
      tickMinutesOfHour(p, 360 * MINUTE_MS),
    );
    for (const [name, phase] of Object.entries(tenMinutePhases)) {
      const minutes = tickMinutesOfHour(phase, 10 * MINUTE_MS);
      expect(minutes.filter((m) => hourlyMinutes.includes(m)), name).toEqual([]);
    }
  });

  // The honest limitation, asserted rather than left in a comment to rot: six
  // ticks an hour cannot avoid a 20-minute hole, so for these two the phase
  // buys stagger and not budget. If someone later claims a 10-minute sweep was
  // moved out of the exhausted band, this test is what refutes it.
  it("cannot keep a 10-minute sweep out of the exhausted band, and says so", () => {
    for (const [name, phase] of Object.entries(tenMinutePhases)) {
      const minutes = tickMinutesOfHour(phase, 10 * MINUTE_MS);
      expect(minutes, name).toHaveLength(6);
      expect(minutes.filter(inExhaustedBand), name).toHaveLength(2);
    }
  });

  it("pins each phase to a whole minute of a grid that divides an hour", () => {
    for (const [name, phase] of Object.entries({ ...hourlyPhases, ...tenMinutePhases })) {
      expect(phase.offsetMs % MINUTE_MS, name).toBe(0);
      expect(phase.offsetMs, name).toBeLessThan(phase.periodMs);
      expect(HOUR_MS % phase.periodMs, name).toBe(0);
    }
  });
});

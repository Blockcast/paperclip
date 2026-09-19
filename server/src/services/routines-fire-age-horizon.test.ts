import { describe, expect, it } from "vitest";
import { deriveRoutineFireAgeHorizonMs } from "./routines.js";

// BLO-31996: how long one routine fire may hold the dispatch lock. A scheduled
// fire is a point-in-time probe whose value expires when its replacement is
// due, so the horizon is one cadence interval less a jitter margin. The
// dispatch-path tests in `__tests__/routines-service.test.ts` exercise the
// fallback (they dispatch with no trigger); this covers the derivation itself.
const HOUR_MS = 60 * 60 * 1000;
const JITTER_MS = 60 * 1000;
const FALLBACK_MS = 6 * HOUR_MS;

describe("deriveRoutineFireAgeHorizonMs", () => {
  const now = new Date("2026-09-05T00:00:00.000Z");

  it("derives one cadence interval, less a jitter margin, from a schedule trigger", () => {
    // The routine that produced this issue: `23 */6 * * *`, a 6h cadence.
    const horizon = deriveRoutineFireAgeHorizonMs(
      { kind: "schedule", cronExpression: "23 */6 * * *", timezone: "UTC" },
      now,
    );
    expect(horizon).toBe(6 * HOUR_MS - JITTER_MS);
  });

  it("tracks the cadence rather than assuming one, so a fast routine gets a short horizon", () => {
    const horizon = deriveRoutineFireAgeHorizonMs(
      { kind: "schedule", cronExpression: "*/15 * * * *", timezone: "UTC" },
      now,
    );
    expect(horizon).toBe(15 * 60 * 1000 - JITTER_MS);
  });

  // The jitter margin exists so a successor landing a beat early is not re-gated
  // by the very bound meant to protect it, but it must not be able to drive the
  // horizon to zero and disable gating altogether on a sub-minute cron.
  it("floors the horizon so a sub-minute cadence cannot collapse it to zero", () => {
    const horizon = deriveRoutineFireAgeHorizonMs(
      { kind: "schedule", cronExpression: "* * * * *", timezone: "UTC" },
      now,
    );
    expect(horizon).toBe(5 * 60 * 1000);
    expect(horizon).toBeGreaterThan(0);
  });

  // Webhook/api fires have no cadence to derive from, so they keep the flat
  // run-age horizon -- i.e. exactly the pre-BLO-31996 behaviour.
  it.each([
    ["webhook", { kind: "webhook", cronExpression: null, timezone: null }],
    ["api", { kind: "api", cronExpression: null, timezone: null }],
  ] as const)("falls back to the flat horizon for a %s trigger", (_label, trigger) => {
    expect(deriveRoutineFireAgeHorizonMs(trigger, now)).toBe(FALLBACK_MS);
  });

  it.each([
    ["no trigger", null],
    ["undefined trigger", undefined],
    ["a schedule trigger missing its cron", { kind: "schedule", cronExpression: null, timezone: "UTC" }],
    ["a schedule trigger missing its timezone", { kind: "schedule", cronExpression: "23 */6 * * *", timezone: null }],
  ] as const)("falls back to the flat horizon given %s", (_label, trigger) => {
    expect(deriveRoutineFireAgeHorizonMs(trigger, now)).toBe(FALLBACK_MS);
  });

  // A cron that no longer parses must not take routine dispatch down with it:
  // gating continues on the flat horizon rather than throwing out of dispatch.
  it("falls back to the flat horizon rather than throwing on an unparseable cron", () => {
    expect(
      deriveRoutineFireAgeHorizonMs(
        { kind: "schedule", cronExpression: "not a cron", timezone: "UTC" },
        now,
      ),
    ).toBe(FALLBACK_MS);
  });

  // The horizon is measured between the next two ticks after `now` rather than
  // read from stored state, so editing a cron self-corrects with no migration.
  it("re-derives across a DST boundary without going negative or zero", () => {
    const horizon = deriveRoutineFireAgeHorizonMs(
      { kind: "schedule", cronExpression: "23 */6 * * *", timezone: "America/New_York" },
      new Date("2026-03-08T04:00:00.000Z"),
    );
    expect(horizon).toBeGreaterThan(0);
  });

  // Ally review, BLO-31996: an irregular cron has more than one gap, and a
  // single forward sample returns whichever one the sampling instant happens to
  // land in. Taking the minimum over several consecutive ticks makes the result
  // independent of when it is called -- which matters because it is called at
  // an arbitrary dispatch time, not at a tick boundary.
  describe("irregular cron expressions", () => {
    // The motivating case, and the one that is off by 3x in the dangerous
    // direction: a weekday-only cron sampled before Friday's tick sees
    // Fri -> Mon = 72h. A fire wedged on Thursday would then hold the dispatch
    // lock until the following Tuesday.
    it("uses the weekday interval for a weekday-only cron regardless of sampling day", () => {
      const weekday = { kind: "schedule", cronExpression: "0 9 * * 1-5", timezone: "UTC" } as const;
      // Thursday, Friday pre-tick (the 72h trap), and Saturday.
      for (const sampledAt of [
        new Date("2026-09-03T00:00:00.000Z"),
        new Date("2026-09-04T00:00:00.000Z"),
        new Date("2026-09-05T00:00:00.000Z"),
      ]) {
        expect(deriveRoutineFireAgeHorizonMs(weekday, sampledAt)).toBe(24 * HOUR_MS - JITTER_MS);
      }
    });

    // Two ticks an hour apart then a 23h gap: the tightest cadence is the one
    // that governs, and the answer must not depend on where the sample lands.
    it("uses the shortest gap for a bunched cron regardless of sampling hour", () => {
      const bunched = { kind: "schedule", cronExpression: "0 0,1 * * *", timezone: "UTC" } as const;
      for (const sampledAt of [
        new Date("2026-09-05T00:30:00.000Z"),
        new Date("2026-09-05T12:00:00.000Z"),
      ]) {
        expect(deriveRoutineFireAgeHorizonMs(bunched, sampledAt)).toBe(HOUR_MS - JITTER_MS);
      }
    });

    // A regular cadence must be unaffected by the multi-sample change: every
    // gap is identical, so the minimum is that gap.
    it("is unchanged for a regular cadence", () => {
      expect(
        deriveRoutineFireAgeHorizonMs(
          { kind: "schedule", cronExpression: "23 */6 * * *", timezone: "UTC" },
          now,
        ),
      ).toBe(6 * HOUR_MS - JITTER_MS);
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { isLapsedMonitorStillLive } from "../services/recovery/service.js";

// BLO-24782: `hasActiveMonitorPath` used to read a monitor in `triggered` state as a
// live wake path with no bound at all. `derivePersistedMonitorState` synthesizes that
// status from `monitorLastTriggeredAt` / `monitorAttemptCount`, and neither column is
// cleared when a monitor lapses -- so "fired a minute ago" and "fired 8 days ago and
// abandoned" produced the identical verdict. The sweep therefore skipped the issue,
// no `issue_recovery_actions` row was ever created, and the BLO-19124 reaper could
// not see the issue even in principle.
describe("BLO-24782 lapsed monitor grace bound", () => {
  const GRACE = 6 * 60 * 60_000;
  const NOW = Date.parse("2026-08-12T08:00:00.000Z");

  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  describe("isLapsedMonitorStillLive", () => {
    it("still reads a just-fired monitor as live, preserving the BLO-16146 anti-race", () => {
      // The race this grace defends against is measured in seconds: a continuation
      // run that is legitimately about to re-arm must not be escalated out from
      // under itself.
      expect(
        isLapsedMonitorStillLive({ lastTriggeredAt: at(5_000), now: NOW, graceMs: GRACE }),
      ).toBe(true);
    });

    it("still reads a monitor fired just inside the bound as live", () => {
      expect(
        isLapsedMonitorStillLive({ lastTriggeredAt: at(GRACE - 60_000), now: NOW, graceMs: GRACE }),
      ).toBe(true);
    });

    it("stops reading a monitor fired past the bound as live", () => {
      expect(
        isLapsedMonitorStillLive({ lastTriggeredAt: at(GRACE + 60_000), now: NOW, graceMs: GRACE }),
      ).toBe(false);
    });

    it("treats the bound as exclusive at the boundary instant", () => {
      expect(
        isLapsedMonitorStillLive({ lastTriggeredAt: at(GRACE), now: NOW, graceMs: GRACE }),
      ).toBe(false);
    });

    it("reads the real stuck population as not live", () => {
      // Measured 2026-08-12 on the CTO's own queue: 22 of 89 `in_progress` issues sat
      // triggered-and-never-re-armed with no run and no recovery action. These are the
      // five oldest, in hours since `monitorLastTriggeredAt`.
      const oldestLapsedHours = [207.5, 173.3, 155.3, 122.8, 114.5];
      for (const hours of oldestLapsedHours) {
        expect(
          isLapsedMonitorStillLive({
            lastTriggeredAt: at(hours * 60 * 60_000),
            now: NOW,
            graceMs: GRACE,
          }),
        ).toBe(false);
      }
    });

    it("reads an absent trigger instant as not live", () => {
      // `status: "triggered"` can be synthesized from `attemptCount > 0` alone, with no
      // timestamp to bound against. An unbounded triggered state of unknown age is
      // exactly the stuck shape, so it must not count as a live wake path.
      expect(
        isLapsedMonitorStillLive({ lastTriggeredAt: null, now: NOW, graceMs: GRACE }),
      ).toBe(false);
    });

    it("reads an unparseable trigger instant as not live", () => {
      expect(
        isLapsedMonitorStillLive({ lastTriggeredAt: "not-a-timestamp", now: NOW, graceMs: GRACE }),
      ).toBe(false);
    });

    // This is why the config layer must never hand this predicate a non-finite grace,
    // and it is the mechanism behind the review finding on #1330: the predicate itself
    // is correct, so an infinite `graceMs` reinstates the unbounded belief without any
    // code here being wrong. Guarding the parse is the only place this can be stopped.
    it("would read even the oldest abandoned monitor as live if handed an infinite grace", () => {
      expect(
        isLapsedMonitorStillLive({
          lastTriggeredAt: at(207.5 * 60 * 60_000),
          now: NOW,
          graceMs: Number.POSITIVE_INFINITY,
        }),
      ).toBe(true);
    });
  });

  describe("lapsedMonitorGraceMs config", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      delete process.env.LAPSED_MONITOR_GRACE_MS;
      process.env.PAPERCLIP_PUBLIC_URL = "http://localhost:3100";
      process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
      process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE = "private";
      process.env.PAPERCLIP_AUTH_BASE_URL_MODE = "explicit";
    });

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("defaults to the six-hour horizon when unset", () => {
      expect(loadConfig()).toMatchObject({ lapsedMonitorGraceMs: 6 * 60 * 60_000 });
    });

    it("uses an explicit override", () => {
      process.env.LAPSED_MONITOR_GRACE_MS = String(2 * 60 * 60_000);
      expect(loadConfig()).toMatchObject({ lapsedMonitorGraceMs: 2 * 60 * 60_000 });
    });

    it("floors the override well above a continuation run's turnaround", () => {
      // An operator must not be able to shrink the grace to where the sweep can beat
      // a run that is legitimately about to re-arm.
      process.env.LAPSED_MONITOR_GRACE_MS = "1000";
      expect(loadConfig()).toMatchObject({ lapsedMonitorGraceMs: 15 * 60_000 });
    });

    it("is independently choosable from the recovery action timeout it defaults to match", () => {
      process.env.LAPSED_MONITOR_GRACE_MS = String(3 * 60 * 60_000);
      const config = loadConfig();
      expect(config.lapsedMonitorGraceMs).toBe(3 * 60 * 60_000);
      expect(config.recoveryActionTimeoutMs).toBe(6 * 60 * 60_000);
    });

    // BLO-24782 review finding: `Number("Infinity")` is truthy, so the old
    // `Number(env) || default` fallback never fired, and `Math.max(floor, Infinity)`
    // is `Infinity`. That made the grace infinite — a `triggered` monitor would read
    // as a live wake path forever, which is precisely the stranded-issue failure this
    // bound exists to remove. One env typo silently reverted the fix.
    it.each(["Infinity", "+Infinity", "1e999"])(
      "rejects the non-finite override %s and falls back to the default",
      (value) => {
        process.env.LAPSED_MONITOR_GRACE_MS = value;
        const { lapsedMonitorGraceMs } = loadConfig();
        expect(Number.isFinite(lapsedMonitorGraceMs)).toBe(true);
        expect(lapsedMonitorGraceMs).toBe(6 * 60 * 60_000);
      },
    );

    it("rejects -Infinity rather than flooring it, so the intent stays legible", () => {
      process.env.LAPSED_MONITOR_GRACE_MS = "-Infinity";
      expect(loadConfig()).toMatchObject({ lapsedMonitorGraceMs: 6 * 60 * 60_000 });
    });

    // A finite override can still be effectively infinite: 1e308 ms is ~1e297 years.
    // Rejecting only non-finite input would leave that half of the hole open.
    it("clamps a finite but absurd override to the seven-day ceiling", () => {
      process.env.LAPSED_MONITOR_GRACE_MS = "1e308";
      expect(loadConfig()).toMatchObject({ lapsedMonitorGraceMs: 7 * 24 * 60 * 60_000 });
    });

    it("falls back to the default for unparseable, empty, and non-positive overrides", () => {
      for (const value of ["not-a-number", "", "0", "-1"]) {
        process.env.LAPSED_MONITOR_GRACE_MS = value;
        expect(loadConfig().lapsedMonitorGraceMs).toBe(6 * 60 * 60_000);
      }
    });

    it("keeps every resolved grace finite across the whole override space", () => {
      for (const value of ["Infinity", "1e999", "1e308", "abc", "", "0", "-1", "-Infinity", "1000"]) {
        process.env.LAPSED_MONITOR_GRACE_MS = value;
        const { lapsedMonitorGraceMs } = loadConfig();
        expect(Number.isFinite(lapsedMonitorGraceMs)).toBe(true);
        expect(lapsedMonitorGraceMs).toBeGreaterThanOrEqual(15 * 60_000);
        expect(lapsedMonitorGraceMs).toBeLessThanOrEqual(7 * 24 * 60 * 60_000);
      }
    });
  });
});

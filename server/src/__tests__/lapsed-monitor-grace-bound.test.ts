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
  });
});

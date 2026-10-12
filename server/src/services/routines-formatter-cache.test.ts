import { afterEach, describe, expect, it, vi } from "vitest";
import { nextCronTickInTimeZone } from "./routines.js";

describe("nextCronTickInTimeZone formatter caching", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("computes the next occurrence of a sparse monthly cron correctly", () => {
    const next = nextCronTickInTimeZone(
      "30 6 1 * *",
      "America/New_York",
      new Date("2026-06-02T00:00:00Z"),
    );
    expect(next).not.toBeNull();
    // 06:30 America/New_York on July 1st is 10:30 UTC (EDT, UTC-4).
    expect(next!.toISOString()).toBe("2026-07-01T10:30:00.000Z");
  });

  it("does not construct a new Intl.DateTimeFormat per minute-step", () => {
    const RealDateTimeFormat = Intl.DateTimeFormat;
    let constructions = 0;
    // Must be a `function` (not an arrow) so the mock stays constructable
    // when the code under test calls `new Intl.DateTimeFormat(...)`.
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (
      ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
    ) {
      constructions += 1;
      return new RealDateTimeFormat(...args);
    } as unknown as typeof Intl.DateTimeFormat);

    // A monthly cron searched from just after the previous firing. The bounded
    // search (BLO-32638) makes a handful of wall-clock lookups for it; the old
    // minute stepper made ~43k. Use a timezone that nothing else in this test
    // file has warmed so cache misses are observable.
    const next = nextCronTickInTimeZone(
      "0 12 1 * *",
      "Pacific/Kiritimati",
      new Date("2026-06-01T12:01:00Z"),
    );
    expect(next).not.toBeNull();

    // One construction to populate the per-timezone cache; every later lookup
    // must reuse it. Before the cache the minute stepper constructed one per
    // step, which blocked the event loop for minutes (#8033).
    expect(constructions).toBeLessThanOrEqual(1);

    constructions = 0;
    nextCronTickInTimeZone("0 12 1 * *", "Pacific/Kiritimati", new Date("2026-06-01T12:01:00Z"));
    expect(constructions).toBe(0);
  });
});

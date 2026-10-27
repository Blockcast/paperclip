/**
 * PEN-3314 — the 1 s RSS release detector.
 *
 * This instrument exists because every other memory series on the row is blind
 * to a release: the sibling sampler keeps a monotonic maximum, the mapping scan
 * is floored at a 300 s cadence by its own cost, and everything else is
 * scrape-resolution. So the failure modes worth testing are the ones that would
 * let it publish a confident zero, or a confident WRONG timestamp, while a
 * release happens anyway:
 *
 * 1. **A gradual drain must still register.** The measured 3.3 GB release took
 *    ~15 minutes (~3.6 MB/s). A consecutive-sample delta detector — the obvious
 *    implementation — sees ~3.6 MB per tick and fires never. There is no
 *    edgewise threshold that catches both that and a single-scrape step, which
 *    is why this is a drawdown detector and why the drain is tested explicitly.
 * 2. **A partial refill must close the episode.** The measured shape is a
 *    STAIRCASE: RSS 1800.8 -> 1073.6 -> 1929.6 MB. If an episode only closed on
 *    recovery past the ORIGINAL peak, a refill that plateaued lower would hold
 *    it open forever and the NEXT release would be silently swallowed.
 * 3. **The onset must be the start of the drawdown, not its detection.** Those
 *    differ by ~15 minutes on the drain shape, and the whole purpose of the
 *    module is to give a trigger search something to align against.
 * 4. **"Never sampled" must not render as "no releases".** Same gauge value,
 *    opposite conclusions; this row has already paid two months for that
 *    conflation once on `nodejs_heap_size_used_bytes`.
 * 5. **The sampler must not keep the process alive, and one throwing read must
 *    not blind it for the process lifetime.**
 */

import { describe, expect, it, afterEach, beforeEach } from "vitest";

import {
  PROCESS_RSS_RELEASE_EVENTS_METRIC,
  PROCESS_RSS_RELEASE_LAST_BYTES_METRIC,
  PROCESS_RSS_RELEASE_LAST_DETECTED_TIMESTAMP_METRIC,
  PROCESS_RSS_RELEASE_LAST_ONSET_TIMESTAMP_METRIC,
  PROCESS_RSS_RELEASE_BOUND_BYTES_METRIC,
  PROCESS_RSS_RELEASE_SAMPLES_METRIC,
  __resetMetricsForTest,
  renderMetrics,
  setRssReleaseMetrics,
} from "../services/metrics.js";

import {
  DEFAULT_RELEASE_THRESHOLD_BYTES,
  DEFAULT_SAMPLE_INTERVAL_MS,
  PLATEAU_BAND_DIVISOR,
  __resetRssReleaseTrackerForTest,
  readRssReleases,
  recordRssSample,
  startRssReleaseTracking,
} from "../services/rss-release-tracker.js";

const MIB = 1024 * 1024;

beforeEach(() => {
  __resetRssReleaseTrackerForTest();
});

describe("recordRssSample", () => {
  it("reports nothing until it has been fed a sample", () => {
    expect(readRssReleases()).toBeNull();
  });

  it("treats the first reading as the high-water mark, not a drawdown from zero", () => {
    recordRssSample(1800 * MIB, 1_000);
    const reading = readRssReleases()!;
    expect(reading.releaseCount).toBe(0);
    expect(reading.lastOnsetAtMs).toBeNull();
  });

  it("counts a non-finite reading as a live sample but folds nothing", () => {
    recordRssSample(undefined, 1_000);
    const reading = readRssReleases()!;
    // The count's job is to say whether the sampler is alive. Conflating
    // "running but this runtime reported no RSS" with "never started" is the
    // ambiguity the module exists to avoid.
    expect(reading.sampleCount).toBe(1);
    expect(reading.releaseCount).toBe(0);
  });

  it("ignores churn shallower than the threshold", () => {
    recordRssSample(1800 * MIB, 1_000);
    recordRssSample(1760 * MIB, 2_000);
    recordRssSample(1790 * MIB, 3_000);
    expect(readRssReleases()!.releaseCount).toBe(0);
  });

  it("restamps the onset clock for in-band churn but not for out-of-band dips", () => {
    recordRssSample(1800 * MIB, 1_000);
    recordRssSample(1760 * MIB, 2_000); // 40 MiB down: descending, do not restamp
    recordRssSample(1790 * MIB, 3_000); // 10 MiB down: inside the band, restamp
    recordRssSample(1200 * MIB, 4_000);
    // Onset is the last IN-BAND sample. Keying on the exact maximum would have
    // pinned this at 1_000 -- the bug Ally caught on #3040.
    expect(readRssReleases()!.lastOnsetAtMs).toBe(3_000);
  });

  /**
   * The gen-2 release: 100% of `anon_other` and 100% of the 262144 bucket
   * returned, -2234 mappings x 262,144 B = 585.6 MB against 588.3 MB observed.
   * Here it completes between two samples.
   */
  it("detects a step release and dates both ends of it", () => {
    recordRssSample(1800 * MIB, 10_000);
    recordRssSample(1800 * MIB, 11_000);
    recordRssSample(1212 * MIB, 12_000);

    const reading = readRssReleases()!;
    expect(reading.releaseCount).toBe(1);
    expect(reading.lastReleaseBytes).toBe(588 * MIB);
    // Onset is the last sample AT the high, not the first sample below it.
    expect(reading.lastOnsetAtMs).toBe(11_000);
    expect(reading.lastDetectedAtMs).toBe(12_000);
    // One interval apart => a step. This is the discriminator against the drain.
    expect(reading.lastDetectedAtMs! - reading.lastOnsetAtMs!).toBe(1_000);
  });

  /**
   * The 2026-09-16T09:45Z release: 3.3 GB over ~15 minutes with the process
   * alive. At 1 Hz that is ~3.7 MB per sample — two orders of magnitude below
   * the threshold — so this is the case a consecutive-sample delta detector
   * misses entirely.
   */
  it("detects a 15-minute drain as ONE episode a per-sample delta would miss", () => {
    const startBytes = 1870 * MIB;
    const endBytes = 790 * MIB;
    const samples = 900;
    const perSample = (startBytes - endBytes) / samples;

    // Precondition of the test, and the reason the detector is shaped this way:
    // no single step comes close to the threshold.
    expect(perSample).toBeLessThan(DEFAULT_RELEASE_THRESHOLD_BYTES / 50);

    recordRssSample(startBytes, 0);
    for (let i = 1; i <= samples; i += 1) {
      recordRssSample(startBytes - perSample * i, i * 1_000);
    }

    const reading = readRssReleases()!;
    expect(reading.releaseCount).toBe(1);
    expect(reading.episodeOpen).toBe(true);
    // The magnitude is peak-to-trough and keeps deepening as the drain runs; it
    // is not frozen at the instant of detection.
    expect(reading.lastReleaseBytes).toBeCloseTo(startBytes - endBytes, -3);
    // The onset is bounded-LATE by one plateau band, not hours-early: the first
    // samples of a slow drain are still inside the band, so they restamp. At
    // 1.2 MiB/sample a 16 MiB band is ~13 samples -- 1.4% of a 900 s drain, and
    // the documented cost of not letting a lone noise spike pin the stamp.
    const bandSamples = Math.floor(DEFAULT_RELEASE_THRESHOLD_BYTES / 4 / perSample);
    expect(reading.lastOnsetAtMs).toBe(bandSamples * 1_000);
    expect(reading.lastOnsetAtMs!).toBeLessThan(0.02 * samples * 1_000);
    // Detection lags the onset by the time taken to shed the threshold, which
    // is what makes a drain legible as a drain rather than as a step.
    expect(reading.lastDetectedAtMs).toBeGreaterThan(50_000);
  });

  /**
   * The staircase: 1800.8 -> 1073.6 -> 1929.6 MB. The refill in the middle
   * overshoots here, but the detector must not DEPEND on the overshoot.
   */
  it("closes the episode on refill and re-anchors the high-water mark", () => {
    recordRssSample(1800 * MIB, 1_000);
    recordRssSample(1073 * MIB, 2_000);
    expect(readRssReleases()!.episodeOpen).toBe(true);

    recordRssSample(1929 * MIB, 3_000);
    const refilled = readRssReleases()!;
    expect(refilled.episodeOpen).toBe(false);
    expect(refilled.releaseCount).toBe(1);
  });

  /**
   * The case that would be silently lost if an episode only closed on recovery
   * past the original peak: RSS releases, refills only PART of the way, and
   * then releases again from the lower plateau.
   */
  it("reports a second release after a refill that never regains the old peak", () => {
    recordRssSample(1800 * MIB, 1_000);
    recordRssSample(1100 * MIB, 2_000);
    expect(readRssReleases()!.releaseCount).toBe(1);

    // Refills to 1400 MB — well below the 1800 MB high, so a detector keyed on
    // the original peak would still consider the first episode open.
    recordRssSample(1400 * MIB, 3_000);
    expect(readRssReleases()!.episodeOpen).toBe(false);

    recordRssSample(700 * MIB, 4_000);
    const second = readRssReleases()!;
    expect(second.releaseCount).toBe(2);
    // Measured from the re-anchored high (1400), not the stale one (1800).
    expect(second.lastReleaseBytes).toBe(700 * MIB);
    expect(second.lastOnsetAtMs).toBe(3_000);
  });

  it("accumulates released bytes across episodes", () => {
    recordRssSample(1800 * MIB, 1_000);
    recordRssSample(1100 * MIB, 2_000);
    recordRssSample(1400 * MIB, 3_000);
    recordRssSample(700 * MIB, 4_000);
    expect(readRssReleases()!.releasedBytesTotal).toBe(700 * MIB + 700 * MIB);
  });

  it("publishes the bounds that say what could have been missed", () => {
    recordRssSample(1800 * MIB, 1_000);
    const reading = readRssReleases()!;
    expect(reading.sampleIntervalMs).toBe(DEFAULT_SAMPLE_INTERVAL_MS);
    expect(reading.thresholdBytes).toBe(DEFAULT_RELEASE_THRESHOLD_BYTES);
  });
});

describe("startRssReleaseTracking", () => {
  function fakeTimers() {
    const ticks: Array<() => void> = [];
    let cleared = 0;
    let unreffed = 0;
    const handle = {
      unref() {
        unreffed += 1;
      },
    };
    return {
      ticks,
      get cleared() {
        return cleared;
      },
      get unreffed() {
        return unreffed;
      },
      setInterval: ((fn: () => void) => {
        ticks.push(fn);
        return handle;
      }) as unknown as typeof setInterval,
      clearInterval: (() => {
        cleared += 1;
      }) as unknown as typeof clearInterval,
    };
  }

  it("unrefs its timer so it cannot hold the process open", () => {
    const timers = fakeTimers();
    startRssReleaseTracking({ setInterval: timers.setInterval, clearInterval: timers.clearInterval });
    expect(timers.unreffed).toBe(1);
  });

  it("samples on each tick and detects the release", () => {
    const timers = fakeTimers();
    const series = [1800 * MIB, 1800 * MIB, 1212 * MIB];
    let index = 0;
    let clock = 0;
    startRssReleaseTracking({
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      residentSetSize: () => series[index++]!,
      now: () => (clock += 1_000),
    });
    for (let i = 0; i < series.length; i += 1) timers.ticks[0]!();
    expect(readRssReleases()!.releaseCount).toBe(1);
  });

  it("survives a throwing read and keeps sampling afterwards", () => {
    const timers = fakeTimers();
    let call = 0;
    startRssReleaseTracking({
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      residentSetSize: () => {
        call += 1;
        if (call === 1) throw new Error("procfs unavailable");
        return 777;
      },
    });
    timers.ticks[0]!();
    // A tick that read nothing is not evidence the sampler is observing anything.
    expect(readRssReleases()).toBeNull();
    timers.ticks[0]!();
    expect(readRssReleases()!.sampleCount).toBe(1);
  });

  it("records the configured bounds so they are published, not assumed", () => {
    const timers = fakeTimers();
    startRssReleaseTracking({
      intervalMs: 250,
      thresholdBytes: 8 * MIB,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      residentSetSize: () => 1,
    });
    timers.ticks[0]!();
    const reading = readRssReleases()!;
    expect(reading.sampleIntervalMs).toBe(250);
    expect(reading.thresholdBytes).toBe(8 * MIB);
  });

  it("stops once and is idempotent", () => {
    const timers = fakeTimers();
    const stop = startRssReleaseTracking({
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    stop();
    stop();
    expect(timers.cleared).toBe(1);
  });
});

/**
 * The publish path. These assertions are the module's central claim rendered in
 * the only form that matters — what a scrape actually sees — because every
 * absent-versus-zero argument in the module docblock is only true if prom-client
 * agrees, and a label-less gauge publishes `name 0` from the moment it is
 * registered unless it is explicitly dropped.
 */
describe("setRssReleaseMetrics (the publish path)", () => {
  afterEach(() => {
    __resetMetricsForTest();
  });

  async function scalar(metric: string): Promise<number | null> {
    const { body } = await renderMetrics();
    for (const line of body.split("\n")) {
      if (line.startsWith("#")) continue;
      const matched = new RegExp(`^${metric}\\s+(\\S+)$`).exec(line);
      if (matched) return Number(matched[1]);
    }
    return null;
  }

  it("publishes nothing at all when the sampler has never ticked", async () => {
    setRssReleaseMetrics(null);
    // Not 0. "Cannot measure" and "measured zero" must not render identically,
    // and a 0 here would read as a live sampler that has seen no release.
    expect(await scalar(PROCESS_RSS_RELEASE_EVENTS_METRIC)).toBeNull();
    expect(await scalar(PROCESS_RSS_RELEASE_SAMPLES_METRIC)).toBeNull();
  });

  it("publishes a zero event count once the sampler is alive, qualified by the sample count", async () => {
    recordRssSample(1800 * MIB, 1_000);
    setRssReleaseMetrics(readRssReleases());
    // Zero events IS the measurement here, and it is readable as one only
    // because the sample count beside it says the sampler ran.
    expect(await scalar(PROCESS_RSS_RELEASE_EVENTS_METRIC)).toBe(0);
    expect(await scalar(PROCESS_RSS_RELEASE_SAMPLES_METRIC)).toBe(1);
  });

  it("leaves the last_* series ABSENT until a release is observed", async () => {
    recordRssSample(1800 * MIB, 1_000);
    setRssReleaseMetrics(readRssReleases());
    // A 0 onset is epoch 1970, and `time() - onset` on it reads as 56 years of
    // staleness rather than as "no release yet".
    expect(await scalar(PROCESS_RSS_RELEASE_LAST_ONSET_TIMESTAMP_METRIC)).toBeNull();
    expect(await scalar(PROCESS_RSS_RELEASE_LAST_DETECTED_TIMESTAMP_METRIC)).toBeNull();
    expect(await scalar(PROCESS_RSS_RELEASE_LAST_BYTES_METRIC)).toBeNull();
  });

  it("publishes both ends of the episode in SECONDS once one is observed", async () => {
    recordRssSample(1800 * MIB, 11_000);
    recordRssSample(1212 * MIB, 12_000);
    setRssReleaseMetrics(readRssReleases());
    // Prometheus timestamps are seconds; the tracker keeps epoch ms.
    expect(await scalar(PROCESS_RSS_RELEASE_LAST_ONSET_TIMESTAMP_METRIC)).toBe(11);
    expect(await scalar(PROCESS_RSS_RELEASE_LAST_DETECTED_TIMESTAMP_METRIC)).toBe(12);
    expect(await scalar(PROCESS_RSS_RELEASE_LAST_BYTES_METRIC)).toBe(588 * MIB);
  });

  it("drops the series again when the sampler stops reporting", async () => {
    recordRssSample(1800 * MIB, 1_000);
    setRssReleaseMetrics(readRssReleases());
    expect(await scalar(PROCESS_RSS_RELEASE_SAMPLES_METRIC)).toBe(1);
    // remove(), not reset(): reset() would return a label-less gauge to a
    // PUBLISHED 0, which rate() reads as a permanently stalled event loop.
    setRssReleaseMetrics(null);
    expect(await scalar(PROCESS_RSS_RELEASE_SAMPLES_METRIC)).toBeNull();
  });
});

describe("REPRO: noisy plateau onset (Ally #3040 important finding)", () => {
  it("dates the onset at the END of a noisy plateau, not at its highest spike", () => {
    // Peak at t=1s, then hover a few MB under it for three hours, then release.
    recordRssSample(1800 * MIB, 1_000);
    let t = 2_000;
    for (let i = 0; i < 10; i += 1) {
      recordRssSample((1790 + (i % 7)) * MIB, t);
      t += 1_000;
    }
    const plateauEndMs = t - 1_000;
    recordRssSample(1212 * MIB, t);

    const reading = readRssReleases()!;
    expect(reading.releaseCount).toBe(1);
    expect(reading.lastOnsetAtMs).toBe(plateauEndMs);
  });
});

describe("Ally #3040 suggestions", () => {
  afterEach(() => {
    __resetMetricsForTest();
  });

  it("keeps exactly one sampler alive across repeated starts", () => {
    const ticks: Array<() => void> = [];
    let cleared = 0;
    const handle = { unref() {} };
    const opts = {
      setInterval: ((fn: () => void) => {
        ticks.push(fn);
        return handle;
      }) as unknown as typeof setInterval,
      clearInterval: (() => {
        cleared += 1;
      }) as unknown as typeof clearInterval,
      residentSetSize: () => 1_000,
    };
    // createApp starts this on every app construction, and a suite builds many.
    startRssReleaseTracking(opts);
    startRssReleaseTracking(opts);
    // The first was stopped when the second started.
    expect(cleared).toBe(1);
    // Both handles exist, but only the live one still folds samples in: driving
    // both must not double the count the help text reads as a ~1.0/s rate.
    // Asserted as `1`, not `ticks.length`: `ticks.length` is also what a tick
    // that ignored `stop()` would produce, so it could not tell the two apart.
    expect(ticks).toHaveLength(2);
    for (const tick of ticks) tick();
    expect(readRssReleases()!.sampleCount).toBe(1);
  });

  it("publishes the bounds in force rather than the compiled-in defaults", async () => {
    startRssReleaseTracking({
      thresholdBytes: 8 * MIB,
      setInterval: ((fn: () => void) => {
        fn();
        return { unref() {} };
      }) as unknown as typeof setInterval,
      clearInterval: (() => {}) as unknown as typeof clearInterval,
      residentSetSize: () => 1_000,
    });
    setRssReleaseMetrics(readRssReleases());

    const { body } = await renderMetrics();
    const out: Record<string, number> = {};
    for (const line of body.split("\n")) {
      if (line.startsWith("#") || !line.startsWith(PROCESS_RSS_RELEASE_BOUND_BYTES_METRIC)) continue;
      const matched = /\{bound="([^"]*)"\}\s+(\S+)$/.exec(line);
      if (matched) out[matched[1]!] = Number(matched[2]);
    }
    expect(out.threshold).toBe(8 * MIB);
    expect(out.plateau_band).toBe(8 * MIB / PLATEAU_BAND_DIVISOR);
  });
});

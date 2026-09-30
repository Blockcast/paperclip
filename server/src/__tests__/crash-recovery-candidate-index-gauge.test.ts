import { afterEach, describe, expect, it } from "vitest";
import {
  CRASH_RECOVERY_CANDIDATE_INDEX_NAME,
  CRASH_RECOVERY_CANDIDATE_INDEX_PRESENT_METRIC,
  __resetMetricsForTest,
  renderMetrics,
  setCrashRecoveryCandidateIndexPresent,
} from "../services/metrics.js";

const SERIES = `${CRASH_RECOVERY_CANDIDATE_INDEX_PRESENT_METRIC}{index="${CRASH_RECOVERY_CANDIDATE_INDEX_NAME}"}`;

/**
 * BLO-21526. Migration 0226 records complete on a populated database without
 * building its deferred `CREATE INDEX CONCURRENTLY`, and every channel that
 * could have surfaced that was silent-on-healthy: the migration's own
 * `RAISE NOTICE` is swallowed by the production client, the deploy guard logs
 * only when it changes something, and the runtime probe's `logger.warn` is
 * latched to the absent transition. This gauge is the one channel that states
 * presence out loud, so the state it publishes is the deliverable — these
 * assertions are the regression guard for it.
 */
async function sampleOf(metric: string): Promise<string[]> {
  const rendered = await renderMetrics();
  return rendered.body
    .split("\n")
    .filter((line) => line.startsWith(metric) && !line.startsWith(`${metric}_`));
}

describe("crash-recovery candidate index gauge", () => {
  afterEach(() => {
    __resetMetricsForTest();
  });

  it("publishes 1 when the index is present", async () => {
    setCrashRecoveryCandidateIndexPresent(true);

    expect(await sampleOf(CRASH_RECOVERY_CANDIDATE_INDEX_PRESENT_METRIC)).toEqual([`${SERIES} 1`]);
  });

  it("publishes 0 when the index is absent or invalid", async () => {
    setCrashRecoveryCandidateIndexPresent(false);

    expect(await sampleOf(CRASH_RECOVERY_CANDIDATE_INDEX_PRESENT_METRIC)).toEqual([`${SERIES} 0`]);
  });

  // The tier hazard. `ensureRegistry` runs on the API tier too, which never
  // runs the probe. prom-client auto-publishes a bare zero-label Gauge at 0 on
  // construction, so an unlabeled version of this metric would report "index
  // missing" from every API pod forever and page permanently regardless of the
  // truth. A labeled Gauge renders nothing until something observes the
  // catalog.
  it("renders no series before any probe has run", async () => {
    expect(await sampleOf(CRASH_RECOVERY_CANDIDATE_INDEX_PRESENT_METRIC)).toEqual([]);
  });

  // The load-bearing case. A failed catalog probe means "we could not tell",
  // which is neither 0 (that would claim the index is gone and page on a
  // healthy database) nor a retained 1 (that would claim health on no
  // information — exactly the silent-on-healthy defect this metric ends).
  it("clears the series when the probe itself fails, rather than reporting 0", async () => {
    setCrashRecoveryCandidateIndexPresent(null);

    expect(await sampleOf(CRASH_RECOVERY_CANDIDATE_INDEX_PRESENT_METRIC)).toEqual([]);
  });

  it("does not leave a stale 1 behind when the probe starts failing", async () => {
    setCrashRecoveryCandidateIndexPresent(true);
    setCrashRecoveryCandidateIndexPresent(null);

    expect(await sampleOf(CRASH_RECOVERY_CANDIDATE_INDEX_PRESENT_METRIC)).toEqual([]);
  });

  it("recovers in both directions across ticks", async () => {
    setCrashRecoveryCandidateIndexPresent(false);
    setCrashRecoveryCandidateIndexPresent(true);

    expect(await sampleOf(CRASH_RECOVERY_CANDIDATE_INDEX_PRESENT_METRIC)).toEqual([`${SERIES} 1`]);
  });
});

/**
 * PEN-5385 — whether the `issues.last_activity_at` drift repair has RUN must be
 * answerable by query.
 *
 * The repair (BLO-51379) reports its outcome exactly once, as a log line, at
 * scheduler-lease acquisition. On a leader that has held the lease for a day
 * that line sits at the HEAD of the log, and every read surface an agent seat
 * has is a tail: confirming a single pass on 2026-11-02 took a Loki head query
 * against a 25h-old pod, and PEN-5385 was opened only because nobody on the
 * PEN-5213 thread could perform that read. Same shape, and same remedy, as
 * PEN-3365's inherited-timeout gauge.
 *
 * The load-bearing assertion is the encoding of `repaired`. PEN-5213 made
 * `issues.last_activity_at` the ORDER BY definition for the issues list, so a
 * drifted column is a mis-ordered list. The guard is idempotent and the column
 * monotone, which means a pass's repaired count IS the number of rows that were
 * drifted when it began — so `repaired == 0` on a completed pass is the
 * standing proof the list is ordered correctly, and it is the one reading a
 * caller must not be able to obtain by accident.
 *
 * Hence the pre-pass test. prom-client renders an unlabelled gauge from
 * construction, so a process that has NEVER run a pass — the permanent and
 * expected state of a non-lease-holding worker, since the repair is a
 * scheduler-lease singleton — still exposes `repaired 0`. That zero is
 * indistinguishable from a real all-clear on its own. The completion timestamp
 * is what separates them, and it is only meaningful because it is 0 (epoch)
 * until a pass finishes, so a staleness bound on it fails CLOSED. Pinning both
 * readings here is what stops a future alert being written against `repaired`
 * alone.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  ISSUES_LAST_ACTIVITY_DRIFT_REPAIR_LAST_COMPLETION_METRIC,
  ISSUES_LAST_ACTIVITY_DRIFT_REPAIR_LAST_FAILED_BATCHES_METRIC,
  ISSUES_LAST_ACTIVITY_DRIFT_REPAIR_LAST_REPAIRED_METRIC,
  __resetMetricsForTest,
  recordIssuesLastActivityDriftRepairPass,
  renderMetrics,
} from "../services/metrics.js";

afterEach(() => {
  __resetMetricsForTest();
});

/** Read an unlabelled gauge's value out of the exposition text. */
async function gauge(metric: string): Promise<number | undefined> {
  const { body } = await renderMetrics();
  const line = body.split("\n").find((l) => l.startsWith(`${metric} `));
  return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(" ") + 1));
}

describe("issues.last_activity_at drift repair pass metrics", () => {
  // The names are asserted literally for the same reason PEN-3365 asserts its
  // own: the name is what lands in PromQL, where no doc comment is read.
  it("publishes the three series under their documented names", () => {
    expect(ISSUES_LAST_ACTIVITY_DRIFT_REPAIR_LAST_COMPLETION_METRIC).toBe(
      "paperclip_issues_last_activity_drift_repair_last_completion_timestamp_seconds",
    );
    expect(ISSUES_LAST_ACTIVITY_DRIFT_REPAIR_LAST_REPAIRED_METRIC).toBe(
      "paperclip_issues_last_activity_drift_repair_last_repaired_rows",
    );
    expect(ISSUES_LAST_ACTIVITY_DRIFT_REPAIR_LAST_FAILED_BATCHES_METRIC).toBe(
      "paperclip_issues_last_activity_drift_repair_last_failed_batches",
    );
  });

  it("reads 0 everywhere before any pass completes, so `repaired` alone cannot be read as an all-clear", async () => {
    expect(await gauge(ISSUES_LAST_ACTIVITY_DRIFT_REPAIR_LAST_REPAIRED_METRIC)).toBe(0);
    // Epoch, not absent: a `time() - <series> > N` bound therefore fires on a
    // process that has never run a pass instead of silently passing.
    expect(await gauge(ISSUES_LAST_ACTIVITY_DRIFT_REPAIR_LAST_COMPLETION_METRIC)).toBe(0);
    expect(await gauge(ISSUES_LAST_ACTIVITY_DRIFT_REPAIR_LAST_FAILED_BATCHES_METRIC)).toBe(0);
  });

  it("publishes a completed pass's repaired count, failed batches and completion time", async () => {
    const before = Date.now() / 1000;
    // The real 2026-11-02T09:42:47Z pass, as read from paperclip-1.
    recordIssuesLastActivityDriftRepairPass({ repaired: 33521, failedBatches: 0 });

    expect(await gauge(ISSUES_LAST_ACTIVITY_DRIFT_REPAIR_LAST_REPAIRED_METRIC)).toBe(33521);
    expect(await gauge(ISSUES_LAST_ACTIVITY_DRIFT_REPAIR_LAST_FAILED_BATCHES_METRIC)).toBe(0);
    const at = await gauge(ISSUES_LAST_ACTIVITY_DRIFT_REPAIR_LAST_COMPLETION_METRIC);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now() / 1000);
  });

  it("lets a later pass reading 0 stand as proof the ordering column is not drifting", async () => {
    recordIssuesLastActivityDriftRepairPass({ repaired: 33521, failedBatches: 0 });
    const firstAt = (await gauge(ISSUES_LAST_ACTIVITY_DRIFT_REPAIR_LAST_COMPLETION_METRIC))!;

    recordIssuesLastActivityDriftRepairPass({ repaired: 0, failedBatches: 0 });

    // Last-pass values, not counters: the second pass REPLACES the first.
    expect(await gauge(ISSUES_LAST_ACTIVITY_DRIFT_REPAIR_LAST_REPAIRED_METRIC)).toBe(0);
    expect(
      (await gauge(ISSUES_LAST_ACTIVITY_DRIFT_REPAIR_LAST_COMPLETION_METRIC))!,
    ).toBeGreaterThanOrEqual(firstAt);
  });

  it("keeps a partial pass's skipped batches visible beside its repaired count", async () => {
    // failedBatches > 0 means the pass completed but did not cover every issue,
    // so its repaired count is a lower bound and a 0 beside it is NOT an
    // all-clear. The two have to be readable together or that distinction is
    // lost at alert-authoring time.
    recordIssuesLastActivityDriftRepairPass({ repaired: 0, failedBatches: 7 });

    expect(await gauge(ISSUES_LAST_ACTIVITY_DRIFT_REPAIR_LAST_REPAIRED_METRIC)).toBe(0);
    expect(await gauge(ISSUES_LAST_ACTIVITY_DRIFT_REPAIR_LAST_FAILED_BATCHES_METRIC)).toBe(7);
  });
});

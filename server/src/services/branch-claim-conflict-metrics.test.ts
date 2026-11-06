import { describe, expect, it, beforeEach } from "vitest";

import {
  BRANCH_CLAIM_CONFLICT_DEFERRALS_METRIC,
  BRANCH_CLAIM_CONFLICT_DEFERRAL_ATTEMPT_METRIC,
  K8S_ISOLATION_CONFLICT_DEFERRALS_METRIC,
  __resetMetricsForTest,
  recordBranchClaimConflictDeferral,
  recordK8sIsolationConflictDeferral,
  renderMetrics,
} from "./metrics.js";

/**
 * PEN-5310: `deferRunForBranchClaimConflict` is the second writer of
 * `heartbeat_runs.queued_at` and had no measurand at all. It is a structural
 * twin of the isolation defer -- same `status = running` guard, same re-queue
 * nulling `startedAt`, same `queuedAt: now` re-stamp, same backoff ladder --
 * but keyed on `paperclipBranchClaimRetry*`, so a census probing the isolation
 * context keys reads 0 and the PEN-5684 counter cannot see these cycles
 * either. These cases pin the two properties that make the new series usable:
 * it counts rolled-back cycles, and it is a sibling of the isolation counter
 * rather than a replacement for it.
 */
describe("branch-claim conflict deferral metrics (PEN-5310)", () => {
  beforeEach(() => {
    __resetMetricsForTest();
  });

  it("counts one rolled-back cycle per call", async () => {
    recordBranchClaimConflictDeferral({ retryAttempt: 1 });
    recordBranchClaimConflictDeferral({ retryAttempt: 2 });

    const body = (await renderMetrics()).body;
    expect(body).toContain(`${BRANCH_CLAIM_CONFLICT_DEFERRALS_METRIC} 2`);
  });

  it("stays a sibling of the isolation counter, so neither absorbs the other", async () => {
    // The whole defect this series exists for: reading one total and calling it
    // "the thrash" understates it by however much the other path contributes.
    recordBranchClaimConflictDeferral({ retryAttempt: 1 });
    recordK8sIsolationConflictDeferral({
      isolationKey: "workspace-tree:project-primary:9f258778-c10f-4bb7-a58f-1e4f72ab81f0",
      cause: "active_writer",
      retryAttempt: 1,
    });

    const body = (await renderMetrics()).body;
    expect(body).toContain(`${BRANCH_CLAIM_CONFLICT_DEFERRALS_METRIC} 1`);
    expect(body).toContain(
      `${K8S_ISOLATION_CONFLICT_DEFERRALS_METRIC}{key_shape="workspace-tree:project-primary",cause="active_writer"} 1`,
    );
  });

  it("observes attempt depth, so a saturated ladder is distinguishable from fresh conflicts", async () => {
    // Same ladder as the isolation twin (`computeK8sIsolationRetryDelayMs`,
    // saturating at 300 s by attempt 6), so the buckets match and a deep tail
    // means one run re-stamping `queuedAt` every 5 minutes indefinitely.
    recordBranchClaimConflictDeferral({ retryAttempt: 1 });
    recordBranchClaimConflictDeferral({ retryAttempt: 48 });

    const body = (await renderMetrics()).body;
    expect(body).toContain(`${BRANCH_CLAIM_CONFLICT_DEFERRAL_ATTEMPT_METRIC}_bucket{le="1"} 1`);
    // The measured 2026-11-02 tail must land inside a finite bucket, not +Inf.
    expect(body).toContain(`${BRANCH_CLAIM_CONFLICT_DEFERRAL_ATTEMPT_METRIC}_bucket{le="55"} 2`);
    expect(body).toContain(`${BRANCH_CLAIM_CONFLICT_DEFERRAL_ATTEMPT_METRIC}_count 2`);
  });

  it("floors a non-finite or sub-1 attempt rather than poisoning the histogram sum", async () => {
    recordBranchClaimConflictDeferral({ retryAttempt: Number.NaN });
    recordBranchClaimConflictDeferral({ retryAttempt: 0 });

    const body = (await renderMetrics()).body;
    expect(body).toContain(`${BRANCH_CLAIM_CONFLICT_DEFERRAL_ATTEMPT_METRIC}_sum 2`);
  });
});

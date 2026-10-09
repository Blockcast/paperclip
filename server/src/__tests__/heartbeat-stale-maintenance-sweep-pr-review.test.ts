/**
 * BLO-35488: the stale-maintenance sweep cancelled queued pr_review transient
 * retries as "stale non-issue maintenance wake backlog". Nothing re-creates a
 * pr_review wake (the GitHub webhook fires once), so the review was lost.
 */
import { describe, expect, it } from "vitest";
import { isStaleMaintenanceSweepCandidate } from "../services/heartbeat.js";

describe("isStaleMaintenanceSweepCandidate", () => {
  it("sweeps non-issue maintenance wakes", () => {
    expect(isStaleMaintenanceSweepCandidate({ wakeReason: "heartbeat_timer" })).toBe(true);
    expect(isStaleMaintenanceSweepCandidate({ wakeReason: "transient_failure_retry" })).toBe(true);
    expect(isStaleMaintenanceSweepCandidate({ wakeReason: "provider_quota_exhausted_recovered" })).toBe(true);
  });

  it("never sweeps a pr_review retry, by taskKey or reviewKind", () => {
    expect(
      isStaleMaintenanceSweepCandidate({
        wakeReason: "transient_failure_retry",
        taskKey: "pr_review:Blockcast/linux-amt:269",
      }),
    ).toBe(false);
    expect(
      isStaleMaintenanceSweepCandidate({ wakeReason: "transient_failure_retry", reviewKind: "pr_review" }),
    ).toBe(false);
    // Literal prefix, not a LIKE pattern: the SQL pre-filter escapes `_` to match.
    expect(
      isStaleMaintenanceSweepCandidate({ wakeReason: "transient_failure_retry", taskKey: "prXreview:Blockcast/x:1" }),
    ).toBe(true);
  });

  it("keeps issue-bound and non-maintenance wakes out of the sweep", () => {
    expect(isStaleMaintenanceSweepCandidate({ wakeReason: "heartbeat_timer", issueId: "i-1" })).toBe(false);
    expect(isStaleMaintenanceSweepCandidate({ wakeReason: "heartbeat_timer", taskId: "t-1" })).toBe(false);
    expect(isStaleMaintenanceSweepCandidate({ wakeReason: "github_pr_review_requested" })).toBe(false);
    expect(isStaleMaintenanceSweepCandidate({})).toBe(false);
  });
});

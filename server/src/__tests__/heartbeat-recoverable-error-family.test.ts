// BLO-28924 — every error code `finalizeAgentStatus` calls "recoverable" must
// actually be recoverable.
//
// Raised by Ally as an Important finding on paperclip#1407. Two lists had drifted
// apart:
//
//   finalizeAgentStatus       keys "keep the agent idle + fire the quota hook"
//                             on the run's errorCODE.
//   shouldScheduleAutomaticRunRetry
//                             keys "schedule a retry that resumes the work"
//                             on the run's errorFAMILY, via
//                             readHeartbeatRunErrorFamily.
//
// `provider_quota_exhausted` was in the first list and absent from the second, so
// a run carrying it was parked `idle` with nothing scheduled to resume it — and,
// since #1407 stopped re-waking an agent whose debounced quota hook failed, no
// recovery wake either. An agent with a heartbeat interval limps to its next
// timer tick; an interval-less, event-driven agent never recovers at all.
//
// The code is emitted by the first-party `claude-local` adapter
// (packages/adapters/claude-local/src/server/execute.ts), which also extracts a
// provider-supplied `retryNotBefore` — so the emit side was already complete and
// only the family mapping was missing.
//
// The set-wide invariant below is the regression guard: it iterates
// RECOVERABLE_AGENT_STATUS_ERROR_CODES rather than a hand-copied list, so adding
// a fourth recoverable code without a matching family arm fails CI instead of
// silently re-opening this gap.
import { describe, expect, it } from "vitest";
import { ROUTE_TO_ORIGINAL_INFRA_ERROR_CODES } from "../services/recovery/zero-token-startup-failure.js";
import {
  RECOVERABLE_AGENT_STATUS_ERROR_CODES,
  readHeartbeatRunErrorFamily,
  readTransientRecoveryContractFromRun,
  shouldScheduleAutomaticRunRetry,
} from "../services/heartbeat.js";

describe("BLO-28924: recoverable error codes resolve to a retry family", () => {
  it("maps provider_quota_exhausted to the provider_quota family", () => {
    expect(
      readHeartbeatRunErrorFamily({
        errorCode: "provider_quota_exhausted",
        resultJson: null,
      }),
    ).toBe("provider_quota");
  });

  // The whole point of the fix: absent a persisted errorFamily, a run finalized
  // with this code must still yield a transient-recovery contract, because that
  // contract is what shouldScheduleAutomaticRunRetry gates the retry on.
  it("yields a transient recovery contract with no persisted errorFamily", () => {
    const run = { errorCode: "provider_quota_exhausted", resultJson: null };

    const contract = readTransientRecoveryContractFromRun(run);

    expect(contract).not.toBeNull();
    expect(contract?.errorFamily).toBe("provider_quota");
    expect(
      shouldScheduleAutomaticRunRetry({ ...run, contextSnapshot: null }),
    ).toBe(true);
  });

  // claude-local populates retryNotBefore from the provider's own reset instant.
  // provider_quota is deliberately excluded from clampTransientHorizon, so that
  // floor must survive onto the contract verbatim rather than being clamped to a
  // per-attempt capacity ceiling.
  it("carries the adapter-supplied retryNotBefore onto the contract", () => {
    const retryNotBefore = "2026-08-19T18:30:00.000Z";

    const contract = readTransientRecoveryContractFromRun({
      errorCode: "provider_quota_exhausted",
      resultJson: { retryNotBefore },
    });

    expect(contract?.errorFamily).toBe("provider_quota");
    expect(contract?.retryNotBefore?.toISOString()).toBe(retryNotBefore);
  });

  // A persisted family is authoritative and must keep winning over the
  // errorCode fallback — the new arm is a fallback, not an override.
  it("still prefers a persisted errorFamily over the errorCode fallback", () => {
    expect(
      readHeartbeatRunErrorFamily({
        errorCode: "provider_quota_exhausted",
        resultJson: { errorFamily: "rate_limit_exhausted" },
      }),
    ).toBe("rate_limit_exhausted");
  });

  // THE INVARIANT. Iterates the exported set so the two lists cannot drift
  // again: a code added to RECOVERABLE_AGENT_STATUS_ERROR_CODES without a
  // family arm fails here. Fails on the parent commit, where
  // provider_quota_exhausted resolves to null.
  it.each([...RECOVERABLE_AGENT_STATUS_ERROR_CODES])(
    "recoverable code %s resolves to a non-null family and schedules a retry",
    (errorCode) => {
      const run = { errorCode, resultJson: null };

      expect(readHeartbeatRunErrorFamily(run)).not.toBeNull();
      expect(readTransientRecoveryContractFromRun(run)).not.toBeNull();
      expect(
        shouldScheduleAutomaticRunRetry({ ...run, contextSnapshot: null }),
      ).toBe(true);
    },
  );

  // Guards the inverse: the fix must not turn every unmapped code into a
  // retryable one. An unrelated hard failure stays terminal.
  it("leaves an unrelated non-recoverable code unmapped", () => {
    expect(
      readHeartbeatRunErrorFamily({ errorCode: "adapter_failed", resultJson: null }),
    ).toBeNull();
    expect(
      readTransientRecoveryContractFromRun({ errorCode: "adapter_failed", resultJson: null }),
    ).toBeNull();
  });
});

// PEN-2462 — the same drift shape, one code over.
//
// `provider_throttled_no_progress` and `rate_limit_exhausted` are written from
// the same two booleans in the same statement in `finalizeAgentStatus`, and
// both are tagged `errorFamily: "rate_limit_exhausted"` there. But only
// `rate_limit_exhausted` appeared in the errorCode fallback ladder in
// `readHeartbeatRunErrorFamily`, so its twin was load-bearing on a single
// field with no second line of defence.
//
// Not a live bug: because the two fields are co-written, no row exists today
// with the code and without the tag, and the tag is consulted first. This is a
// backstop for a row written by a future path that sets the code alone, or one
// whose `resultJson` is dropped downstream. The tests below are written with
// `resultJson: null` precisely because that is the only state that
// discriminates — with the tag present, both codes already pass.
describe("PEN-2462: provider_throttled_no_progress resolves from errorCode alone", () => {
  it("maps to the rate_limit_exhausted family with no persisted errorFamily", () => {
    expect(
      readHeartbeatRunErrorFamily({
        errorCode: "provider_throttled_no_progress",
        resultJson: null,
      }),
    ).toBe("rate_limit_exhausted");
  });

  // The family is what selects the retry curve, so the fallback is only worth
  // anything if it carries through to a contract and a scheduled retry.
  it("yields a rate-limit recovery contract and schedules a retry", () => {
    const run = { errorCode: "provider_throttled_no_progress", resultJson: null };

    expect(readTransientRecoveryContractFromRun(run)?.errorFamily).toBe(
      "rate_limit_exhausted",
    );
    expect(
      shouldScheduleAutomaticRunRetry({ ...run, contextSnapshot: null }),
    ).toBe(true);
  });

  // The asymmetry this closes: both codes are interchangeable at the point of
  // write, so they must be interchangeable at the point of read.
  it("resolves identically to its twin", () => {
    expect(
      readHeartbeatRunErrorFamily({
        errorCode: "provider_throttled_no_progress",
        resultJson: null,
      }),
    ).toBe(
      readHeartbeatRunErrorFamily({
        errorCode: "rate_limit_exhausted",
        resultJson: null,
      }),
    );
  });

  // A persisted tag still wins; this arm is a fallback, not an override.
  it("still prefers a persisted errorFamily", () => {
    expect(
      readHeartbeatRunErrorFamily({
        errorCode: "provider_throttled_no_progress",
        resultJson: { errorFamily: "transient_upstream" },
      }),
    ).toBe("transient_upstream");
  });
});

// BLO-35668 — the same drift as BLO-28924 above, one engine over.
//
// `skill_materialization_pending` (BLO-32055, #1669) replaced `adapter_failed` at
// the claude-k8s emit site. The PR argued retryability was "preserved exactly"
// because the new code joined TRANSIENT_INFRA_CONTINUATION_ERROR_CODES, and
// recovery-classifiers.test.ts asserts that parity — in the issue CONTINUATION
// sweep. That sweep is issue-scoped. A pr_review run is not an issue run, so
// `shouldScheduleAutomaticRunRetry` is its ONLY retry path, and there
// `adapter_failed` is admitted by a literal that the rename did not update.
//
// Net effect measured 2026-10-01 over 18h of Ally runs: 13 failures, 0 retries,
// against 24 `transient_failure_retry` runs for its sibling codes in the same
// window. The PR under-specified its own claim and the test followed it, so the
// parity below is asserted in BOTH engines deliberately — classification in one
// is not enrolment in the other.
describe("BLO-35668: skill_materialization_pending retries wherever adapter_failed does", () => {
  const prReview = { reviewKind: "pr_review" };

  it("schedules a retry for a pr_review run", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "skill_materialization_pending",
        resultJson: null,
        contextSnapshot: prReview,
      }),
    ).toBe(true);
  });

  // The actual invariant the #1669 comment asserts. Written as a comparison
  // rather than a literal `true` so it keeps holding if `adapter_failed`'s own
  // gating is ever narrowed — the two must move together or not at all.
  it.each([
    ["pr_review context", prReview],
    ["issue context", { issueId: "issue-a" }],
    ["neither", {}],
  ] as const)("matches adapter_failed exactly (%s)", (_label, contextSnapshot) => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "skill_materialization_pending",
        resultJson: null,
        contextSnapshot,
      }),
    ).toBe(
      shouldScheduleAutomaticRunRetry({
        errorCode: "adapter_failed",
        resultJson: null,
        contextSnapshot,
      }),
    );
  });

  // Negative control. `skill_not_found` is the non-catalog-backed half of the
  // same adapter ternary and is a permanent configuration fault; if the fix above
  // had been written as "any skill_* code retries", this is what it would break.
  it("does not extend to the permanent skill_not_found", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "skill_not_found",
        resultJson: null,
        contextSnapshot: prReview,
      }),
    ).toBe(false);
  });

  // The THIRD enrolment site of the same rename, raised by Ally as an Important
  // finding on #2159. This one is routing, not retry: ROUTE_TO_ORIGINAL_INFRA_ERROR_CODES
  // decides owner-vs-manager for a `stranded_assigned_issue`, and the routing
  // union's other arm (`isInfraClassStrandedFailure`) is scoped to
  // `k8s_job_deleted_externally`, git transport, and `claude_truncated` +
  // pod-removal wording — a ClaudeSkillSourceUnavailableError matches none. So
  // the miss handed an assignee's issue UP the manager ladder for a
  // materialization race they had no part in: the BLO-20933 hazard that set
  // exists to prevent.
  //
  // By comparison rather than a literal `true`, for the same reason as above: if
  // `adapter_failed` is ever removed from that set, this code should follow it
  // out rather than fail.
  //
  // NOT folded into one set shared with the retry gate (Ally's suggestion 2).
  // The two are different populations, not one drifted list:
  // `shouldScheduleAutomaticRunRetry` also admits `session_unavailable` and
  // `process_lost`, and neither belongs in the routing set — BLO-27463's scope
  // note above it deliberately keeps routing and the attempt budget separate,
  // and merging them would widen routing onto codes it argued out. The invariant
  // that actually holds is the narrower one asserted here and above: these two
  // codes name ONE fault at ONE emit site, so they move together.
  it("is routed infra-class wherever adapter_failed is", () => {
    expect(ROUTE_TO_ORIGINAL_INFRA_ERROR_CODES.has("skill_materialization_pending")).toBe(
      ROUTE_TO_ORIGINAL_INFRA_ERROR_CODES.has("adapter_failed"),
    );
  });
});

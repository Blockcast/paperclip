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

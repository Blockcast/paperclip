// PEN-3129 containment. The fix records the pod's own provider verdict on a
// `job_failed` run. The tempting shape — writing `resultJson.errorFamily =
// "rate_limit_exhausted"`, which the whole capacity-aware ecosystem already
// reads — would have been a silent authorization bug, and these pin the reason
// it was not taken.
//
// `shouldScheduleAutomaticRunRetry` consults the transient recovery contract
// (i.e. `readHeartbeatRunErrorFamily`) at a line that sits ABOVE its
// `job_failed` branch and returns `true` unconditionally. A `job_failed` run
// that gained a top-level `errorFamily` would therefore retry without the
// `adapterInvocationStarted === false` proof that branch demands — the proof
// that exists because "a failed external-lifecycle Job may have performed
// non-idempotent work" (shared git workspace, posted comments, pushed commits).
// The stale-kill branch above carries an explicit guard comment about exactly
// this ordering; `job_failed` has no such protection, so containment is the
// nesting and the field name, and that is what is asserted here.
import { describe, expect, it } from "vitest";
import {
  readHeartbeatRunErrorFamily,
  readTransientRecoveryContractFromRun,
  shouldScheduleAutomaticRunRetry,
} from "../services/heartbeat.js";

/** What the reconciler now writes for a 429-terminated pod. */
const POD_TERMINAL_VERDICT = {
  apiErrorStatus: 429,
  subtype: "error_during_execution",
  isError: true,
  terminalReason: "api_error",
  providerFamily: "rate_limit_exhausted",
} as const;

function jobFailedRun(overrides?: { adapterInvocationStarted?: boolean }) {
  return {
    errorCode: "job_failed",
    error: "External lifecycle Job failed: BackoffLimitExceeded: Job has reached the specified backoff limit",
    contextSnapshot: { issueId: "issue-1" },
    resultJson: {
      externalLifecycleRecovery: {
        reason: "job_failed",
        jobPhase: "failed",
        jobReason: "BackoffLimitExceeded",
        podTerminalVerdict: POD_TERMINAL_VERDICT,
        ...(overrides?.adapterInvocationStarted !== undefined
          ? { adapterInvocationStarted: overrides.adapterInvocationStarted }
          : {}),
      },
    },
  } as unknown as Parameters<typeof shouldScheduleAutomaticRunRetry>[0];
}

describe("PEN-3129 — the pod terminal verdict is a dimension, not a retry signal", () => {
  it("does not become the run's errorFamily", () => {
    // The nesting IS the containment: `readHeartbeatRunErrorFamily` reads
    // `resultJson.errorFamily` at the top level only.
    expect(readHeartbeatRunErrorFamily(jobFailedRun())).toBeNull();
  });

  it("does not manufacture a transient recovery contract", () => {
    expect(readTransientRecoveryContractFromRun(jobFailedRun())).toBeNull();
  });

  it("leaves the adapter-invocation evidence gate as the only thing that admits a retry", () => {
    // Unproven and proven-started both stay refused; only the durable proof
    // that the adapter never ran admits the retry — exactly as before the
    // verdict existed.
    expect(shouldScheduleAutomaticRunRetry(jobFailedRun())).toBe(false);
    expect(
      shouldScheduleAutomaticRunRetry(jobFailedRun({ adapterInvocationStarted: true })),
    ).toBe(false);
    expect(
      shouldScheduleAutomaticRunRetry(jobFailedRun({ adapterInvocationStarted: false })),
    ).toBe(true);
  });

  it("admits exactly what it admitted before the verdict was added", () => {
    // Differential: same rows, verdict stripped. Any divergence here means the
    // dimension changed an admission decision somewhere.
    const withVerdict = [undefined, true, false] as const;
    for (const adapterInvocationStarted of withVerdict) {
      const run = jobFailedRun(
        adapterInvocationStarted === undefined ? undefined : { adapterInvocationStarted },
      ) as unknown as { resultJson: { externalLifecycleRecovery: Record<string, unknown> } };
      const stripped = JSON.parse(JSON.stringify(run)) as typeof run;
      delete stripped.resultJson.externalLifecycleRecovery.podTerminalVerdict;
      expect(
        shouldScheduleAutomaticRunRetry(run as unknown as Parameters<typeof shouldScheduleAutomaticRunRetry>[0]),
      ).toBe(
        shouldScheduleAutomaticRunRetry(
          stripped as unknown as Parameters<typeof shouldScheduleAutomaticRunRetry>[0],
        ),
      );
    }
  });

  it("still yields the family when the run genuinely finalized as a capacity failure", () => {
    // The containment must not be a blanket suppression: a run that really did
    // record a top-level errorFamily keeps its contract.
    expect(
      readHeartbeatRunErrorFamily({
        errorCode: "rate_limit_exhausted",
        resultJson: { errorFamily: "rate_limit_exhausted" },
      } as unknown as Parameters<typeof readHeartbeatRunErrorFamily>[0]),
    ).toBe("rate_limit_exhausted");
  });
});

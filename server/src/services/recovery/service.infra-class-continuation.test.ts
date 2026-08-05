import { describe, expect, it } from "vitest";
import { classifyContinuationFailure } from "./service.js";

// Infra-class run failures must not spend the stranded-recovery budget or bounce
// the issue up the org chain.
//
// Why classifyContinuationFailure is the right unit under test: its `maxAttempts` is
// the sole gate on the escalation in reconcileStrandedAssignedIssues
// (service.ts, the `consecutive >= classification.maxAttempts` branch). That branch
// is the ONLY caller of escalateStrandedAssignedIssue on the continuation path, and
// escalateStrandedAssignedIssue is what does BOTH things this ticket is about:
//   - ensureSourceScopedStrandedRecoveryAction(...) -> attemptCount + 1
//   - issuesSvc.update(..., { status: "blocked", assigneeAgentId: action.ownerAgentId })
// So `kind: "default"` (maxAttempts 1) means "escalate + reassign on the 2nd
// consecutive failure"; `kind: "transient_infra"` (maxAttempts 3) means "keep
// re-dispatching with backoff, spend nothing, reassign nobody".

type Run = Parameters<typeof classifyContinuationFailure>[0];

const run = (errorCode: string | null) => ({ errorCode } as unknown as Run);

const jobMissingRun = (adapterInvocationStarted: unknown) =>
  ({
    errorCode: "job_missing",
    resultJson: { externalLifecycleRecovery: { adapterInvocationStarted } },
  } as unknown as Run);

describe("BLO-18106: job_missing continuation recovery is evidence-gated", () => {
  it("work-class control: an ordinary run failure still escalates on the next attempt", () => {
    // The paired assertion the AC asks for. A work-class failure keeps the old
    // behavior -- one attempt, then escalateStrandedAssignedIssue (attempt burn +
    // reassignment). If this ever flips to transient_infra, the change above has
    // over-reached and genuinely stuck work would silently retry forever.
    const workClass = classifyContinuationFailure(run("some_adapter_error"));
    expect(workClass.kind).toBe("default");
    expect(workClass.maxAttempts).toBe(1);

    // k8s_pod_schedule_failed can be emitted after the main container starts, so
    // it must not be replayed without stronger producer evidence.
    expect(classifyContinuationFailure(run("k8s_pod_schedule_failed"))).toMatchObject({
      kind: "default",
      maxAttempts: workClass.maxAttempts,
    });
  });

  it("non-retryable codes are unaffected by the infra-class widening", () => {
    expect(classifyContinuationFailure(run("agent_not_invokable")).kind).toBe("non_retryable");
    expect(classifyContinuationFailure(run("budget_blocked")).kind).toBe("non_retryable");
  });

  describe("job_missing is evidence-gated, not unconditionally infra-class", () => {
    it("re-dispatches only when the reconciler proved the adapter never started", () => {
      const c = classifyContinuationFailure(jobMissingRun(false));
      expect(c.kind).toBe("transient_infra");
      expect(c.maxAttempts).toBeGreaterThan(1);
    });

    it("does NOT re-dispatch when the adapter had already been invoked", () => {
      // BLO-18106: the external lifecycle Job can vanish *after* a non-idempotent
      // side effect. Re-running would duplicate that work, so this must stay on the
      // escalate path even though the error code looks infra-shaped.
      expect(classifyContinuationFailure(jobMissingRun(true)).kind).toBe("default");
    });

    it("fails safe when the invocation evidence is missing or not a boolean", () => {
      expect(classifyContinuationFailure(jobMissingRun(undefined)).kind).toBe("default");
      expect(classifyContinuationFailure(jobMissingRun("false")).kind).toBe("default");
      expect(classifyContinuationFailure(run("job_missing")).kind).toBe("default");
    });
  });
});

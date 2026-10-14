import { describe, expect, it } from "vitest";
import { classifyRunLiveness } from "../services/run-liveness.js";

const baseInput = {
  runStatus: "succeeded",
  issue: {
    status: "in_progress",
    title: "Implement feature",
    description: "Add the requested behavior.",
  },
  resultJson: null,
  stdoutExcerpt: null,
  stderrExcerpt: null,
  error: null,
  errorCode: null,
  continuationAttempt: 0,
  evidence: null,
};

describe("run liveness classifier", () => {
  it("classifies text-only future work as plan_only", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "I will inspect the repo next and then implement the fix.",
      },
    });

    expect(classification.livenessState).toBe("plan_only");
    expect(classification.actionability).toBe("runnable");
    expect(classification.nextAction).toContain("inspect the repo");
  });

  it("classifies empty successful output as empty_response", () => {
    const classification = classifyRunLiveness(baseInput);

    expect(classification.livenessState).toBe("empty_response");
    expect(classification.actionability).toBe("unknown");
  });

  it("treats issue comments, documents, products, and actions as progress", () => {
    const latestEvidenceAt = new Date("2026-04-18T12:00:00Z");
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Updated implementation.",
      },
      evidence: {
        issueCommentsCreated: 1,
        documentRevisionsCreated: 1,
        workProductsCreated: 1,
        toolOrActionEventsCreated: 1,
        latestEvidenceAt,
      },
    });

    expect(classification.livenessState).toBe("advanced");
    expect(classification.lastUsefulActionAt).toBe(latestEvidenceAt);
  });

  it("does not treat workspace operations alone as concrete progress", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "I will inspect the repo next.",
      },
      evidence: {
        workspaceOperationsCreated: 1,
        latestEvidenceAt: new Date("2026-04-18T12:00:00Z"),
      },
    });

    expect(classification.livenessState).toBe("plan_only");
    expect(classification.lastUsefulActionAt).toBeNull();
  });

  it("exempts planning/document tasks from plan-only retry classification", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      issue: {
        status: "in_progress",
        title: "Draft implementation plan",
        description: "Create a plan for the work.",
      },
      resultJson: {
        summary: "Plan:\n- Inspect files\n- Implement after approval",
      },
    });

    expect(classification.livenessState).toBe("advanced");
  });

  it("exempts runs that update the plan document from plan-only classification", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Next steps:\n- inspect files\n- implement the service",
      },
      evidence: {
        documentRevisionsCreated: 1,
        planDocumentRevisionsCreated: 1,
        latestEvidenceAt: new Date("2026-04-18T12:00:00Z"),
      },
    });

    expect(classification.livenessState).toBe("advanced");
  });

  it("classifies done issues as completed", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      issue: {
        ...baseInput.issue,
        status: "done",
      },
      resultJson: {
        summary: "Finished the implementation.",
      },
    });

    expect(classification.livenessState).toBe("completed");
  });

  it("classifies declared blockers as blocked", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "I cannot proceed because I need access credentials.",
      },
    });

    expect(classification.livenessState).toBe("blocked");
    expect(classification.actionability).toBe("blocked_external");
  });

  it("treats PAP-2000-style validation output as runnable follow-up, not an external blocker", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "PAP-1949 remains blocked until PAP-2000 is resolved.",
      },
      issueCommentBodies: [
        [
          "Validation is ready for the next pass.",
          "",
          "- Blocked chain context: PAP-1949 -> PAP-1999 -> PAP-2000",
          "- Next action: run npm test and report the row counts.",
        ].join("\n"),
      ],
    });

    expect(classification.livenessState).toBe("plan_only");
    expect(classification.actionability).toBe("runnable");
    expect(classification.nextAction).toBe("run npm test and report the row counts.");
  });

  it("prefers durable comments over raw transcript next-action noise", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      issueCommentBodies: ["Next action: run pnpm test -- --runInBand."],
      stdoutExcerpt: [
        "tool_call: write",
        "command: rm -rf production-data",
        "Next action: deploy to production",
      ].join("\n"),
    });

    expect(classification.actionability).toBe("runnable");
    expect(classification.nextAction).toBe("run pnpm test -- --runInBand.");
  });

  it("keeps approval requests out of automatic continuation", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Next action: wait for board approval before continuing.",
      },
    });

    expect(classification.livenessState).toBe("blocked");
    expect(classification.actionability).toBe("approval_required");
    expect(classification.nextAction).toBe("wait for board approval before continuing.");
  });

  it("routes production-sensitive next actions to manager review", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Next action: deploy to production and verify live traffic.",
      },
    });

    expect(classification.livenessState).toBe("needs_followup");
    expect(classification.actionability).toBe("manager_review");
    expect(classification.nextAction).toBe("deploy to production and verify live traffic.");
  });


  it("uses killed background-task evidence instead of a generic failed-run reason", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      runStatus: "failed",
      errorCode: "process_lost",
      resultJson: {
        stopReason: "unmanaged_background_task_stopped",
        unmanagedBackgroundTask: {
          kind: "orphaned_process_group_cleanup",
          stopped: true,
          stopReason: "unmanaged_background_task_stopped",
          reason: "unmanaged background task stopped; no durable live path",
        },
      },
    });

    expect(classification.livenessState).toBe("failed");
    expect(classification.livenessReason).toBe("unmanaged background task stopped; no durable live path");
  });

  it("marks unclear useful output as unknown actionability", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      resultJson: {
        summary: "Observed mixed output and left notes for a later pass.",
      },
    });

    expect(classification.livenessState).toBe("needs_followup");
    expect(classification.actionability).toBe("unknown");
    expect(classification.nextAction).toBeNull();
  });

  // PEN-4035. The stamp used to be gated on `advanced | completed | blocked`,
  // so a run that died at the provider after writing a real issue comment
  // reported `lastUsefulActionAt: null` -- and because
  // classifyAndPersistRunLiveness writes the field unconditionally, that null
  // also overwrote the live stamp flushOutputProgress had already recorded.
  // Measured over n=1000 runs: 0/57 rate_limit_exhausted, 0/9 timed_out, 0/9
  // claude_transient_upstream and 0/7 acpx_turn_failed carried the stamp,
  // against 22/22 for cancelled, while 8 of 63 of those null rows had in fact
  // authored a durable comment.
  describe("lastUsefulActionAt is kept on abnormal termination (PEN-4035)", () => {
    const latestEvidenceAt = new Date("2026-10-12T09:15:00Z");
    const evidence = { issueCommentsCreated: 1, latestEvidenceAt };

    // The fault classes measured at a false 0%: every non-succeeded run status
    // lands on `failed`, so one case per distinct errorCode shape is enough to
    // cover all four.
    it.each([
      ["failed", "rate_limit_exhausted"],
      ["timed_out", "timed_out"],
      ["failed", "claude_transient_upstream"],
      ["failed", "acpx_turn_failed"],
    ])("retains the evidence stamp for runStatus=%s errorCode=%s", (runStatus, errorCode) => {
      const classification = classifyRunLiveness({ ...baseInput, runStatus, errorCode, evidence });

      expect(classification.livenessState).toBe("failed");
      expect(classification.lastUsefulActionAt).toBe(latestEvidenceAt);
    });

    it("retains the evidence stamp on the interrupted -> needs_followup arm", () => {
      const classification = classifyRunLiveness({
        ...baseInput,
        runStatus: "interrupted",
        errorCode: "external_wait_yield",
        evidence,
      });

      expect(classification.livenessState).toBe("needs_followup");
      expect(classification.lastUsefulActionAt).toBe(latestEvidenceAt);
    });

    it("retains the evidence stamp on the unmanaged-background-task failed arm", () => {
      const classification = classifyRunLiveness({
        ...baseInput,
        runStatus: "failed",
        errorCode: "process_lost",
        evidence,
        resultJson: {
          stopReason: "unmanaged_background_task_stopped",
          unmanagedBackgroundTask: {
            kind: "orphaned_process_group_cleanup",
            stopped: true,
            stopReason: "unmanaged_background_task_stopped",
            reason: "unmanaged background task stopped; no durable live path",
          },
        },
      });

      expect(classification.livenessState).toBe("failed");
      expect(classification.lastUsefulActionAt).toBe(latestEvidenceAt);
    });

    // The other half of the contract: the fix widens *what is kept*, it does
    // not invent a stamp. A failed run that genuinely produced nothing durable
    // must still read null, or the 0% artifact is merely replaced by a 100%
    // one. Workspace creation alone is explicitly not concrete evidence
    // (hasConcreteActionEvidence), so it is the sharpest negative case.
    it("still reports null for a failed run with no concrete evidence", () => {
      expect(
        classifyRunLiveness({ ...baseInput, runStatus: "failed", errorCode: "rate_limit_exhausted" })
          .lastUsefulActionAt,
      ).toBeNull();

      expect(
        classifyRunLiveness({
          ...baseInput,
          runStatus: "failed",
          errorCode: "rate_limit_exhausted",
          evidence: { workspaceOperationsCreated: 1, latestEvidenceAt },
        }).lastUsefulActionAt,
      ).toBeNull();
    });

    // Regression guard on the states that always kept the stamp, so a future
    // edit cannot restore the gate by inverting it.
    it("still retains the stamp for advanced/completed/blocked", () => {
      expect(
        classifyRunLiveness({
          ...baseInput,
          resultJson: { summary: "Updated implementation." },
          evidence,
        }).lastUsefulActionAt,
      ).toBe(latestEvidenceAt);

      expect(
        classifyRunLiveness({
          ...baseInput,
          issue: { ...baseInput.issue, status: "done" },
          evidence,
        }).lastUsefulActionAt,
      ).toBe(latestEvidenceAt);

      expect(
        classifyRunLiveness({
          ...baseInput,
          issue: { ...baseInput.issue, status: "blocked" },
          evidence,
        }).lastUsefulActionAt,
      ).toBe(latestEvidenceAt);
    });
  });
});

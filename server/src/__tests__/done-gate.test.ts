import { describe, expect, it } from "vitest";
import { shouldBlockNarratedDone } from "../services/done-gate.js";

describe("shouldBlockNarratedDone", () => {
  const base = {
    fromStatus: "in_progress",
    toStatus: "done" as string | undefined,
    existingCheckoutRunId: null as string | null,
    lastEvidenceVerdict: null as unknown,
    isAgentActor: true,
    hasDurableArtifactEvidence: false,
  };

  it("blocks an agent marking done with no execution run and no pr-link evidence", () => {
    expect(shouldBlockNarratedDone({ ...base, fromStatus: "todo" })).toBe(true);
  });

  it("allows done when the issue reached a real execution checkout", () => {
    expect(
      shouldBlockNarratedDone({ ...base, existingCheckoutRunId: "run-123" }),
    ).toBe(false);
  });

  it("allows done when prior evidence verdict found a pr-link", () => {
    expect(
      shouldBlockNarratedDone({
        ...base,
        fromStatus: "in_review",
        lastEvidenceVerdict: { verdict: "pass", evidenceFound: ["checklist:done-when", "pr-link"] },
      }),
    ).toBe(false);
  });

  it("allows QA-only closure when a refreshed evidence verdict found a PR link", () => {
    expect(
      shouldBlockNarratedDone({
        ...base,
        fromStatus: "blocked",
        lastEvidenceVerdict: { verdict: "warn", evidenceFound: ["checklist:done-when", "test-output", "pr-link"] },
      }),
    ).toBe(false);
  });

  it("allows done when a pr-link was detected but is not a required shape for this issue's labels (BLO-16325)", () => {
    // Mirrors the real evidence-gate.ts shape: `evidenceFound` is
    // `required ∩ detected` and omits pr-link whenever it isn't required
    // (unlabeled issues, `infra`/`backend`-labeled issues, etc.), while
    // `allDetected` is every shape the evaluator actually found. A real
    // pasted GitHub PR URL must still unblock `done` in that case.
    expect(
      shouldBlockNarratedDone({
        ...base,
        fromStatus: "blocked",
        lastEvidenceVerdict: {
          verdict: "warn",
          evidenceFound: [],
          allDetected: ["pr-link"],
        },
      }),
    ).toBe(false);
  });

  it("does nothing for non-done transitions", () => {
    expect(shouldBlockNarratedDone({ ...base, toStatus: "in_review" })).toBe(false);
    expect(shouldBlockNarratedDone({ ...base, toStatus: undefined })).toBe(false);
  });

  it("never blocks a human actor closing an issue", () => {
    expect(shouldBlockNarratedDone({ ...base, fromStatus: "todo", isAgentActor: false })).toBe(false);
  });

  it("does not block a no-op done->done re-set", () => {
    expect(shouldBlockNarratedDone({ ...base, fromStatus: "done" })).toBe(false);
  });

  it("tolerates a malformed evidence verdict without throwing", () => {
    expect(
      shouldBlockNarratedDone({ ...base, fromStatus: "todo", lastEvidenceVerdict: "garbage" }),
    ).toBe(true);
    expect(
      shouldBlockNarratedDone({ ...base, fromStatus: "todo", lastEvidenceVerdict: { evidenceFound: "not-an-array" } }),
    ).toBe(true);
  });

  // BLO-20691: the predicate reads `checkoutRunId`, never the `executionRunId`
  // dispatch lock. The scheduler stamps `executionRunId` on a merely queued run
  // while leaving `checkoutRunId` null, so an issue the dispatcher touched but
  // no agent ever executed presents here as `existingCheckoutRunId: null` and
  // must still block. The interface has no `executionRunId` field at all, which
  // is what stops a call site reinstating the old read by habit.
  it("blocks when only a dispatch lock was held and checkout never happened", () => {
    expect(
      shouldBlockNarratedDone({
        ...base,
        fromStatus: "in_review",
        existingCheckoutRunId: null,
        hasDurableArtifactEvidence: false,
      }),
    ).toBe(true);
  });

  // BLO-19081: the lock columns are transient — `issues.update()` nulls them on
  // any transition away from `in_progress`, so investigation-shaped work (no
  // commit, no PR, lock long released) could not be closed by an agent at all.
  // A run-attributed durable artifact is the third accepted evidence shape.
  describe("durable-artifact evidence (BLO-19081)", () => {
    it("allows done for an investigation-shaped issue: durable artifact, no run, no pr-link", () => {
      expect(
        shouldBlockNarratedDone({
          ...base,
          fromStatus: "in_review",
          existingCheckoutRunId: null,
          lastEvidenceVerdict: { verdict: "warn", evidenceFound: [], allDetected: [] },
          hasDurableArtifactEvidence: true,
        }),
      ).toBe(false);
    });

    it("STILL BLOCKS when the only evidence is a comment body (gate not deleted)", () => {
      // The caller derives `hasDurableArtifactEvidence` exclusively from
      // issue-document / work-product rows, never from comment text. A
      // thread full of well-sourced prose therefore leaves it false and the
      // close must still fail. If this ever goes green with `true`, the gate
      // has been removed rather than fixed.
      expect(
        shouldBlockNarratedDone({
          ...base,
          fromStatus: "in_review",
          existingCheckoutRunId: null,
          lastEvidenceVerdict: {
            verdict: "warn",
            evidenceFound: [],
            // Every non-durable shape an agent can produce from prose alone.
            allDetected: ["checklist:done-when", "test-output", "kubectl-state", "url-probe"],
          },
          hasDurableArtifactEvidence: false,
        }),
      ).toBe(true);
    });

    it("keeps blocking a runless narrator even when it claims completion in prose", () => {
      expect(
        shouldBlockNarratedDone({ ...base, fromStatus: "todo", hasDurableArtifactEvidence: false }),
      ).toBe(true);
    });

    it("regression guard: a real checkout still allows done with no artifact and no pr-link", () => {
      expect(
        shouldBlockNarratedDone({
          ...base,
          existingCheckoutRunId: "run-123",
          hasDurableArtifactEvidence: false,
        }),
      ).toBe(false);
    });

    it("does not let a durable artifact unblock a non-done transition or a human no-op", () => {
      expect(
        shouldBlockNarratedDone({ ...base, toStatus: "in_review", hasDurableArtifactEvidence: true }),
      ).toBe(false);
      expect(
        shouldBlockNarratedDone({ ...base, fromStatus: "done", hasDurableArtifactEvidence: true }),
      ).toBe(false);
    });
  });
});

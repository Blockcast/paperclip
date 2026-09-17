import { describe, expect, it } from "vitest";
import {
  isStatusOnlyRecoveryContextSnapshot,
  readRecoveryRunWriteClass,
  RECOVERY_GUARD_CONTEXT_KEYS,
  RECOVERY_RUN_WRITE_CLASS_NOTICE,
  RECOVERY_WORK_CLASS_KEY,
  recoveryAssigneeAdapterOverrides,
  scrubRecoveryModelProfileHints,
  STATUS_ONLY_RECOVERY_GUARD_CONTEXT,
  STATUS_ONLY_RECOVERY_RESUME_GUIDANCE,
  withRecoveryModelProfileHint,
} from "./model-profile-hint.js";

describe("recovery model profile policy", () => {
  it("allows cheap only for status-only recovery and adds guard context", () => {
    expect(withRecoveryModelProfileHint({ issueId: "issue-1" }, "status_only")).toEqual({
      issueId: "issue-1",
      recoveryIntent: "status_only",
      allowDeliverableWork: false,
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
      modelProfile: "cheap",
      recoveryWorkClass: "status_only",
    });
    expect(recoveryAssigneeAdapterOverrides("status_only")).toEqual({ modelProfile: "cheap" });
  });

  it("scrubs inherited cheap hints from normal model source-work retries", () => {
    expect(withRecoveryModelProfileHint({
      issueId: "issue-1",
      retryOfRunId: "run-1",
      modelProfile: "cheap",
      recoveryIntent: "status_only",
      allowDeliverableWork: false,
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
    }, "normal_model")).toEqual({
      issueId: "issue-1",
      retryOfRunId: "run-1",
      recoveryWorkClass: "normal_model",
    });
  });

  it("keeps planning recovery on the normal model with a document-only guard context", () => {
    expect(withRecoveryModelProfileHint({ issueId: "issue-1" }, "planning_only")).toEqual({
      issueId: "issue-1",
      recoveryIntent: "planning_only",
      allowDeliverableWork: false,
      allowDocumentUpdates: true,
      resumeRequiresNormalModel: false,
      recoveryWorkClass: "planning_only",
    });
  });

  it("can scrub copied downstream source-work contexts without applying a profile", () => {
    expect(scrubRecoveryModelProfileHints({
      taskId: "source-task",
      modelProfile: "cheap",
      paperclipModelProfile: { requested: "cheap" },
      allowDocumentUpdates: false,
      recoveryWorkClass: "status_only",
    })).toEqual({ taskId: "source-task" });
  });

  // BLO-32634: the three classes must stay mutually exclusive, and no caller may
  // end up with a partial tuple. Re-classifying an already-classified context is
  // the path that used to leak one — `planning_only` supplies no `modelProfile`,
  // so a `cheap` carried in by the input rode along beside it.
  it("re-classifies without leaving a partial tuple", () => {
    const statusOnly = withRecoveryModelProfileHint({ issueId: "issue-1" }, "status_only");

    expect(withRecoveryModelProfileHint(statusOnly, "planning_only")).toEqual({
      issueId: "issue-1",
      recoveryIntent: "planning_only",
      allowDeliverableWork: false,
      allowDocumentUpdates: true,
      resumeRequiresNormalModel: false,
      recoveryWorkClass: "planning_only",
    });
    expect(withRecoveryModelProfileHint(statusOnly, "normal_model")).toEqual({
      issueId: "issue-1",
      recoveryWorkClass: "normal_model",
    });
  });

  // Every key the guard block owns is declared in one place. The merge in
  // heartbeat.ts drops exactly this set, so a key that stops being listed here
  // silently stops being dropped there.
  it("declares every guard key it can write", () => {
    const written = new Set([
      ...Object.keys(withRecoveryModelProfileHint({}, "status_only")),
      ...Object.keys(withRecoveryModelProfileHint({}, "planning_only")),
      ...Object.keys(withRecoveryModelProfileHint({}, "normal_model")),
    ]);

    for (const key of written) {
      expect(RECOVERY_GUARD_CONTEXT_KEYS).toContain(key);
    }
    expect(RECOVERY_GUARD_CONTEXT_KEYS).toContain(RECOVERY_WORK_CLASS_KEY);
  });
});

// PEN-3275. The announcement in the wake prompt and the 403 at the route guards must classify a
// run identically — an agent told it is unconstrained and then refused is the exact trap this
// work exists to close, and it would be worse than the silence it replaces.
describe("recovery run write class", () => {
  // The ratchet: classification is asserted against what the PRODUCER actually writes, not
  // against a hand-copied tuple. Editing a guard tuple moves both sides together or fails here.
  it("classifies each work class the producer can emit", () => {
    expect(readRecoveryRunWriteClass(withRecoveryModelProfileHint({ issueId: "i" }, "status_only")))
      .toBe("status_only");
    expect(readRecoveryRunWriteClass(withRecoveryModelProfileHint({ issueId: "i" }, "planning_only")))
      .toBe("planning_only");
  });

  // A declared normal-model wake carries `recoveryWorkClass` but no guard tuple, and the route
  // guards let it write. It must therefore be announced as unconstrained, not as "unknown".
  it("returns null for a declared normal-model wake and for an ordinary snapshot", () => {
    expect(readRecoveryRunWriteClass(withRecoveryModelProfileHint({ issueId: "i" }, "normal_model")))
      .toBeNull();
    expect(readRecoveryRunWriteClass({ issueId: "i" })).toBeNull();
    expect(readRecoveryRunWriteClass(null)).toBeNull();
    expect(readRecoveryRunWriteClass([STATUS_ONLY_RECOVERY_GUARD_CONTEXT])).toBeNull();
  });

  // The conjunction is the guard. `isStatusOnlyRecoveryContextSnapshot` treats a partial tuple as
  // NOT status-only, so the route guards would allow the write; announcing containment there would
  // state the opposite of what the run can do. Asserted in the same direction as the enforcer.
  it("agrees with the enforcing predicates on a partial tuple", () => {
    const partial = { ...withRecoveryModelProfileHint({}, "status_only"), allowDocumentUpdates: true };
    expect(isStatusOnlyRecoveryContextSnapshot(partial)).toBe(false);
    expect(readRecoveryRunWriteClass(partial)).toBeNull();
  });

  // BLO-32634 residual: a coalesced escalation can retain `modelProfile: "cheap"` while being
  // planning-capable. Requiring a profile here would misclassify it as unconstrained and suppress
  // the announcement on a run whose approval writes the guards still refuse.
  it("classifies a planning-only snapshot that retained the cheap profile", () => {
    expect(readRecoveryRunWriteClass({
      ...withRecoveryModelProfileHint({ issueId: "i" }, "planning_only"),
      modelProfile: "cheap",
    })).toBe("planning_only");
  });

  // The other direction of that same asymmetry, asserted rather than only documented. The
  // status-only predicate requires `modelProfile: "cheap"`; its planning-only sibling deliberately
  // omits the check, because the `planning_only` arm of `withRecoveryModelProfileHint` SCRUBS the
  // key rather than setting it — so requiring a value would make the predicate unsatisfiable on
  // the producer's own output. Together with the case above this pins both arms of a divergence
  // that reads like an oversight and would otherwise be "tidied" into symmetry.
  it("classifies a planning-only snapshot carrying no model profile at all", () => {
    const planningOnly = withRecoveryModelProfileHint({ issueId: "i" }, "planning_only");

    expect(planningOnly).not.toHaveProperty("modelProfile");
    expect(readRecoveryRunWriteClass(planningOnly)).toBe("planning_only");
    // The sibling requires the key, so the same tuple minus a profile is NOT status-only.
    expect(isStatusOnlyRecoveryContextSnapshot(planningOnly)).toBe(false);
  });

  it("reuses the shared resume guidance verbatim so the wake and the 403 cannot drift", () => {
    expect(RECOVERY_RUN_WRITE_CLASS_NOTICE.status_only)
      .toContain(STATUS_ONLY_RECOVERY_RESUME_GUIDANCE.resumeGuidance);
  });

  // BLO-25878 / BLO-32774. The notice must not read as a promise that a normal-model run is
  // coming, nor as an instruction to go arm oneself an unguarded one — `issues.ts` refuses
  // exactly that monitor arm, so suggesting it would send the reader into another 403.
  it("neither promises a normal-model run nor steers the reader into arming one", () => {
    for (const notice of Object.values(RECOVERY_RUN_WRITE_CLASS_NOTICE)) {
      expect(notice).not.toMatch(/arm a monitor|monitor to resume|wait for a normal-model run/i);
    }
    expect(RECOVERY_RUN_WRITE_CLASS_NOTICE.status_only).toContain("never ends");
  });

  // The false-record failure is the one that produced a durable wrong claim on PEN-3248, so the
  // instruction that prevents it is asserted rather than left to prose review.
  it("tells the reader to confirm a contained write returned before claiming it", () => {
    for (const notice of Object.values(RECOVERY_RUN_WRITE_CLASS_NOTICE)) {
      expect(notice).toContain("before you describe it as done");
    }
  });
});

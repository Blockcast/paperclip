import { describe, expect, it } from "vitest";
import {
  RECOVERY_GUARD_CONTEXT_KEYS,
  RECOVERY_WORK_CLASS_KEY,
  recoveryAssigneeAdapterOverrides,
  scrubRecoveryModelProfileHints,
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

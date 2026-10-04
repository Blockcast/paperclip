import { describe, expect, it } from "vitest";
import { toIssueActiveRunRow } from "../services/issues.js";
import {
  PLANNING_ONLY_RECOVERY_GUARD_CONTEXT,
  RECOVERY_MODEL_PROFILE_KEY,
  RECOVERY_WORK_CLASS_KEY,
  STATUS_ONLY_RECOVERY_GUARD_CONTEXT,
} from "../services/recovery/model-profile-hint.js";

// PEN-3275. `activeRun` answers "is a run attending this row?". It did not answer
// "can that run perform this row's remedy?", and a write-contained run is
// indistinguishable from an unconstrained one on every liveness surface we have:
// the wake is delivered, the run is serviced, `activeRun` populates, and the
// approval/document/monitor writes the row needs are refused by the route guards.
//
// These tests pin the two properties that the derivation's own suite
// (`model-profile-hint.test.ts`) cannot cover, because they are properties of the
// PROJECTION rather than of the classifier: the snapshot must not leak onto the
// response, and the field must be present-and-null rather than absent.

const baseRow = {
  id: "run-1",
  companyId: "company-1",
  status: "running",
  agentId: "agent-1",
  invocationSource: "automation",
  triggerDetail: "system",
  startedAt: new Date("2026-10-04T04:22:17.705Z"),
  finishedAt: null,
  createdAt: new Date("2026-10-03T23:51:20.226Z"),
  lastOutputAt: new Date("2026-10-04T04:22:23.295Z"),
  lastUsefulActionAt: new Date("2026-10-04T04:22:23.295Z"),
};

function row(contextSnapshot: Record<string, unknown> | null) {
  return { ...baseRow, contextSnapshot };
}

describe("activeRun write-containment projection", () => {
  it("reports status_only for the tuple the route guards actually enforce", () => {
    const projected = toIssueActiveRunRow(
      row({ modelProfile: RECOVERY_MODEL_PROFILE_KEY, ...STATUS_ONLY_RECOVERY_GUARD_CONTEXT }),
    );
    expect(projected.writeContainment).toBe("status_only");
  });

  it("reports planning_only for its tuple", () => {
    const projected = toIssueActiveRunRow(row({ ...PLANNING_ONLY_RECOVERY_GUARD_CONTEXT }));
    expect(projected.writeContainment).toBe("planning_only");
  });

  // The guard is the conjunction. A run that cleared one key is NOT contained by
  // the route guards, so reporting it as contained here would be the mirror of the
  // defect: a row that can act, read as one that cannot.
  it("does not report containment for a partial tuple", () => {
    const projected = toIssueActiveRunRow(
      row({
        modelProfile: RECOVERY_MODEL_PROFILE_KEY,
        ...STATUS_ONLY_RECOVERY_GUARD_CONTEXT,
        allowDocumentUpdates: true,
      }),
    );
    expect(projected.writeContainment).toBeNull();
  });

  // `null` is "unconstrained", never "unknown" — including for a wake that
  // positively declared itself normal-model and so carries no guard tuple.
  it("reports null for an unconstrained run, including a declared normal_model wake", () => {
    expect(toIssueActiveRunRow(row(null)).writeContainment).toBeNull();
    expect(toIssueActiveRunRow(row({})).writeContainment).toBeNull();
    expect(
      toIssueActiveRunRow(row({ [RECOVERY_WORK_CLASS_KEY]: "normal_model" })).writeContainment,
    ).toBeNull();
  });

  // BLO-34421's lesson, applied to this field: an absent key reads as "no
  // containment" to a consumer doing a truthiness test, which is the expensive
  // direction. Present-and-null is the contract, so state it directly rather
  // than leaving it implied by the value assertions above.
  //
  // Measured, not assumed: dropping the key when the class is null fails this
  // test AND both `toBeNull()` assertions above — `expect(undefined).toBeNull()`
  // does not pass in vitest. So this case is a redundant guard on a contract the
  // others already enforce, kept because it names the contract in one place
  // instead of making a reader infer it from a null check.
  it("always carries the key, even when unconstrained", () => {
    const projected = toIssueActiveRunRow(row(null));
    expect(Object.keys(projected)).toContain("writeContainment");
  });

  // The snapshot is selected only to derive the class. It carries the run's wake
  // payload and task data, so it must not reach a response.
  it("drops contextSnapshot and companyId from the projected row", () => {
    const projected = toIssueActiveRunRow(
      row({
        modelProfile: RECOVERY_MODEL_PROFILE_KEY,
        ...STATUS_ONLY_RECOVERY_GUARD_CONTEXT,
        secretTaskPayload: "must-not-be-returned",
      }),
    );
    const keys = Object.keys(projected);
    expect(keys).not.toContain("contextSnapshot");
    expect(keys).not.toContain("companyId");
    expect(JSON.stringify(projected)).not.toContain("must-not-be-returned");
  });

  it("preserves the existing activeRun liveness fields unchanged", () => {
    const projected = toIssueActiveRunRow(row(null));
    expect(projected).toMatchObject({
      id: baseRow.id,
      status: baseRow.status,
      agentId: baseRow.agentId,
      invocationSource: baseRow.invocationSource,
      triggerDetail: baseRow.triggerDetail,
      startedAt: baseRow.startedAt,
      finishedAt: baseRow.finishedAt,
      createdAt: baseRow.createdAt,
      lastOutputAt: baseRow.lastOutputAt,
      lastUsefulActionAt: baseRow.lastUsefulActionAt,
    });
  });
});

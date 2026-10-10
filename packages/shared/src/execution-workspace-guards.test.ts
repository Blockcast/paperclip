import { describe, expect, it } from "vitest";

import { isClosedIsolatedExecutionWorkspace, isExecutionWorkspaceDetachPatch } from "./execution-workspace-guards.js";

const CLOSED_ID = "33333333-3333-4333-8333-333333333333";
const OPEN_ID = "44444444-4444-4444-8444-444444444444";

function detach(updateFields: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return isExecutionWorkspaceDetachPatch({
    updateFields,
    hasComment: false,
    hasReviewRequest: false,
    closedExecutionWorkspaceId: CLOSED_ID,
    ...overrides,
  } as Parameters<typeof isExecutionWorkspaceDetachPatch>[0]);
}

// BLO-42036. The guard this feeds keys on `closedAt`, which no exposed route can clear, so
// before this predicate a collected workspace bricked its source issue permanently: every
// agent-reachable write 409'd, and archiving the workspace 409'd the other way ("still
// linked to an open issue"). One test per arm, so each arm has a failing mutation.
describe("isExecutionWorkspaceDetachPatch", () => {
  it("allows detaching to null", () => {
    expect(detach({ executionWorkspaceId: null })).toBe(true);
  });

  it("allows rebinding onto a different workspace", () => {
    expect(detach({ executionWorkspaceId: OPEN_ID })).toBe(true);
  });

  it("allows workspace preference and settings to ride along", () => {
    expect(
      detach({
        executionWorkspaceId: null,
        executionWorkspacePreference: "isolated_workspace",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      }),
    ).toBe(true);
  });

  // Re-pinning the SAME dead workspace moves nothing. If this were a detach the guard
  // would be bypassable by echoing the value the issue already holds.
  it("refuses a patch that re-pins the same closed workspace", () => {
    expect(detach({ executionWorkspaceId: CLOSED_ID })).toBe(false);
  });

  it("refuses a patch that does not set executionWorkspaceId at all", () => {
    expect(detach({ executionWorkspacePreference: "isolated_workspace" })).toBe(false);
  });

  it("refuses an empty patch", () => {
    expect(detach({})).toBe(false);
  });

  // The exemption must not become a general write channel: these are the ways real work
  // could ride in alongside the detach.
  it("refuses a detach carrying a non-workspace field", () => {
    expect(detach({ executionWorkspaceId: null, status: "in_progress" })).toBe(false);
  });

  it("refuses a detach carrying a comment", () => {
    expect(detach({ executionWorkspaceId: null }, { hasComment: true })).toBe(false);
  });

  it("refuses a detach carrying a review request", () => {
    expect(detach({ executionWorkspaceId: null }, { hasReviewRequest: true })).toBe(false);
  });
});

// Pinned because the detach predicate is only reachable when this one says the workspace is
// closed, and `status: "active"` with `closedAt` set is exactly the state a failed repair
// leaves behind — flipping status is accepted by the workspace route and clears nothing.
describe("isClosedIsolatedExecutionWorkspace", () => {
  it("treats a closedAt-stamped workspace as closed even when status reads active", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({
        mode: "isolated_workspace",
        status: "active",
        closedAt: new Date("2026-10-09T03:41:39.769Z"),
      } as Parameters<typeof isClosedIsolatedExecutionWorkspace>[0]),
    ).toBe(true);
  });

  it("treats an archived workspace as closed even with no closedAt", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({
        mode: "isolated_workspace",
        status: "archived",
        closedAt: null,
      } as Parameters<typeof isClosedIsolatedExecutionWorkspace>[0]),
    ).toBe(true);
  });

  it("leaves a healthy isolated workspace alone", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({
        mode: "isolated_workspace",
        status: "active",
        closedAt: null,
      } as Parameters<typeof isClosedIsolatedExecutionWorkspace>[0]),
    ).toBe(false);
  });
});

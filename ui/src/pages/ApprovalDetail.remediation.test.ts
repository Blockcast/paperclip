import { describe, expect, it } from "vitest";

import { ApiError } from "../api/client";
import { canResubmitFromBoard, errorWithRemediation } from "./ApprovalDetail";

// The refusal this exists for: BLO-34008 stops a `budget_override_required` card
// returning to `pending` without a machine-checkable assertion. The bare `error`
// says the payload is unverifiable; only `details.remediation` says what would
// make it verifiable, and the operator clicking "Mark resubmitted" is the person
// who has to decide what happens to the card next.
const budgetRefusal = () =>
  new ApiError(
    "`budget_override_required` requires at least one machine-checkable entry in " +
      "`payload.enforcement_assertions`; prose figures cannot be verified against enforcement",
    422,
    {
      error: "…",
      details: {
        code: "budget_approval_missing_enforcement_assertion",
        remediation: "Add one entry per policy this decision changes, under `payload.…`.",
      },
    },
  );

describe("errorWithRemediation", () => {
  it("folds details.remediation into the surfaced message", () => {
    const shown = errorWithRemediation(budgetRefusal(), "Resubmit failed");
    expect(shown).toContain("prose figures cannot be verified");
    expect(shown).toContain("Add one entry per policy this decision changes");
  });

  it("leaves an ordinary ApiError untouched", () => {
    expect(errorWithRemediation(new ApiError("Approval not found", 404, { error: "x" }), "fell back")).toBe(
      "Approval not found",
    );
  });

  it("does not append an empty or non-string remediation", () => {
    const blank = new ApiError("nope", 422, { details: { remediation: "   " } });
    expect(errorWithRemediation(blank, "fell back")).toBe("nope");
    const wrongType = new ApiError("nope", 422, { details: { remediation: { a: 1 } } });
    expect(errorWithRemediation(wrongType, "fell back")).toBe("nope");
  });

  it("survives a null body and a non-Error rejection", () => {
    expect(errorWithRemediation(new ApiError("boom", 500, null), "fell back")).toBe("boom");
    expect(errorWithRemediation("not an error", "fell back")).toBe("fell back");
  });
});

// The dead end this closes: "Mark resubmitted" sends no payload, so on a
// caller-filed budget card the server guard can only answer 422 with a
// remediation telling the operator the fix must happen somewhere else. The
// button is suppressed exactly where it cannot win, and — the half that matters
// for not regressing today's population — left alone where it can.
describe("canResubmitFromBoard", () => {
  const card = (over: Partial<Parameters<typeof canResubmitFromBoard>[0]> = {}) => ({
    type: "budget_override_required",
    requestedByAgentId: null,
    requestedByUserId: null,
    ...over,
  }) as Parameters<typeof canResubmitFromBoard>[0];

  it("suppresses the button on an agent-filed budget card", () => {
    expect(canResubmitFromBoard(card({ requestedByAgentId: "a1" }))).toBe(false);
  });

  it("suppresses it on a user-filed budget card too", () => {
    expect(canResubmitFromBoard(card({ requestedByUserId: "u1" }))).toBe(false);
  });

  // Both requester columns null == filed by the budget watcher through
  // insertApproval(), which the server exempts from the assertion guard. These
  // are the entire `revision_requested` budget population today, so gating them
  // would remove the only budget resubmit that currently works.
  it("keeps it on a watcher-filed budget card, which the server exempts", () => {
    expect(canResubmitFromBoard(card())).toBe(true);
  });

  it("never gates a non-budget card, whoever filed it", () => {
    for (const type of ["hire_agent", "request_board_approval", "approve_ceo_strategy"] as const) {
      expect(canResubmitFromBoard(card({ type, requestedByAgentId: "a1" }))).toBe(true);
    }
  });
});

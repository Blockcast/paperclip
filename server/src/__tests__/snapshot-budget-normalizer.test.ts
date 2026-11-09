import { describe, expect, it } from "vitest";
import { normalizeSnapshotBudgetCents } from "../services/agents.js";

// PEN-6277. `configPatchFromSnapshot` (`services/agents.ts`) and the rollback
// guard in `routes/agents.ts` both normalize a revision's restored
// `budgetMonthlyCents`, and they used to do it with two copies of
// `Math.max(0, Math.floor(...))`. They now share this one function, so drift is
// structurally impossible rather than merely detectable -- but the function
// itself had no direct test, and the only input any suite covered was the
// FRACTIONAL one (`1_300_000.7`, in `agent-scope-pinned-config-keys-routes`).
//
// The CLAMP arm was therefore unpinned, and it is the half that is not
// cosmetic: `agents.budget_monthly_cents` is a non-negative display mirror, so
// a revision carrying a negative cap has to restore 0 rather than write the
// negative through. Deleting `Math.max(0, ...)` leaves every other budget test
// in this repo green and reds only the first case below -- which is the point
// of pinning it here, at the function, rather than through a route.
describe("normalizeSnapshotBudgetCents (PEN-6277)", () => {
  it("clamps a NEGATIVE snapshot value to zero instead of writing it through", () => {
    expect(normalizeSnapshotBudgetCents(-1)).toBe(0);
    expect(normalizeSnapshotBudgetCents(-0.5)).toBe(0);
    expect(normalizeSnapshotBudgetCents(-9_900_000)).toBe(0);
  });

  // Not the new coverage -- this restates, at the function, what the route
  // suite already asserts through a rollback. It is here so that a mutation to
  // either arm of the normalizer is attributable to the arm it broke.
  it("floors a fractional value and leaves a non-negative integer alone", () => {
    expect(normalizeSnapshotBudgetCents(1_300_000.7)).toBe(1_300_000);
    expect(normalizeSnapshotBudgetCents(1_300_000)).toBe(1_300_000);
    expect(normalizeSnapshotBudgetCents(0)).toBe(0);
  });
});

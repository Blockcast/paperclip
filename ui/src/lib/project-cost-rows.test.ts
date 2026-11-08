import { describe, expect, it } from "vitest";
import type { CostByProject } from "@paperclipai/shared";
import {
  UNATTRIBUTED_PROJECT_LABEL,
  reconcileProjectCosts,
  toProjectCostRows,
} from "./project-cost-rows";

function row(overrides: Partial<CostByProject>): CostByProject {
  return {
    projectId: "project-1",
    projectName: "Managed Commercial Gateway",
    costCents: 0,
    consumptionCents: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

describe("toProjectCostRows", () => {
  it("labels the null-project bucket as unattributed", () => {
    const rows = toProjectCostRows([
      row({ projectId: "project-1", projectName: "Gateway", costCents: 700 }),
      row({ projectId: null, projectName: null, costCents: 300 }),
    ]);

    expect(rows.map((r) => r.label)).toEqual(["Gateway", UNATTRIBUTED_PROJECT_LABEL]);
    expect(rows.map((r) => r.unattributed)).toEqual([false, true]);
    expect(rows.map((r) => r.key)).toEqual(["project-1", "unattributed"]);
  });

  it("falls back to the project id rather than the bucket label when a named project has no name", () => {
    // Claiming a real project is "Unattributed" would misreport WHICH defect the
    // operator is looking at, so an unnamed project renders as its id.
    const [only] = toProjectCostRows([row({ projectId: "project-9", projectName: null })]);

    expect(only?.label).toBe("project-9");
    expect(only?.unattributed).toBe(false);
  });

  it("returns no rows for an absent response", () => {
    expect(toProjectCostRows(undefined)).toEqual([]);
  });
});

describe("reconcileProjectCosts", () => {
  // PEN-6084's invariant, at the display layer: with the unattributed bucket present the
  // card's own total equals the Summary card beside it. Pinned as an invariant, never as
  // a magnitude -- the bucket SHRINKS as write-time attribution (PEN-5937) lands.
  it("reconciles once the unattributed bucket is included", () => {
    const rows = toProjectCostRows([
      row({ projectId: "project-1", costCents: 839_102 }),
      row({ projectId: null, projectName: null, costCents: 701_031 }),
    ]);

    const result = reconcileProjectCosts(rows, 1_540_133);

    expect(result.reconciles).toBe(true);
    expect(result.differenceCents).toBe(0);
    expect(result.totalCents).toBe(1_540_133);
  });

  it("reports the shortfall when rows do not sum to the summary", () => {
    const rows = toProjectCostRows([row({ projectId: "project-1", costCents: 1_002_603 })]);

    const result = reconcileProjectCosts(rows, 1_703_634);

    expect(result.reconciles).toBe(false);
    expect(result.differenceCents).toBe(-701_031);
  });
});

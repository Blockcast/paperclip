import { describe, expect, it } from "vitest";
import type { CostByProject } from "@paperclipai/shared";
import {
  UNATTRIBUTED_PROJECT_LABEL,
  projectCostWindowTotal,
  reconcileProjectCosts,
  toProjectCostRows,
} from "./project-cost-rows";

function row(overrides: Partial<CostByProject>): CostByProject {
  return {
    projectId: "project-1",
    projectName: "Managed Commercial Gateway",
    costCents: 0,
    windowTotalCents: 0,
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

describe("projectCostWindowTotal", () => {
  // Every row carries the same total, so reading the first is reading the statement's own
  // answer. The bucket row carries it too -- the reconciliation must not depend on which
  // kind of row happens to sort first.
  it("reads the window total off whichever row comes first", () => {
    expect(
      projectCostWindowTotal([
        row({ projectId: "project-1", costCents: 700, windowTotalCents: 1_000 }),
        row({ projectId: null, projectName: null, costCents: 300, windowTotalCents: 1_000 }),
      ]),
    ).toBe(1_000);

    expect(
      projectCostWindowTotal([
        row({ projectId: null, projectName: null, costCents: 1_000, windowTotalCents: 1_000 }),
      ]),
    ).toBe(1_000);
  });

  it("reports zero for an empty or absent response", () => {
    // Sound only because `by-project` buckets rather than drops: any spend in the window
    // produces at least the unattributed row, so no rows means no spend.
    expect(projectCostWindowTotal([])).toBe(0);
    expect(projectCostWindowTotal(undefined)).toBe(0);
  });
});

describe("reconcileProjectCosts", () => {
  // PEN-6084's invariant, at the display layer: with the unattributed bucket present the
  // rows account for the whole window the SAME response reported. Pinned as an invariant,
  // never as a magnitude -- the bucket SHRINKS as write-time attribution (PEN-5937) lands.
  it("reconciles once the unattributed bucket is included", () => {
    const served = [
      row({ projectId: "project-1", costCents: 839_102, windowTotalCents: 1_540_133 }),
      row({ projectId: null, projectName: null, costCents: 701_031, windowTotalCents: 1_540_133 }),
    ];

    const result = reconcileProjectCosts(toProjectCostRows(served), projectCostWindowTotal(served));

    expect(result.reconciles).toBe(true);
    expect(result.differenceCents).toBe(0);
    expect(result.totalCents).toBe(1_540_133);
    expect(result.windowTotalCents).toBe(1_540_133);
  });

  it("reports the shortfall when the rows do not account for the window", () => {
    // The pre-PEN-6084 shape: the attributed project alone, with the window total naming
    // the spend the aggregate dropped.
    const served = [
      row({ projectId: "project-1", costCents: 1_002_603, windowTotalCents: 1_703_634 }),
    ];

    const result = reconcileProjectCosts(toProjectCostRows(served), projectCostWindowTotal(served));

    expect(result.reconciles).toBe(false);
    expect(result.differenceCents).toBe(-701_031);
  });
});

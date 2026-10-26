import { describe, expect, it } from "vitest";
import { compareStrandedSweepKey, rotateStrandedCandidates } from "./stranded-sweep-budget.js";

const row = (companyId: string, assigneeAgentId: string | null, t: number, id: string) => ({
  companyId,
  assigneeAgentId,
  createdAt: new Date(t),
  id,
});

// Already in the candidate query's ORDER BY: company, assignee (NULLS LAST), createdAt, id.
const ordered = [
  row("a", "x", 1, "1"),
  row("a", "x", 2, "2"),
  row("a", null, 1, "3"),
  row("b", "x", 1, "4"),
  row("b", "y", 1, "5"),
];

describe("compareStrandedSweepKey (BLO-48950)", () => {
  it("agrees with the query's ORDER BY, NULL assignee last", () => {
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareStrandedSweepKey(ordered[i], ordered[i + 1])).toBe(-1);
      expect(compareStrandedSweepKey(ordered[i + 1], ordered[i])).toBe(1);
    }
    expect(compareStrandedSweepKey(ordered[2], ordered[2])).toBe(0);
  });
});

describe("rotateStrandedCandidates (BLO-48950)", () => {
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).join("");

  it("keeps order when there is nothing to resume", () => {
    expect(ids(rotateStrandedCandidates(ordered, null))).toBe("12345");
  });

  it("resumes just after the last candidate reached", () => {
    expect(ids(rotateStrandedCandidates(ordered, ordered[1]))).toBe("34512");
  });

  it("resumes by KEY when the last-reached row has left the set", () => {
    // The row a truncated pass reached last was escalated and is gone from this pass.
    const gone = row("a", null, 5, "9");
    const remaining = ordered.filter((r) => r.id !== "3");
    expect(ids(rotateStrandedCandidates(remaining, gone))).toBe("4512");
  });

  it("wraps to the head when the resume key is past the end", () => {
    expect(ids(rotateStrandedCandidates(ordered, row("z", null, 0, "0")))).toBe("12345");
  });
});

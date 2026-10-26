import { describe, expect, it } from "vitest";
import {
  compareStrandedSweepKey,
  rotateStrandedCandidates,
  runBudgetedStrandedLoop,
} from "./stranded-sweep-budget.js";

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

describe("runBudgetedStrandedLoop (BLO-48950)", () => {
  // Each visit costs 100 "ms" on a fake clock; budget 250 => the 4th check sees 300 > 250.
  const slowPass = async (rows: typeof ordered) => {
    let t = 0;
    const visited: string[] = [];
    const out = await runBudgetedStrandedLoop(
      rows,
      async (r) => {
        visited.push(r.id);
        t += 100;
      },
      250,
      () => t,
    );
    return { ...out, visited: visited.join("") };
  };

  it("stops at the budget, finishing the candidate in flight, and records where", async () => {
    const out = await slowPass(ordered);
    expect(out).toMatchObject({ reached: 3, budgetExhausted: true, visited: "123" });
    expect(out.resumeAfter?.id).toBe("3");
  });

  it("reaches every candidate across successive truncated passes, and a clean pass resets the cursor", async () => {
    const first = await slowPass(ordered);
    // Rotation wraps, so the second pass covers the tail and then the head again.
    const second = await slowPass(rotateStrandedCandidates(ordered, first.resumeAfter));
    expect(second.visited).toBe("451");
    expect(new Set(first.visited + second.visited).size).toBe(ordered.length);
    expect(second.resumeAfter?.id).toBe("1");
    const clean = await runBudgetedStrandedLoop(
      rotateStrandedCandidates(ordered, second.resumeAfter),
      async () => {},
      250,
      () => 0,
    );
    expect(clean).toMatchObject({ reached: 5, budgetExhausted: false, resumeAfter: null });
  });

  it("a pass within budget reaches everything and leaves no cursor", async () => {
    let t = 0;
    const out = await runBudgetedStrandedLoop(ordered, async () => {}, 250, () => t);
    expect(out).toEqual({ reached: 5, budgetExhausted: false, stopped: false, resumeAfter: null });
  });

  it("stops for shutdown before the next candidate and leaves no cursor", async () => {
    const visited: string[] = [];
    const out = await runBudgetedStrandedLoop(
      ordered,
      async (r) => { visited.push(r.id); },
      250,
      () => 0,
      () => visited.length >= 2,
    );
    expect(out).toEqual({ reached: 2, budgetExhausted: false, stopped: true, resumeAfter: null });
  });
});

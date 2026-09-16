// BLO-34222 negative control. Temporary: proves this lane can turn red.
// Reverted in the next commit on this PR.
import { describe, expect, it } from "vitest";

describe("BLO-34222 negative control", () => {
  it("fails deliberately so the new CI lane is observed red at least once", () => {
    expect(1).toBe(2);
  });
});

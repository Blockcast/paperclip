import { describe, expect, it } from "vitest";
import {
  parseDuplicateBackfillFlag,
  parseDuplicateBackfillNumberFlag,
} from "../../scripts/issue-duplicate-backfill.js";

describe("issue duplicate backfill flags", () => {
  const argv = (...args: string[]) => ["node", "issue-duplicate-backfill.ts", ...args];

  it("rejects empty and whitespace-only scope flag values", () => {
    expect(() => parseDuplicateBackfillFlag(argv("--company", ""), "--company")).toThrow(
      "--company requires a non-empty value",
    );
    expect(() => parseDuplicateBackfillFlag(argv("--project", "   "), "--project")).toThrow(
      "--project requires a non-empty value",
    );
  });

  it("rejects empty numeric flag values before Number coercion can turn them into zero", () => {
    expect(() =>
      parseDuplicateBackfillNumberFlag(argv("--score", ""), "--score", 0.82, { min: 0, max: 1 }),
    ).toThrow("--score requires a non-empty value");
    expect(() =>
      parseDuplicateBackfillNumberFlag(argv("--distinctive", "\t"), "--distinctive", 2, {
        min: 1,
        integer: true,
      }),
    ).toThrow("--distinctive requires a non-empty value");
  });
});

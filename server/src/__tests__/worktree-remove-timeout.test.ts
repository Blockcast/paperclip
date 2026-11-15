import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKTREE_REMOVE_GIT_TIMEOUT_MS } from "../services/workspace-runtime.js";

// BLO-49622: a `git worktree remove` killed mid-walk deletes the `.git` link
// and leaves the admin registration — the husk every later wake refuses.
// The destructive walk must therefore not run under the 30s probe deadline.
describe("worktree remove deadline (BLO-49622)", () => {
  it("is far above the 30s probe deadline that killed 13% of removals", () => {
    expect(WORKTREE_REMOVE_GIT_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("is the deadline the collector's removal call actually uses", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../services/workspace-runtime.ts", import.meta.url)),
      "utf8",
    );
    const call = src.match(/args: \["worktree", "remove", \.\.\.removeForceArgs, workspacePath\],[\s\S]{0,120}?timeoutMs: (\w+)/);
    expect(call?.[1]).toBe("WORKTREE_REMOVE_GIT_TIMEOUT_MS");
  });
});

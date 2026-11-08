import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// PEN-5982: this suite's slowest tests sit at 60-66% of vitest's 5 s default,
// and a timeout inside a `merge_group` run evicts the PR from the merge queue
// rather than costing a re-run. Lock the raised timeout in so a config cleanup
// cannot silently bring the eviction back. Mirrors the sibling claude-k8s
// guard (BLO-48145).
//
// Read as source text rather than imported: `tsconfig.json` here has
// `include: ["src"]` with `rootDir: "src"` (unlike the claude sibling, which
// excludes tests from tsc), so `import "../vitest.config"` does not typecheck
// and widening `include` would put the file outside `rootDir`.
const CONFIG_PATH = fileURLToPath(
  new URL("../vitest.config.ts", import.meta.url),
);

describe("vitest config (PEN-5982)", () => {
  it("keeps the per-test timeout at 30 s or more", () => {
    const source = readFileSync(CONFIG_PATH, "utf8");
    // Not anchored on a trailing comma: `testTimeout` as the last property
    // carries none, and a correct config should not red the guard. A
    // non-literal form (`30 * 1000`, a named constant) still fails here
    // rather than passing unchecked -- deliberate, and the message says so.
    const match = source.match(/^\s*testTimeout:\s*([\d_]+)\b/m);

    // Fail closed: a config that declares no testTimeout at all has silently
    // fallen back to the 5 s default this guard exists to prevent.
    expect(match, `no testTimeout declared in ${CONFIG_PATH}`).not.toBeNull();

    const timeoutMs = Number(match![1].replace(/_/g, ""));
    expect(timeoutMs).toBeGreaterThanOrEqual(30_000);
  });
});

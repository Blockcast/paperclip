import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // ARC budgets -- rationale in scripts/run-vitest-stable.mjs (BLO-37369),
    // enforced by scripts/__tests__/vitest-project-coverage.test.mjs.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    environment: "node",
  },
});

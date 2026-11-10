import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PEN-6455: hooks in this package spawn processes and create/remove temp
    // trees, and this package had no config at all, so they ran on Vitest's
    // bare 10s hook default. A root CLI --hookTimeout cannot supply one -- it
    // is inert under Vitest 4 `projects` (BLO-37184). Enforced by the real-I/O
    // hook sweep in scripts/__tests__/vitest-project-coverage.test.mjs.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});

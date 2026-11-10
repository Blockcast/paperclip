import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PEN-6455: hooks in this package spawn processes and create/remove temp
    // trees. A root CLI --hookTimeout is inert under Vitest 4 `projects`
    // (BLO-37184), so without this they run on Vitest's bare 10s default --
    // a budget nobody chose, and the one that evicted #3583 from the merge
    // queue. Enforced by the real-I/O hook sweep in
    // scripts/__tests__/vitest-project-coverage.test.mjs.
    hookTimeout: 60_000,
    environment: "node",
    // ACP subprocess startup and repeated auth-merge shell fixtures can exceed
    // Vitest's 5s default when ARC nodes are under I/O contention.
    testTimeout: 30_000,
  },
});

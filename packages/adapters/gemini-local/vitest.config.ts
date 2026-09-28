import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // ARC CPU contention stretches otherwise healthy filesystem/process tests
    // past Vitest's 5s test / 10s hook defaults without indicating a hang. These
    // budgets must live here: a root-level --testTimeout/--hookTimeout does not
    // reach a project config, it is accepted and ignored (BLO-37369).
    testTimeout: 30_000,
    hookTimeout: 60_000,
    environment: "node",
  },
});

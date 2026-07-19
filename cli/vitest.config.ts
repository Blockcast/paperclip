import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Timeouts lifted for ARC self-hosted runners (BLO-17026). Since #712
    // (BLO-16561) moved CI off ubuntu-latest onto the shared ARC pool, the
    // embedded-Postgres + real-git-worktree integration suites here (worktree,
    // routines, configure) run against a far more contended host where
    // embedded-postgres startup + reseed can take ~40s under load — well past
    // the previous 60s ceiling on peak-contention runs. Per-test overrides in
    // the embedded-postgres suites are raised alongside this (Vitest honors a
    // per-test timeout over the global).
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
  },
});

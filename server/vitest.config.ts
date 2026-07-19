import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    globalSetup: ["./vitest.global-setup.ts"],
    setupFiles: ["./src/__tests__/setup-supertest.ts"],

    // Bumped above vitest defaults (5s test / 10s hook / 10s teardown)
    // because many suites here run against an embedded Postgres that
    // takes 6-12s to start on a loaded self-hosted runner and 1-3s to
    // finish each TRUNCATE-based cleanup. The default 10s hookTimeout
    // was the direct cause of 39 skipped tests in secrets-service.test.ts
    // on the 2026-05-18 verify_canary run 26007667963 — the suite's
    // beforeAll never reached the test bodies because embedded-postgres
    // startup raced past the hook deadline. Per-file overrides exist
    // (process-recovery sets beforeAll to 20s, watchdog sets afterEach
    // to 30s) but lifting the baseline avoids retrofitting every suite.
    //
    // 2026-07-18 (BLO-17026): lifted again after #712 (BLO-16561) moved CI
    // off ubuntu-latest onto the shared ARC pool. On that far more contended
    // host embedded-postgres startup climbed to ~40s, so the 30s testTimeout
    // and the tight per-test overrides became the chronic cause of red
    // verify_canary runs (publish/deploy skipped for ~21h). The tight
    // per-test overrides in the embedded-postgres suites are raised alongside
    // this lift, since Vitest honors a per-test timeout over the global.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
  },
});

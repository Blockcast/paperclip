import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",

    // Bumped above vitest defaults (5s test / 10s hook) for the same reason
    // server/vitest.config.ts is — see the two dated notes there. The fence
    // suites construct a fresh PGlite (WASM Postgres) and replay every
    // migration in a per-test `beforeEach`, which is seconds of real work
    // even on an idle host, so 10s is an unconsidered default rather than a
    // budget anyone chose.
    //
    // 2026-09-27 (BLO-37114): this package was the single largest source of
    // merge-queue ejections — 6 of the last 12 `PR`-lane `merge_group`
    // failures were `Hook timed out in 10000ms` at the `beforeEach` of
    // aggregate-fence-restart-safety.test.ts:248 and
    // aggregate-fence-contention.test.ts:236, on workers so contended that
    // the same run reported `import 51.94s`. The test bodies themselves were
    // passing; only the hook deadline was missed. An ejection costs a full
    // re-traverse of a ~64-deep queue, so the default was expensive.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});

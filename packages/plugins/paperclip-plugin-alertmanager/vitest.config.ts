import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",

    // Bumped above vitest defaults (5s test / 10s hook) for the same reason
    // server/vitest.config.ts is — see the two dated notes there. The fence
    // suites construct a fresh PGlite (WASM Postgres) and replay every
    // migration in `migrations/` in a per-FILE `beforeAll`; each case is then
    // handed an empty schema by a TRUNCATE in `beforeEach` (BLO-36739), so the
    // engine starts once per file and not once per case. Measured first-party
    // on an idle host 2026-11-16: that hook costs 2.2–3.4 s, of which the
    // PGlite boot is 94–96% and the 16 migrations are 96–136 ms. The cost is
    // engine startup, it is paid once per test file, and it stretches with
    // whatever else the runner is doing — so 10s is an unconsidered default
    // rather than a budget anyone chose.
    //
    // 2026-09-27 (BLO-37114): this package was the single largest source of
    // merge-queue ejections — 6 of the last 12 `PR`-lane `merge_group`
    // failures were `Hook timed out in 10000ms` at the `beforeEach` of
    // aggregate-fence-restart-safety.test.ts:248 and
    // aggregate-fence-contention.test.ts:236, on workers so contended that
    // the same run reported `import 51.94s`. The test bodies themselves were
    // passing; only the hook deadline was missed. An ejection costs a full
    // re-traverse of a ~64-deep queue, so the default was expensive.
    //
    // 2026-11-16 (PEN-6759): DO NOT PASS A PER-HOOK TIMEOUT ARGUMENT TIGHTER
    // THAN THIS. Five `beforeAll`s carried an explicit `}, 30_000)`, which
    // vitest honours OVER this config, so the hooks that do the most work in
    // this package ran on a quarter of the budget this line chose for this
    // pool — and nothing read the two numbers together. On `merge_group` run
    // 43815231525 three of them crossed it (`Hook timed out in 30000ms`, with
    // 633 tests passed and zero assertions failed), ejecting #3824 from the
    // master queue and discarding a human enqueue act. The control is in the
    // same job: the PGlite suites that INHERIT this number ran slower and
    // survived — `attendance-read` is p50 17.7 s / max 47.7 s over 15
    // merge_group jobs, against 120 s. `vitest-project-coverage.test.mjs` now
    // fails on any booting hook whose explicit argument undercuts its
    // project's configured `hookTimeout`.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});

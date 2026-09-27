import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",

    // Same lift as server/ and paperclip-plugin-alertmanager, but the binding
    // knob is a different one here — read this before removing either line.
    // `startEmbeddedPostgresTestDatabase` boots a real Postgres, which
    // server/vitest.config.ts records taking ~40s on the contended ARC pool.
    // In THIS package 29 of the 30 suites that use it call it from inside an
    // `it()` body (21 directly, 8 through a module-level wrapper the tests
    // call), so `testTimeout` is what actually binds; only
    // pipelines-schema.test.ts boots from a `beforeAll`. That is the reverse
    // of the alertmanager package, where a per-test `beforeEach` makes
    // `hookTimeout` the whole problem.
    //
    // 2026-09-27 (BLO-37114): PRECAUTIONARY, not measured. No `packages/db`
    // timeout appears in the merge-queue failure sample; the package is
    // included because it runs the same embedded Postgres with no timeouts
    // set, and the cost of discovering that the hard way is a full
    // re-traverse of a ~64-deep queue. If one of these ever has to go, drop
    // `hookTimeout` — carried for symmetry and the one `beforeAll` file — and
    // keep `testTimeout`, which is the line doing the work.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});

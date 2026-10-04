import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",

    // Same lift as server/ and paperclip-plugin-alertmanager, but BOTH values
    // are near-inert in this package TODAY — they are here for the suites that
    // come next, not the ones already written. Read this before citing either
    // as the reason an existing test passes.
    // `startEmbeddedPostgresTestDatabase` boots a real Postgres, which
    // server/vitest.config.ts records taking ~40s on the contended ARC pool.
    // In THIS package 30 suites boot it, and a per-call timeout argument
    // overrides the config — which almost every block already passes. Measured
    // 2026-09-27 over those 30 files: 90 of 122 `it`/hook openers close with an
    // explicit timeout, and of the four blocks that do fall through to the
    // values below, NONE boots a database (`backup-lib.test.ts:55` buffered
    // writer; `unjournaled-migrations-apply.test.ts:32`, whose own comment says
    // "Needs no database"; `client.test.ts:126` reads a directory;
    // `pipelines-schema.test.ts:50`, whose boot is in the `beforeAll`).
    // So `testTimeout` reaches no Postgres-booting body at all, and
    // `hookTimeout` reaches exactly one block: the bare `afterEach` at
    // `pool-timeout-bounds.test.ts:49`. In particular it does NOT cover
    // `pipelines-schema.test.ts:41`, the one `beforeAll` boot — that hook
    // closes `}, 60_000)` itself, as does its `afterAll` at :46.
    // Contrast the alertmanager package, where a per-test `beforeEach` closes
    // with no argument and `hookTimeout` is therefore the whole fix.
    //
    // 2026-09-27 (BLO-37114): PRECAUTIONARY, not measured. No `packages/db`
    // timeout appears in the merge-queue failure sample; the package is
    // included because it runs the same embedded Postgres, and the cost of
    // discovering a gap the hard way is a full re-traverse of a ~64-deep queue.
    // Keep both. Neither is load-bearing for an existing test, so removing
    // either changes nothing measurable now — which is exactly why the next
    // suite that forgets its own `}, 60_000)` would land on Vitest's bare 5s
    // test / 10s hook defaults instead. That inheritance is the whole value.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});

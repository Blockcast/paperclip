import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",

    // Same lift as server/ and paperclip-plugin-alertmanager, for the same
    // reason: `startEmbeddedPostgresTestDatabase` boots a real Postgres from
    // a `beforeAll`, which server/vitest.config.ts records taking ~40s on the
    // contended ARC pool — four times the default 10s hookTimeout.
    //
    // 2026-09-27 (BLO-37114): PRECAUTIONARY, not measured. Unlike the
    // alertmanager package, no `packages/db` hook timeout appears in the
    // merge-queue failure sample; this package is included because it has the
    // identical shape (embedded Postgres in a hook, no timeouts set) and the
    // cost of discovering that the hard way is a full re-traverse of a
    // ~64-deep queue. Remove it if it ever gets in the way.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",

    // Bumped above Vitest defaults (5s test / 10s hook) because the
    // aggregate-fence suites spin up a fresh PGlite and apply the full
    // migration set in `beforeEach` (aggregate-fence-restart-safety.test.ts
    // :248, aggregate-fence-contention.test.ts:236). That hook normally
    // finishes in a couple of seconds, but on a contended ARC runner it
    // spikes past the 10s default -- and one timed-out hook fails the whole
    // candidate even though every assertion passed ("1 failed | 353 passed").
    //
    // BLO-22902: this was the single largest source of merge-queue eviction
    // on master. 9 of the 12 `General tests (workspaces-b)` failures sampled
    // 2026-09-18..2026-09-28 carried this exact signature, spread across 11
    // unrelated PRs, and each one burned a ~75-90 min serial build slot
    // (`max_entries_to_build: 1`).
    //
    // These MUST be set here rather than on the command line. CI already runs
    // `vitest run --project paperclip-plugin-alertmanager --hookTimeout=60000`
    // via scripts/run-vitest-stable.mjs (`arcWorkspaceVitestArgs`), but the
    // root config uses `projects:` and a root-level CLI timeout does not
    // propagate into a project's own config. Measured 2026-09-28 (vitest
    // 4.1.8): a probe hook sleeping 12s still died at 10011ms with
    // --hookTimeout=60000 passed explicitly, and passed once the value was set
    // here. So do not "simplify" this away in favour of the CLI flags --
    // they are inert. BLO-37369 tracks that wider defect, which affects every
    // other workspaces-b package too.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

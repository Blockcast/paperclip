import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PEN-6455. This package had no vitest.config.ts at all, so every test and
    // every hook ran on Vitest's bare 5s/10s defaults -- budgets nobody chose.
    // On 2026-11-10 the file-level `afterAll` in github-git-egress-runtime.test.ts,
    // which removes the git fixture repos the file created, crossed the 10s hook
    // default on a contended runner. Every test in the file passed; only the
    // teardown timed out, and GitHub dropped #3583 from the merge queue
    // (`reason: failed_checks`), discarding a ~50 min `merge_group` run.
    //
    // A root CLI flag cannot supply the hook half: `--testTimeout` reaches a
    // project's resolved config under Vitest 4 `projects` and `--hookTimeout`
    // does not (BLO-37184, re-measured on vitest 4.1.8 for PEN-6455 --
    // `--hookTimeout=60000` still reported "Hook timed out in 10000ms", while
    // the same 12s hook passed once the package declared its own).
    //
    // 60s rather than the 120s the Postgres-booting packages use: those budget
    // for a ~40s embedded-postgres startup (BLO-17026) and this package boots
    // no database. Measured cost of the teardown this covers is 291ms for 45
    // git repos of 5 commits each -- 2.4x the fixture count this suite creates
    // -- so 60s is ample headroom for a contention spike without letting a
    // genuinely hung hook sit for two minutes before it reports.
    hookTimeout: 60_000,
    // Declared rather than left to the lane's --testTimeout=30000, so the
    // budget still holds when the suite is run directly, as the sibling guard
    // in scripts/__tests__/vitest-project-coverage.test.mjs reasons for the
    // embedded-Postgres packages.
    testTimeout: 30_000,
  },
});

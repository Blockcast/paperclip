import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// BLO-22902: the aggregate-fence suites in paperclip-plugin-alertmanager build a
// fresh PGlite and apply the full migration set in `beforeEach`. On a contended
// ARC runner that hook overruns Vitest's 10s default `hookTimeout`, and a single
// timed-out hook fails the entire merge-queue candidate while every assertion
// passes ("1 failed | 353 passed"). Measured 2026-09-18..2026-09-28, that one
// signature accounted for 9 of the 12 sampled `General tests (workspaces-b)`
// failures, spread across 11 unrelated PRs, each burning a ~75-90 min serial
// build slot under `max_entries_to_build: 1`.
//
// The budget MUST be declared in the package's own vitest.config.ts.
// scripts/run-vitest-stable.mjs already passes `--testTimeout=30000
// --hookTimeout=60000` for this lane (`arcWorkspaceVitestArgs`, applied to every
// `general-workspaces-b` project) and those flags are INERT: the root config
// uses `projects:`, and a root-level CLI timeout does not propagate into a
// project's own config. Verified experimentally on vitest 4.1.8 -- a probe
// `beforeEach` sleeping 12s still died at 10011ms with `--hookTimeout=60000`
// passed explicitly, and passed once the value was set in the package config.
// BLO-37369 tracks that wider defect, which affects every workspaces-b package.
//
// This test does not re-run that experiment; it guards the fix from being
// silently reverted by someone who reads the CLI flags and concludes the
// package-level values are redundant. They are not.

const VITEST_DEFAULT_HOOK_TIMEOUT_MS = 10_000;
const VITEST_DEFAULT_TEST_TIMEOUT_MS = 5_000;

const config = readFileSync(
  new URL("../../packages/plugins/paperclip-plugin-alertmanager/vitest.config.ts", import.meta.url),
  "utf8",
);

/** Reads `name: 12_345,` / `name: 12345,` out of the config source. */
function readTimeout(name) {
  const match = config.match(new RegExp(`${name}\\s*:\\s*([0-9_]+)`));
  assert.ok(
    match,
    `packages/plugins/paperclip-plugin-alertmanager/vitest.config.ts must declare \`${name}\`. ` +
      "Do not rely on the --testTimeout/--hookTimeout flags in scripts/run-vitest-stable.mjs: " +
      "they do not reach a project config (BLO-22902, BLO-37369).",
  );
  return Number(match[1].replaceAll("_", ""));
}

test("alertmanager declares a hookTimeout above the Vitest default", () => {
  const hookTimeout = readTimeout("hookTimeout");
  assert.ok(
    hookTimeout > VITEST_DEFAULT_HOOK_TIMEOUT_MS,
    `hookTimeout must exceed Vitest's ${VITEST_DEFAULT_HOOK_TIMEOUT_MS}ms default so the PGlite ` +
      `beforeEach survives ARC contention; got ${hookTimeout}ms.`,
  );
});

test("alertmanager declares a testTimeout above the Vitest default", () => {
  const testTimeout = readTimeout("testTimeout");
  assert.ok(
    testTimeout > VITEST_DEFAULT_TEST_TIMEOUT_MS,
    `testTimeout must exceed Vitest's ${VITEST_DEFAULT_TEST_TIMEOUT_MS}ms default; got ${testTimeout}ms.`,
  );
});

test("the aggregate-fence suites still build their database in a per-test hook", () => {
  // If these suites ever stop paying per-test PGlite setup -- e.g. they move to
  // a `beforeAll` -- the timeouts above are no longer load-bearing and this
  // guard should be revisited rather than cargo-culted forward.
  const suites = [
    "aggregate-fence-restart-safety.test.ts",
    "aggregate-fence-contention.test.ts",
  ];

  const stillUsesPerTestSetup = suites.some((suite) => {
    const source = readFileSync(
      new URL(
        `../../packages/plugins/paperclip-plugin-alertmanager/src/__tests__/${suite}`,
        import.meta.url,
      ),
      "utf8",
    );
    return /beforeEach\(async \(\) => \{[\s\S]{0,200}?new PGlite\(\)/.test(source);
  });

  assert.ok(
    stillUsesPerTestSetup,
    "Neither aggregate-fence suite builds a PGlite in `beforeEach` any more. The timeout " +
      "budget in vitest.config.ts was justified by that setup cost (BLO-22902) -- re-check " +
      "whether it is still needed instead of leaving this guard asserting a dead premise.",
  );
});

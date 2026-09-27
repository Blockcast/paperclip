#!/usr/bin/env node
/**
 * check-embedded-db-vitest-timeouts.test.mjs
 *
 * Guards the fix in BLO-37114: the packages whose suites boot a real embedded
 * database must declare their OWN `testTimeout`/`hookTimeout`, above Vitest's
 * bare 5s/10s defaults.
 *
 * Why a guard is needed at all — the protection is not where it looks like it
 * is. `scripts/run-vitest-stable.mjs` passes `--testTimeout=30000
 * --hookTimeout=60000` for the general-workspaces-b group, and under Vitest 4
 * `projects` those ROOT CLI flags never reach a project's resolved config
 * (BLO-37184). So every package in that group silently runs on the defaults no
 * matter what the runner asks for, and the only thing that binds is a value in
 * the package's own vitest.config.ts.
 *
 * That makes deleting one of these values a SILENT regression: nothing fails at
 * the point of deletion, the runner still prints the flags it is passing, and
 * the cost surfaces later as a merge-queue ejection. Measured 2026-09-27, the
 * alertmanager fence suites were the single largest source of those ejections —
 * `Hook timed out in 10000ms`, the bare default, at the per-test `beforeEach`
 * of aggregate-fence-restart-safety.test.ts, on workers contended enough that
 * the same run reported `import 51.94s`. An ejection costs a full re-traverse
 * of a ~64-deep queue.
 *
 * Deliberately NOT a glob over every vitest.config.ts. The two packages are
 * named because the claim is specific — these boot a real database — and a
 * repo-wide floor would be a different, unmeasured policy. Add a package here
 * when it starts booting one.
 *
 * ponytail: text-scan rather than importing the TS config, so this stays a
 * dependency-free `node --test` with no transpile step. Upgrade to a real
 * import if these configs ever become computed rather than literal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Vitest's own bare defaults — the values that bind when nothing else does.
const VITEST_DEFAULT_TEST_TIMEOUT_MS = 5_000;
const VITEST_DEFAULT_HOOK_TIMEOUT_MS = 10_000;

const EMBEDDED_DB_PACKAGES = [
  'packages/db',
  'packages/plugins/paperclip-plugin-alertmanager',
];

/**
 * Reads a `<key>: <number>` literal out of a config source. Returns null when
 * the key is absent or is not a plain numeric literal — both of which this
 * guard must treat as "not declared", since a computed value is exactly the
 * case the text scan cannot honestly vouch for.
 */
export function readTimeoutLiteral(source, key) {
  const match = source.match(new RegExp(`^\\s*${key}\\s*:\\s*([0-9_]+)\\s*,`, 'm'));
  if (!match) return null;
  const digits = match[1].replace(/_/g, '');
  if (digits === '') return null;
  return Number(digits);
}

test('readTimeoutLiteral parses, and refuses what it cannot vouch for', () => {
  assert.equal(readTimeoutLiteral('    testTimeout: 60_000,\n', 'testTimeout'), 60000);
  assert.equal(readTimeoutLiteral('    hookTimeout: 120000,\n', 'hookTimeout'), 120000);
  // Absent key.
  assert.equal(readTimeoutLiteral('    environment: "node",\n', 'testTimeout'), null);
  // Computed value — must NOT be read as a declared number.
  assert.equal(readTimeoutLiteral('    testTimeout: BASE * 2,\n', 'testTimeout'), null);
  // A key that merely appears inside prose must not be mistaken for a setting.
  assert.equal(readTimeoutLiteral('    // testTimeout: 60_000 is inert here\n', 'testTimeout'), null);
});

for (const pkg of EMBEDDED_DB_PACKAGES) {
  test(`${pkg} declares its own Vitest timeouts above the bare defaults`, () => {
    const configPath = join(repoRoot, pkg, 'vitest.config.ts');
    const source = readFileSync(configPath, 'utf8');

    const testTimeout = readTimeoutLiteral(source, 'testTimeout');
    const hookTimeout = readTimeoutLiteral(source, 'hookTimeout');

    assert.notEqual(
      testTimeout,
      null,
      `${pkg}/vitest.config.ts declares no literal testTimeout. The root ` +
        `--testTimeout flag in scripts/run-vitest-stable.mjs does NOT reach it ` +
        `(BLO-37184), so removing this drops the package to Vitest's ` +
        `${VITEST_DEFAULT_TEST_TIMEOUT_MS}ms default silently.`,
    );
    assert.notEqual(
      hookTimeout,
      null,
      `${pkg}/vitest.config.ts declares no literal hookTimeout. This is the ` +
        `value that was missing when the alertmanager fence suites ejected ` +
        `merge-queue PRs with "Hook timed out in ` +
        `${VITEST_DEFAULT_HOOK_TIMEOUT_MS}ms" (BLO-37114).`,
    );

    assert.ok(
      testTimeout > VITEST_DEFAULT_TEST_TIMEOUT_MS,
      `${pkg} testTimeout is ${testTimeout}ms, at or below Vitest's ` +
        `${VITEST_DEFAULT_TEST_TIMEOUT_MS}ms default — booting a real embedded ` +
        `database alone takes ~40s on the contended ARC pool.`,
    );
    assert.ok(
      hookTimeout > VITEST_DEFAULT_HOOK_TIMEOUT_MS,
      `${pkg} hookTimeout is ${hookTimeout}ms, at or below Vitest's ` +
        `${VITEST_DEFAULT_HOOK_TIMEOUT_MS}ms default — this is the exact value ` +
        `that failed in merge_group run 36353732315.`,
    );
  });
}

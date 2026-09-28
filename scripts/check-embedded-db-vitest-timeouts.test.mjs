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
 * Deliberately NOT a glob over every vitest.config.ts. The three packages are
 * named because the claim is specific — these boot a real database — and a
 * repo-wide floor would be a different, unmeasured policy. Add a package here
 * when it starts booting one.
 *
 * ponytail: text-scan rather than importing the TS config, so this stays a
 * dependency-free `node --test` with no transpile step. Comments and string
 * bodies are blanked before scanning, so the real ceiling is a config that
 * computes these values rather than writing literals — handled deliberately by
 * the `null` path tested below, and failing CLOSED. Placement, not
 * computation, was the hole that fails silently; that is what the `test: {}`
 * scoping closes.
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
  // 237 of server's test files reach `startEmbeddedPostgresTestDatabase`/`new
  // PGlite(` — the largest exposure of the three, and the precedent the other
  // two configs cite. Its run path passes no timeout flags at all
  // (`serializedServerVitestArgs` in run-vitest-stable.mjs is only
  // `--no-file-parallelism --maxWorkers=1`), so its config file is the single
  // thing holding these values.
  'server',
];

/**
 * Blanks out comments and string/template bodies, preserving offsets and line
 * structure. Brace-matching and key-matching both run over this, so neither a
 * `}` inside a comment (packages/db/vitest.config.ts has several, quoting
 * `}, 60_000)`) nor a key name inside prose can be mistaken for code.
 */
export function blankNonCode(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') out += (i++, ' ');
      continue;
    }
    if (char === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += i < source.length ? '  ' : '';
      i += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      out += ' ';
      i++;
      while (i < source.length && source[i] !== char) {
        if (source[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += i < source.length ? ' ' : '';
      i++;
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

/**
 * Returns the body of the top-level `test: { ... }` block, or null if it cannot
 * be delimited. Scoping matters: Vitest ignores `testTimeout`/`hookTimeout`
 * written anywhere else in `defineConfig`, so a key matched outside this block
 * is not a setting — it is the exact silent misconfiguration this guard exists
 * to catch.
 */
export function extractTestBlock(source) {
  const code = blankNonCode(source);
  const open = code.match(/^\s*test\s*:\s*\{/m);
  if (!open) return null;
  const start = open.index + open[0].length;
  let depth = 1;
  let i = start;
  while (i < code.length && depth > 0) {
    const char = code[i++];
    if (char === '{') depth++;
    else if (char === '}') depth--;
  }
  return depth === 0 ? code.slice(start, i - 1) : null;
}

/**
 * Reads a `<key>: <number>` literal out of a `test: {}` block body. Returns
 * null when the key is absent or is not a plain numeric literal — both of which
 * this guard must treat as "not declared", since a computed value is exactly
 * the case the text scan cannot honestly vouch for.
 */
export function readTimeoutLiteral(source, key) {
  const match = source.match(new RegExp(`^\\s*${key}\\s*:\\s*([0-9_]+)\\s*[,}\\n]`, 'm'));
  if (!match) return null;
  const digits = match[1].replace(/_/g, '');
  if (digits === '') return null;
  return Number(digits);
}

test('extractTestBlock scopes to the block Vitest actually reads', () => {
  const inside = 'export default defineConfig({\n  test: {\n    testTimeout: 60_000,\n  },\n});\n';
  assert.equal(readTimeoutLiteral(extractTestBlock(inside), 'testTimeout'), 60000);
  // Misplaced at the top level of defineConfig: Vitest ignores it entirely and
  // the package silently drops to the bare defaults. Must NOT read as declared.
  const misplaced = 'export default defineConfig({\n  testTimeout: 60_000,\n  test: {\n    environment: "node",\n  },\n});\n';
  assert.equal(readTimeoutLiteral(extractTestBlock(misplaced) ?? '', 'testTimeout'), null);
  // No test block at all.
  assert.equal(extractTestBlock('export default defineConfig({});\n'), null);
});

test('readTimeoutLiteral parses, and refuses what it cannot vouch for', () => {
  assert.equal(readTimeoutLiteral('    testTimeout: 60_000,\n', 'testTimeout'), 60000);
  assert.equal(readTimeoutLiteral('    hookTimeout: 120000,\n', 'hookTimeout'), 120000);
  // Final property with no trailing comma still reads — erring closed here would
  // report "declares no literal hookTimeout" about a file that plainly declares one.
  assert.equal(readTimeoutLiteral('    hookTimeout: 120_000\n  }', 'hookTimeout'), 120000);
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

    const testBlock = extractTestBlock(source);
    assert.notEqual(
      testBlock,
      null,
      `${pkg}/vitest.config.ts has no delimitable top-level \`test: { ... }\` ` +
        `block, so no timeout written in it can be verified — and any written ` +
        `outside it is ignored by Vitest.`,
    );

    const testTimeout = readTimeoutLiteral(testBlock, 'testTimeout');
    const hookTimeout = readTimeoutLiteral(testBlock, 'hookTimeout');

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

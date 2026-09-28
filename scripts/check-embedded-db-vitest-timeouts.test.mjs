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
 * Deliberately NOT a glob over every vitest.config.ts. The four packages are
 * named because the claim is specific — these boot a real database — and a
 * repo-wide floor would be a different, unmeasured policy. Add a package here
 * when it starts booting one.
 *
 * ponytail: text-scan rather than importing the TS config, so this stays a
 * dependency-free `node --test` with no transpile step. Comments and string
 * bodies are blanked before scanning, so the real ceiling is a config that
 * computes these values rather than writing literals — handled deliberately by
 * the `null` path tested below, and failing CLOSED. Placement was the hole that
 * fails silently, and it is closed at ALL THREE levels: outside `test: {}`,
 * inside a nested child of it (`sequence`, `poolOptions.forks`, `coverage`)
 * where Vitest equally ignores the key, and — when a file holds more than one
 * `test: {}` — in a block Vitest never reads. Four known ceilings, all failing
 * CLOSED: a computed value; more than one `test: {}` in the file (a shared base
 * object, a `mergeConfig` source), where which block binds cannot be decided
 * without resolving the config, so the scan refuses instead of guessing the
 * first — counted ANCHORLESS, because a line-anchored count misses the
 * anchored-base/inline-export orientation and selects the dead block; a regex
 * literal containing a quote character (`blankNonCode` does not lex regexes, so
 * it reads on into string-blanking mode); and a key sharing its source line
 * with anything else, since `readTimeoutLiteral` is line-anchored
 * (`environment: "node", testTimeout: 60_000,` reads as undeclared). Each
 * surfaces as a loud `null`, never as a false green.
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
  // PGlite(` — the largest exposure of the four, and the precedent the other
  // configs cite. Its run path passes no timeout flags at all
  // (`serializedServerVitestArgs` in run-vitest-stable.mjs is only
  // `--no-file-parallelism --maxWorkers=1`), so its config file is the single
  // thing holding these values.
  'server',
  // Same shape as server, one package out: `startEmbeddedPostgresTestDatabase`
  // at five call sites across worktree/routines/company-import-export, and its
  // own config names "the embedded-Postgres + real-git-worktree integration
  // suites here". Runs as project `paperclipai` in group A, invoked with the
  // same `serializedServerVitestArgs` — so no CLI fallback here either.
  'cli',
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
 * Returns the body of the file's sole `test: { ... }` block with every nested
 * child object blanked, or null if it cannot be delimited or cannot be
 * identified unambiguously. Scoping matters three times over: Vitest ignores
 * `testTimeout`/`hookTimeout` written anywhere else in `defineConfig`, ignores
 * them inside a child of `test` such as `sequence: {}` or
 * `poolOptions: { forks: {} }`, and — when the file holds more than one
 * `test: {}` — only one of those blocks is the exported one. All three read as
 * "declared" to a naive scan while the package silently runs at 5s/10s — the
 * exact misconfiguration this guard exists to catch. Newlines survive blanking
 * so the line-anchored key match stays aligned.
 */
export function extractTestBlock(source) {
  const code = blankNonCode(source);
  // More than one candidate block and we cannot tell which one Vitest reads
  // without resolving `defineConfig`/`mergeConfig`/spreads. Refuse rather than
  // guess: guessing the first would scan a shared base object whose timeouts
  // bind nothing, and report a package as covered while it runs at 5s/10s.
  // Counted WITHOUT the line anchor the selection match below uses, on purpose.
  // Anchoring the count reopens the hole one orientation out: a line-anchored
  // base block plus an INLINE exported one counts 1, the guard stays quiet, and
  // the base block is selected. `\b` keeps `latest:` and friends out.
  if ((code.match(/\btest\s*:\s*\{/g) ?? []).length > 1) return null;
  const open = code.match(/^\s*test\s*:\s*\{/m);
  if (!open) return null;
  const start = open.index + open[0].length;
  let depth = 1;
  let i = start;
  let out = '';
  while (i < code.length && depth > 0) {
    const char = code[i++];
    const before = depth;
    if (char === '{') depth++;
    else if (char === '}') depth--;
    if (depth === 0) break;
    // `before > 1` blanks a child's closing brace too, so no stray `}` leaks
    // back into the body at depth 1.
    out += (before > 1 || depth > 1) && char !== '\n' ? ' ' : char;
  }
  return depth === 0 ? out : null;
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

test('extractTestBlock blanks nested children of test: {}', () => {
  // Inside `sequence: {}` — a block `server/vitest.config.ts` really carries.
  // Vitest drops the package to 5s/10s; must NOT read as declared.
  const nested = [
    'export default defineConfig({',
    '  test: {',
    '    sequence: {',
    '      testTimeout: 60_000,',
    '    },',
    '  },',
    '});',
    '',
  ].join('\n');
  assert.equal(readTimeoutLiteral(extractTestBlock(nested) ?? '', 'testTimeout'), null);
  // Two levels down, where pool tuning conventionally goes.
  const pool = [
    'export default defineConfig({',
    '  test: {',
    '    poolOptions: { forks: {',
    '      hookTimeout: 120_000,',
    '    } },',
    '  },',
    '});',
    '',
  ].join('\n');
  assert.equal(readTimeoutLiteral(extractTestBlock(pool) ?? '', 'hookTimeout'), null);
  // A sibling at the block's own depth still reads, with a child present.
  const both = [
    'export default defineConfig({',
    '  test: {',
    '    sequence: { hooks: "list" },',
    '    testTimeout: 60_000,',
    '  },',
    '});',
    '',
  ].join('\n');
  assert.equal(readTimeoutLiteral(extractTestBlock(both), 'testTimeout'), 60000);
});

test('extractTestBlock refuses a file with more than one test: {} block', () => {
  // A shared base object whose timeouts are never spread into the exported
  // config. Taking the FIRST block reads 120_000/120_000 off `base` and reports
  // the package as covered while Vitest runs it at 5s/10s — a false green over
  // precisely the regression this guard exists to stop.
  //
  // Both orientations are fixtures because the multiplicity count and the
  // selection match use DIFFERENT regexes: the count is anchorless, selection
  // is line-anchored. Shape C is the one a line-anchored COUNT misses — it
  // counts 1, so the guard stays quiet and selects the dead base block.
  const twoBlocksAnchored = [
    'const base = {',
    '  test: {',
    '    testTimeout: 120_000,',
    '    hookTimeout: 120_000,',
    '  },',
    '};',
    'export default defineConfig({',
    '  test: {',
    '    environment: "node",',
    '  },',
    '});',
    '',
  ].join('\n');
  assert.equal(extractTestBlock(twoBlocksAnchored), null);
  assert.equal(readTimeoutLiteral(extractTestBlock(twoBlocksAnchored) ?? '', 'testTimeout'), null);

  // Shape C: line-anchored base, INLINE export. Measured at 08352aac this read
  // testTimeout=120000 hookTimeout=120000 off `base` and passed green.
  const anchoredBaseInlineExport = [
    'const base = {',
    '  test: {',
    '    testTimeout: 120_000,',
    '    hookTimeout: 120_000,',
    '  },',
    '};',
    'export default defineConfig({ test: { environment: "node" } });',
    '',
  ].join('\n');
  assert.equal(extractTestBlock(anchoredBaseInlineExport), null);
  assert.equal(
    readTimeoutLiteral(extractTestBlock(anchoredBaseInlineExport) ?? '', 'testTimeout'),
    null,
  );

  // Fully inline: never reached a false green even before the anchorless count,
  // because the line-anchored SELECTION match finds nothing and returns null.
  // Kept as a fixture so that path stays covered if the anchors ever move.
  const bothInline =
    'const base = { test: { testTimeout: 120_000 } };\n' +
    'export default defineConfig({ test: { environment: "node" } });\n';
  assert.equal(extractTestBlock(bothInline), null);
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

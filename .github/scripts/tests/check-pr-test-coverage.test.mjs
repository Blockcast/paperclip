import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTestCoverage, retitleGateNote } from '../check-pr-test-coverage.mjs';
import { SKIP_PREFIXES as DEDUP_SKIP_PREFIXES } from '../check-pr-dedup-search.mjs';
import { SKIP_ISSUE_PREFIXES } from '../check-pr-linked-issue.mjs';

const makeFiles = (filenames) =>
  filenames.map(filename => ({ filename, status: 'modified' }));

// Existing tests with title parameter added (fix: prefix means test required)

test('passes when .test.ts file is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/foo.test.ts', 'src/foo.ts']), 'fix: bug').passed, true);
});

test('passes when .spec.js file is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/bar.spec.js']), 'fix: bug').passed, true);
});

test('passes when file under tests/ is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['tests/unit/baz.ts']), 'fix: bug').passed, true);
});

test('passes when file under __tests__ is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/__tests__/qux.ts']), 'fix: bug').passed, true);
});

// The repo's Node-native suites are `*.test.mjs` — 38 of them, including this
// checker's own tests. They were invisible to TEST_PATTERNS, so a PR whose only
// tests used that convention was told "no test files detected" (BLO-18484).
test('passes when .test.mjs file is changed', () => {
  assert.equal(
    checkTestCoverage(makeFiles(['scripts/gh-token-wrapper.test.mjs', 'Dockerfile.runtime']), 'fix: bug').passed,
    true,
  );
});

test('passes when .spec.cjs file is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['scripts/thing.spec.cjs']), 'fix: bug').passed, true);
});

// `unittest`'s discovery convention is `test_*.py`, and review-gate-sweep.yml
// discovers with exactly that pattern. None of the JS patterns above match it.
test('passes when a test_*.py file is changed', () => {
  assert.equal(
    checkTestCoverage(makeFiles(['.github/scripts/test_sweep_stalled_ally_reviews.py']), 'fix: bug').passed,
    true,
  );
});

test('passes when a *_test.py file is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['scripts/sweep_test.py']), 'fix: bug').passed, true);
});

// The exact shape that failed before this widening: a fix: PR whose only files
// are a Python script and its Python tests. The no-tests arm fires whenever a
// non-skip-prefixed PR matches no test file at all, so this failed regardless of
// the fact that 273 lines of tests were right there in the diff.
test('passes on a fix: PR touching only a Python script and its test', () => {
  assert.equal(
    checkTestCoverage(
      makeFiles([
        '.github/scripts/sweep-stalled-ally-reviews.py',
        '.github/scripts/test_sweep_stalled_ally_reviews.py',
        '.github/workflows/review-gate-sweep.yml',
      ]),
      'fix(review-gate-sweep): re-read markers before the write',
    ).passed,
    true,
  );
});

// Negative control: widening for Python must not make *every* .py file count as
// a test. Without this, a pattern as loose as /\.py$/ would pass the suite while
// silently disabling the gate for the whole language.
test('a non-test .py file does not satisfy the gate', () => {
  const result = checkTestCoverage(
    makeFiles(['.github/scripts/sweep-stalled-ally-reviews.py']),
    'fix: bug',
  );
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('No test files detected'));
});

// `contest.py` / `latest.py` end in the letters `test.py` but are not tests; the
// `_` in the pattern is what keeps them out.
test('a .py file merely ending in test.py does not satisfy the gate', () => {
  assert.equal(checkTestCoverage(makeFiles(['scripts/latest.py']), 'fix: bug').passed, false);
});

test('a .test.mjs file does not count as a source change on a docs: PR', () => {
  // isSourceFile() excludes anything matching TEST_PATTERNS, so widening the
  // patterns must also keep .test.mjs out of the docs/chore mismatch check.
  assert.equal(checkTestCoverage(makeFiles(['README.md', 'scripts/x.test.mjs']), 'docs: update').passed, true);
});

test('a non-test .mjs file still counts as a source change on a docs: PR', () => {
  const result = checkTestCoverage(makeFiles(['README.md', 'scripts/x.mjs']), 'docs: update');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('source code changes'));
});

test('fails when fix: PR has no tests', () => {
  const result = checkTestCoverage(makeFiles(['src/foo.ts', 'src/bar.ts']), 'fix: bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('test'));
});

test('fails when feat: PR has no tests', () => {
  const result = checkTestCoverage(makeFiles(['src/foo.ts']), 'feat: new feature');
  assert.equal(result.passed, false);
});

test('fails with empty file list and fix: prefix', () => {
  assert.equal(checkTestCoverage([], 'fix: bug').passed, false);
});

test('ignores removed test files', () => {
  const files = [
    { filename: 'src/foo.test.ts', status: 'removed' },
    { filename: 'src/foo.ts', status: 'modified' },
  ];
  assert.equal(checkTestCoverage(files, 'fix: bug').passed, false);
});

// New tests for prefix-aware skip behavior

test('skips test requirement for docs: prefix (markdown only)', () => {
  assert.equal(checkTestCoverage(makeFiles(['README.md', 'docs/setup.md']), 'docs: update guide').passed, true);
});

test('skips test requirement for chore: prefix (config only)', () => {
  assert.equal(checkTestCoverage(makeFiles(['.gitignore', '.github/labels.yml']), 'chore: cleanup').passed, true);
});

test('skips test requirement for refactor: prefix', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/foo.ts']), 'refactor: rename function').passed, true);
});

test('skips test requirement for style: prefix', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/foo.ts']), 'style: format').passed, true);
});

// New tests for mismatch detection

test('flags docs: PR with source code changes', () => {
  const result = checkTestCoverage(makeFiles(['src/api.ts', 'README.md']), 'docs: update docs');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('docs:'));
  assert.ok(result.failures[0].includes('source code'));
});

test('flags chore: PR with source code changes', () => {
  const result = checkTestCoverage(makeFiles(['src/server.ts']), 'chore: cleanup');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('chore:'));
});

test('does NOT flag chore: PR with only config files', () => {
  const result = checkTestCoverage(makeFiles(['package.json', '.eslintrc.js']), 'chore: bump');
  // .eslintrc.js is a .js file but it's config — current rule will flag it. This documents that.
  // For now we err on the side of flagging — contributor can retitle if needed.
  assert.equal(result.passed, false);
});

test('does NOT flag refactor: PR with source code (refactor expects source changes)', () => {
  const result = checkTestCoverage(makeFiles(['src/foo.ts']), 'refactor: rename');
  assert.equal(result.passed, true);
});

test('requires test when no prefix used', () => {
  const result = checkTestCoverage(makeFiles(['src/foo.ts']), 'Some PR with no prefix');
  assert.equal(result.passed, false);
});

test('handles scoped prefix like fix(server):', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/foo.test.ts', 'src/foo.ts']), 'fix(server): bug').passed, true);
});

// PEN-6323: the retitle advice is composition-aware.
//
// Both retitle suggestions in this gate point authors OUT of the dedup-search
// and linked-issue gates' skip sets, so an author who obeyed the advice exactly
// traded one red gate for two others the comment never mentioned. The advice now
// names what the retitle will newly require. These tests pin that against the
// sibling gates' REAL exported skip lists, so the claim cannot go stale silently.

test('mismatch advice names the gates the suggested prefixes do NOT skip', () => {
  const result = checkTestCoverage(makeFiles(['server/src/api.ts', 'README.md']), 'docs: update');
  assert.equal(result.passed, false);
  const [failure] = result.failures;
  assert.ok(failure.includes('dedup-search'), `missing dedup-search note: ${failure}`);
  assert.ok(failure.includes('linked-issue'), `missing linked-issue note: ${failure}`);
  assert.ok(failure.includes('also need'), `missing consequence clause: ${failure}`);
});

test('no-tests advice names them too when the current prefix IS exempt', () => {
  // `test:` skips dedup-search and linked-issue but does NOT skip this gate, so
  // a `test:` PR with no test file is told to retitle `refactor:` — which leaves
  // both skip sets.
  const result = checkTestCoverage(makeFiles(['server/src/api.ts']), 'test: tidy up');
  assert.equal(result.passed, false);
  const [failure] = result.failures;
  assert.ok(failure.includes('dedup-search'), `missing dedup-search note: ${failure}`);
  assert.ok(failure.includes('linked-issue'), `missing linked-issue note: ${failure}`);
});

test('no note when the current prefix is already subject to those gates', () => {
  // `fix:` is in neither skip set, so retitling to `refactor:` adds nothing —
  // the note would be noise, not news.
  const [failure] = checkTestCoverage(makeFiles(['server/src/api.ts']), 'fix: bug').failures;
  assert.ok(!failure.includes('also need'), `unexpected note: ${failure}`);
});

test('no note when the title carries no prefix at all', () => {
  const [failure] = checkTestCoverage(makeFiles(['server/src/api.ts']), 'Some PR').failures;
  assert.ok(!failure.includes('also need'), `unexpected note: ${failure}`);
});

test('retitleGateNote is empty when every suggested prefix is also exempt', () => {
  // Discriminating control: the helper must be able to return nothing, or the
  // assertions above are satisfied by a constant.
  assert.equal(retitleGateNote('docs', ['chore']), '');
  assert.equal(retitleGateNote('docs', ['chore', 'ci']), '');
});

test('retitleGateNote claims a gate IFF a suggested prefix leaves its skip set', () => {
  // Computed against the sibling gates' real lists rather than a copy of them,
  // so this stays true if either list changes — and reds if the note generator
  // starts claiming a gate that does apply, or stops claiming one that does not.
  const gates = [
    { skip: DEDUP_SKIP_PREFIXES, requirement: 'the dedup-search checkbox' },
    { skip: SKIP_ISSUE_PREFIXES, requirement: 'a linked issue' },
  ];
  for (const current of ['docs', 'chore', 'build', 'ci', 'fix', 'feat', 'test']) {
    for (const suggestions of [['fix', 'feat', 'refactor'], ['refactor']]) {
      const note = retitleGateNote(current, suggestions);
      for (const gate of gates) {
        const shouldClaim =
          gate.skip.includes(current) && suggestions.some(p => !gate.skip.includes(p));
        assert.equal(
          note.includes(gate.requirement),
          shouldClaim,
          `current=${current} suggestions=${suggestions} gate=${gate.requirement} note=${note}`,
        );
      }
    }
  }
});

test('the advised prefixes are exactly the ones named in the advice text', () => {
  // Today's configuration, asserted literally. If a sibling gate's skip list
  // gains one of these prefixes this reds loudly, which is the point: the advice
  // text is then claiming a requirement that no longer applies.
  const [failure] = checkTestCoverage(makeFiles(['server/src/api.ts']), 'docs: update').failures;
  for (const p of ['`fix:`', '`feat:`', '`refactor:`']) {
    assert.ok(failure.includes(p), `advice no longer names ${p}: ${failure}`);
  }
  assert.ok(
    failure.includes('the dedup-search checkbox and a linked issue'),
    `unexpected requirement wording: ${failure}`,
  );
});

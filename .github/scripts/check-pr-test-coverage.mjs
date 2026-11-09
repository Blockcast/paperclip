#!/usr/bin/env node
/**
 * check-pr-test-coverage.mjs
 * Checks that a PR diff includes at least one test file. Respects conventional
 * commit prefixes — skips check for docs/chore/build/ci/style/refactor PRs.
 * Also detects mismatch: docs/chore PRs that contain real source code changes.
 * Export: checkTestCoverage(files, prTitle) → { passed, failures }
 */
import { fileURLToPath } from 'node:url';
import { SKIP_PREFIXES as DEDUP_SKIP_PREFIXES } from './check-pr-dedup-search.mjs';
import { SKIP_ISSUE_PREFIXES } from './check-pr-linked-issue.mjs';

// `.mjs`/`.cjs` are included deliberately: the repo's own Node-native suites use
// `*.test.mjs` (38 of them, including this checker's tests and everything run by
// the `node --test` steps in pr.yml). Omitting them made the gate report "no test
// files detected" on PRs whose only tests were written in that convention.
//
// The `unittest` patterns are here for the same reason, one language over. The
// repo runs Python suites too — `.github/workflows/review-gate-sweep.yml` invokes
// `unittest discover -p 'test_sweep_*.py'` — and `unittest`'s own discovery
// convention is `test_*.py`, which none of the JS patterns match. Because the
// no-tests arm fires whenever a non-skip-prefixed PR contains no matching file at
// all (regardless of whether any *source* file changed), the omission failed every
// Python-only PR unconditionally, and pushed authors toward a false `refactor:`
// retitle rather than toward writing tests — inverting the gate's own purpose
// (BLO-19152 recorded that inversion for the `.mjs` case). `*_test.py` is accepted
// alongside it for symmetry with the `.test.*` convention above.
const TEST_PATTERNS = [
  /\.test\.(ts|js|tsx|jsx|mjs|cjs)$/,
  /\.spec\.(ts|js|tsx|jsx|mjs|cjs)$/,
  /(?:^|\/)tests?\//,
  /\/__tests__\//,
  /(?:^|\/)test_[^/]*\.py$/,
  /_test\.py$/,
];

const SOURCE_CODE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

// Prefixes where test coverage is NOT required
const SKIP_TEST_PREFIXES = ['docs', 'chore', 'build', 'ci', 'style', 'refactor', 'revert'];

// Prefixes where source code changes are NOT expected (mismatch detection)
// Note: 'style' is excluded — formatting PRs legitimately touch source files
const NO_SOURCE_CODE_PREFIXES = ['docs', 'chore', 'build', 'ci'];

// The prefixes this gate suggests an author retitle to. Declared once so the
// advice text and the side-effect note below cannot drift apart.
const MISMATCH_RETITLE_SUGGESTIONS = ['fix', 'feat', 'refactor'];
const NO_TESTS_RETITLE_SUGGESTIONS = ['refactor'];

// Other gates in `run-quality-gates.mjs` are ALSO prefix-sensitive, and their
// skip sets are not this one's. Every prefix this gate suggests is outside the
// dedup-search and linked-issue skip sets, so an author on a `docs:`/`chore:`/
// `build:`/`ci:` PR who follows the advice exactly trades the mismatch failure
// for a missing-dedup-checkbox failure and a missing-linked-issue failure the
// comment never mentioned (PEN-6323). Each gate's remedy text is correct about
// its own gate and silent about the composition; the aggregator prints them all
// and reconciles none.
//
// The skip sets are IMPORTED, not restated, so this note cannot go stale when a
// sibling gate's list changes: a prefix added to one of those lists drops out of
// `notExempt` and stops being claimed.
const TITLE_SENSITIVE_GATES = [
  {
    name: 'dedup-search',
    skipPrefixes: DEDUP_SKIP_PREFIXES,
    requirement: 'the dedup-search checkbox',
  },
  {
    name: 'linked-issue',
    skipPrefixes: SKIP_ISSUE_PREFIXES,
    requirement: 'a linked issue (or an inline issue description)',
  },
];

function formatPrefixList(prefixes) {
  const quoted = prefixes.map(p => `\`${p}:\``);
  if (quoted.length === 1) return quoted[0];
  if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(', ')}, or ${quoted[quoted.length - 1]}`;
}

function formatList(items) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Sentence naming what a suggested retitle will NEWLY require, or '' when it
 * requires nothing new. Fires only for a gate the CURRENT prefix is exempt from
 * and at least one suggested prefix is not — a requirement that already applies
 * is noise, not news.
 *
 * Exported for the test suite, which pins the advice against the real skip sets.
 */
export function retitleGateNote(currentPrefix, suggestedPrefixes) {
  const groups = new Map();
  for (const gate of TITLE_SENSITIVE_GATES) {
    if (!currentPrefix || !gate.skipPrefixes.includes(currentPrefix)) continue;
    const notExempt = suggestedPrefixes.filter(p => !gate.skipPrefixes.includes(p));
    if (notExempt.length === 0) continue;
    const key = notExempt.join(',');
    if (!groups.has(key)) groups.set(key, { notExempt, names: [], requirements: [] });
    groups.get(key).names.push(gate.name);
    groups.get(key).requirements.push(gate.requirement);
  }
  if (groups.size === 0) return '';

  const clauses = [...groups.values()].map(g => {
    const verb = g.notExempt.length === 1 ? 'does' : 'do';
    const gates = `${formatList(g.names)} gate${g.names.length === 1 ? '' : 's'}`;
    return (
      `${formatPrefixList(g.notExempt)} ${verb} not skip the ${gates} the way ` +
      `\`${currentPrefix}:\` does, so the retitled PR will also need ` +
      `${formatList(g.requirements)} in its body`
    );
  });

  return ` Note: ${clauses.join('; ')}.`;
}

function parsePrefix(title) {
  if (!title) return null;
  const match = title.match(/^([a-z]+)(?:\([^)]*\))?:/);
  return match ? match[1].toLowerCase() : null;
}

function isSourceFile(filename) {
  if (!SOURCE_CODE_PATTERN.test(filename)) return false;
  if (TEST_PATTERNS.some(p => p.test(filename))) return false;
  return true;
}

export function checkTestCoverage(files, prTitle = '') {
  const prefix = parsePrefix(prTitle);

  // Mismatch detection: docs/chore/etc PR with real source code changes
  if (prefix && NO_SOURCE_CODE_PREFIXES.includes(prefix)) {
    const sourceChanges = files.filter(f => f.status !== 'removed' && isSourceFile(f.filename));
    if (sourceChanges.length > 0) {
      return {
        passed: false,
        failures: [
          `PR is titled \`${prefix}:\` but includes source code changes ` +
          `(${sourceChanges.slice(0, 3).map(f => f.filename).join(', ')}` +
          `${sourceChanges.length > 3 ? ', ...' : ''}). ` +
          `Please retitle as ${formatPrefixList(MISMATCH_RETITLE_SUGGESTIONS)} so the right gates run, ` +
          `or remove the source code changes if this is genuinely a \`${prefix}:\` PR.` +
          retitleGateNote(prefix, MISMATCH_RETITLE_SUGGESTIONS),
        ],
      };
    }
  }

  // Skip test requirement for prefixes that don't change behavior
  if (prefix && SKIP_TEST_PREFIXES.includes(prefix)) {
    return { passed: true, failures: [] };
  }

  const hasTests = files.some(
    f => f.status !== 'removed' && TEST_PATTERNS.some(p => p.test(f.filename))
  );

  return {
    passed: hasTests,
    failures: hasTests ? [] : [
      'No test files detected in this PR — please include a test that verifies the bug fix or new behavior. ' +
      `If this PR genuinely doesn't need a test (e.g. a refactor), please retitle with ` +
      `${formatPrefixList(NO_TESTS_RETITLE_SUGGESTIONS)} prefix.` +
      retitleGateNote(prefix, NO_TESTS_RETITLE_SUGGESTIONS),
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = JSON.parse(process.env.PR_FILES ?? '[]');
  const title = process.env.PR_TITLE ?? '';
  const result = checkTestCoverage(files, title);
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}

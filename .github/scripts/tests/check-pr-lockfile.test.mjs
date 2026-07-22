import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLockfile } from '../check-pr-lockfile.mjs';

const makeFiles = (filenames) => filenames.map(f => ({ filename: f, status: 'modified' }));

test('passes when lockfile is not changed', () => {
  assert.equal(checkLockfile(makeFiles(['src/foo.ts']), 'someuser', 'fix/bug').passed, true);
});

test('passes when lockfile changed by refresh bot on correct branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'chore/refresh-lockfile'
  );
  assert.equal(result.passed, true);
});

test('fails when lockfile changed by regular user', () => {
  const result = checkLockfile(makeFiles(['pnpm-lock.yaml']), 'someuser', 'fix/bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('pnpm-lock.yaml'));
});

test('fails when lockfile changed by bot on wrong branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'fix/something-else'
  );
  assert.equal(result.passed, false);
});

// Exemptions must match pr.yml's `Block manual lockfile edits` step, which is
// the policy that actually hard-fails the PR. Regression for BLO-17412: an
// allyblockcast[bot] security bump carrying a lockfile diff passes pr.yml but
// was wrongly failed here.
test('passes when lockfile changed by allyblockcast[bot]', () => {
  const result = checkLockfile(
    makeFiles(['package.json', 'pnpm-lock.yaml']),
    'allyblockcast[bot]',
    'security/blo-17412-brace-expansion'
  );
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test('passes when lockfile changed by blockcast-ci-packages[bot]', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'blockcast-ci-packages[bot]',
    'chore/upstream-merge'
  );
  assert.equal(result.passed, true);
});

test('passes when lockfile changed by dependabot[bot]', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'dependabot[bot]',
    'dependabot/npm_and_yarn/foo'
  );
  assert.equal(result.passed, true);
});

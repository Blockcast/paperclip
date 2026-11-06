import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLockfile, onlyPatchHashesChanged } from '../check-pr-lockfile.mjs';

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

// A patch-file edit must change the lockfile's patch hashes; pr.yml allows a
// lockfile diff that changes nothing else, so the gate must too.
const HASH_ONLY = [
  '@@ -61,7 +61,7 @@ patchedDependencies:',
  '   postgres@3.4.9:',
  '-    hash: wypnepoeoyyvesrbh36xjd5n74',
  '+    hash: bvzv2vbruzpoh7jyfuzjiwp3da',
  '     path: patches/postgres@3.4.9.patch',
  '@@ -85,1 +85,1 @@ importers:',
  '-        version: 0.45.2(postgres@3.4.9(patch_hash=wypnepoeoyyvesrbh36xjd5n74))',
  '+        version: 0.45.2(postgres@3.4.9(patch_hash=bvzv2vbruzpoh7jyfuzjiwp3da))',
].join('\n');

test('passes a lockfile diff that changes only patch hashes', () => {
  const result = checkLockfile(
    [{ filename: 'pnpm-lock.yaml', status: 'modified', patch: HASH_ONLY }],
    'someuser',
    'fix/bug'
  );
  assert.equal(result.passed, true);
});

test('fails a lockfile diff that changes anything besides patch hashes', () => {
  const versionBump = HASH_ONLY.replace('+        version: 0.45.2', '+        version: 0.45.3');
  assert.equal(onlyPatchHashesChanged(versionBump), false);
  const integrity = [
    '@@ -900,1 +900,1 @@',
    '-    resolution: {integrity: sha512-aaaa}',
    '+    resolution: {integrity: sha512-bbbb}',
  ].join('\n');
  assert.equal(onlyPatchHashesChanged(integrity), false);
  assert.equal(
    checkLockfile([{ filename: 'pnpm-lock.yaml', status: 'modified', patch: versionBump }], 'someuser', 'fix/bug').passed,
    false
  );
});

test('fails a lockfile diff that moves a line across context', () => {
  const moved = ['@@ -1,3 +1,3 @@', '-  a: 1', '   b: 2', '+  a: 1'].join('\n');
  assert.equal(onlyPatchHashesChanged(moved), false);
});

test('fails a lockfile change with no patch text (too large for the API)', () => {
  assert.equal(onlyPatchHashesChanged(undefined), false);
  assert.equal(checkLockfile(makeFiles(['pnpm-lock.yaml']), 'someuser', 'fix/bug').passed, false);
});

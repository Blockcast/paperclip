import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workflowsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../workflows',
);
const pr = readFileSync(path.join(workflowsDir, 'pr.yml'), 'utf8');

// The comment above the key explains the `base_ref` anti-pattern by name, so an
// "is absent" assertion has to run against executable lines or the explanation
// of the rule trips the rule. Same guard as soak-workflow-triggers.test.mjs.
const code = pr
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

const group = code.match(/^concurrency:\n(?:.*\n)*?\s*group:\s*(.+)$/m)?.[1];

test('pr.yml defines a concurrency group', () => {
  assert.ok(group, 'could not find concurrency.group in pr.yml');
});

// BLO-22902: `merge_group.base_ref` is a constant (`refs/heads/master`), so it
// collapses every merge-group build into a single cancel-in-progress slot. That
// is invisible while maximumEntriesToBuild=1 and silently defeats any raise
// above 1 -- the head's build gets cancelled by the entry queued behind it.
// Superseding a re-staged generation does NOT rely on this key: GitHub cancels
// a destroyed merge group's runs itself (measured 2026-09-13).
test('merge-group builds are keyed per entry, not per base branch', () => {
  assert.doesNotMatch(
    group,
    /merge_group\.base_ref/,
    'concurrency.group keys merge_group on base_ref, a constant: concurrent ' +
      'queue entries would cancel each other and starve the queue head',
  );
  assert.match(
    group,
    /merge_group\.head_ref/,
    'concurrency.group must key merge_group on head_ref, which is unique per ' +
      'queue entry and per re-staged generation',
  );
});

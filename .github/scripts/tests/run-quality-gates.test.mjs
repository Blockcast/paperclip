import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildComment,
  findExistingComment,
  isGraphifyReindexArtifactOnlyPr,
} from '../run-quality-gates.mjs';

const workflow = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../workflows/commitperclip-review.yml',
  ),
  'utf8',
);

test('findExistingComment: paginates until it finds the commitperclip comment', async () => {
  const seenPaths = [];
  const comment = await findExistingComment(async (path) => {
    seenPaths.push(path);
    if (path.endsWith('page=1')) {
      return Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        user: { login: 'someone-else', type: 'User' },
        body: 'unrelated',
      }));
    }
    if (path.endsWith('page=2')) {
      return [{
        id: 200,
        user: { login: 'commitperclip[bot]', type: 'Bot' },
        body: 'Looks good.\n\n— commitperclip',
      }];
    }
    return [];
  }, 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment.id, 200);
  assert.deepEqual(seenPaths, [
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=1',
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=2',
  ]);
});

test('findExistingComment: returns null when no signed comment exists', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 1,
      user: { login: 'commitperclip[bot]', type: 'Bot' },
      body: 'Unsigned status update',
    },
  ]), 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment, null);
});

// BLO-26636. The old predicate allowlisted the literal login
// `commitperclip[bot]`, but get-bot-token.mjs resolves whichever App
// COMMITPERCLIP_APP_ID points at — `allyblockcast[bot]` on Blockcast. So
// `existing` was permanently null there: every failing run POSTed a duplicate,
// and a passing run skipped the write entirely, stranding the failure comment.
// This fixture is the one the old code returns undefined for.
test('findExistingComment: matches whichever App posted it, not a hard-coded login', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 5654012482,
      user: { login: 'allyblockcast[bot]', type: 'Bot' },
      body: 'Hey @someone! Before this PR can be reviewed…\n\n— commitperclip',
    },
  ]), 'token', 'Blockcast/paperclip', 1828);

  assert.equal(comment.id, 5654012482);
});

// `type === 'Bot'` is the whole guard against the PATCH path overwriting a
// human's comment — repo-write identities can edit others' comments via the
// API, so a human quoting the signature must not be treated as ours.
test('findExistingComment: ignores a human comment carrying the signature', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 9,
      user: { login: 'kkroo', type: 'User' },
      body: 'Quoting the bot here:\n\n— commitperclip',
    },
  ]), 'token', 'Blockcast/paperclip', 1828);

  assert.equal(comment, null);
});

// On Blockcast every agent posts as `allyblockcast[bot]`, so `type === 'Bot'`
// cannot tell our gate comment from an agent comment that quotes the
// signature — and `.find` takes the first match in id order, so a quoting
// comment posted first would get PATCHed over. The signature is last in both
// buildComment branches; anchor there.
test('findExistingComment: ignores a bot comment that merely quotes the signature', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 11,
      user: { login: 'allyblockcast[bot]', type: 'Bot' },
      body: 'The old code matched `— commitperclip` by login.\n\nSee the diff above.',
    },
    {
      id: 12,
      user: { login: 'allyblockcast[bot]', type: 'Bot' },
      body: 'Hey @someone! Before this PR can be reviewed…\n\n— commitperclip',
    },
  ]), 'token', 'Blockcast/paperclip', 1889);

  assert.equal(comment.id, 12);
});

test('findExistingComment: tolerates a comment with no body', async () => {
  const comment = await findExistingComment(async () => ([
    { id: 13, user: { login: 'allyblockcast[bot]', type: 'Bot' }, body: null },
  ]), 'token', 'Blockcast/paperclip', 1889);

  assert.equal(comment, null);
});

// BLO-26636. The failure the gate reports most often is a body/title
// violation, and the old text sent the author to push a commit — advice that
// re-runs nothing for a body edit and burns a CI matrix when followed.
test('buildComment: names editing the description, not just pushing a commit', () => {
  const body = buildComment('someone', ['Missing section: **## Risks**'], []);

  assert.match(body, /editing the PR description or title/);
  assert.doesNotMatch(body, /push a new commit and these checks will re-run/);
});

// The remedy above is only true because the workflow listens for `edited`.
// These assertions have to move together or the comment starts lying.
test('commitperclip-review: listens for edited without displacing the original triggers', () => {
  for (const type of ['opened', 'synchronize', 'reopened', 'edited']) {
    assert.match(workflow, new RegExp(`types:\\s*\\[[^\\]]*\\b${type}\\b`));
  }
  assert.match(workflow, /merge_group:\s*\n\s*types:\s*\[checks_requested\]/);
});

// pull_request_target hands secrets to a job triggered by an untrusted fork
// PR, so the base-branch checkout is what makes adding a trigger type safe at
// all. If this ever flips to the PR head, `edited` stops being a one-line
// change and becomes an arbitrary-code-execution path. The count is what bounds
// the blacklist problem: enumerating `ref:` spellings can only ever chase an
// unbounded set (`github.head_ref`, `refs/pull/`, `env.PR_HEAD_SHA`,
// `merge_commit_sha`, …). Asserting there is exactly one checkout, and that it
// is `master`, rejects every second *checkout step* regardless of how its
// `ref:` is written. Ceiling: a `run:` step fetching PR code itself (`git fetch
// origin pull/N/head`), or a third-party action taking its own `ref:` input, is
// outside any guard that reads this workflow as text. Neither exists today —
// the only `uses:` steps are checkout, dependency-review-action and setup-node
// — so if you add one, this test will not stop you.
test('commitperclip-review: still checks out master, never PR code', () => {
  assert.match(workflow, /uses:\s*actions\/checkout@[^\n]*\n\s*with:\s*\n\s*ref:\s*master/);
  assert.equal((workflow.match(/uses:\s*actions\/checkout@/g) ?? []).length, 1);
});

test('isGraphifyReindexArtifactOnlyPr: permits generated graphify reindex PRs', () => {
  const result = isGraphifyReindexArtifactOnlyPr({
    author: 'allyblockcast[bot]',
    branch: 'bot/graphify-reindex',
    files: [
      { filename: 'server/src/graphify-out/graph.json' },
      { filename: 'server/src/graphify-out/GRAPH_REPORT.md' },
      { filename: 'server/src/graphify-out/.graphify_labels.json' },
    ],
  });

  assert.equal(result, true);
});

test('isGraphifyReindexArtifactOnlyPr: rejects non-graphify authors', () => {
  const result = isGraphifyReindexArtifactOnlyPr({
    author: 'someone-else',
    branch: 'bot/graphify-reindex',
    files: [{ filename: 'server/src/graphify-out/graph.json' }],
  });

  assert.equal(result, false);
});

test('isGraphifyReindexArtifactOnlyPr: rejects non-graphify branches', () => {
  const result = isGraphifyReindexArtifactOnlyPr({
    author: 'allyblockcast[bot]',
    branch: 'feature/change',
    files: [{ filename: 'server/src/graphify-out/graph.json' }],
  });

  assert.equal(result, false);
});

test('isGraphifyReindexArtifactOnlyPr: rejects mixed source changes', () => {
  const result = isGraphifyReindexArtifactOnlyPr({
    author: 'allyblockcast[bot]',
    branch: 'bot/graphify-reindex',
    files: [
      { filename: 'server/src/graphify-out/graph.json' },
      { filename: 'server/src/routes/github-webhook.ts' },
    ],
  });

  assert.equal(result, false);
});

test('isGraphifyReindexArtifactOnlyPr: rejects empty file lists', () => {
  const result = isGraphifyReindexArtifactOnlyPr({
    author: 'allyblockcast[bot]',
    branch: 'bot/graphify-reindex',
    files: [],
  });

  assert.equal(result, false);
});

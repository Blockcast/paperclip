import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkCommitTrailers,
  fetchAllPullRequestCommits,
  STRIP_COMMAND,
} from '../check-pr-commit-trailers.mjs';

const commit = (sha, message) => ({ sha, commit: { message } });
const CLEAN = commit('a'.repeat(40), 'fix(ci): do the thing\n\nBody text.');
const TRAILERED = commit(
  'b'.repeat(40),
  'fix: other thing\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>',
);
const FOOTER = commit('c'.repeat(40), 'docs: x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)');

test('trailered commit fails', () => {
  const r = checkCommitTrailers([TRAILERED]);
  assert.equal(r.passed, false);
  assert.match(r.failures[0], /`bbbbbbbbbbbb`/);
});

test('trailer match is case-insensitive', () => {
  assert.equal(checkCommitTrailers([commit('d'.repeat(40), 'x\n\nco-authored-by: a <b@c>')]).passed, false);
});

test('Generated with footer fails', () => {
  assert.equal(checkCommitTrailers([FOOTER]).passed, false);
});

test('clean commit passes', () => {
  assert.deepEqual(checkCommitTrailers([CLEAN]), { passed: true, failures: [] });
});

test('prose that only mentions the words passes (line-anchored)', () => {
  const prose = commit('e'.repeat(40), 'docs: forbid the Co-Authored-By: trailer\n\nAgents add Generated with [x] footers; stop.');
  assert.equal(checkCommitTrailers([prose]).passed, true);
});

test('mixed series fails naming only the trailered SHA', () => {
  const r = checkCommitTrailers([CLEAN, TRAILERED, commit('f'.repeat(40), 'chore: y')]);
  assert.equal(r.passed, false);
  assert.match(r.failures[0], /bbbbbbbbbbbb/);
  assert.doesNotMatch(r.failures[0], /aaaaaaaaaaaa|ffffffffffff/);
});

test('fetch paginates until a short page', async () => {
  const pages = { 1: Array(100).fill(CLEAN), 2: [TRAILERED] };
  const seen = [];
  const gh = async p => { seen.push(p); return pages[Number(p.match(/page=(\d+)$/)[1])]; };
  const all = await fetchAllPullRequestCommits(gh, 'o/r', 7, 't');
  assert.equal(all.length, 101);
  assert.deepEqual(seen, ['/repos/o/r/pulls/7/commits?per_page=100&page=1', '/repos/o/r/pulls/7/commits?per_page=100&page=2']);
});

const mainSource = () => {
  const s = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../run-quality-gates.mjs'), 'utf8');
  return s.slice(s.indexOf('async function main()'));
};

test('orchestrator reads commits live through the shared budget and gates on them, not the PR body', () => {
  const main = mainSource();
  assert.match(main, /fetchAllPullRequestCommits\(gh, GH_REPO, prNumber, GH_TOKEN\)/);
  assert.match(main, /checkCommitTrailers\(commits\)/);
  assert.match(main, /\.\.\.trailerResult\.failures/);
});

test('the remedy command in the failure message actually strips the trailers', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trailers-'));
  const sh = cmd => execSync(cmd, { cwd: dir, encoding: 'utf8', env: { ...process.env, FILTER_BRANCH_SQUELCH_WARNING: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  sh('git init -q -b master && git commit -q --allow-empty -m base && git update-ref refs/remotes/origin/master HEAD');
  sh(`git commit -q --allow-empty -F - <<'M'\n${TRAILERED.commit.message}\nM`);
  sh(`git commit -q --allow-empty -F - <<'M'\n${FOOTER.commit.message}\nM`);
  sh(STRIP_COMMAND.replace(/ && git push.*$/, ''));
  const msgs = sh('git log --format=%B%x00 origin/master..HEAD').split('\0').filter(m => m.trim());
  assert.equal(msgs.length, 2);
  assert.equal(checkCommitTrailers(msgs.map((m, i) => commit(String(i), m))).passed, true);
  assert.match(msgs.join(''), /fix: other thing/);
});

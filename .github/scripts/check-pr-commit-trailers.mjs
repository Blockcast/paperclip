#!/usr/bin/env node
/**
 * check-pr-commit-trailers.mjs
 * Fails when any commit in the PR's own range carries an AI attribution
 * trailer. The merge queue lands commit messages verbatim, so a trailer is
 * permanent in master's history, and the repo owner's rule is that trailered
 * commits must never land on paperclip (BLO-43661, closing note on #2441).
 * The PR *body* is not checked: it is never landed.
 *
 * Export: checkCommitTrailers(commits) → { passed, failures }
 *         fetchAllPullRequestCommits(gh, repo, prNumber, token) → commits[]
 */

// Line-anchored so prose that merely mentions the words does not trip it.
// `Generated with [` is the markdown-link footer assistants append.
export const TRAILER_PATTERNS = [
  /^[ \t]*co-authored-by:/im,
  /^[ \t]*(?:🤖[ \t]*)?generated with \[/im,
];

export const STRIP_COMMAND =
  "git filter-branch -f --msg-filter \"grep -viE '^[[:space:]]*(co-authored-by:|(🤖[[:space:]]*)?generated with \\[)'\" origin/master..HEAD && git push --force-with-lease";

export function checkCommitTrailers(commits) {
  const offending = commits
    .filter(c => TRAILER_PATTERNS.some(p => p.test(c.commit?.message ?? '')))
    .map(c => c.sha);
  if (offending.length === 0) return { passed: true, failures: [] };
  return {
    passed: false,
    failures: [
      `Commit(s) ${offending.map(s => `\`${s.slice(0, 12)}\``).join(', ')} carry a \`Co-Authored-By\` / \`Generated with\` trailer. ` +
      'The merge queue lands commit messages verbatim, so trailered commits must never land on paperclip. ' +
      `Strip them and force-push: \`${STRIP_COMMAND}\` (or \`git rebase -i origin/master\` and \`reword\` each one). ` +
      'This check re-reads the commits on every push.',
    ],
  };
}

// Read live for the current head on every run, so a push that strips the
// trailer flips this green on `synchronize`. ponytail: GitHub caps this
// endpoint at 250 commits; a PR that long has bigger problems.
export async function fetchAllPullRequestCommits(gh, repo, prNumber, token) {
  const commits = [];
  for (let page = 1; ; page += 1) {
    const batch = await gh(`/repos/${repo}/pulls/${prNumber}/commits?per_page=100&page=${page}`, token);
    commits.push(...batch);
    if (batch.length < 100) return commits;
  }
}

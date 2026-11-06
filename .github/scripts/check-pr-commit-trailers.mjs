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

// Strip only. The force-push is PUSH_REMEDY below and is deliberately NOT
// appended here: a lease has to name the sha it expects, which a static string
// cannot know, and the test executes this constant verbatim.
export const STRIP_COMMAND =
  "git filter-branch -f --msg-filter \"grep -viE '^[[:space:]]*(co-authored-by:|(🤖[[:space:]]*)?generated with \\[)'\" origin/master..HEAD";

// The `git` egress wrapper refuses a blind force push, and since PEN-4869 that
// includes a BARE `--force-with-lease`: bare takes its expectation from the
// remote-tracking ref, so an intervening fetch advances it and the lease then
// passes over the very commit it was meant to protect. Agent pods put that
// wrapper first on PATH, so a bare lease printed here is refused for exactly
// the population this check writes to, at the moment they are already blocked.
//
// Read the sha, then name it. Deriving it inline -- `:$(git rev-parse
// origin/<branch>)` -- would satisfy the wrapper's argv predicate while
// reproducing the hazard it exists to stop, which is worse than being refused.
export const PUSH_REMEDY =
  "git fetch origin && git rev-parse origin/<branch>   # read that sha, then: " +
  "git push --force-with-lease=refs/heads/<branch>:<expected-sha> origin <branch>";

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
      `Strip them: \`${STRIP_COMMAND}\` (or \`git rebase -i origin/master\` and \`reword\` each one). ` +
      `Then force-push with a lease that names the sha it expects: \`${PUSH_REMEDY}\`. ` +
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

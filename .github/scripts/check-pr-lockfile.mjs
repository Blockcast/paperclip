#!/usr/bin/env node
/**
 * check-pr-lockfile.mjs
 * Checks that pnpm-lock.yaml was not manually edited.
 * Export: checkLockfile(files, prAuthor, prBranch) → { passed, failures }
 */
import { fileURLToPath } from 'node:url';

export function checkLockfile(files, prAuthor, prBranch) {
  const lockfileChanged = files.some(f => f.filename === 'pnpm-lock.yaml');
  if (!lockfileChanged) return { passed: true, failures: [] };

  // Exemptions MUST mirror the `Block manual lockfile edits` step in pr.yml —
  // that is the policy which actually hard-fails the PR. pr.yml allows the
  // dedicated refresh branch and trusted bot authors to carry lockfile diffs;
  // human/agent PRs stay blocked. A narrower list here produced false failures
  // on PRs pr.yml actually allows (e.g. allyblockcast[bot] security bumps —
  // BLO-17412), with a message wrongly claiming pr.yml would fail them. Keep
  // this set in sync with pr.yml's exemptions.
  const EXEMPT_BOT_AUTHORS = new Set([
    'blockcast-ci-packages[bot]',
    'allyblockcast[bot]',
    'dependabot[bot]',
  ]);
  const exempt =
    prBranch === 'chore/refresh-lockfile' || EXEMPT_BOT_AUTHORS.has(prAuthor);

  return {
    passed: exempt,
    failures: exempt ? [] : [
      'You have changes to `pnpm-lock.yaml` — `pr.yml` will hard-fail this PR with a confusing message about lockfile edits. ' +
      'To fix: run `pnpm install` locally, exclude the lockfile from your commit, push again. ' +
      'The lockfile is regenerated automatically by the refresh bot on a schedule.',
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = JSON.parse(process.env.PR_FILES ?? '[]');
  const result = checkLockfile(files, process.env.PR_AUTHOR ?? '', process.env.PR_BRANCH ?? '');
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}

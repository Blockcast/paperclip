#!/usr/bin/env node
/**
 * check-pr-lockfile.mjs
 * Checks that pnpm-lock.yaml was not manually edited.
 * Export: checkLockfile(files, prAuthor, prBranch) → { passed, failures }
 *         onlyPatchHashesChanged(patch) → boolean
 */
import { fileURLToPath } from 'node:url';

const hashless = line => line
  .replace(/patch_hash=[a-z0-9]+/g, 'patch_hash=')
  .replace(/^( {4}hash: )[a-z0-9]+$/, '$1');

// True when a GitHub file `patch` changes nothing but pnpm patch hashes: every
// run of removed lines is replaced in place by the same lines with only their
// hashes differing. A missing (too large) patch is not hash-only.
export function onlyPatchHashesChanged(patch) {
  if (!patch) return false;
  let removed = [];
  let added = [];
  const flush = () => {
    const same = removed.join('\n') === added.join('\n');
    removed = [];
    added = [];
    return same;
  };
  for (const line of patch.split('\n')) {
    if (line.startsWith('-')) {
      if (added.length && !flush()) return false;
      removed.push(hashless(line.slice(1)));
    } else if (line.startsWith('+')) {
      added.push(hashless(line.slice(1)));
    } else if (!flush()) {
      return false;
    }
  }
  return flush();
}

export function checkLockfile(files, prAuthor, prBranch) {
  const lockfile = files.find(f => f.filename === 'pnpm-lock.yaml');
  if (!lockfile) return { passed: true, failures: [] };
  // pr.yml allows a lockfile that differs from base only in patch hashes: a
  // patch-file edit must change them, and the overrides-consistency check
  // proves each matches its committed patch file.
  if (onlyPatchHashesChanged(lockfile.patch)) return { passed: true, failures: [] };

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

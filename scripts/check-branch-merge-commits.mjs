#!/usr/bin/env node
/**
 * check-branch-merge-commits.mjs (PEN-5431)
 *
 * Fails a PR whose head branch carries MERGE COMMITS relative to its base,
 * when that base is the default branch — i.e. the branch governed by this
 * repo's `mergeMethod: REBASE` merge queue.
 *
 * ## Why this is a gate and not another paragraph
 *
 * The rule this enforces was already written down, twice, and was violated
 * anyway BY ITS OWN AUTHOR:
 *
 *   - `runbooks/merge-queue-stalled-head.md` §"The standard remedy is
 *     self-inflicted under `REBASE`" — commit 0b1ce770 (BLO-23395),
 *     2026-09-29, authored `CTO <cto@paperclip.blockcast.net>`. It states the
 *     prohibition AND prescribes the exact probe below.
 *   - `runbooks/pr-update-branch-destroys-required-checks.md` opens with the
 *     same prohibition — commit df73fefc (BLO-22647), 2026-08-16.
 *
 * On 2026-11-04T05:50:11Z, 36 days later, #3352 was evicted from the queue and
 * the remedy applied was `git merge master into branch` (merge commit
 * e47e65dea, authored `Cto <cto@paperclip.blockcast.net>` — the same identity
 * as 0b1ce770). That fixed `mergeable`, left `rebaseable: false`, and added a
 * commit the REBASE queue must itself replay. Eviction #2 followed at
 * 09:10:53Z. Both evictions emitted ZERO `merge_group` runs, so no check
 * failure explains either; the only trace was a timeline event.
 *
 * The documentation gap was therefore zero, and discoverability and cross-
 * linking were not the defect either: the actor who needed the rule had
 * WRITTEN it. A correct rule that nobody applies at the moment of action has
 * no enforcement surface, and prose cannot acquire one. This is that surface.
 *
 * ## What already existed, and why none of it catches this
 *
 *   - `merge-queue-eviction-detector` (BLO-23395) is REACTIVE: it classifies a
 *     removal AFTER the queue has evicted the PR, and notifies the author. It
 *     fired correctly for eviction #1. It cannot see the merge commit that
 *     causes eviction #2, because that commit is created by the remediation
 *     the detector's own notification prompts.
 *   - `land-clean-prs.mjs` passes `--rebase` so the LANDING path does not
 *     CREATE merge commits (BLO-22300). It does not inspect a branch that
 *     already carries them.
 *   - `pr.yml` had no merge-commit assertion of any kind.
 *
 * So the window between "author merges master into the branch" and "queue
 * evicts the PR for it" was unobserved. On #3352 that window was 3h20m.
 *
 * ## The predicate, and exactly what a PASS does and does not prove
 *
 *     git log --min-parents=2 <base>..<head>
 *
 * This is the probe `runbooks/merge-queue-stalled-head.md:498` already
 * prescribes, run as an assertion instead of as advice. It is ONE-SIDED, and
 * the runbook says so in the paragraph that defines it:
 *
 *   - NONZERO on a REBASE queue is a real, actionable defect. The queue will
 *     try to replay each merge commit, and a merge commit's diff against its
 *     own first parent frequently touches files (lockfiles, generated
 *     journals, migration manifests) a later `master` has changed again.
 *   - ZERO IS NOT AN ALL-CLEAR. #3205 read `0` and was un-stageable anyway.
 *
 * This gate therefore asserts the fail-closed half only. Passing means "this
 * branch is not un-stageable FOR THIS REASON" — it is NOT a prediction that
 * the branch will stage, and the pass message says so rather than letting a
 * green check be read as one. Only a throwaway rebase decides that.
 *
 * ## Scope: default-branch bases only
 *
 * The merge queue governs the default branch. A PR stacked on a feature branch
 * is not replayed by it, and a merge commit there is ordinary stacked-branch
 * work rather than the self-inflicted case above. Gating it would be a false
 * reject of a legitimate pattern, so `--base-ref` scopes the assertion to
 * exactly the branch the rule governs. Omitting `--base-ref` asserts
 * unconditionally (the strict direction), so a caller that forgets to pass it
 * gets a stricter gate, never a silently disabled one.
 *
 * This deliberately does NOT query GitHub for the queue's merge method.
 * `land-clean-prs.mjs` already records why modelling per-repo server state in
 * a gate is a mistake: a wrong model silently skips the repo. The structural
 * property asserted here is the one that matters under REBASE, and if the
 * queue were ever switched to MERGE this gate would be unnecessary rather than
 * wrong — a linear branch is never the thing that breaks a MERGE queue.
 *
 * Reads only. No network, no `gh`, no writes. Needs full history
 * (`fetch-depth: 0`), which the `policy` job already has.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const UNIT_SEPARATOR = "\u001f";
const RECORD_SEPARATOR = "\u001e";
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/** The branch this repo's `mergeMethod: REBASE` queue governs. */
export const DEFAULT_BRANCH = "master";

export const RUNBOOK = "runbooks/merge-queue-stalled-head.md";

/**
 * Parse `git log --min-parents=2` output emitted with the separators above.
 * Tolerates a trailing record separator and blank trailing fields.
 */
export function parseMergeCommitLog(rawOutput) {
  return String(rawOutput ?? "")
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = "", parents = "", subject = ""] = record.split(UNIT_SEPARATOR);
      return {
        sha: sha.trim(),
        parents: parents.trim().split(/\s+/).filter(Boolean),
        subject: subject.trim(),
      };
    })
    .filter((commit) => commit.sha.length > 0);
}

/**
 * Resolve the CURRENT tip of the base branch, for use as an extra exclusion.
 *
 * WHY THIS EXISTS (measured 2026-11-04, master @ ab4a80c82). `PR_BASE_SHA` is
 * `pull_request.base.sha`, which is the base branch tip as of PR creation and
 * LAGS as `master` moves -- #3358 read a base.sha 105 commits behind master.
 * That is normally harmless, because a branch point at or before base.sha means
 * every master commit in the head's ancestry is already an ancestor of base.sha
 * and so falls out of the two-dot range. It stops being harmless if the branch
 * is REBASED onto a newer master than base.sha: master commits newer than
 * base.sha enter the head's ancestry, and any MERGE commit among them would be
 * reported against an author who did not create it and cannot remove it.
 *
 * That is not hypothetical. `master` is not linear: 605 of its 9,303 commits
 * are merges. The REBASE queue has made it nearly so recently -- 1 in the last
 * 500, 18 in the last 1,500 -- but the most recent (`9112ad1af`, 2026-11-01)
 * postdates the runbook this gate enforces, so the population is small and
 * live rather than purely historical.
 *
 * A gate that cries wolf gets switched off, so excluding anything already
 * reachable from the base branch removes the class. It CANNOT cause a false
 * negative: a merge commit the author created by merging master into their own
 * branch exists only on that branch, so it is never reachable from the base
 * branch tip and is still reported.
 *
 * Returns null when the ref cannot be resolved (shallow clone, no remote), in
 * which case the caller proceeds without the extra exclusion -- the strict
 * direction, identical to the pre-hardening behaviour.
 */
export function resolveBaseBranchTip({ repoRoot, baseRef, execFile = execFileSync } = {}) {
  if (!baseRef) return null;
  for (const candidate of [`refs/remotes/origin/${baseRef}`, `refs/heads/${baseRef}`]) {
    try {
      const sha = execFile("git", ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER,
      });
      const trimmed = String(sha).trim();
      if (trimmed) return trimmed;
    } catch {
      // Unresolvable candidate; try the next, then fall through to null.
    }
  }
  return null;
}

/**
 * Merge commits reachable from `head` but not from `base` (nor from any ref in
 * `excludeRefs`).
 *
 * Two-dot semantics, matching the runbook's own probe, expressed in the
 * explicit `<head> ^<base>` form so additional exclusions compose without the
 * argument-order surprises of `--not`.
 *
 * `execFile` is injected for tests; argv array, never a shell.
 */
export function findBranchMergeCommits({ repoRoot, base, head, excludeRefs = [], execFile = execFileSync } = {}) {
  if (!base || !head) throw new Error("findBranchMergeCommits requires both base and head");
  const format = `%H${UNIT_SEPARATOR}%P${UNIT_SEPARATOR}%s${RECORD_SEPARATOR}`;
  const exclusions = [base, ...excludeRefs].filter(Boolean).map((ref) => `^${ref}`);
  const rawOutput = execFile(
    "git",
    ["log", "--min-parents=2", `--format=${format}`, head, ...exclusions],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER },
  );
  return parseMergeCommitLog(rawOutput);
}

/**
 * The verdict, as data, so the test suite pins the decision rather than the
 * wording. `governed: false` is a pass that explicitly did not assert.
 */
export function evaluateBranch({ baseRef, defaultBranch = DEFAULT_BRANCH, mergeCommits = [] } = {}) {
  // Only `--base-ref` that is PRESENT and DIFFERENT opts out. Absent asserts.
  const governed = baseRef == null || baseRef === "" || baseRef === defaultBranch;
  if (!governed) {
    return {
      ok: true,
      governed: false,
      mergeCommits: [],
      reason: `base \`${baseRef}\` is not the default branch \`${defaultBranch}\`; the merge queue does not replay this PR`,
    };
  }
  return {
    ok: mergeCommits.length === 0,
    governed: true,
    mergeCommits,
    reason:
      mergeCommits.length === 0
        ? "no merge commits in base..head"
        : `${mergeCommits.length} merge commit(s) in base..head`,
  };
}

/** Human-readable report. Separate from the verdict so wording is not load-bearing. */
export function formatReport(verdict, { base, head } = {}) {
  const lines = [];
  if (!verdict.governed) {
    lines.push(`check-branch-merge-commits: SKIP — ${verdict.reason}.`);
    return lines.join("\n");
  }
  if (verdict.ok) {
    lines.push(`check-branch-merge-commits: PASS — ${verdict.reason} (${base}..${head}).`);
    // The runbook's own warning, repeated where it is actually read. A green
    // check here is not a prediction that the branch will stage (#3205 read 0
    // and was un-stageable anyway); it only rules out the self-inflicted case.
    lines.push("  NOTE: this check is one-sided. A pass rules out merge-commit replay as a");
    lines.push("  cause of eviction; it does NOT prove the branch is stageable. Only a");
    lines.push("  throwaway `git rebase origin/master` decides that.");
    return lines.join("\n");
  }
  lines.push(`check-branch-merge-commits: FAIL — ${verdict.reason} (${base}..${head}).`);
  lines.push("");
  lines.push("This repo's merge queue is `mergeMethod: REBASE`. It replays every commit on");
  lines.push("this branch, including these merge commits, and a merge commit's diff against");
  lines.push("its own first parent frequently touches files a later `master` has changed");
  lines.push("again. That is a silent eviction: zero `merge_group` runs, no check-run, no");
  lines.push("comment — the only trace is a timeline event.");
  lines.push("");
  for (const commit of verdict.mergeCommits) {
    lines.push(`  ${commit.sha.slice(0, 9)}  (${commit.parents.length} parents)  ${commit.subject}`);
  }
  lines.push("");
  lines.push("REMEDY — rebase, do not merge:");
  lines.push("");
  // The lease has to name the sha the author last PUBLISHED, and the reflog of
  // the remote-tracking ref is the only source that means exactly that: a push
  // writes an `update by push` entry, a fetch writes a different one, so the
  // newest `update by push` is this clone's own publication.
  //
  // Since PEN-4869 the wrapper refuses a bare `--force-with-lease`, because bare
  // takes its expectation from the tracking ref and so passes over the very
  // commit it was meant to protect. A PINNED lease read from `ls-remote`, from a
  // freshly fetched `origin/<branch>`, or from `@{u}` has that same defect in the
  // accepted shape -- all three are the tracking ref's current value, i.e. the
  // thing the lease is compared against, so it can never fail. `@{u}` in
  // particular is just `origin/<branch>`: measured, after a co-author pushes and
  // we fetch, it returns THEIR commit while the newest `update by push` still
  // returns ours. It also fails `fatal: no upstream configured` on a worktree
  // that pushed via `git push origin HEAD:<branch>` -- the common agent shape --
  // whereas the reflog needs no upstream. Hence the rendered fallback below.
  //
  // `ls-remote` belongs on the far side of the comparison, which is what the
  // fourth line does.
  lines.push("    git reflog show origin/<branch>   # newest `update by push` = <expected-sha>, the sha YOU last pushed");
  lines.push("                                      #   (never pushed from this clone? use the sha your last push printed)");
  lines.push("    git fetch origin master");
  lines.push("    git rebase origin/master      # NOT `git merge origin/master`");
  lines.push("    git ls-remote origin refs/heads/<branch>   # still <expected-sha>? if not, a co-author pushed -- STOP");
  lines.push("    git push --force-with-lease=refs/heads/<branch>:<expected-sha> origin <branch>");
  lines.push("");
  lines.push("`git merge origin/master` and the GitHub \"Update branch\" button both make");
  lines.push("`mergeable` true while leaving `rebaseable` false, which is the failure this");
  lines.push("check exists to stop. Read `.rebaseable`, not `mergeable_state` — a");
  lines.push("`mergeable_state: clean` masks it.");
  lines.push("");
  lines.push(`See ${RUNBOOK} ("The standard remedy is self-inflicted under \`REBASE\`").`);
  return lines.join("\n");
}

export function parseArgs(argv) {
  const args = { base: null, head: null, baseRef: null, defaultBranch: DEFAULT_BRANCH };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--base") args.base = argv[++i] ?? null;
    else if (token === "--head") args.head = argv[++i] ?? null;
    else if (token === "--base-ref") args.baseRef = argv[++i] ?? null;
    else if (token === "--default-branch") args.defaultBranch = argv[++i] ?? DEFAULT_BRANCH;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error?.message ?? error));
    console.error("usage: check-branch-merge-commits.mjs --base <sha> --head <sha> [--base-ref <ref>]");
    process.exit(2);
  }
  if (!args.base || !args.head) {
    console.error("check-branch-merge-commits: --base and --head are required.");
    console.error("In CI these are $PR_BASE_SHA / $PR_HEAD_SHA. Do NOT use HEAD: `pr.yml`");
    console.error("checks out `refs/pull/N/merge`, whose tip is itself a merge commit.");
    process.exit(2);
  }

  // A git failure must not read as a pass. Exit 2 (infrastructure) is distinct
  // from exit 1 (the branch is dirty), so a broken checkout is never silently
  // green.
  let mergeCommits;
  try {
    const repoRoot = process.cwd();
    // Drop anything already on the base branch; see resolveBaseBranchTip.
    const baseBranchTip = resolveBaseBranchTip({ repoRoot, baseRef: args.baseRef });
    const excludeRefs = baseBranchTip && baseBranchTip !== args.base ? [baseBranchTip] : [];
    mergeCommits = findBranchMergeCommits({ repoRoot, base: args.base, head: args.head, excludeRefs });
  } catch (error) {
    console.error(`check-branch-merge-commits: could not read ${args.base}..${args.head}.`);
    console.error("This needs full history — the calling job must use `fetch-depth: 0`.");
    console.error(String(error?.message ?? error));
    process.exit(2);
  }

  const verdict = evaluateBranch({
    baseRef: args.baseRef,
    defaultBranch: args.defaultBranch,
    mergeCommits,
  });
  const report = formatReport(verdict, { base: args.base, head: args.head });
  if (verdict.ok) {
    console.log(report);
    process.exit(0);
  }
  console.error(report);
  process.exit(1);
}

if (isMainModule()) main();

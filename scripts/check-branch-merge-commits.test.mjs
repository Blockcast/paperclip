import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BRANCH,
  evaluateBranch,
  findBranchMergeCommits,
  formatReport,
  parseArgs,
  parseMergeCommitLog,
  resolveBaseBranchTip,
} from "./check-branch-merge-commits.mjs";

const SCRIPT = fileURLToPath(new URL("./check-branch-merge-commits.mjs", import.meta.url));
const UNIT_SEPARATOR = "\u001f";
const RECORD_SEPARATOR = "\u001e";

function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function commit(repoRoot, file, body, message) {
  writeFileSync(path.join(repoRoot, file), body);
  git(repoRoot, ["add", file]);
  git(repoRoot, ["commit", "--no-gpg-sign", "-m", message]);
  return git(repoRoot, ["rev-parse", "HEAD"]).trim();
}

/**
 * Reproduces the #3352 shape exactly: a branch off `master`, `master` moves,
 * and the branch absorbs it with `git merge` (the remedy the runbook
 * prohibits) instead of `git rebase`.
 */
function makeRepo() {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "merge-commit-gate-"));
  git(repoRoot, ["init", "--quiet", "--initial-branch", "master"]);
  git(repoRoot, ["config", "user.email", "test@example.com"]);
  git(repoRoot, ["config", "user.name", "Test"]);
  git(repoRoot, ["config", "commit.gpgsign", "false"]);
  const base = commit(repoRoot, "README.md", "base\n", "base commit");
  return { repoRoot, base };
}

test("parseMergeCommitLog parses sha, parents and subject", () => {
  const raw =
    `aaa111${UNIT_SEPARATOR}p1 p2${UNIT_SEPARATOR}Merge branch 'master'${RECORD_SEPARATOR}` +
    `bbb222${UNIT_SEPARATOR}q1 q2${UNIT_SEPARATOR}another merge${RECORD_SEPARATOR}`;
  const parsed = parseMergeCommitLog(raw);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { sha: "aaa111", parents: ["p1", "p2"], subject: "Merge branch 'master'" });
  assert.deepEqual(parsed[1].parents, ["q1", "q2"]);
});

test("parseMergeCommitLog returns [] for empty, blank and nullish input", () => {
  for (const raw of ["", "   ", RECORD_SEPARATOR, null, undefined]) {
    assert.deepEqual(parseMergeCommitLog(raw), []);
  }
});

test("findBranchMergeCommits: a rebased branch is clean (the correct remedy)", () => {
  const { repoRoot, base } = makeRepo();
  try {
    git(repoRoot, ["checkout", "--quiet", "-b", "feature"]);
    commit(repoRoot, "feature.txt", "work\n", "feature work");
    git(repoRoot, ["checkout", "--quiet", "master"]);
    const movedBase = commit(repoRoot, "other.txt", "master moved\n", "master moves on");
    git(repoRoot, ["checkout", "--quiet", "feature"]);
    git(repoRoot, ["rebase", "--quiet", "master"]);
    const head = git(repoRoot, ["rev-parse", "HEAD"]).trim();

    const found = findBranchMergeCommits({ repoRoot, base: movedBase, head });
    assert.deepEqual(found, [], "a rebased branch must carry no merge commits");
    assert.equal(evaluateBranch({ baseRef: "master", mergeCommits: found }).ok, true);
    assert.notEqual(base, movedBase);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("findBranchMergeCommits: `git merge master` into the branch is caught (the #3352 defect)", () => {
  const { repoRoot } = makeRepo();
  try {
    git(repoRoot, ["checkout", "--quiet", "-b", "feature"]);
    commit(repoRoot, "feature.txt", "work\n", "feature work");
    git(repoRoot, ["checkout", "--quiet", "master"]);
    const movedBase = commit(repoRoot, "other.txt", "master moved\n", "master moves on");
    git(repoRoot, ["checkout", "--quiet", "feature"]);
    // The prohibited remedy, verbatim.
    git(repoRoot, ["merge", "--no-ff", "--no-gpg-sign", "-m", "Merge branch 'master' into feature", "master"]);
    const head = git(repoRoot, ["rev-parse", "HEAD"]).trim();

    const found = findBranchMergeCommits({ repoRoot, base: movedBase, head });
    assert.equal(found.length, 1, "the absorbed merge commit must be found");
    assert.equal(found[0].parents.length, 2);
    assert.match(found[0].subject, /Merge branch 'master'/);

    const verdict = evaluateBranch({ baseRef: "master", mergeCommits: found });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.governed, true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("findBranchMergeCommits uses a two-dot range: base-side merge commits are not this branch's problem", () => {
  const { repoRoot } = makeRepo();
  try {
    // A merge commit that lands on master BEFORE the branch exists. The branch
    // cannot remove it, and three-dot would wrongly attribute it here.
    git(repoRoot, ["checkout", "--quiet", "-b", "sidecar"]);
    commit(repoRoot, "sidecar.txt", "side\n", "sidecar work");
    git(repoRoot, ["checkout", "--quiet", "master"]);
    git(repoRoot, ["merge", "--no-ff", "--no-gpg-sign", "-m", "Merge sidecar into master", "sidecar"]);
    const movedBase = git(repoRoot, ["rev-parse", "HEAD"]).trim();

    git(repoRoot, ["checkout", "--quiet", "-b", "feature"]);
    commit(repoRoot, "feature.txt", "work\n", "feature work");
    const head = git(repoRoot, ["rev-parse", "HEAD"]).trim();

    assert.deepEqual(findBranchMergeCommits({ repoRoot, base: movedBase, head }), []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("findBranchMergeCommits requires both endpoints", () => {
  assert.throws(() => findBranchMergeCommits({ repoRoot: ".", base: "a" }), /requires both base and head/);
  assert.throws(() => findBranchMergeCommits({ repoRoot: ".", head: "b" }), /requires both base and head/);
});

test("evaluateBranch: a non-default base is skipped, not failed (stacked PRs)", () => {
  const verdict = evaluateBranch({
    baseRef: "feature/parent",
    mergeCommits: [{ sha: "deadbeef", parents: ["a", "b"], subject: "Merge" }],
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.governed, false);
  assert.deepEqual(verdict.mergeCommits, []);
});

test("evaluateBranch: an ABSENT base-ref asserts rather than silently disabling the gate", () => {
  const mergeCommits = [{ sha: "deadbeef", parents: ["a", "b"], subject: "Merge" }];
  for (const baseRef of [undefined, null, ""]) {
    const verdict = evaluateBranch({ baseRef, mergeCommits });
    assert.equal(verdict.ok, false, `baseRef ${JSON.stringify(baseRef)} must still assert`);
    assert.equal(verdict.governed, true);
  }
});

test("evaluateBranch: honours a non-default --default-branch", () => {
  const mergeCommits = [{ sha: "deadbeef", parents: ["a", "b"], subject: "Merge" }];
  assert.equal(evaluateBranch({ baseRef: "main", defaultBranch: "main", mergeCommits }).ok, false);
  assert.equal(evaluateBranch({ baseRef: "master", defaultBranch: "main", mergeCommits }).governed, false);
});

test("formatReport: the failure names the rebase remedy and never recommends merge", () => {
  const verdict = evaluateBranch({
    baseRef: DEFAULT_BRANCH,
    mergeCommits: [{ sha: "e47e65dea0000000", parents: ["a", "b"], subject: "Merge branch 'master'" }],
  });
  const report = formatReport(verdict, { base: "aaa", head: "bbb" });
  assert.match(report, /FAIL/);
  assert.match(report, /git rebase origin\/master/);
  assert.match(report, /e47e65dea/);
  assert.match(report, /runbooks\/merge-queue-stalled-head\.md/);
  // The one line that must never appear as advice.
  assert.ok(
    !/^\s*git merge origin\/master\s*$/m.test(report),
    "the report must never present `git merge origin/master` as a remedy",
  );
  // PEN-4869: agent pods put the git egress wrapper first on PATH and it refuses
  // a BARE `--force-with-lease`, so a remedy printed here would misfire for
  // exactly the population already blocked by this check. The trailers module
  // carries the same guard; this one is its counterpart, so the third remedy
  // cannot regress to a bare lease silently (PEN-5807).
  assert.doesNotMatch(report, /--force-with-lease(?!=)/, "bare lease is refused by the PEN-4869 wrapper");
  assert.match(report, /--force-with-lease=refs\/heads\/<branch>:<expected-sha>/);
  // ...and the expectation must be a sha the author READ, never one substituted
  // from the remote at push time: `:$(git rev-parse ...)` wears the accepted
  // shape while leasing against the value it is checked against (PEN-5807).
  assert.doesNotMatch(report, /--force-with-lease=\S*:\$\(/, "the expectation must not be derived inline");
  // The expectation is sourced from the tracking ref's REFLOG (`update by push`
  // = this clone's own publication), never from the ref's CURRENT value --
  // `ls-remote`, a fetched `origin/<branch>`, or `@{u}`, which is that same ref
  // and returns a co-author's commit once anything has fetched (PEN-5807).
  assert.match(report, /git reflog show origin\/<branch>/);
  assert.doesNotMatch(report, /rev-parse @\{u\}/, "`@{u}` is the tracking ref, not the sha you last pushed");
  // The no-upstream / never-pushed case must be in the RENDERED text, not only
  // in a source comment the report's reader never sees.
  assert.match(report, /never pushed from this clone/);
  // PEN-6453: `.rebaseable` does not discriminate -- measured `true` on #3492 at
  // the head this check FAILED and again at the rebased head it PASSED. The report
  // may NAME the field, to disarm a reader who has already read `true` elsewhere,
  // but it must never nominate it as the thing to read. Asserted as a NEGATIVE
  // because the failure mode is a well-meant re-widening: "read `.rebaseable`"
  // looks like helpful specificity to anyone who has not seen the measurement.
  assert.doesNotMatch(
    report,
    /\bread\b[^\n]*\brebaseable\b/i,
    "`.rebaseable` must not be nominated as the discriminator (PEN-6453)",
  );
  assert.match(report, /never a verdict/);
  // ...and the instrument that replaces it is this script, run on both arms.
  assert.match(report, /node scripts\/check-branch-merge-commits\.mjs/);
  assert.match(report, /BOTH arms/);
});

test("formatReport: a PASS states its own one-sidedness", () => {
  const report = formatReport(evaluateBranch({ baseRef: DEFAULT_BRANCH, mergeCommits: [] }), {
    base: "aaa",
    head: "bbb",
  });
  assert.match(report, /PASS/);
  assert.match(report, /one-sided/);
  assert.match(report, /does NOT prove the branch is stageable/);
});

test("parseArgs reads the four flags and rejects unknown ones", () => {
  const args = parseArgs(["--base", "aaa", "--head", "bbb", "--base-ref", "master", "--default-branch", "main"]);
  assert.deepEqual(args, { base: "aaa", head: "bbb", baseRef: "master", defaultBranch: "main" });
  assert.equal(parseArgs([]).defaultBranch, DEFAULT_BRANCH);
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
});

test("CLI: exit 2 when endpoints are missing, 1 when dirty, 0 when clean", () => {
  const { repoRoot } = makeRepo();
  try {
    git(repoRoot, ["checkout", "--quiet", "-b", "feature"]);
    commit(repoRoot, "feature.txt", "work\n", "feature work");
    git(repoRoot, ["checkout", "--quiet", "master"]);
    const movedBase = commit(repoRoot, "other.txt", "master moved\n", "master moves on");
    git(repoRoot, ["checkout", "--quiet", "feature"]);
    git(repoRoot, ["merge", "--no-ff", "--no-gpg-sign", "-m", "Merge branch 'master' into feature", "master"]);
    const head = git(repoRoot, ["rev-parse", "HEAD"]).trim();

    const run = (args) => {
      try {
        const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, output: stdout };
      } catch (error) {
        return { code: error.status, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
      }
    };

    assert.equal(run([]).code, 2, "missing endpoints is an infrastructure error, not a pass");
    assert.equal(run(["--base", movedBase]).code, 2);

    const dirty = run(["--base", movedBase, "--head", head, "--base-ref", "master"]);
    assert.equal(dirty.code, 1);
    assert.match(dirty.output, /git rebase origin\/master/);

    const skipped = run(["--base", movedBase, "--head", head, "--base-ref", "feature/parent"]);
    assert.equal(skipped.code, 0);
    assert.match(skipped.output, /SKIP/);

    const clean = run(["--base", movedBase, "--head", movedBase, "--base-ref", "master"]);
    assert.equal(clean.code, 0);
    assert.match(clean.output, /PASS/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("CLI: a bad range is exit 2 (infrastructure), never a silent pass", () => {
  const { repoRoot } = makeRepo();
  try {
    let code = 0;
    try {
      execFileSync(process.execPath, [SCRIPT, "--base", "notarealsha", "--head", "alsonotreal"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      code = error.status;
    }
    assert.equal(code, 2, "an unreadable range must not be reported as clean");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// --- base.sha staleness hardening (PEN-5431) --------------------------------
//
// `pull_request.base.sha` lags as the base branch moves (#3358 measured 105
// commits behind). If the branch is rebased onto a newer master than base.sha,
// master commits -- including master's own merge commits -- enter the two-dot
// range and would be reported against an author who did not create them.
// `master` really does carry merge commits (605/9,303; 1 in the last 500), so
// this class is small and live, not historical.

/**
 * master: C1 -> MC (merge of sidecar) -> C2 ; feature branches off C2.
 * A stale base of C1 puts master's own MC inside `C1..feature`.
 */
function makeStaleBaseRepo() {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "merge-commit-stale-"));
  git(repoRoot, ["init", "--quiet", "--initial-branch", "master"]);
  git(repoRoot, ["config", "user.email", "test@example.com"]);
  git(repoRoot, ["config", "user.name", "Test"]);
  git(repoRoot, ["config", "commit.gpgsign", "false"]);
  const staleBase = commit(repoRoot, "README.md", "base\n", "C1");
  git(repoRoot, ["checkout", "--quiet", "-b", "sidecar"]);
  commit(repoRoot, "sidecar.txt", "side\n", "sidecar work");
  git(repoRoot, ["checkout", "--quiet", "master"]);
  git(repoRoot, ["merge", "--no-ff", "--no-gpg-sign", "-m", "Merge sidecar into master", "sidecar"]);
  commit(repoRoot, "c2.txt", "c2\n", "C2");
  const masterTip = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  git(repoRoot, ["checkout", "--quiet", "-b", "feature"]);
  commit(repoRoot, "feature.txt", "work\n", "feature work");
  const head = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  return { repoRoot, staleBase, masterTip, head };
}

test("resolveBaseBranchTip resolves a local branch and returns null when unresolvable", () => {
  const { repoRoot, masterTip } = makeStaleBaseRepo();
  try {
    assert.equal(resolveBaseBranchTip({ repoRoot, baseRef: "master" }), masterTip);
    assert.equal(resolveBaseBranchTip({ repoRoot, baseRef: "no-such-branch" }), null);
    assert.equal(resolveBaseBranchTip({ repoRoot, baseRef: null }), null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a stale base.sha would report master's OWN merge commit; excluding the base branch tip removes it", () => {
  const { repoRoot, staleBase, masterTip, head } = makeStaleBaseRepo();
  try {
    // Without the hardening: master's merge commit is attributed to the branch.
    const naive = findBranchMergeCommits({ repoRoot, base: staleBase, head });
    assert.equal(naive.length, 1, "precondition: the stale range really does contain master's merge");
    assert.match(naive[0].subject, /Merge sidecar into master/);

    // With it: gone, because it is reachable from the base branch tip.
    const hardened = findBranchMergeCommits({ repoRoot, base: staleBase, head, excludeRefs: [masterTip] });
    assert.deepEqual(hardened, [], "a merge commit the branch did not create must not be reported");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("the exclusion introduces NO false negative: a branch-authored merge is still caught", () => {
  const { repoRoot, staleBase } = makeStaleBaseRepo();
  try {
    // master must move PAST the branch point first: `git merge --no-ff` is a
    // no-op ("Already up to date") when the named ref is already an ancestor,
    // so without this there is no merge commit to catch and the test would
    // pass vacuously.
    git(repoRoot, ["checkout", "--quiet", "master"]);
    commit(repoRoot, "c3.txt", "c3\n", "C3");
    const newMasterTip = git(repoRoot, ["rev-parse", "HEAD"]).trim();

    // The prohibited remedy, on top of the stale-base shape.
    git(repoRoot, ["checkout", "--quiet", "feature"]);
    git(repoRoot, ["merge", "--no-ff", "--no-gpg-sign", "-m", "Merge branch 'master' into feature", "master"]);
    const head = git(repoRoot, ["rev-parse", "HEAD"]).trim();
    assert.notEqual(head, newMasterTip, "precondition: a real merge commit was created");

    const hardened = findBranchMergeCommits({ repoRoot, base: staleBase, head, excludeRefs: [newMasterTip] });
    assert.equal(hardened.length, 1, "the branch's own merge commit is never reachable from the base branch");
    assert.match(hardened[0].subject, /Merge branch 'master' into feature/);
    assert.equal(evaluateBranch({ baseRef: "master", mergeCommits: hardened }).ok, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("CLI end-to-end: a stale base does not false-fail once the base branch resolves", () => {
  const { repoRoot, staleBase, head } = makeStaleBaseRepo();
  try {
    let code = 0;
    let output = "";
    try {
      output = execFileSync(process.execPath, [SCRIPT, "--base", staleBase, "--head", head, "--base-ref", "master"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      code = error.status;
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    assert.equal(code, 0, `expected PASS, got exit ${code}:\n${output}`);
    assert.match(output, /PASS/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

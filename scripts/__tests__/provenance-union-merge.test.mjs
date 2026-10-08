import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import {
  LOG,
  LOG_DIR,
  NOT_SOURCE,
  VENDOR_DIR,
  checkVendoredProvenanceLog,
  isEntryPath,
} from "../check-vendored-provenance-log.mjs";

// BLO-34872 + BLO-35109. Two concurrent PRs touching the vendored adapter used to
// conflict on five hunks: an append-only log row, a 64-hex integrity hash, and a
// version line recorded in three files. BLO-34872 moved the log row into its own
// `merge=union` file. BLO-35109 removed the hash (single-valued, so a union would
// have made the provenance verdict depend on sort order) and stopped bumping the
// version per-PR (nothing outside the tree reads it).
//
// Both halves rest on agreements that nothing else checks and that fail silently
// -- a union-merged file quietly acquiring a single-valued field, a guard whose
// exclusion list rots past a rename, a log file nothing forces anyone to append
// to. Hence tests rather than comments.

const repoRoot = new URL("../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, repoRoot), "utf8");
const HEX64 = /^[0-9a-f]{64}$/m;

/** Paths marked `merge=union` in the repo-root .gitattributes. */
function unionMergedPaths() {
  return read(".gitattributes")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(/\s+/))
    .filter(([, ...attrs]) => attrs.includes("merge=union"))
    .map(([path]) => path);
}

// --------------------------------------------------------------------------
// Static invariants over the real tree
// --------------------------------------------------------------------------

test("no provenance file carries a 64-hex line (BLO-35109 AC3)", () => {
  // Zero candidates, so no merge ordering can ever introduce a second. This is
  // the assertion that catches someone reviving the stored integrity manifest:
  // a single-valued field in a union-merged file is resolved by sort order
  // rather than by the tree, and one of the two orderings fails permissively.
  for (const path of [`${VENDOR_DIR}/PROVENANCE.md`, LOG]) {
    const matches = read(path)
      .split("\n")
      .filter((l) => HEX64.test(l));
    assert.deepEqual(
      matches,
      [],
      `${path} contains a 64-hex line. Single-valued fields cannot live in this tree: they conflict on every concurrent PR, and moving one into the union-merged log would let a union keep both candidates.`,
    );
  }
});

test("PROVENANCE.md does not instruct contributors to update the deleted hash", () => {
  // The content check above cannot see prose. A surviving "update the integrity
  // hash" mandate sends a contributor looking for a hash that no longer exists,
  // and the good-faith repair is to restore one, tripping the AC3 assertion.
  assert.doesNotMatch(
    read(`${VENDOR_DIR}/PROVENANCE.md`),
    /must\s+update the integrity hash/i,
    "PROVENANCE.md still mandates updating a hash BLO-35109 deleted",
  );
});

test("the append-only log is union-merged and PROVENANCE.md is not", () => {
  const union = unionMergedPaths();
  assert.ok(
    union.includes(LOG),
    `${LOG} must be marked merge=union in .gitattributes; without it every concurrent append conflicts again`,
  );
  assert.ok(
    !union.includes(`${VENDOR_DIR}/PROVENANCE.md`),
    "PROVENANCE.md is prose and tables; a union cannot reconcile an interior edit",
  );
});

test("the guard's non-source list names only files present in the tree", () => {
  // The other half of a rename: a stale entry would silently stop requiring a
  // log row for a file that still exists under a new name.
  const tracked = new Set(
    execFileSync("git", ["ls-files"], {
      cwd: new URL(`${VENDOR_DIR}/`, repoRoot),
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .map((p) => `${VENDOR_DIR}/${p}`),
  );

  for (const path of NOT_SOURCE) {
    assert.ok(
      tracked.has(path),
      `check-vendored-provenance-log.mjs excludes '${path}', which is not tracked under ${VENDOR_DIR}. A stale exclusion stops requiring a provenance row for a real file.`,
    );
  }
});

test("CI runs the guard, and no longer verifies a stored manifest", () => {
  const workflow = read(".github/workflows/pr.yml");
  assert.match(
    workflow,
    /node \.\/scripts\/check-vendored-provenance-log\.mjs --base "\$PR_BASE_SHA" --head "\$PR_HEAD_SHA"/,
    "the provenance-log guard is not wired into .github/workflows/pr.yml",
  );
  assert.doesNotMatch(
    workflow,
    /grep -oE '\^\[0-9a-f\]\{64\}\$'/,
    "pr.yml still reads a stored 64-hex manifest; that is the single-valued field BLO-35109 removed",
  );
});

// --------------------------------------------------------------------------
// Behaviour of the guard, against real git history
// --------------------------------------------------------------------------

const SOURCE = `${VENDOR_DIR}/src/server/job-manifest.ts`;
const SECOND_SOURCE = `${VENDOR_DIR}/src/server/execute.ts`;
const LOG_HEADER = "| commit | files | what |\n|---|---|---|\n| `seed` | x | y |\n";

const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), "provenance-guard-"));
  scratchDirs.push(dir);
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const write = (rel, body) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };

  git("init", "--quiet", "--initial-branch=master");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");

  write(".gitattributes", `${LOG} merge=union\n`);
  write(`${VENDOR_DIR}/LICENSE`, "MIT\n");
  write(SOURCE, "export const manifest = 1;\n");
  write(SECOND_SOURCE, "export const execute = 1;\n");
  write(`${VENDOR_DIR}/PROVENANCE.md`, "# Provenance\n");
  write(LOG, LOG_HEADER);
  write(`${LOG_DIR}/README.md`, "# Per-change provenance entries\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "seed");

  const base = git("rev-parse", "HEAD").trim();
  const commit = (message) => {
    git("add", "-A");
    git("commit", "--quiet", "-m", message);
  };
  const check = () => checkVendoredProvenanceLog({ base, head: "HEAD", cwd: dir });
  return { dir, git, write, commit, check, base };
}

test("a vendored source change with no log row is rejected", () => {
  const { write, commit, check } = scratchRepo();
  write(SOURCE, "export const manifest = 2;\n");
  commit("touch vendored source");

  const result = check();
  assert.equal(result.ok, false);
  assert.match(result.reason, /gained no entry/);
  assert.ok(
    result.detail.some((line) => line.includes(SOURCE)),
    "the failure should name the changed file",
  );
});

// --------------------------------------------------------------------------
// BLO-41101. LOG is frozen: nothing may modify it, in the net diff or in any
// commit along the way. These replace an earlier append-only rule, a binary
// rule, and a warn-but-pass legacy-row path -- all three read only the net
// diff, and the net diff cannot see a row that a later commit takes back out.
// --------------------------------------------------------------------------

test("appending a row to the frozen log is rejected, and the repair relocates it", () => {
  // Was "a vendored source change with an appended log row passes". It did
  // pass, with a warning that described this exact failure as a known outcome
  // -- and master gained two such rows on 2026-10-01, which is what every
  // in-flight branch carrying a LOG commit was then ejected against.
  const { write, commit, check } = scratchRepo();
  write(SOURCE, "export const manifest = 2;\n");
  write(LOG, `${LOG_HEADER}| \`abc\` | job-manifest.ts | bumped the manifest |\n`);
  commit("touch vendored source and append to the frozen log");

  const result = check();
  assert.equal(result.ok, false, "the frozen log must not be appendable");
  assert.match(result.reason, /frozen, and this change modifies it/);
  assert.ok(
    result.detail.some((line) => line.includes(`${LOG_DIR}/<issue-or-pr>.md`)),
    "a wrong net diff must be told to relocate the row",
  );
  assert.ok(
    result.detail.some((line) => line.includes("filter-branch")),
    "and to scrub it from history too -- dropping it from the tip is not enough",
  );
});

test("appending a row on its own, with no source change, is still rejected", () => {
  // The rule is unconditional. A row appended by a PR that changes no vendored
  // source is still a row master gains, and so is still what the next branch's
  // rebase replay conflicts against.
  const { write, commit, check } = scratchRepo();
  write(LOG, `${LOG_HEADER}| \`abc\` | - | a note |\n`);
  commit("log append only");

  const result = check();
  assert.equal(result.ok, false);
  assert.match(result.reason, /frozen, and this change modifies it/);
});

test("deleting or editing a line in the frozen log is rejected", () => {
  // Previously two tests, rejected by an append-only rule for a reason that no
  // longer applies -- "append new rows at the end" is now wrong advice. The
  // behaviour is preserved; only the diagnosis changed.
  for (const [name, seedSource] of [["with a source change", true], ["alone", false]]) {
    const { write, commit, check } = scratchRepo();
    if (seedSource) write(SOURCE, "export const manifest = 2;\n");
    write(LOG, "| commit | files | what |\n|---|---|---|\n| `seed` | x | EDITED |\n");
    commit(`rewrite an existing log row ${name}`);

    const result = check();
    assert.equal(result.ok, false, `a rewritten row ${name} must not pass`);
    assert.match(result.reason, /frozen/);
  }
});

test("a log git treats as binary is rejected, not silently passed", () => {
  // `git diff --numstat` emits `-\t-` for a binary blob. The old guard parsed
  // those to NaN, which made every numeric comparison false, so it needed an
  // explicit Number.isFinite check or it passed on exactly the input it existed
  // to reject. The frozen check tests for the PRESENCE of a diff line instead,
  // which cannot have that shape -- this pins that the fail-open did not come
  // back with the counts.
  const withSource = scratchRepo();
  withSource.write(SOURCE, "export const manifest = 2;\n");
  withSource.write(LOG, `${LOG_HEADER}| \`abc\` | job\0manifest.ts | binary now |\n`);
  withSource.commit("rewrite the log as a binary blob, and touch source");

  const a = withSource.check();
  assert.equal(a.ok, false);
  assert.match(a.reason, /frozen/);

  const logOnly = scratchRepo();
  logOnly.write(LOG, "| commit | files | what |\n|---|---|---|\n| `seed` | x | \0 |\n");
  logOnly.commit("destructively rewrite the log as a binary blob");

  const b = logOnly.check();
  assert.equal(b.ok, false, "a binary log must never verify as ok");
  assert.match(b.reason, /frozen/);
});

test("adding only whitespace to the frozen log is still touching it", () => {
  // Was "a blank added line does not satisfy the require-a-row guard", which
  // pinned a `/^\+\s*\|/` row-shape filter on LOG. That filter is gone with the
  // row path: LOG can no longer satisfy the guard at all, so the question is
  // not whether a blank line is a row but whether the file was touched.
  const { write, commit, check } = scratchRepo();
  write(SOURCE, "export const manifest = 2;\n");
  write(LOG, `${LOG_HEADER}\n   \n`);
  commit("touch vendored source, append only whitespace to the frozen log");

  const result = check();
  assert.equal(result.ok, false);
  assert.match(result.reason, /frozen/);
});

test("changing only the Blockcast-added provenance files needs no row", () => {
  // Paths are written out rather than read off NOT_SOURCE on purpose. Iterating
  // the list under test means deleting an entry deletes its own case, so the
  // suite stays green on exactly the change it exists to catch.
  for (const path of [`${VENDOR_DIR}/LICENSE`, `${VENDOR_DIR}/PROVENANCE.md`]) {
    const { write, commit, check } = scratchRepo();
    write(path, "Blockcast-added, not upstream source.\n");
    commit(`touch ${path}`);

    assert.deepEqual(check(), { ok: true }, `${path} should not require a log row`);
  }

  // And the other direction: the list must not quietly grow to cover real
  // source, which would stop requiring a row for it.
  assert.deepEqual(NOT_SOURCE, [`${VENDOR_DIR}/LICENSE`, `${VENDOR_DIR}/PROVENANCE.md`]);
});

test("a change that does not touch the vendored tree at all passes", () => {
  const { write, commit, check } = scratchRepo();
  write("README.md", "unrelated\n");
  commit("unrelated");

  assert.deepEqual(check(), { ok: true });
});

test("commits that landed on the base branch are not attributed to this change", () => {
  // $PR_BASE_SHA is the base branch's *tip*, not the merge base. A two-dot diff
  // against it reports the base's own entries as deletions, so an unrelated
  // vendored change on master would fail every open vendored PR with a bogus
  // "append-only" violation. The three-dot range is what prevents that.
  //
  // BLO-41101: the vehicle is an entry file, not a LOG row. A LOG row would now
  // be rejected as a frozen-file change before the three-dot range mattered,
  // so this test would have passed for the wrong reason and stopped measuring
  // what it is named for.
  const { dir, git, write, commit, base } = scratchRepo();

  git("checkout", "--quiet", "-b", "feature");
  write(SOURCE, "export const manifest = 2;\n");
  write(`${LOG_DIR}/blo-feature.md`, "The PR's own change.\n");
  commit("feature work, recorded");

  git("checkout", "--quiet", "master");
  write(`${LOG_DIR}/blo-master.md`, "Landed on master after the branch point.\n");
  commit("unrelated master entry");
  const baseTip = git("rev-parse", "HEAD").trim();

  assert.notEqual(baseTip, base, "master must have moved for this test to mean anything");
  git("checkout", "--quiet", "feature");

  assert.equal(checkVendoredProvenanceLog({ base: baseTip, head: "HEAD", cwd: dir }).ok, true);
});

// --------------------------------------------------------------------------
// The whole point: two concurrent vendored changes rebase without conflict
// --------------------------------------------------------------------------

test("two concurrent realistic vendored changes rebase with no conflict (BLO-35109 AC1)", () => {
  const { dir, git, write, commit, base } = scratchRepo();

  // Branch A: edits one vendored source file and records it.
  git("checkout", "--quiet", "-b", "branch-a");
  write(SOURCE, "export const manifest = 2;\n");
  write(`${LOG_DIR}/change-a.md`, "Change A: bumped the manifest.\n");
  commit("change A");

  // Branch B: edits a different vendored source file and records its own.
  git("checkout", "--quiet", "-b", "branch-b", base);
  write(SECOND_SOURCE, "export const execute = 2;\n");
  write(`${LOG_DIR}/change-b.md`, "Change B: bumped execute.\n");
  commit("change B");

  // Before BLO-34872 + BLO-35109 this rebase conflicted every time: on the log
  // row, on the 64-hex hash, and on the version line in three files.
  git("rebase", "branch-a");

  assert.ok(!readFileSync(join(dir, `${LOG_DIR}/change-b.md`), "utf8").includes("<<<<<<<"),
    "the rebase left conflict markers");

  // And the rebased result still satisfies the guard.
  assert.equal(checkVendoredProvenanceLog({ base, head: "HEAD", cwd: dir }).ok, true);
});

test("the union driver still resolves a local rebase of a legacy LOG row (BLO-41101 AC5)", () => {
  // AC5: `merge=union` is KEPT, so record what it still does. Branches that
  // already carry a LOG row predate the frozen rule and must stay locally
  // rebasable; CI is what now rejects them, with a message and a repair.
  //
  // This is also the mechanism that hid the bug for six evictions, so it is
  // pinned deliberately rather than left to chance: the two CONTROL tests below
  // assert the same driver does NOT save the merge GitHub actually performs.
  const { dir, git, write, commit, base } = scratchRepo();

  git("checkout", "--quiet", "-b", "branch-a");
  write(LOG, `${LOG_HEADER}| \`aaa\` | job-manifest.ts | change A |\n`);
  commit("change A, legacy row");

  git("checkout", "--quiet", "-b", "branch-b", base);
  write(LOG, `${LOG_HEADER}| \`bbb\` | execute.ts | change B |\n`);
  commit("change B, legacy row");

  git("rebase", "branch-a");

  const merged = readFileSync(join(dir, LOG), "utf8");
  assert.ok(merged.includes("change A"), "union merge dropped branch A's row");
  assert.ok(merged.includes("change B"), "union merge dropped branch B's row");
  assert.ok(!merged.includes("<<<<<<<"), "the rebase left conflict markers");

  // And the guard rejects it anyway -- the local clean is exactly the false
  // reassurance BLO-41101 is about.
  const result = checkVendoredProvenanceLog({ base, head: "HEAD", cwd: dir });
  assert.equal(result.ok, false, "a locally-clean rebase must not read as mergeable");
  assert.match(result.reason, /frozen/);
});

// --------------------------------------------------------------------------
// BLO-34872 round 2: the merge GitHub actually performs
//
// Everything above this line exercises a local `git rebase`, which honours the
// repo's `merge=union` attribute. GitHub does not: its server-side merge
// ignores .gitattributes merge drivers, and that merge is what computes a PR's
// `mergeable` state and the merge-queue rebase. So the union-merge tests above
// were green while #2070, #1459 and #1699 were being ejected from the queue
// with `merge_conflict` on exactly the file the union was supposed to fix.
//
// These reproduce that by forcing `merge=text` in .git/info/attributes, which
// has higher precedence than the in-tree .gitattributes. The CONTROL is the
// load-bearing half: it asserts the harness still conflicts on the old
// single-file layout. Without it a harness that silently stopped merging
// anything would report the new layout as clean and prove nothing.
// --------------------------------------------------------------------------

/**
 * Two branches off one base, merged the way GitHub merges: attribute merge
 * drivers disabled. Each branch edits a DIFFERENT vendored source file, so any
 * conflict reported is attributable to how the change was RECORDED and not to
 * the source edit -- without that the control conflicts on `SOURCE` and proves
 * nothing about the log at all.
 *
 * @param {(ctx: ReturnType<typeof scratchRepo>, branch: {id: string, source: string}) => void} record
 * @returns {{clean: boolean, output: string}}
 */
function mergeBranches(record, { drivers = false } = {}) {
  const ctx = scratchRepo();
  const { dir, git, base } = ctx;
  const branches = [
    { id: "a", source: SOURCE },
    { id: "b", source: SECOND_SOURCE },
  ];

  // $GIT_DIR/info/attributes has the highest precedence, so this overrides the
  // union line in the tree's own .gitattributes. That is the GitHub equivalence.
  if (!drivers) {
    mkdirSync(join(dir, ".git", "info"), { recursive: true });
    writeFileSync(join(dir, ".git", "info", "attributes"), `${LOG} merge=text\n`);
  }

  for (const branch of branches) {
    git("checkout", "--quiet", "-b", `branch-${branch.id}`, base);
    ctx.write(branch.source, `export const x = "${branch.id}";\n`);
    record(ctx, branch);
    ctx.commit(`change ${branch.id}`);
  }

  try {
    return { clean: true, output: git("merge-tree", "--write-tree", "branch-a", "branch-b") };
  } catch (err) {
    // Non-zero exit == conflict. merge-tree still writes the conflicted paths
    // to stdout, which is how we check WHICH file conflicted.
    return { clean: false, output: String(err.stdout ?? "") };
  }
}

const singleFileAppend = (ctx, branch) => {
  ctx.write(LOG, `${LOG_HEADER}| \`${branch.id}\` | ${branch.source} | change ${branch.id} |\n`);
};

test("CONTROL: concurrent appends to the single log file conflict without drivers", () => {
  // The failure as measured on 2026-09-30: master 0bb33a1a7, #2070 ejected at
  // 17:04:28Z and #1459 at 17:07:02Z, both `merge_conflict`, both in this file
  // and nothing else, both clean under a local merge with the union attribute.
  const { clean, output } = mergeBranches(singleFileAppend);
  assert.equal(
    clean,
    false,
    "the harness no longer reproduces the single-file conflict, so the test below proves nothing",
  );
  assert.ok(
    output.includes(LOG),
    `the conflict must be in ${LOG} itself, not in the source edit: ${output}`,
  );
});

test("CONTROL: the disabled driver is WHY the single-file case conflicts", () => {
  // The control above pins that it conflicts and which file; this pins the
  // cause. Without it a future harness change that conflicts in LOG for some
  // unrelated reason would still satisfy it, and the subject test below would
  // go on "proving" a merge property the harness was no longer measuring.
  //
  // This is round 1's mistake in miniature: that demonstration used `git
  // rebase`, which honours the driver, so it was green for a reason that had
  // nothing to do with GitHub.
  const { clean, output } = mergeBranches(singleFileAppend, { drivers: true });
  assert.equal(
    clean,
    true,
    `with merge=union in effect the same appends must merge: ${output}`,
  );
});

test("one file per change merges cleanly without drivers (BLO-34872 round 2)", () => {
  const { clean, output } = mergeBranches((ctx, branch) => {
    ctx.write(`${LOG_DIR}/change-${branch.id}.md`, `Change ${branch.id}: touched ${branch.source}.\n`);
  });
  assert.equal(clean, true, `two distinct new entry files must never conflict: ${output}`);
});

// --------------------------------------------------------------------------
// The guard accepts a per-change file, and only a per-change file
// --------------------------------------------------------------------------

test("a vendored source change with a new entry file passes, with no warning", () => {
  const { write, commit, check } = scratchRepo();
  write(SOURCE, "export const manifest = 2;\n");
  write(`${LOG_DIR}/blo-1.md`, "Bumped the manifest.\n");
  commit("touch vendored source and record it");

  assert.deepEqual(check(), { ok: true });
});

test("a branch whose net diff is clean but whose commits touch LOG is rejected (BLO-41101 AC1)", () => {
  // THE HEADLINE CASE. #1797: `git diff master -- LOG` empty, the guard said
  // ok, `merge=union` made every local rebase return clean -- and the REBASE
  // merge queue replayed the commits one at a time, conflicted on the first one
  // that touched LOG, and ejected the PR six times in 24 days with zero
  // merge_group runs to point at.
  const { dir, git, write, commit, check, base } = scratchRepo();

  write(SOURCE, "export const manifest = 2;\n");
  write(LOG, `${LOG_HEADER}| \`abc\` | job-manifest.ts | recorded the old way |\n`);
  commit("record it in the frozen log");
  const offender = git("rev-parse", "HEAD").trim();

  write(`${LOG_DIR}/blo-1.md`, "Moved the row here instead.\n");
  write(LOG, LOG_HEADER); // take the row back out: net diff for LOG is now empty
  commit("move the row to the entry directory");

  // The precondition, asserted rather than assumed: without it this test would
  // pass on the old net-diff-only guard and prove nothing.
  assert.equal(
    git("diff", "--numstat", `${base}...HEAD`, "--", LOG).trim(),
    "",
    "the net diff for LOG must be empty, or this is not the case under test",
  );

  const result = check();
  assert.equal(result.ok, false, "a clean net diff over a LOG-touching history is not mergeable");
  assert.match(result.reason, /Your net diff leaves it alone/);
  assert.ok(
    result.detail.some((line) => line.includes(offender)),
    `the failure must name the offending commit ${offender}`,
  );
  assert.ok(
    result.detail.some((line) => line.includes("filter-branch")),
    "and give the one-command repair",
  );
  // The repair must pin LOG to the MERGE BASE's blob, not to `base`'s. Measured
  // on #1797: a tip-pinned rewrite left 1 offending commit of 6 and still
  // conflicted, because the first rewritten commit's parent is the merge base,
  // so rewriting LOG to master's blob is itself a modification.
  assert.ok(
    result.detail.some((line) => line.includes("merge-base")),
    "the repair must pin to the merge base's blob, or it leaves an offending commit behind",
  );
  // AC4: this message is the history repair, not the relocate-your-row one.
  assert.ok(
    !result.detail.some((line) => line.includes(`${LOG_DIR}/<issue-or-pr>.md`)),
    "a clean net diff must not be told to relocate a row it does not have",
  );
});

test("a commit that landed on master is not reported as this branch's offender (BLO-41101)", () => {
  // Two dots, not three. For rev-list `base...head` is a SYMMETRIC DIFFERENCE,
  // so it pulls in master's own LOG commits -- measured, 3 commits instead of
  // 2 -- and blames this branch for rows it did not write. That would fail
  // every open vendored PR the moment master gained a row.
  const { dir, git, write, commit, base } = scratchRepo();

  git("checkout", "--quiet", "-b", "feature");
  write(SOURCE, "export const manifest = 2;\n");
  write(`${LOG_DIR}/blo-1.md`, "Recorded properly.\n");
  commit("feature work, recorded in the entry directory");

  git("checkout", "--quiet", "master");
  write(LOG, `${LOG_HEADER}| \`mmm\` | - | a legacy row that landed on master |\n`);
  commit("master appends to the frozen log");
  const baseTip = git("rev-parse", "HEAD").trim();
  assert.notEqual(baseTip, base, "master must have moved for this test to mean anything");

  git("checkout", "--quiet", "feature");
  assert.equal(
    checkVendoredProvenanceLog({ base: baseTip, head: "HEAD", cwd: dir }).ok,
    true,
    "master's own LOG commit must not be attributed to this branch",
  );
});

test("a LOG commit hidden behind a merge that discards it is still found (BLO-41101)", () => {
  // --full-history. Default history simplification walks ONE parent of a merge:
  // when the merge's tree is TREESAME to the mainline parent -- which is what a
  // merge that discards the side's LOG change produces -- the side commit is
  // pruned and rev-list returns nothing at all. Measured: 0 commits plain, 0
  // with --no-merges alone, 1 with --full-history. A rebase still replays that
  // commit, so the branch is still un-stageable; without the flag the guard is
  // a complete fail-open on this shape, and the net diff is empty too.
  const { dir, git, write, commit, check, base } = scratchRepo();

  write(SOURCE, "export const manifest = 2;\n");
  write(`${LOG_DIR}/blo-1.md`, "Recorded properly.\n");
  commit("feature work, recorded the supported way");

  git("checkout", "--quiet", "-b", "side");
  write(LOG, `${LOG_HEADER}| \`sss\` | - | a row added on a side branch |\n`);
  commit("side branch touches the frozen log");
  const offender = git("rev-parse", "HEAD").trim();

  git("checkout", "--quiet", "master");
  git("merge", "--quiet", "--no-ff", "side", "-m", "merge side");
  // Discard the side's LOG change in the merge, so the merge tree is TREESAME
  // to the mainline parent and the net diff for LOG comes back empty.
  git("checkout", base, "--", LOG);
  git("commit", "--quiet", "-a", "--amend", "--no-edit");
  const mergeCommit = git("rev-parse", "HEAD").trim();

  assert.equal(
    git("diff", "--numstat", `${base}...HEAD`, "--", LOG).trim(),
    "",
    "the net diff for LOG must be empty, or this is not the case under test",
  );

  const result = check();
  assert.equal(result.ok, false, "a LOG commit behind a discarding merge is still replayed");
  assert.ok(
    result.detail.some((line) => line.includes(offender)),
    `the failure must name the pruned commit ${offender}`,
  );
  // --no-merges. A rebase replays non-merge commits only, so listing the merge
  // itself sends the author to a commit that is not the problem. Measured: 2
  // SHAs listed without the flag, 1 with. Asserting the offender is PRESENT
  // cannot catch that -- only asserting the merge is ABSENT can.
  assert.ok(
    !result.detail.some((line) => line.includes(mergeCommit)),
    "a merge commit is not replayed by a rebase and must not be named as an offender",
  );
});

test("a change adding only an entry file passes (BLO-41101 AC3 true-negative)", () => {
  // The control that stops the guard becoming "any vendored PR fails". Without
  // it, a frozen check that over-matched -- on the directory, on a path prefix,
  // on the whole vendored tree -- would look like a working guard.
  const { write, commit, check } = scratchRepo();
  write(SOURCE, "export const manifest = 2;\n");
  write(`${LOG_DIR}/blo-41101.md`, "Bumped the manifest.\n");
  commit("touch vendored source and record it the supported way");

  assert.deepEqual(check(), { ok: true });
});

test("the entry directory's README does not satisfy the guard", () => {
  // Every PR would otherwise be able to satisfy it by touching the docs.
  const { write, commit, check } = scratchRepo();
  write(SOURCE, "export const manifest = 2;\n");
  write(`${LOG_DIR}/README.md`, "# Per-change provenance entries\n\nedited\n");
  commit("touch vendored source, edit the directory README");

  const result = check();
  assert.equal(result.ok, false);
  assert.match(result.reason, /gained no entry/);
});

test("modifying an existing entry does not satisfy the guard for a later change", () => {
  // --diff-filter=A. Re-editing an earlier entry is not conflict-free -- two
  // PRs editing one path collide exactly like the single-file log did -- so it
  // must not count as this change's record. The entry has to predate the base
  // for this to mean anything: within one PR, add-then-edit is still an add.
  const { dir, git, write, commit, base } = scratchRepo();
  write(`${LOG_DIR}/blo-1.md`, "First change.\n");
  commit("an earlier entry, already on the base branch");
  const entryBase = git("rev-parse", "HEAD").trim();
  assert.notEqual(entryBase, base, "the entry must predate the range under test");

  write(SOURCE, "export const manifest = 2;\n");
  write(`${LOG_DIR}/blo-1.md`, "First change, with a later edit.\n");
  commit("touch vendored source, edit the earlier entry");

  const result = checkVendoredProvenanceLog({ base: entryBase, head: "HEAD", cwd: dir });
  assert.equal(result.ok, false, "the edit must not count as this change's entry");
  assert.match(result.reason, /gained no entry/);
});

test("editing an entry alone is not itself a vendored change needing an entry", () => {
  // The `!p.startsWith(LOG_DIR)` filter in `changed`. Drop it and a typo fix in
  // your own earlier entry is rejected as unrecorded vendored source.
  //
  // The entry must predate the base, exactly as in the --diff-filter=A case
  // above: inside one range an add-then-edit is still an add, so the guard is
  // satisfied by the add and this passes on broken code. Measured -- written
  // the obvious way, reverting the filter left the whole suite green.
  const { dir, git, write, commit } = scratchRepo();
  write(`${LOG_DIR}/blo-1.md`, "First change.\n");
  commit("an earlier entry, already on the base branch");
  const entryBase = git("rev-parse", "HEAD").trim();

  write(`${LOG_DIR}/blo-1.md`, "First change, typo fixed.\n");
  commit("fix a typo in an entry");

  assert.deepEqual(
    checkVendoredProvenanceLog({ base: entryBase, head: "HEAD", cwd: dir }),
    { ok: true },
  );
});

test("README.md under the entry directory is documentation, not an entry", () => {
  assert.ok(isEntryPath(`${LOG_DIR}/blo-34872.md`));
  assert.ok(!isEntryPath(`${LOG_DIR}/README.md`), "the docs must not satisfy the guard");
  assert.ok(!isEntryPath(`${LOG_DIR}/notes.txt`), "entries are markdown");
  assert.ok(!isEntryPath(`${VENDOR_DIR}/PROVENANCE.md`), "only files inside the directory count");
});

test("the real tree has the entry directory, and PROVENANCE.md points at it", () => {
  // The two halves that rot independently: the directory could be deleted, or
  // the docs could keep sending contributors to the frozen table.
  const tracked = execFileSync("git", ["ls-files", LOG_DIR], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

  assert.ok(
    tracked.includes(`${LOG_DIR}/README.md`),
    `${LOG_DIR}/README.md is not tracked; the guard's error message points contributors at it`,
  );
  assert.ok(
    read(`${VENDOR_DIR}/PROVENANCE.md`).includes("PROVENANCE-CHANGES.d/"),
    "PROVENANCE.md does not mention the entry directory, so contributors keep appending to the frozen table",
  );
});

// --------------------------------------------------------------------------
// The entry directory is append-only, and an entry has to record something.
// All seven below reproduce findings from Ally's review of PR #2148 at
// 9eaab0364, and each fails with its one guard reverted.
// --------------------------------------------------------------------------

const BUMP = "export const manifest = 2;\n";

/** Seeds an entry that predates the range under test, as a prior PR would have. */
function repoWithPriorEntry(name = "blo-1.md", body = "An earlier change.\n") {
  const scratch = scratchRepo();
  scratch.write(`${LOG_DIR}/${name}`, body);
  scratch.commit("an earlier entry, already on the base branch");
  const priorBase = scratch.git("rev-parse", "HEAD").trim();
  return {
    ...scratch,
    priorBase,
    checkFromPrior: () =>
      checkVendoredProvenanceLog({ base: priorBase, head: "HEAD", cwd: scratch.dir }),
  };
}

test("deleting an entry file is rejected", () => {
  // Entry paths are filtered out of `changed`, so before the LOG_DIR deletion
  // guard a delete-only change reached `changed.length === 0` and returned ok:
  // erasing the record was the one mutation nothing caught.
  const { git, commit, checkFromPrior } = repoWithPriorEntry();
  git("rm", "--quiet", `${LOG_DIR}/blo-1.md`);
  commit("delete an earlier entry");

  const result = checkFromPrior();
  assert.equal(result.ok, false, "erasing a prior entry must not pass");
  assert.match(result.reason, /append-only/);
  assert.ok(
    result.detail.some((line) => line.includes("blo-1.md")),
    "the failure should name the entry it removed",
  );
});

test("emptying a prior entry in place is rejected, as deleting it is", () => {
  // An emptied entry is an `M`, not a `D`, so the deletion guard passes it. The
  // typo-fix case above must keep passing, so this is erasure, not editing.
  for (const body of ["", "  \n\n"]) {
    const { write, commit, checkFromPrior } = repoWithPriorEntry();
    write(`${LOG_DIR}/blo-1.md`, body);
    commit("empty an earlier entry");

    const result = checkFromPrior();
    assert.equal(result.ok, false, `emptying a prior entry to ${JSON.stringify(body)} must not pass`);
    assert.match(result.reason, /empties 1 existing entry/);
    assert.ok(result.detail.some((line) => line.includes("blo-1.md")), "the failure should name the entry");
  }
});

test("replacing a prior entry with a symlink is rejected", () => {
  // A symlink swap is a `T`, which --diff-filter=M alone misses, and its blob
  // is the link target, which is not blank: so the mode is checked, not the text.
  const { dir, write, commit, checkFromPrior } = repoWithPriorEntry();
  write(`${LOG_DIR}/notes.txt`, "elsewhere\n");
  unlinkSync(join(dir, LOG_DIR, "blo-1.md"));
  symlinkSync("notes.txt", join(dir, LOG_DIR, "blo-1.md"));
  commit("point an earlier entry somewhere else");

  const result = checkFromPrior();
  assert.equal(result.ok, false, "a symlinked entry no longer records anything itself");
  assert.match(result.reason, /empties 1 existing entry/);
});

test("adding a symlink as the new entry does not satisfy the guard", () => {
  // The `A` twin of the case above: the added entry's diff is its link target,
  // `+blo-1.md`, which is not blank, so a diff-only test scores it 1 and passes.
  for (const target of ["blo-1.md", "README.md", "/etc/hostname"]) {
    const { dir, write, commit, checkFromPrior } = repoWithPriorEntry();
    write(SOURCE, BUMP);
    symlinkSync(target, join(dir, LOG_DIR, "blo-9.md"));
    commit("touch vendored source, add a symlink as the entry");

    const result = checkFromPrior();
    assert.equal(result.ok, false, `an entry linking to ${target} records nothing itself`);
    assert.match(result.reason, /records nothing/);
    assert.ok(result.detail.some((line) => line.includes("blo-9.md")), "the failure should name the entry");
  }
});

test("deleting every prior entry while adding your own is rejected", () => {
  const { git, write, commit, checkFromPrior } = repoWithPriorEntry();
  git("rm", "--quiet", `${LOG_DIR}/blo-1.md`);
  write(SOURCE, BUMP);
  write(`${LOG_DIR}/blo-2.md`, "My change, and I took the others with me.\n");
  commit("clear the log, record only mine");

  const result = checkFromPrior();
  assert.equal(result.ok, false, "a valid entry of your own does not license erasing others'");
  assert.match(result.reason, /append-only/);
});

test("a deletion paired with a similar new entry is still seen as a deletion", () => {
  // --no-renames on the deletion check. git pairs delete+add of similar bodies
  // as a rename (measured R087 on git 2.47), and plain --diff-filter=D then
  // reports nothing -- so without the flag the append-only rule above has a
  // trivial bypass: delete an entry while adding one that looks like it.
  const body = "An earlier change, with a body long enough to score as similar.\n";
  const { git, write, commit, checkFromPrior } = repoWithPriorEntry("blo-1.md", body);
  git("rm", "--quiet", `${LOG_DIR}/blo-1.md`);
  write(SOURCE, BUMP);
  write(`${LOG_DIR}/blo-2.md`, `${body}Plus one more line.\n`);
  commit("supersede an entry by renaming it");

  const result = checkFromPrior();
  assert.equal(result.ok, false, "the rename pairing must not hide the deletion");
  assert.match(result.reason, /append-only/);
});

test("an empty entry file does not satisfy the guard", () => {
  // isEntryPath tests the path and nothing else, so a zero-byte file used to
  // pass -- the same "add nothing" satisfier the row filter already rejects.
  const { write, commit, check } = scratchRepo();
  write(SOURCE, BUMP);
  write(`${LOG_DIR}/blo-1.md`, "");
  commit("touch vendored source, add an empty entry");

  const result = check();
  assert.equal(result.ok, false, "an empty entry records nothing");
  assert.match(result.reason, /records nothing/);
  assert.ok(
    result.detail.some((line) => line.includes("blo-1.md")),
    "the failure should name the empty entry, not ask for one that is already there",
  );
});

test("a whitespace-only entry does not satisfy the guard", () => {
  // Specifically the `+++` exclusion. A bare /^\+\s*\S/ matches the diff
  // header's own plus signs, so without it this file scores 1 and passes.
  const { write, commit, check } = scratchRepo();
  write(SOURCE, BUMP);
  write(`${LOG_DIR}/blo-1.md`, "   \n\t\n");
  commit("touch vendored source, add a whitespace-only entry");

  const result = check();
  assert.equal(result.ok, false, "whitespace is not a record");
  assert.match(result.reason, /records nothing/);
});

test("an entry moved in from a non-entry path still counts as added", () => {
  // --no-renames on the added-entry check. The source here is not an entry, so
  // the append-only rule does not fire; without the flag git pairs the move as
  // a rename, --diff-filter=A comes back empty, and the guard rejects a change
  // that did record itself -- naming only the source file, never the entry.
  const draft = `${LOG_DIR}/notes.txt`;
  const body = "Drafted here first, with a body long enough to pair as a rename.\n";
  const { git, write, commit, base, dir } = scratchRepo();
  write(draft, body);
  commit("leave a draft in the entry directory");
  const draftBase = git("rev-parse", "HEAD").trim();
  assert.notEqual(draftBase, base, "the draft must predate the range under test");

  git("mv", draft, `${LOG_DIR}/blo-2.md`);
  write(SOURCE, BUMP);
  commit("promote the draft to this change's entry");

  assert.deepEqual(
    checkVendoredProvenanceLog({ base: draftBase, head: "HEAD", cwd: dir }),
    { ok: true },
  );
});

test("moving vendored source into the entry directory is rejected", () => {
  // The destination is a valid entry path, which is what makes this the half
  // --no-renames does NOT close: with the flag alone `changed` names the source
  // again, but the destination is then an added entry whose diff is full of the
  // moved source code, so it satisfies substantiveEntries as its own record and
  // the guard passes on a file that has left the vendored tree.
  const { git, commit, check } = scratchRepo();
  // Moved with its content untouched, so git scores it R100. Modifying it in
  // the same range drops the pair below the similarity threshold and git
  // reports D + A instead -- a different, weaker shape that still demands an
  // entry, so it is not this bypass.
  git("mv", SOURCE, `${LOG_DIR}/blo-9.md`);
  commit("launder vendored source into the entry directory");

  const result = check();
  assert.equal(result.ok, false, "source moved into LOG_DIR has left the tree");
  assert.match(result.reason, /moves 1 vendored source file\(s\) into/);
  assert.ok(
    result.detail.some((line) => line.includes(SOURCE) && line.includes("blo-9.md")),
    "the failure should name both ends of the move",
  );
});

test("moving vendored source into the entry directory under a non-entry name is rejected", () => {
  // The --no-renames twin of the case above. `moved.txt` is not an entry path,
  // so addedEntries is empty and the guard would reject on `gained no entry`
  // once `changed` names the source -- but only once it does. Without the flag
  // the move is reported at its destination alone, that destination is filtered
  // out as a LOG_DIR path, and `changed` reaches the early return empty.
  const { git, commit, check } = scratchRepo();
  git("mv", SOURCE, `${LOG_DIR}/moved.txt`);
  commit("launder vendored source under a non-entry name");

  assert.equal(check().ok, false, "a non-entry destination is still a removal");
});

test("moving vendored source onto a NOT_SOURCE path is rejected", () => {
  // The --no-renames on `changed` earns its place here and nowhere else.
  // LOG_DIR is not the only sink `changed` filters out -- NOT_SOURCE is the
  // other, and relocatedIntoLog deliberately does not cover it. A move onto a
  // NOT_SOURCE path that already exists is an M plus a D, so it rejects either
  // way; it pairs as a rename only when the destination is absent at the base,
  // and then the destination is filtered and `changed` comes back empty.
  const { git, commit, dir } = scratchRepo();
  git("rm", "--quiet", `${VENDOR_DIR}/PROVENANCE.md`);
  commit("drop PROVENANCE.md so the move below pairs as a rename");
  const base = git("rev-parse", "HEAD").trim();

  git("mv", SOURCE, `${VENDOR_DIR}/PROVENANCE.md`);
  commit("launder vendored source onto a path `changed` filters out");

  const result = checkVendoredProvenanceLog({ base, head: "HEAD", cwd: dir });
  assert.equal(result.ok, false, "source that left the tree must still be recorded");
  assert.match(result.reason, /gained no entry/);
});

test("an entry with a non-ASCII filename satisfies the guard", () => {
  // core.quotePath defaults on, so git returns `"...caf\303\251.md"` -- quotes
  // and all. That fails isEntryPath and the LOG_DIR filter in `changed`, so the
  // entry was counted as unrecorded vendored source and named as the offender.
  // README.md promises "Any `.md` filename works".
  const { write, commit, check } = scratchRepo();
  write(SOURCE, BUMP);
  write(`${LOG_DIR}/café.md`, "Accented filename.\n");
  commit("record the change under a non-ASCII entry name");

  assert.deepEqual(check(), { ok: true });
});

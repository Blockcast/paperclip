import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("a vendored source change with an appended log row passes", () => {
  const { write, commit, check } = scratchRepo();
  write(SOURCE, "export const manifest = 2;\n");
  write(LOG, `${LOG_HEADER}| \`abc\` | job-manifest.ts | bumped the manifest |\n`);
  commit("touch vendored source and log it");

  // Still accepted -- transitional, see "a legacy row still passes" below.
  assert.equal(check().ok, true);
});

test("deleting a line from the append-only log is rejected", () => {
  // Union merge keeps both sides' added lines and cannot reconcile an edit, so
  // an edited or reordered row would be silently duplicated on the next
  // concurrent append. In a diff, an edit is a deletion.
  const { write, commit, check } = scratchRepo();
  write(SOURCE, "export const manifest = 2;\n");
  write(LOG, "| commit | files | what |\n|---|---|---|\n| `seed` | x | EDITED |\n");
  commit("rewrite an existing log row");

  const result = check();
  assert.equal(result.ok, false);
  assert.match(result.reason, /append-only/);
});

test("editing a log row is rejected even with no source change", () => {
  // The append-only rule is unconditional: `merge=union` duplicates a rewritten
  // row on the next concurrent append whether or not the same PR touched source.
  const { write, commit, check } = scratchRepo();
  write(LOG, "| commit | files | what |\n|---|---|---|\n| `seed` | x | EDITED |\n");
  commit("rewrite an existing log row, nothing else");

  const result = check();
  assert.equal(result.ok, false);
  assert.match(result.reason, /append-only/);
});

test("appending a log row on its own is not itself a change needing a row", () => {
  const { write, commit, check } = scratchRepo();
  write(LOG, `${LOG_HEADER}| \`abc\` | - | a note |\n`);
  commit("log append only");

  assert.deepEqual(check(), { ok: true });
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

test("a log git treats as binary is rejected, not silently passed", () => {
  // `git diff --numstat` emits `-\t-` for a binary blob, so both counts parse
  // to NaN and every comparison against them is false. Without an explicit
  // non-finite check the guard passes on exactly the input it exists to
  // reject. A stray NUL from a bad editor or a pasted binary snippet is enough.
  //
  // Asserting the *reason* is what makes this a real mutation test: drop the
  // non-finite check and the destructive rewrite below stops being reported as
  // an unverifiable file, which is the defect. The no-source-change case is
  // the pure fail-open -- with the check gone it returns ok:true outright.
  const withSource = scratchRepo();
  withSource.write(SOURCE, "export const manifest = 2;\n");
  withSource.write(LOG, `${LOG_HEADER}| \`abc\` | job\0manifest.ts | binary now |\n`);
  withSource.commit("rewrite the log as a binary blob, and touch source");

  const a = withSource.check();
  assert.equal(a.ok, false);
  assert.match(a.reason, /not a text file/);

  const logOnly = scratchRepo();
  logOnly.write(LOG, "| commit | files | what |\n|---|---|---|\n| `seed` | x | \0 |\n");
  logOnly.commit("destructively rewrite the log as a binary blob");

  const b = logOnly.check();
  assert.equal(b.ok, false, "a binary log must never verify as ok");
  assert.match(b.reason, /not a text file/);
});

test("a blank added line does not satisfy the require-a-row guard", () => {
  // `added > 0` counts lines, and a blank line is a line. Requiring an added
  // line shaped like a table row keeps the cheapest way to silence the guard
  // being to actually write the row.
  const { write, commit, check } = scratchRepo();
  write(SOURCE, "export const manifest = 2;\n");
  write(LOG, `${LOG_HEADER}\n   \n`);
  commit("touch vendored source, append only whitespace");

  const result = check();
  assert.equal(result.ok, false);
  assert.match(result.reason, /gained no entry/);
});

test("a change that does not touch the vendored tree at all passes", () => {
  const { write, commit, check } = scratchRepo();
  write("README.md", "unrelated\n");
  commit("unrelated");

  assert.deepEqual(check(), { ok: true });
});

test("commits that landed on the base branch are not attributed to this change", () => {
  // $PR_BASE_SHA is the base branch's *tip*, not the merge base. A two-dot diff
  // against it reports the base's own log rows as deletions, so an unrelated
  // append on master would fail every open vendored PR with a bogus
  // "append-only" violation. The three-dot range is what prevents that.
  const { dir, git, write, commit, base } = scratchRepo();

  git("checkout", "--quiet", "-b", "feature");
  write(SOURCE, "export const manifest = 2;\n");
  write(LOG, `${LOG_HEADER}| \`fff\` | job-manifest.ts | the PR's own change |\n`);
  commit("feature work, logged");

  git("checkout", "--quiet", "master");
  write(LOG, `${LOG_HEADER}| \`mmm\` | - | landed on master after the branch point |\n`);
  commit("unrelated master append");
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

  // Branch A: edits one vendored source file and appends its row.
  git("checkout", "--quiet", "-b", "branch-a");
  write(SOURCE, "export const manifest = 2;\n");
  write(LOG, `${LOG_HEADER}| \`aaa\` | job-manifest.ts | change A |\n`);
  commit("change A");

  // Branch B: edits a different vendored source file and appends its own row.
  git("checkout", "--quiet", "-b", "branch-b", base);
  write(SECOND_SOURCE, "export const execute = 2;\n");
  write(LOG, `${LOG_HEADER}| \`bbb\` | execute.ts | change B |\n`);
  commit("change B");

  // Before BLO-34872 + BLO-35109 this rebase conflicted every time: on the log
  // row, on the 64-hex hash, and on the version line in three files.
  git("rebase", "branch-a");

  const merged = readFileSync(join(dir, LOG), "utf8");
  assert.ok(merged.includes("change A"), "union merge dropped branch A's row");
  assert.ok(merged.includes("change B"), "union merge dropped branch B's row");
  assert.ok(!merged.includes("<<<<<<<"), "the rebase left conflict markers");

  // And the rebased result still satisfies the guard.
  assert.equal(checkVendoredProvenanceLog({ base, head: "HEAD", cwd: dir }).ok, true);
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
function mergeWithoutDrivers(record) {
  const ctx = scratchRepo();
  const { dir, git, base } = ctx;
  const branches = [
    { id: "a", source: SOURCE },
    { id: "b", source: SECOND_SOURCE },
  ];

  // $GIT_DIR/info/attributes has the highest precedence, so this overrides the
  // union line in the tree's own .gitattributes. That is the GitHub equivalence.
  mkdirSync(join(dir, ".git", "info"), { recursive: true });
  writeFileSync(join(dir, ".git", "info", "attributes"), `${LOG} merge=text\n`);

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

test("CONTROL: concurrent appends to the single log file conflict without drivers", () => {
  // The failure as measured on 2026-09-30: master 0bb33a1a7, #2070 ejected at
  // 17:04:28Z and #1459 at 17:07:02Z, both `merge_conflict`, both in this file
  // and nothing else, both clean under a local merge with the union attribute.
  const { clean, output } = mergeWithoutDrivers((ctx, branch) => {
    ctx.write(LOG, `${LOG_HEADER}| \`${branch.id}\` | ${branch.source} | change ${branch.id} |\n`);
  });
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

test("one file per change merges cleanly without drivers (BLO-34872 round 2)", () => {
  const { clean, output } = mergeWithoutDrivers((ctx, branch) => {
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

test("a legacy row still passes, but is warned about", () => {
  // Transitional on purpose: PRs already in the queue appended to the old file
  // and must not all be rewritten. The warning is what stops it being the
  // silent default -- appending there is what reproduces the conflict.
  const { write, commit, check } = scratchRepo();
  write(SOURCE, "export const manifest = 2;\n");
  write(LOG, `${LOG_HEADER}| \`abc\` | job-manifest.ts | bumped the manifest |\n`);
  commit("touch vendored source, append to the frozen log");

  const result = check();
  assert.equal(result.ok, true);
  assert.match(result.warning ?? "", /frozen/);
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

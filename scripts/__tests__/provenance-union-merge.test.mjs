import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import {
  LOG,
  NOT_SOURCE,
  VENDOR_DIR,
  checkVendoredProvenanceLog,
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
  assert.match(result.reason, /gained no row/);
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

  assert.deepEqual(check(), { ok: true });
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
  assert.match(result.reason, /gained no row/);
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

  assert.deepEqual(
    checkVendoredProvenanceLog({ base: baseTip, head: "HEAD", cwd: dir }),
    { ok: true },
  );
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
  assert.deepEqual(checkVendoredProvenanceLog({ base, head: "HEAD", cwd: dir }), { ok: true });
});

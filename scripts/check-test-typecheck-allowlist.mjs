#!/usr/bin/env node
/**
 * check-test-typecheck-allowlist.mjs
 *
 * `server/tsconfig.json` excludes `src/__tests__` so tests stay out of `dist/`,
 * and `typecheck` and `build` share that config -- so nothing typechecks a
 * server test except the gated allowlist in `server/tsconfig.tests.json`
 * (BLO-38582). A test file outside that allowlist is NOT typechecked, and
 * `pnpm typecheck` exits 0 anyway. That pass is VACUOUS, and it reads exactly
 * like a real one.
 *
 * PEN-4186 measured the gap at master 6b4d6a1d: 726 test files under
 * `server/src/__tests__/`, 6 entries in `include`. `git grep -l tsconfig.tests`
 * returned only the npm script that runs it and one test file's prose -- no
 * guard compared the two sets, so a new test file landed outside the gate by
 * default and silently. PEN-3889's author reported "typecheck passed" on a new
 * file, then injected a deliberate type error; `typecheck` still exited 0.
 *
 * DECISION (PEN-4186): enforce for ADDED files only. A brand-new test file is
 * the one population whose cost is near zero -- it has no pre-existing errors
 * by construction and no concurrent PRs touching it, so the merge-tree binding
 * the config's own `//ratchet-is-continuous` header warns about does not yet
 * apply to it. Demanding the ~720-file backlog at once is NOT this guard's job
 * and it deliberately never asks for it.
 *
 * The counter-argument, stated rather than buried: that merge-tree cost is
 * DEFERRED, not absent. A file free to add today binds every future PR that
 * touches it. This guard converts a silent gap into a standing tax, knowingly,
 * because the alternative is a green check that verified nothing -- and people
 * cite those. The decision is reversible by deleting this file and its pr.yml
 * step; the entries it forced in stay, and `include` still only grows.
 *
 * Four arms. The first three defend the gate; the fourth defends the ratchet,
 * because a guard that forces files IN while leaving a one-line exit OUT is
 * defeatable, and a defeatable guard is worse than none once people cite it.
 *
 *   1. no globs      -- every `include` entry is a literal path. This guard
 *                       matches by exact path; a glob entry would be silently
 *                       unmatchable, so it is refused loudly instead.
 *   2. no dangling   -- every `include` entry names a file that EXISTS. tsc
 *                       silently ignores a missing literal include entry (it
 *                       only errors when ALL inputs are missing), so a rename
 *                       retires the gate for that file while leaving `include`
 *                       the same length. "Never shrink" is satisfied in letter.
 *   3. added covered -- every ADDED `.test.ts`/`.test.tsx` anywhere under
 *                       `server/src/__tests__/` is in `include`. This is
 *                       PEN-4186's actual ask.
 *   4. ratchet       -- an entry present on the base may only disappear if the
 *                       file it named was DELETED in the same diff. The config
 *                       header names dropping the entry as "the cheapest-looking
 *                       repair", which "silently retires the gate and leaves
 *                       `typecheck` green".
 *
 * Arms 1, 2 read the working tree (in CI, the merge tree -- which is what gets
 * typechecked). Arms 3, 4 read the base...head diff. Each arm is internally
 * consistent; they are not compared against each other.
 *
 * KNOWN CEILING: base, not siblings. Two concurrent PRs can each add a test
 * file and both pass; neither needs the other's entry. That is correct -- the
 * union is still fully allowlisted once both land.
 *
 * A branch cut before this guard existed does NOT escape: pr.yml also runs on
 * `merge_group`, where PR_BASE_SHA is the queue's own base_sha, so the file
 * reads as ADDED against the queue base however old the branch is. What
 * escapes is only a path that never reaches either trigger -- an admin merge
 * that bypasses the queue, or a direct push to master.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TSCONFIG_PATH = "server/tsconfig.tests.json";
/** `include` entries are relative to the tsconfig's own directory. */
export const TSCONFIG_DIR = "server";
export const TESTS_DIR = "server/src/__tests__";

const GLOB_CHARS = /[*?]/;
const TEST_FILE = /\.test\.tsx?$/;

/** An `include` entry (`src/__tests__/a.test.ts`) as a repo path. */
export const toRepoPath = (entry) => `${TSCONFIG_DIR}/${entry}`;
/** The inverse: a repo path as the `include` entry that would cover it. */
export const toIncludeEntry = (repoPath) => repoPath.slice(TSCONFIG_DIR.length + 1);

export const isGatedTestFile = (repoPath) =>
  repoPath.startsWith(`${TESTS_DIR}/`) && TEST_FILE.test(repoPath);

/**
 * @param {object} args
 * @param {unknown} args.include head `include` array
 * @param {unknown} [args.baseInclude] base `include` array; omit to skip arm 4
 * @param {string[]} [args.addedFiles] repo-relative paths added in base...head
 * @param {(repoPath: string) => boolean} args.fileExists existence in the head tree
 * @param {string} [args.baseLabel]
 * @returns {string[]} one message per problem; empty means the gate is intact
 */
export function checkAllowlist({
  include,
  baseInclude,
  addedFiles = [],
  fileExists,
  baseLabel = "the base branch",
}) {
  // Fail closed. An `include` this guard cannot read would satisfy every arm
  // vacuously -- which is the exact silent pass the whole file exists to stop.
  if (!Array.isArray(include) || include.length === 0) {
    return [`${TSCONFIG_PATH}: no readable \`include\` array. Refusing to pass a config this guard cannot read.`];
  }

  const problems = [];
  const includeSet = new Set(include);

  // --- arm 1: literal paths only ------------------------------------------
  for (const entry of include) {
    if (typeof entry !== "string") {
      problems.push(`${TSCONFIG_PATH}: \`include\` entry ${JSON.stringify(entry)} is not a string.`);
    } else if (GLOB_CHARS.test(entry)) {
      problems.push(`${TSCONFIG_PATH}: \`include\` entry "${entry}" contains a glob. This guard matches by exact path, so a glob entry is unmatchable here and every arm would silently under-report. Either list the files literally, or teach scripts/check-test-typecheck-allowlist.mjs tsconfig glob semantics -- do not leave it to drift.`);
    }
  }
  // A malformed entry makes every path-keyed arm below unreliable.
  if (problems.length > 0) return problems;

  // --- arm 2: no dangling entries -----------------------------------------
  // tsc ignores a missing literal include entry unless ALL inputs are missing,
  // so this is how a rename retires the gate at constant `include` length.
  for (const entry of include) {
    const repoPath = toRepoPath(entry);
    if (!fileExists(repoPath)) {
      problems.push(`${TSCONFIG_PATH}: \`include\` names "${entry}", which does not exist. tsc silently ignores a missing literal entry, so this file is no longer typechecked by anything while \`include\` still looks the same length. Update the entry if the file was renamed; remove it if the file was deleted.`);
    }
  }

  // --- arm 3: every ADDED test file is allowlisted ------------------------
  const uncovered = addedFiles.filter((p) => isGatedTestFile(p) && !includeSet.has(toIncludeEntry(p))).sort();
  if (uncovered.length > 0) {
    problems.push(
      `${uncovered.length} test file(s) added in this diff are absent from ${TSCONFIG_PATH} \`include\`, so nothing typechecks them and \`pnpm typecheck\` passes vacuously on them (PEN-4186). Add to \`include\`:\n` +
        uncovered.map((p) => `      "${toIncludeEntry(p)}",`).join("\n") +
        `\n    This is scoped to files ADDED in this diff only -- it never asks for the pre-existing backlog.`,
    );
  }

  // --- arm 4: the ratchet -- include may only ever grow -------------------
  if (Array.isArray(baseInclude)) {
    // Keyed on "the file still exists", NOT on "this diff deleted it". The two
    // look equivalent and are not: `baseInclude` is read at PR_BASE_SHA while
    // `include` is read from the working tree, which in CI is the MERGE tree.
    // So when master deletes an allowlisted file and its entry, a re-run of an
    // unrelated PR sees the entry gone from `include`, still present in
    // `baseInclude`, and absent from its own `base...head` deletions -- and
    // would go red on a file it never touched. Existence is read from the same
    // tree that gets typechecked, so it cannot drift that way, and it is what
    // the message below already claims to be asserting.
    const dropped = baseInclude
      .filter((entry) => typeof entry === "string" && !includeSet.has(entry) && fileExists(toRepoPath(entry)))
      .sort();
    if (dropped.length > 0) {
      problems.push(
        `${dropped.length} \`include\` entr(y/ies) present on ${baseLabel} were removed, but the file(s) still exist:\n` +
          dropped.map((entry) => `      "${entry}"`).join("\n") +
          `\n    ${TSCONFIG_PATH}'s own header names this as "the cheapest-looking repair", which "silently retires the gate and leaves \`typecheck\` green". If a merge-tree typecheck error landed on lines your diff never touched, rebase and sweep the new call sites. Never shrink \`include\`.`,
      );
    }
  }

  return problems;
}

/** Read a path at a git ref. Throws rather than letting an arm degrade to "clean". */
export function readAtRef({ repoRoot, ref, path, exec = execFileSync }) {
  try {
    return exec("git", ["show", `${ref}:${path}`], {
      encoding: "utf8",
      cwd: repoRoot,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(`cannot read ${path} at ${ref}: ${err.message}. pr.yml checks this job out with fetch-depth: 0, so a missing base is a failure, not a skip.`);
  }
}

/**
 * Added and deleted paths in `base...head`.
 *
 * `--no-renames` is load-bearing: with rename detection a moved test file is
 * one `R` row and appears in NEITHER set, so arm 3 would never ask for the
 * renamed file's entry. Split into D + A, the new path is an `A` row and arm 3
 * demands it.
 */
export function readDiffNameStatus({ repoRoot, base, head, exec = execFileSync }) {
  const out = exec("git", ["diff", "--name-status", "--no-renames", `${base}...${head}`], {
    encoding: "utf8",
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const addedFiles = [];
  const deletedFiles = [];
  for (const line of out.split("\n")) {
    const [status, path] = line.split("\t");
    if (!path) continue;
    if (status === "A") addedFiles.push(path);
    else if (status === "D") deletedFiles.push(path);
  }
  return { addedFiles, deletedFiles };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const base = process.argv[2] || process.env.PR_BASE_SHA || "";
  const head = process.argv[3] || process.env.PR_HEAD_SHA || "HEAD";

  const include = JSON.parse(readFileSync(join(repoRoot, TSCONFIG_PATH), "utf8")).include;
  const fileExists = (repoPath) => existsSync(join(repoRoot, repoPath));

  let diff = { addedFiles: [], deletedFiles: [] };
  let baseInclude;
  if (base) {
    diff = readDiffNameStatus({ repoRoot, base, head });
    baseInclude = JSON.parse(readAtRef({ repoRoot, ref: base, path: TSCONFIG_PATH })).include;
  } else if (process.env.GITHUB_ACTIONS) {
    // Arms 3 and 4 are the whole point and both are base-relative. Passing
    // here would be a required check going green having checked the two arms
    // that cannot see a newly added file. pr.yml populates PR_BASE_SHA for
    // both of its triggers today; this throw is what keeps that true when a
    // third trigger is added.
    console.error("ERROR: no base ref (PR_BASE_SHA unset) in CI. This guard's added-file and ratchet arms are base-relative, so passing here would be a green check that could not see a new test file at all.");
    process.exit(1);
  }

  const problems = checkAllowlist({
    include,
    baseInclude,
    addedFiles: diff.addedFiles,
    fileExists,
    baseLabel: base ? `the base branch (${base.slice(0, 9)})` : "the base branch",
  });

  if (problems.length > 0) {
    console.error(`ERROR: ${TSCONFIG_PATH} no longer gates what it claims to (PEN-4186)\n`);
    for (const problem of problems) console.error(`  ${problem}\n`);
    process.exit(1);
  }
  const scope = base ? `${diff.addedFiles.length} added file(s) vs ${base.slice(0, 9)}` : "working tree only (no base ref)";
  console.log(`  ✓  ${TSCONFIG_PATH}: ${include.length} allowlisted test file(s) all present; ${scope} clean.`);
}

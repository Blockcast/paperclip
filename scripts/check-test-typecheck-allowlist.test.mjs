import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TESTS_DIR,
  TSCONFIG_PATH,
  checkAllowlist,
  isGatedTestFile,
  readDiffNameStatus,
  toIncludeEntry,
  toRepoPath,
} from "./check-test-typecheck-allowlist.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Fixtures: the REAL allowlist shape, so these keep reproducing after the live
// `include` grows. Entry paths are relative to `server/`.
// ---------------------------------------------------------------------------
const GATED = "src/__tests__/pr-comment-review-gate.test.ts";
const ALSO_GATED = "src/__tests__/zoned-cron-equivalence.test.ts";
const BASELINE = [GATED, ALSO_GATED];

/** Every allowlisted file exists; nothing else does. */
const existsOnly = (...repoPaths) => {
  const present = new Set(repoPaths);
  return (p) => present.has(p);
};
const allGatedExist = (include) => existsOnly(...include.map(toRepoPath));

const check = (overrides = {}) =>
  checkAllowlist({
    include: BASELINE,
    baseInclude: BASELINE,
    fileExists: allGatedExist(overrides.include ?? BASELINE),
    baseLabel: "master",
    ...overrides,
  });

// ---------------------------------------------------------------------------
// Baseline: the guard must be able to PASS. A check that is always red is as
// useless as one that is always green -- it just fails in the other direction.
// ---------------------------------------------------------------------------
test("clean tree with no added test files passes", () => {
  assert.deepEqual(check(), []);
});

test("an added test file that IS allowlisted passes", () => {
  const added = `${TESTS_DIR}/brand-new.test.ts`;
  const include = [...BASELINE, toIncludeEntry(added)];
  assert.deepEqual(
    check({ include, fileExists: existsOnly(...include.map(toRepoPath)), addedFiles: [added] }),
    [],
  );
});

// ---------------------------------------------------------------------------
// Arm 3 -- PEN-4186's actual ask. THIS IS THE NEGATIVE CONTROL: the guard is
// shown to go red on an added-but-unlisted test file, and green once listed.
// ---------------------------------------------------------------------------
test("arm 3: an added test file absent from `include` is rejected, and naming it fixes it", () => {
  const added = `${TESTS_DIR}/brand-new.test.ts`;

  const red = check({ addedFiles: [added], fileExists: existsOnly(...BASELINE.map(toRepoPath), added) });
  assert.equal(red.length, 1);
  assert.match(red[0], /brand-new\.test\.ts/);
  assert.match(red[0], /vacuously/);
  // The message must carry the exact line to paste, or the remedy is a guess.
  assert.match(red[0], /"src\/__tests__\/brand-new\.test\.ts",/);

  const include = [...BASELINE, toIncludeEntry(added)];
  assert.deepEqual(
    check({ include, baseInclude: BASELINE, addedFiles: [added], fileExists: existsOnly(...include.map(toRepoPath)) }),
    [],
  );
});

test("arm 3: .test.tsx counts, and a nested path counts", () => {
  const nested = `${TESTS_DIR}/nested/dir/thing.test.tsx`;
  const problems = check({ addedFiles: [nested], fileExists: existsOnly(...BASELINE.map(toRepoPath), nested) });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /nested\/dir\/thing\.test\.tsx/);
});

test("arm 3: non-test files and files outside the tests dir are NOT demanded", () => {
  // The backlog is ~720 files; this guard must never widen beyond new tests.
  const ignored = [
    `${TESTS_DIR}/helpers/fixture-builder.ts`, // helper, not a `.test.` file
    "server/src/routes/new-route.ts", // ordinary src, already typechecked
    "ui/src/__tests__/widget.test.ts", // a different package's tests
    "server/src/__tests__notes.md",
  ];
  assert.deepEqual(check({ addedFiles: ignored, fileExists: existsOnly(...BASELINE.map(toRepoPath), ...ignored) }), []);
});

test("arm 3: a test file that already existed is NOT demanded", () => {
  // Scoped to ADDED files only -- an existing file is the backlog, not this row.
  const existing = `${TESTS_DIR}/ancient-untyped.test.ts`;
  assert.deepEqual(
    check({ addedFiles: [], fileExists: existsOnly(...BASELINE.map(toRepoPath), existing) }),
    [],
  );
});

// ---------------------------------------------------------------------------
// Arm 4 -- the ratchet. `include` may only ever grow.
// ---------------------------------------------------------------------------
test("arm 4: dropping an entry whose file still exists is rejected", () => {
  const problems = check({ include: [GATED], baseInclude: BASELINE, fileExists: existsOnly(...BASELINE.map(toRepoPath)) });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /zoned-cron-equivalence\.test\.ts/);
  assert.match(problems[0], /Never shrink/);
});

test("arm 4: dropping an entry IS allowed once its file no longer exists", () => {
  assert.deepEqual(
    check({
      include: [GATED],
      baseInclude: BASELINE,
      fileExists: existsOnly(toRepoPath(GATED)),
    }),
    [],
  );
});

test("arm 4: a drop made by the BASE, not by this diff, is not this PR's red", () => {
  // The base-drift case. `baseInclude` is read at PR_BASE_SHA but `include` is
  // read from the merge tree, so when master retires an allowlisted file and
  // its entry, an unrelated PR sees: entry gone from `include`, still present
  // in `baseInclude`, and absent from its OWN base...head deletions. Keying on
  // the deletion set reddened that PR for a file it never touched; keying on
  // existence -- read from the same tree that gets typechecked -- does not.
  //
  // `addedFiles`/deletions are empty on purpose: this PR touched nothing.
  assert.deepEqual(
    check({
      include: [GATED],
      baseInclude: BASELINE,
      addedFiles: [],
      fileExists: existsOnly(toRepoPath(GATED)),
    }),
    [],
  );
});

test("arm 4: a rename must move the entry, not drop it", () => {
  // `--no-renames` splits a rename into D(old) + A(new), so BOTH arms engage:
  // dropping the old entry is allowed, and the new path must be allowlisted.
  const from = toRepoPath(ALSO_GATED);
  const to = `${TESTS_DIR}/zoned-cron-equivalence.renamed.test.ts`;

  const dropped = check({
    include: [GATED],
    baseInclude: BASELINE,
    addedFiles: [to],
    fileExists: existsOnly(toRepoPath(GATED), to),
  });
  assert.equal(dropped.length, 1);
  assert.match(dropped[0], /renamed\.test\.ts/); // arm 3 asks for the new path

  const moved = [GATED, toIncludeEntry(to)];
  assert.deepEqual(
    check({
      include: moved,
      baseInclude: BASELINE,
      addedFiles: [to],
        fileExists: existsOnly(...moved.map(toRepoPath)),
    }),
    [],
  );
});

test("arm 4 is skipped, not failed, when there is no base", () => {
  assert.deepEqual(check({ include: [GATED], baseInclude: undefined, fileExists: existsOnly(toRepoPath(GATED)) }), []);
});

// ---------------------------------------------------------------------------
// Arm 2 -- a dangling entry. tsc ignores a missing literal include entry
// unless ALL inputs are missing, so this retires the gate at constant length.
// ---------------------------------------------------------------------------
test("arm 2: an `include` entry naming a file that does not exist is rejected", () => {
  const problems = check({ fileExists: existsOnly(toRepoPath(GATED)) });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /zoned-cron-equivalence\.test\.ts/);
  assert.match(problems[0], /does not exist/);
});

// ---------------------------------------------------------------------------
// Arm 1 -- literal paths only. The guard matches by exact path, so it must
// refuse a shape it cannot match rather than under-report against it.
// ---------------------------------------------------------------------------
test("arm 1: a glob entry is refused loudly rather than silently unmatched", () => {
  const problems = checkAllowlist({
    include: ["src/__tests__/*.test.ts"],
    fileExists: () => true,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /contains a glob/);
});

test("arm 1: a malformed entry short-circuits the path-keyed arms", () => {
  // Every later arm is keyed on entry strings; running them against a
  // non-string would under-report rather than fail.
  const problems = checkAllowlist({ include: [GATED, 42], fileExists: () => true });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /is not a string/);
});

// ---------------------------------------------------------------------------
// Fail-closed on an unreadable config. An `include` this guard cannot read
// would satisfy every arm vacuously -- the exact failure mode it exists for.
// ---------------------------------------------------------------------------
for (const [label, include] of [
  ["missing", undefined],
  ["not an array", { "src/a.test.ts": true }],
  ["empty", []],
]) {
  test(`fail-closed: \`include\` ${label} is a failure, not a vacuous pass`, () => {
    const problems = checkAllowlist({ include, fileExists: () => true, addedFiles: [`${TESTS_DIR}/x.test.ts`] });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /Refusing to pass a config this guard cannot read/);
  });
}

// ---------------------------------------------------------------------------
// Path helpers, pinned because every arm is keyed on them.
// ---------------------------------------------------------------------------
test("path helpers round-trip between `include` entries and repo paths", () => {
  assert.equal(toRepoPath(GATED), `${TESTS_DIR}/pr-comment-review-gate.test.ts`);
  assert.equal(toIncludeEntry(toRepoPath(GATED)), GATED);
  assert.equal(isGatedTestFile(`${TESTS_DIR}/a.test.ts`), true);
  assert.equal(isGatedTestFile(`${TESTS_DIR}/a.ts`), false);
  assert.equal(isGatedTestFile("server/src/a.test.ts"), false);
});

// ---------------------------------------------------------------------------
// `--no-renames` is load-bearing: with rename detection on, a moved test file
// is one `R` row and lands in NEITHER set, so arm 3 never asks for the new
// entry. Driven against a real git repo, because that is where the default
// lives -- asserting it off a flag string would pass against the bug.
// ---------------------------------------------------------------------------
test("readDiffNameStatus splits a rename into delete + add", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "allowlist-guard-"));
  const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("init", "-q", "-b", "master");
    git("config", "user.email", "guard-test@example.invalid");
    git("config", "user.name", "Guard Test");
    // Rename detection is on by default; make it maximally likely to fire.
    git("config", "diff.renames", "true");
    mkdirSync(join(repoRoot, TESTS_DIR), { recursive: true });
    const body = `test("x", () => {});\n`.repeat(40);
    writeFileSync(join(repoRoot, TESTS_DIR, "old.test.ts"), body);
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").trim();
    git("mv", `${TESTS_DIR}/old.test.ts`, `${TESTS_DIR}/new.test.ts`);
    git("commit", "-qm", "rename");

    const { addedFiles, deletedFiles } = readDiffNameStatus({ repoRoot, base, head: "HEAD" });
    assert.deepEqual(addedFiles, [`${TESTS_DIR}/new.test.ts`]);
    assert.deepEqual(deletedFiles, [`${TESTS_DIR}/old.test.ts`]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The live config must satisfy this guard's own whole-tree arms. If it ever
// does not, the guard is red on master and the message says which arm.
// ---------------------------------------------------------------------------
test("the real server/tsconfig.tests.json passes arms 1 and 2", async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const include = JSON.parse(readFileSync(join(REPO_ROOT, TSCONFIG_PATH), "utf8")).include;
  assert.ok(Array.isArray(include) && include.length > 0, `${TSCONFIG_PATH} has no readable include`);
  assert.deepEqual(
    checkAllowlist({ include, fileExists: (p) => existsSync(join(REPO_ROOT, p)) }),
    [],
  );
});

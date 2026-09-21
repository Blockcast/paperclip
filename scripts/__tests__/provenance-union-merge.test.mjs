import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// BLO-34872. The vendored adapter's per-patch log is append-only, so before the
// split every PR touching that tree conflicted with every other one on it --
// 4 rebases on PR #1873 alone, PROVENANCE.md the only conflicting file each
// time. The fix is `merge=union` on the log file, scoped to that file only.
//
// The whole safety of that fix rests on two agreements that nothing else
// checks, and both fail silently:
//
//   1. a union-merged file must be excluded from the integrity hash, or the
//      next append breaks the vendor_claude_k8s job for reasons nobody will
//      connect to `.gitattributes`;
//   2. a union-merged file must never contain a 64-hex line, or a union keeps
//      BOTH sides' lines and CI's `grep ... | head -1` picks whichever sorts
//      first -- a provenance verdict decided by merge ordering rather than by
//      the tree, which fails permissively on one of the two orderings.
//
// Rename the log file in one place and not the other and both agreements break
// with a green build. Hence this test rather than a comment.

const repoRoot = new URL("../../", import.meta.url);
const VENDOR_DIR = "vendor/paperclip-adapter-claude-k8s";

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

/**
 * The alternation the vendor_claude_k8s job excludes from the integrity hash,
 * read out of the workflow itself so a drift between the two is a failure here
 * rather than a surprise in CI.
 */
function ciExclusionAlternatives(source, label) {
  const all = source.match(/grep -vxE '([^']+)'/g);
  assert.ok(all, `${label}: no \`grep -vxE '...'\` exclusion found`);
  // A second vendored tree with its own provenance job would bind every
  // assertion below to whichever regex appears first, leaving the suite green
  // while guarding the wrong job.
  assert.equal(
    all.length,
    1,
    `${label}: expected exactly one \`grep -vxE '...'\` exclusion regex, found ${all.length}`,
  );
  return source.match(/grep -vxE '([^']+)'/)[1].split("|");
}

const workflow = read(".github/workflows/pr.yml");
const provenance = read(`${VENDOR_DIR}/PROVENANCE.md`);

test("every union-merged vendor file is excluded from the integrity hash", () => {
  const union = unionMergedPaths().filter((p) => p.startsWith(`${VENDOR_DIR}/`));
  assert.ok(
    union.length > 0,
    "expected at least one merge=union path under the vendored tree; if the log file was renamed, update .gitattributes",
  );

  // The CI step runs with working-directory: vendor/..., so `git ls-files`
  // emits vendor-relative paths and the regex is written against those.
  const excluded = ciExclusionAlternatives(workflow, ".github/workflows/pr.yml");

  for (const path of union) {
    const relative = path.slice(`${VENDOR_DIR}/`.length);
    const escaped = relative.replace(/\./g, "\\.");
    assert.ok(
      excluded.includes(escaped),
      `${path} is merge=union but the vendor_claude_k8s exclusion regex does not name '${escaped}' (it has: ${excluded.join("|")}). A union-merged file inside the hash breaks the provenance job on the next concurrent append.`,
    );
  }
});

test("PROVENANCE.md's documented regenerate command matches the one CI runs", () => {
  // Two copies of the same alternation; a reader who follows the doc and gets a
  // different hash than CI has no way to tell which is wrong.
  assert.deepEqual(
    ciExclusionAlternatives(provenance, `${VENDOR_DIR}/PROVENANCE.md`),
    ciExclusionAlternatives(workflow, ".github/workflows/pr.yml"),
  );
});

test("no union-merged file carries a 64-hex line, and PROVENANCE.md carries exactly one", () => {
  for (const path of unionMergedPaths()) {
    const matches = read(path).split("\n").filter((l) => HEX64.test(l));
    assert.deepEqual(
      matches,
      [],
      `${path} is merge=union and contains a 64-hex line. A union keeps both sides' copies, so CI's \`grep -oE '^[0-9a-f]{64}$' | head -1\` would resolve by sort order instead of by the tree.`,
    );
  }

  const hashLines = provenance.split("\n").filter((l) => HEX64.test(l));
  assert.equal(
    hashLines.length,
    1,
    `expected exactly one integrity hash line in ${VENDOR_DIR}/PROVENANCE.md, found ${hashLines.length}`,
  );
});

test("PROVENANCE.md itself is not union-merged", () => {
  assert.ok(
    !unionMergedPaths().includes(`${VENDOR_DIR}/PROVENANCE.md`),
    "PROVENANCE.md holds the integrity hash; union-merging it is the exact failure this split exists to avoid",
  );
});

test("the exclusion regex names no file that is absent from the vendored tree", () => {
  // Catches the other half of a rename: the regex still excluding the old
  // filename would leave a stale hole in the hash.
  const tracked = new Set(
    execFileSync("git", ["ls-files"], {
      cwd: new URL(`${VENDOR_DIR}/`, repoRoot),
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean),
  );

  for (const alternative of ciExclusionAlternatives(workflow, ".github/workflows/pr.yml")) {
    const filename = alternative.replace(/\\/g, "");
    assert.ok(
      tracked.has(filename),
      `the vendor_claude_k8s exclusion regex names '${filename}', which is not tracked under ${VENDOR_DIR}. A stale exclusion silently drops a real file from the integrity hash.`,
    );
  }
});

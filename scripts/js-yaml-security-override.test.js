import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// BLO-32908 / Dependabot alert Blockcast/paperclip#174.
// GHSA-2883-xcg3-v3hh (CVE-2026-84375): js-yaml >=4.0.0 <4.3.2 lets an empty
// merge source bypass the maxTotalMergeKeys accounting, so a small document
// with many empty merges still burns unbounded CPU. Nothing here depends on
// js-yaml directly -- scripts/check-workflows-parse.mjs says so outright, and
// deliberately uses actionlint instead for that reason -- so the only lever is
// the pnpm override, and the only thing that proves the override took is what
// the lockfile actually resolved.
test("js-yaml resolves above the GHSA-2883-xcg3-v3hh patched floor", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");

  assert.equal(packageJson.pnpm.overrides["js-yaml"], ">=4.3.2 <5");

  // Two spaces then a bare `js-yaml@`: top-level package keys only. The quoted
  // `'@types/js-yaml@4.0.9'` keys must not match -- that is a distinct
  // types-only package with its own version line, and 4.0.9 would read as
  // vulnerable under this advisory's range if it were folded in here.
  const resolutions = [
    ...lockfile.matchAll(/^  js-yaml@(\d+)\.(\d+)\.(\d+):$/gm),
  ];
  assert.ok(resolutions.length > 0, "lockfile missing js-yaml resolution");

  // Assert on every resolution, not the first: a single outlier entry left
  // inside the vulnerable range is the whole question, and a check that stops
  // at the common case would report green on it.
  for (const resolution of resolutions) {
    const [major, minor, patch] = resolution.slice(1).map(Number);
    assert.ok(
      major > 4 ||
        (major === 4 && (minor > 3 || (minor === 3 && patch >= 2))),
      `lockfile resolved vulnerable js-yaml ${major}.${minor}.${patch}`,
    );
  }
});

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

// Assert on EVERY resolution, not the first: a single outlier entry left inside
// the vulnerable range is the whole question, and a check that stops at the
// common case would report green on it.
function assertPatched(versions, where) {
  assert.ok(versions.length > 0, `${where}: no js-yaml resolution found`);
  for (const [major, minor, patch] of versions) {
    assert.ok(
      major > 4 || (major === 4 && (minor > 3 || (minor === 3 && patch >= 2))),
      `${where} resolved vulnerable js-yaml ${major}.${minor}.${patch}`,
    );
  }
}
test("js-yaml resolves above the GHSA-2883-xcg3-v3hh patched floor", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");

  assert.equal(packageJson.pnpm.overrides["js-yaml"], ">=4.3.2 <5");

  // Two spaces then a bare `js-yaml@`: top-level package keys only. The quoted
  // `'@types/js-yaml@4.0.9'` keys must not match -- that is a distinct
  // types-only package with its own version line, and 4.0.9 would read as
  // vulnerable under this advisory's range if it were folded in here. They
  // start `'@types/`, so the bare-name anchor excludes them even though the
  // optional quote is allowed. Nothing is required after the version, so a
  // peer-suffixed key (`js-yaml@4.3.2(peer)`) is still checked rather than
  // silently skipped.
  const resolutions = [
    ...lockfile.matchAll(/^ {2}'?js-yaml@(\d+)\.(\d+)\.(\d+)/gm),
  ];
  assert.ok(resolutions.length > 0, "lockfile missing js-yaml resolution");

  assertPatched(
    resolutions.map((m) => m.slice(1).map(Number)),
    "pnpm-lock.yaml",
  );
});

// The root pnpm override cannot reach vendor/paperclip-adapter-claude-k8s: it is
// excluded from pnpm-workspace.yaml and carries its own npm lockfile, which the
// Dockerfile `vendor` stage installs with `npm ci` (exact pins, no re-resolve)
// before building and packing the adapter. So that lockfile is a second,
// independently-governed resolution of the same advisory and needs its own
// floor -- via npm `overrides`, the npm-side twin of the root pnpm override.
test("vendored claude-k8s adapter resolves js-yaml above the patched floor", async () => {
  const dir = "vendor/paperclip-adapter-claude-k8s";
  const packageJson = JSON.parse(await readFile(`${dir}/package.json`, "utf8"));
  const lockfile = JSON.parse(
    await readFile(`${dir}/package-lock.json`, "utf8"),
  );

  assert.equal(packageJson.overrides["js-yaml"], ">=4.3.2 <5");

  // Parse the lockfile rather than regexing it: npm keys `packages` by install
  // path, so a nested copy lands at `.../node_modules/js-yaml` and a bare-name
  // text match would also catch the distinct `@types/js-yaml` package.
  const versions = Object.entries(lockfile.packages ?? {})
    .filter(([path]) => path.endsWith("node_modules/js-yaml"))
    .map(([, entry]) => entry.version.split(".").map(Number));

  assertPatched(versions, `${dir}/package-lock.json`);
});

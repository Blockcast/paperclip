import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// BLO-31120 / Dependabot alert Blockcast/paperclip#146.
// GHSA-73wf-gq98-2v4g (CVE-2026-73088): browserslist <= 4.28.6 crashes, and
// can write to Object.prototype, in normalizeStats() when handed untrusted
// browserslist-stats.json custom stats. Nothing here depends on browserslist
// directly — it arrives transitively via @babel/helper-compilation-targets —
// so the only lever is the pnpm override, and the only thing that proves the
// override took is what the lockfile actually resolved.
test("browserslist resolves above the GHSA-73wf-gq98-2v4g patched floor", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");

  assert.equal(packageJson.pnpm.overrides.browserslist, ">=4.28.7 <5");

  const resolutions = [
    ...lockfile.matchAll(/^  browserslist@(\d+)\.(\d+)\.(\d+):$/gm),
  ];
  assert.ok(resolutions.length > 0, "lockfile missing browserslist resolution");

  // Assert on every resolution, not the first: a single outlier entry left
  // inside the vulnerable range is the whole question, and a check that stops
  // at the common case would report green on it.
  for (const resolution of resolutions) {
    const [major, minor, patch] = resolution.slice(1).map(Number);
    assert.ok(
      major > 4 ||
        (major === 4 &&
          (minor > 28 || (minor === 28 && patch >= 7))),
      `lockfile resolved vulnerable browserslist ${major}.${minor}.${patch}`,
    );
  }
});

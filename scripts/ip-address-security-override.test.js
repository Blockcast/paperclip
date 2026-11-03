import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// PEN-5303 raised this floor from ^10.3.1 (GHSA-mwp4-54f8-5fhr) to ^10.7.4.
// Five ip-address advisories are live against 10.3.x and they do not share a
// floor: GHSA-rpw4-54j3-4h4q and GHSA-2vr4-cq9g-pvrc need >=10.5.1,
// GHSA-j6r3-76f7-8jcv and GHSA-h3mg-xc3c-68pw need >=10.7.1, and
// GHSA-rxp7-6hxx-x8q5 needs >=10.7.4. The highest floor is the only one worth
// asserting — a pin at any lower one is green while four of the five are
// still reported. Nothing here depends on ip-address directly (it arrives
// transitively, chiefly via socks), so the pnpm override is the only lever
// and the lockfile is the only proof the override took.
test("ip-address resolves above the GHSA-rxp7-6hxx-x8q5 patched floor", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");

  assert.equal(packageJson.pnpm.overrides["ip-address"], "^10.7.4");

  const resolutions = [
    ...lockfile.matchAll(/^  ip-address@(\d+)\.(\d+)\.(\d+):$/gm),
  ];
  assert.ok(resolutions.length > 0, "lockfile missing ip-address resolution");

  for (const resolution of resolutions) {
    const [major, minor, patch] = resolution.slice(1).map(Number);
    assert.ok(
      major > 10 ||
        (major === 10 && (minor > 7 || (minor === 7 && patch >= 4))),
      `lockfile resolved vulnerable ip-address ${major}.${minor}.${patch}`,
    );
  }
});

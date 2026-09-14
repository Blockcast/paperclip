import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// BLO-32910 / Dependabot alert Blockcast/paperclip#176.
// GHSA-535w-7cp7-47q4 (CVE-2026-82333): multer < 2.3.0 is vulnerable to
// denial of service via an oversized array index in field names. Unlike the
// browserslist pin, multer IS a direct dependency (server/package.json), so
// there are two levers and both have to hold: the workspace `pnpm.overrides`
// floor, and the declared range at the dependency's own declaration site. A
// `^2.2.0` declaration under a `>=2.3.0` override resolves correctly today but
// silently reintroduces the vulnerable range the moment the override is
// dropped, so this asserts both.
//
// The floor moved 2.2.0 -> 2.3.0. The earlier multer advisories tracked in
// package.json's securityAuditRemediations ledger (GHSA-72gw-mp4g-v24j,
// GHSA-3p4h-7m6x-2hcm) were patched in 2.2.0 and remain addressed, since
// 2.3.0 is above their floor too.
const PATCHED_FLOOR = [2, 3, 0];

function isBelowFloor([major, minor, patch]) {
  const [floorMajor, floorMinor, floorPatch] = PATCHED_FLOOR;
  if (major !== floorMajor) return major < floorMajor;
  if (minor !== floorMinor) return minor < floorMinor;
  return patch < floorPatch;
}

test("multer resolves above the GHSA-535w-7cp7-47q4 patched floor", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const serverPackageJson = JSON.parse(
    await readFile("server/package.json", "utf8"),
  );
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");

  assert.equal(packageJson.pnpm.overrides.multer, ">=2.3.0 <3");
  assert.equal(serverPackageJson.dependencies.multer, "^2.3.0");

  // Keep the advisory ledger honest about why the floor is where it is: a
  // range bump with no recorded advisory is indistinguishable from a
  // routine version bump, and the next person to widen it has nothing to read.
  const ledger = packageJson.securityAuditRemediations["PEN-1198"].multer;
  assert.equal(ledger.patchedRange, ">=2.3.0 <3");
  assert.ok(
    ledger.advisories.includes("GHSA-535w-7cp7-47q4"),
    "securityAuditRemediations ledger missing GHSA-535w-7cp7-47q4",
  );

  // Match a trailing ':' or '(' so a peer-suffixed entry is not skipped —
  // an unmatched entry can never fail, which would report green on exactly
  // the resolution this guard exists to catch.
  const resolutions = [
    ...lockfile.matchAll(/^  multer@(\d+)\.(\d+)\.(\d+)(?=[:(])/gm),
  ];
  assert.ok(resolutions.length > 0, "lockfile missing multer resolution");

  // Assert on every resolution, not the first: a single outlier entry left
  // inside the vulnerable range is the whole question, and a check that stops
  // at the common case would report green on it.
  for (const resolution of resolutions) {
    const version = resolution.slice(1, 4).map(Number);
    assert.ok(
      !isBelowFloor(version),
      `lockfile resolved vulnerable multer ${version.join(".")}`,
    );
  }
});

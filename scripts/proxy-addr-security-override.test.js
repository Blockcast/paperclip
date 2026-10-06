import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// BLO-40607 / Dependabot alert Blockcast/paperclip#209 (and BLO-40610 /
// alert #214, the same advisory against the root lockfile).
// GHSA-jqcg-44mw-7w3h (CVE-2026-90711, critical): proxy-addr >= 1.1.0 < 2.0.8
// mis-compares an IPv4-mapped IPv6 address against a trusted subnet, so a
// client can spoof the address Express reports as `req.ip`.
//
// Two manifests resolve this package and they are maintained by different
// package managers, which is why both are asserted here:
//
//   pnpm-lock.yaml                                -> express 5.x -> proxy-addr
//   packages/services/designer/package-lock.json  -> express 5.x -> proxy-addr
//
// `express@5.2.1` declares `proxy-addr: ^2.0.7`, a range that already admits
// 2.0.8 — so the pnpm override pins the floor rather than making it reachable.
// It stops a future resolution drifting back down to 2.0.7 while that version
// is still the one most of the ecosystem's integrity hashes point at. The
// designer lockfile has no override mechanism; npm resolved it directly, so
// the only thing that proves it took is what the lockfile resolved.
//
// The surviving `"proxy-addr": "^2.0.7"` range string in the designer lockfile
// is express's own constraint, not a resolution. It is correct for it to stay,
// and that is why this file reads resolved `version` fields and never greps
// for the literal "2.0.7".

const PATCHED_FLOOR = ">=2.0.8 <3";

// Assert on EVERY resolution, not the first: a single outlier entry left
// inside the vulnerable range is the whole question, and a check that stops at
// the common case would report green on it.
function assertPatched(versions, where) {
  assert.ok(versions.length > 0, `${where}: no proxy-addr resolution found`);
  for (const [major, minor, patch] of versions) {
    assert.ok(
      major > 2 || (major === 2 && (minor > 0 || patch >= 8)),
      `${where} resolved vulnerable proxy-addr ${major}.${minor}.${patch} (GHSA-jqcg-44mw-7w3h affects >= 1.1.0 < 2.0.8)`,
    );
  }
}

test("proxy-addr resolves above the GHSA-jqcg-44mw-7w3h floor", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");

  assert.equal(packageJson.pnpm.overrides["proxy-addr"], PATCHED_FLOOR);
  assert.equal(
    packageJson.securityAuditRemediations["BLO-40607"]["proxy-addr"]
      .patchedRange,
    PATCHED_FLOOR,
    "securityAuditRemediations ledger disagrees with pnpm.overrides",
  );

  // Positive control. Every assertion below is satisfied by a lockfile that
  // resolves nothing at all, so an empty, truncated or restructured lockfile
  // would read as green rather than as unreadable. Pin the format this file
  // knows how to parse: pnpm v9 keys top-level packages as `  name@version:`.
  assert.match(
    lockfile,
    /^lockfileVersion: '9\.\d+'$/m,
    "pnpm-lock.yaml is not a pnpm v9 lockfile, so these key-shape assertions cannot be trusted",
  );
  assert.ok(
    lockfile.length > 100_000,
    `pnpm-lock.yaml is ${lockfile.length} bytes, too small to be this workspace's lockfile`,
  );

  // Two spaces then a bare `proxy-addr@`: top-level package keys only, in both
  // the `packages:` and `snapshots:` sections. Requiring `:` or `(` after the
  // version keeps a peer-suffixed key checked rather than silently skipped.
  const resolutions = [
    ...lockfile.matchAll(/^ {2}'?proxy-addr@(\d+)\.(\d+)\.(\d+)[^\n]*?(?=[:(])/gm),
  ];
  assertPatched(
    resolutions.map((m) => m.slice(1).map(Number)),
    "pnpm-lock.yaml",
  );
});

test("the designer npm lockfile resolves above the same floor", async () => {
  const designerPath = "packages/services/designer/package-lock.json";
  const designer = JSON.parse(await readFile(designerPath, "utf8"));

  // Positive control, same reasoning as above: npm v3 lockfiles key resolved
  // packages under `packages`, and an empty or restructured file would make
  // the loop below vacuous.
  assert.equal(
    designer.lockfileVersion,
    3,
    `${designerPath} is not an npm v3 lockfile, so these key-shape assertions cannot be trusted`,
  );
  assert.ok(
    Object.keys(designer.packages ?? {}).length > 100,
    `${designerPath} has too few package entries to be this workspace's lockfile`,
  );

  const versions = Object.entries(designer.packages)
    .filter(([key]) => key === "proxy-addr" || key.endsWith("/proxy-addr"))
    .map(([key, entry]) => {
      assert.match(
        entry.version ?? "",
        /^\d+\.\d+\.\d+/,
        `${designerPath}: ${key} has no resolved version`,
      );
      return entry.version.split(".").slice(0, 3).map(Number);
    });

  assertPatched(versions, designerPath);
});

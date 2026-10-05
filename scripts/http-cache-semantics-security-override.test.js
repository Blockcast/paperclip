import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// BLO-39519 / Dependabot alert Blockcast/paperclip#208.
// GHSA-ch52-4w7c-c8xp (CVE-2026-93748, high): http-cache-semantics <= 4.2.0
// mishandles `max-stale`, so a shared cache can serve one user's cached
// response to another.
//
// This advisory was unfixable when it landed, and that is why the floor here is
// worth stating explicitly. 4.2.0 was npm's `latest` and the exact top of the
// vulnerable range, GitHub's advisory carried (and still carries) a null
// first_patched_version, and every make-fetch-happen release through 16.0.1
// pins `http-cache-semantics: ^4.1.1` — so there was no floor to raise and no
// parent to bump. 4.3.0 published 2026-10-04 and is the first release outside
// the range, which turns this back into an ordinary override.
//
// Nothing in this repo depends on http-cache-semantics directly. It arrives on
// one thread of optional build-time tooling:
//
//   sqlite3 (optional peer of drizzle-orm)
//     -> optionalDependencies: node-gyp
//          -> make-fetch-happen
//               -> http-cache-semantics
//
// `make-fetch-happen`'s own `^4.1.1` range already admits 4.3.0, so the pnpm
// override is what pins the floor rather than what makes it reachable: it stops
// a future resolution drifting back down to 4.2.0 while that version is still
// the one most of the ecosystem's integrity hashes point at. The only thing
// that proves the override took is what the lockfile actually resolved.

const PATCHED_FLOOR = ">=4.3.0 <5";

// Assert on EVERY resolution, not the first: a single outlier entry left inside
// the vulnerable range is the whole question, and a check that stops at the
// common case would report green on it.
function assertPatched(versions, where) {
  assert.ok(
    versions.length > 0,
    `${where}: no http-cache-semantics resolution found`,
  );
  for (const [major, minor, patch] of versions) {
    assert.ok(
      major > 4 || (major === 4 && minor >= 3),
      `${where} resolved vulnerable http-cache-semantics ${major}.${minor}.${patch} (GHSA-ch52-4w7c-c8xp affects <= 4.2.0)`,
    );
  }
}

test("http-cache-semantics resolves above the GHSA-ch52-4w7c-c8xp floor", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");

  assert.equal(
    packageJson.pnpm.overrides["http-cache-semantics"],
    PATCHED_FLOOR,
  );
  assert.equal(
    packageJson.securityAuditRemediations["BLO-39519"][
      "http-cache-semantics"
    ].patchedRange,
    PATCHED_FLOOR,
    "securityAuditRemediations ledger disagrees with pnpm.overrides",
  );

  // Positive control. Every assertion below is satisfied by a lockfile that
  // resolves nothing at all, so an empty, truncated or restructured lockfile
  // would read as green rather than as unreadable. Pin the format this file
  // knows how to parse: pnpm v9 keys top-level packages as `  name@version:`,
  // which is the shape the regex below depends on.
  assert.match(
    lockfile,
    /^lockfileVersion: '9\.\d+'$/m,
    "pnpm-lock.yaml is not a pnpm v9 lockfile, so these key-shape assertions cannot be trusted",
  );
  assert.ok(
    lockfile.length > 100_000,
    `pnpm-lock.yaml is ${lockfile.length} bytes, too small to be this workspace's lockfile`,
  );

  // Two spaces then a bare `http-cache-semantics@`: top-level package keys
  // only, in both the `packages:` and `snapshots:` sections. Requiring `:` or
  // `(` after the version keeps a peer-suffixed key
  // (`http-cache-semantics@4.3.0(peer)`) checked rather than silently skipped,
  // while refusing to half-match some longer version string.
  const resolutions = [
    ...lockfile.matchAll(
      /^ {2}'?http-cache-semantics@(\d+)\.(\d+)\.(\d+)[^\n]*?(?=[:(])/gm,
    ),
  ];

  assertPatched(
    resolutions.map((m) => m.slice(1).map(Number)),
    "pnpm-lock.yaml",
  );
});

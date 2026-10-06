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
// first_patched_version, and no make-fetch-happen release declared a range that
// excluded it (9.1.0 and 10.2.1 pin `^4.1.0`; 13.x through 16.0.1 pin `^4.1.1`)
// — so there was no floor to raise and no parent to bump. 4.3.0 published
// 2026-10-04 and is the first release outside the range, which turns this back
// into an ordinary override.
//
// GHSA-ch52-4w7c-c8xp is the advisory that makes Dependabot alert, but it is
// NOT the advisory 4.3.0 fixes, and it may not survive: the maintainer closed
// the upstream report `not_planned` as bogus and a withdrawal request is open
// at github/advisory-database#10139. The whole 4.2.0 → 4.3.0 delta is
// `_varyMatches()`, which is GHSA-f27v-pv5m-c5g6 (CVE-2026-93750, high):
// cross-user disclosure via `Vary` wildcard matching. That advisory is
// `type: unreviewed` with an EMPTY `vulnerabilities` array, so no version range
// is mapped and Dependabot structurally cannot alert on it. If ch52 is
// withdrawn, f27v is the sole remaining justification for this floor — do not
// read a closed alert as a reason to drop the override.
//
// Nothing in this repo depends on http-cache-semantics directly. It arrives on
// one thread of optional build-time tooling:
//
//   sqlite3 (optional peer of drizzle-orm)
//     -> optionalDependencies: node-gyp
//          -> make-fetch-happen
//               -> http-cache-semantics
//
// `make-fetch-happen@9.1.0`'s own `^4.1.0` range already admits 4.3.0, so the
// pnpm override is what pins the floor rather than what makes it reachable: it
// stops a future resolution drifting back down to 4.2.0 while that version is
// still the one most of the ecosystem's integrity hashes point at. The only
// thing that proves the override took is what the lockfile actually resolved.

const PATCHED_FLOOR = ">=4.3.0 <5";

// The two advisories this floor stands on. Pinned exactly, not
// `arrayContaining`: ch52 is the one Dependabot alerts on and f27v is the one
// 4.3.0 actually fixes, and the comment above explains why dropping either
// misrepresents the override. An unpinned array lets that justification revert
// silently.
const ADVISORIES = ["GHSA-ch52-4w7c-c8xp", "GHSA-f27v-pv5m-c5g6"];

// Derive the numeric comparison from PATCHED_FLOOR rather than restating it.
// A hardcoded `minor >= 3` beside a declared `>=4.3.0 <5` reads as though the
// constant drives the check while the two can drift apart: raising the
// constant to `>=4.4.0 <5` over a lockfile still resolving 4.3.0 used to stay
// green. Fail loudly if the constant stops being parseable — never degrade to
// a comparison that passes everything.
const FLOOR_MATCH = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/.exec(PATCHED_FLOOR);
assert.ok(
  FLOOR_MATCH,
  `PATCHED_FLOOR ${JSON.stringify(PATCHED_FLOOR)} is not a '>=x.y.z <M' range, so no numeric floor can be derived from it`,
);
const [FLOOR_MAJOR, FLOOR_MINOR, FLOOR_PATCH, CEIL_MAJOR] = FLOOR_MATCH.slice(
  1,
).map(Number);

function satisfiesFloor([major, minor, patch]) {
  if (major >= CEIL_MAJOR) return false;
  if (major !== FLOOR_MAJOR) return major > FLOOR_MAJOR;
  if (minor !== FLOOR_MINOR) return minor > FLOOR_MINOR;
  return patch >= FLOOR_PATCH;
}

// Assert on EVERY resolution, not the first: a single outlier entry left inside
// the vulnerable range is the whole question, and a check that stops at the
// common case would report green on it.
function assertPatched(versions, where) {
  assert.ok(
    versions.length > 0,
    `${where}: no http-cache-semantics resolution found`,
  );
  for (const version of versions) {
    assert.ok(
      satisfiesFloor(version),
      `${where} resolved http-cache-semantics ${version.join(".")} outside ${PATCHED_FLOOR} (GHSA-ch52-4w7c-c8xp affects <= 4.2.0)`,
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
  assert.deepEqual(
    packageJson.securityAuditRemediations["BLO-39519"][
      "http-cache-semantics"
    ].advisories,
    ADVISORIES,
    "securityAuditRemediations ledger no longer cites both advisories this floor rests on",
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

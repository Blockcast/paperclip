import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// BLO-40923. GHSA-frvp-7c67-39w9 (moderate): @hono/node-server mishandles a
// request whose path contains an encoded traversal sequence, so a static-file
// route can be walked outside its root. The advisory has TWO windows, not one:
//
//   < 1.19.15              -> patched in 1.19.15
//   >= 2.0.0, < 2.0.5      -> patched in 2.0.5
//
// Designer reaches this package transitively through
// `@modelcontextprotocol/sdk`, whose own range is `^1.19.9 || ^2.0.5` — a
// range that spans both windows, so it cannot be relied on to stay out of
// either. The floor is declared in `packages/services/designer/package.json`
// under npm's `overrides`, the same mechanism that package already uses for
// `fast-uri` and `proxy-addr`.
//
// The override's upper bound is the load-bearing half and it is NOT about the
// advisory. Without `<2`, npm resolves 2.1.3 — outside the advisory, and a
// silent major-version jump for designer on the next `npm install`. This
// override is the only artifact holding designer on the 1.x line, and JSON
// cannot carry a comment saying so, which is why it is said here.
//
// BLO-56715 raised the floor to 1.19.18 for GHSA-jpvv-r467-5p4w (moderate):
// a backslash in the request path is parsed as a path separator, so a
// path-based access rule at a reverse proxy can be bypassed. Its windows are
// `< 1.19.18` and `>= 2.0.0 < 2.1.6`, which contain GHSA-frvp's, so the
// assertion below tests the wider pair. The ROOT pnpm workspace reaches the
// package the same way (every MCP server package -> @modelcontextprotocol/sdk)
// and is asserted too: the scheduled dependency-audit lane reads that lockfile.
//
// Consequence worth knowing rather than fixing: when the SDK eventually drops
// 1.x and requires `^2.0.5` alone, this cap turns into a hard ERESOLVE rather
// than a quiet bump. That is the better failure mode — but it will read as
// mysterious, and this file is where the explanation lives.

const PATCHED_FLOOR = ">=1.19.18 <2";

const designerRoot = new URL(
  "../packages/services/designer/",
  import.meta.url,
);

// Assert on EVERY resolution, not the first: a single outlier entry left
// inside either window is the whole question, and a check that stops at the
// common case would report green on it.
function assertPatched(versions, where) {
  assert.ok(
    versions.length > 0,
    `${where}: no @hono/node-server resolution found`,
  );
  for (const { major, minor, patch, prerelease } of versions) {
    // semver orders a prerelease BELOW its own release, so 1.19.15-rc.1 is
    // inside `< 1.19.15` and 2.0.5-rc.1 inside `< 2.0.5`. Neither may pass on
    // its numeric triple alone, and rejecting prereleases outright is both
    // correct here and smaller than ordering them.
    assert.ok(
      !prerelease,
      `${where} resolved prerelease @hono/node-server ${major}.${minor}.${patch}${prerelease} (sorts below ${major}.${minor}.${patch}, i.e. inside GHSA-jpvv-r467-5p4w)`,
    );
    const inFirstWindow =
      major < 1 || (major === 1 && (minor < 19 || (minor === 19 && patch < 18)));
    const inSecondWindow = major === 2 && (minor === 0 || (minor === 1 && patch < 6));
    assert.ok(
      !inFirstWindow && !inSecondWindow,
      `${where} resolved vulnerable @hono/node-server ${major}.${minor}.${patch} (GHSA-jpvv-r467-5p4w affects < 1.19.18 and >= 2.0.0 < 2.1.6)`,
    );
  }
}

test("the designer manifest declares the @hono/node-server floor", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("package.json", designerRoot), "utf8"),
  );

  // Prevention, not just detection: the lockfile below is a committed
  // artifact, while this override is what keeps the next `npm install` from
  // drifting — back into the advisory, or forward across the major. Assert it
  // too, otherwise the two can silently disagree.
  assert.equal(
    manifest.overrides?.["@hono/node-server"],
    PATCHED_FLOOR,
    "designer package.json must pin the @hono/node-server override that keeps npm off the vulnerable ranges and off 2.x",
  );
});

test("the designer lockfile resolves above the same floor", async () => {
  const designerPath = "packages/services/designer/package-lock.json";
  const lockfile = JSON.parse(
    await readFile(new URL("package-lock.json", designerRoot), "utf8"),
  );

  // Positive control. Every assertion below is satisfied by a lockfile that
  // resolves nothing at all, so an empty, truncated or restructured lockfile
  // would read as green rather than as unreadable.
  assert.equal(
    lockfile.lockfileVersion,
    3,
    `${designerPath} is not an npm v3 lockfile, so these key-shape assertions cannot be trusted`,
  );
  assert.ok(
    Object.keys(lockfile.packages ?? {}).length > 100,
    `${designerPath} has too few package entries to be this workspace's lockfile`,
  );

  const versions = Object.entries(lockfile.packages)
    .filter(
      ([path]) =>
        path === "node_modules/@hono/node-server" ||
        path.endsWith("/node_modules/@hono/node-server"),
    )
    .map(([path, entry]) => {
      const parsed = /^(\d+)\.(\d+)\.(\d+)(-[\w.+-]*)?$/.exec(
        entry.version ?? "",
      );
      assert.ok(parsed, `${designerPath}: ${path} has no resolved version`);
      return {
        major: Number(parsed[1]),
        minor: Number(parsed[2]),
        patch: Number(parsed[3]),
        prerelease: parsed[4],
      };
    });

  assertPatched(versions, designerPath);
});

test("the root pnpm workspace pins and resolves above the same floor", async () => {
  const rootUrl = new URL("../", import.meta.url);
  const packageJson = JSON.parse(
    await readFile(new URL("package.json", rootUrl), "utf8"),
  );
  const lockfile = await readFile(new URL("pnpm-lock.yaml", rootUrl), "utf8");

  assert.equal(packageJson.pnpm.overrides["@hono/node-server"], PATCHED_FLOOR);
  assert.deepEqual(
    packageJson.securityAuditRemediations["BLO-56715"]["@hono/node-server"],
    {
      patchedRange: PATCHED_FLOOR,
      advisories: ["GHSA-jpvv-r467-5p4w", "GHSA-frvp-7c67-39w9"],
    },
  );

  // Positive control, as above: a lockfile that resolves nothing passes
  // every per-version assertion.
  assert.match(lockfile, /^lockfileVersion: '9\.\d+'$/m);
  assert.ok(lockfile.length > 100_000, "pnpm-lock.yaml is too small to be real");

  // Top-level package keys only: `  '@hono/node-server@1.19.19':`.
  const versions = [
    ...lockfile.matchAll(
      /^  '@hono\/node-server@(\d+)\.(\d+)\.(\d+)(-[\w.+-]*)?':$/gm,
    ),
  ].map((m) => ({
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4],
  }));
  assertPatched(versions, "pnpm-lock.yaml");
});

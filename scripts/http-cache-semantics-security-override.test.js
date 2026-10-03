import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// BLO-39519 / Dependabot alert Blockcast/paperclip#208.
// GHSA-ch52-4w7c-c8xp (CVE-2026-93748): http-cache-semantics <= 4.2.0 can
// disclose cross-user cached responses via max-stale handling.
//
// This advisory has NO patched version. npm's latest http-cache-semantics is
// 4.2.0 -- the exact top of the vulnerable range -- and the advisory carries a
// null first_patched_version, so there is no floor to raise it to. Every
// make-fetch-happen release pins http-cache-semantics ^4.1.1, so overriding
// make-fetch-happen does not help either.
//
// The only remediation is removal. The sole consumer chain was
//   sqlite3 -> (optionalDependencies) node-gyp@8.4.1 -> make-fetch-happen@9.1.0
//     -> http-cache-semantics
// and node-gyp >= 13 dropped make-fetch-happen entirely in favour of undici,
// so pinning that one edge takes the whole subtree out of the graph.
test("http-cache-semantics is absent from the dependency graph", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");

  assert.equal(packageJson.pnpm.overrides["sqlite3>node-gyp"], ">=13");

  // Positive control. The assertions below are absence checks, and an absence
  // check reports green on a lockfile that was truncated, unreadable, or in a
  // format these patterns do not match -- the failure is indistinguishable
  // from a genuine fix. Anchor on something that must resolve, so a read that
  // cannot see anything fails loudly here instead of passing silently.
  assert.match(
    lockfile,
    /^lockfileVersion: '9\.\d+'$/m,
    "lockfile is not the pnpm v9 format these patterns assume",
  );
  assert.ok(
    /^ {2}sqlite3@\d+\.\d+\.\d+:$/m.test(lockfile),
    "control failed: sqlite3 must still resolve, else this file proves nothing",
  );

  // Assert on every resolution, not the first: one outlier entry left inside
  // the vulnerable range is the whole question.
  const nodeGyp = [...lockfile.matchAll(/^ {2}node-gyp@(\d+)\.(\d+)\.(\d+):$/gm)];
  assert.ok(nodeGyp.length > 0, "lockfile missing node-gyp resolution");
  for (const resolution of nodeGyp) {
    const [major] = resolution.slice(1).map(Number);
    assert.ok(
      major >= 13,
      `node-gyp ${resolution[1]}.${resolution[2]}.${resolution[3]} still pulls make-fetch-happen`,
    );
  }

  // The two packages the chain above would reintroduce. Match the bare name
  // anywhere, not just at a resolution anchor: a new consumer could pull
  // either one back in under a different parent.
  assert.ok(
    !lockfile.includes("make-fetch-happen"),
    "make-fetch-happen is back, and it pins a vulnerable http-cache-semantics",
  );
  assert.ok(
    !lockfile.includes("http-cache-semantics"),
    "http-cache-semantics is back; GHSA-ch52-4w7c-c8xp has no patched version, so it must stay out of the graph",
  );
});

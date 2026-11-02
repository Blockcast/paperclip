import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FAST_URI_ADVISORIES,
  FAST_URI_VULNERABLE_RANGES,
  fastUriAdvisoriesFor,
  fastUriLockfileVersions,
  isVulnerableFastUri,
  parseRange,
  parseVersion,
} from "./fast-uri-advisory.js";

const v = (parts) => parts.join(".");

// One below a version, staying inside the 3-component space. `.999` rather
// than a real predecessor because fast-uri has no release anywhere near it and
// the assertion only needs a version that sorts immediately under the floor.
function justBelow([major, minor, patch]) {
  if (patch > 0) return [major, minor, patch - 1];
  if (minor > 0) return [major, minor - 1, 999];
  return [major - 1, 999, 999];
}

// The union the seventeen encoded advisories must derive to. Transcribed here
// ONCE, on purpose: this is the assertion that fails if an advisory entry is
// dropped or a bound is mistyped, which is the defect this module has shipped
// three times. It is not a second source of truth -- the module derives, this
// pins. PEN-5284 moved all three fixed bounds: 2.4.5 -> 2.4.8, 3.1.6 -> 3.1.9
// and 4.1.3 -> 4.2.3, because the eight advisories published after the
// 2026-09-13 read patch above every bound the snapshot knew about.
test("derived union matches the union of all published fast-uri advisories", () => {
  assert.deepEqual(FAST_URI_VULNERABLE_RANGES, [
    { introduced: [0, 0, 0], fixed: [2, 4, 8] },
    { introduced: [3, 0, 0], fixed: [3, 1, 9] },
    { introduced: [4, 0, 0], fixed: [4, 2, 3] },
  ]);
});

test("every encoded range edge is pinned on both sides", () => {
  for (const { introduced, fixed } of FAST_URI_VULNERABLE_RANGES) {
    assert.equal(
      isVulnerableFastUri(v(introduced)),
      true,
      `${v(introduced)} is the range floor and must be rejected`,
    );
    assert.equal(
      isVulnerableFastUri(v(justBelow(fixed))),
      true,
      `${v(justBelow(fixed))} is the last vulnerable version below ${v(fixed)}`,
    );
    assert.equal(
      isVulnerableFastUri(v(fixed)),
      false,
      `${v(fixed)} is the fix and must be accepted`,
    );

    // The bottom range is unbounded below -- every 0.x/1.x/2.x release under
    // 2.4.5 is vulnerable per GHSA-7p8r/v39h/q3j6 -- so it has no lower edge.
    if (introduced.some((n) => n !== 0)) {
      const below = justBelow(introduced);
      assert.equal(
        isVulnerableFastUri(v(below)),
        false,
        `${v(below)} sits below ${v(introduced)} and must be accepted`,
      );
    }
  }
});

// The ten versions master's single-advisory table accepted. Regression list
// for BLO-31492; each is declared vulnerable by at least one live advisory.
test("versions the single-advisory table wrongly accepted are rejected", () => {
  for (const version of [
    "2.3.1",
    "2.3.5",
    "2.4.0",
    "2.4.1",
    "3.0.0",
    "3.0.9",
    "3.1.0",
    "3.1.1",
    "3.1.2",
    "4.0.0",
  ]) {
    assert.equal(
      isVulnerableFastUri(version),
      true,
      `${version} must be rejected`,
    );
  }
});

// 2.4.5, 3.1.6, 3.1.7 and 4.1.3 all used to sit in this list. Every one of
// them is now declared vulnerable by an advisory published after the snapshot,
// so each moved up to the real patch point for its line. 3.1.7 is the one
// PEN-5284 was opened on: both lockfiles resolved it and both gates were green.
test("patched and out-of-range versions are accepted", () => {
  for (const version of ["2.4.8", "2.9.9", "3.1.9", "4.2.3", "5.0.0"]) {
    assert.equal(
      isVulnerableFastUri(version),
      false,
      `${version} must be accepted`,
    );
  }
});

test("a guard failure cites every advisory that matched, not one", () => {
  // 3.1.2 is the version the ticket was opened on: outside GHSA-5jgf's
  // >= 3.1.3 floor, inside six others.
  const matched = fastUriAdvisoriesFor("3.1.2");
  assert.ok(matched.length > 1, "3.1.2 matches more than one advisory");
  assert.ok(!matched.includes("GHSA-5jgf-p345-68v8"), "5jgf floor is 3.1.3");
  assert.ok(matched.includes("GHSA-fph4-wmhf-6fwf"), "fph4 floor is 3.1.2");
  // The PEN-5284 regression. This read `[]` against the 2026-09-13 snapshot
  // while five live advisories covered 3.1.7, which is precisely why both
  // gates passed over it. Compared sorted: which advisories match is the
  // property worth pinning, their order in the table is not.
  assert.deepEqual(fastUriAdvisoriesFor("3.1.7").slice().sort(), [
    "GHSA-333x-w4r6-6crp",
    "GHSA-hrr3-gc8f-f4qj",
    "GHSA-w74x-v6f9-j3xg",
    "GHSA-wjr9-j795-jxcr",
    "GHSA-xhq7-xmqj-769h",
  ]);
  // 3.1.8 patches GHSA-hrr3 alone, so it is still covered by the other four --
  // the floor has to clear the HIGHEST patch point, not the first one.
  assert.equal(isVulnerableFastUri("3.1.8"), true);
  assert.equal(isVulnerableFastUri("3.1.9"), false);
});

test("every encoded advisory contributes at least one live range", () => {
  assert.equal(FAST_URI_ADVISORIES.length, 17);
  for (const { id, ranges } of FAST_URI_ADVISORIES) {
    assert.ok(ranges.length > 0, `${id} has no ranges`);
    for (const range of ranges) parseRange(range);
  }
});

// package.json's securityAuditRemediations entry is a CLAIM about this table:
// that its `patchedRange` clears every advisory encoded above, and that its
// `advisories` names the ones that forced that floor. Nothing else in the repo
// checks either half, so without this the entry could record any floor and any
// IDs and still be "guarded" on paper.
//
// It also arms the NEXT rotation. The floor assertions below are written
// against the derived table rather than against a literal, so when a newly
// published advisory raises the 3.x bound past the recorded floor this fails
// in a pr.yml-registered gate -- which is exactly what did not happen when the
// 2026-09-13 snapshot aged out from under 3.1.7 and both gates stayed green.
test("the securityAuditRemediations floor clears this table exactly", () => {
  const rootPackageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const entry =
    rootPackageJson.securityAuditRemediations["PEN-5284"]["fast-uri"];

  // The ledger records the floor the override actually enforces, not a
  // parallel one that can drift away from it.
  assert.equal(entry.patchedRange, rootPackageJson.pnpm.overrides["fast-uri"]);

  const floor = /^>=(\d+\.\d+\.\d+) </.exec(entry.patchedRange)?.[1];
  assert.ok(floor, `unreadable patchedRange ${entry.patchedRange}`);

  // The floor is clean, and it is the LOWEST clean version -- a floor pinned
  // arbitrarily high would also pass the first check while hiding which
  // advisory it is actually avoiding.
  assert.equal(isVulnerableFastUri(floor), false, `${floor} must be accepted`);
  const below = v(justBelow(parseVersion(floor)));
  assert.equal(isVulnerableFastUri(below), true, `${below} must be rejected`);

  // Every recorded ID is a real entry above -- a typo'd or retired GHSA ID
  // reads as documentation and asserts nothing.
  const known = new Set(FAST_URI_ADVISORIES.map((advisory) => advisory.id));
  for (const id of entry.advisories) {
    assert.ok(known.has(id), `ledger names unknown advisory ${id}`);
  }
  // And they are EXACTLY the advisories that covered 3.1.7, the resolution
  // this floor supersedes. Containment is what let the snapshot rot: a table
  // that merely contains the advisory you came for is the failure mode.
  assert.deepEqual(
    entry.advisories.slice().sort(),
    fastUriAdvisoriesFor("3.1.7").slice().sort(),
  );
});

test("parseVersion fails closed rather than coercing", () => {
  for (const bad of [
    "3.1",
    "",
    "3.1.x",
    "v3.1.5",
    "latest",
    null,
    undefined,
    "3.1.6-rc.1",
    "3.1.7(patch_hash=abc)",
    "-1.0.0",
  ]) {
    assert.throws(
      () => parseVersion(bad),
      /unparseable fast-uri version/,
      `parseVersion(${JSON.stringify(bad)}) must throw`,
    );
    assert.throws(() => isVulnerableFastUri(bad), /unparseable fast-uri/);
  }
});

test("parseRange normalises GitHub bounds and fails closed", () => {
  assert.deepEqual(parseRange(">= 3.1.2, < 3.1.6"), {
    introduced: [3, 1, 2],
    fixed: [3, 1, 6],
  });
  // Inclusive upper bound becomes the next patch, which is the arithmetic the
  // hand-merged table kept getting wrong.
  assert.deepEqual(parseRange(">= 3.0.0, <= 3.1.3"), {
    introduced: [3, 0, 0],
    fixed: [3, 1, 4],
  });
  assert.deepEqual(parseRange("< 2.4.4"), {
    introduced: [0, 0, 0],
    fixed: [2, 4, 4],
  });
  assert.deepEqual(parseRange("<= 2.4.0"), {
    introduced: [0, 0, 0],
    fixed: [2, 4, 1],
  });
  // `= X` pins a single affected release. GHSA-58mr-gqgx-xq4g writes all three
  // of its arms that way, and before PEN-5284 this threw -- at module load,
  // not at gate time, so transcribing that advisory verbatim would have taken
  // down every importer rather than failing a check.
  assert.deepEqual(parseRange("= 3.1.6"), {
    introduced: [3, 1, 6],
    fixed: [3, 1, 7],
  });
  assert.deepEqual(parseRange("=2.4.5"), {
    introduced: [2, 4, 5],
    fixed: [2, 4, 6],
  });
  // An exact pin covers exactly its one version and neither neighbour.
  assert.equal(isVulnerableFastUri("3.1.6"), true);
  for (const bad of [
    "3.1.6",
    ">= 3.1.6",
    "^3.1.6",
    "",
    "> 3.1.6, < 3.1.6",
    // Still a bad range, not an exact pin: the version must be complete.
    "= 3.1",
    "= 3.1.x",
    "== 3.1.6",
    ">= 3.0.0, = 3.1.6",
  ]) {
    assert.throws(
      () => parseRange(bad),
      /fast-uri range|unparseable fast-uri version/,
      `parseRange(${JSON.stringify(bad)}) must throw`,
    );
  }
});

test("the lockfile scan reads every pnpm key shape, and fails closed", () => {
  // Both `packages:` (`key:`) and `snapshots:` (`key: {}`) forms, bare and
  // quoted. The quoted forms are the ones worth pinning: the closing `'` must
  // not reach parseVersion as part of the version.
  // Fixtures carry 3.1.9, not 3.1.7: the last assertion in this loop is that
  // the scanned version is ACCEPTED, so a fixture pinned to a version that
  // later goes vulnerable turns a key-shape test into a floor test and fails
  // for the wrong reason. Use the current floor.
  for (const [line, want] of [
    ["  fast-uri@3.1.9:", "3.1.9"],
    ["  fast-uri@3.1.9: {}", "3.1.9"],
    ["  'fast-uri@3.1.9':", "3.1.9"],
    ["  'fast-uri@3.1.9': {}", "3.1.9"],
    ["  fast-uri@3.1.9(patch_hash=abc):", "3.1.9"],
    ["  'fast-uri@3.1.9(patch_hash=abc)': {}", "3.1.9"],
  ]) {
    assert.deepEqual(
      fastUriLockfileVersions(line),
      [want],
      `${JSON.stringify(line)} must yield ${want}`,
    );
    // Whatever came back must be comparable, not just string-equal.
    assert.equal(isVulnerableFastUri(fastUriLockfileVersions(line)[0]), false);
  }

  // A prerelease parses out of the key but is NOT silently dropped: it reaches
  // parseVersion, which throws. Skipping it would fail open.
  assert.deepEqual(fastUriLockfileVersions("  fast-uri@4.1.0-rc.1:"), [
    "4.1.0-rc.1",
  ]);
  assert.throws(() => parseVersion("4.1.0-rc.1"), /unparseable fast-uri/);

  // No fast-uri at all is not an error here -- the caller asserts non-empty.
  assert.deepEqual(fastUriLockfileVersions("  other@1.0.0:"), []);

  // A key shape the pattern does not anticipate must fail, not read as zero.
  // pnpm's `link:`/`file:` protocol puts a `:` inside the key, so the version
  // class stops early and the full pattern misses while the bare-key count
  // still sees it -- exactly the disagreement the cross-check exists to catch.
  assert.throws(
    () => fastUriLockfileVersions("  fast-uri@link:../vendor/fast-uri:"),
    /could not parse/,
  );
});

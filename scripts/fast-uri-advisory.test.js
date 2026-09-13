import assert from "node:assert/strict";
import test from "node:test";

import {
  FAST_URI_ADVISORIES,
  FAST_URI_VULNERABLE_RANGES,
  fastUriAdvisoriesFor,
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

// The union the nine encoded advisories must derive to. Transcribed here ONCE,
// on purpose: this is the assertion that fails if an advisory entry is dropped
// or a bound is mistyped, which is the defect this module has shipped three
// times. It is not a second source of truth -- the module derives, this pins.
test("derived union matches the union of all published fast-uri advisories", () => {
  assert.deepEqual(FAST_URI_VULNERABLE_RANGES, [
    { introduced: [0, 0, 0], fixed: [2, 4, 5] },
    { introduced: [3, 0, 0], fixed: [3, 1, 6] },
    { introduced: [4, 0, 0], fixed: [4, 1, 3] },
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

test("patched and out-of-range versions are accepted", () => {
  for (const version of [
    "2.4.5",
    "2.9.9",
    "3.1.6",
    "3.1.7",
    "4.1.3",
    "5.0.0",
  ]) {
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
  assert.deepEqual(fastUriAdvisoriesFor("3.1.7"), []);
});

test("every encoded advisory contributes at least one live range", () => {
  assert.equal(FAST_URI_ADVISORIES.length, 9);
  for (const { id, ranges } of FAST_URI_ADVISORIES) {
    assert.ok(ranges.length > 0, `${id} has no ranges`);
    for (const range of ranges) parseRange(range);
  }
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
  for (const bad of ["3.1.6", ">= 3.1.6", "^3.1.6", "", "> 3.1.6, < 3.1.6"]) {
    assert.throws(
      () => parseRange(bad),
      /fast-uri range|unparseable fast-uri version/,
      `parseRange(${JSON.stringify(bad)}) must throw`,
    );
  }
});

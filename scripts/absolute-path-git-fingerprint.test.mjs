// Coverage for the pure parts of `absolute-path-git-fingerprint.mjs`.
//
// WHY ONLY THE PURE PARTS
// -----------------------
// Hashing files and reading PATH is established by running it in a pod. What cannot be
// re-established that way on a future re-run is the rule that decides whether two runs
// describe the SAME egress surface -- and a silent regression there is one-directional in
// the damaging sense: a fingerprint that collides across genuinely different surfaces lets
// a stale PEN-4986 measurement be cited for an image it never ran on, which is how §7.2
// trigger 4's residual acceptance keeps running on evidence that no longer applies.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fingerprintFrom,
  gitPathLayout,
  wrapperIsAhead,
  REAL_GIT,
  WRAPPER,
} from "./absolute-path-git-fingerprint.mjs";

test("identical surfaces fingerprint identically regardless of key order", () => {
  const a = fingerprintFrom({ files: { x: "1", y: "2" }, layout: [WRAPPER, REAL_GIT] });
  const b = fingerprintFrom({ files: { y: "2", x: "1" }, layout: [WRAPPER, REAL_GIT] });
  assert.equal(a, b);
});

test("a changed file hash changes the fingerprint", () => {
  const a = fingerprintFrom({ files: { x: "1" }, layout: [] });
  const b = fingerprintFrom({ files: { x: "2" }, layout: [] });
  assert.notEqual(a, b);
});

test("a file going ABSENT changes the fingerprint", () => {
  const a = fingerprintFrom({ files: { x: "1" }, layout: [] });
  const b = fingerprintFrom({ files: { x: null }, layout: [] });
  assert.notEqual(a, b);
});

test("PATH ORDER is part of the fingerprint, not just the set", () => {
  // The guard works only while the wrapper precedes /usr/bin. A reordering that leaves
  // the same entries present is exactly the change a set-based hash would miss.
  const a = fingerprintFrom({ files: {}, layout: [WRAPPER, REAL_GIT] });
  const b = fingerprintFrom({ files: {}, layout: [REAL_GIT, WRAPPER] });
  assert.notEqual(a, b);
});

test("gitPathLayout keeps PATH order and skips entries with no git", () => {
  const present = new Set(["/wrap/git", "/usr/bin/git"]);
  const layout = gitPathLayout("/wrap:/nothing:/usr/bin", (p) => present.has(p));
  assert.deepEqual(layout, ["/wrap/git", "/usr/bin/git"]);
});

test("gitPathLayout tolerates an unset or empty PATH", () => {
  assert.deepEqual(gitPathLayout(undefined, () => true), []);
  assert.deepEqual(gitPathLayout("", () => true), []);
});

test("wrapperIsAhead is false when the real binary resolves first", () => {
  assert.equal(wrapperIsAhead([REAL_GIT, WRAPPER]), false);
  assert.equal(wrapperIsAhead([WRAPPER, REAL_GIT]), true);
});

test("wrapperIsAhead is false, not true, when no git is on PATH at all", () => {
  // Fail closed: an empty layout is not evidence the guard is in front of anything.
  assert.equal(wrapperIsAhead([]), false);
});

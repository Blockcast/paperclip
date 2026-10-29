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
  FINGERPRINT_VERSION,
  REAL_GIT,
  WRAPPER,
} from "./absolute-path-git-fingerprint.mjs";

test("identical surfaces fingerprint identically regardless of key order", () => {
  const a = fingerprintFrom({ files: { x: "1", y: "2" }, layout: [WRAPPER, REAL_GIT] });
  const b = fingerprintFrom({ files: { y: "2", x: "1" }, layout: [WRAPPER, REAL_GIT] });
  assert.equal(a, b);
});

test("the RULE version is part of the fingerprint", () => {
  // Digests are compared across time ("equals the one in §1 -> may cite that
  // measurement"). Two rules must therefore never produce comparable digests: a v1
  // digest meeting a v2 digest has to read as a mismatch, not as an unchanged surface.
  const a = fingerprintFrom({ files: { x: "1" }, layout: [], version: 1 });
  const b = fingerprintFrom({ files: { x: "1" }, layout: [], version: 2 });
  assert.notEqual(a, b);
});

test("fingerprintFrom defaults to the current rule version", () => {
  assert.equal(
    fingerprintFrom({ files: { x: "1" }, layout: [] }),
    fingerprintFrom({ files: { x: "1" }, layout: [], version: FINGERPRINT_VERSION }),
  );
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

// The regression these pin is the one this value exists to prevent. `wrapperIsAhead`
// asked `first !== REAL_GIT` until 2026-10-29, so EVERY case below answered `true` --
// a reported "bare `git` reaches the wrapper: yes" while it demonstrably did not. §4
// makes `wrapperAhead: false` the escalation signal, so the fail-open silenced exactly
// the escalation it exists to raise. The two tests above all passed throughout: none of
// them put a third, non-wrapper path first, which is why the defect survived 8/8 green.
const identityRealpath = (p) => p;

test("wrapperIsAhead is false for a real git that is not the literal /usr/bin/git", () => {
  // /bin/git on a merged-usr image: the real binary, reached via `/bin -> usr/bin`.
  assert.equal(wrapperIsAhead(["/bin/git", REAL_GIT], identityRealpath), false);
  // /usr/lib/git-core/git: a SECOND inode holding a byte-identical copy of real git,
  // confirmed present in the agent image (PEN-4998). The known-real bypass.
  assert.equal(wrapperIsAhead(["/usr/lib/git-core/git"], identityRealpath), false);
});

test("wrapperIsAhead is false when a shim is placed ahead of the wrapper", () => {
  assert.equal(wrapperIsAhead(["/usr/local/bin/git", WRAPPER], identityRealpath), false);
});

test("wrapperIsAhead follows a symlink that points at the wrapper", () => {
  // A path is credited when it RESOLVES to the wrapper -- a bare `git` there does reach
  // the guard. Only the wrapper's own target is resolved, so this cannot credit anything
  // that resolves elsewhere.
  const realpath = (p) => (p === "/usr/local/bin/git" || p === WRAPPER ? WRAPPER : p);
  assert.equal(wrapperIsAhead(["/usr/local/bin/git"], realpath), true);
});

test("wrapperIsAhead fails CLOSED when a path cannot be resolved", () => {
  // The production resolver falls back to the path itself on error. An unresolvable
  // path then compares equal only to itself, so a resolution failure can never
  // manufacture a wrapper match.
  assert.equal(wrapperIsAhead(["/some/unresolvable/git"], identityRealpath), false);
});

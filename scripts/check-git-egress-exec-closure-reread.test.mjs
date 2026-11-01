// Tests for the PEN-5186 standing detector (§8 residual 4).
//
// Every clause gets its own case, because the failure this detector exists to
// prevent is silence: a clause that stops firing looks exactly like a clean
// repository. The cases below are written so that disabling any one conditional
// in the script reds at least one of them.

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  CLEAR,
  OWED,
  REVIEW_DUE,
  TRAILER,
  UNREADABLE,
  WATCHED_PATHS,
  evaluate,
  rereadAttestations,
  renderReport,
  reviewOwed,
  touchedWatchedPaths,
} from "./check-git-egress-exec-closure-reread.mjs";

const SHIM = "packages/adapter-utils/src/github-git-egress-shim.ts";
const RUNTIME = "packages/adapter-utils/src/github-git-egress-runtime.ts";
const BEFORE = "2026-11-01";

test("the watched set is exactly §8 residual 4's two files", () => {
  // Residual 4 is ONE residual naming TWO files. §11.5 flags specifically that
  // it must not be read as two residuals — and equally it must not shrink to
  // one file. Pinning the set here is what makes a silent narrowing a red test.
  assert.deepEqual([...WATCHED_PATHS].sort(), [RUNTIME, SHIM].sort());
});

test("exit codes keep 'could not judge' out of the clear bucket", () => {
  assert.equal(CLEAR, 0);
  assert.equal(OWED, 1);
  assert.equal(UNREADABLE, 2);
  assert.notEqual(UNREADABLE, CLEAR);
});

test("touchedWatchedPaths reports each watched file independently", () => {
  assert.deepEqual(touchedWatchedPaths([]), []);
  assert.deepEqual(touchedWatchedPaths(["README.md"]), []);
  assert.deepEqual(touchedWatchedPaths([SHIM]), [SHIM]);
  assert.deepEqual(touchedWatchedPaths([RUNTIME]), [RUNTIME]);
  assert.deepEqual(touchedWatchedPaths([RUNTIME, SHIM, "README.md"]).sort(), [RUNTIME, SHIM].sort());
});

test("a near-miss path does not count as the watched file", () => {
  // The test file beside it, and a same-named file elsewhere, are NOT the
  // closure. Matching loosely here would make the detector satisfiable by
  // touching a neighbour.
  assert.deepEqual(touchedWatchedPaths([`${SHIM.replace(".ts", ".test.ts")}`]), []);
  assert.deepEqual(touchedWatchedPaths(["github-git-egress-shim.ts"]), []);
});

test("a trailer with a value is an attestation", () => {
  assert.deepEqual(rereadAttestations([`fix: thing\n\n${TRAILER}: no new exec route; reads unchanged`]), [
    "no new exec route; reads unchanged",
  ]);
});

test("a trailer with no value is NOT an attestation", () => {
  // The whole point is the words. A bare key attests to nothing, and accepting
  // it would make the check satisfiable by pasting a token.
  assert.deepEqual(rereadAttestations([`fix: thing\n\n${TRAILER}:`]), []);
  assert.deepEqual(rereadAttestations([`fix: thing\n\n${TRAILER}:    `]), []);
});

test("the trailer is found case-insensitively and with leading whitespace", () => {
  assert.equal(rereadAttestations([`x\n\n  residual-4-reread: checked`]).length, 1);
  assert.equal(rereadAttestations([`x\n\n\tRESIDUAL-4-REREAD: checked`]).length, 1);
});

test("a trailer mentioned mid-line does not count", () => {
  // "I should add a Residual-4-Reread: trailer" is prose, not an attestation.
  assert.deepEqual(rereadAttestations([`x\n\nI will add a ${TRAILER}: later`]), []);
});

test("attestations are collected across every commit in the range", () => {
  const found = rereadAttestations([`a\n\n${TRAILER}: first`, "b: no trailer", `c\n\n${TRAILER}: second`]);
  assert.deepEqual(found, ["first", "second"]);
});

test("touching a watched file without a trailer owes a re-read", () => {
  const result = evaluate({ changedPaths: [SHIM], commitMessages: ["fix: tidy"], today: BEFORE });
  assert.equal(result.trailerOwed, true);
  assert.equal(result.verdict, "owed");
});

test("touching a watched file WITH a trailer is clear", () => {
  const result = evaluate({
    changedPaths: [RUNTIME],
    commitMessages: [`fix: tidy\n\n${TRAILER}: comment-only; injection unchanged`],
    today: BEFORE,
  });
  assert.equal(result.trailerOwed, false);
  assert.equal(result.verdict, "clear");
});

test("touching nothing watched is clear even with no trailer", () => {
  const result = evaluate({ changedPaths: ["README.md"], commitMessages: ["docs: x"], today: BEFORE });
  assert.equal(result.trailerOwed, false);
  assert.equal(result.verdict, "clear");
});

test("the calendar arm is quiet before the due date and fires on it", () => {
  assert.equal(reviewOwed("2027-01-30"), false);
  assert.equal(reviewOwed(REVIEW_DUE), true, "the review is owed ON the due date, not after it");
  assert.equal(reviewOwed("2027-06-01"), true);
});

test("a completion BEFORE the due date does not clear it", () => {
  // An older review is a PREVIOUS review. Accepting it would let the date be
  // discharged by work that predates the thing it was meant to re-read.
  assert.equal(reviewOwed("2027-02-01", "2027-01-31", "2026-11-01"), true);
  assert.equal(reviewOwed("2027-02-01", "2027-01-31", "2027-01-30"), true);
});

test("a completion ON OR AFTER the due date clears it", () => {
  assert.equal(reviewOwed("2027-02-01", "2027-01-31", "2027-01-31"), false);
  assert.equal(reviewOwed("2027-02-01", "2027-01-31", "2027-02-01"), false);
});

test("an unparseable date is refused rather than compared", () => {
  // String comparison on a non-ISO date silently produces a verdict, and the
  // wrong one roughly half the time. Refusing routes it to UNREADABLE instead.
  assert.throws(() => reviewOwed("not-a-date"), /YYYY-MM-DD/);
  assert.throws(() => reviewOwed("2027-1-31"), /YYYY-MM-DD/);
  assert.throws(() => reviewOwed("2027-02-01", "2027-01-31", "nonsense"), /YYYY-MM-DD/);
});

test("the calendar arm fires independently of the per-change arm", () => {
  // Once due, a PR that touches nothing watched is still owed — otherwise the
  // date would only surface on PRs that happen to touch these two files.
  const result = evaluate({ changedPaths: ["README.md"], commitMessages: ["docs: x"], today: "2027-02-01" });
  assert.equal(result.trailerOwed, false);
  assert.equal(result.calendarOwed, true);
  assert.equal(result.verdict, "owed");
});

test("the report names the remedy for whichever arm fired", () => {
  const trailerOnly = renderReport(
    evaluate({ changedPaths: [SHIM], commitMessages: ["fix: x"], today: BEFORE }),
    { base: "a", head: "b", today: BEFORE },
  );
  assert.match(trailerOnly, /RE-READ IS OWED/);
  assert.match(trailerOnly, new RegExp(`${TRAILER}: <`));
  assert.doesNotMatch(trailerOnly, /REVIEW IS DUE/);

  const calendarOnly = renderReport(
    evaluate({ changedPaths: [], commitMessages: [], today: "2027-02-01" }),
    { base: "a", head: "b", today: "2027-02-01" },
  );
  assert.match(calendarOnly, /REVIEW IS DUE/);
  assert.doesNotMatch(calendarOnly, /RE-READ IS OWED/);
});

test("the calendar report preserves §8's framing of residual 1", () => {
  // §8 forbids residual 1 being written up as a proof, including by the review
  // that re-reads it. The reviewer reads this text at the moment they start, so
  // the constraint has to survive in it.
  const report = renderReport(
    evaluate({ changedPaths: [], commitMessages: [], today: "2027-02-01" }),
    { today: "2027-02-01" },
  );
  assert.match(report, /A LIST OF VECTORS CLOSED/);
  assert.match(report, /forbids promoting it to a proof/);
});

test("the report always states the watched set and the verdict", () => {
  const report = renderReport(
    evaluate({ changedPaths: [], commitMessages: [], today: BEFORE }),
    { base: "a", head: "b", today: BEFORE },
  );
  assert.match(report, /verdict\s+= clear/);
  for (const p of WATCHED_PATHS) assert.ok(report.includes(p), `report omits ${p}`);
});

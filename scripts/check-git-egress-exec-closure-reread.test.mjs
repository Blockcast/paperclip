// Tests for the PEN-5186 standing detector (§8 residual 4).
//
// Every clause gets its own case, because the failure this detector exists to
// prevent is silence: a clause that stops firing looks exactly like a clean
// repository. The cases below are written so that disabling any one conditional
// in the script reds at least one of them.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLEAR,
  OWED,
  REVIEW_DUE,
  REVIEW_NOTICE,
  TRAILER,
  UNREADABLE,
  WATCHED_PATHS,
  evaluate,
  missingWatchedPaths,
  rereadAttestations,
  renderReport,
  reviewNoticeDue,
  reviewOwed,
  touchedWatchedPaths,
  parsePerCommitLog,
  readRange,
  touchingCommits,
} from "./check-git-egress-exec-closure-reread.mjs";
// Namespace import as well as the named ones: the constant-parity test below
// derives its set from what this module actually exports, which named imports
// cannot express.
import * as reread from "./check-git-egress-exec-closure-reread.mjs";

const SHIM = "packages/adapter-utils/src/github-git-egress-shim.ts";
const RUNTIME = "packages/adapter-utils/src/github-git-egress-runtime.ts";
const BEFORE = "2026-11-01";
// The tree at head with both watched files still in place. Spelled out at every
// `evaluate` call rather than defaulted inside it: a default here would be a
// value that reads as "present", which is the vacuous pin this detector's own
// PR removed from the broker policy suite.
const BOTH_PRESENT = [SHIM, RUNTIME, "README.md"];

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

test("missingWatchedPaths names each watched file absent from head", () => {
  assert.deepEqual(missingWatchedPaths([SHIM, RUNTIME]), []);
  assert.deepEqual(missingWatchedPaths([SHIM, RUNTIME, "README.md"]), []);
  assert.deepEqual(missingWatchedPaths([RUNTIME]), [SHIM]);
  assert.deepEqual(missingWatchedPaths([SHIM]), [RUNTIME]);
  assert.deepEqual([...missingWatchedPaths([])].sort(), [RUNTIME, SHIM].sort());
});

test("a head tree that was never supplied is refused, not read as present", () => {
  // The whole point of the arm is that it cannot pass by default. If this ever
  // starts returning [] for a missing input, the guard is vacuous again.
  assert.throws(() => missingWatchedPaths(undefined), /headPaths must be an array/);
  assert.throws(() => missingWatchedPaths(null), /headPaths must be an array/);
});

test("a DELETED watched file owes a re-read even with a trailer", () => {
  // A trailer attests to a change. It cannot answer "where should this check
  // look now", so it must not clear a watch that has lost its target.
  const result = evaluate({
    changedPaths: [SHIM],
    commitMessages: [`chore: drop the shim\n\n${TRAILER}: removed it deliberately`],
    today: BEFORE,
    headPaths: [RUNTIME, "README.md"],
  });
  assert.equal(result.trailerOwed, false, "the trailer does satisfy the per-change arm");
  assert.equal(result.watchStale, true, "but the watch has lost a target");
  assert.deepEqual(result.missing, [SHIM]);
  assert.equal(result.verdict, "owed");
});

test("a RENAMED watched file is caught at both arms", () => {
  // Under `--no-renames` the move appears as the old path (a delete) plus the
  // new one, so the per-change arm fires; the old path is also gone from head,
  // so the staleness arm fires too and survives someone adding a trailer.
  const moved = "packages/adapter-utils/src/github-git-egress-shim-v2.ts";
  const result = evaluate({
    changedPaths: [SHIM, moved],
    commitMessages: ["refactor: move the shim"],
    today: BEFORE,
    headPaths: [moved, RUNTIME],
  });
  assert.deepEqual(result.touched, [SHIM], "the OLD path is what the watch knows");
  assert.equal(result.trailerOwed, true);
  assert.equal(result.watchStale, true);
  assert.equal(result.verdict, "owed");
});

test("the stale-watch report says re-point the watch, not add a trailer", () => {
  const report = renderReport(
    evaluate({ changedPaths: [], commitMessages: [], today: BEFORE, headPaths: [RUNTIME] }),
    { base: "a", head: "b", today: BEFORE },
  );
  assert.match(report, /STOPPED WATCHING/);
  assert.match(report, new RegExp(SHIM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(report, /re-point WATCHED_PATHS/);
  // It must not send the reader to the trailer, which cannot fix this.
  assert.doesNotMatch(report, /Add a trailer to any commit in this range/);
  assert.match(report, /residual 4 is re-opened/i);
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
  const result = evaluate({ changedPaths: [SHIM], commitMessages: ["fix: tidy"], today: BEFORE, headPaths: BOTH_PRESENT });
  assert.equal(result.trailerOwed, true);
  assert.equal(result.verdict, "owed");
});

test("touching a watched file WITH a trailer is clear", () => {
  const result = evaluate({
    changedPaths: [RUNTIME],
    commitMessages: [`fix: tidy\n\n${TRAILER}: comment-only; injection unchanged`],
    today: BEFORE,
    headPaths: BOTH_PRESENT,
  });
  assert.equal(result.trailerOwed, false);
  assert.equal(result.verdict, "clear");
});

test("touching nothing watched is clear even with no trailer", () => {
  const result = evaluate({ changedPaths: ["README.md"], commitMessages: ["docs: x"], today: BEFORE, headPaths: BOTH_PRESENT });
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
  const result = evaluate({ changedPaths: ["README.md"], commitMessages: ["docs: x"], today: "2027-02-01", headPaths: BOTH_PRESENT });
  assert.equal(result.trailerOwed, false);
  assert.equal(result.calendarOwed, true);
  assert.equal(result.verdict, "owed");
});

test("the notice window opens at REVIEW_NOTICE and closes at REVIEW_DUE", () => {
  // It closes ON the due date on purpose: from there the calendar arm reds, and
  // a warning alongside a failure teaches people to skim the annotation that
  // matters.
  assert.equal(reviewNoticeDue("2026-12-14", "2026-12-15", "2027-01-31"), false);
  assert.equal(reviewNoticeDue("2026-12-15", "2026-12-15", "2027-01-31"), true, "the notice opens ON the notice date");
  assert.equal(reviewNoticeDue("2027-01-30", "2026-12-15", "2027-01-31"), true);
  assert.equal(reviewNoticeDue("2027-01-31", "2026-12-15", "2027-01-31"), false, "the gate has taken over on the due date");
  assert.equal(reviewNoticeDue("2027-06-01", "2026-12-15", "2027-01-31"), false);
});

test("the SHIPPED constants put the notice window ahead of the due date", () => {
  // Pinned against the real values, not only against the function's arguments:
  // a correct predicate fed a stranded constant is still a notice that never
  // fires, and the discharge edit moves all three of these at once.
  assert.ok(REVIEW_NOTICE < REVIEW_DUE, `REVIEW_NOTICE ${REVIEW_NOTICE} must precede REVIEW_DUE ${REVIEW_DUE}`);
  assert.equal(reviewNoticeDue(REVIEW_NOTICE), true, "the window is open on its own first day");
  assert.equal(reviewNoticeDue(REVIEW_DUE), false, "the window has closed by the due date");
});

test("an empty notice window is refused rather than silently never firing", () => {
  // notice >= due is the one way to get these three constants wrong that is
  // indistinguishable from a correct file in a quiet year. Refusing routes it to
  // UNREADABLE, which is not the clear bucket.
  assert.throws(() => reviewNoticeDue("2026-12-20", "2027-01-31", "2027-01-31"), /strictly before/);
  assert.throws(() => reviewNoticeDue("2026-12-20", "2027-02-01", "2027-01-31"), /strictly before/);
  assert.throws(() => reviewNoticeDue("not-a-date"), /YYYY-MM-DD/);
  assert.throws(() => reviewNoticeDue("2026-12-20", "2026-12-1", "2027-01-31"), /YYYY-MM-DD/);
});

test("the notice arm changes no verdict", () => {
  // The whole point of the arm. The exit code is `verdict === "clear" ? 0 : 1`,
  // so pinning the verdict inside the window is what pins the exit code — if
  // this ever reads "owed", the notice has become a gate nobody agreed to.
  const inWindow = evaluate({ changedPaths: ["README.md"], commitMessages: ["docs: x"], today: REVIEW_NOTICE, headPaths: BOTH_PRESENT });
  assert.equal(inWindow.noticeDue, true);
  assert.equal(inWindow.calendarOwed, false, "the notice must not be riding on the calendar arm");
  assert.equal(inWindow.verdict, "clear");

  const before = evaluate({ changedPaths: ["README.md"], commitMessages: ["docs: x"], today: BEFORE, headPaths: BOTH_PRESENT });
  assert.equal(before.noticeDue, false);
  assert.equal(before.verdict, "clear");
});

test("the notice report warns without claiming the review is already due", () => {
  const notice = renderReport(
    evaluate({ changedPaths: [], commitMessages: [], today: REVIEW_NOTICE, headPaths: BOTH_PRESENT }),
    { base: "a", head: "b", today: REVIEW_NOTICE },
  );
  assert.match(notice, /REVIEW IS APPROACHING/);
  assert.match(notice, /nothing is blocked by/);
  assert.match(notice, new RegExp(`review_notice  = ${REVIEW_NOTICE}`));
  // The wording the calendar arm owns must not appear while that arm is still
  // quiet. A notice that reads like the failure is a notice people learn to
  // ignore, and then the failure reads like the notice.
  assert.doesNotMatch(notice, /REVIEW IS DUE/);
  assert.match(notice, /verdict\s+= clear/);
});

test("the report names the remedy for whichever arm fired", () => {
  const trailerOnly = renderReport(
    evaluate({ changedPaths: [SHIM], commitMessages: ["fix: x"], today: BEFORE, headPaths: BOTH_PRESENT }),
    { base: "a", head: "b", today: BEFORE },
  );
  assert.match(trailerOnly, /RE-READ IS OWED/);
  assert.match(trailerOnly, new RegExp(`${TRAILER}: <`));
  assert.doesNotMatch(trailerOnly, /REVIEW IS DUE/);

  const calendarOnly = renderReport(
    evaluate({ changedPaths: [], commitMessages: [], today: "2027-02-01", headPaths: BOTH_PRESENT }),
    { base: "a", head: "b", today: "2027-02-01" },
  );
  assert.match(calendarOnly, /REVIEW IS DUE/);
  assert.doesNotMatch(calendarOnly, /RE-READ IS OWED/);
});

test("both discharge instructions name every REVIEW_* constant this module exports", () => {
  // The test above pins which HEADLINE fired, not what the remedy under it says,
  // and that gap let the calendar arm go stale: it was written when there were
  // two constants and kept naming two after REVIEW_NOTICE was added. The arm a
  // late discharger reads is this one — under a repo-wide freeze — so it is the
  // worse of the two to leave naming an incomplete edit.
  //
  // The set is DERIVED from the module's own exports, and the first version of
  // this test used a literal list instead. That list pinned only the three names
  // already written in it, which is the SAME gap one layer up: measured on
  // d446f52, adding a fourth `REVIEW_*` export and naming it in the notice arm
  // alone left this suite 32/32 green, while its own comment claimed "a fourth
  // constant cannot land in one arm and silently miss the other". Deriving the
  // set is what makes that claim true.
  //
  // ⚠ Consequence, accepted deliberately: a future `REVIEW_*` export that
  // genuinely belongs in only one arm will red here. That is the intended
  // direction — it forces the asymmetry to be argued for in a diff instead of
  // being absorbed silently — but it is a cost, not a freebie. Narrow the regex
  // or exempt the name explicitly; do not re-flatten this back to a literal.
  const CONSTANTS = Object.keys(reread).filter((k) => /^REVIEW_[A-Z_]+$/.test(k));
  // A derived set can also go EMPTY — a rename, a regex that stops matching —
  // and an empty set passes the loop below by never entering it, which is the
  // vacuous pin this detector's own PR removed from the broker policy suite. The
  // three names known today are asserted as a FLOOR, not as the pin: the loop
  // still runs over whatever the module actually exports, so the floor
  // under-counting cannot weaken it.
  for (const known of ["REVIEW_LAST_COMPLETED", "REVIEW_DUE", "REVIEW_NOTICE"]) {
    assert.ok(CONSTANTS.includes(known), `the derived constant set must include ${known}`);
  }

  const calendar = renderReport(
    evaluate({ changedPaths: [], commitMessages: [], today: "2027-02-01", headPaths: BOTH_PRESENT }),
    { today: "2027-02-01" },
  );
  const notice = renderReport(
    evaluate({ changedPaths: [], commitMessages: [], today: REVIEW_NOTICE, headPaths: BOTH_PRESENT }),
    { today: REVIEW_NOTICE },
  );

  // Each report carries exactly one of the two remedies, so neither assertion
  // can be satisfied by the other arm's text.
  assert.match(calendar, /REVIEW IS DUE/);
  assert.doesNotMatch(calendar, /IS APPROACHING/);
  assert.match(notice, /IS APPROACHING/);
  assert.doesNotMatch(notice, /REVIEW IS DUE and has not been recorded/);

  for (const name of CONSTANTS) {
    assert.ok(calendar.includes(name), `the calendar remedy must name ${name}`);
    assert.ok(notice.includes(name), `the notice remedy must name ${name}`);
  }
});

test("the calendar report preserves §8's framing of residual 1", () => {
  // §8 forbids residual 1 being written up as a proof, including by the review
  // that re-reads it. The reviewer reads this text at the moment they start, so
  // the constraint has to survive in it.
  const report = renderReport(
    evaluate({ changedPaths: [], commitMessages: [], today: "2027-02-01", headPaths: BOTH_PRESENT }),
    { today: "2027-02-01" },
  );
  assert.match(report, /A LIST OF VECTORS CLOSED/);
  assert.match(report, /forbids promoting it to a proof/);
});

test("an unmeasured staleness arm is not reported as a clean watch", () => {
  // The unreadable-range path renders a result whose staleness arm never ran.
  // "(none)" there would assert something nothing checked — the exact
  // false-clear shape this detector exists to avoid.
  const unread = renderReport(
    { touched: null, attestations: null, trailerOwed: false, calendarOwed: true, missing: null, watchStale: false, verdict: "owed" },
    { base: undefined, head: undefined, today: "2027-02-01" },
  );
  // Every measured field, not just the one that prompted this.
  assert.match(unread, /touched        = \(not measured\)/);
  assert.match(unread, /attestations   = \(not measured\)/);
  assert.match(unread, /touched_commits= \(not measured\)/);
  assert.match(unread, /missing_at_head= \(not measured\)/);
  assert.doesNotMatch(unread, /= \(none\)/);
  assert.doesNotMatch(unread, /attestations   = 0/);

  // ...and a measured-clean read still says so, so "(not measured)" has not
  // simply replaced the clean wording everywhere.
  const measured = renderReport(
    evaluate({ changedPaths: [], commitMessages: [], commits: [], today: BEFORE, headPaths: BOTH_PRESENT }),
    { base: "a", head: "b", today: BEFORE },
  );
  assert.match(measured, /touched        = \(none\)/);
  assert.match(measured, /attestations   = 0/);
  assert.match(measured, /touched_commits= \(none\)/);
  assert.match(measured, /missing_at_head= \(none\)/);
  assert.doesNotMatch(measured, /not measured/);
});

test("the report always states the watched set and the verdict", () => {
  const report = renderReport(
    evaluate({ changedPaths: [], commitMessages: [], today: BEFORE, headPaths: BOTH_PRESENT }),
    { base: "a", head: "b", today: BEFORE },
  );
  assert.match(report, /verdict\s+= clear/);
  for (const p of WATCHED_PATHS) assert.ok(report.includes(p), `report omits ${p}`);
});


// ---------------------------------------------------------------------------
// Per-commit attestation coverage (PEN-5186 re-read, 2026-11-08).
//
// Measured on PR #3336: a range of two commits BOTH touching
// `github-git-egress-runtime.ts`, carrying one trailer between them, cleared
// with `attestations = 1` and no statement anywhere that the attestation had
// two commits to cover. These cases pin the note that states it, and pin just
// as hard that it stays a note.
// ---------------------------------------------------------------------------

// `git log --format=%H` always emits 40 hex characters and the report
// abbreviates to 9, so fixtures are padded to full length rather than written
// short. A 9-character fixture would pass straight through the abbreviation and
// hide whether it happens at all.
const sha40 = (prefix) => prefix.padEnd(40, "0");
const commit = (sha, paths, message = "subject") => ({ sha: sha40(sha), paths, message });
const attested = (sha, paths) =>
  commit(sha, paths, `subject\n\n${TRAILER}: read it, nothing new reaches an exec`);

test("touchingCommits keeps only commits that touch a watched file", () => {
  const rows = touchingCommits([
    commit("aaaaaaaaa1", ["README.md"]),
    commit("bbbbbbbbb2", [RUNTIME, "README.md"]),
    attested("ccccccccc3", [SHIM]),
  ]);
  assert.deepEqual(
    rows,
    [
      { sha: sha40("bbbbbbbbb2"), touched: [RUNTIME], attested: false },
      { sha: sha40("ccccccccc3"), touched: [SHIM], attested: true },
    ],
  );
});

test("a commit's own attestation is read from its own message, not the range", () => {
  // The whole point of the arm: `rereadAttestations` over the range would say
  // "attested" for both rows here. Per commit, exactly one is.
  const rows = touchingCommits([
    commit("aaaaaaaaa1", [RUNTIME]),
    attested("bbbbbbbbb2", [RUNTIME]),
  ]);
  assert.deepEqual(rows.map((r) => r.attested), [false, true]);
});

test("a per-commit input that was never supplied is 'not measured', not 'none'", () => {
  const unmeasured = evaluate({
    changedPaths: [RUNTIME],
    commitMessages: [`${TRAILER}: read it`],
    today: BEFORE,
    headPaths: BOTH_PRESENT,
  });
  assert.equal(unmeasured.perCommit, null);
  assert.equal(unmeasured.coverageUnstated, false);
  assert.match(renderReport(unmeasured, {}), /touched_commits= \(not measured\)/);
});

test("the report names each touching commit and whether it carries a trailer", () => {
  const report = renderReport(
    evaluate({
      changedPaths: [RUNTIME],
      commitMessages: [`${TRAILER}: read both`],
      commits: [commit("a7ceaf998", [RUNTIME]), attested("c53e80b94", [RUNTIME])],
      today: BEFORE,
      headPaths: BOTH_PRESENT,
    }),
    { base: "a", head: "b", today: BEFORE },
  );
  assert.match(report, /touched_commits= a7ceaf998 \[no trailer\], c53e80b94 \[trailer\]/);
});

test("the coverage note fires on an uncovered sibling and names it", () => {
  const result = evaluate({
    changedPaths: [RUNTIME],
    commitMessages: [`${TRAILER}: read both`],
    commits: [commit("a7ceaf998", [RUNTIME]), attested("c53e80b94", [RUNTIME])],
    today: BEFORE,
    headPaths: BOTH_PRESENT,
  });
  assert.equal(result.coverageUnstated, true);
  const report = renderReport(result, { base: "a", head: "b", today: BEFORE });
  assert.match(report, /2 commit\(s\) in this range touch a watched file/);
  assert.match(report, /These carry no trailer of their own: a7ceaf998\./);
  // Named, so a reviewer can go and read the one that was not attested.
  assert.doesNotMatch(report, /c53e80b94 are the commits/);
});

test("the coverage note changes no verdict and no exit code", () => {
  // This is the line that keeps it a note. If it ever reaches `verdict`, it has
  // become a second gate nobody agreed to — the same bar the notice arm holds.
  const shared = {
    changedPaths: [RUNTIME],
    commitMessages: [`${TRAILER}: read both`],
    today: BEFORE,
    headPaths: BOTH_PRESENT,
  };
  const noted = evaluate({
    ...shared,
    commits: [commit("a7ceaf998", [RUNTIME]), attested("c53e80b94", [RUNTIME])],
  });
  const quiet = evaluate({ ...shared, commits: [attested("c53e80b94", [RUNTIME])] });
  assert.equal(noted.coverageUnstated, true);
  assert.equal(quiet.coverageUnstated, false);
  // Same verdict, same trailerOwed, either way.
  assert.equal(noted.verdict, "clear");
  assert.equal(quiet.verdict, "clear");
  assert.equal(noted.trailerOwed, false);
  assert.equal(quiet.trailerOwed, false);
});

test("one touching commit attested somewhere ELSE still raises the note", () => {
  // The shape an earlier draft suppressed with a `perCommit.length > 1` clause,
  // and the one where the coverage question is sharpest: the range carries an
  // attestation, so `trailerOwed` is false and the check clears — but the
  // trailer sits on a commit that touched nothing watched, and nothing else
  // would say so. A mutation test found this; the clause is gone.
  const result = evaluate({
    changedPaths: [RUNTIME],
    commitMessages: ["subject", `docs only\n\n${TRAILER}: read it`],
    commits: [commit("aaaaaaaaa1", [RUNTIME]), attested("bbbbbbbbb2", ["README.md"])],
    today: BEFORE,
    headPaths: BOTH_PRESENT,
  });
  assert.equal(result.trailerOwed, false);
  assert.equal(result.verdict, "clear");
  assert.equal(result.coverageUnstated, true);
  // Abbreviated to 9 characters from the 40 the fixture carries.
  assert.match(renderReport(result, {}), /These carry no trailer of their own: aaaaaaaaa\./);
});

test("a single touching commit that attests itself raises no coverage note", () => {
  // PR #3496's measured shape. One commit, one trailer, nothing to say — a note
  // that fired here would be noise on the correct case, which is how a note
  // teaches people to skim the one that matters.
  const result = evaluate({
    changedPaths: [RUNTIME],
    commitMessages: [`${TRAILER}: read it`],
    commits: [attested("5aaec87f0", [RUNTIME])],
    today: BEFORE,
    headPaths: BOTH_PRESENT,
  });
  assert.equal(result.coverageUnstated, false);
  assert.doesNotMatch(renderReport(result, {}), /carry no trailer of their own/);
});

test("two touching commits that each attest raise no coverage note", () => {
  const result = evaluate({
    changedPaths: [RUNTIME],
    commitMessages: [`${TRAILER}: read it`],
    commits: [attested("aaaaaaaaa1", [RUNTIME]), attested("bbbbbbbbb2", [SHIM])],
    today: BEFORE,
    headPaths: BOTH_PRESENT,
  });
  assert.equal(result.coverageUnstated, false);
});

test("a range with no commit input is refused rather than read as empty", () => {
  // `touchingCommits` is the one place a bad input could quietly become "no
  // commits touched anything", which renders identically to a clean range.
  assert.throws(() => touchingCommits(undefined), /must be an array/);
  assert.throws(() => touchingCommits("a7ceaf998"), /must be an array/);
});

// ---------------------------------------------------------------------------
// `readRange` against a real repository.
//
// Everything in `readRange` is a git invocation, so none of its flags are
// reachable from the pure-function cases above: they are handed synthetic path
// lists and never run git at all. That gap was not theoretical — a mutation
// dropping `--no-renames` from the per-commit log survived the entire suite.
// ---------------------------------------------------------------------------

function scratchRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "pen5186-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "T");
  // Rename detection ON, so a run that forgot `--no-renames` reads this repo
  // the way CI would rather than the way the test wishes.
  git("config", "diff.renames", "true");
  const write = (rel, body) => {
    mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  };
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-q", "--no-gpg-sign", "-m", message);
    return git("rev-parse", "HEAD").trim();
  };
  return { dir, git, write, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("readRange attributes each touching commit and finds the trailer on it", () => {
  const repo = scratchRepo();
  try {
    repo.write("README.md", "base\n");
    // BOTH watched files, or the staleness arm reports the missing one and the
    // verdict below would be "owed" for a reason this case is not about.
    for (const p of WATCHED_PATHS) repo.write(p, "base\n");
    const base = repo.commit("base");

    repo.write(WATCHED_PATHS[1], "one\n");
    const bare = repo.commit("touches the runtime, attests nothing");

    repo.write(WATCHED_PATHS[1], "two\n");
    // A body carrying the characters a naive parser might split on, so the
    // delimiter choice is exercised rather than assumed.
    const withTrailer = repo.commit(
      `touches it again\n\nnotes: a % and a \\x01-looking literal\n\n${TRAILER}: read both, nothing reaches an exec`,
    );

    const range = readRange(base, withTrailer, { cwd: repo.dir });
    assert.deepEqual(range.changedPaths, [WATCHED_PATHS[1]]);
    assert.deepEqual(range.headPaths.sort(), [...WATCHED_PATHS].sort());
    assert.equal(range.commitMessages.length, 2);
    assert.deepEqual(range.commits.map((c) => c.sha), [withTrailer, bare]);

    const rows = touchingCommits(range.commits);
    assert.deepEqual(
      rows.map((r) => [r.sha, r.attested]),
      [[withTrailer, true], [bare, false]],
    );

    // End to end: the range clears (one attestation) and still says the other
    // commit carried none of its own.
    const result = evaluate({ ...range, today: BEFORE });
    assert.equal(result.verdict, "clear");
    assert.equal(result.coverageUnstated, true);
    assert.match(
      renderReport(result, { base, head: withTrailer, today: BEFORE }),
      new RegExp(`These carry no trailer of their own: ${bare.slice(0, 9)}\\.`),
    );
  } finally {
    repo.cleanup();
  }
});

test("readRange sees a RENAMED watched file at its old path, per commit too", () => {
  // `--no-renames` is load-bearing on BOTH git reads. Under rename detection a
  // moved watched file is reported only at its new path, so the watched path
  // never appears, no commit is attributed, and the move sails through with no
  // attestation owed. This is the mutation that survived every other case.
  const repo = scratchRepo();
  try {
    repo.write(WATCHED_PATHS[1], "exactly the same bytes, so git scores the rename 100%\n");
    repo.write("README.md", "base\n");
    const base = repo.commit("base");

    repo.git("mv", WATCHED_PATHS[1], "packages/adapter-utils/src/moved-elsewhere.ts");
    const moved = repo.commit("move the watched file away");

    const range = readRange(base, moved, { cwd: repo.dir });
    assert.ok(
      range.changedPaths.includes(WATCHED_PATHS[1]),
      `the range-wide arm lost the old path: ${range.changedPaths.join(", ")}`,
    );
    const rows = touchingCommits(range.commits);
    assert.deepEqual(
      rows.map((r) => r.sha),
      [moved],
      "the per-commit arm did not attribute the move to the commit that made it",
    );

    // Both arms fire: a re-read is owed AND the watch is now pointing at
    // nothing. A trailer does not clear the second one.
    const result = evaluate({ ...range, today: BEFORE });
    assert.equal(result.trailerOwed, true);
    assert.equal(result.watchStale, true);
    assert.equal(result.verdict, "owed");
  } finally {
    repo.cleanup();
  }
});

test("an unreadable per-commit chunk is refused, not skipped", () => {
  // The silent-failure path: skipping a chunk returns FEWER commits than the
  // range holds, and a short coverage note is indistinguishable from a
  // well-covered range. Loud beats short.
  const good = "\x01abc\x02subject\x03\nfile.ts\n";
  assert.equal(parsePerCommitLog(good).length, 1);
  assert.throws(() => parsePerCommitLog(`${good}\x01no-delimiters-here`), /could not parse/);
  assert.throws(() => parsePerCommitLog("\x01abc\x03out\x02of\x02order"), /could not parse/);
  // An empty blob is an empty range, which is a real answer and not an error.
  assert.deepEqual(parsePerCommitLog(""), []);
  assert.deepEqual(parsePerCommitLog(null), []);
});

test("the per-commit arm reads the SAME commit set as the attestation arm", () => {
  // Both must be two-dot. `git log A...B` is the SYMMETRIC difference, so a
  // three-dot per-commit read on a diverged history pulls in commits from the
  // base side that the attestation count never saw — and the two arms would
  // then disagree about which commits were considered, which is the one
  // property the coverage note's docstring promises.
  const repo = scratchRepo();
  try {
    for (const p of WATCHED_PATHS) repo.write(p, "base\n");
    repo.write("README.md", "base\n");
    const root = repo.commit("root");

    repo.git("checkout", "-q", "-b", "topic");
    repo.write(WATCHED_PATHS[1], "topic\n");
    const head = repo.commit("topic touches the runtime");

    // The base branch moves on after the fork point, which is what makes the
    // two readings differ at all.
    repo.git("checkout", "-q", "main");
    repo.write("README.md", "base moved on\n");
    const base = repo.commit("base side moved");
    assert.notEqual(base, root);

    const range = readRange(base, head, { cwd: repo.dir });
    assert.equal(
      range.commits.length,
      range.commitMessages.length,
      "the per-commit arm and the attestation arm read different commit sets",
    );
    assert.deepEqual(range.commits.map((c) => c.sha), [head]);
  } finally {
    repo.cleanup();
  }
});

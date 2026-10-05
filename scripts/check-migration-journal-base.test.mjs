import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkAgainstBase, readAtRef } from "./check-migration-journal-base.mjs";

// ---------------------------------------------------------------------------
// Fixtures: the REAL entries from the BLO-39490 incident, verbatim.
//
// master@5e792aa62 ends at idx 247; three open PRs each append idx 248 with an
// identical hand-copied `when`, differing only in `tag`. The collision depends
// entirely on the tail, so these four entries reproduce it exactly -- and keep
// reproducing it after the live PRs merge.
// ---------------------------------------------------------------------------
const TAIL = { idx: 247, version: "7", when: 1789900000000, tag: "0247_agent_wakeup_requests_timer_baseline_index", breakpoints: true };
const PR_1864 = { idx: 248, version: "7", when: 1789900100000, tag: "0248_cost_events_cache_creation_tokens", breakpoints: true };
const PR_1741 = { idx: 248, version: "7", when: 1789900100000, tag: "0248_runs_read_transcript_grant_seed", breakpoints: true };
const PR_2190 = { idx: 248, version: "7", when: 1789900100000, tag: "0248_budget_incidents_open_only_unique", breakpoints: true };

const journalOf = (...entries) => ({ version: "7", dialect: "postgresql", entries });
const filesOf = (journal) => journal.entries.map((e) => `${e.tag}.sql`);

/** A whole tree: journal plus the .sql files its entries name. */
const treeOf = (...entries) => {
  const journal = journalOf(...entries);
  return { journal, sqlFiles: filesOf(journal) };
};

const MASTER = treeOf(TAIL);
const check = (head, base, baseLabel = "master") =>
  checkAgainstBase({
    journal: head.journal,
    baseJournal: base.journal,
    sqlFiles: head.sqlFiles,
    baseSqlFiles: base.sqlFiles,
    baseLabel,
  });

// ---------------------------------------------------------------------------
// The incident
// ---------------------------------------------------------------------------

test("a branch taking the next free number passes", () => {
  assert.deepEqual(check(treeOf(TAIL, PR_2190), MASTER), []);
});

test("BLO-39490: once one 248 lands, the other two fail naming idx 248", () => {
  const afterLand = treeOf(TAIL, PR_1864);

  const losers = [PR_1741, PR_2190].map((entry) => check(treeOf(TAIL, entry), afterLand));

  for (const problems of losers) {
    // Both arms fire: the journal idx AND the .sql file number are taken.
    assert.equal(problems.length, 2, problems.join("\n"));
    assert.match(problems[0], /adds idx 248/);
    assert.match(problems[0], /already has idx 248 \("0248_cost_events_cache_creation_tokens"\)/);
    assert.match(problems[0], /renumber .*journal entry AND \.sql file -- to 249/i);
    assert.match(problems[1], /takes number 0248/);
    assert.match(problems[1], /renumber to 0249/i);
  }
  assert.match(losers[0][0], /0248_runs_read_transcript_grant_seed/);
  assert.match(losers[1][0], /0248_budget_incidents_open_only_unique/);
});

test("renumbering onto a free number clears both arms", () => {
  const afterLand = treeOf(TAIL, PR_1864);
  const renumbered = { ...PR_2190, idx: 249, tag: "0249_budget_incidents_open_only_unique" };
  assert.deepEqual(check(treeOf(TAIL, PR_1864, renumbered), afterLand), []);
});

test("an unchanged tree carried over from the base is not a collision", () => {
  assert.deepEqual(check(treeOf(TAIL), MASTER), []);
});

test("re-using a base tag at a different idx is a collision", () => {
  // A migration already on the base, renumbered on the branch.
  const head = treeOf({ ...TAIL, idx: 248 });
  const problems = check(head, MASTER);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /already has that tag at idx 247/);
});

// ---------------------------------------------------------------------------
// Arm 2 on its own: the .sql number is what the post-merge tree trips on, so
// it must fire even when the journal is clean.
// ---------------------------------------------------------------------------

test("a new .sql reusing a base file number fails even when the journal is clean", () => {
  const base = treeOf(TAIL, PR_1864);
  const head = {
    journal: journalOf(TAIL, PR_1864, { ...PR_1741, idx: 249 }),
    // Renumbered the journal entry but not the file -- the half-done rename.
    sqlFiles: [...filesOf(journalOf(TAIL, PR_1864)), "0248_runs_read_transcript_grant_seed.sql"],
  };
  const problems = check(head, base);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /0248_runs_read_transcript_grant_seed\.sql takes number 0248/);
  assert.match(problems[0], /already has 0248_cost_events_cache_creation_tokens\.sql/);
});

test("a .sql with no 4-digit prefix is reported", () => {
  const head = { journal: journalOf(TAIL), sqlFiles: [...MASTER.sqlFiles, "fixup.sql"] };
  assert.match(check(head, MASTER).join("\n"), /does not start with a 4-digit migration number/);
});

// ---------------------------------------------------------------------------
// Fail closed -- this guard has no single-tree arm, so a silent pass is total
// ---------------------------------------------------------------------------

for (const [label, journal] of [
  ["empty entries", journalOf()],
  ["missing entries", { version: "7" }],
  ["null", null],
]) {
  test(`an unreadable head journal (${label}) fails rather than passing vacuously`, () => {
    const problems = checkAgainstBase({ journal, baseJournal: MASTER.journal, sqlFiles: [], baseSqlFiles: [] });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /Refusing to pass a journal this guard cannot read/);
  });

  test(`an unreadable BASE journal (${label}) fails rather than passing vacuously`, () => {
    const problems = checkAgainstBase({ journal: MASTER.journal, baseJournal: journal, sqlFiles: [], baseSqlFiles: [] });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /Refusing to pass a base this guard cannot read/);
  });
}

test("a malformed entry is reported once, not also compared to the base", () => {
  // Both halves of the shape check: non-integer idx, and non-string tag. An
  // entry missing either cannot be compared to the base at all.
  //
  // The second fixture collides with TAIL's idx ON PURPOSE. With an idx the
  // base does not have, the comparison that follows the `malformed` push finds
  // nothing either way, so dropping its `continue` changes no output and the
  // guard has no failing mutation. At idx 247 the fall-through would add a
  // second, nonsensical message (`adds idx 247 ("null") ... Renumber ... to
  // 248`), so the exact count below is what pins the `continue` down.
  for (const bad of [{ idx: "248", tag: "0248_x" }, { idx: 247, tag: null }]) {
    const head = { journal: journalOf(TAIL, bad), sqlFiles: MASTER.sqlFiles };
    const problems = check(head, MASTER);
    assert.equal(problems.length, 1, `${JSON.stringify(bad)} -> ${problems.join("\n")}`);
    assert.match(problems[0], /malformed entry/, JSON.stringify(bad));
  }
});

test("one entry that lost its `idx` does not strip the renumber suggestion from the others", () => {
  // `nextFreeIdx` is computed over the whole journal before the per-entry shape
  // check runs, so a single entry missing `idx` used to make it NaN -- and the
  // "renumber to N" half of every OTHER message is the entire value this guard
  // adds over the merge-queue conflict it predicts.
  // Both sides get one: the base-side filter is a separate guard from the
  // head-side one, and mutating them together lets either hide behind the
  // other's failing assertion.
  const lostIdx = { version: "7", when: 1789900100000, tag: "0248_lost_idx", breakpoints: true };
  const baseLostIdx = { version: "7", when: 1789899900000, tag: "0246_base_lost_idx", breakpoints: true };
  const collide = { ...TAIL, tag: "0247_different_tag" };
  const base = treeOf(TAIL, baseLostIdx);
  const head = {
    journal: journalOf(TAIL, lostIdx, collide),
    sqlFiles: [...base.sqlFiles, "0247_different_tag.sql"],
  };

  const problems = check(head, base);

  assert.equal(problems.length, 3, problems.join("\n"));
  assert.doesNotMatch(problems.join("\n"), /NaN/, problems.join("\n"));
  assert.match(problems[0], /malformed entry/);
  assert.match(problems[1], /renumber .*journal entry AND \.sql file -- to 248/i);
  assert.match(problems[2], /renumber to 0248/i);
});

test("readAtRef throws on an unreadable ref instead of skipping the comparison", () => {
  assert.throws(
    () =>
      readAtRef({
        repoRoot: ".",
        ref: "deadbeef",
        path: "x.json",
        exec: () => {
          throw new Error("fatal: invalid object name");
        },
      }),
    /cannot read x\.json at deadbeef/,
  );
});

// An absent base ref is the one path that reaches a green exit having compared
// nothing. Locally that is fine; in CI it is a required check verifying nothing
// while every sibling still runs. `pr.yml` populates PR_BASE_SHA on both of its
// triggers, so this is unreachable today -- these two pin it shut by
// construction rather than by workflow-level `env:` discipline.
const runWithoutBase = (env) =>
  spawnSync(process.execPath, [fileURLToPath(new URL("./check-migration-journal-base.mjs", import.meta.url))], {
    encoding: "utf8",
    env: { ...process.env, PR_BASE_SHA: "", GITHUB_ACTIONS: "", ...env },
  });

test("no base ref in CI fails rather than passing green having checked nothing", () => {
  const { status, stderr } = runWithoutBase({ GITHUB_ACTIONS: "true" });
  assert.equal(status, 1, stderr);
  assert.match(stderr, /green check that verified nothing/);
});

test("no base ref outside CI stays a local convenience", () => {
  const { status, stdout } = runWithoutBase({});
  assert.equal(status, 0, stdout);
  assert.match(stdout, /nothing was checked/);
});

// ---------------------------------------------------------------------------
// This guard must not duplicate packages/db/src/check-migration-numbering.ts
// (BLO-27927). Everything visible in ONE tree belongs there; a regression that
// re-adds a single-tree arm here shows up as these staying silent.
// ---------------------------------------------------------------------------

test("single-tree problems are left to check-migration-numbering.ts", () => {
  const base = treeOf(TAIL);
  // Duplicate idx within the head journal -> ensureNoDuplicates.
  const dupIdx = { journal: journalOf(TAIL, PR_1864, PR_1741), sqlFiles: filesOf(journalOf(TAIL, PR_1864, PR_1741)) };
  assert.deepEqual(check(dupIdx, base), []);
  // A .sql with no journal entry -> ensureFilesAreJournaled. Includes the nine
  // grandfathered files, which is why this guard needs no baseline of its own.
  const orphan = { journal: journalOf(TAIL), sqlFiles: [...base.sqlFiles, "0115_milestones.sql"] };
  assert.deepEqual(check(orphan, base), []);
  // A journal entry with no .sql -> ensureJournalMatchesFiles.
  const missing = { journal: journalOf(TAIL, PR_1864), sqlFiles: base.sqlFiles };
  assert.deepEqual(check(missing, base), []);
});

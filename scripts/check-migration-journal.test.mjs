import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkJournal,
  JOURNAL_PATH,
  KNOWN_UNJOURNALED,
  readBaseJournal,
  readSqlTags,
} from "./check-migration-journal.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ---------------------------------------------------------------------------
// Fixtures: the REAL entries from the BLO-39490 incident, verbatim.
//
// master@5e792aa62 ends at idx 247; three open PRs each append idx 248 with an
// identical hand-copied `when`, differing only in `tag`. The full ~1700-line
// journal blobs are not checked in because the collision depends entirely on
// the tail -- these five entries reproduce it exactly, and stay reproducible
// after the live PRs merge.
// ---------------------------------------------------------------------------
const MASTER_TAIL = {
  idx: 247,
  version: "7",
  when: 1789900000000,
  tag: "0247_agent_wakeup_requests_timer_baseline_index",
  breakpoints: true,
};
const PR_1864 = { idx: 248, version: "7", when: 1789900100000, tag: "0248_cost_events_cache_creation_tokens", breakpoints: true };
const PR_1741 = { idx: 248, version: "7", when: 1789900100000, tag: "0248_runs_read_transcript_grant_seed", breakpoints: true };
const PR_2190 = { idx: 248, version: "7", when: 1789900100000, tag: "0248_budget_incidents_open_only_unique", breakpoints: true };

const journalOf = (...entries) => ({ version: "7", dialect: "postgresql", entries });
/** A tree where every journal entry has its .sql and nothing else is lying around. */
const tagsOf = (journal) => journal.entries.map((e) => e.tag);

/**
 * Synthetic trees carry no baselined orphans, so the real nine-file
 * KNOWN_UNJOURNALED default would report nine missing files on every fixture.
 * The live tree is exercised against the real default at the bottom.
 */
const check = (args) => checkJournal({ knownUnjournaled: [], ...args });

const MASTER = journalOf(MASTER_TAIL);

// ---------------------------------------------------------------------------
// Arm 1 -- collision against the base branch
// ---------------------------------------------------------------------------

test("a PR adding the next free idx passes", () => {
  const head = journalOf(MASTER_TAIL, PR_2190);
  assert.deepEqual(
    check({ journal: head, sqlTags: tagsOf(head), baseJournal: MASTER }),
    [],
  );
});

test("BLO-39490: once one 248 lands, the other two fail naming idx 248", () => {
  // #1864 merges first, so master now carries its 248.
  const masterAfter1864 = journalOf(MASTER_TAIL, PR_1864);

  const survivors = [PR_1741, PR_2190].map((entry) => {
    const head = journalOf(MASTER_TAIL, entry);
    return check({
      journal: head,
      sqlTags: tagsOf(head),
      baseJournal: masterAfter1864,
      baseLabel: "master",
    });
  });

  // One pass, two failures -- and each failure names the colliding entry and
  // the next free index, not just "conflict".
  for (const problems of survivors) {
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /idx 248/);
    assert.match(problems[0], /0248_cost_events_cache_creation_tokens/);
    assert.match(problems[0], /renumber .*to 249/i);
  }
  assert.match(survivors[0][0], /0248_runs_read_transcript_grant_seed/);
  assert.match(survivors[1][0], /0248_budget_incidents_open_only_unique/);
});

test("renumbering to a free idx clears the collision", () => {
  const masterAfter1864 = journalOf(MASTER_TAIL, PR_1864);
  const renumbered = { ...PR_2190, idx: 249, tag: "0249_budget_incidents_open_only_unique" };
  const head = journalOf(MASTER_TAIL, PR_1864, renumbered);
  assert.deepEqual(
    check({ journal: head, sqlTags: tagsOf(head), baseJournal: masterAfter1864 }),
    [],
  );
});

test("re-using a tag at a different idx is a collision too", () => {
  // A migration already on the base, renumbered on the branch: the tag is
  // unique within the head journal, so only the base arm can catch it.
  const head = journalOf({ ...MASTER_TAIL, idx: 248 });
  const problems = check({ journal: head, sqlTags: tagsOf(head), baseJournal: MASTER });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /already has that tag at idx 247/);
});

test("the same tag twice in one journal fails even with no base to compare to", () => {
  const head = journalOf(MASTER_TAIL, { ...MASTER_TAIL, idx: 248 });
  const problems = check({ journal: head, sqlTags: tagsOf(head), baseJournal: null });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /appears 2 times \(idx 247, 248\)/);
});

test("the keep-both-sides resolution fails on the self-duplicate arm", () => {
  // Resolving the conflict by keeping both lines: two entries, one idx.
  const head = journalOf(MASTER_TAIL, PR_1864, PR_1741);
  const problems = check({ journal: head, sqlTags: tagsOf(head), baseJournal: null });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /idx 248 is claimed by 2 entries/);
});

test("no base journal means the collision arm is skipped, not silently passed", () => {
  // Self-consistency still applies; only the base comparison goes away.
  const head = journalOf(MASTER_TAIL, PR_1864);
  assert.deepEqual(check({ journal: head, sqlTags: tagsOf(head), baseJournal: null }), []);
});

// ---------------------------------------------------------------------------
// Arm 2 -- journal <-> .sql correspondence
// ---------------------------------------------------------------------------

test("BLO-39490 hunk 2: dropping an entry but keeping its .sql fails", () => {
  // The obvious resolution of the single-`tag`-line conflict: one journal
  // entry survives, both .sql files remain, the loser never runs.
  const head = journalOf(MASTER_TAIL, PR_1864);
  const sqlTags = [...tagsOf(head), PR_1741.tag];
  const problems = check({ journal: head, sqlTags, baseJournal: MASTER });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /0248_runs_read_transcript_grant_seed\.sql has no journal entry/);
  assert.match(problems[0], /would never run/);
});

test("a journal entry whose .sql is missing fails", () => {
  const head = journalOf(MASTER_TAIL, PR_1864);
  const problems = check({ journal: head, sqlTags: [MASTER_TAIL.tag], baseJournal: MASTER });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /references "0248_cost_events_cache_creation_tokens" but .*\.sql does not exist/);
});

test("baselined orphans are tolerated but the baseline cannot rot", () => {
  const head = journalOf(MASTER_TAIL);
  const baselined = ["0115_milestones"];

  // Present and unjournalled: the state the baseline describes.
  assert.deepEqual(
    checkJournal({ journal: head, sqlTags: [MASTER_TAIL.tag, "0115_milestones"], baseJournal: null, knownUnjournaled: baselined }),
    [],
  );
  // Listed but gone.
  assert.match(
    checkJournal({ journal: head, sqlTags: [MASTER_TAIL.tag], baseJournal: null, knownUnjournaled: baselined }).join("\n"),
    /no longer exists/,
  );
  // Listed but now properly journalled.
  const fixed = journalOf(MASTER_TAIL, { idx: 248, version: "7", when: 1, tag: "0115_milestones", breakpoints: true });
  assert.match(
    checkJournal({ journal: fixed, sqlTags: tagsOf(fixed), baseJournal: null, knownUnjournaled: baselined }).join("\n"),
    /now HAS a journal entry/,
  );
});

// ---------------------------------------------------------------------------
// Fail-closed: a journal this guard cannot read must not read as clean
// ---------------------------------------------------------------------------

for (const [label, journal] of [
  ["empty entries", journalOf()],
  ["missing entries", { version: "7" }],
  ["null journal", null],
]) {
  test(`an unreadable journal (${label}) fails rather than passing vacuously`, () => {
    const problems = checkJournal({ journal, sqlTags: [], baseJournal: MASTER });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /Refusing to pass a journal this guard cannot read/);
  });
}

test("a malformed entry is reported, not skipped", () => {
  // Both halves of the shape check: a non-integer idx, and a non-string tag.
  // An entry missing either one cannot be reasoned about by any arm below, so
  // skipping it silently would make the whole journal read as clean.
  for (const bad of [{ idx: "248", tag: "0248_x" }, { idx: 248, tag: null }]) {
    const problems = checkJournal({
      journal: journalOf(MASTER_TAIL, bad),
      sqlTags: [MASTER_TAIL.tag],
      baseJournal: null,
      knownUnjournaled: [],
    });
    assert.match(problems.join("\n"), /malformed entry/, JSON.stringify(bad));
  }
});

test("readBaseJournal throws on an unreadable base ref instead of skipping the arm", () => {
  assert.throws(
    () =>
      readBaseJournal({
        repoRoot: REPO_ROOT,
        baseRef: "deadbeef",
        exec: () => {
          throw new Error("fatal: invalid object name");
        },
      }),
    /cannot read .* at base ref deadbeef/,
  );
  assert.equal(readBaseJournal({ repoRoot: REPO_ROOT, baseRef: "" }), null);
});

// ---------------------------------------------------------------------------
// The live tree. This is what keeps KNOWN_UNJOURNALED accurate: the moment a
// baselined file is journalled, deleted, or a tenth orphan appears, this fails.
// ---------------------------------------------------------------------------

test("the checked-in migrations tree is self-consistent", () => {
  const problems = checkJournal({
    journal: JSON.parse(readFileSync(join(REPO_ROOT, JOURNAL_PATH), "utf8")),
    sqlTags: readSqlTags(REPO_ROOT),
    baseJournal: null,
  });
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("KNOWN_UNJOURNALED is frozen and non-empty", () => {
  // It is a ratchet: nine known-dead files, and the guard above holds it there.
  assert.ok(Object.isFrozen(KNOWN_UNJOURNALED));
  assert.equal(KNOWN_UNJOURNALED.length, 9);
});

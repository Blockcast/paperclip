// BLO-41267: "The base is red" in runbooks/merge-queue-stalled-head.md ranks
// failing jobs by DISTINCT PRs. Its timestamped variant must keep that count:
// appending the timestamp and keeping `sort -u` makes every line unique per run,
// so a re-queued PR is counted once per run (9 -> 12 on the worked example).
// The variant's dedup/count stage is run here against a fixture, exactly as
// written in the runbook.
//
// The same section's cancel-rate table once carried a 14:0xZ prefix of a day as
// if it were the day. Its rows must be complete days and its headline figures
// must recompute from them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const runbook = readFileSync(
  new URL("../../../../runbooks/merge-queue-stalled-head.md", import.meta.url),
  "utf8",
);

// The pipeline stage after the per-run loop: everything after `done |` in the
// fenced block that starts at `anchor`.
function stageAfterLoop(anchor) {
  const start = runbook.indexOf(anchor);
  assert.ok(start !== -1, `${anchor} not found; re-anchor this test`);
  const block = runbook.slice(start, runbook.indexOf("```", start));
  const i = block.indexOf("done |");
  assert.ok(i !== -1, "no `done |` stage; re-anchor this test");
  return block.slice(i + "done |".length);
}

const variant = () => stageAfterLoop("# Same as above, plus each PR's earliest failure time");
const mainQuery = () => stageAfterLoop('# $WINDOW is the suspected red period');

// job \t pr \t createdAt, newest first as `gh run list` returns them. PR 101 is
// re-queued three times on the same job.
const fixture = [
  ["Typecheck", "101", "2026-10-08T23:43:06Z"],
  ["Typecheck", "102", "2026-10-08T20:28:51Z"],
  ["Typecheck", "101", "2026-10-08T18:19:07Z"],
  ["Typecheck", "101", "2026-10-08T17:03:58Z"],
  ["Canary", "103", "2026-10-08T02:52:09Z"],
]
  .map((f) => f.join("\t"))
  .join("\n");

function run(stage) {
  const r = spawnSync("bash", ["-c", stage], { input: `${fixture}\n`, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return Object.fromEntries(
    r.stdout
      .trim()
      .split("\n")
      .map((l) => l.split("\t"))
      .map(([n, job, prs]) => [job, { n: Number(n), prs: prs.trim().split(" ") }]),
  );
}

function assertDistinctPrsWithEarliestTime(stage) {
  const out = run(stage);
  assert.equal(out.Typecheck.n, 2, "count must be distinct PRs, not runs");
  assert.deepEqual(out.Typecheck.prs, ["101@10-08T17:03", "102@10-08T20:28"]);
  assert.equal(out.Canary.n, 1);
}

test("the timestamped variant counts distinct PRs and keeps each PR's earliest failure", () => {
  assertDistinctPrsWithEarliestTime(variant());
});

test("must-fail: the main query's `sort -u` stage fed a timestamped stream counts runs", () => {
  assert.throws(() => assertDistinctPrsWithEarliestTime(mainQuery()), assert.AssertionError);
});

function cancelTable() {
  const start = runbook.indexOf("| day | lanes | builds | cancelled |");
  assert.ok(start !== -1, "cancel-rate table not found; re-anchor this test");
  const end = runbook.indexOf("\n\n", start);
  return runbook
    .slice(start, end)
    .split("\n")
    .slice(2)
    .map((l) => l.split("|").map((c) => c.trim()))
    .map(([, day, lanes, builds, cancelled, note]) => ({
      day,
      lanes: Number(lanes),
      builds: Number(builds),
      cancelled: Number(cancelled),
      note,
    }));
}

test("cancel-rate rows are complete days, never a prefix", () => {
  for (const row of cancelTable()) {
    assert.doesNotMatch(row.day, /partial/i, `${row.day} is a prefix written down as a day`);
  }
});

test("cancel-rate headline recomputes from the rows, setting aside red-base builds", () => {
  const one = [0, 0];
  const two = [0, 0];
  for (const row of cancelTable()) {
    if (row.day.startsWith("~~")) continue; // a whole red-base day
    let kept = [row.builds, row.cancelled];
    const mixed = row.note.match(
      /mixed: (\d+) builds \/ (\d+) fan-out, then (\d+) builds \/ (\d+) cancelled on the red base/,
    );
    if (mixed) {
      const [b, c, rb, rc] = mixed.slice(1).map(Number);
      assert.deepEqual([b + rb, c + rc], kept, `${row.day} split does not sum to the row`);
      kept = [b, c];
    }
    const acc = row.lanes === 1 ? one : two;
    acc[0] += kept[0];
    acc[1] += kept[1];
  }
  const pct = ([b, c]) => `${((100 * c) / b).toFixed(1)}% (${c}/${b})`;
  const prose = runbook.replace(/\s+/g, " ");
  assert.ok(prose.includes(`1-lane baseline ${pct(one)}`), `1-lane headline is not ${pct(one)}`);
  assert.ok(
    prose.includes(`2-lane excluding red-base builds ${pct(two)}`),
    `2-lane headline is not ${pct(two)}`,
  );
});

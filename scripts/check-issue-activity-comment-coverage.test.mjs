import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMMENTS_PAGE_SIZE,
  DEFAULT_MIN_SAMPLE,
  EXIT_NO_SAMPLE,
  EXIT_OK,
  EXIT_VIOLATION,
  MAX_COMMENT_PAGES,
  classifyComment,
  decide,
  findViolations,
  planNextCommentsPage,
  sampleSize,
  summarize,
  unkeyedLossPct,
} from "./check-issue-activity-comment-coverage.mjs";

/** Build `n` comments of one shape; ids are unique so the join set behaves. */
function comments(n, { authorType, keyed, prefix }) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    authorType,
    idempotencyKey: keyed ? `key-${prefix}-${i}` : null,
  }));
}

/** The documented steady state: system never logged, route comments logged. */
function healthySample() {
  const agent = comments(40, { authorType: "agent", keyed: false, prefix: "a" });
  const keyedAgent = comments(10, { authorType: "agent", keyed: true, prefix: "k" });
  const system = comments(15, { authorType: "system", keyed: true, prefix: "s" });
  return {
    all: [...agent, ...keyedAgent, ...system],
    logged: new Set([...agent, ...keyedAgent].map((c) => c.id)),
  };
}

test("classifyComment splits on authorType and on whether the request carried a key", () => {
  const logged = new Set(["x"]);
  assert.deepEqual(
    classifyComment({ id: "x", authorType: "agent", idempotencyKey: "k" }, logged),
    { authorType: "agent", path: "keyed", logged: true },
  );
  assert.deepEqual(
    classifyComment({ id: "y", authorType: "system", idempotencyKey: null }, logged),
    { authorType: "system", path: "unkeyed", logged: false },
  );
});

test("classifyComment calls a missing authorType unknown rather than guessing a family", () => {
  assert.equal(classifyComment({ id: "z" }, new Set()).authorType, "unknown");
});

test("summarize carries logged AND unlogged per cell, so coverage reads positively", () => {
  const { all, logged } = healthySample();
  const summary = summarize(all, logged);
  const systemCell = summary.find((c) => c.authorType === "system");
  assert.equal(systemCell.logged, 0);
  assert.equal(systemCell.unlogged, 15);
  const keyedAgentCell = summary.find((c) => c.authorType === "agent" && c.path === "keyed");
  assert.equal(keyedAgentCell.logged, 10);
  assert.equal(keyedAgentCell.unlogged, 0);
  assert.equal(sampleSize(summary), 65);
});

test("unkeyedLossPct measures agent/user unkeyed loss only, ignoring system and keyed cells", () => {
  const agent = comments(100, { authorType: "agent", keyed: false, prefix: "a" });
  const system = comments(50, { authorType: "system", keyed: false, prefix: "s" });
  // 3 of the 100 unkeyed agent comments lost; every system comment unlogged.
  const logged = new Set(agent.slice(3).map((c) => c.id));
  const pct = unkeyedLossPct(summarize([...agent, ...system], logged));
  assert.ok(Math.abs(pct - 3) < 1e-9, `expected 3%, got ${pct}`);
});

test("unkeyedLossPct returns null, not 0, when there is nothing of that shape to measure", () => {
  const system = comments(5, { authorType: "system", keyed: false, prefix: "s" });
  assert.equal(unkeyedLossPct(summarize(system, new Set())), null);
});

test("findViolations reports nothing on the documented steady state", () => {
  const { all, logged } = healthySample();
  assert.deepEqual(findViolations(summarize(all, logged)), []);
});

test("findViolations flags a keyed route comment with no activity row", () => {
  const keyed = comments(10, { authorType: "agent", keyed: true, prefix: "k" });
  const found = findViolations(summarize(keyed, new Set(keyed.slice(1).map((c) => c.id))));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "keyed_comment_unlogged");
});

test("findViolations flags a system comment that IS logged — the documented 0% rule went stale", () => {
  const system = comments(4, { authorType: "system", keyed: false, prefix: "s" });
  const found = findViolations(summarize(system, new Set([system[0].id])));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "system_comment_logged");
});

test("findViolations does NOT flag ordinary unkeyed loss, which is documented and expected", () => {
  const agent = comments(50, { authorType: "agent", keyed: false, prefix: "a" });
  assert.deepEqual(findViolations(summarize(agent, new Set(agent.slice(2).map((c) => c.id)))), []);
});

test("decide returns OK on a healthy sample above the threshold", () => {
  const { all, logged } = healthySample();
  const outcome = decide(summarize(all, logged));
  assert.equal(outcome.code, EXIT_OK);
  assert.equal(outcome.verdict, "OK");
});

// This is the property the probe exists for. The failure being tracked only
// ever presents as an absence, so a probe that scored "nothing to look at" as a
// pass would be indistinguishable from a probe that was not running at all.
test("decide refuses to return OK when it had nothing to measure", () => {
  const outcome = decide(summarize([], new Set()));
  assert.equal(outcome.verdict, "NO_SAMPLE");
  assert.equal(outcome.code, EXIT_NO_SAMPLE);
  assert.notEqual(outcome.code, EXIT_OK);
});

test("decide refuses to return OK on a sample merely too small to support one", () => {
  const agent = comments(DEFAULT_MIN_SAMPLE - 1, { authorType: "agent", keyed: false, prefix: "a" });
  const outcome = decide(summarize(agent, new Set(agent.map((c) => c.id))));
  assert.equal(outcome.verdict, "NO_SAMPLE");
  assert.match(outcome.reason, /need >= /);
});

test("decide reports a ledger violation ahead of any loss ceiling", () => {
  const keyed = comments(30, { authorType: "agent", keyed: true, prefix: "k" });
  const outcome = decide(summarize(keyed, new Set(keyed.slice(1).map((c) => c.id))));
  assert.equal(outcome.code, EXIT_VIOLATION);
  assert.equal(outcome.violations[0].kind, "keyed_comment_unlogged");
});

test("decide fails an explicit unkeyed-loss ceiling only when one is asked for", () => {
  const agent = comments(100, { authorType: "agent", keyed: false, prefix: "a" });
  const summary = summarize(agent, new Set(agent.slice(10).map((c) => c.id)));
  assert.equal(decide(summary, { maxUnkeyedLossPct: 5 }).code, EXIT_VIOLATION);
  assert.equal(decide(summary, { maxUnkeyedLossPct: 20 }).code, EXIT_OK);
  assert.equal(decide(summary).code, EXIT_OK);
});

test("decide refuses the run when a loss ceiling arrived malformed", () => {
  // A typo'd --max-unkeyed-loss-pct must not silently disable the assertion;
  // that is the same "guard that cannot fail" this probe exists to catch.
  const agent = comments(100, { authorType: "agent", keyed: false, prefix: "a" });
  const summary = summarize(agent, new Set(agent.slice(10).map((c) => c.id)));
  const outcome = decide(summary, { maxUnkeyedLossPct: Number("abc") });
  assert.equal(outcome.verdict, "NO_SAMPLE");
  assert.notEqual(outcome.code, EXIT_OK);
  assert.match(outcome.reason, /not a finite number/);
});

test("the three outcomes stay distinct, so clean never collides with unmeasured", () => {
  assert.equal(new Set([EXIT_OK, EXIT_VIOLATION, EXIT_NO_SAMPLE]).size, 3);
});

/* -------------------------------------------------------------------------- */
/* planNextCommentsPage -- the comment walk's stopping rules.                  */
/* A single ?limit=500 request returns the OLDEST 500 and does not say so, so  */
/* the walk is what keeps the sample from being a silent prefix of the very    */
/* long-lived issues most worth measuring.                                     */
/* -------------------------------------------------------------------------- */

/** `n` page rows with ids offset by `from`, shaped like the comments endpoint. */
function page(n, from = 0) {
  return Array.from({ length: n }, (_, i) => ({ id: `c-${from + i}` }));
}

test("a short page ends the walk and keeps every row", () => {
  const step = planNextCommentsPage(page(3), new Set(), 500);
  assert.equal(step.done, true);
  assert.equal(step.reason, "short_page");
  assert.equal(step.cursor, null);
  assert.equal(step.fresh.length, 3);
});

test("an empty page ends the walk without inventing a cursor", () => {
  const step = planNextCommentsPage([], new Set(), 500);
  assert.equal(step.done, true);
  assert.equal(step.reason, "short_page");
  assert.equal(step.cursor, null);
  assert.deepEqual(step.fresh, []);
});

test("a full page continues, anchored on its last id", () => {
  const step = planNextCommentsPage(page(500), new Set(), 500);
  assert.equal(step.done, false);
  assert.equal(step.reason, null);
  assert.equal(step.cursor, "c-499");
  assert.equal(step.fresh.length, 500);
});

test("a page of exactly the limit is 'full', not 'short'", () => {
  // The boundary that decides whether a 500-comment issue is walked further.
  // Reading `length === limit` as short would stop one page early and silently
  // drop every comment after the 500th -- the prefix this probe exists to flag.
  assert.equal(planNextCommentsPage(page(COMMENTS_PAGE_SIZE), new Set(), COMMENTS_PAGE_SIZE).done, false);
  assert.equal(planNextCommentsPage(page(COMMENTS_PAGE_SIZE - 1), new Set(), COMMENTS_PAGE_SIZE).done, true);
});

test("rows already seen are not re-collected", () => {
  const rows = page(500);
  const seen = new Set(rows.slice(0, 200).map((r) => r.id));
  const step = planNextCommentsPage(rows, seen, 500);
  assert.equal(step.fresh.length, 300);
  assert.equal(step.done, false);
});

test("a full page of nothing new ends the walk instead of looping forever", () => {
  // An `after` cursor is documented as strictly exclusive (PEN-4458), but a
  // deployment predating that fix re-returns the anchor at the head of every
  // ascending page. Trusting the contract alone would spin here.
  const rows = page(500);
  const seen = new Set(rows.map((r) => r.id));
  const step = planNextCommentsPage(rows, seen, 500);
  assert.equal(step.done, true);
  assert.equal(step.reason, "no_new_rows");
  assert.equal(step.cursor, null);
  assert.deepEqual(step.fresh, []);
});

test("a full page whose last row has no id stops rather than re-requesting it", () => {
  const rows = [...page(499), { id: undefined }];
  const step = planNextCommentsPage(rows, new Set(), 500);
  assert.equal(step.done, true);
  assert.equal(step.reason, "no_cursor");
  assert.equal(step.fresh.length, 499);
});

test("walking consecutive pages collects every row exactly once", () => {
  // Drives the planner the way main() does, against an inclusive-cursor server
  // that repeats the anchor on every page -- the worst case for the walk.
  const all = page(1250);
  const seen = new Set();
  const collected = [];
  let cursor = null;
  let requests = 0;
  for (let i = 0; i < MAX_COMMENT_PAGES; i++) {
    const start = cursor === null ? 0 : Number(cursor.split("-")[1]);
    const rows = all.slice(start, start + 500);
    requests += 1;
    const step = planNextCommentsPage(rows, seen, 500);
    for (const row of step.fresh) {
      seen.add(row.id);
      collected.push(row.id);
    }
    if (step.done) break;
    cursor = step.cursor;
  }
  assert.equal(collected.length, 1250);
  assert.equal(new Set(collected).size, 1250);
  assert.deepEqual(collected.slice(0, 2), ["c-0", "c-1"]);
  assert.equal(collected.at(-1), "c-1249");
  assert.ok(requests <= MAX_COMMENT_PAGES);
});

test("the page cap is high enough not to bite a realistic issue", () => {
  // 20 x 500. The busiest row measured for PEN-5158 held 315 comments.
  assert.ok(MAX_COMMENT_PAGES * COMMENTS_PAGE_SIZE >= 10000);
});

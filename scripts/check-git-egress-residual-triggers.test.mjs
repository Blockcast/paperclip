// Coverage for `check-git-egress-residual-triggers.mjs` — PEN-4988, the standing
// detector for §7.2 trigger 2 of the PEN-3183 git-egress boundary decision.
//
// WHAT THESE TESTS ARE FOR, AND WHAT THEY CANNOT DO
// -------------------------------------------------
// This detector's whole failure mode is reporting CLEAR when it should report
// FIRED, and a clear verdict is indistinguishable from a broken query. So every
// test below pins the FIRED and UNREADABLE directions; a test that only proved
// the clear path would reproduce the exact trap it exists to catch.
//
// They exercise the pure core (`summariseEntries`, `renderReport`) against
// recorded Loki response shapes. The end-to-end leg — that the query actually
// matches the paperclip-api stream and that a match exits 1 — was proven live
// against Loki on 2026-10-29 with the needle swapped for one known present in
// that stream (23 occurrences, verdict=fired, exit 1). Re-prove that way if the
// stream labels ever change; this file cannot, since it has no Loki.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLEAR,
  FIRED,
  LOKI_QUERY,
  UNREADABLE,
  renderReport,
  summariseEntries,
} from "./check-git-egress-residual-triggers.mjs";

/** The shape Loki's query_range returns: streams, each with [ts, line] pairs. */
function stream(...lines) {
  return [{ values: lines.map((line, i) => [`${1793261925931878776n + BigInt(i)}`, line]) }];
}

const REAL_WARN = JSON.stringify({
  level: "warn",
  event: "claude_k8s.data_mount_broad_rw",
  msg: "data volume mounted broad rw; BLO-32734 subPath narrowing not applied",
  reason: "isolation_disabled",
  runId: "run-1",
  jobName: "ac-job-1",
  dataClaimName: "paperclip-data",
  selfPvcClaimName: "paperclip-data",
});

test("no streams is the only clear verdict", () => {
  assert.equal(summariseEntries([]).length, 0);
  assert.equal(summariseEntries(undefined).length, 0);
  const report = renderReport({ occurrences: [], windowMinutes: 90, lokiUrl: "http://loki" });
  assert.match(report, /verdict\s+= clear/);
  assert.doesNotMatch(report, /fired/);
});

test("a real server warn is counted and its reason leg extracted", () => {
  const [only] = summariseEntries(stream(REAL_WARN));
  assert.equal(only.reason, "isolation_disabled");
  assert.equal(only.jobName, "ac-job-1");
  assert.equal(only.runId, "run-1");
});

test("all three gate legs survive the round trip", () => {
  // The leg is the remedy selector — `no_claim` and `foreign_claim` are fixed
  // differently from `isolation_disabled` — so losing it degrades the page.
  for (const reason of ["isolation_disabled", "no_claim", "foreign_claim"]) {
    const line = JSON.stringify({ event: "claude_k8s.data_mount_broad_rw", reason, jobName: "j", runId: "r" });
    assert.equal(summariseEntries(stream(line))[0].reason, reason);
  }
});

test("an ANSI-wrapped warn still parses", () => {
  // Not hypothetical: every other line on this stream arrives colourised, and a
  // trailing colour reset is enough to break a naive JSON.parse.
  const wrapped = `\u001b[33mWARN\u001b[39m \u001b[90m${REAL_WARN}\u001b[39m`;
  assert.equal(summariseEntries(stream(wrapped))[0].reason, "isolation_disabled");
});

test("an UNPARSEABLE line still counts as an occurrence — fails toward FIRED", () => {
  // The load-bearing direction. If a log-format change made the line unreadable,
  // dropping it would turn a fired trigger into a silent clear; counting it
  // raises a page a human then disambiguates.
  const occurrences = summariseEntries(stream("data_mount_broad_rw but not json at all"));
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].reason, "(unparsed)");
  assert.match(renderReport({ occurrences, windowMinutes: 90, lokiUrl: "x" }), /verdict\s+= fired/);
});

test("occurrences across several streams are all counted", () => {
  const two = [...stream(REAL_WARN), ...stream(REAL_WARN, REAL_WARN)];
  assert.equal(summariseEntries(two).length, 3);
});

test("the report lists distinct reasons and truncates the per-line detail", () => {
  const many = Array.from({ length: 25 }, (_, i) =>
    JSON.stringify({ reason: i % 2 ? "no_claim" : "isolation_disabled", jobName: `j${i}`, runId: `r${i}` }),
  );
  const report = renderReport({ occurrences: summariseEntries(stream(...many)), windowMinutes: 90, lokiUrl: "x" });
  assert.match(report, /reasons\s+= isolation_disabled, no_claim/);
  assert.match(report, /occurrences\s+= 25/);
  assert.match(report, /and 5 more/);
});

test("the Loki query is scoped to the server container, not the namespace", () => {
  // ns `paperclip` also carries every agent pod's own `claude` container. An
  // unscoped query lets agent output match this needle — an agent discussing the
  // event (as this very row does) would be reported as a render that never
  // happened.
  assert.match(LOKI_QUERY, /container="paperclip"/);
  assert.match(LOKI_QUERY, /namespace="paperclip"/);
  assert.match(LOKI_QUERY, /claude_k8s\.data_mount_broad_rw/);
});

test("the Loki needle matches the structured key, not the bare event name", () => {
  // `summariseEntries` counts an unparseable match as FIRED, so a bare-substring
  // needle makes any line that merely QUOTES the event name — an error echoing
  // issue text, a logged request body — a `critical` page. The producer is a
  // single `JSON.stringify({ level, event, ... })`, so the key form is what it
  // actually emits, with no interior spaces.
  assert.match(LOKI_QUERY, /`"event":"claude_k8s\.data_mount_broad_rw"`/);

  // The shape the producer emits must satisfy the needle...
  const needle = LOKI_QUERY.slice(LOKI_QUERY.indexOf("|=") + 2).trim().replaceAll("`", "");
  const emitted = JSON.stringify({
    level: "warn",
    event: "claude_k8s.data_mount_broad_rw",
    reason: "no_claim",
  });
  assert.ok(emitted.includes(needle), `${emitted} does not contain ${needle}`);

  // ...and prose that merely names the event must not.
  const prose = 'error: issue body mentions claude_k8s.data_mount_broad_rw here';
  assert.ok(!prose.includes(needle));
});

test("exit codes are distinct and UNREADABLE is not CLEAR", () => {
  // The workflow branches on these and the alert gives exit 1 and exit 2
  // different alertnames: one means "bypass 3 re-opened", the other means
  // "nothing is currently watching for it".
  assert.equal(CLEAR, 0);
  assert.equal(FIRED, 1);
  assert.equal(UNREADABLE, 2);
  assert.notEqual(UNREADABLE, CLEAR);
});

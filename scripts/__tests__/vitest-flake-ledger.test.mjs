// Guards scripts/vitest-flake-ledger.mjs. Pure functions only -- the download
// half is `gh` plumbing with nothing to assert about.
//
// Run: node --test scripts/__tests__/vitest-flake-ledger.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLedger,
  classify,
  escapeCell,
  readReport,
} from "../vitest-flake-ledger.mjs";

const runnerPath = (rel) => `/home/runner/_work/paperclip/paperclip/${rel}`;

const report = (files) => ({
  testResults: files.map(([name, status, assertions]) => ({
    name: runnerPath(name),
    status,
    assertionResults: (assertions ?? []).map(([fullName, s]) => ({
      fullName,
      status: s,
    })),
  })),
});

test("readReport strips the runner checkout prefix so keys compare across runs", () => {
  const { observed } = readReport(
    report([["server/src/a.test.ts", "passed", [["does a thing", "passed"]]]]),
  );
  assert.deepEqual([...observed], ["server/src/a.test.ts > does a thing"]);
});

test("a suite that crashes before any test runs still counts as a failure", () => {
  // Vitest reports an import-time/setup crash as a failed file with an EMPTY
  // assertionResults. Dropping it would hide the hardest flakes to find.
  const { observed, failed } = readReport(
    report([["server/src/boom.test.ts", "failed", []]]),
  );
  const key = "server/src/boom.test.ts > (file failed with no failing test)";
  assert.deepEqual([...observed], [key]);
  assert.deepEqual([...failed], [key]);
});

test("a failed file whose assertions all PASSED still counts as a failure", () => {
  // The afterAll/teardown-hook shape: every test passed, the file failed, the
  // PR was ejected. Keying on "saw an assertion" rather than "saw a FAILING
  // assertion" would record this as a clean observation of every test in it.
  const { observed, failed } = readReport(
    report([["server/src/teardown.test.ts", "failed", [["t", "passed"]]]]),
  );
  const key = "server/src/teardown.test.ts > (file failed with no failing test)";
  assert.deepEqual(
    [...observed].sort(),
    ["server/src/teardown.test.ts > t", key].sort(),
  );
  assert.deepEqual([...failed], [key]);
});

test("buildLedger separates flaky from always-failing and drops always-passing", () => {
  const flaky = ["server/src/a.test.ts", "passed", [["flaky one", "failed"]]];
  const flakyOk = ["server/src/a.test.ts", "passed", [["flaky one", "passed"]]];
  const broken = ["server/src/b.test.ts", "passed", [["broken one", "failed"]]];
  const fine = ["server/src/c.test.ts", "passed", [["fine one", "passed"]]];

  const rows = buildLedger([
    { runId: 1, reports: [report([flaky, broken, fine])] },
    { runId: 2, reports: [report([flakyOk, broken, fine])] },
  ]);

  assert.deepEqual(
    rows.map((r) => [r.key, r.failedIn.length, r.observedIn.length]),
    [
      // Ranked by failure count, so the worst offender reads first.
      ["server/src/b.test.ts > broken one", 2, 2],
      ["server/src/a.test.ts > flaky one", 1, 2],
    ],
    "always-passing tests must not appear at all",
  );
});

test("a test observed only once is not filed as broken, however large the batch", () => {
  // Ally's reproduction on #2206. The batch has THREE runs, so a batch-level
  // `total < 2` guard does not engage -- but `new one` is still 1/1, which is
  // arithmetically identical to the most broken test in the batch. Filing it
  // under "broken, not flaky" tells a reader someone already knows about it,
  // which is the one heading that makes a row likely to be skipped.
  const old = (s) => ["server/src/a.test.ts", "passed", [["old one", s]]];
  const fresh = ["server/src/b.test.ts", "passed", [["new one", "failed"]]];
  const rows = buildLedger([
    { runId: 1, reports: [report([old("failed")])] },
    { runId: 2, reports: [report([old("passed")])] },
    { runId: 3, reports: [report([old("passed"), fresh])] },
  ]);

  assert.deepEqual(
    rows.map((r) => [
      r.key,
      `${r.failedIn.length}/${r.observedIn.length}`,
      classify(r),
    ]),
    [
      ["server/src/a.test.ts > old one", "1/3", "flaky"],
      ["server/src/b.test.ts > new one", "1/1", "unclassified"],
    ],
  );
});

test("classify subsumes the single-run batch without a special case", () => {
  // Over one run every row is 1/1, so none of them can be classified -- which
  // is what the deleted `total < 2` branch used to say at the batch level.
  const rows = buildLedger([
    {
      runId: 1,
      reports: [report([["server/src/a.test.ts", "passed", [["t", "failed"]]]])],
    },
  ]);
  assert.deepEqual(rows.map(classify), ["unclassified"]);
});

test("a failure in any shard of a run counts once for that run", () => {
  // Each `General tests` leg uploads its own report; a test lives in exactly
  // one shard, but a retry or a re-run can land two reports for it in one run.
  // The unit is the RUN, because the run is what ejects a PR.
  const rows = buildLedger([
    {
      runId: 1,
      reports: [
        report([["server/src/a.test.ts", "passed", [["t", "failed"]]]]),
        report([["server/src/a.test.ts", "passed", [["t", "passed"]]]]),
      ],
    },
  ]);
  assert.deepEqual(rows.map((r) => [r.failedIn.length, r.observedIn.length]), [
    [1, 1],
  ]);
});

test("a cell cannot add a column or end its row early", () => {
  // `fullName` is author-controlled. A `|` adds a column; a newline ends the
  // row, which drops every row printed after it -- a silent truncation of the
  // ledger, not a cosmetic one.
  assert.equal(escapeCell("a | b"), "a \\| b");
  assert.equal(escapeCell("first\n  second"), "first second");
  assert.equal(escapeCell("a|b\nc"), "a\\|b c");
});

// Guards scripts/vitest-flake-ledger.mjs. Pure functions only -- the download
// half is `gh` plumbing with nothing to assert about.
//
// Run: node --test scripts/__tests__/vitest-flake-ledger.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import { buildLedger, readReport } from "../vitest-flake-ledger.mjs";

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

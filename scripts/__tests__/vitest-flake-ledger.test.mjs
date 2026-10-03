// Guards scripts/vitest-flake-ledger.mjs: the pure functions, plus the three
// argv/stdin guards in main() that reject a bad invocation. Those three are
// reached by running the script as a subprocess -- they need no `gh` and no
// network, so the only part left unasserted is the download plumbing itself.
//
// Run: node --test scripts/__tests__/vitest-flake-ledger.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildLedger,
  classify,
  escapeCell,
  readReport,
} from "../vitest-flake-ledger.mjs";

const SCRIPT = fileURLToPath(new URL("../vitest-flake-ledger.mjs", import.meta.url));
const runCli = (...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

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
      // Ranked by failure RATE, so the worst offender reads first.
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
      // `new one` leads on rate (1/1 beats 1/3); the classification, not the
      // order, is what this test is about.
      ["server/src/b.test.ts > new one", "1/1", "unclassified"],
      ["server/src/a.test.ts > old one", "1/3", "flaky"],
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
  // ...and the rate is unchanged BUT the pair is not thrown away: the same key
  // failed and passed with the code held fixed, which is proof rather than
  // inference. Without this it reads 1/1 and files under "not enough runs".
  assert.deepEqual(rows.map(classify), ["proven"]);
});

test("one run that only fails is not promoted to proven", () => {
  // The negative control for the test above: `proven` must require BOTH
  // outcomes, not merely "more than one report" or "was retried".
  const rows = buildLedger([
    {
      runId: 1,
      reports: [
        report([["server/src/a.test.ts", "passed", [["t", "failed"]]]]),
        report([["server/src/a.test.ts", "passed", [["t", "failed"]]]]),
      ],
    },
  ]);
  assert.deepEqual(rows.map(classify), ["unclassified"]);
});

test("inside the flaky table a higher RATE outranks a higher COUNT", () => {
  // Ally's reproduction on #2206. Ranking on the absolute count puts a 3/10 =
  // 30% above a 2/3 = 67%, but the question the flaky table answers is "how
  // often does this eject a PR", which is the rate.
  const one = (file, status) => [file, "passed", [["t", status]]];
  const runs = [];
  for (let i = 0; i < 10; i++) {
    const reports = [report([one("server/src/cold.test.ts", i < 3 ? "failed" : "passed")])];
    if (i < 3) {
      reports.push(report([one("server/src/hot.test.ts", i < 2 ? "failed" : "passed")]));
    }
    runs.push({ runId: i, reports });
  }
  const rows = buildLedger(runs);
  assert.deepEqual(
    rows.map((r) => [r.key, `${r.failedIn.length}/${r.observedIn.length}`]),
    [
      ["server/src/hot.test.ts > t", "2/3"],
      ["server/src/cold.test.ts > t", "3/10"],
    ],
  );
  assert.deepEqual(rows.map(classify), ["flaky", "flaky"]);
});

test("--runs rejects anything that is not a positive integer", () => {
  // `Number("abc")` is NaN and would reach gh as `--limit=NaN`; 0, 2.5 and -1
  // are each accepted by Number() and meaningless as a run count. None of
  // these may spawn gh, so a failure here is also a failure to reach network.
  for (const bad of ["abc", "0", "2.5", "-1", ""]) {
    const r = runCli("--runs", bad);
    assert.notEqual(r.status, 0, `--runs ${bad} must exit non-zero`);
    assert.match(r.stderr, /--runs needs a positive integer|--runs needs a value/);
    assert.equal(r.stdout, "", `--runs ${bad} must print no ledger`);
  }
});

test("--dir on a directory holding no readable reports fails loudly", () => {
  // The silent-green shape this whole script exists to attack: skipping the
  // one input here would print four `_none_` tables and exit 0, rendering "I
  // read nothing" as "no flakes found".
  const empty = mkdtempSync(join(tmpdir(), "flake-ledger-empty-"));
  const r = runCli("--dir", empty);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no readable vitest reports/);
  assert.equal(r.stdout, "", "must not print a ledger it could not build");

  // A directory whose only JSON is unparseable is the same case, not a clean
  // one: parseReports skips the bad file and leaves zero reports behind.
  const junk = mkdtempSync(join(tmpdir(), "flake-ledger-junk-"));
  writeFileSync(join(junk, "report.json"), "{ truncated");
  const r2 = runCli("--dir", junk);
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /no readable vitest reports/);
});

test("--dir renders a ledger from reports it CAN read", () => {
  // The positive control for the two guards above: they must reject a bad
  // invocation without also rejecting a good one.
  const dir = mkdtempSync(join(tmpdir(), "flake-ledger-ok-"));
  writeFileSync(
    join(dir, "report.json"),
    JSON.stringify(report([["server/src/a.test.ts", "passed", [["t", "failed"]]]])),
  );
  const r = runCli("--dir", dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /# vitest flake ledger/);
  assert.match(r.stdout, /\| 1 \/ 1 \| server\/src\/a\.test\.ts > t \|/);
});

test("the module can be imported from an eval context without running main()", () => {
  // `process.argv[1]` is undefined under `node -e`, where an unguarded
  // pathToFileURL throws and takes the whole import down -- so every export
  // becomes unreachable from a context that only wants to read them.
  const r = spawnSync(
    process.execPath,
    ["-e", `import(${JSON.stringify(SCRIPT)}).then(m => console.log(typeof m.classify)).catch(e => { console.log("THREW", e.code); process.exitCode = 1; })`],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), "function");
});

test("a cell cannot add a column or end its row early", () => {
  // `fullName` is author-controlled. A `|` adds a column; a newline ends the
  // row, which drops every row printed after it -- a silent truncation of the
  // ledger, not a cosmetic one.
  assert.equal(escapeCell("a | b"), "a \\| b");
  assert.equal(escapeCell("first\n  second"), "first second");
  assert.equal(escapeCell("a|b\nc"), "a\\|b c");
});

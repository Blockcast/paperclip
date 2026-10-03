#!/usr/bin/env node
// BLO-28886 AC3. Turns the per-shard vitest JSON reports that pr.yml uploads
// (artifact `vitest-report-<group>-<shard>-<attempt>`, see the "Upload vitest
// JSON reports" step) into a per-test flake ledger.
//
// Why this exists: before the upload landed, naming a flaky TEST meant
// downloading job logs -- 45-75s each, and a batch of 18 timed out. The reports
// make it a query.
//
// The distinction the ledger is for: a test that fails in EVERY run it appears
// in is broken, not flaky, and someone already knows. A test that fails in SOME
// runs and passes in others is what ejects blameless PRs from the merge queue.
// Those are reported separately.
//
//   node scripts/vitest-flake-ledger.mjs                  # last 50 merge_group runs
//   node scripts/vitest-flake-ledger.mjs --runs 30 --event pull_request
//   node scripts/vitest-flake-ledger.mjs --dir ./already-downloaded
//
// Artifacts carry `retention-days: 14`, so the window is bounded at two weeks
// regardless of --runs.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "Blockcast/paperclip";
// The runner's checkout prefix, stripped so a path is comparable across runs
// and greppable locally. Keyed on the repo name rather than a literal /home
// path because self-hosted runners use a different workspace root.
const RUNNER_PREFIX = /^.*?\/paperclip\/paperclip\//;

/** Every *.json under `dir`, recursively. */
export function reportFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...reportFiles(path));
    else if (entry.endsWith(".json")) out.push(path);
  }
  return out;
}

/**
 * One vitest JSON report -> the set of test keys it observed, and the subset it
 * saw fail. A suite that crashes before any assertion runs reports
 * `status: "failed"` with an EMPTY assertionResults -- that is a real failure
 * and dropping it would hide exactly the import-time/setup flakes that are
 * hardest to find, so it gets a synthetic key.
 */
export function readReport(json) {
  const observed = new Set();
  const failed = new Set();
  for (const file of json.testResults ?? []) {
    const path = String(file.name ?? "<unknown>").replace(RUNNER_PREFIX, "");
    let sawAssertion = false;
    for (const test of file.assertionResults ?? []) {
      sawAssertion = true;
      const key = `${path} > ${test.fullName ?? test.title ?? "<unnamed>"}`;
      observed.add(key);
      if (test.status === "failed") failed.add(key);
    }
    if (file.status === "failed" && !sawAssertion) {
      const key = `${path} > (suite failed before any test ran)`;
      observed.add(key);
      failed.add(key);
    }
  }
  return { observed, failed };
}

/**
 * runs: [{ runId, dir }] -> ledger rows. A test counts as failed in a run if
 * ANY shard's report in that run saw it fail; the unit is the run, because the
 * run is what ejects a PR.
 */
export function buildLedger(runs) {
  const rows = new Map();
  for (const { runId, reports } of runs) {
    const observed = new Set();
    const failed = new Set();
    for (const report of reports) {
      const r = readReport(report);
      for (const k of r.observed) observed.add(k);
      for (const k of r.failed) failed.add(k);
    }
    for (const key of observed) {
      const row = rows.get(key) ?? { key, observedIn: [], failedIn: [] };
      row.observedIn.push(runId);
      if (failed.has(key)) row.failedIn.push(runId);
      rows.set(key, row);
    }
  }
  return [...rows.values()]
    .filter((row) => row.failedIn.length > 0)
    .sort(
      (a, b) =>
        b.failedIn.length - a.failedIn.length || a.key.localeCompare(b.key),
    );
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20 });
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : argv[i + 1];
  };
  const preDownloaded = arg("dir");
  const limit = Number(arg("runs", "50"));
  const event = arg("event", "merge_group");

  let runs;
  if (preDownloaded) {
    runs = [
      {
        runId: preDownloaded,
        reports: reportFiles(preDownloaded).map((f) =>
          JSON.parse(readFileSync(f, "utf8")),
        ),
      },
    ];
  } else {
    const ids = JSON.parse(
      gh([
        "run",
        "list",
        "-R",
        REPO,
        "--workflow=PR",
        `--event=${event}`,
        `--limit=${limit}`,
        "--json",
        "databaseId,conclusion",
      ]),
    )
      // `cancelled` carries no verdict (BLO-23194) -- counting it would dilute
      // every rate in the ledger with runs that never finished.
      .filter((r) => r.conclusion === "success" || r.conclusion === "failure")
      .map((r) => r.databaseId);

    const root = mkdtempSync(join(tmpdir(), "flake-ledger-"));
    runs = [];
    for (const id of ids) {
      const dir = join(root, String(id));
      try {
        gh([
          "run",
          "download",
          String(id),
          "-R",
          REPO,
          "-p",
          "vitest-report-*",
          "-D",
          dir,
        ]);
      } catch {
        // No artifacts: the run predates the upload step, or they expired at 14
        // days. Either way it carries no test-level evidence -- skip it rather
        // than counting it as a run in which nothing failed.
        process.stderr.write(`run ${id}: no vitest reports, skipped\n`);
        continue;
      }
      runs.push({
        runId: id,
        reports: reportFiles(dir).map((f) =>
          JSON.parse(readFileSync(f, "utf8")),
        ),
      });
    }
  }

  const ledger = buildLedger(runs);
  const total = runs.length;
  const flaky = ledger.filter((r) => r.failedIn.length < r.observedIn.length);
  const broken = ledger.filter((r) => r.failedIn.length === r.observedIn.length);

  const table = (rows) =>
    rows.length === 0
      ? "_none_\n"
      : "| failed / observed | test |\n|---|---|\n" +
        rows
          .map((r) => `| ${r.failedIn.length} / ${r.observedIn.length} | ${r.key} |`)
          .join("\n") +
        "\n";

  process.stdout.write(
    `# vitest flake ledger\n\n` +
      `${total} run(s) with uploaded reports` +
      (preDownloaded ? ` (from ${preDownloaded})` : ` (${event}, last ${limit} listed)`) +
      `\n\n## Flaky -- failed in some runs, passed in others\n\n${table(flaky)}` +
      `\n## Failed in every run observed -- broken, not flaky\n\n${table(broken)}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();

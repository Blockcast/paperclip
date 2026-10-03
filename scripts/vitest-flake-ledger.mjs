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
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
 * saw fail.
 *
 * The invariant: a FAILED file always contributes at least one failed key.
 * Two shapes break it, and both would otherwise be recorded as a clean
 * observation of every test in the file:
 *   - a suite that crashes before any assertion runs (EMPTY assertionResults),
 *     which is where the import-time/setup flakes hide;
 *   - an afterAll/teardown hook error, where every assertion PASSED and the
 *     file still failed -- so keying on "saw an assertion" misses it.
 * Both eject a PR, so both get the synthetic key.
 */
export function readReport(json) {
  const observed = new Set();
  const failed = new Set();
  for (const file of json.testResults ?? []) {
    const path = String(file.name ?? "<unknown>").replace(RUNNER_PREFIX, "");
    let sawFailure = false;
    for (const test of file.assertionResults ?? []) {
      const key = `${path} > ${test.fullName ?? test.title ?? "<unnamed>"}`;
      observed.add(key);
      if (test.status === "failed") {
        failed.add(key);
        sawFailure = true;
      }
    }
    if (file.status === "failed" && !sawFailure) {
      const key = `${path} > (file failed with no failing test)`;
      observed.add(key);
      failed.add(key);
    }
  }
  return { observed, failed };
}

/**
 * runs: [{ runId, reports }] -> ledger rows. A test counts as failed in a run
 * if ANY shard's report in that run saw it fail; the unit is the run, because
 * the run is what ejects a PR.
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

// `gh run download` exits non-zero both for "this run uploaded nothing" and for
// auth / network / HTTP 403 rate limiting -- and a 403 is a live condition on
// this installation. Swallowing those as "no reports" would silently shrink the
// sample and under-count every rate in the ledger, so only the empty-artifact
// result is a skip; everything else re-throws.
const NO_ARTIFACTS = /no (valid )?artifacts?\b/i;

/**
 * Parse every report under `dir`, skipping (not aborting on) unreadable ones. A
 * vitest process killed mid-write leaves truncated JSON and `vitest-report-*`
 * fetches it like any other, so one bad file must not discard a whole batch of
 * downloads that has already been paid for.
 */
function parseReports(dir) {
  const out = [];
  for (const f of reportFiles(dir)) {
    try {
      out.push(JSON.parse(readFileSync(f, "utf8")));
    } catch (err) {
      process.stderr.write(`unreadable report ${f}, skipped: ${err.message}\n`);
    }
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const value = argv[i + 1];
    // A trailing or flag-followed `--runs` would otherwise reach gh as NaN.
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} needs a value`);
    }
    return value;
  };
  const preDownloaded = arg("dir");
  const limit = Number(arg("runs", "50"));
  const event = arg("event", "merge_group");

  let runs;
  let listed;
  let root;
  if (preDownloaded) {
    runs = [{ runId: preDownloaded, reports: parseReports(preDownloaded) }];
    listed = 1;
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
      // every rate in the ledger with runs that never finished. `timed_out` is
      // kept: it is a verdict, and it ejects a PR like any other failure.
      .filter((r) => r.conclusion !== "cancelled" && r.conclusion)
      .map((r) => r.databaseId);
    listed = ids.length;

    root = mkdtempSync(join(tmpdir(), "flake-ledger-"));
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
      } catch (err) {
        if (!NO_ARTIFACTS.test(String(err.stderr ?? err.message))) throw err;
        // The run predates the upload step, or the artifacts expired at 14
        // days. Either way it carries no test-level evidence -- skip it rather
        // than counting it as a run in which nothing failed.
        process.stderr.write(`run ${id}: no vitest reports, skipped\n`);
        continue;
      }
      runs.push({ runId: id, reports: parseReports(dir) });
    }
  }

  const ledger = buildLedger(runs);
  const total = runs.length;

  const escape = (s) => s.replaceAll("|", "\\|");
  const table = (rows) =>
    rows.length === 0
      ? "_none_\n"
      : "| failed / observed | test |\n|---|---|\n" +
        rows
          .map(
            (r) =>
              `| ${r.failedIn.length} / ${r.observedIn.length} | ${escape(r.key)} |`,
          )
          .join("\n") +
        "\n";

  // The flaky/broken split needs at least two runs to mean anything: over one
  // run every row reads 1/1 and lands under "broken" by arithmetic alone.
  const body =
    total < 2
      ? `## Failures (one run only -- flaky vs broken is not separable)\n\n${table(ledger)}`
      : `## Flaky -- failed in some runs, passed in others\n\n` +
        table(ledger.filter((r) => r.failedIn.length < r.observedIn.length)) +
        `\n## Failed in every run observed -- broken, not flaky\n\n` +
        table(ledger.filter((r) => r.failedIn.length === r.observedIn.length));

  process.stdout.write(
    `# vitest flake ledger\n\n` +
      (preDownloaded
        ? `reports from ${preDownloaded}`
        : `${total} of ${listed} run(s) carried reports (${listed - total} skipped), ${event}`) +
      `\n\n${body}`,
  );

  if (root) rmSync(root, { recursive: true, force: true });
}

if (import.meta.url === `file://${process.argv[1]}`) main();

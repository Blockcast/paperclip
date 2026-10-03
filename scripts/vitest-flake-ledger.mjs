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
// Those are reported separately. A test observed only ONCE supports neither
// claim -- 1/1 is arithmetically identical for both -- so it gets a third
// table rather than being filed under "broken" on one data point.
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
import { pathToFileURL } from "node:url";

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

/**
 * Which table a row belongs in, keyed on the ROW's own evidence rather than on
 * the batch size. A test observed once always reads 1/1, so `failed ===
 * observed` cannot tell it apart from the most broken test in the batch -- and
 * "broken, not flaky" tells a reader someone already knows about this one,
 * which makes a 1/1 row the row most likely to be skipped. A newly added or
 * renamed test, or one whose shard failed to upload in most runs, is observed
 * few times, so this is not a rare shape over a 50-run window.
 *
 * Also subsumes the single-run batch: with one run every row has exactly one
 * observation, so every row lands in `unclassified` without a special case.
 */
export function classify(row) {
  if (row.observedIn.length < 2) return "unclassified";
  return row.failedIn.length === row.observedIn.length ? "broken" : "flaky";
}

/**
 * One markdown table cell. Both substitutions exist because `fullName` is
 * attacker-free but author-controlled: a `|` would add a column, and a newline
 * would end the row outright and silently drop every row after it.
 */
export function escapeCell(s) {
  return s.replaceAll("|", "\\|").replace(/\s*\n\s*/g, " ");
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

/**
 * Download and parse every run's vitest reports. The temp dir is owned here so
 * a mid-loop throw -- the 403 above, with up to --runs worth of artifacts
 * already on disk -- cleans up on the way out instead of leaking.
 *
 * A run is only counted once it yields at least one PARSEABLE report, so a run
 * whose reports were all truncated is reported as skipped rather than as a run
 * that carried reports and saw nothing fail.
 */
function downloadRuns(ids) {
  const root = mkdtempSync(join(tmpdir(), "flake-ledger-"));
  try {
    const runs = [];
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
      const reports = parseReports(dir);
      if (reports.length === 0) {
        process.stderr.write(`run ${id}: no readable vitest reports, skipped\n`);
        continue;
      }
      runs.push({ runId: id, reports });
    }
    return runs;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  // `Number("abc")` is NaN, which would otherwise reach gh as `--limit=NaN`.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("--runs needs a positive integer");
  }
  const event = arg("event", "merge_group");

  let runs;
  let listed;
  if (preDownloaded) {
    const reports = parseReports(preDownloaded);
    // The download path skips a report-less run and says so on stderr, because
    // other runs in the batch may still carry evidence. Here there is only one
    // input, so skipping it would print three `_none_` tables and exit 0 -- "I
    // read nothing" rendered as "no flakes found", which is the silent green
    // this whole script exists to attack. An existing but empty directory is
    // the only case: readdirSync already throws ENOENT on a missing one.
    if (reports.length === 0) {
      throw new Error(`--dir ${preDownloaded}: no readable vitest reports`);
    }
    runs = [{ runId: preDownloaded, reports }];
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
      // An ALLOWLIST, not a denylist: `cancelled` carries no verdict
      // (BLO-23194) and `startup_failure`/`neutral`/`skipped`/`stale`/
      // `action_required` cannot carry vitest reports at all, so each would
      // cost a wasted `gh run download` against a rate-limited installation
      // and inflate the skipped count. `timed_out` IS kept: it is a verdict,
      // and it ejects a PR like any other failure.
      .filter((r) => ["success", "failure", "timed_out"].includes(r.conclusion))
      .map((r) => r.databaseId);
    listed = ids.length;
    runs = downloadRuns(ids);
  }

  const ledger = buildLedger(runs);
  const total = runs.length;

  const table = (rows) =>
    rows.length === 0
      ? "_none_\n"
      : "| failed / observed | test |\n|---|---|\n" +
        rows
          .map(
            (r) =>
              `| ${r.failedIn.length} / ${r.observedIn.length} | ${escapeCell(r.key)} |`,
          )
          .join("\n") +
        "\n";

  const bucket = (name) => table(ledger.filter((r) => classify(r) === name));
  const body =
    `## Flaky -- failed in some runs, passed in others\n\n` +
    bucket("flaky") +
    `\n## Failed in every run observed -- broken, not flaky\n\n` +
    bucket("broken") +
    `\n## Failed on their only observation -- not enough runs to classify\n\n` +
    bucket("unclassified");

  process.stdout.write(
    `# vitest flake ledger\n\n` +
      (preDownloaded
        ? `reports from ${preDownloaded}`
        : `${total} of ${listed} run(s) carried reports (${listed - total} skipped), ${event}`) +
      `\n\n${body}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();

#!/usr/bin/env node
/**
 * report-shard-manifest-freshness.mjs
 *
 * Reports drift between the server suite set on disk and
 * scripts/general-server-shard-durations.json (BLO-24241), in the runner's
 * WARNING channel, and always exits 0.
 *
 * PEN-5700 is why this is a reporter and not a `node --test` step. The check
 * used to run as `node --test ./scripts/check-shard-manifest-freshness.test.mjs`
 * under `continue-on-error: true`, on the belief -- written into pr.yml -- that
 * a stale manifest would then show as "a real red X on its own step". It does
 * not. `continue-on-error` sets the step's CONCLUSION to `success`; it does not
 * suppress the `##[error]` annotation the runner mints for a non-zero exit. So
 * a green step wrote a full ERR_ASSERTION diff and `##[error]Process completed
 * with exit code 1.` into the `policy` log, indistinguishable from the job's
 * real failure and LATER in the log than it.
 *
 * Four readers in two days took it for the real failure: PEN-5667 records the
 * #3376 ejection being "misdiagnosed ... as a master-wide shard-manifest
 * breakage"; the Security Engineer formed and falsified the same hypothesis
 * from a different PR; and the CTO reached it twice, once while filing
 * PEN-5700 and again the next day on #3438 -- that fourth time having
 * "reproduced the assertion on a pristine clone of master", which does fail,
 * and concluded in writing that master was red and every PR blocked. That is
 * the sharp edge here: the assertion is TRUE, so verifying it confirms the
 * wrong conclusion. Nothing in the log says the step passed.
 *
 * So the severity of the message now matches the severity of the step. Drift
 * is still named suite-by-suite with its one-line fix, and is still visible --
 * more visible, since a `::warning::` surfaces in the run summary rather than
 * only in the log body -- but it is no longer spelled like a failure.
 *
 * This file never exits non-zero. That is the invariant, not an implementation
 * detail: an unexpected error is reported as a warning too (see main), because
 * a step whose whole purpose is to report without blocking must not acquire a
 * way to block. What a stale manifest actually COSTS is gated elsewhere and
 * stays required: scripts/__tests__/run-vitest-stable-shard.test.mjs fails the
 * job below HARD_FAIL_COVERAGE_FLOOR, which is the abandonment case this
 * report is deliberately not.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadShardDurations } from "./general-server-shard.mjs";
import {
  evaluateManifestFreshness,
  formatMissingSuitesDiagnostic,
} from "./check-shard-manifest-freshness.mjs";
import { collectAllServerSuiteFiles } from "./run-vitest-stable-suites.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST = path.join(repoRoot, "scripts", "general-server-shard-durations.json");

/**
 * Escaping for an annotation's message, per the workflow-command format:
 * `%` first (so it cannot double-escape the sequences introduced after it),
 * then CR and LF. Without this a multi-line diagnostic is truncated at its
 * first newline and every suite after the first is lost from the annotation.
 */
export function escapeAnnotationData(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

/**
 * Pure half: a freshness result in, the exact lines to print out. Split from
 * the IO so both branches are provable without a tree in a particular state.
 *
 * `annotations` is empty when the manifest is current -- a reporter that
 * annotates on the happy path trains readers to ignore it, which is the
 * failure this file exists to undo rather than relocate.
 */
export function renderFreshnessReport({ missing, coverage, totalSuites }) {
  if (missing.length === 0) {
    return {
      stale: false,
      log: [
        `Shard duration manifest is current: all ${totalSuites} server suite(s) have a recorded duration.`,
      ],
      annotations: [],
    };
  }

  const diagnostic = formatMissingSuitesDiagnostic({ missing, coverage, totalSuites });
  return {
    stale: true,
    log: [diagnostic],
    annotations: [
      `::warning title=Shard duration manifest is stale::${escapeAnnotationData(diagnostic)}`,
    ],
  };
}

/** `--manifest <path>` / `--manifest=<path>`, so a fixture can drive both branches. */
export function parseManifestArg(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--manifest") return argv[i + 1];
    const inline = /^--manifest=(.*)$/.exec(argv[i]);
    if (inline) return inline[1];
  }
  return undefined;
}

export function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  let report;
  try {
    const files = collectAllServerSuiteFiles(repoRoot);
    const durations = loadShardDurations(parseManifestArg(argv) ?? DEFAULT_MANIFEST);
    report = renderFreshnessReport(evaluateManifestFreshness({ files, durations }));
  } catch (error) {
    // Reported, never thrown. See the header: this step must not acquire a way
    // to fail `policy`, and a crash here is still information worth surfacing.
    log(
      `::warning title=Shard duration manifest report failed::${escapeAnnotationData(
        `Could not evaluate manifest freshness: ${error?.stack ?? error}`,
      )}`,
    );
    return;
  }

  for (const line of [...report.log, ...report.annotations]) log(line);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}

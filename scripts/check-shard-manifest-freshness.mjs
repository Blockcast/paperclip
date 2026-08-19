/**
 * check-shard-manifest-freshness.mjs
 *
 * Detects drift between the general-server suite set on disk and
 * scripts/general-server-shard-durations.json (BLO-24241).
 *
 * A suite absent from the manifest silently gets the median weight (see
 * defaultSuiteWeight in general-server-shard.mjs) instead of a build
 * failure -- the right default for a typical new suite, the wrong one for a
 * heavyweight (a 138s+ suite ran packed as median-sized before this ticket).
 * The old gate (scripts/__tests__/run-vitest-stable-shard.test.mjs asserting
 * coverage >=90%) turned that silent drift into a hard cliff: one PR
 * crossing 90% failed the `policy` job outright, which skips build,
 * typecheck, e2e and every test lane over a single missing JSON entry
 * (#1117 hit this at 359/399=89.97%).
 *
 * These two functions now back two separate, differently-tiered checks:
 *   - run-vitest-stable-shard.test.mjs keeps a REQUIRED assertion, but at a
 *     much more generous floor (HARD_FAIL_COVERAGE_FLOOR, well below the old
 *     90%) so ordinary one-or-two-suite drift can no longer cascade. It
 *     always prints formatMissingSuitesDiagnostic() as a warning even when
 *     it doesn't fail.
 *   - scripts/check-shard-manifest-freshness.test.mjs asserts
 *     strict 100% coverage and is wired into .github/workflows/pr.yml with
 *     continue-on-error, so it stays visible (a real red X on its own step,
 *     naming every missing suite and the fix) without failing `policy`.
 */

export const HARD_FAIL_COVERAGE_FLOOR = 0.75;

export const ONE_LINE_FIX =
  "Run `node scripts/measure-general-server-shard-durations.mjs --update` to backfill real durations for the suites below (or wait for the next .github/workflows/refresh-shard-manifest.yml run).";

export function evaluateManifestFreshness({ files, durations }) {
  const missing = files.filter((file) => durations[file] === undefined).sort();
  const coverage = files.length === 0 ? 1 : (files.length - missing.length) / files.length;
  return { missing, coverage, totalSuites: files.length };
}

export function formatMissingSuitesDiagnostic({ missing, coverage, totalSuites }) {
  const pct = (coverage * 100).toFixed(1);
  const lines = [
    `Shard duration manifest coverage is ${pct}% (${missing.length} of ${totalSuites} general-server suite(s) missing a recorded duration).`,
    ...missing.map((file) => `  - ${file}`),
    "",
    ONE_LINE_FIX,
  ];
  return lines.join("\n");
}

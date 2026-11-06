import assert from "node:assert/strict";
import test from "node:test";

import {
  HARD_FAIL_COVERAGE_FLOOR,
  ONE_LINE_FIX,
  evaluateManifestFreshness,
  formatMissingSuitesDiagnostic,
} from "./check-shard-manifest-freshness.mjs";

// PEN-5700: every test here is PURE -- literal inputs, no tree, no manifest --
// which is what lets pr.yml run this step as REQUIRED. It used to also carry a
// tree-state assertion ("no server suite present on disk is absent from the
// manifest"), and carrying both in one file is what forced the whole step under
// `continue-on-error: true`: tree state drifts on its own, so the step had to
// be allowed to fail, which left these regression tests unable to fail anything
// either. Worse, `continue-on-error` does not suppress the `##[error]` the
// runner mints for the non-zero exit -- it only sets the step's CONCLUSION to
// `success` -- so the drift assertion wrote a full ERR_ASSERTION diff into the
// `policy` log from a green step, and four readers in two days took it for the
// job's real failure.
//
// That tree-state report now lives in scripts/report-shard-manifest-freshness.mjs,
// which says "stale" in the runner's warning channel and always exits 0. The
// cost of real abandonment is still gated, and still required, by the
// HARD_FAIL_COVERAGE_FLOOR assertion in
// scripts/__tests__/run-vitest-stable-shard.test.mjs.

test("evaluateManifestFreshness flags a suite present in the file list but absent from the manifest", () => {
  const files = ["a.test.ts", "b.test.ts", "c.test.ts"];
  const durations = { "a.test.ts": 10, "c.test.ts": 30 };

  const result = evaluateManifestFreshness({ files, durations });

  assert.deepEqual(result.missing, ["b.test.ts"]);
  assert.equal(result.totalSuites, 3);
  assert.ok(Math.abs(result.coverage - 2 / 3) < 1e-9);
});

test("evaluateManifestFreshness reports full coverage when nothing is missing", () => {
  const files = ["a.test.ts", "b.test.ts"];
  const durations = { "a.test.ts": 10, "b.test.ts": 20, "unrelated.test.ts": 5 };

  const result = evaluateManifestFreshness({ files, durations });

  assert.deepEqual(result.missing, []);
  assert.equal(result.coverage, 1);
});

test("formatMissingSuitesDiagnostic names every missing suite and the one-line fix", () => {
  const diagnostic = formatMissingSuitesDiagnostic({
    missing: ["server/src/__tests__/heavy-suite.test.ts"],
    coverage: 0.99,
    totalSuites: 100,
  });

  assert.ok(diagnostic.includes("server/src/__tests__/heavy-suite.test.ts"));
  assert.ok(diagnostic.includes("99.0%"));
  assert.ok(diagnostic.includes(ONE_LINE_FIX));
});

test("the hard-fail floor sits well below the old 90% cliff so a suite or two of drift cannot cascade", () => {
  assert.ok(HARD_FAIL_COVERAGE_FLOOR < 0.9);
  assert.ok(HARD_FAIL_COVERAGE_FLOOR > 0, "floor must still catch genuine abandonment");
});

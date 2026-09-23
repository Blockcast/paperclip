import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadShardDurations } from "./general-server-shard.mjs";
import {
  HARD_FAIL_COVERAGE_FLOOR,
  ONE_LINE_FIX,
  evaluateManifestFreshness,
  formatMissingSuitesDiagnostic,
} from "./check-shard-manifest-freshness.mjs";
import { collectGeneralServerSuiteFiles } from "./run-vitest-stable-suites.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const durationsManifest = path.join(repoRoot, "scripts", "general-server-shard-durations.json");

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

// The direct verifying signal for BLO-24241: no suite present on disk may be
// absent from the manifest. Before the manifest fix landed in the same PR
// this failed against the real tree (3 suites were missing); it now proves
// the fix stuck. Unlike the old >=90% assertion in
// run-vitest-stable-shard.test.mjs, this step is wired into
// .github/workflows/pr.yml with continue-on-error, so a future regression
// here shows as a visible red X on its own step instead of failing the
// `policy` job and skipping build/typecheck/e2e for the whole PR.
test("no general-server suite present on disk is absent from the manifest", () => {
  const files = collectGeneralServerSuiteFiles(repoRoot);
  const durations = loadShardDurations(durationsManifest);

  const result = evaluateManifestFreshness({ files, durations });

  assert.deepEqual(
    result.missing,
    [],
    `manifest is missing entries for suites present on disk:\n${formatMissingSuitesDiagnostic(result)}`,
  );
});

test("the hard-fail floor sits well below the old 90% cliff so a suite or two of drift cannot cascade", () => {
  assert.ok(HARD_FAIL_COVERAGE_FLOOR < 0.9);
  assert.ok(HARD_FAIL_COVERAGE_FLOOR > 0, "floor must still catch genuine abandonment");
});

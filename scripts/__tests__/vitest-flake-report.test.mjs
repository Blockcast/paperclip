import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// BLO-28886 AC3. The per-test flake ledger is built from vitest JSON reports
// uploaded by the `General tests` matrix. Two properties make that work, and
// both fail SILENTLY if removed -- the artifact simply stops appearing, and
// nothing goes red:
//
//   1. The upload runs `if: always()`. A ledger is built from the runs that
//      FAILED; an upload gated on success collects only the reports nobody
//      needs, while still looking correctly wired.
//   2. The reporter is gated on PAPERCLIP_VITEST_REPORT_DIR and the job sets
//      it. Drop either half and every report lands nowhere.
//
// Same family as the fail-open filters this repo keeps re-learning: a guard
// whose failure mode is "produces nothing" is indistinguishable from "found
// nothing", so it needs a test that fails when the guard is removed.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const vitestConfig = readFileSync(path.join(repoRoot, "vitest.config.ts"), "utf8");
const prWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/pr.yml"), "utf8");

const ENV_VAR = "PAPERCLIP_VITEST_REPORT_DIR";
const REPORT_DIR = "/tmp/vitest-reports";

// The `general_tests` job body, up to the next top-level job key. Sliced by
// line rather than by regex: a `(?:(?!  key:)[\s\S])*` scan is not anchored to
// line starts, so it halts two characters into any deeper-indented `env:` and
// silently returns a truncated job.
function generalTestsJob() {
  const lines = prWorkflow.split("\n");
  const start = lines.findIndex((line) => line === "  general_tests:");
  assert.notEqual(start, -1, "could not locate the `general_tests` job in .github/workflows/pr.yml");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const job = lines.slice(start, end).join("\n");
  // A truncated slice would vacuously pass every assertion below.
  assert.match(job, /- name: Run grouped general test suites/, "job slice looks truncated");
  return job;
}

test("vitest.config.ts registers the JSON reporter only when the report dir is set", () => {
  assert.match(
    vitestConfig,
    new RegExp(`process\\.env\\.${ENV_VAR}`),
    `vitest.config.ts must gate the JSON reporter on ${ENV_VAR}`,
  );
  assert.match(
    vitestConfig,
    /reporters:\s*\["default",\s*"json"\]/,
    "expected both the default reporter (human-readable CI logs) and the json reporter",
  );
  assert.match(
    vitestConfig,
    /outputFile:\s*\{\s*json:/,
    "expected the json reporter to write to outputFile.json",
  );
  // Many vitest invocations per job; a fixed filename keeps only the last one.
  // Asserted against the outputFile expression itself, not anywhere in the
  // file -- the surrounding comment also says "process.pid", so a loose match
  // passes with the interpolation deleted.
  assert.match(
    vitestConfig,
    /outputFile:\s*\{\s*json:\s*`[^`]*\$\{process\.pid\}[^`]*`/,
    "the report filename must interpolate process.pid, or invocations overwrite each other",
  );
  // The gate has to be a real conditional: an unconditional reporter would
  // change local `pnpm test` output and write reports nobody collects.
  assert.match(
    vitestConfig,
    /\?[\s\S]*reporters:[\s\S]*:\s*\{\}/,
    "the reporter block must be conditional on the env var, not unconditional",
  );
});

test("the General tests job exports the report dir and uploads the reports on failure", () => {
  const job = generalTestsJob();

  assert.match(
    job,
    new RegExp(`${ENV_VAR}:\\s*${REPORT_DIR}\\b`),
    `general_tests must export ${ENV_VAR}=${REPORT_DIR}`,
  );

  const upload =
    /\n {6}- name: Upload vitest JSON reports[^\n]*\n((?: {8}[^\n]*\n| *\n)*)/.exec(job);
  assert.ok(upload, "general_tests must upload the vitest JSON reports");
  const step = upload[1];

  assert.match(
    step,
    /if:\s*always\(\)/,
    "the upload must be `if: always()` -- a flake ledger is built from the FAILING runs",
  );
  assert.match(step, /uses:\s*actions\/upload-artifact@/, "expected actions/upload-artifact");
  assert.match(
    step,
    new RegExp(`path:\\s*${REPORT_DIR}/`),
    `the upload path must match ${ENV_VAR}`,
  );
  assert.match(
    step,
    /if-no-files-found:\s*ignore/,
    "must be `ignore`: a shard killed at its timeout cap writes no report, and a " +
      "missing ledger row must never turn an otherwise-green run red",
  );
  // Artifact names must be unique across the 6 matrix legs or the upload 409s.
  // `shard_index` is 0 for the first server shard, and 0 is FALSY in a GitHub
  // expression -- so the fallback has to test `shard_count`, not `shard_index`.
  assert.match(
    step,
    /name:\s*vitest-report-\$\{\{ matrix\.group \}\}-\$\{\{ matrix\.shard_count == '' && 'all' \|\| matrix\.shard_index \}\}/,
    "artifact name must be unique per matrix leg and must not collapse shard 0 into 'all'",
  );
  // Uniqueness across legs is not enough: a re-run of a failed job is a new
  // ATTEMPT of the same run, so the same leg re-uploads a name that already
  // exists and upload-artifact@v4 409s. On a ~29%-red lane "Re-run failed
  // jobs" is the common path, so without this the step turns a retried job
  // red -- exactly the blameless failure this issue exists to stop.
  assert.match(
    step,
    /continue-on-error:\s*true/,
    "the upload must be `continue-on-error: true`: a re-run 409s on the existing " +
      "artifact name, and this step must never be able to fail a job",
  );
});

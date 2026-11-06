import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  escapeAnnotationData,
  parseManifestArg,
  renderFreshnessReport,
} from "../report-shard-manifest-freshness.mjs";
import { collectAllServerSuiteFiles } from "../run-vitest-stable-suites.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const reporter = path.join(repoRoot, "scripts", "report-shard-manifest-freshness.mjs");

// Both spawn branches are driven by a FIXTURE manifest, never by the checked-in
// one. Tree state is exactly what drifts here -- the manifest is refreshed
// weekly against suites that land daily -- so a test that reads today's real
// coverage asserts a different thing on Monday than on Friday, and the stale
// branch (the one PEN-5700 is about) would stop being exercised at all the
// first time the manifest caught up.
function fixtureManifest(durations) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shard-manifest-"));
  const file = path.join(dir, "durations.json");
  writeFileSync(file, JSON.stringify({ durations }), "utf8");
  return file;
}

function runReporter(manifestPath) {
  return spawnSync(process.execPath, [reporter, "--manifest", manifestPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

// The invariant the whole row turns on. `continue-on-error: true` sets a step's
// CONCLUSION to `success` but does NOT suppress the `##[error]` annotation the
// runner mints for a non-zero exit, so the only way a non-blocking step stops
// spelling itself like a failure is to actually succeed.
test("a stale manifest still exits 0, so the runner mints no error annotation for it", () => {
  const result = runReporter(fixtureManifest({}));

  assert.equal(result.status, 0, `reporter must exit 0 when stale: ${result.stderr}`);
  assert.match(result.stdout, /::warning title=Shard duration manifest is stale::/);
  assert.doesNotMatch(result.stdout, /::error/);
  assert.equal(result.stderr.trim(), "", "a stale manifest is not an error-channel event");
});

test("a current manifest exits 0 and raises no annotation at all", () => {
  const everySuite = Object.fromEntries(
    collectAllServerSuiteFiles(repoRoot).map((file) => [file, 1000]),
  );
  const result = runReporter(fixtureManifest(everySuite));

  assert.equal(result.status, 0, `reporter must exit 0 when current: ${result.stderr}`);
  assert.doesNotMatch(result.stdout, /::warning/);
  assert.doesNotMatch(result.stdout, /::error/);
  assert.match(result.stdout, /Shard duration manifest is current/);
});

test("the stale report names every missing suite and the one-line fix", () => {
  const report = renderFreshnessReport({
    missing: ["server/src/__tests__/a.test.ts", "server/src/services/b.test.ts"],
    coverage: 0.5,
    totalSuites: 4,
  });

  assert.equal(report.stale, true);
  assert.equal(report.annotations.length, 1);
  const [annotation] = report.annotations;
  assert.ok(annotation.startsWith("::warning "), "drift is a warning, not an error");
  assert.ok(annotation.includes("server/src/__tests__/a.test.ts"));
  assert.ok(annotation.includes("server/src/services/b.test.ts"));
  assert.ok(annotation.includes("measure-general-server-shard-durations.mjs"));
  // The plain-text diagnosis stays in the log body: the row's own done-when
  // forbids silencing it, since nothing else reports drift suite-by-suite.
  assert.ok(report.log.join("\n").includes("server/src/__tests__/a.test.ts"));
});

test("a current manifest produces no annotation, so the channel stays worth reading", () => {
  const report = renderFreshnessReport({ missing: [], coverage: 1, totalSuites: 7 });

  assert.equal(report.stale, false);
  assert.deepEqual(report.annotations, []);
  assert.ok(report.log.join("\n").includes("all 7 server suite(s)"));
});

// A workflow command ends at its first raw newline. Unescaped, the annotation
// would carry only the coverage line and drop every suite name under it --
// which is the half a reader actually needs.
test("the annotation is a single line with newlines escaped", () => {
  const [annotation] = renderFreshnessReport({
    missing: ["a.test.ts", "b.test.ts"],
    coverage: 0.5,
    totalSuites: 4,
  }).annotations;

  assert.ok(!annotation.includes("\n"), "annotation must not contain a raw newline");
  assert.ok(annotation.includes("%0A"), "newlines must survive as %0A");
});

// Order matters: escaping `%` after the newline substitution turns each `%0A`
// back into a literal `%250A` and the annotation renders the escape codes.
test("escapeAnnotationData escapes the percent sign before the sequences it introduces", () => {
  assert.equal(escapeAnnotationData("99.4%\nnext"), "99.4%25%0Anext");
  assert.equal(escapeAnnotationData("a\r\nb"), "a%0D%0Ab");
});

test("parseManifestArg accepts both the separated and inline spellings", () => {
  assert.equal(parseManifestArg(["--manifest", "/tmp/a.json"]), "/tmp/a.json");
  assert.equal(parseManifestArg(["--manifest=/tmp/b.json"]), "/tmp/b.json");
  assert.equal(parseManifestArg([]), undefined);
});

// Guards the repair itself. Re-adding `continue-on-error` to either step
// restores exactly the defect PEN-5700 removed, and it would read as a tidy-up
// to anyone who still believes it produces "a real red X on its own step".
test("pr.yml runs the reporter and neither freshness step is continue-on-error", () => {
  const source = readFileSync(path.join(repoRoot, ".github", "workflows", "pr.yml"), "utf8");
  // Blank comment bodies in place: this file's own steps are documented in
  // prose that names `continue-on-error`, and counting a sentence about the
  // rule as an instance of breaking it would make documenting it turn this red.
  const workflow = source
    .replace(/^[ \t]*#.*$/gm, (line) => " ".repeat(line.length))
    .replace(/[ \t]#[^\n]*$/gm, (trailing) => " ".repeat(trailing.length));

  const start = workflow.indexOf("\n  policy:\n");
  const end = workflow.indexOf("\n  helm_chart:\n", start);
  assert.notEqual(start, -1, "pr.yml must define policy");
  assert.notEqual(end, -1, "pr.yml must define helm_chart after policy");
  const steps = workflow.slice(start, end).split("\n      - name: ").slice(1);

  const byName = (prefix) => {
    const found = steps.filter((step) => step.split("\n")[0].trim().startsWith(prefix));
    assert.equal(found.length, 1, `policy must define exactly one "${prefix}" step`);
    return found[0];
  };

  const reporterStep = byName("Report shard duration manifest freshness");
  assert.match(reporterStep, /run: node \.\/scripts\/report-shard-manifest-freshness\.mjs/);
  assert.doesNotMatch(
    reporterStep,
    /continue-on-error/,
    "the reporter exits 0 by design; continue-on-error would re-mint the error annotation it removes",
  );

  assert.doesNotMatch(
    byName("Test shard manifest freshness helpers"),
    /continue-on-error/,
    "the helper tests are pure and must be able to fail the job",
  );
});

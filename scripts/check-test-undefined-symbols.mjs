#!/usr/bin/env node
// Fails when a server test references an identifier that does not exist.
//
// Why this is narrow rather than a full typecheck: server/tsconfig.json is both
// the build config and the typecheck config, and it excludes src/__tests__ so
// tests stay out of dist/. The side effect was that tests were never
// typechecked. On 2026-08-10 a test called `buildHumanGatedAgeingReport`, a
// symbol that exists nowhere; it threw ReferenceError on every run, failed
// `General tests (server 1/4)` in every merge-queue batch, and wedged master
// for ~3.7 hours (BLO-24983). Typechecking tests fully would surface ~740
// pre-existing fixture-typing errors, which is a separate project. The
// undefined-identifier class alone was 1 error, so it is gated now and the rest
// is left for later.
//
// IMPORTANT: the diagnostic pass exits nonzero on this project by design
// (those ~740 errors). Its exit code is tolerated only after a separate config
// preflight succeeds and the compiler exits normally.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(repoRoot, "server");
const defaultProject = join(serverDir, "tsconfig.typecheck.json");

// Codes for "you used a name that is not in scope". TS2304 is the plain case;
// the others are the same mistake with a suggestion or an iteration/JSX shape.
const UNDEFINED_NAME_CODES = ["TS2304", "TS2552", "TS2662", "TS2663"];
const DIAGNOSTIC_RE = /error TS\d+:/;
const SOURCE_DIAGNOSTIC_RE = /^.+\(\d+,\d+\): error TS\d+:/;
const TARGET_RE = new RegExp(`error (?:${UNDEFINED_NAME_CODES.join("|")}):`);

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function readOutput(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function requireNormalExit(result, phase) {
  if (result.error) {
    fail(`cannot run ${phase}: ${result.error.message}`);
  }
  if (result.signal || result.status === null) {
    fail(`${phase} terminated abnormally${result.signal ? ` by ${result.signal}` : ""}`);
  }
}

const args = process.argv.slice(2);
let project = defaultProject;
if (args.length > 0) {
  if (args.length !== 2 || args[0] !== "--project") {
    fail("usage: check-test-undefined-symbols.mjs [--project <tsconfig>]");
  }
  project = resolve(args[1]);
}

if (!existsSync(project)) {
  // A missing project must not read as "no undefined symbols".
  fail(`cannot run: ${project} not found`);
}

// `tsc` can emit a configuration diagnostic (for example TS5083 for a missing
// extended config) alongside ordinary source diagnostics. Validate config
// resolution independently so those failures cannot be mistaken for the
// intentionally tolerated source-type backlog below.
const configResult = spawnSync(
  "npx",
  ["tsc", "--showConfig", "--pretty", "false", "-p", project],
  { cwd: serverDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);

requireNormalExit(configResult, "tsc configuration preflight");
if (configResult.status !== 0) {
  console.error(readOutput(configResult).trim().slice(0, 4000));
  fail(`tsc configuration preflight exited ${configResult.status}`);
}

const result = spawnSync(
  "npx",
  ["tsc", "--noEmit", "--pretty", "false", "-p", project],
  { cwd: serverDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);

requireNormalExit(result, "tsc diagnostic pass");

const output = readOutput(result);
const lines = output.split("\n");
const allDiagnostics = lines.filter((line) => DIAGNOSTIC_RE.test(line));
const compilerDiagnostics = allDiagnostics.filter(
  (line) => !SOURCE_DIAGNOSTIC_RE.test(line),
);
const offenders = lines.filter((line) => TARGET_RE.test(line));

if (compilerDiagnostics.length > 0) {
  console.error(compilerDiagnostics.slice(0, 20).join("\n"));
  fail(
    `tsc emitted ${compilerDiagnostics.length} compiler/global diagnostic(s); ` +
      `the test program was not checked reliably`,
  );
}

// Distinguish "tsc ran and found nothing in our class" from "tsc never got far
// enough to report anything". Without this, a broken config or a failed install
// would silently pass the gate.
if (allDiagnostics.length === 0 && result.status !== 0) {
  console.error(output.trim().slice(0, 4000));
  fail(
    `tsc exited ${result.status} without emitting any diagnostics -- treating as "could not run", not as "clean". See output above.`,
  );
}

if (offenders.length > 0) {
  console.error(
    `FAIL ${offenders.length} test reference(s) to an identifier that does not exist:\n`,
  );
  for (const line of offenders) console.error(`  ${line.trim()}`);
  console.error(
    `\nEach is a name used without being imported or defined. At runtime this is a` +
      `\nReferenceError that fails the test on every run -- see BLO-24983.` +
      `\nFix by importing the symbol, or by correcting the name if it was renamed.`,
  );
  process.exit(1);
}

console.log(
  `ok no undefined identifiers in server tests ` +
    `(${allDiagnostics.length} other type errors present and intentionally not gated)`,
);

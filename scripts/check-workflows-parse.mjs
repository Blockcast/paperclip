// BLO-23511: fail CI when a workflow file does not parse.
//
// WHY THIS EXISTS
//
// An unparseable workflow produces ZERO jobs, so it cannot fail any gate.
// GitHub manufactures a run that completes instantly with
// `conclusion: failure` and `jobs: []`; every required check stays green
// because the broken workflow never ran. `docker-agent.yml` was unparseable
// on master for ~19h (f94d5212 -> b6ac6afd) and nothing caught it. The job
// that broke the file was the `alert-on-failure` job added to detect that
// very workflow failing, so the alert could never fire.
//
// `check-github-runner-labels.mjs` already reads these same files, but it
// scans them line by line (`stripInlineComment`, `splitInlineList`, ...). A
// line scanner reads a structurally broken file perfectly happily, so the
// repo had a workflow-scanning gate constitutionally unable to detect a
// workflow that does not parse.
//
// WHY actionlint AND NOT A YAML LIBRARY
//
// The `policy` job calls `./.github/actions/setup-pnpm` with the default
// `run_install: false`, so it never installs `node_modules` — every
// validator there is Node-builtins-only. `js-yaml` appears in package.json
// only as a version constraint (an override / peer rule), not as a
// dependency, so it does not resolve in CI even though it may resolve on a
// developer machine from a parent-directory `node_modules`. Declaring it
// would change `pnpm-lock.yaml`, which the `Block manual lockfile edits`
// step in this same job rejects for non-bot PRs.
//
// actionlint is a static binary pinned by version + SHA256 in
// `.github/actions/setup-actionlint`. It needs no lockfile change, it parses
// with a real YAML parser, and it checks strictly more than parsing
// (expression syntax, context validity, runner labels).
//
// WHY THIS FAILS CLOSED
//
// If actionlint is unavailable, this exits non-zero rather than skipping.
// A gate that quietly no-ops when its tool is missing reproduces the exact
// bug it was written to prevent: absence of failure standing in for success.
// Same reason an empty workflow set is an error rather than a pass — if the
// glob stops matching, the gate has stopped protecting anything and must say
// so instead of reporting green.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORKFLOWS_DIR = path.join(".github", "workflows");

// Both integrations shell out to tools that may or may not be installed on a
// given runner, and actionlint silently skips a missing one. That makes the
// gate's verdict depend on preinstalled runner tooling: identical source
// could pass on one runner and fail on another, and nobody could reproduce
// it locally. Pass them explicitly empty so the result is decided by the
// pinned binary alone.
export const DETERMINISM_FLAGS = ["-shellcheck=", "-pyflakes="];

export function collectWorkflowFiles(repoRoot, { readdir = readdirSync } = {}) {
  const dir = path.join(repoRoot, WORKFLOWS_DIR);
  return readdir(dir)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort()
    .map((file) => path.join(WORKFLOWS_DIR, file));
}

export function runCheck({
  repoRoot = process.cwd(),
  actionlintBin = process.env.ACTIONLINT_BIN || "actionlint",
  spawn = spawnSync,
  readdir = readdirSync,
  log = console.log,
  error = console.error,
} = {}) {
  let files;
  try {
    files = collectWorkflowFiles(repoRoot, { readdir });
  } catch (cause) {
    error(`Could not read ${WORKFLOWS_DIR}: ${cause.message}`);
    return 1;
  }

  if (files.length === 0) {
    error(
      `No workflow files found under ${WORKFLOWS_DIR}. This gate only protects files it can see, so an empty set is a failure, not a pass.`,
    );
    return 1;
  }

  const result = spawn(actionlintBin, ["-no-color", ...DETERMINISM_FLAGS, ...files], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.error) {
    error(`Could not run actionlint (${actionlintBin}): ${result.error.message}`);
    error(
      "This gate fails closed: a missing linter is reported as a failure rather than skipped, because a workflow that does not parse emits zero jobs and would otherwise pass every check.",
    );
    error(
      "In CI, `./.github/actions/setup-actionlint` installs it. Locally, install actionlint or set ACTIONLINT_BIN to its path.",
    );
    return 1;
  }

  if (result.status !== 0) {
    if (result.stdout) error(result.stdout.trimEnd());
    if (result.stderr) error(result.stderr.trimEnd());
    error(
      `\nWorkflow validation failed. A workflow that does not parse produces zero jobs, so GitHub reports an instant 0-job run and every other check stays green — that is why this must block here.`,
    );
    return 1;
  }

  log(`  ✓  Validated ${files.length} workflow files: all parse and lint clean.`);
  return 0;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  process.exit(runCheck({ repoRoot: process.cwd() }));
}

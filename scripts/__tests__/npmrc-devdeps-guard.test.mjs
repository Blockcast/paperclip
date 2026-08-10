import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readRepoFile(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function workflowJobBody(workflow, jobName) {
  const jobStart = workflow.indexOf(`  ${jobName}:`);
  assert.notEqual(jobStart, -1, `pr.yml must define a ${jobName} job.`);

  const rest = workflow.slice(jobStart + 1);
  const nextJob = rest.search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return nextJob === -1 ? workflow.slice(jobStart) : workflow.slice(jobStart, jobStart + 1 + nextJob);
}

/**
 * Extract the elements of a literal bash array assignment (`name=( a b c )`)
 * from a workflow `run:` block, in source order. Elements are unquoted and a
 * leading `$` is stripped, so `"$FOO_RESULT"` reads back as `FOO_RESULT`.
 * Returns null when the array is absent, letting callers emit a precise
 * failure rather than an opaque parse error.
 */
function parseBashArrayElements(body, arrayName) {
  const match = new RegExp(String.raw`\b${arrayName}=\(([^)]*)\)`).exec(body);
  if (match === null) return null;
  return match[1]
    .split(/\s+/)
    .filter((element) => element !== "")
    .map((element) => element.replace(/^"(.*)"$/, "$1").replace(/^\$/, ""));
}

/**
 * Parse .npmrc into key/value pairs, ignoring comments and blank lines, so a
 * setting that only appears inside an explanatory comment cannot satisfy these
 * assertions.
 */
function parseNpmrc(contents) {
  const settings = new Map();
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    settings.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return settings;
}

// BLO-19064. pnpm treats NODE_ENV=production as an implicit `--prod`: it skips
// every devDependency and still exits 0. The agent toolchain image inherits
// NODE_ENV=production from the paperclip-runtime base, so without this setting a
// plain `pnpm install` leaves no vitest/typescript/esbuild/tsx and no test,
// typecheck or build entrypoint can run.
test(".npmrc keeps devDependencies installable under NODE_ENV=production", () => {
  const settings = parseNpmrc(readRepoFile(".npmrc"));

  assert.equal(
    settings.get("production"),
    "false",
    ".npmrc must set `production=false`, otherwise NODE_ENV=production silently prunes every devDependency (BLO-19064).",
  );

  // `prod=false` looks equivalent and is not: pnpm 9.15.4 still prunes. Fail
  // loudly if someone "simplifies" the working key into the broken alias.
  assert.ok(
    !settings.has("prod") || settings.has("production"),
    "The `prod` alias does not override NODE_ENV in pnpm 9.x; keep the `production` key.",
  );
});

test("pr.yml guards the install against an ambient NODE_ENV=production", () => {
  const prWorkflow = readRepoFile(".github/workflows/pr.yml");

  assert.match(
    prWorkflow,
    /^ {2}worktree_install:$/m,
    "pr.yml must define a worktree_install job that exercises a from-scratch install.",
  );

  const jobBody = workflowJobBody(prWorkflow, "worktree_install");

  // The job is only a regression guard if it reproduces the broken environment.
  assert.match(
    jobBody,
    /env:\n\s+NODE_ENV: production/,
    "worktree_install must pin NODE_ENV: production so removing the .npmrc setting fails CI.",
  );

  assert.match(jobBody, /git worktree add --detach/);
  assert.match(jobBody, /pnpm install --frozen-lockfile/);

  // A worktree materializes files from git HEAD, so it would otherwise miss a
  // lockfile the policy job regenerated and fail on ERR_PNPM_OUTDATED_LOCKFILE.
  assert.match(jobBody, /cp pnpm-lock\.yaml/);

  for (const dependency of ["vitest", "typescript", "esbuild", "cross-env", "@playwright/test"]) {
    assert.ok(
      jobBody.includes(dependency),
      `worktree_install must assert the root devDependency ${dependency} was installed.`,
    );
  }

  assert.match(jobBody, /node_modules\/\.bin\/vitest/);
  assert.match(jobBody, /pnpm exec vitest --version/);

  const verifyBody = workflowJobBody(prWorkflow, "verify");
  assert.match(
    verifyBody,
    /needs:\s*\[[^\]]*\bworktree_install\b[^\]]*\]/,
    "The legacy required verify job must depend on worktree_install so the guard gates merges.",
  );
  assert.match(verifyBody, /WORKTREE_INSTALL_RESULT:\s*\${{\s*needs\.worktree_install\.result\s*}}/);
  // BLO-20867 replaced the flat `test "$X" = "success"` check with a lane
  // classifier so cancelled/skipped/failed lanes get distinct annotations, and
  // BLO-20789 then rewrote that classifier from an associative map to two
  // parallel indexed arrays for Bash 3 portability. The regression guard this
  // test cares about — a failed worktree_install actually fails the required
  // verify check — survives that rewrite only if worktree_install's *result*
  // is still what gets classified under worktree_install's *name*.
  //
  // The associative map paired name to result by construction. Parallel arrays
  // do not: dropping or reordering one element silently shifts every later
  // lane onto its neighbour's result, so a green build could mask a failed
  // install. Validate the pairing positionally rather than pattern-matching a
  // literal, so this guard keeps holding under a future refactor and fails on
  // the misalignment the array form newly makes possible.
  const laneNames = parseBashArrayElements(verifyBody, "lane_names");
  const laneResults = parseBashArrayElements(verifyBody, "lane_results");
  assert.ok(laneNames !== null, "verify must classify lanes via a lane_names array.");
  assert.ok(laneResults !== null, "verify must classify lanes via a lane_results array.");
  assert.equal(
    laneNames.length,
    laneResults.length,
    "lane_names and lane_results are paired by index; unequal lengths shift lanes onto the wrong result.",
  );

  assert.deepEqual(
    laneResults,
    laneNames.map((lane) => `${lane.toUpperCase()}_RESULT`),
    "Each lane_results entry must be the ${LANE}_RESULT env var of the lane_names entry at the same index.",
  );

  const worktreeInstallIndex = laneNames.indexOf("worktree_install");
  assert.notEqual(
    worktreeInstallIndex,
    -1,
    "verify's lane_names must include worktree_install so a failed install fails the required check.",
  );
  assert.equal(
    laneResults[worktreeInstallIndex],
    "WORKTREE_INSTALL_RESULT",
    "worktree_install must be classified against its own result, not a neighbouring lane's.",
  );

  // The arrays are only paired if the loop reads both at the same index.
  assert.match(
    verifyBody,
    /for i in "\$\{!lane_names\[@\]\}";\s*do\s*\n\s*lane="\$\{lane_names\[\$i\]\}"\s*\n\s*case "\$\{lane_results\[\$i\]\}" in/,
    "verify must iterate lane_names and lane_results under a shared index so names and results stay paired.",
  );
  assert.match(
    verifyBody,
    /\*\)\s*failed_lanes\+=\("\$lane"\)/,
    "verify must still treat an unrecognized/failed lane result as a failure, not silently pass.",
  );
  assert.match(
    verifyBody,
    /if \[ "\$\{#failed_lanes\[@\]\}" -gt 0 \];\s*then[\s\S]*?exit 1/,
    "verify must exit non-zero when any lane (including worktree_install) is in failed_lanes.",
  );
});

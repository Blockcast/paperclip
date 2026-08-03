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

  // BLO-21078: verify now classifies each lane's result into success /
  // cancelled / failed instead of a bare `test ... = success` chain, so a
  // GitHub-side runner kill can be told apart from a real test failure. The
  // guard's job is unchanged though: a broken from-scratch install must still
  // fail the job, whichever bucket it lands in.
  assert.match(
    verifyBody,
    /\["Worktree install"\]="\$WORKTREE_INSTALL_RESULT"/,
    "worktree_install's result must feed the verify lane-result table so a broken install is still classified.",
  );
  assert.match(
    verifyBody,
    /\*\)\s*failed_lanes\+=/,
    "A worktree_install result other than success/cancelled must be classified as failed.",
  );
  assert.match(
    verifyBody,
    /\n\s*exit 1\s*$/,
    "verify must still exit non-zero when worktree_install (or any lane) isn't success.",
  );
});

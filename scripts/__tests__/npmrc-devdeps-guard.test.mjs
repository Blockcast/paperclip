import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readRepoFile(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
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

  // The job is only a regression guard if it reproduces the broken environment.
  assert.match(
    prWorkflow,
    /worktree_install:[\s\S]*?env:\n\s+NODE_ENV: production/,
    "worktree_install must pin NODE_ENV: production so removing the .npmrc setting fails CI.",
  );

  const jobBody = prWorkflow.slice(prWorkflow.indexOf("  worktree_install:"));

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
});

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/docker.yml"), "utf8");
const script = path.join(repoRoot, ".github/scripts/guard-pending-deploy.sh");

function runGuard(workflowRuns) {
  const root = mkdtempSync(path.join(tmpdir(), "guard-pending-deploy-"));
  const binDir = path.join(root, "bin");
  const gh = path.join(binDir, "gh");
  const output = path.join(root, "output");
  const summary = path.join(root, "summary");
  mkdirSync(binDir);
  writeFileSync(output, "");
  writeFileSync(summary, "");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash\nprintf '%s' '${JSON.stringify({ workflow_runs: workflowRuns }).replaceAll("'", "'\\''")}'\n`,
  );
  chmodSync(gh, 0o755);

  const result = spawnSync("bash", [script], {
    env: {
      GH_TOKEN: "test-token",
      REPO: "Blockcast/paperclip",
      CURRENT_RUN_ID: "999",
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      PATH: `${binDir}:${process.env.PATH}`,
    },
    encoding: "utf8",
  });
  return {
    ...result,
    output: readFileSync(output, "utf8"),
    summary: readFileSync(summary, "utf8"),
  };
}

test("guard blocks a later dispatch when another run is waiting", () => {
  const result = runGuard([
    { id: 999, created_at: "2026-08-14T00:00:00Z", html_url: "self" },
    { id: 123, created_at: "2026-08-14T01:00:00Z", html_url: "https://github.com/Blockcast/paperclip/actions/runs/123" },
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "blocked=true\n");
  assert.match(result.stdout, /::warning::Deploy dispatch skipped/);
  assert.match(result.summary, /actions\/runs\/123/);
});

test("guard permits the dispatch when no other run is waiting", () => {
  const result = runGuard([{ id: 999, created_at: "2026-08-14T00:00:00Z", html_url: "self" }]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "blocked=false\n");
  assert.equal(result.summary, "");
});

test("both guard jobs checkout the script before invoking it", () => {
  const guardJobs = workflow.split("\n  deploy:\n")[0];
  assert.equal((guardJobs.match(/name: Checkout workflow scripts/g) ?? []).length, 2);
  assert.equal((guardJobs.match(/run: \.github\/scripts\/guard-pending-deploy\.sh/g) ?? []).length, 2);
});

// A job-level `permissions:` block replaces the workflow-level one outright
// instead of merging into it, so the `contents: read` at the top of docker.yml
// does not reach these jobs. Omit it and actions/checkout cannot clone, the
// job fails before the guard script runs, and `deploy` — which requires both
// guards to succeed — is skipped on every dispatch. Both jobs are gated on
// `workflow_dispatch` against master, so no PR run ever exercises them; this
// assertion is the only thing standing between that mistake and a silently
// dead deploy path.
test("both guard jobs grant contents: read so actions/checkout can clone", () => {
  for (const job of ["guard-pending-deploy", "guard-pending-deploy-final"]) {
    const block = workflow.split(`\n  ${job}:\n`)[1]?.split("\n    outputs:")[0];
    assert.ok(block, `${job}: job block not found`);
    assert.match(block, /^      contents: read$/m, `${job}: must grant contents: read`);
    assert.match(block, /^      actions: read$/m, `${job}: must grant actions: read`);
  }
});

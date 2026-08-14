import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { APP_NOREPLY_EMAIL, findAttributionOffenses, findLocalRangeOffenses } from "./check-commit-author-attribution.mjs";

test("a rebased grandfathered commit keeps its exemption by patch-id and author", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "attribution-rebase-"));
  try {
    const git = (args, env) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env } });
    git(["init", "-q", "-b", "main"]); git(["config", "user.name", "Test"]); git(["config", "user.email", "base@example.com"]);
    git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base", "-q"]); const base = git(["rev-parse", "HEAD"]).trim();
    git(["config", "user.email", APP_NOREPLY_EMAIL]); git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "grandfathered", "-q"], { GIT_AUTHOR_DATE: "2026-08-05T00:00:00Z", GIT_COMMITTER_DATE: "2026-08-05T00:00:00Z" });
    const pinned = git(["rev-parse", "HEAD"]).trim(); git(["checkout", "-q", "main"]); git(["config", "user.email", "base@example.com"]); git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base moved", "-q"]); git(["checkout", "-q", "-b", "feature", pinned]); git(["-c", "commit.gpgsign=false", "rebase", "main", "-q"]);
    const rebased = git(["rev-parse", "HEAD"]).trim(); assert.notEqual(rebased, pinned);
    const patch = execFileSync("git", ["show", "--format=", rebased], { cwd: repoRoot, encoding: "utf8" }); const patchId = execFileSync("git", ["patch-id", "--stable"], { cwd: repoRoot, input: patch, encoding: "utf8" }).trim().split(/\s+/)[0];
    assert.deepEqual(findLocalRangeOffenses({ repoRoot, base, head: rebased, allowlist: new Set([`${patchId}|${APP_NOREPLY_EMAIL}`]) }), []);
  } finally { rmSync(repoRoot, { recursive: true, force: true }); }
});

test("allowlist matching remains fail-closed for unregistered patch content", () => {
  assert.equal(findAttributionOffenses([{ patchId: "not-registered", authorEmail: APP_NOREPLY_EMAIL }], { allowlist: new Set() }).length, 1);
});

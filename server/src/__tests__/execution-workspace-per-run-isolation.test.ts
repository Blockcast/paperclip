import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRunScopeToBranchName,
  realizeExecutionWorkspace,
} from "../services/workspace-runtime.ts";
import { parseIssueExecutionWorkspaceSettings, buildExecutionWorkspaceAdapterConfig } from "../services/execution-workspace-policy.ts";
import { issueExecutionWorkspaceSettingsSchema } from "@paperclipai/shared";

/**
 * BLO-19063: two live runs of one agent must never share a working tree.
 *
 * Worktrees are keyed by branch name (`worktreePath = join(parentDir, branch)`),
 * and the branch is derived from the issue — so before this change two runs of
 * the same issue resolved to the same `cwd`, and under the fleet default
 * (`shared_workspace` + `project_primary`) *every* run of *every* issue in a
 * project did. `runScope: "per_run"` makes the branch, and therefore the tree,
 * run-unique.
 */

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createTempRepo(defaultBranch = "master") {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-per-run-repo-"));
  tempRoots.push(repoRoot);
  await runGit(repoRoot, ["init"]);
  // Hermetic: neutralize any inherited global core.hooksPath (see the same
  // guard in workspace-runtime.test.ts).
  await runGit(repoRoot, ["config", "core.hooksPath", path.join(repoRoot, ".git", "no-hooks")]);
  await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["checkout", "-B", defaultBranch]);
  return repoRoot;
}

/** Provision one run's workspace, exactly as heartbeat.ts does. */
function realizeRun(input: {
  repoRoot: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  heartbeatRunId: string | null;
  runScope?: "per_issue" | "per_run";
}) {
  return realizeExecutionWorkspace({
    base: {
      baseCwd: input.repoRoot,
      source: "project_primary",
      projectId: "project-1",
      workspaceId: "workspace-1",
      repoUrl: null,
      repoRef: "master",
    },
    config: {
      workspaceStrategy: {
        type: "git_worktree",
        branchTemplate: "{{issue.identifier}}-{{slug}}",
        ...(input.runScope ? { runScope: input.runScope } : {}),
      },
    },
    issue: {
      id: input.issueId,
      identifier: input.issueIdentifier,
      title: input.issueTitle,
    },
    // Same agent for both runs — the concurrency this issue is about.
    agent: { id: "agent-1", name: "CTO", companyId: "company-1" },
    heartbeatRunId: input.heartbeatRunId,
  });
}

/** True when `parent` contains `child` (or they are the same path). */
function isAncestorPath(parent: string, child: string) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

describe("per-run execution workspace isolation (BLO-19063)", () => {
  it("gives two concurrent runs on different issues non-overlapping cwds", async () => {
    const repoRoot = await createTempRepo();

    const [runA, runB] = await Promise.all([
      realizeRun({
        repoRoot,
        issueId: "issue-a",
        issueIdentifier: "BLO-19063",
        issueTitle: "Per-run execution workspaces",
        heartbeatRunId: "11111111-1111-4111-8111-111111111111",
        runScope: "per_run",
      }),
      realizeRun({
        repoRoot,
        issueId: "issue-b",
        issueIdentifier: "BLO-18953",
        issueTitle: "Ally review requests coalescing",
        heartbeatRunId: "22222222-2222-4222-8222-222222222222",
        runScope: "per_run",
      }),
    ]);

    // AC1: the two runs never resolve to the same cwd...
    expect(runA.cwd).not.toBe(runB.cwd);
    // ...and neither tree is nested inside the other, so a `rm -rf` or
    // `git checkout` in one cannot reach the other.
    expect(isAncestorPath(runA.cwd, runB.cwd)).toBe(false);
    expect(isAncestorPath(runB.cwd, runA.cwd)).toBe(false);
    expect(runA.branchName).not.toBe(runB.branchName);
  });

  it("gives two concurrent runs on the SAME issue non-overlapping cwds", async () => {
    // This is the vector BLO-19001 does not close: same issue by design, so
    // branch-per-issue keying hands both runs one tree.
    const repoRoot = await createTempRepo();

    const first = await realizeRun({
      repoRoot,
      issueId: "issue-a",
      issueIdentifier: "BLO-19063",
      issueTitle: "Per-run execution workspaces",
      heartbeatRunId: "11111111-1111-4111-8111-111111111111",
      runScope: "per_run",
    });
    const second = await realizeRun({
      repoRoot,
      issueId: "issue-a",
      issueIdentifier: "BLO-19063",
      issueTitle: "Per-run execution workspaces",
      heartbeatRunId: "33333333-3333-4333-8333-333333333333",
      runScope: "per_run",
    });

    expect(first.cwd).not.toBe(second.cwd);
    expect(isAncestorPath(first.cwd, second.cwd)).toBe(false);
    expect(isAncestorPath(second.cwd, first.cwd)).toBe(false);

    // Both are real, independently checked-out git worktrees. This is the part
    // a path-only scheme fails: git refuses to check one branch out twice, so
    // per-run trees require per-run *branches*.
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repoRoot });
    expect(stdout).toContain(first.cwd);
    expect(stdout).toContain(second.cwd);

    // AC2: uncommitted state in one tree is invisible to the other.
    await fs.writeFile(path.join(first.cwd, "scratch.txt"), "run-1 only\n", "utf8");
    await expect(fs.access(path.join(second.cwd, "scratch.txt"))).rejects.toThrow();
  });

  it("keeps the issue identifier in the branch name so PR ref-linking survives", async () => {
    // BLO-9117 guarantee: the github-webhook forward-capture keys on the
    // uppercase BLO- ref in the branch name.
    const repoRoot = await createTempRepo();
    const run = await realizeRun({
      repoRoot,
      issueId: "issue-a",
      issueIdentifier: "BLO-19063",
      issueTitle: "Per-run execution workspaces",
      heartbeatRunId: "11111111-1111-4111-8111-111111111111",
      runScope: "per_run",
    });
    expect(run.branchName).toContain("BLO-19063");
    expect(/BLO-\d+/.exec(run.branchName ?? "")?.[0]).toBe("BLO-19063");
  });

  it("defaults to per_issue, so existing shared behaviour is unchanged", async () => {
    // AC4: not a forced fleet-wide migration. Omitting runScope must reuse one
    // tree across runs exactly as before.
    const repoRoot = await createTempRepo();
    const first = await realizeRun({
      repoRoot,
      issueId: "issue-a",
      issueIdentifier: "BLO-19063",
      issueTitle: "Per-run execution workspaces",
      heartbeatRunId: "11111111-1111-4111-8111-111111111111",
    });
    const second = await realizeRun({
      repoRoot,
      issueId: "issue-a",
      issueIdentifier: "BLO-19063",
      issueTitle: "Per-run execution workspaces",
      heartbeatRunId: "33333333-3333-4333-8333-333333333333",
    });
    expect(second.cwd).toBe(first.cwd);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });
});

describe("applyRunScopeToBranchName", () => {
  const runId = "11111111-2222-4333-8444-555555555555";

  it("is a no-op for per_issue and for a missing scope", () => {
    expect(applyRunScopeToBranchName("BLO-1-x", "per_issue", runId)).toBe("BLO-1-x");
    expect(applyRunScopeToBranchName("BLO-1-x", null, runId)).toBe("BLO-1-x");
    expect(applyRunScopeToBranchName("BLO-1-x", undefined, runId)).toBe("BLO-1-x");
  });

  it("falls back to the issue-scoped name when no run id is available", () => {
    // Inventing a token here would strand a tree nothing can resolve again.
    expect(applyRunScopeToBranchName("BLO-1-x", "per_run", null)).toBe("BLO-1-x");
    expect(applyRunScopeToBranchName("BLO-1-x", "per_run", "")).toBe("BLO-1-x");
  });

  it("appends a stable, distinct token per run", () => {
    const a = applyRunScopeToBranchName("BLO-1-x", "per_run", runId);
    const b = applyRunScopeToBranchName("BLO-1-x", "per_run", runId);
    const c = applyRunScopeToBranchName("BLO-1-x", "per_run", "99999999-2222-4333-8444-555555555555");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^BLO-1-x-r[0-9a-f]{8}$/);
  });

  it("clamps to git's usable branch length even for a long base name", () => {
    const long = `BLO-19063-${"a".repeat(400)}`;
    const scoped = applyRunScopeToBranchName(long, "per_run", runId);
    expect(scoped.length).toBeLessThanOrEqual(120);
    // The run token must survive the clamp — truncating it away would collapse
    // two runs back onto one tree, which is the whole bug.
    expect(scoped).toMatch(/-r[0-9a-f]{8}$/);
  });
});

describe("runScope is reachable by configuration (AC3)", () => {
  it("survives the issue-settings validator, which is strict()", () => {
    const parsed = issueExecutionWorkspaceSettingsSchema.parse({
      mode: "isolated_workspace",
      workspaceStrategy: { type: "git_worktree", runScope: "per_run" },
    });
    expect(parsed.workspaceStrategy?.runScope).toBe("per_run");
  });

  it("rejects an unknown scope rather than silently persisting it", () => {
    expect(() =>
      issueExecutionWorkspaceSettingsSchema.parse({
        workspaceStrategy: { type: "git_worktree", runScope: "per_galaxy" },
      }),
    ).toThrow();
  });

  it("round-trips through the policy parser", () => {
    const settings = parseIssueExecutionWorkspaceSettings({
      mode: "isolated_workspace",
      workspaceStrategy: { type: "git_worktree", runScope: "per_run" },
    });
    expect(settings?.workspaceStrategy?.runScope).toBe("per_run");
  });

  it("drops an unrecognized scope in the policy parser instead of passing it through", () => {
    const settings = parseIssueExecutionWorkspaceSettings({
      workspaceStrategy: { type: "git_worktree", runScope: "nonsense" },
    });
    expect(settings?.workspaceStrategy?.runScope).toBeUndefined();
  });

  it("survives issue settings -> adapter config, which is what realize actually reads", () => {
    // Closes the gap between "the validator accepts it" and "the runtime sees
    // it": realizeExecutionWorkspace reads config.workspaceStrategy, so a scope
    // that parsed cleanly but was dropped on the way into the adapter config
    // would be silently inert.
    const issueSettings = parseIssueExecutionWorkspaceSettings({
      mode: "isolated_workspace",
      workspaceStrategy: { type: "git_worktree", runScope: "per_run" },
    });
    const config = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {},
      projectPolicy: null,
      issueSettings,
      mode: "isolated_workspace",
      legacyUseProjectWorkspace: null,
    });
    expect((config.workspaceStrategy as Record<string, unknown>).runScope).toBe("per_run");
  });
});

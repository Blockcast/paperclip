import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupExecutionWorkspaceArtifacts, ensurePersistedExecutionWorkspaceAvailable } from "../services/workspace-runtime.ts";
import {
  authorizeOwnedGitWorktreeCleanup,
  classifyWorktreeOwnership,
  formatWorktreeOwnerLockReason,
  lockGitWorktreeForOwner,
  parseGitWorktreeRegistrations,
  parseWorktreeOwnerLockReason,
  pruneOwnStaleGitWorktree,
} from "../services/git-worktree-ownership.ts";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

const asyncGit = async (args: string[], cwd: string) => git(args, cwd);
const normalizePath = async (value: string) => {
  try {
    return path.resolve(fs.realpathSync(value));
  } catch {
    return path.resolve(value);
  }
};

function createRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-ownership-"));
  tempRoots.add(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(["init", "-q", "--initial-branch=main", "."], repo);
  git(["config", "user.email", "runtime@paperclip.test"], repo);
  git(["config", "user.name", "Paperclip Runtime"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "seed\n", "utf8");
  git(["add", "."], repo);
  git(["commit", "-qm", "seed"], repo);
  return repo;
}

/** Registers a worktree the way the runtime does: `worktree add` then an ownership lock. */
async function createOwnedWorktree(input: {
  repo: string;
  worktreePath: string;
  branchName: string;
  executionWorkspaceId: string;
  runId: string;
}) {
  git(["worktree", "add", "-q", "-b", input.branchName, input.worktreePath, "main"], input.repo);
  const result = await lockGitWorktreeForOwner({
    git: asyncGit,
    repoRoot: input.repo,
    worktreePath: input.worktreePath,
    normalizePath,
    token: {
      branchName: input.branchName,
      executionWorkspaceId: input.executionWorkspaceId,
      runId: input.runId,
    },
  });
  expect(result.locked).toBe(true);
}

function registeredWorktreePaths(repo: string): string[] {
  return parseGitWorktreeRegistrations(git(["worktree", "list", "--porcelain"], repo))
    .map((entry) => path.resolve(entry.worktree));
}

/**
 * The reported failure mode is a *live* worktree whose directory git cannot
 * read from the pruning process (a mount that is not visible, a tmpfs that is
 * not attached). Renaming the directory away reproduces exactly the state git
 * observes — `prunable: gitdir file points to non-existent location` — while
 * the run's edits are still on disk under the moved path.
 */
async function withWorktreeUnreadable<T>(worktreePath: string, fn: () => Promise<T> | T): Promise<T> {
  const hidden = `${worktreePath}.unreadable`;
  fs.renameSync(worktreePath, hidden);
  try {
    // Must await inside the try: returning the promise would restore the
    // directory before the work under test ever observes it missing.
    return await fn();
  } finally {
    fs.renameSync(hidden, worktreePath);
  }
}

describe("concurrent runs sharing one worktree registry (BLO-19607)", () => {
  /**
   * The reported failure: one run repairs its own missing worktree while a
   * second run is live, and the repair takes the second run's registration with
   * it. This drives the real restore path, which is where the repo-global
   * `git worktree prune` used to run.
   *
   * Both worktrees are registered *without* ownership locks here, exactly as a
   * pre-fix (or hand-made) worktree is. That isolates the guarantee to the one
   * thing under test — the repair no longer issues a repo-global prune — rather
   * than letting the lock do the work.
   */
  it("restores its own worktree without collecting a concurrent run's registration", async () => {
    const repo = createRepo();
    const runAPath = path.join(path.dirname(repo), "run-a");
    const runBPath = path.join(path.dirname(repo), "run-b");

    git(["worktree", "add", "-q", "-b", "blo-19607-run-a", runAPath, "main"], repo);
    git(["worktree", "add", "-q", "-b", "blo-19607-run-b", runBPath, "main"], repo);

    // Run A holds validated-but-uncommitted work: the state that was lost.
    fs.writeFileSync(path.join(runAPath, "evidence.sql"), "select 1;\n", "utf8");

    // Run B's worktree directory is gone, so run B takes the repair path.
    fs.rmSync(runBPath, { recursive: true, force: true });

    const realized = await withWorktreeUnreadable(runAPath, async () =>
      await ensurePersistedExecutionWorkspaceAvailable({
        db: null,
        base: {
          baseCwd: repo,
          source: "task_session",
          projectId: null,
          workspaceId: null,
          repoUrl: null,
          repoRef: "main",
        },
        workspace: {
          id: "workspace-b",
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          cwd: runBPath,
          providerRef: runBPath,
          projectId: null,
          projectWorkspaceId: null,
          repoUrl: null,
          baseRef: "main",
          branchName: "blo-19607-run-b",
        },
        issue: null,
        agent: { id: "agent-b", name: "Runner B", companyId: "company-1" },
        heartbeatRunId: "run-b-repair",
      }));

    // Run B repaired itself.
    expect(realized?.worktreePath).toBe(runBPath);
    expect(registeredWorktreePaths(repo)).toContain(path.resolve(runBPath));

    // Run A survived: registration, edits, and the ability to commit them.
    expect(registeredWorktreePaths(repo)).toContain(path.resolve(runAPath));
    expect(fs.readFileSync(path.join(runAPath, "evidence.sql"), "utf8")).toBe("select 1;\n");

    git(["add", "."], runAPath);
    git(["commit", "-qm", "run A commits after a concurrent repair"], runAPath);
    expect(git(["log", "-1", "--pretty=%s"], runAPath)).toBe("run A commits after a concurrent repair");
  });

  it("keeps a live run's registration and uncommitted edits when a concurrent run tears its own workspace down", async () => {
    const repo = createRepo();
    const runAPath = path.join(path.dirname(repo), "run-a");
    const runBPath = path.join(path.dirname(repo), "run-b");

    await createOwnedWorktree({
      repo,
      worktreePath: runAPath,
      branchName: "blo-19607-run-a",
      executionWorkspaceId: "workspace-a",
      runId: "run-a",
    });
    await createOwnedWorktree({
      repo,
      worktreePath: runBPath,
      branchName: "blo-19607-run-b",
      executionWorkspaceId: "workspace-b",
      runId: "run-b",
    });

    // Run A has validated-but-uncommitted work, the state that was being lost.
    fs.writeFileSync(path.join(runAPath, "evidence.sql"), "select 1;\n", "utf8");
    fs.writeFileSync(path.join(runAPath, "README.md"), "edited by run A\n", "utf8");

    // Run B tears its own workspace down while run A's directory is unreadable.
    const result = await withWorktreeUnreadable(runAPath, async () =>
      await cleanupExecutionWorkspaceArtifacts({
        workspace: {
          id: "workspace-b",
          cwd: runBPath,
          providerType: "git_worktree",
          providerRef: runBPath,
          branchName: "blo-19607-run-b",
          repoUrl: null,
          baseRef: "main",
          projectId: null,
          projectWorkspaceId: null,
          sourceIssueId: null,
          metadata: { createdByRuntime: true },
        },
        projectWorkspace: { cwd: repo, cleanupCommand: null },
      }));

    // Run B's own teardown still succeeds.
    expect(registeredWorktreePaths(repo)).not.toContain(path.resolve(runBPath));
    expect(result.warnings.filter((warning) => warning.includes("run-a"))).toEqual([]);

    // Run A survived: registration, edits, and the ability to commit them.
    expect(registeredWorktreePaths(repo)).toContain(path.resolve(runAPath));
    expect(fs.readFileSync(path.join(runAPath, "evidence.sql"), "utf8")).toBe("select 1;\n");

    git(["add", "."], runAPath);
    git(["commit", "-qm", "run A commits after concurrent cleanup"], runAPath);
    expect(git(["log", "-1", "--pretty=%s"], runAPath)).toBe("run A commits after concurrent cleanup");
  });

  it("demonstrates the regression: a repo-global prune drops the concurrent run's registration", async () => {
    const repo = createRepo();
    const runAPath = path.join(path.dirname(repo), "run-a");
    // Registered the pre-fix way — no ownership lock.
    git(["worktree", "add", "-q", "-b", "blo-19607-run-a", runAPath, "main"], repo);

    await withWorktreeUnreadable(runAPath, () => {
      git(["worktree", "prune"], repo);
    });

    expect(registeredWorktreePaths(repo)).not.toContain(path.resolve(runAPath));
  });

  it("leaves a concurrent run registered when a run clears its own stale entry", async () => {
    const repo = createRepo();
    const runAPath = path.join(path.dirname(repo), "run-a");
    const runBPath = path.join(path.dirname(repo), "run-b");

    await createOwnedWorktree({
      repo,
      worktreePath: runAPath,
      branchName: "blo-19607-run-a",
      executionWorkspaceId: "workspace-a",
      runId: "run-a",
    });
    await createOwnedWorktree({
      repo,
      worktreePath: runBPath,
      branchName: "blo-19607-run-b",
      executionWorkspaceId: "workspace-b",
      runId: "run-b",
    });

    // Run B's own worktree really is gone; run A's is merely unreadable.
    fs.rmSync(runBPath, { recursive: true, force: true });

    const outcome = await withWorktreeUnreadable(runAPath, async () =>
      await pruneOwnStaleGitWorktree({
        git: asyncGit,
        repoRoot: repo,
        worktreePath: runBPath,
        token: { branchName: "blo-19607-run-b", executionWorkspaceId: "workspace-b", runId: "run-b-2" },
        normalizePath,
      }));

    expect(outcome.removed).toBe(true);
    expect(registeredWorktreePaths(repo)).not.toContain(path.resolve(runBPath));
    expect(registeredWorktreePaths(repo)).toContain(path.resolve(runAPath));
  });

  it("refuses to clean up a worktree owned by another run and reports why", async () => {
    const repo = createRepo();
    const runAPath = path.join(path.dirname(repo), "run-a");
    await createOwnedWorktree({
      repo,
      worktreePath: runAPath,
      branchName: "blo-19607-run-a",
      executionWorkspaceId: "workspace-a",
      runId: "run-a",
    });

    const authorization = await authorizeOwnedGitWorktreeCleanup({
      git: asyncGit,
      repoRoot: repo,
      worktreePath: runAPath,
      token: { branchName: "blo-19607-run-b", executionWorkspaceId: "workspace-b", runId: "run-b" },
      normalizePath,
    });

    expect(authorization.authorized).toBe(false);
    expect(authorization.warnings.join(" ")).toContain("blo-19607-run-a");
    // The refusal is non-destructive: the lock is still held by its owner.
    const entry = parseGitWorktreeRegistrations(git(["worktree", "list", "--porcelain"], repo))
      .find((candidate) => path.resolve(candidate.worktree) === path.resolve(runAPath));
    expect(entry?.locked).toBe(true);
  });

  it("does not report a claim when the worktree is already locked by another owner", async () => {
    const repo = createRepo();
    const runAPath = path.join(path.dirname(repo), "run-a");
    await createOwnedWorktree({
      repo,
      worktreePath: runAPath,
      branchName: "blo-19607-run-a",
      executionWorkspaceId: "workspace-a",
      runId: "run-a",
    });

    // git refuses to re-lock, and the existing lock is not ours.
    const result = await lockGitWorktreeForOwner({
      git: asyncGit,
      repoRoot: repo,
      worktreePath: runAPath,
      normalizePath,
      token: { branchName: "blo-19607-run-b", executionWorkspaceId: "workspace-b", runId: "run-b" },
    });

    expect(result.locked).toBe(false);
    expect(result.warnings.join(" ")).toContain("already locked by another owner");
  });

  it("treats a re-lock of our own worktree as a held claim", async () => {
    const repo = createRepo();
    const runAPath = path.join(path.dirname(repo), "run-a");
    await createOwnedWorktree({
      repo,
      worktreePath: runAPath,
      branchName: "blo-19607-run-a",
      executionWorkspaceId: "workspace-a",
      runId: "run-a",
    });

    // A later run of the same workspace re-stamps its own branch.
    const result = await lockGitWorktreeForOwner({
      git: asyncGit,
      repoRoot: repo,
      worktreePath: runAPath,
      normalizePath,
      token: { branchName: "blo-19607-run-a", executionWorkspaceId: "workspace-a", runId: "run-a-2" },
    });

    expect(result).toEqual({ locked: true, warnings: [] });
  });

  it("still tears down a worktree created before ownership stamping", async () => {    const repo = createRepo();
    const legacyPath = path.join(path.dirname(repo), "legacy");
    // Pre-fix registration: no lock at all.
    git(["worktree", "add", "-q", "-b", "legacy-branch", legacyPath, "main"], repo);

    const authorization = await authorizeOwnedGitWorktreeCleanup({
      git: asyncGit,
      repoRoot: repo,
      worktreePath: legacyPath,
      token: { branchName: "legacy-branch", executionWorkspaceId: "workspace-legacy", runId: null },
      normalizePath,
    });

    expect(authorization).toEqual({ authorized: true, warnings: [] });
  });
});

describe("worktree ownership tokens", () => {
  it("round-trips through a git lock reason", () => {
    const token = { branchName: "blo-19607-fix", executionWorkspaceId: "ws-1", runId: "run-1" };
    expect(parseWorktreeOwnerLockReason(formatWorktreeOwnerLockReason(token))).toEqual(token);
  });

  it("keeps the lock reason on a single line so porcelain stays parseable", () => {
    const reason = formatWorktreeOwnerLockReason({
      branchName: "branch\nwith\nnewlines",
      executionWorkspaceId: "ws-1",
      runId: null,
    });
    expect(reason).not.toContain("\n");
    expect(parseWorktreeOwnerLockReason(reason)?.runId).toBeNull();
  });

  it("does not claim ownership of a foreign lock", () => {
    expect(parseWorktreeOwnerLockReason("mounted on a usb stick")).toBeNull();
  });

  it("parses locked and prunable attributes from porcelain output", () => {
    const registrations = parseGitWorktreeRegistrations(
      [
        "worktree /repo",
        "branch refs/heads/main",
        "",
        "worktree /runs/a",
        "branch refs/heads/run-a",
        "locked paperclip-owned branch=run-a workspace=ws-a run=r1",
        "",
        "worktree /runs/b",
        "branch refs/heads/run-b",
        "prunable gitdir file points to non-existent location",
        "",
      ].join("\n"),
    );

    expect(registrations).toHaveLength(3);
    expect(registrations[1]).toMatchObject({
      worktree: "/runs/a",
      locked: true,
      lockReason: "paperclip-owned branch=run-a workspace=ws-a run=r1",
      prunable: false,
    });
    expect(registrations[2]).toMatchObject({
      worktree: "/runs/b",
      locked: false,
      prunable: true,
      prunableReason: "gitdir file points to non-existent location",
    });
  });

  it("classifies ownership so only a provable claim authorizes removal", () => {
    const expected = { branchName: "run-a", executionWorkspaceId: "ws-a", runId: "r2" };
    const owned = { locked: true, lockReason: "paperclip-owned branch=run-a workspace=ws-a run=r1", branch: null };
    const other = { locked: true, lockReason: "paperclip-owned branch=run-b workspace=ws-b run=r9", branch: null };

    // A later run of the same workspace still owns its own branch.
    expect(classifyWorktreeOwnership(owned, expected).kind).toBe("owned");
    expect(classifyWorktreeOwnership(other, expected).kind).toBe("owned_by_other");
    expect(classifyWorktreeOwnership({ locked: true, lockReason: "held by hand", branch: null }, expected).kind)
      .toBe("foreign_lock");
    // Unlocked and on someone else's branch: not provably ours.
    expect(classifyWorktreeOwnership({ locked: false, lockReason: null, branch: "refs/heads/other" }, expected).kind)
      .toBe("unowned");
    // Unlocked but on our branch: a pre-ownership worktree we may adopt.
    expect(classifyWorktreeOwnership({ locked: false, lockReason: null, branch: "refs/heads/run-a" }, expected).kind)
      .toBe("owned");
    // No branch identity at all: nothing can be asserted.
    expect(classifyWorktreeOwnership(owned, { ...expected, branchName: "" }).kind).toBe("indeterminate");
  });
});

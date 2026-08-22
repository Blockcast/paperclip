import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  collectDueExecutionWorkspaces,
  finalizeRunScopedExecutionWorkspace,
} from "../services/execution-workspace-cleanup.ts";
import { realizeExecutionWorkspace } from "../services/workspace-runtime.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const execFileAsync = promisify(execFile);
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const tempRoots: string[] = [];

async function runGit(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd });
}

async function createRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-repo-"));
  tempRoots.push(repoRoot);
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "core.hooksPath", path.join(repoRoot, ".git", "no-hooks")]);
  await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["branch", "-M", "main"]);
  return repoRoot;
}

describeEmbeddedPostgres("run-scoped execution workspace cleanup", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-cleanup-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    while (tempRoots.length > 0) {
      await fs.rm(tempRoots.pop()!, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function provisionPersistedWorkspace() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const agentId = randomUUID();
    const runId = "11111111-1111-4111-8111-111111111111";
    const repoRoot = await createRepo();
    await db.insert(companies).values({
      id: companyId,
      name: "Cleanup Co",
      status: "active",
      issuePrefix: "CLN",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Cleanup project" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cleaner",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "primary",
      cwd: repoRoot,
      isPrimary: true,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "test",
      status: "succeeded",
    });
    const realized = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId,
        workspaceId: projectWorkspaceId,
        repoUrl: null,
        repoRef: "main",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "CLN-1-cleanup",
          runScope: "per_run",
        },
      },
      issue: { id: randomUUID(), identifier: "CLN-1", title: "Cleanup" },
      agent: { id: agentId, name: "Cleaner", companyId },
      executionWorkspaceId,
      heartbeatRunId: runId,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: realized.branchName!,
      status: "active",
      cwd: realized.cwd,
      baseRef: realized.repoRef,
      branchName: realized.branchName,
      providerType: "git_worktree",
      providerRef: realized.worktreePath,
      metadata: { createdByRuntime: true, cleanupOwnerRunId: runId },
    });
    return { companyId, projectId, projectWorkspaceId, executionWorkspaceId, runId, repoRoot, realized };
  }

  it("removes and deregisters a clean per-run worktree after normal finalization", async () => {
    const fixture = await provisionPersistedWorkspace();
    const futureWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: futureWorkspaceId,
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      projectWorkspaceId: fixture.projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "future-cleanup",
      status: "cleanup_pending",
      cwd: path.join(fixture.repoRoot, "future-cleanup"),
      providerType: "git_worktree",
      cleanupEligibleAt: new Date(Date.now() + 60_000),
    });
    const result = await finalizeRunScopedExecutionWorkspace({
      db,
      companyId: fixture.companyId,
      executionWorkspaceId: fixture.executionWorkspaceId,
      runId: fixture.runId,
    });

    expect(result).toMatchObject({ selected: 1, claimed: 1, cleaned: 1, failed: 0 });
    await expect(fs.access(fixture.realized.cwd)).rejects.toThrow();
    const { stdout } = await runGit(fixture.repoRoot, ["worktree", "list", "--porcelain"]);
    expect(stdout).not.toContain(fixture.realized.cwd);
    const row = await db.select().from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, fixture.executionWorkspaceId))
      .then((rows) => rows[0]);
    expect(row).toMatchObject({ status: "archived", cleanupEligibleAt: null, cleanupReason: null });
    const futureRow = await db.select().from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, futureWorkspaceId))
      .then((rows) => rows[0]);
    expect(futureRow).toMatchObject({ status: "cleanup_pending" });
    expect(futureRow?.cleanupEligibleAt).not.toBeNull();
  });

  it("refuses to remove a per-run worktree with uncommitted changes", async () => {
    const fixture = await provisionPersistedWorkspace();
    await fs.writeFile(path.join(fixture.realized.cwd, "scratch.txt"), "do not lose\n", "utf8");

    const result = await finalizeRunScopedExecutionWorkspace({
      db,
      companyId: fixture.companyId,
      executionWorkspaceId: fixture.executionWorkspaceId,
      runId: fixture.runId,
    });

    expect(result).toMatchObject({ selected: 1, claimed: 1, cleaned: 0, failed: 1 });
    await expect(fs.access(path.join(fixture.realized.cwd, "scratch.txt"))).resolves.toBeUndefined();
    const row = await db.select().from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, fixture.executionWorkspaceId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("cleanup_failed");
    expect(row?.cleanupReason).toContain("uncommitted changes");
  });

  it("recovers a terminal run cleanup obligation after the finalizer is lost", async () => {
    const fixture = await provisionPersistedWorkspace();

    const result = await collectDueExecutionWorkspaces({ db, companyId: fixture.companyId });

    expect(result).toMatchObject({ selected: 1, claimed: 1, cleaned: 1, failed: 0 });
    await expect(fs.access(fixture.realized.cwd)).rejects.toThrow();
    const row = await db.select().from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, fixture.executionWorkspaceId))
      .then((rows) => rows[0]);
    expect(row).toMatchObject({ status: "archived", cleanupEligibleAt: null });
  });

  it("ignores a malformed cleanupOwnerRunId stamp instead of aborting the sweep", async () => {
    const fixture = await provisionPersistedWorkspace();
    await db
      .update(executionWorkspaces)
      .set({
        metadata: { createdByRuntime: true, cleanupOwnerRunId: "not-a-uuid" },
      })
      .where(eq(executionWorkspaces.id, fixture.executionWorkspaceId));

    // Comparing the extracted stamp as uuid is what keeps the owner-run lookup on the
    // primary key index, but it means a non-uuid stamp would raise
    // `invalid input syntax for type uuid` and take the whole sweep down with it.
    const result = await collectDueExecutionWorkspaces({ db, companyId: fixture.companyId });

    expect(result).toMatchObject({ selected: 0, claimed: 0, cleaned: 0, failed: 0 });
    // Positive control: the tree really was realized, so `selected: 0` reflects the
    // skipped stamp rather than a workspace that never existed.
    await expect(fs.access(fixture.realized.cwd)).resolves.toBeUndefined();
    const row = await db.select().from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, fixture.executionWorkspaceId))
      .then((rows) => rows[0]);
    expect(row).toMatchObject({ status: "active", cleanupEligibleAt: null });
  });

  it("holds the cleanup claim through teardown so an expired timestamp cannot run concurrently", async () => {
    const fixture = await provisionPersistedWorkspace();
    const receiptPath = path.join(fixture.repoRoot, "cleanup-receipt.txt");
    await db
      .update(projectWorkspaces)
      .set({ cleanupCommand: `sleep 1; printf cleanup >> ${JSON.stringify(receiptPath)}` })
      .where(eq(projectWorkspaces.id, fixture.projectWorkspaceId));
    await db
      .update(executionWorkspaces)
      .set({ status: "cleanup_pending", cleanupEligibleAt: new Date() })
      .where(eq(executionWorkspaces.id, fixture.executionWorkspaceId));

    const firstSweep = collectDueExecutionWorkspaces({
      db,
      companyId: fixture.companyId,
      claimDurationMs: 200,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const secondSweep = await collectDueExecutionWorkspaces({
      db,
      companyId: fixture.companyId,
      claimDurationMs: 200,
    });

    expect(secondSweep).toMatchObject({ selected: 1, claimed: 0, cleaned: 0, failed: 0 });
    await expect(firstSweep).resolves.toMatchObject({ selected: 1, claimed: 1, cleaned: 1, failed: 0 });
    await expect(fs.readFile(receiptPath, "utf8")).resolves.toBe("cleanup");
  });
});

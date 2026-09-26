import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, executionWorkspaces, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { classifyRemovalProof, executionWorkspaceCleanupService } from "../services/execution-workspace-cleanup.ts";
import {
  inspectWorktreeReclaimSafety,
  RECLAIM_FS_OUTSTANDING_LIMIT,
  reclaimFsOutstandingCount,
  resolvePathForWorktreeComparison,
} from "../services/workspace-runtime.ts";
import { findGitWorktreeRegistration, lockGitWorktreeForOwner } from "../services/git-worktree-ownership.ts";

/**
 * BLO-22984. A collector fails silently exactly like a detector: one that never
 * runs is indistinguishable from one that runs and finds nothing to collect.
 * That is how `pruneOwnStaleGitWorktree` was believed to reclaim disk for weeks
 * while reclaiming zero bytes, so these tests use real git repositories and a
 * real database rather than asserting on mock calls — every "removed" assertion
 * below is a stat of the filesystem and a read of `git worktree list`.
 */

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

/** Origin + clone, so `git branch -r --contains` has something real to answer. */
function createRepoWithRemote(): { repo: string; origin: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-ws-collector-"));
  tempRoots.add(root);
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  git(["init", "-q", "--bare", "--initial-branch=main", origin], root);
  git(["clone", "-q", origin, repo], root);
  git(["config", "user.email", "runtime@paperclip.test"], repo);
  git(["config", "user.name", "Paperclip Runtime"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "seed\n", "utf8");
  git(["add", "."], repo);
  git(["commit", "-qm", "seed"], repo);
  git(["push", "-q", "origin", "main"], repo);
  return { repo, origin };
}

/** Materializes a worktree the way the runtime does: `worktree add` + ownership lock. */
async function addOwnedWorktree(input: {
  repo: string;
  worktreePath: string;
  branchName: string;
  executionWorkspaceId: string;
}) {
  git(["worktree", "add", "-q", "-b", input.branchName, input.worktreePath, "main"], input.repo);
  await lockGitWorktreeForOwner({
    git: async (args, cwd) => git(args, cwd),
    repoRoot: input.repo,
    worktreePath: input.worktreePath,
    normalizePath: async (value) => path.resolve(fs.realpathSync(path.dirname(value)), path.basename(value)),
    token: { branchName: input.branchName, executionWorkspaceId: input.executionWorkspaceId, runId: null },
  });
}

function worktreeIsRegistered(repo: string, worktreePath: string): boolean {
  return git(["worktree", "list", "--porcelain"], repo)
    .split("\n")
    .some((line) => line.startsWith("worktree ") && fs.existsSync(line.slice("worktree ".length))
      && path.resolve(line.slice("worktree ".length)) === path.resolve(worktreePath));
}

describe("inspectWorktreeReclaimSafety", () => {
  it("clears a clean worktree whose HEAD is published", async () => {
    const { repo } = createRepoWithRemote();
    const worktreePath = path.join(path.dirname(repo), "wt-clean");
    await addOwnedWorktree({ repo, worktreePath, branchName: "wt-clean", executionWorkspaceId: randomUUID() });

    expect(await inspectWorktreeReclaimSafety(worktreePath)).toMatchObject({ safe: true, reason: "clean" });
  });

  it("refuses a worktree holding uncommitted work", async () => {
    const { repo } = createRepoWithRemote();
    const worktreePath = path.join(path.dirname(repo), "wt-dirty");
    await addOwnedWorktree({ repo, worktreePath, branchName: "wt-dirty", executionWorkspaceId: randomUUID() });
    fs.writeFileSync(path.join(worktreePath, "README.md"), "edited but never committed\n", "utf8");

    const verdict = await inspectWorktreeReclaimSafety(worktreePath);
    expect(verdict.safe).toBe(false);
    expect(verdict.reason).toBe("dirty");
  });

  it("refuses a worktree holding an untracked file", async () => {
    const { repo } = createRepoWithRemote();
    const worktreePath = path.join(path.dirname(repo), "wt-untracked");
    await addOwnedWorktree({ repo, worktreePath, branchName: "wt-untracked", executionWorkspaceId: randomUUID() });
    fs.writeFileSync(path.join(worktreePath, "scratch.txt"), "not added\n", "utf8");

    expect(await inspectWorktreeReclaimSafety(worktreePath)).toMatchObject({ safe: false, reason: "dirty" });
  });

  it("refuses a worktree whose commits reached no remote", async () => {
    const { repo } = createRepoWithRemote();
    const worktreePath = path.join(path.dirname(repo), "wt-unpushed");
    await addOwnedWorktree({ repo, worktreePath, branchName: "wt-unpushed", executionWorkspaceId: randomUUID() });
    fs.writeFileSync(path.join(worktreePath, "work.txt"), "committed, never pushed\n", "utf8");
    git(["add", "."], worktreePath);
    git(["commit", "-qm", "local work"], worktreePath);

    const verdict = await inspectWorktreeReclaimSafety(worktreePath);
    expect(verdict.safe).toBe(false);
    expect(verdict.reason).toBe("unpushed");
  });

  it("refuses anything it cannot read rather than assuming it is clean", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-ws-collector-nongit-"));
    tempRoots.add(root);
    // A directory that exists but is not a git worktree: every git probe fails.
    expect(await inspectWorktreeReclaimSafety(root)).toMatchObject({ safe: false, reason: "unverifiable" });
  });

  it("treats an unmaterialized path as registry-only", async () => {
    const verdict = await inspectWorktreeReclaimSafety(path.join(os.tmpdir(), `paperclip-absent-${randomUUID()}`));
    expect(verdict).toMatchObject({ safe: true, reason: "missing" });
  });

  it("refuses a path that is not a directory rather than calling it missing", async () => {
    // `stat().catch(() => false)` would collapse this into "missing" -> safe,
    // and so would every EACCES/EIO/ESTALE. Only a proving errno is missing.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-ws-collector-file-"));
    tempRoots.add(root);
    const filePath = path.join(root, "not-a-directory");
    fs.writeFileSync(filePath, "\n", "utf8");

    expect(await inspectWorktreeReclaimSafety(filePath)).toMatchObject({ safe: false, reason: "unverifiable" });
  });

  it("gives up on a stat that never returns instead of hanging the collector", async () => {
    // A wedged mount: stat neither resolves nor rejects. The collector is tracked
    // heartbeat-scheduler work, so without a bound this await also blocks the
    // shutdown drain forever.
    vi.useFakeTimers();
    // Resolvable at the end: an abandoned call holds its directory until the
    // syscall answers, and leaving that held would make every later test in
    // this file depend on declaration order.
    let unwedge!: () => void;
    const stat = vi.spyOn(fsp, "stat").mockImplementation(
      () => new Promise((resolve) => { unwedge = () => resolve(undefined as never); }),
    );
    try {
      const pending = inspectWorktreeReclaimSafety(path.join(os.tmpdir(), `paperclip-wedged-${randomUUID()}`));
      await vi.runOnlyPendingTimersAsync();
      expect(await pending).toMatchObject({ safe: false, reason: "unverifiable", detail: "stat failed: ETIMEDOUT" });
    } finally {
      unwedge?.();
      await vi.advanceTimersByTimeAsync(0);
      stat.mockRestore();
      vi.useRealTimers();
    }
    expect(reclaimFsOutstandingCount()).toBe(0);
  });

  it("refcounts the hold, so one answered syscall does not release a directory another still holds", async () => {
    vi.useFakeTimers();
    // Two abandoned calls under ONE directory. A `Set` collapses them to a
    // single entry, so the first syscall to answer clears the hold while the
    // second thread is still held — and the backstop then reads a threadpool
    // that is emptier than it is. The pre-checks make this rare rather than
    // impossible: two callers can both check before either expires, and the
    // run-teardown and operator-PATCH callers share the same map.
    const dir = path.join(os.tmpdir(), `paperclip-wedged-${randomUUID()}`);
    const unwedge: Array<() => void> = [];
    const stat = vi.spyOn(fsp, "stat").mockImplementation(
      () => new Promise((resolve) => { unwedge.push(() => resolve(undefined as never)); }),
    );
    try {
      const first = inspectWorktreeReclaimSafety(path.join(dir, "wt-a"));
      const second = inspectWorktreeReclaimSafety(path.join(dir, "wt-b"));
      await vi.runOnlyPendingTimersAsync();
      await Promise.all([first, second]);
      expect(reclaimFsOutstandingCount()).toBe(2);

      unwedge[0]?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(reclaimFsOutstandingCount()).toBe(1);

      unwedge[1]?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(reclaimFsOutstandingCount()).toBe(0);
    } finally {
      for (const release of unwedge) release();
      await vi.advanceTimersByTimeAsync(0);
      stat.mockRestore();
      vi.useRealTimers();
    }
  });

  it("abandons one thread for a wedged registry, not one per colocated registration", async () => {
    // The registry walk is the other route past the entry gate, and it scales
    // with the *population* rather than with the candidate count:
    // `findGitWorktreeRegistration` normalizes every registration it lists, so
    // on the 128-registration population this collector exists to drain, one
    // candidate against a wedged mount would abandon 128 threads — a pool of 4.
    // Driven through the real call site rather than by calling the normalizer
    // twice, because it is the loop that does the damage.
    //
    // `realpath`, not `stat`: the walk and the inspector use different calls,
    // which is why the existing wedge fixtures above do not cover this one.
    vi.useFakeTimers();
    const parent = path.join(os.tmpdir(), `paperclip-wedged-registry-${randomUUID()}`);
    const registrations = ["wt-a", "wt-b", "wt-c"].map((name) => path.join(parent, name));
    const unwedge: Array<() => void> = [];
    // Resolves to the path it was asked about — realpath's no-symlink answer.
    // Resolving to nothing instead would make the walk read it as a missing
    // segment and climb to the parent, issuing a second never-settling call,
    // so the hold would never release and the teardown below would not clear.
    const realpath = vi.spyOn(fsp, "realpath").mockImplementation(
      ((target: fs.PathLike) => new Promise((resolve) => {
        unwedge.push(() => resolve(String(target) as never));
      })) as typeof fsp.realpath,
    );
    try {
      const pending = findGitWorktreeRegistration({
        git: async () => registrations.map((worktree) => `worktree ${worktree}\nbranch refs/heads/${path.basename(worktree)}\n`).join("\n"),
        repoRoot: parent,
        worktreePath: registrations[0]!,
        normalizePath: resolvePathForWorktreeComparison,
      });
      // Drain until quiet rather than once. With the pre-check only the first
      // normalize ever arms a deadline, so every later pass is a no-op; without
      // it each normalize arms its own *after* the previous one expired, and a
      // single tick would leave this hanging on `pending`. Failing the mutation
      // on the count below is a far better signal than failing it on a timeout,
      // which is indistinguishable from an environmental stall.
      for (let i = 0; i < registrations.length + 1; i += 1) {
        await vi.runOnlyPendingTimersAsync();
      }
      const found = await pending;

      // The whole point: N registrations, one held thread.
      expect(reclaimFsOutstandingCount()).toBe(1);
      expect(unwedge).toHaveLength(1);
      // And the fallback still answers — both sides normalize lexically, so
      // the match the walk would have made is still made.
      expect(found?.worktree).toBe(registrations[0]);
    } finally {
      for (const release of unwedge) release();
      await vi.advanceTimersByTimeAsync(0);
      realpath.mockRestore();
      vi.useRealTimers();
    }
    expect(reclaimFsOutstandingCount()).toBe(0);
  });
});

/**
 * The archive decision, isolated.
 *
 * This one branch cannot be reached through the real-filesystem suite below,
 * and the reason is worth stating rather than papering over with a mock. The
 * divergence between `cleanup.cleaned` and a proving stat is a TOCTOU on a
 * transient errno: the pre-check reads the tree, removal runs, and only then
 * does EACCES/EIO/ESTALE land. The pre-check already rejects every *stable*
 * cause (a non-directory, an unreadable path) before removal is attempted, so
 * staging it needs the errno to appear mid-sweep — not reproducible with a real
 * fs, and not reproducible by chmod either, since these tests can run as root.
 *
 * So the wiring is covered by the sweep tests below (a proven removal archives;
 * a declined one does not) and the errno mapping by the inspector tests above;
 * this table covers the predicate that joins them.
 */
describe("classifyRemovalProof", () => {
  it("archives only on a removal proven by a missing path", () => {
    expect(classifyRemovalProof(true, "missing")).toBeNull();
  });

  it("defers when the stat that reported removal could not prove it", () => {
    // The BLO-22984 residual: `cleaned` is `stat().catch(() => false)`, so an
    // ESTALE on the network mount reads as "gone" and would archive the row
    // with a null stamp, which `selectEligible` can never re-select.
    expect(classifyRemovalProof(true, "unverifiable")).toBe("unverifiable");
  });

  it("defers when the tree is still demonstrably there after cleanup", () => {
    expect(classifyRemovalProof(true, "clean")).toBe("clean");
    expect(classifyRemovalProof(true, "dirty")).toBe("dirty");
    expect(classifyRemovalProof(true, "unpushed")).toBe("unpushed");
  });

  it("defers when removal itself was declined, whatever the path now stats as", () => {
    expect(classifyRemovalProof(false, "missing")).toBe("uncleaned");
    expect(classifyRemovalProof(false, null)).toBe("uncleaned");
  });

  it("archives a row with no path to prove, which is the registry-only case", () => {
    expect(classifyRemovalProof(true, null)).toBeNull();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("reconcileExecutionWorkspaceCleanup", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let cleanup: ReturnType<typeof executionWorkspaceCleanupService>;
  let companyId: string;
  let projectId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-workspace-cleanup-");
    db = createDb(tempDb.connectionString);
    cleanup = executionWorkspaceCleanupService(db);
  }, 180_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    companyId = randomUUID();
    projectId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Collector Co", status: "active" });
    await db.insert(projects).values({ id: projectId, companyId, name: "collector-project" });
  });

  async function insertWorkspace(input: {
    worktreePath: string;
    branchName: string;
    cleanupEligibleAt: Date | null;
    lastUsedAt: Date;
  }) {
    const id = randomUUID();
    await db.insert(executionWorkspaces).values({
      id,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: input.branchName,
      status: "active",
      cwd: input.worktreePath,
      providerType: "git_worktree",
      providerRef: input.worktreePath,
      branchName: input.branchName,
      cleanupEligibleAt: input.cleanupEligibleAt,
      lastUsedAt: input.lastUsedAt,
    });
    return id;
  }

  const hourAgo = () => new Date(Date.now() - 60 * 60 * 1000);

  it("removes an eligible worktree from disk and from the git registry", async () => {
    const { repo } = createRepoWithRemote();
    const worktreePath = path.join(path.dirname(repo), "wt-collect");
    const id = randomUUID();
    await addOwnedWorktree({ repo, worktreePath, branchName: "wt-collect", executionWorkspaceId: id });
    await db.insert(executionWorkspaces).values({
      id,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "wt-collect",
      status: "active",
      cwd: worktreePath,
      providerType: "git_worktree",
      providerRef: worktreePath,
      branchName: "wt-collect",
      cleanupEligibleAt: hourAgo(),
      lastUsedAt: hourAgo(),
    });
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(worktreeIsRegistered(repo, worktreePath)).toBe(true);

    const result = await cleanup.reconcileExecutionWorkspaceCleanup();

    expect(result.collected).toBe(1);
    expect(result.skipped).toBe(0);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(worktreeIsRegistered(repo, worktreePath)).toBe(false);

    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id));
    expect(row?.status).toBe("archived");
    expect(row?.cleanupReason).toBe("collected");
    // Cleared so the row cannot be selected again.
    expect(row?.cleanupEligibleAt).toBeNull();
  });

  it("leaves a worktree with uncommitted work on disk and defers it", async () => {
    const { repo } = createRepoWithRemote();
    const worktreePath = path.join(path.dirname(repo), "wt-keep");
    const id = randomUUID();
    await addOwnedWorktree({ repo, worktreePath, branchName: "wt-keep", executionWorkspaceId: id });
    fs.writeFileSync(path.join(worktreePath, "README.md"), "unsaved work\n", "utf8");
    await db.insert(executionWorkspaces).values({
      id,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "wt-keep",
      status: "active",
      cwd: worktreePath,
      providerType: "git_worktree",
      providerRef: worktreePath,
      branchName: "wt-keep",
      cleanupEligibleAt: hourAgo(),
      lastUsedAt: hourAgo(),
    });

    const result = await cleanup.reconcileExecutionWorkspaceCleanup();

    expect(result.collected).toBe(0);
    expect(result.skipped).toBe(1);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(worktreeIsRegistered(repo, worktreePath)).toBe(true);
    expect(fs.readFileSync(path.join(worktreePath, "README.md"), "utf8")).toBe("unsaved work\n");

    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id));
    expect(row?.cleanupReason).toBe("retained_dirty");
    // Deferred, not abandoned: re-checked next window so it collects once pushed.
    expect(row?.cleanupEligibleAt?.getTime() ?? 0).toBeGreaterThan(Date.now());
  });

  it("never archives a workspace whose worktree removal was declined", async () => {
    // The targeted population: a registration whose lock this workspace does
    // not own, so `authorizeOwnedGitWorktreeCleanup` declines and nothing is
    // removed. Archiving here would null `cleanupEligibleAt`, which
    // `selectEligible` requires, so the tree could never be reconsidered.
    const { repo } = createRepoWithRemote();
    const worktreePath = path.join(path.dirname(repo), "wt-foreign");
    const id = randomUUID();
    git(["worktree", "add", "-q", "-b", "wt-foreign", worktreePath, "main"], repo);
    git(["worktree", "lock", "--reason", "held by another tool", worktreePath], repo);
    await db.insert(executionWorkspaces).values({
      id,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "wt-foreign",
      status: "active",
      cwd: worktreePath,
      providerType: "git_worktree",
      providerRef: worktreePath,
      branchName: "wt-foreign",
      cleanupEligibleAt: hourAgo(),
      lastUsedAt: hourAgo(),
    });

    const result = await cleanup.reconcileExecutionWorkspaceCleanup();

    expect(result.collected).toBe(0);
    expect(result.skipped).toBe(1);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(worktreeIsRegistered(repo, worktreePath)).toBe(true);

    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id));
    expect(row?.status).toBe("active");
    expect(row?.cleanupReason).toBe("retained_uncleaned");
    // Still selectable next window, so the leak stays recoverable.
    expect(row?.cleanupEligibleAt?.getTime() ?? 0).toBeGreaterThan(Date.now());
  });

  it("ends the pass after a stat hits its deadline instead of feeding the wedged mount another thread", async () => {
    // An abandoned stat keeps its libuv threadpool thread until the syscall
    // returns, and the pool is 4 threads process-wide. These trees are
    // colocated, so continuing the batch would retire the pool one candidate at
    // a time. The rest are re-selected next window; nothing is lost by stopping.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-wedged-pass-"));
    tempRoots.add(root);
    const wedgedPath = path.join(root, "wt-wedged");
    const nextPath = path.join(root, "wt-next");
    const wedgedId = await insertWorkspace({
      worktreePath: wedgedPath,
      branchName: "wt-wedged",
      cleanupEligibleAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      lastUsedAt: hourAgo(),
    });
    const nextId = await insertWorkspace({
      worktreePath: nextPath,
      branchName: "wt-next",
      cleanupEligibleAt: hourAgo(),
      lastUsedAt: hourAgo(),
    });

    const realStat = fsp.stat.bind(fsp);
    let reachedWedged!: () => void;
    let unwedge: (() => void) | undefined;
    const wedgedStatCalled = new Promise<void>((resolve) => {
      reachedWedged = resolve;
    });
    // Only timers are faked: the database client and Date stay real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stat = vi.spyOn(fsp, "stat").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target) === wedgedPath) {
        reachedWedged();
        // Resolvable so the wedged directory does not stay held past this test.
        return new Promise((resolve) => { unwedge = () => resolve(undefined as never); });
      }
      return (realStat as (...args: unknown[]) => Promise<fs.Stats>)(target, ...rest);
    }) as typeof fsp.stat);
    try {
      const pending = cleanup.reconcileExecutionWorkspaceCleanup();
      await wedgedStatCalled;
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;

      expect(result.scanned).toBe(1);
      expect(result.collected).toBe(0);
      expect(result.skipped).toBe(1);
    } finally {
      unwedge?.();
      await vi.advanceTimersByTimeAsync(0);
      stat.mockRestore();
      vi.useRealTimers();
    }

    const [wedged] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, wedgedId));
    expect(wedged?.cleanupReason).toBe("retained_unverifiable");
    // Never examined: still eligible, untouched, picked up next window.
    const [next] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, nextId));
    expect(next?.status).toBe("active");
    expect(next?.cleanupReason).toBeNull();
    expect(next?.cleanupEligibleAt?.getTime() ?? Infinity).toBeLessThanOrEqual(Date.now());
  });

  it("holds only the wedged directory, so a colocated sibling is skipped and another root still collects", async () => {
    const wedgedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-wedged-root-"));
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-other-root-"));
    tempRoots.add(wedgedRoot);
    tempRoots.add(otherRoot);
    const wedgedPath = path.join(wedgedRoot, "wt-wedged");
    const siblingPath = path.join(wedgedRoot, "wt-sibling");
    // Absent on disk, so it is provably registry-only and collectable.
    const otherPath = path.join(otherRoot, "wt-other");
    const hours = (n: number) => new Date(Date.now() - n * 60 * 60 * 1000);
    await insertWorkspace({
      worktreePath: wedgedPath, branchName: "wt-wedged", cleanupEligibleAt: hours(4), lastUsedAt: hourAgo(),
    });
    const siblingId = await insertWorkspace({
      worktreePath: siblingPath, branchName: "wt-sibling", cleanupEligibleAt: hours(3), lastUsedAt: hourAgo(),
    });
    const otherId = await insertWorkspace({
      worktreePath: otherPath, branchName: "wt-other", cleanupEligibleAt: hours(2), lastUsedAt: hourAgo(),
    });

    const realStat = fsp.stat.bind(fsp);
    const statted: string[] = [];
    let unwedge: (() => void) | undefined;
    let reachedWedged!: () => void;
    const wedgedStatCalled = new Promise<void>((resolve) => { reachedWedged = resolve; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stat = vi.spyOn(fsp, "stat").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      statted.push(String(target));
      if (String(target) === wedgedPath) {
        reachedWedged();
        return new Promise((resolve) => { unwedge = () => resolve(undefined as never); });
      }
      return (realStat as (...args: unknown[]) => Promise<fs.Stats>)(target, ...rest);
    }) as typeof fsp.stat);
    try {
      const first = cleanup.reconcileExecutionWorkspaceCleanup();
      await wedgedStatCalled;
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await first).scanned).toBe(1);
      expect(reclaimFsOutstandingCount()).toBe(1);

      statted.length = 0;
      const second = await cleanup.reconcileExecutionWorkspaceCleanup();
      // The sibling shares the wedged mount, so it is deferred without a probe:
      // statting it would hold a second threadpool thread to learn the same thing.
      expect(statted).not.toContain(siblingPath);
      expect(second.skipped).toBeGreaterThanOrEqual(1);
      // ...and the hold is scoped to that directory, so an unrelated root is
      // still collected rather than the collector latching off process-wide.
      expect(second.collected).toBe(1);

      unwedge?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(reclaimFsOutstandingCount()).toBe(0);
    } finally {
      unwedge?.();
      await vi.advanceTimersByTimeAsync(0);
      stat.mockRestore();
      vi.useRealTimers();
    }

    const [sibling] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, siblingId));
    expect(sibling?.status).toBe("active");
    const [other] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, otherId));
    expect(other?.status).toBe("archived");
  });

  it("ends the pass once abandoned calls reach the threadpool ceiling, even under unrelated roots", async () => {
    // The entry gate bounds where a pass *starts*; this covers where it ends.
    // The targeted break above only fires on the inspector-expiry path. When
    // the *cleanup-side* stat expires instead — inspector already succeeded,
    // mount wedged between the two reads — the candidate defers and continues,
    // so outstanding grows with no break. Under one root the colocated
    // pre-check would deflect the next candidate; each of these gets its own
    // root so nothing deflects them and only the in-loop re-check can stop the
    // pass. Sized off the limit rather than a literal, since it is derived
    // from UV_THREADPOOL_SIZE.
    const wedgedPaths: string[] = [];
    const hours = (n: number) => new Date(Date.now() - n * 60 * 60 * 1000);
    for (let i = 0; i < RECLAIM_FS_OUTSTANDING_LIMIT; i += 1) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `paperclip-ceiling-${i}-`));
      tempRoots.add(root);
      // Absent on disk, so the inspector reads ENOENT and returns safe; the
      // only stat that can hang is the cleanup-side one.
      const wtPath = path.join(root, `wt-ceiling-${i}`);
      wedgedPaths.push(wtPath);
      await insertWorkspace({
        worktreePath: wtPath,
        branchName: `wt-ceiling-${i}`,
        cleanupEligibleAt: hours(10 - i),
        lastUsedAt: hourAgo(),
      });
    }
    // Youngest eligibility, so it sorts last and is the candidate the ceiling
    // must leave unscanned. Absent on disk, so it would otherwise collect.
    const trailingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-ceiling-trailing-"));
    tempRoots.add(trailingRoot);
    const trailingPath = path.join(trailingRoot, "wt-trailing");
    const trailingId = await insertWorkspace({
      worktreePath: trailingPath,
      branchName: "wt-trailing",
      cleanupEligibleAt: hours(1),
      lastUsedAt: hourAgo(),
    });

    const realStat = fsp.stat.bind(fsp);
    const seen = new Map<string, number>();
    const statted: string[] = [];
    const unwedge: Array<() => void> = [];
    // One signal per wedging candidate. The deadline's timer only exists once
    // its stat has actually been called, and that call happens after a real
    // inspect + git/ownership pass — so advancing fake time on a fixed loop
    // races it and advances past nothing. Wait for each call, then advance.
    const reached: Array<() => void> = [];
    const statCalled = wedgedPaths.map(() => new Promise<void>((resolve) => { reached.push(resolve); }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stat = vi.spyOn(fsp, "stat").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      const key = String(target);
      statted.push(key);
      const nth = (seen.get(key) ?? 0) + 1;
      seen.set(key, nth);
      // First stat per path is the inspector's (real ENOENT -> safe/missing);
      // the second is the cleanup-side one, and that is the one that hangs.
      const wedgedIndex = wedgedPaths.indexOf(key);
      if (nth > 1 && wedgedIndex >= 0) {
        reached[wedgedIndex]?.();
        return new Promise((resolve) => { unwedge.push(() => resolve(undefined as never)); });
      }
      return (realStat as (...args: unknown[]) => Promise<fs.Stats>)(target, ...rest);
    }) as typeof fsp.stat);
    try {
      const pending = cleanup.reconcileExecutionWorkspaceCleanup();
      for (const called of statCalled) {
        await called;
        await vi.advanceTimersByTimeAsync(30_000);
      }
      const result = await pending;

      expect(reclaimFsOutstandingCount()).toBe(RECLAIM_FS_OUTSTANDING_LIMIT);
      // Scanned exactly the wedging candidates and stopped: the trailing one is
      // never examined, so its eligibility is not pushed out either.
      expect(result.scanned).toBe(RECLAIM_FS_OUTSTANDING_LIMIT);
      expect(statted).not.toContain(trailingPath);
      expect(result.collected).toBe(0);
    } finally {
      for (const release of unwedge) release();
      await vi.advanceTimersByTimeAsync(0);
      stat.mockRestore();
      vi.useRealTimers();
    }

    const [trailing] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, trailingId));
    expect(trailing?.status).toBe("active");
    expect(trailing?.cleanupReason).toBeNull();
    expect(trailing?.cleanupEligibleAt?.getTime() ?? Infinity).toBeLessThanOrEqual(Date.now());
    // Each wedging candidate runs a full inspect + teardown against a real
    // repo before its cleanup-side stat can expire, so this is slower than the
    // inspector-expiry tests above; 60s is not enough headroom.
  }, 180_000);

  it("does not touch a workspace that is not yet eligible", async () => {
    const { repo } = createRepoWithRemote();
    const worktreePath = path.join(path.dirname(repo), "wt-active");
    const id = randomUUID();
    await addOwnedWorktree({ repo, worktreePath, branchName: "wt-active", executionWorkspaceId: id });
    await db.insert(executionWorkspaces).values({
      id,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "git_worktree",
      name: "wt-active",
      status: "active",
      cwd: worktreePath,
      providerType: "git_worktree",
      providerRef: worktreePath,
      branchName: "wt-active",
      // Stamped, but the window has not elapsed — this is the reused per-issue shape.
      cleanupEligibleAt: new Date(Date.now() + 60 * 60 * 1000),
      lastUsedAt: hourAgo(),
    });

    const result = await cleanup.reconcileExecutionWorkspaceCleanup();

    expect(result.scanned).toBe(0);
    expect(result.collected).toBe(0);
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it("never touches a shared local_fs workspace, which points at the project checkout", async () => {
    const id = randomUUID();
    await db.insert(executionWorkspaces).values({
      id,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "project-primary",
      status: "active",
      cwd: path.join(os.tmpdir(), `paperclip-primary-${randomUUID()}`),
      providerType: "local_fs",
      providerRef: null,
      cleanupEligibleAt: hourAgo(),
      lastUsedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    const result = await cleanup.reconcileExecutionWorkspaceCleanup();

    expect(result.scanned).toBe(0);
    expect(result.collected).toBe(0);
    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id));
    expect(row?.status).toBe("active");
  });

  it("backfills long-idle unstamped rows so the pre-existing population is reclaimable", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const legacy = await insertWorkspace({
      worktreePath: path.join(os.tmpdir(), `paperclip-legacy-${randomUUID()}`),
      branchName: "legacy",
      cleanupEligibleAt: null,
      lastUsedAt: eightDaysAgo,
    });
    const recent = await insertWorkspace({
      worktreePath: path.join(os.tmpdir(), `paperclip-recent-${randomUUID()}`),
      branchName: "recent",
      cleanupEligibleAt: null,
      lastUsedAt: hourAgo(),
    });

    const result = await cleanup.reconcileExecutionWorkspaceCleanup();

    expect(result.stamped).toBe(1);
    // Stamped and collected in the same pass: the paths are absent, so only the
    // registry entry could have remained.
    expect(result.collected).toBe(1);

    const [legacyRow] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, legacy));
    expect(legacyRow?.status).toBe("archived");
    const [recentRow] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, recent));
    expect(recentRow?.cleanupEligibleAt).toBeNull();
    expect(recentRow?.status).toBe("active");
  });

  it("never backfills an archived row, so quarantined evidence survives", async () => {
    const id = await insertWorkspace({
      worktreePath: path.join(os.tmpdir(), `paperclip-quarantined-${randomUUID()}`),
      branchName: "quarantined",
      cleanupEligibleAt: null,
      lastUsedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    await db.update(executionWorkspaces)
      .set({ status: "archived", cleanupReason: "workspace_validation_failed" })
      .where(eq(executionWorkspaces.id, id));

    const result = await cleanup.reconcileExecutionWorkspaceCleanup();

    expect(result.stamped).toBe(0);
    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id));
    expect(row?.cleanupEligibleAt).toBeNull();
    expect(row?.cleanupReason).toBe("workspace_validation_failed");
  });

  it("never collects an archived row that still carries a stamp", async () => {
    // The backfill's evidence rule, asserted on the selection side. A row
    // archived elsewhere *while stamped* is reachable by `selectEligible`
    // even though `stampIdleLegacyWorkspaces` would never have stamped it,
    // so without a status filter the collector would remove the artifact
    // somebody archived to keep. The worktree is real and clean here, so the
    // only thing that can spare it is the selection predicate.
    const { repo } = createRepoWithRemote();
    const worktreePath = path.join(path.dirname(repo), "wt-quarantined");
    const id = randomUUID();
    await addOwnedWorktree({ repo, worktreePath, branchName: "wt-quarantined", executionWorkspaceId: id });
    await db.insert(executionWorkspaces).values({
      id,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "wt-quarantined",
      status: "archived",
      cwd: worktreePath,
      providerType: "git_worktree",
      providerRef: worktreePath,
      branchName: "wt-quarantined",
      cleanupReason: "workspace_validation_failed",
      cleanupEligibleAt: hourAgo(),
      lastUsedAt: hourAgo(),
    });

    const result = await cleanup.reconcileExecutionWorkspaceCleanup();

    expect(result.scanned).toBe(0);
    expect(result.collected).toBe(0);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(worktreeIsRegistered(repo, worktreePath)).toBe(true);

    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id));
    expect(row?.cleanupReason).toBe("workspace_validation_failed");
  });


  it("never defers a row archived after it was selected, so the retained census stays true", async () => {
    // The evidence rule on the THIRD writer. `selectEligible` excludes archived
    // rows, so the only way `deferCandidate` can see one is the window between
    // selection and the defer write — which is exactly what two overlapping
    // passes produce: the leading pass archives a row it proved removed while
    // the trailing pass is still inspecting the tree underneath it.
    //
    // `deferCandidate` deliberately does not set `status`, so without the guard
    // the row ends `archived` while carrying `retained_dirty`: a tree that was
    // provably removed, recorded in the `cleanup_reason like 'retained_%'`
    // census as one the collector chose to keep. That census is this
    // collector's own observability deliverable, so the corruption is silent in
    // exactly the place we would look to detect it.
    //
    // The window is forced rather than raced: the db handed to the service
    // archives the row the moment the candidate query resolves, which is
    // deterministic where a real overlap would be timing-dependent.
    const { repo } = createRepoWithRemote();
    const worktreePath = path.join(path.dirname(repo), "wt-archived-midpass");
    const id = randomUUID();
    await addOwnedWorktree({ repo, worktreePath, branchName: "wt-archived-midpass", executionWorkspaceId: id });
    // Dirty, so the pass takes the defer path rather than removing the tree.
    fs.writeFileSync(path.join(worktreePath, "README.md"), "unsaved work\n", "utf8");
    await db.insert(executionWorkspaces).values({
      id,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "wt-archived-midpass",
      status: "active",
      cwd: worktreePath,
      providerType: "git_worktree",
      providerRef: worktreePath,
      branchName: "wt-archived-midpass",
      cleanupEligibleAt: hourAgo(),
      lastUsedAt: hourAgo(),
    });

    let archived = false;
    const archiveOnce = async () => {
      if (archived) return;
      archived = true;
      await db.update(executionWorkspaces)
        .set({ status: "archived", cleanupReason: "workspace_validation_failed" })
        .where(eq(executionWorkspaces.id, id));
    };
    // Drizzle builders are chainable thenables, so the hook has to survive
    // `.from().where().orderBy().limit()`. `then` is read off the TARGET, not
    // the proxy, or awaiting it would re-enter this trap forever.
    const archiveWhenSelectResolves = (builder: any): any => new Proxy(builder, {
      get(target, prop, receiver) {
        if (prop === "then") {
          return (onOk: any, onErr: any) =>
            Reflect.get(target, "then").call(target, async (rows: unknown) => {
              await archiveOnce();
              return rows;
            }).then(onOk, onErr);
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const out = value.apply(target, args);
          return out && typeof out === "object" ? archiveWhenSelectResolves(out) : out;
        };
      },
    });
    const racingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select") {
          return (...args: unknown[]) =>
            archiveWhenSelectResolves((target as any).select(...args));
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;

    const result = await executionWorkspaceCleanupService(racingDb)
      .reconcileExecutionWorkspaceCleanup();

    // The pass really did reach the defer path — otherwise this asserts nothing.
    expect(archived).toBe(true);
    expect(result.skipped).toBe(1);
    expect(result.collected).toBe(0);

    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id));
    expect(row?.status).toBe("archived");
    // The archive's own reason survives; no `retained_*` stamp is layered onto it.
    expect(row?.cleanupReason).toBe("workspace_validation_failed");
  });
});

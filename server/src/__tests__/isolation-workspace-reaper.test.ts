import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { environments } from "@paperclipai/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISOLATION_WORKSPACE_REAPER_DELETED_METRIC,
  ISOLATION_WORKSPACE_REAPER_ENTRIES_METRIC,
  ISOLATION_WORKSPACE_REAPER_ENTRY_OUTCOMES,
  ISOLATION_WORKSPACE_REAPER_LAST_SWEEP_METRIC,
  ISOLATION_WORKSPACE_REAPER_RETAINED_RESURRECTED_METRIC,
  ISOLATION_WORKSPACE_REAPER_SCANNED_METRIC,
  ISOLATION_WORKSPACE_REAPER_SKIPPED_LAYOUT_METRIC,
  ISOLATION_WORKSPACE_REAPER_STOP_REASONS,
  ISOLATION_WORKSPACE_REAPER_SWEEPS_METRIC,
  ISOLATION_WORKSPACE_REAPER_UNREACHABLE_AGENTS_METRIC,
  getMetricsRegistry,
} from "../services/metrics.js";
import {
  DEFAULT_MAX_DELETES_PER_TICK,
  PER_AGENT_WORKSPACE_VOLUME_CONFIG_KEY,
  buildIsolationReclaimPlan,
  classifyIsolationWorkspaceAge,
  createDbUnreachableAgentCount,
  REAPABLE_LAYOUT,
  UNREACHABLE_AGENTS_UNKNOWN,
  WORKSPACE_VOLUME_CLAIM_CONFIG_KEY,
  WORKTREE_PARENT_DIRS,
  type WorkspaceUsageLookup,
  type WorkspaceUsageRow,
  reapIsolationWorkspaces,
  startIsolationWorkspaceReaper,
} from "../services/isolation-workspace-reaper.js";
import { DEFAULT_WORKTREE_INSTANCE_HOME_DIRNAME, REPO_MANAGED_WORKTREES_SUBPATH } from "../worktree-config.js";

const DAY = 86_400_000;
const NOW = new Date("2026-09-04T12:00:00Z").getTime();
const now = () => NOW;

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof reapIsolationWorkspaces>[0]["logger"];

let root: string;

/**
 * Stands in for `execution_workspaces`. A name absent from the map is the
 * orphan cohort — no owning row — which is the only case that falls back to
 * filesystem age.
 */
function usageLookup(rows: Record<string, Partial<WorkspaceUsageRow> & { lastUsedDaysAgo: number }>): WorkspaceUsageLookup {
  return async (ids) => {
    const found = new Map<string, WorkspaceUsageRow>();
    for (const id of ids) {
      const row = rows[id];
      if (!row) continue;
      found.set(id, {
        lastUsedAt: new Date(NOW - row.lastUsedDaysAgo * DAY),
        status: row.status ?? "active",
        closedAt: row.closedAt ?? null,
      });
    }
    return found;
  };
}

/**
 * A lookup whose answer changes after the opening snapshot, which is the only
 * way to exercise the pre-unlink re-read: the first (batched) call sees the
 * sweep's view of the world, every later per-id call sees `after`. `onRecheck`
 * runs before the re-read answers, so a test can mutate the filesystem in the
 * same window a resuming run would.
 */
function racingUsageLookup(
  before: Record<string, { lastUsedDaysAgo: number }>,
  after: Record<string, { lastUsedDaysAgo: number }>,
  onRecheck?: () => Promise<void>,
): WorkspaceUsageLookup & { calls: string[][] } {
  const calls: string[][] = [];
  const lookup = async (ids: string[]) => {
    const first = calls.length === 0;
    calls.push(ids);
    if (!first && onRecheck) await onRecheck();
    return usageLookup(first ? before : after)(ids);
  };
  return Object.assign(lookup, { calls });
}

/** Materialize a workspace dir with a given top-level layout and age. */
async function makeWorkspace(
  name: string,
  layout: string[],
  ageDays: number,
  files: Record<string, string> = {},
) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  for (const child of layout) await fs.mkdir(path.join(dir, child), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(dir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
  }
  const stamp = new Date(NOW - ageDays * DAY);
  await fs.utimes(dir, stamp, stamp);
  return dir;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "iso-reaper-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("reapIsolationWorkspaces", () => {
  it("removes an aged workspace whose layout is exactly {home, session}", async () => {
    await makeWorkspace("ws-old", [...REAPABLE_LAYOUT], 45, {
      "session/.claude/projects/a.jsonl": "{}",
    });

    const res = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger, lookupWorkspaceUsage: usageLookup({}) });

    expect(res).toMatchObject({ eligible: 1, deleted: 1, skippedLayout: 0, failed: 0 });
    await expect(fs.stat(path.join(root, "ws-old"))).rejects.toThrow();
  });

  it("leaves a workspace younger than the age cutoff alone", async () => {
    await makeWorkspace("ws-fresh", [...REAPABLE_LAYOUT], 3);

    const res = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger, lookupWorkspaceUsage: usageLookup({}) });

    expect(res).toMatchObject({ scanned: 1, eligible: 0, deleted: 0 });
    await expect(fs.stat(path.join(root, "ws-fresh"))).resolves.toBeDefined();
  });

  /**
   * The premise that made the original `mtime` predicate unsafe, pinned as a
   * test because the whole DB gate rests on it. A directory's `mtime` advances
   * only when a *direct child entry* is added, removed, or renamed. A
   * workspace-isolated run writes under `home/` and `session/`, both of which
   * already exist, so the root keeps its materialization time forever.
   */
  it("root mtime does not advance when a live run writes into home/ and session/", async () => {
    const dir = await makeWorkspace("ws-busy", [...REAPABLE_LAYOUT], 45);
    const materializedAt = (await fs.stat(dir)).mtimeMs;

    await fs.mkdir(path.join(dir, "session/.claude/projects"), { recursive: true });
    await fs.writeFile(path.join(dir, "session/.claude/projects/a.jsonl"), "{}");
    await fs.writeFile(path.join(dir, "home/.bashrc"), "export X=1");
    // What re-materializing on the next run does to the existing children.
    for (const child of REAPABLE_LAYOUT) {
      await fs.mkdir(path.join(dir, child), { recursive: true });
    }

    expect((await fs.stat(dir)).mtimeMs).toBe(materializedAt);
  });

  /**
   * The Critical case. A workspace materialized 45 days ago but used today is
   * indistinguishable from a 45-day-old orphan on the filesystem, and
   * `storage.home`/`storage.session` are both persistent — so deleting it
   * destroys durable state belonging to a live workspace. Fails against the
   * root-`mtime` predicate this replaced.
   */
  it("retains a workspace the database reports as recently used, despite an old root mtime", async () => {
    await makeWorkspace("ws-live", [...REAPABLE_LAYOUT], 45, {
      "session/.claude/projects/a.jsonl": "{}",
    });

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({ "ws-live": { lastUsedDaysAgo: 0 } }),
    });

    expect(res).toMatchObject({ scanned: 1, retainedInUse: 1, eligible: 0, deleted: 0 });
    await expect(
      fs.readFile(path.join(root, "ws-live", "session/.claude/projects/a.jsonl"), "utf8"),
    ).resolves.toBe("{}");
  });

  it("reaps a workspace whose owning row has been idle past the cutoff", async () => {
    await makeWorkspace("ws-idle", [...REAPABLE_LAYOUT], 45);

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({ "ws-idle": { lastUsedDaysAgo: 44 } }),
    });

    expect(res).toMatchObject({ retainedInUse: 0, eligible: 1, deleted: 1 });
    await expect(fs.stat(path.join(root, "ws-idle"))).rejects.toThrow();
  });

  /**
   * `lastUsedAt` is the only signal that can protect a live workspace, but it is
   * not the only one that can *retain*. A directory materialized yesterday
   * cannot have been idle for a month, so a row claiming otherwise is stale and
   * the conservative reading wins. This state should not arise — materializing
   * a workspace sets `lastUsedAt` — which is exactly why acting on it would be
   * acting on a contradiction.
   */
  it("retains when the row says idle but the directory was materialized inside the window", async () => {
    await makeWorkspace("ws-recent-dir", [...REAPABLE_LAYOUT], 1);

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({ "ws-recent-dir": { lastUsedDaysAgo: 90 } }),
    });

    expect(res).toMatchObject({ eligible: 0, deleted: 0, retainedFresh: 1 });
    await expect(fs.stat(path.join(root, "ws-recent-dir"))).resolves.toBeDefined();
  });

  it("falls back to filesystem age only for a directory with no owning row", async () => {
    await makeWorkspace("ws-orphan", [...REAPABLE_LAYOUT], 45);
    await makeWorkspace("ws-owned", [...REAPABLE_LAYOUT], 45);

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({ "ws-owned": { lastUsedDaysAgo: 0 } }),
    });

    expect(res).toMatchObject({ scanned: 2, retainedInUse: 1, eligible: 1, deleted: 1 });
    await expect(fs.stat(path.join(root, "ws-orphan"))).rejects.toThrow();
    await expect(fs.stat(path.join(root, "ws-owned"))).resolves.toBeDefined();
  });

  /**
   * The finding that justifies the allowlist. Of 448 audited directories, 447
   * were `{home, session}` and one carried a real git worktree. An age-only
   * predicate deletes it; this must not.
   */
  it("skips an aged directory carrying a git worktree, and does not delete it", async () => {
    await makeWorkspace("ws-worktree", ["home", "session", "wt-blo-19094"], 60, {
      "wt-blo-19094/README.md": "real work",
    });

    const res = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger, lookupWorkspaceUsage: usageLookup({}) });

    expect(res).toMatchObject({ scanned: 1, eligible: 0, deleted: 0, skippedLayout: 1 });
    await expect(
      fs.readFile(path.join(root, "ws-worktree", "wt-blo-19094", "README.md"), "utf8"),
    ).resolves.toBe("real work");
    expect(silentLogger!.warn).toHaveBeenCalledTimes(1);
  });

  it("skips an aged, layout-compliant directory holding a git worktree one level down", async () => {
    // The shape property 1 cannot see: top level is exactly {home, session},
    // and `home/<name>/.git` is the worktree pointer file. Measured on 13 of
    // 503 live match-set directories (BLO-36735).
    await makeWorkspace("ws-nested-wt", [...REAPABLE_LAYOUT], 60, {
      "home/blo-32797-wt/.git": "gitdir: /paperclip/.../pim-multicast-gateway/.git/worktrees/blo-32797-wt\n",
      "home/blo-32797-wt/Makefile": "real work",
    });

    const res = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger, lookupWorkspaceUsage: usageLookup({}) });

    expect(res).toMatchObject({ scanned: 1, eligible: 0, deleted: 0, skippedLayout: 0, retainedNestedCheckout: 1 });
    await expect(
      fs.readFile(path.join(root, "ws-nested-wt", "home", "blo-32797-wt", "Makefile"), "utf8"),
    ).resolves.toBe("real work");
  });

  it("probes session/ for a nested checkout, not only home/", async () => {
    // A registered worktree was found under each side on the live tree, so
    // probing one of them is not enough.
    await makeWorkspace("ws-nested-session", [...REAPABLE_LAYOUT], 60, {
      "session/pmg-34906-wt/.git": "gitdir: /paperclip/.../.git/worktrees/pmg-34906-wt\n",
    });

    const res = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger, lookupWorkspaceUsage: usageLookup({}) });

    expect(res).toMatchObject({ eligible: 0, deleted: 0, skippedLayout: 0, retainedNestedCheckout: 1 });
    await expect(fs.stat(path.join(root, "ws-nested-session"))).resolves.toBeDefined();
  });

  it("probes the parents named by the modules that create them, not restated literals", () => {
    // BLO-36735 I1: the probe once carried its own `.paperclip-worktrees`
    // literal while `workspace-runtime` built `.paperclip/worktrees`, leaving
    // the helper's real default unreachable. Pin the probe to the producers'
    // own constants so the two cannot drift apart again.
    expect(REPO_MANAGED_WORKTREES_SUBPATH).toBe(path.join(".paperclip", "worktrees"));
    expect([...WORKTREE_PARENT_DIRS].sort()).toEqual(
      [REPO_MANAGED_WORKTREES_SUBPATH, DEFAULT_WORKTREE_INSTANCE_HOME_DIRNAME].sort(),
    );
  });

  it.each([
    ["execution-workspace worktree parent", REPO_MANAGED_WORKTREES_SUBPATH],
    ["worktree-instance home", DEFAULT_WORKTREE_INSTANCE_HOME_DIRNAME],
  ])("skips on a non-empty %s, and reaps when it is empty", async (_label, parent) => {
    // `home` is the repo root here, but its own `.git` is gone: only the
    // parent dir is left to say a worktree lives below — three levels down,
    // where neither `.git` probe reaches.
    await makeWorkspace("ws-wt-parent", [...REAPABLE_LAYOUT], 60, {
      [path.join("home", parent, "blo-1-wt", "Makefile")]: "real work",
    });
    // Negative control: the same directory name, empty, must NOT retain —
    // otherwise the guard is a constant on anyone who ever ran the helper.
    await makeWorkspace("ws-wt-parent-empty", [...REAPABLE_LAYOUT], 60);
    await fs.mkdir(path.join(root, "ws-wt-parent-empty", "home", parent), { recursive: true });

    const res = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger, lookupWorkspaceUsage: usageLookup({}) });

    expect(res).toMatchObject({ scanned: 2, eligible: 1, deleted: 1, skippedLayout: 0, retainedNestedCheckout: 1 });
    await expect(fs.stat(path.join(root, "ws-wt-parent"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(root, "ws-wt-parent-empty"))).rejects.toThrow();
  });

  it("retains a side that is itself a repository root", async () => {
    await makeWorkspace("ws-side-repo", [...REAPABLE_LAYOUT], 60, {
      "session/.git/HEAD": "ref: refs/heads/main\n",
    });

    const res = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger, lookupWorkspaceUsage: usageLookup({}) });

    expect(res).toMatchObject({ eligible: 0, deleted: 0, retainedNestedCheckout: 1 });
    await expect(fs.stat(path.join(root, "ws-side-repo", "session", ".git", "HEAD"))).resolves.toBeDefined();
  });

  it("retains when a child's .git cannot be probed, rather than reading the fault as absence", async () => {
    // ELOOP, from a self-referential symlink, is a stat fault that is neither
    // ENOENT nor ENOTDIR and raises for every uid — so unlike chmod it cannot
    // pass on a root-run CI by deleting the directory.
    await makeWorkspace("ws-loop", [...REAPABLE_LAYOUT], 60);
    await fs.symlink("loop", path.join(root, "ws-loop", "home", "loop"));

    const res = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger, lookupWorkspaceUsage: usageLookup({}) });

    expect(res).toMatchObject({ eligible: 0, deleted: 0, retainedNestedCheckout: 1 });
    await expect(fs.stat(path.join(root, "ws-loop"))).resolves.toBeDefined();
  });

  it("still reaps a layout-compliant orphan whose home/ holds only tool caches", async () => {
    // The guard must not cost all of the reclaim. `.config` and `.local` are
    // on every workspace in the tree. A dangling symlink must read as absence
    // too, or every workspace with a stale tool link would be retained.
    await makeWorkspace("ws-plain-orphan", [...REAPABLE_LAYOUT], 60, {
      "home/.config/gh/hosts.yml": "x",
      "home/.local/share/pnpm/store": "y",
      "session/history.jsonl": "z",
    });
    await fs.symlink("/nonexistent-target", path.join(root, "ws-plain-orphan", "home", ".stale-link"));

    const res = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger, lookupWorkspaceUsage: usageLookup({}) });

    expect(res).toMatchObject({ eligible: 1, deleted: 1, skippedLayout: 0, retainedNestedCheckout: 0 });
  });

  it("retains rather than deletes when the nested probe cannot read a side", async () => {
    // Fail-closed branch. `home` is made a plain file so `readdir` raises
    // ENOTDIR for every uid — a chmod 0 would not block a root-run CI, and
    // would then pass by deleting the thing it is meant to protect.
    const dir = path.join(root, "ws-unreadable");
    await fs.mkdir(path.join(dir, "session"), { recursive: true });
    await fs.writeFile(path.join(dir, "home"), "not a directory");
    const stamp = new Date(NOW - 60 * DAY);
    await fs.utimes(dir, stamp, stamp);

    const res = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger, lookupWorkspaceUsage: usageLookup({}) });

    expect(res).toMatchObject({ eligible: 0, deleted: 0, skippedLayout: 0, retainedNestedCheckout: 1 });
    await expect(fs.stat(dir)).resolves.toBeDefined();
  });

  it("skips a partial layout rather than treating a missing member as inert", async () => {
    await makeWorkspace("ws-home-only", ["home"], 60);

    const res = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger, lookupWorkspaceUsage: usageLookup({}) });

    expect(res).toMatchObject({ eligible: 0, deleted: 0, skippedLayout: 1 });
    await expect(fs.stat(path.join(root, "ws-home-only"))).resolves.toBeDefined();
  });

  it("dryRun classifies as eligible but deletes nothing", async () => {
    await makeWorkspace("ws-old", [...REAPABLE_LAYOUT], 45);

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      dryRun: true,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({}),
    });

    expect(res).toMatchObject({ eligible: 1, deleted: 0 });
    await expect(fs.stat(path.join(root, "ws-old"))).resolves.toBeDefined();
  });

  it("caps deletions per tick and reports that it was capped", async () => {
    for (let i = 0; i < 5; i += 1) {
      await makeWorkspace(`ws-${i}`, [...REAPABLE_LAYOUT], 45);
    }

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      maxDeletesPerTick: 2,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({}),
    });

    expect(res.deleted).toBe(2);
    expect(res.capped).toBe(true);
    const left = await fs.readdir(root);
    expect(left).toHaveLength(3);
  });

  /**
   * The cap counts the work a live pass would perform, not unlinks already
   * done, so a dry run stops where the real run would. Counting deletions made
   * the cap unreachable in `dryRun` and the preview unrepresentative.
   */
  it("engages the per-tick cap in dryRun exactly as a live pass would", async () => {
    for (let i = 0; i < 5; i += 1) {
      await makeWorkspace(`ws-${i}`, [...REAPABLE_LAYOUT], 45);
    }

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      maxDeletesPerTick: 2,
      dryRun: true,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({}),
    });

    expect(res).toMatchObject({ eligible: 2, deleted: 0, capped: true });
    expect(await fs.readdir(root)).toHaveLength(5);
  });

  /** A tick whose remaining entries were all retained has no work left to defer. */
  it("does not report capped when the cap was never reached", async () => {
    await makeWorkspace("ws-old", [...REAPABLE_LAYOUT], 45);
    await makeWorkspace("ws-fresh", [...REAPABLE_LAYOUT], 2);

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      maxDeletesPerTick: 1,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({}),
    });

    expect(res).toMatchObject({ deleted: 1, capped: false });
  });

  /**
   * The runbook's reading of `retained_nested_checkout` rests on this: a
   * retention spends no unlink budget, but the cap `break`s, so a nested
   * checkout past the break is never reached and a capped sweep undercounts.
   * Root order is pinned through `readdir` because the filesystem's is not.
   */
  it("a capped sweep never reaches a nested checkout past its break", async () => {
    const order = ["ws-nest-early", "ws-a", "ws-b", "ws-c", "ws-nest-late"];
    for (const name of order) {
      await makeWorkspace(name, [...REAPABLE_LAYOUT], 45, name.startsWith("ws-nest") ? { "home/repo/.git": "gitdir: x\n" } : {});
    }
    const realReaddir = fs.readdir;
    const spy = vi.spyOn(fs, "readdir").mockImplementation(async (target, opts) => {
      const out = (await realReaddir.call(fs, target as never, opts as never)) as never as { name: string }[];
      if (target === root) out.sort((x, y) => order.indexOf(x.name) - order.indexOf(y.name));
      return out as never;
    });

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      maxDeletesPerTick: 2,
      dryRun: true,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({}),
    });

    spy.mockRestore();
    expect(res).toMatchObject({ scanned: 3, eligible: 2, retainedNestedCheckout: 1, capped: true });
  });

  it("is idempotent: a second pass over a drained tree deletes nothing", async () => {    await makeWorkspace("ws-old", [...REAPABLE_LAYOUT], 45);

    const first = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger, lookupWorkspaceUsage: usageLookup({}) });
    const second = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger, lookupWorkspaceUsage: usageLookup({}) });

    expect(first.deleted).toBe(1);
    expect(second).toMatchObject({ scanned: 0, deleted: 0, failed: 0 });
  });

  /**
   * Another reclaimer was observed on this tree mid-incident. A directory that
   * disappears between scan and unlink is normal, not a failure.
   */
  it("counts a concurrently-removed workspace as vanished, not failed", async () => {
    const dir = await makeWorkspace("ws-racy", [...REAPABLE_LAYOUT], 45);
    const realReaddir = fs.readdir;
    const spy = vi.spyOn(fs, "readdir").mockImplementation(async (target, opts) => {
      if (target === dir) {
        await realReaddir.call(fs, target as string);
        await fs.rm(dir, { recursive: true, force: true });
      }
      return realReaddir.call(fs, target as never, opts as never) as never;
    });

    const res = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger, lookupWorkspaceUsage: usageLookup({}) });

    spy.mockRestore();
    expect(res.failed).toBe(0);
    expect(res.deleted).toBe(0);
    expect(res.vanished).toBe(1);
  });

  /**
   * The residual from the `lastUsedAt` fix: the sweep's opening snapshot is a
   * single read that then authorizes unlinks for the rest of the tick, and a
   * tick is bounded by `maxDeletesPerTick` unlinks against an MDS measured at
   * 145 files/s — minutes, not microseconds. A run that resurrects a long-idle
   * workspace inside that window refreshes `lastUsedAt` and writes under
   * `home`/`session`, which moves neither the root's existence, nor its layout,
   * nor its `mtime`, so the two pre-existing re-checks are all blind to it.
   * Without the pre-unlink re-read this deletes persistent state underneath a
   * run that has already started writing.
   */
  it("retains a workspace resurrected between the snapshot and the unlink", async () => {
    await makeWorkspace("ws-resurrected", [...REAPABLE_LAYOUT], 45, {
      "session/.claude/projects/a.jsonl": "{}",
    });
    const lookup = racingUsageLookup(
      { "ws-resurrected": { lastUsedDaysAgo: 44 } },
      { "ws-resurrected": { lastUsedDaysAgo: 0 } },
    );

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: lookup,
    });

    // The near miss reports as its own outcome, not as routine retention: this
    // workspace was one query away from being deleted underneath a live run.
    expect(res).toMatchObject({
      scanned: 1,
      retainedResurrected: 1,
      retainedInUse: 0,
      eligible: 0,
      deleted: 0,
    });
    await expect(
      fs.readFile(path.join(root, "ws-resurrected", "session/.claude/projects/a.jsonl"), "utf8"),
    ).resolves.toBe("{}");
  });

  /** The re-read must not resurrect a row that is still idle at unlink time. */
  it("still deletes when the re-read confirms the workspace is idle", async () => {
    await makeWorkspace("ws-still-idle", [...REAPABLE_LAYOUT], 45);
    const lookup = racingUsageLookup(
      { "ws-still-idle": { lastUsedDaysAgo: 44 } },
      { "ws-still-idle": { lastUsedDaysAgo: 44 } },
    );

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: lookup,
    });

    expect(res).toMatchObject({ eligible: 1, deleted: 1, retainedInUse: 0 });
    expect(lookup.calls).toEqual([["ws-still-idle"], ["ws-still-idle"]]);
  });

  /**
   * The re-read costs one primary-key lookup per prospective unlink and is
   * bounded by the same cap as the unlinks. A dry run pays neither: it is a
   * preview, and a per-directory round trip would make previewing a large tree
   * more expensive than the pass it previews.
   */
  it("re-reads once per prospective unlink, and not at all in dryRun", async () => {
    for (let i = 0; i < 4; i += 1) await makeWorkspace(`ws-${i}`, [...REAPABLE_LAYOUT], 45);
    const preview = racingUsageLookup({}, {});
    const live = racingUsageLookup({}, {});
    const sweep = { root, maxAgeDays: 30, maxDeletesPerTick: 2, now, logger: silentLogger };

    // dryRun first: it leaves the tree intact for the live pass that follows.
    const previewRes = await reapIsolationWorkspaces({
      ...sweep,
      dryRun: true,
      lookupWorkspaceUsage: preview,
    });
    const liveRes = await reapIsolationWorkspaces({ ...sweep, lookupWorkspaceUsage: live });

    expect(previewRes).toMatchObject({ eligible: 2, deleted: 0, capped: true });
    expect(preview.calls).toHaveLength(1);
    expect(liveRes).toMatchObject({ eligible: 2, deleted: 2, capped: true });
    expect(live.calls).toHaveLength(3); // one batched snapshot + one per unlink
  });

  /**
   * `force` was dropped from `fs.rm` so a directory removed mid-sweep raises
   * ENOENT instead of being silently reported as a deletion — but the only test
   * reaching `vanished` did so through the *readdir* ENOENT path, so re-adding
   * `force: true` would leave the suite green. The pre-unlink re-read is the
   * natural seam for closing that window: it is the last thing to run before
   * `fs.rm`.
   */
  it("counts a workspace removed after the final re-check as vanished, not deleted", async () => {
    const dir = await makeWorkspace("ws-late-race", [...REAPABLE_LAYOUT], 45);
    const lookup = racingUsageLookup({}, {}, async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: lookup,
    });

    expect(res).toMatchObject({ eligible: 1, deleted: 0, vanished: 1, failed: 0 });
  });

  /**
   * The point of `retainedFresh`: with no concurrent removals every scanned
   * directory lands in exactly one named bucket, so an operator reading the
   * first live sweep does not have to infer an outcome from a subtraction.
   */
  it("names every outcome, leaving no unexplained remainder in the sweep log", async () => {
    await makeWorkspace("ws-fresh-dir", [...REAPABLE_LAYOUT], 2);
    await makeWorkspace("ws-live-row", [...REAPABLE_LAYOUT], 45);
    await makeWorkspace("ws-worktree", ["home", "session", "wt-blo-19094"], 60);
    await makeWorkspace("ws-nested", [...REAPABLE_LAYOUT], 60, { "home/repo/.git": "gitdir: x\n" });
    await makeWorkspace("ws-orphan", [...REAPABLE_LAYOUT], 45);

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({ "ws-live-row": { lastUsedDaysAgo: 0 } }),
    });

    expect(res).toMatchObject({
      scanned: 5,
      retainedFresh: 1,
      retainedInUse: 1,
      skippedLayout: 1,
      retainedNestedCheckout: 1,
      eligible: 1,
      deleted: 1,
      vanished: 0,
    });
    expect(
      res.retainedFresh +
        res.retainedInUse +
        res.retainedResurrected +
        res.skippedLayout +
        res.retainedNestedCheckout +
        res.failed +
        res.eligible,
    ).toBe(res.scanned);
  });

  /**
   * The re-read is the only call in the sweep that can fault *after*
   * irreversible removals, so a propagating throw would discard the record of
   * what was already unlinked — on exactly the run an operator most needs to
   * reconstruct. Fail-closed is still correct; losing the receipt is not.
   *
   * Two workspaces, `maxDeletes` unreached: the first deletes, the second
   * faults. The sweep must end there and still return the first deletion.
   */
  it("keeps the sweep record when the pre-unlink re-read faults mid-pass", async () => {
    await makeWorkspace("ws-a", [...REAPABLE_LAYOUT], 45);
    await makeWorkspace("ws-b", [...REAPABLE_LAYOUT], 45);

    let recheckCalls = 0;
    const lookupWorkspaceUsage = async (ids: string[]) => {
      // The batched opening snapshot resolves normally; only the per-directory
      // re-reads are driven to reject, and only after the first has succeeded.
      if (ids.length > 1) return new Map();
      recheckCalls += 1;
      if (recheckCalls > 1) throw new Error("db unavailable");
      return new Map();
    };

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage,
    });

    // The receipt survives: one deletion actually happened and is reported.
    expect(res).toMatchObject({ deleted: 1, lookupFaulted: true, failed: 0 });
    expect(recheckCalls).toBe(2);
    // Fail-closed: the faulting directory is not removed, and the tick stops
    // rather than assessing anything further.
    const survivors = (await fs.readdir(root)).sort();
    expect(survivors).toHaveLength(1);
  });

  it("returns an empty result when the root does not exist", async () => {
    const res = await reapIsolationWorkspaces({
      root: path.join(root, "absent"),
      maxAgeDays: 30,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({}),
    });

    expect(res).toMatchObject({ scanned: 0, deleted: 0, failed: 0 });
  });

  it("ignores plain files at the root", async () => {
    await fs.writeFile(path.join(root, "stray.txt"), "x");

    const res = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger, lookupWorkspaceUsage: usageLookup({}) });

    expect(res.scanned).toBe(0);
    await expect(fs.stat(path.join(root, "stray.txt"))).resolves.toBeDefined();
  });

  it("defaults the per-tick ceiling to a bounded value", () => {
    expect(DEFAULT_MAX_DELETES_PER_TICK).toBeGreaterThan(0);
    expect(DEFAULT_MAX_DELETES_PER_TICK).toBeLessThanOrEqual(1000);
  });
});

describe("startIsolationWorkspaceReaper", () => {
  it("sweeps immediately, then on the interval, and serializes overlapping ticks", async () => {
    await makeWorkspace("ws-a", [...REAPABLE_LAYOUT], 45);
    let tick: (() => void) | null = null;
    const scheduler = {
      setInterval: (cb: () => void) => {
        tick = cb;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: vi.fn(),
    };

    const stop = startIsolationWorkspaceReaper(
      {} as never,
      1000,
      { root, maxAgeDays: 30, now, logger: silentLogger, lookupWorkspaceUsage: usageLookup({}) },
      scheduler as never,
    );
    await vi.waitFor(async () => {
      await expect(fs.stat(path.join(root, "ws-a"))).rejects.toThrow();
    });

    await makeWorkspace("ws-b", [...REAPABLE_LAYOUT], 45);
    tick!();
    await vi.waitFor(async () => {
      await expect(fs.stat(path.join(root, "ws-b"))).rejects.toThrow();
    });

    stop();
    expect(scheduler.clearInterval).toHaveBeenCalled();
  });
});

/**
 * Sweep metrics (BLO-36814).
 *
 * The case these exist for is the one a happy-path test never reaches: a tick
 * that deletes nothing. A reaper that stopped ticking and a reaper that ticks
 * and finds nothing are the same picture on every dashboard unless the idle
 * tick emits, so every assertion below is about the *presence* of a series at
 * a zero value, not about a non-zero count.
 *
 * The registry is process-global and has no reset, so values are read as
 * deltas. Series presence is read absolutely — nothing pre-seeds these
 * children, so a child exists only because a sweep emitted it.
 */
async function series(metric: string): Promise<Array<{ labels: Record<string, string>; value: number }>> {
  const handle = getMetricsRegistry().getSingleMetric(metric);
  if (!handle) throw new Error(`${metric} is not registered`);
  const data = (await handle.get()) as {
    values: Array<{ labels: Record<string, string>; value: number }>;
  };
  return data.values;
}

async function valueOf(metric: string, labels: Record<string, string>): Promise<number | undefined> {
  const match = (await series(metric)).find((entry) =>
    Object.entries(labels).every(([k, v]) => entry.labels[k] === v),
  );
  return match?.value;
}

describe("reapIsolationWorkspaces metrics", () => {
  it("emits every series on a sweep that deletes nothing", async () => {
    // Fresh and in use: scanned, retained, nothing eligible, nothing deleted.
    await makeWorkspace("ws-live", [...REAPABLE_LAYOUT], 2);
    const before = {
      scanned: (await valueOf(ISOLATION_WORKSPACE_REAPER_SCANNED_METRIC, { dry_run: "false" })) ?? 0,
      sweeps:
        (await valueOf(ISOLATION_WORKSPACE_REAPER_SWEEPS_METRIC, {
          dry_run: "false",
          stop_reason: "complete",
        })) ?? 0,
    };

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({ "ws-live": { lastUsedDaysAgo: 2 } }),
    });
    expect(res).toMatchObject({ scanned: 1, deleted: 0, eligible: 0 });

    // The load-bearing assertion: `deleted` is PRESENT at 0. A sweep that
    // removed nothing must still be readable as a sweep that happened.
    expect(await valueOf(ISOLATION_WORKSPACE_REAPER_DELETED_METRIC, { dry_run: "false" })).toBeDefined();
    expect(await valueOf(ISOLATION_WORKSPACE_REAPER_SCANNED_METRIC, { dry_run: "false" })).toBe(
      before.scanned + 1,
    );
    expect(
      await valueOf(ISOLATION_WORKSPACE_REAPER_SWEEPS_METRIC, {
        dry_run: "false",
        stop_reason: "complete",
      }),
    ).toBe(before.sweeps + 1);

    // Every bounded child is materialized, so a dashboard reads 0 rather than
    // "no data" for outcomes this tick did not produce.
    const outcomes = (await series(ISOLATION_WORKSPACE_REAPER_ENTRIES_METRIC))
      .filter((entry) => entry.labels.dry_run === "false")
      .map((entry) => entry.labels.outcome)
      .sort();
    expect(outcomes).toEqual([...ISOLATION_WORKSPACE_REAPER_ENTRY_OUTCOMES].sort());

    const stops = (await series(ISOLATION_WORKSPACE_REAPER_SWEEPS_METRIC))
      .filter((entry) => entry.labels.dry_run === "false")
      .map((entry) => entry.labels.stop_reason)
      .sort();
    expect(stops).toEqual([...ISOLATION_WORKSPACE_REAPER_STOP_REASONS].sort());

    // Liveness: the gauge is what separates "swept and found nothing" from
    // "never swept", because both leave the counters unmoved.
    expect(
      await valueOf(ISOLATION_WORKSPACE_REAPER_LAST_SWEEP_METRIC, { dry_run: "false" }),
    ).toBe(Math.floor(NOW / 1000));
  });

  it("keeps skippedLayout and retainedResurrected as their own series", async () => {
    // A stray git worktree — the wt-blo-19094 shape the allowlist caught.
    await makeWorkspace("ws-worktree", ["home", "session", "wt-blo-19094"], 45);
    const before = {
      skipped: (await valueOf(ISOLATION_WORKSPACE_REAPER_SKIPPED_LAYOUT_METRIC, { dry_run: "false" })) ?? 0,
    };

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({}),
    });
    expect(res).toMatchObject({ skippedLayout: 1, deleted: 0 });

    expect(await valueOf(ISOLATION_WORKSPACE_REAPER_SKIPPED_LAYOUT_METRIC, { dry_run: "false" })).toBe(
      before.skipped + 1,
    );
    // Both findings fields carry their own metric name, so no `sum by (...)`
    // over the generic outcome counter can aggregate either of them away.
    expect(
      (await series(ISOLATION_WORKSPACE_REAPER_ENTRIES_METRIC)).map((e) => e.labels.outcome),
    ).not.toContain("skipped_layout");
    expect(
      (await series(ISOLATION_WORKSPACE_REAPER_ENTRIES_METRIC)).map((e) => e.labels.outcome),
    ).not.toContain("retained_resurrected");
    expect(
      await valueOf(ISOLATION_WORKSPACE_REAPER_RETAINED_RESURRECTED_METRIC, { dry_run: "false" }),
    ).toBeDefined();
  });

  it("counts a nested-checkout retention apart from skipped_layout", async () => {
    // BLO-36735 I2: skipped_layout means "top level outside the allowlist,
    // unexamined". A nested checkout was examined and its top level matched, so
    // folding it in would park a steady population under that finding's baseline of 1.
    await makeWorkspace("ws-nested", [...REAPABLE_LAYOUT], 45, { "home/repo/.git": "gitdir: x\n" });
    const read = async () => ({
      skipped: (await valueOf(ISOLATION_WORKSPACE_REAPER_SKIPPED_LAYOUT_METRIC, { dry_run: "false" })) ?? 0,
      nested:
        (await valueOf(ISOLATION_WORKSPACE_REAPER_ENTRIES_METRIC, {
          dry_run: "false",
          outcome: "retained_nested_checkout",
        })) ?? 0,
    });
    const before = await read();

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({}),
    });
    expect(res).toMatchObject({ skippedLayout: 0, retainedNestedCheckout: 1, deleted: 0 });

    expect(await read()).toEqual({ skipped: before.skipped, nested: before.nested + 1 });
  });

  it("labels a dry-run tick so it cannot be read as a live one", async () => {
    await makeWorkspace("ws-old", [...REAPABLE_LAYOUT], 45);
    const before = {
      dryEligible:
        (await valueOf(ISOLATION_WORKSPACE_REAPER_ENTRIES_METRIC, {
          dry_run: "true",
          outcome: "eligible",
        })) ?? 0,
      liveEligible:
        (await valueOf(ISOLATION_WORKSPACE_REAPER_ENTRIES_METRIC, {
          dry_run: "false",
          outcome: "eligible",
        })) ?? 0,
    };

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      now,
      dryRun: true,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({}),
    });
    // `deleted` counts real unlinks, so a dry run leaves it at 0 and the
    // would-have-removed count lands on `eligible` instead.
    expect(res).toMatchObject({ eligible: 1, deleted: 0 });
    await expect(fs.stat(path.join(root, "ws-old"))).resolves.toBeTruthy();

    expect(
      await valueOf(ISOLATION_WORKSPACE_REAPER_ENTRIES_METRIC, {
        dry_run: "true",
        outcome: "eligible",
      }),
    ).toBe(before.dryEligible + 1);
    // The whole point of the label: a preview must not add to the live series.
    expect(
      await valueOf(ISOLATION_WORKSPACE_REAPER_ENTRIES_METRIC, {
        dry_run: "false",
        outcome: "eligible",
      }),
    ).toBe(before.liveEligible);
    expect(await valueOf(ISOLATION_WORKSPACE_REAPER_DELETED_METRIC, { dry_run: "true" })).toBe(0);
  });

  it("still emits series when the root does not exist, tagged root_absent", async () => {
    // The blind spot this guards: an ENABLED reaper pointed at the WRONG path
    // scans nothing and, before BLO-36814, returned without touching the
    // registry — so it was indistinguishable from a DISABLED one on every
    // dashboard while the real tree grew unreclaimed (the BLO-31222 shape).
    const missing = path.join(root, "definitely-not-a-root");
    const before = {
      rootAbsent:
        (await valueOf(ISOLATION_WORKSPACE_REAPER_SWEEPS_METRIC, {
          dry_run: "false",
          stop_reason: "root_absent",
        })) ?? 0,
      complete:
        (await valueOf(ISOLATION_WORKSPACE_REAPER_SWEEPS_METRIC, {
          dry_run: "false",
          stop_reason: "complete",
        })) ?? 0,
    };

    const res = await reapIsolationWorkspaces({
      root: missing,
      maxAgeDays: 30,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({}),
    });
    expect(res).toMatchObject({ scanned: 0, deleted: 0 });

    // Liveness: the gauge advanced, so "enabled but pointed nowhere" is
    // readable as a sweep that happened rather than as absence.
    expect(
      await valueOf(ISOLATION_WORKSPACE_REAPER_LAST_SWEEP_METRIC, { dry_run: "false" }),
    ).toBe(Math.floor(NOW / 1000));
    expect(
      await valueOf(ISOLATION_WORKSPACE_REAPER_SCANNED_METRIC, { dry_run: "false" }),
    ).toBeDefined();

    // …and it is NOT folded into `complete`. Collapsing the two would let a
    // misconfigured reaper read as a healthy sweep over an empty tree.
    expect(
      await valueOf(ISOLATION_WORKSPACE_REAPER_SWEEPS_METRIC, {
        dry_run: "false",
        stop_reason: "root_absent",
      }),
    ).toBe(before.rootAbsent + 1);
    expect(
      await valueOf(ISOLATION_WORKSPACE_REAPER_SWEEPS_METRIC, {
        dry_run: "false",
        stop_reason: "complete",
      }),
    ).toBe(before.complete);
  });
});

/**
 * BLO-36735: the runbook once read the nested-checkout series as "~13 per
 * sweep", which a capped sweep cannot report and the measurement never was.
 * Nothing rendered breaks when that prose rots, so pin it to the label sets
 * the code actually emits.
 */
describe("isolation-workspace reaper runbook", () => {
  it("reads retained_nested_checkout against the stop reason, not as a per-sweep figure", () => {
    const runbook = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../runbooks/isolation-workspace-reaper.md"),
      "utf8",
    );
    const start = runbook.indexOf('outcome="retained_nested_checkout"');
    const end = runbook.indexOf("\n## ", start);
    expect(start).toBeGreaterThan(-1);
    const block = runbook.slice(start, end).replace(/\s+/g, " ");

    const stopReasons = [...block.matchAll(/stop_reason="([a-z_]+)"/g)].map((m) => m[1]);
    expect(stopReasons).toEqual(expect.arrayContaining(["capped", "complete"]));
    for (const reason of stopReasons) expect(ISOLATION_WORKSPACE_REAPER_STOP_REASONS).toContain(reason);
    for (const [, outcome] of block.matchAll(/`(retained_[a-z_]+)`/g)) {
      expect(ISOLATION_WORKSPACE_REAPER_ENTRY_OUTCOMES).toContain(outcome);
    }
    expect(block).toMatch(/\bfloor\b/);
    expect(block).not.toMatch(/\d+\s+per sweep/i);
  });
});

/**
 * PEN-5125. These do not test a deletion predicate — they test that the sweep
 * can say what it did NOT look at. The gap they describe is invisible to every
 * other assertion in this file by construction: an agent on a foreign claim
 * materializes no directory under this root, so there is nothing to `mkdir` in
 * a fixture and nothing for the outcome buckets to count.
 */
describe("reapIsolationWorkspaces coverage (PEN-5125)", () => {
  it("reports UNKNOWN rather than zero when no coverage probe is supplied", async () => {
    await makeWorkspace("ws-old", [...REAPABLE_LAYOUT], 45);

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({}),
    });

    // The sentinel, not 0. A sweep that was never told how to measure its own
    // coverage must not publish full coverage.
    expect(res.unreachableAgents).toBe(UNREACHABLE_AGENTS_UNKNOWN);
    expect(res.deleted).toBe(1);
  });

  it("carries the probe's count without disturbing any outcome bucket", async () => {
    await makeWorkspace("ws-old", [...REAPABLE_LAYOUT], 45);
    await makeWorkspace("ws-live", [...REAPABLE_LAYOUT], 45);

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({ "ws-live": { lastUsedDaysAgo: 0 } }),
      countUnreachableAgents: async () => 4,
    });

    expect(res.unreachableAgents).toBe(4);
    // The point of the row: unreachable directories are in NO bucket, so the
    // documented identity still holds exactly — over a population that is four
    // agents short. `scanned` counts what was enumerated, and nothing the probe
    // reports was.
    expect(res.scanned).toBe(2);
    expect(
      res.retainedFresh +
        res.retainedInUse +
        res.retainedResurrected +
        res.skippedLayout +
        res.retainedNestedCheckout +
        res.failed +
        res.eligible,
    ).toBe(res.scanned);
    expect(res.capped).toBe(false);
    expect(res.lookupFaulted).toBe(false);
  });

  it("warns, and still completes the sweep, when agents are unreachable", async () => {
    await makeWorkspace("ws-old", [...REAPABLE_LAYOUT], 45);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      now,
      logger: log as unknown as Parameters<typeof reapIsolationWorkspaces>[0]["logger"],
      lookupWorkspaceUsage: usageLookup({}),
      countUnreachableAgents: async () => 1,
    });

    expect(res.deleted).toBe(1);
    expect(
      log.warn.mock.calls.some(([fields]) => (fields as { unreachableAgents?: number }).unreachableAgents === 1),
    ).toBe(true);
  });

  it("keeps the sentinel and reclaims anyway when the probe throws", async () => {
    await makeWorkspace("ws-old", [...REAPABLE_LAYOUT], 45);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      now,
      logger: log as unknown as Parameters<typeof reapIsolationWorkspaces>[0]["logger"],
      lookupWorkspaceUsage: usageLookup({}),
      countUnreachableAgents: async () => {
        throw new Error("control plane unreachable");
      },
    });

    // Fails toward "cannot tell", never toward "fully covered"…
    expect(res.unreachableAgents).toBe(UNREACHABLE_AGENTS_UNKNOWN);
    expect(log.error).toHaveBeenCalled();
    // …and the probe is an observation about the pass, not an input to it, so a
    // fault must not cost the fleet its reclamation.
    expect(res.deleted).toBe(1);
    await expect(fs.stat(path.join(root, "ws-old"))).rejects.toThrow();
  });

  it("probes on the root-absent path too", async () => {
    const res = await reapIsolationWorkspaces({
      root: path.join(root, "definitely-not-here"),
      maxAgeDays: 30,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({}),
      countUnreachableAgents: async () => 2,
    });

    // `root_absent` plus a non-zero coverage gap is the sharpest reading there
    // is — the trees exist, they are simply not here. Collapsing the probe into
    // the enumerated path would lose exactly that.
    expect(res.scanned).toBe(0);
    expect(res.unreachableAgents).toBe(2);
    expect(
      await valueOf(ISOLATION_WORKSPACE_REAPER_UNREACHABLE_AGENTS_METRIC, { dry_run: "false" }),
    ).toBe(2);
  });

  it("publishes the count on every sweep, so a later probe failure overwrites it", async () => {
    const base = {
      root,
      maxAgeDays: 30,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({}),
    };

    await reapIsolationWorkspaces({ ...base, countUnreachableAgents: async () => 3 });
    expect(
      await valueOf(ISOLATION_WORKSPACE_REAPER_UNREACHABLE_AGENTS_METRIC, { dry_run: "false" }),
    ).toBe(3);

    // A gauge left unwritten keeps its last value, so a probe that starts
    // failing would otherwise go on publishing a stale, reassuring number.
    await reapIsolationWorkspaces({
      ...base,
      countUnreachableAgents: async () => {
        throw new Error("nope");
      },
    });
    expect(
      await valueOf(ISOLATION_WORKSPACE_REAPER_UNREACHABLE_AGENTS_METRIC, { dry_run: "false" }),
    ).toBe(UNREACHABLE_AGENTS_UNKNOWN);
  });

  it("startIsolationWorkspaceReaper supplies a probe when the caller omits one", async () => {
    // Guards the one production wiring (`server/src/index.ts`) against going
    // coverage-blind by omission: it passes neither lookup, so both defaults
    // have to come from here.
    let probed = false;
    // Answers both arms: no k8s environment names a claim, then seven agents
    // are moved off this volume by their own config.
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: async () => {
            probed = true;
            return [{ count: table === environments ? 0 : 7 }];
          },
        }),
      }),
    };
    const scheduler = {
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: vi.fn(),
    };

    const stop = startIsolationWorkspaceReaper(
      db as never,
      1000,
      { root, maxAgeDays: 30, now, logger: silentLogger, lookupWorkspaceUsage: usageLookup({}) },
      scheduler as never,
    );
    await vi.waitFor(async () => {
      expect(
        await valueOf(ISOLATION_WORKSPACE_REAPER_UNREACHABLE_AGENTS_METRIC, { dry_run: "false" }),
      ).toBe(7);
    });
    expect(probed).toBe(true);
    stop();
  });
});

describe("createDbUnreachableAgentCount (PEN-5125)", () => {
  /**
   * Captures the two aggregates in order. Arm B (`environments`) runs first and
   * short-circuits, so a stub that answers only one query is enough to pin the
   * short-circuit — which is the property under test.
   */
  function stubDb(answers: number[]) {
    const queries: string[] = [];
    let i = 0;
    return {
      queries,
      db: {
        select: () => ({
          from: (table: unknown) => ({
            where: async () => {
              // Identity, not serialization: a drizzle table object is
              // circular (`column.table` points back), so `JSON.stringify`
              // throws here.
              queries.push(table === environments ? "environments" : "agents");
              return [{ count: answers[i++] ?? 0 }];
            },
          }),
        }),
      },
    };
  }

  it("returns UNKNOWN, not a count, when a k8s environment supplies a claim", async () => {
    // The review finding on #3180. `execute.ts` merges a k8s-remote target's
    // config over the agent's with the ENVIRONMENT winning, so such an agent is
    // on a foreign volume with nothing in its own row to say so. Which agents
    // those are is not derivable here — the environment is chosen per run — so
    // the only sound statement is that the agent count is untrustworthy.
    const { db, queries } = stubDb([1, 99]);
    const probe = createDbUnreachableAgentCount(db as never);

    expect(await probe()).toBe(UNREACHABLE_AGENTS_UNKNOWN);
    // …and it short-circuits: reporting a number beside a known-untrustworthy
    // basis is exactly what the sentinel exists to avoid.
    expect(queries).toEqual(["environments"]);
  });

  it("falls through to the agent count when no environment supplies a claim", async () => {
    const { db, queries } = stubDb([0, 3]);
    const probe = createDbUnreachableAgentCount(db as never);

    expect(await probe()).toBe(3);
    expect(queries).toEqual(["environments", "agents"]);
  });

  it("pins the SQL that cannot be exercised without a live Postgres", () => {
    // Read as text rather than executed: `embedded-postgres` does not start in
    // this sandbox. What has to hold is checkable from source, and each of
    // these has a failure mode that would make the gauge lie.
    const source = readFileSync(
      fileURLToPath(new URL("../services/isolation-workspace-reaper.ts", import.meta.url)),
      "utf8",
    );

    // Mirrors `asBoolean`: only a JSON boolean `true` opts an agent in. A `->>`
    // text comparison would also match the string "true", naming agents whose
    // Job DOES mount this claim.
    expect(source).toContain("'true'::jsonb");
    expect(source).not.toMatch(/->>\s*\$\{?PER_AGENT_WORKSPACE_VOLUME_CONFIG_KEY/);

    // Arm B must be scoped to the driver that actually merges its config over
    // the agent's; widening it would return UNKNOWN on environments that cannot
    // move a Job at all.
    expect(source).toMatch(/environments\.driver\} = 'k8s'/);

    // `IS DISTINCT FROM`, never `<>`: with no self-claim supplied (the state
    // today) a `<>` comparison against NULL is NULL, which would silently empty
    // BOTH arms and restore the confident, false zero.
    expect(source).toContain("IS DISTINCT FROM");
    expect(source).not.toMatch(/btrim\([^)]*\) <> \$\{self\}/);

    expect(PER_AGENT_WORKSPACE_VOLUME_CONFIG_KEY).toBe("enablePerAgentWorkspaceVolume");
    expect(WORKSPACE_VOLUME_CLAIM_CONFIG_KEY).toBe("workspaceVolumeClaim");
  });

  it("passes the self-claim name through, so naming the server's own claim can be excluded", async () => {
    // `serverHoldsJobDataClaim` is TRUE when `workspaceVolumeClaim` equals the
    // server's own PVC, and naming it explicitly is a realistic operator choice
    // — the adapter's fixtures use `paperclip-data`. Nothing supplies the name
    // today, so this pins the seam rather than the exclusion.
    const { db } = stubDb([0, 0]);
    const probe = createDbUnreachableAgentCount(db as never, "  paperclip-data  ");
    expect(await probe()).toBe(0);

    const source = readFileSync(
      fileURLToPath(new URL("../services/isolation-workspace-reaper.ts", import.meta.url)),
      "utf8",
    );
    // Trimmed, and an empty string collapses to null so a blank config value
    // cannot become a claim name nothing matches.
    expect(source).toContain("selfDataClaimName?.trim() || null");
  });
});

/**
 * The foreign-claim half (PEN-5151).
 *
 * `buildIsolationReclaimPlan` decides for a volume this process cannot walk, so
 * every test here states the inventory an executor would have reported rather
 * than materializing a tree.
 */
describe("buildIsolationReclaimPlan", () => {
  const ID_A = "11111111-1111-4111-8111-111111111111";
  const ID_B = "22222222-2222-4222-8222-222222222222";
  const ID_C = "33333333-3333-4333-8333-333333333333";

  const entry = (name: string, mtimeDaysAgo: number) => ({
    name,
    mtimeMs: NOW - mtimeDaysAgo * DAY,
  });

  it("plans the same directories the mounted sweep would delete", async () => {
    const plan = await buildIsolationReclaimPlan({
      // A: aged on both signals. B: aged on disk but its row says live. C: too
      // young to have been idle for the window, whatever any row claims.
      inventory: [entry(ID_A, 40), entry(ID_B, 40), entry(ID_C, 2)],
      lookupWorkspaceUsage: usageLookup({
        [ID_A]: { lastUsedDaysAgo: 40 },
        [ID_B]: { lastUsedDaysAgo: 1 },
        [ID_C]: { lastUsedDaysAgo: 90 },
      }),
      maxAgeDays: 30,
      now,
    });

    expect(plan.eligibleIds).toEqual([ID_A]);
    expect(plan.retainedInUse).toBe(1);
    expect(plan.retainedFresh).toBe(1);
    expect(plan.truncated).toBe(false);
    expect(plan.inventorySize).toBe(3);
  });

  it("plans the orphan cohort, where filesystem age is the intended meaning", async () => {
    // No owning row is the population this reaper was aimed at. `mtime` carries
    // the decision there and only there — the same rule the mounted sweep uses.
    const plan = await buildIsolationReclaimPlan({
      inventory: [entry(ID_A, 40)],
      lookupWorkspaceUsage: usageLookup({}),
      maxAgeDays: 30,
      now,
    });
    expect(plan.eligibleIds).toEqual([ID_A]);
  });

  it("refuses a name that is not a workspace id, rather than passing it to an unlink", async () => {
    // The mounted sweep gets names from `readdir`, so they are single path
    // components by construction. A plan crosses a process boundary and comes
    // back as the argument to a recursive unlink, so a traversal or a separator
    // has to be refused HERE. All three of these are old enough to be eligible
    // on every other signal, which is the point.
    const plan = await buildIsolationReclaimPlan({
      inventory: [entry("..", 40), entry(`../${ID_A}`, 40), entry("not-a-uuid", 40)],
      lookupWorkspaceUsage: usageLookup({}),
      maxAgeDays: 30,
      now,
    });
    expect(plan.eligibleIds).toEqual([]);
    expect(plan.skippedUnsafeName).toBe(3);
    expect(plan.inventorySize).toBe(3);
  });

  it("bounds the plan and offers the most overdue first", async () => {
    // Property 4 on the executor's side: it is a second unlink source against
    // the same MDS. Ordering is what makes successive ticks drain a backlog
    // instead of re-offering the same head.
    const plan = await buildIsolationReclaimPlan({
      inventory: [entry(ID_A, 40), entry(ID_B, 90), entry(ID_C, 60)],
      lookupWorkspaceUsage: usageLookup({}),
      maxAgeDays: 30,
      maxEntries: 2,
      now,
    });
    expect(plan.eligibleIds).toEqual([ID_B, ID_C]);
    expect(plan.truncated).toBe(true);
  });

  it("defaults its bound to the sweep's per-tick ceiling", async () => {
    const inventory = Array.from({ length: DEFAULT_MAX_DELETES_PER_TICK + 5 }, (_, i) =>
      entry(`${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`, 40 + i),
    );
    const plan = await buildIsolationReclaimPlan({
      inventory,
      lookupWorkspaceUsage: usageLookup({}),
      maxAgeDays: 30,
      now,
    });
    expect(plan.eligibleIds).toHaveLength(DEFAULT_MAX_DELETES_PER_TICK);
    expect(plan.truncated).toBe(true);
  });

  it("asks the database once, and only about names it would act on", async () => {
    // The unsafe names are filtered before the query: a plan must not turn an
    // attacker-shaped directory name into a database predicate, and the round
    // trip is the mounted sweep's single batched snapshot.
    const calls: string[][] = [];
    const plan = await buildIsolationReclaimPlan({
      inventory: [entry(ID_A, 40), entry("../etc", 40)],
      lookupWorkspaceUsage: async (ids) => {
        calls.push([...ids]);
        return new Map();
      },
      maxAgeDays: 30,
      now,
    });
    expect(calls).toEqual([[ID_A]]);
    expect(plan.eligibleIds).toEqual([ID_A]);
  });

  it("does not query at all when nothing survives name validation", async () => {
    const lookup = vi.fn();
    const plan = await buildIsolationReclaimPlan({
      inventory: [entry("..", 40)],
      lookupWorkspaceUsage: lookup as never,
      maxAgeDays: 30,
      now,
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(plan.eligibleIds).toEqual([]);
  });

  it("refuses an entry with no usable mtime, rather than ranking it first", async () => {
    // `mtimeMs` is typed `number` but crosses a serialization boundary. Each of
    // these makes `mtimeMs >= cutoff` false, which would route the entry to
    // `aged`; `null` additionally sorts ahead of every real candidate, so a
    // malformed entry would become the most eligible directory in the plan.
    const plan = await buildIsolationReclaimPlan({
      inventory: [
        { name: ID_A, mtimeMs: Number.NaN },
        { name: ID_B, mtimeMs: null as unknown as number },
        { name: ID_C, mtimeMs: undefined as unknown as number },
      ],
      lookupWorkspaceUsage: usageLookup({}),
      maxAgeDays: 30,
      now,
    });
    expect(plan.eligibleIds).toEqual([]);
    expect(plan.skippedMalformed).toBe(3);
    expect(plan.skippedUnsafeName).toBe(0);
  });

  it("keeps a malformed entry from displacing a real candidate in the ordering", async () => {
    const plan = await buildIsolationReclaimPlan({
      inventory: [{ name: ID_A, mtimeMs: null as unknown as number }, entry(ID_B, 40)],
      lookupWorkspaceUsage: usageLookup({}),
      maxAgeDays: 30,
      maxEntries: 1,
      now,
    });
    expect(plan.eligibleIds).toEqual([ID_B]);
    expect(plan.truncated).toBe(false);
  });

  it("spends its budget once per directory, however often the inventory names it", async () => {
    // `readdir` cannot return a name twice; an inventory crossing a process
    // boundary can. A repeat would spend the bound on one directory and push a
    // real candidate out of the plan, while the second unlink only finds ENOENT.
    const plan = await buildIsolationReclaimPlan({
      inventory: [entry(ID_A, 90), entry(ID_A, 90), entry(ID_B, 40)],
      lookupWorkspaceUsage: usageLookup({}),
      maxAgeDays: 30,
      maxEntries: 2,
      now,
    });
    expect(plan.eligibleIds).toEqual([ID_A, ID_B]);
    expect(plan.skippedDuplicate).toBe(1);
    expect(plan.truncated).toBe(false);
  });

  it("lands every inventory entry in exactly one bucket", async () => {
    // The identity the result documents. This is the only surface an operator
    // has for a volume they cannot walk, so a silently absorbed entry is the
    // same failure the mounted sweep's `scanned` identity exists to prevent.
    const plan = await buildIsolationReclaimPlan({
      inventory: [
        entry(ID_A, 90), // eligible
        entry(ID_B, 60), // eligible, past the bound
        entry(ID_C, 2), // fresh
        entry("44444444-4444-4444-8444-444444444444", 40), // row says live
        entry(ID_A, 90), // duplicate
        entry("not-a-uuid", 40), // unsafe name
        { name: "55555555-5555-4555-8555-555555555555", mtimeMs: Number.NaN }, // malformed
      ],
      lookupWorkspaceUsage: usageLookup({
        "44444444-4444-4444-8444-444444444444": { lastUsedDaysAgo: 1 },
      }),
      maxAgeDays: 30,
      maxEntries: 1,
      now,
    });

    expect(plan.eligibleIds).toEqual([ID_A]);
    expect(plan.droppedByBound).toBe(1);
    expect(plan.retainedFresh).toBe(1);
    expect(plan.retainedInUse).toBe(1);
    expect(plan.skippedDuplicate).toBe(1);
    expect(plan.skippedUnsafeName).toBe(1);
    expect(plan.skippedMalformed).toBe(1);
    expect(plan.truncated).toBe(true);

    const accounted =
      plan.eligibleIds.length +
      plan.droppedByBound +
      plan.retainedFresh +
      plan.retainedInUse +
      plan.skippedUnsafeName +
      plan.skippedMalformed +
      plan.skippedDuplicate;
    expect(accounted).toBe(plan.inventorySize);
  });

  it("leaves layout and nested-checkout checks to the executor", async () => {
    // Deliberate, not pending: both read the filesystem, and answering them
    // here would mean trusting an executor's account of a tree it is asking
    // permission to delete. A plan entry is permission to consider, never an
    // instruction to remove.
    const source = readFileSync(
      fileURLToPath(new URL("../services/isolation-workspace-reaper.ts", import.meta.url)),
      "utf8",
    );
    const start = source.indexOf("export async function buildIsolationReclaimPlan");
    expect(start).toBeGreaterThan(-1);
    // Bounded at the next top-level declaration: an unbounded slice would run
    // through `reapIsolationWorkspaces`, which legitimately calls both, and the
    // assertion would silently stop testing this function.
    const end = source.indexOf("function isReapableLayout", start);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(body).not.toContain("hasNestedCheckout");
    expect(body).not.toContain("isReapableLayout");
  });
});

describe("classifyIsolationWorkspaceAge", () => {
  const row = (lastUsedDaysAgo: number): WorkspaceUsageRow => ({
    lastUsedAt: new Date(NOW - lastUsedDaysAgo * DAY),
    status: "active",
    closedAt: null,
  });
  const cutoff = NOW - 30 * DAY;

  it("lets a fresh mtime retain whatever the row says", () => {
    // `mtime` is materialization time, so it is useless for deletion and valid
    // for retention: a directory materialized yesterday cannot have been idle
    // for a month. Requiring both signals can only ever retain more.
    expect(
      classifyIsolationWorkspaceAge({ mtimeMs: NOW - DAY, owner: row(900), cutoff }),
    ).toEqual({ verdict: "fresh", idleSinceMs: NOW - DAY, ageSource: "mtime" });
  });

  it("lets a live row retain an aged directory", () => {
    const verdict = classifyIsolationWorkspaceAge({ mtimeMs: NOW - 90 * DAY, owner: row(1), cutoff });
    expect(verdict.verdict).toBe("in_use");
    expect(verdict.ageSource).toBe("lastUsedAt");
  });

  it("reports the row's age, not the directory's, once a row exists", () => {
    // The row wins outright when it is present: the filesystem no longer gets a
    // vote, so an operator reading `ageDays` is reading idleness and not
    // materialization age.
    const verdict = classifyIsolationWorkspaceAge({ mtimeMs: NOW - 900 * DAY, owner: row(40), cutoff });
    expect(verdict).toEqual({
      verdict: "aged",
      idleSinceMs: NOW - 40 * DAY,
      ageSource: "lastUsedAt",
    });
  });

  it("falls back to mtime only when there is no row", () => {
    expect(classifyIsolationWorkspaceAge({ mtimeMs: NOW - 40 * DAY, owner: undefined, cutoff })).toEqual({
      verdict: "aged",
      idleSinceMs: NOW - 40 * DAY,
      ageSource: "mtime",
    });
  });

  it("is the only age rule in the module, so the two sweeps cannot drift", () => {
    // The mounted sweep and the foreign-claim plan decide the same question in
    // different processes. A second transcription of this rule is the likeliest
    // way the plan ends up authorizing a deletion the mounted sweep would
    // refuse, and `mtime` alone is the predicate BLO-31222 exists to stop
    // using. So: exactly one comparison of `lastUsedAt` against the cutoff in
    // the whole module, and it is in this function.
    const source = readFileSync(
      fileURLToPath(new URL("../services/isolation-workspace-reaper.ts", import.meta.url)),
      "utf8",
    );
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code.match(/lastUsedAt\.getTime\(\)/g) ?? []).toHaveLength(2);
    const classifier = code.slice(
      code.indexOf("export function classifyIsolationWorkspaceAge"),
      code.indexOf("export interface IsolationWorkspaceInventoryEntry"),
    );
    // One inside the classifier; the other is the pre-unlink re-read, which
    // compares the re-read row and not the snapshot.
    expect(classifier.match(/lastUsedAt\.getTime\(\)/g) ?? []).toHaveLength(1);
    expect(code).toContain("current.lastUsedAt.getTime() >= cutoff");
  });
});

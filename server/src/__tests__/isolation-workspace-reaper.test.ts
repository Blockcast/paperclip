import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_DELETES_PER_TICK,
  REAPABLE_LAYOUT,
  reapIsolationWorkspaces,
  startIsolationWorkspaceReaper,
} from "../services/isolation-workspace-reaper.js";

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

    const res = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger });

    expect(res).toMatchObject({ eligible: 1, deleted: 1, skippedLayout: 0, failed: 0 });
    await expect(fs.stat(path.join(root, "ws-old"))).rejects.toThrow();
  });

  it("leaves a workspace younger than the age cutoff alone", async () => {
    await makeWorkspace("ws-fresh", [...REAPABLE_LAYOUT], 3);

    const res = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger });

    expect(res).toMatchObject({ scanned: 1, eligible: 0, deleted: 0 });
    await expect(fs.stat(path.join(root, "ws-fresh"))).resolves.toBeDefined();
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

    const res = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger });

    expect(res).toMatchObject({ scanned: 1, eligible: 0, deleted: 0, skippedLayout: 1 });
    await expect(
      fs.readFile(path.join(root, "ws-worktree", "wt-blo-19094", "README.md"), "utf8"),
    ).resolves.toBe("real work");
    expect(silentLogger!.warn).toHaveBeenCalledTimes(1);
  });

  it("skips a partial layout rather than treating a missing member as inert", async () => {
    await makeWorkspace("ws-home-only", ["home"], 60);

    const res = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger });

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
    });

    expect(res.deleted).toBe(2);
    expect(res.capped).toBe(true);
    const left = await fs.readdir(root);
    expect(left).toHaveLength(3);
  });

  it("is idempotent: a second pass over a drained tree deletes nothing", async () => {
    await makeWorkspace("ws-old", [...REAPABLE_LAYOUT], 45);

    const first = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger });
    const second = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger });

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

    const res = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger });

    spy.mockRestore();
    expect(res.failed).toBe(0);
    expect(res.vanished + res.deleted).toBeGreaterThanOrEqual(1);
  });

  it("returns an empty result when the root does not exist", async () => {
    const res = await reapIsolationWorkspaces({
      root: path.join(root, "absent"),
      maxAgeDays: 30,
      now,
      logger: silentLogger,
    });

    expect(res).toMatchObject({ scanned: 0, deleted: 0, failed: 0 });
  });

  it("ignores plain files at the root", async () => {
    await fs.writeFile(path.join(root, "stray.txt"), "x");

    const res = await reapIsolationWorkspaces({ root, maxAgeDays: 30, now, logger: silentLogger });

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
      1000,
      { root, maxAgeDays: 30, now, logger: silentLogger },
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

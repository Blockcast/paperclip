import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_DELETES_PER_TICK,
  REAPABLE_LAYOUT,
  type WorkspaceUsageLookup,
  type WorkspaceUsageRow,
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
    await makeWorkspace("ws-orphan", [...REAPABLE_LAYOUT], 45);

    const res = await reapIsolationWorkspaces({
      root,
      maxAgeDays: 30,
      now,
      logger: silentLogger,
      lookupWorkspaceUsage: usageLookup({ "ws-live-row": { lastUsedDaysAgo: 0 } }),
    });

    expect(res).toMatchObject({
      scanned: 4,
      retainedFresh: 1,
      retainedInUse: 1,
      skippedLayout: 1,
      eligible: 1,
      deleted: 1,
      vanished: 0,
    });
    expect(
      res.retainedFresh +
        res.retainedInUse +
        res.retainedResurrected +
        res.skippedLayout +
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

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HEAP_SNAPSHOT_EXTENSION,
  HEAP_SNAPSHOT_SENTINEL_BASENAME,
  type HeapSnapshotConfig,
  type HeapSnapshotRuntime,
  decideHeapSnapshot,
  ensureHeapSnapshotDir,
  pruneHeapSnapshots,
  takeHeapSnapshot,
} from "../services/heap-snapshot.js";

const GB = 1024 * 1024 * 1024;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "heap-snapshot-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function config(overrides: Partial<HeapSnapshotConfig> = {}): HeapSnapshotConfig {
  return {
    dir,
    keep: 2,
    minFreeBytes: 10 * GB,
    autoThresholdBytes: 0,
    autoMinIntervalMs: 2 * 60 * 60 * 1000,
    sentinelMinIntervalMs: 5 * 60 * 1000,
    ...overrides,
  };
}

function runtime(overrides: Partial<HeapSnapshotRuntime> = {}): HeapSnapshotRuntime {
  return {
    now: () => new Date("2026-09-29T23:00:00.000Z"),
    heapUsedBytes: () => GB,
    // Stand in for v8.writeHeapSnapshot: writes at the path it is handed, which is
    // what lets the partial-then-rename contract be asserted without a real snapshot.
    writeSnapshot: (filePath: string) => {
      writeFileSync(filePath, "{}");
      return filePath;
    },
    freeBytes: () => 100 * GB,
    ...overrides,
  };
}

function state(
  overrides: Partial<{ lastAutoSnapshotAtMs: number | null; lastSentinelSnapshotAtMs: number | null }> = {},
): { lastAutoSnapshotAtMs: number | null; lastSentinelSnapshotAtMs: number | null } {
  return { lastAutoSnapshotAtMs: null, lastSentinelSnapshotAtMs: null, ...overrides };
}

function writeSnapshotFile(name: string, mtimeSeconds: number): void {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, "{}");
  utimesSync(filePath, mtimeSeconds, mtimeSeconds);
}

describe("pruneHeapSnapshots", () => {
  it("retains the newest N completed snapshots and deletes the rest", () => {
    writeSnapshotFile(`old${HEAP_SNAPSHOT_EXTENSION}`, 1000);
    writeSnapshotFile(`mid${HEAP_SNAPSHOT_EXTENSION}`, 2000);
    writeSnapshotFile(`new${HEAP_SNAPSHOT_EXTENSION}`, 3000);

    const removed = pruneHeapSnapshots(dir, 2);

    expect(removed).toEqual([`old${HEAP_SNAPSHOT_EXTENSION}`]);
    expect(readdirSync(dir).sort()).toEqual([`mid${HEAP_SNAPSHOT_EXTENSION}`, `new${HEAP_SNAPSHOT_EXTENSION}`]);
  });

  it("deletes abandoned .partial files regardless of the retention cap", () => {
    // The worker's failure mode is an abrupt SIGABRT on heap exhaustion, so a
    // multi-gigabyte partial outliving its process is the expected leftover.
    writeSnapshotFile(`keep${HEAP_SNAPSHOT_EXTENSION}`, 3000);
    writeSnapshotFile(`abandoned${HEAP_SNAPSHOT_EXTENSION}.partial`, 1000);

    const removed = pruneHeapSnapshots(dir, 10);

    expect(removed).toEqual([`abandoned${HEAP_SNAPSHOT_EXTENSION}.partial`]);
    expect(readdirSync(dir)).toEqual([`keep${HEAP_SNAPSHOT_EXTENSION}`]);
  });

  it("orders by the filename stamp, not mtime, so retrieval cannot retire the newer snapshot", () => {
    // Retrieval is documented as copying these off the shared volume, and copy
    // tooling rewrites mtimes. Here the mtimes say the opposite of the stamps.
    writeSnapshotFile(`2026-09-29T20-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`, 9000);
    writeSnapshotFile(`2026-09-29T23-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`, 1000);

    const removed = pruneHeapSnapshots(dir, 1);

    expect(removed).toEqual([`2026-09-29T20-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`]);
    expect(readdirSync(dir)).toEqual([`2026-09-29T23-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`]);
  });

  it("leaves a recently written .partial alone, since a peer replica may still own it", () => {
    // The tier gate admits both "worker" and the default "all", so a second
    // replica's in-flight write must survive this pod's prune.
    const inflight = `inflight${HEAP_SNAPSHOT_EXTENSION}.partial`;
    writeFileSync(path.join(dir, inflight), "{}");

    expect(pruneHeapSnapshots(dir, 10)).toEqual([]);
    expect(readdirSync(dir)).toEqual([inflight]);
  });

  it("leaves unrelated files alone", () => {
    writeFileSync(path.join(dir, "README.md"), "not a snapshot");
    writeFileSync(path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME), "");

    expect(pruneHeapSnapshots(dir, 0)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(["README.md", HEAP_SNAPSHOT_SENTINEL_BASENAME]);
  });

  it("is a no-op on a directory that does not exist yet", () => {
    expect(pruneHeapSnapshots(path.join(dir, "absent"), 2)).toEqual([]);
  });
});

describe("takeHeapSnapshot", () => {
  it("renames into place so a reader never observes a partial as complete", () => {
    const observedDuringWrite: string[][] = [];
    const result = takeHeapSnapshot(
      config(),
      "sentinel",
      runtime({
        writeSnapshot: (filePath: string) => {
          writeFileSync(filePath, "{}");
          // A retrieving pod polls this directory; capture what it would see mid-write.
          observedDuringWrite.push(readdirSync(dir));
          return filePath;
        },
      }),
    );

    expect("filePath" in result).toBe(true);
    if (!("filePath" in result)) return;

    // Mid-write the only entry carries .partial, so a directory listing filtered
    // on the snapshot extension yields nothing half-written.
    expect(observedDuringWrite[0].every((name) => name.endsWith(".partial"))).toBe(true);
    expect(readdirSync(dir)).toEqual([path.basename(result.filePath)]);
    expect(result.filePath.endsWith(HEAP_SNAPSHOT_EXTENSION)).toBe(true);
    expect(result.trigger).toBe("sentinel");
    expect(result.heapUsedBytes).toBe(GB);
  });

  it("refuses without destroying the snapshots it would have pruned", () => {
    // Seeded deliberately: the refusal path used to prune *first*, so from an
    // empty directory this assertion could not fail. A snapshot names a past
    // heap state and cannot be retaken, and the PEN-3314 deliverable is a pair.
    writeSnapshotFile(`old${HEAP_SNAPSHOT_EXTENSION}`, 1000);
    writeSnapshotFile(`new${HEAP_SNAPSHOT_EXTENSION}`, 2000);

    // 1 GB heap => 2 GB estimate, atop a 10 GB floor: 11 GB free is not enough,
    // and the two seeded files are nowhere near closing a 1 GB shortfall.
    const result = takeHeapSnapshot(config(), "threshold", runtime({ freeBytes: () => 11 * GB }));

    expect(result).toEqual({
      skipped: "insufficient-free-space",
      freeBytes: 11 * GB,
      requiredBytes: 12 * GB,
      reclaimableBytes: 2,
    });
    expect(readdirSync(dir).sort()).toEqual([`new${HEAP_SNAPSHOT_EXTENSION}`, `old${HEAP_SNAPSHOT_EXTENSION}`]);
  });

  it("credits what the pre-prune would reclaim, so the cap still buys headroom", () => {
    // Byte-exact on purpose: required = 100 floor + 10 heap * 2 = 120. Free is
    // 118, and pruning `old` (2 bytes) is exactly what closes the gap.
    writeSnapshotFile(`old${HEAP_SNAPSHOT_EXTENSION}`, 1000);
    writeSnapshotFile(`new${HEAP_SNAPSHOT_EXTENSION}`, 2000);

    const result = takeHeapSnapshot(
      config({ minFreeBytes: 100, keep: 2 }),
      "threshold",
      runtime({ heapUsedBytes: () => 10, freeBytes: () => 118 }),
    );

    expect("filePath" in result).toBe(true);
    expect(readdirSync(dir)).not.toContain(`old${HEAP_SNAPSHOT_EXTENSION}`);
  });

  it("refuses when even the reclaimable bytes would not close the gap", () => {
    // One byte tighter than the case above: 117 + 2 < 120, so nothing is spent.
    writeSnapshotFile(`old${HEAP_SNAPSHOT_EXTENSION}`, 1000);
    writeSnapshotFile(`new${HEAP_SNAPSHOT_EXTENSION}`, 2000);

    const result = takeHeapSnapshot(
      config({ minFreeBytes: 100, keep: 2 }),
      "threshold",
      runtime({ heapUsedBytes: () => 10, freeBytes: () => 117 }),
    );

    expect("skipped" in result).toBe(true);
    expect(readdirSync(dir).sort()).toEqual([`new${HEAP_SNAPSHOT_EXTENSION}`, `old${HEAP_SNAPSHOT_EXTENSION}`]);
  });

  it("prunes to keep-1 before writing, so the cap is honoured at rest", () => {
    writeSnapshotFile(`old${HEAP_SNAPSHOT_EXTENSION}`, 1000);
    writeSnapshotFile(`new${HEAP_SNAPSHOT_EXTENSION}`, 2000);

    const result = takeHeapSnapshot(config({ keep: 2 }), "threshold", runtime());

    expect("filePath" in result).toBe(true);
    const names = readdirSync(dir).sort();
    expect(names).toHaveLength(2);
    expect(names).toContain(`new${HEAP_SNAPSHOT_EXTENSION}`);
    expect(names).not.toContain(`old${HEAP_SNAPSHOT_EXTENSION}`);
  });

  it("removes the partial when the snapshot write throws", () => {
    expect(() =>
      takeHeapSnapshot(
        config(),
        "sentinel",
        runtime({
          writeSnapshot: (filePath: string) => {
            writeFileSync(filePath, "partial bytes");
            throw new Error("v8 ran out of room");
          },
        }),
      ),
    ).toThrow("v8 ran out of room");

    expect(readdirSync(dir)).toEqual([]);
  });

  it("creates the snapshot directory on first use", () => {
    const nested = path.join(dir, "data", "diagnostics", "heap");
    expect(existsSync(nested)).toBe(false);

    takeHeapSnapshot(config({ dir: nested }), "sentinel", runtime());

    expect(readdirSync(nested)).toHaveLength(1);
  });
});

describe("ensureHeapSnapshotDir", () => {
  it("creates the directory so a sentinel has somewhere to land before the first snapshot", () => {
    // Without this the trigger is unreachable: the sentinel goes inside the
    // directory, and the directory would otherwise only appear after a snapshot.
    const nested = path.join(dir, "data", "diagnostics", "heap");

    ensureHeapSnapshotDir(nested);

    expect(existsSync(nested)).toBe(true);
    writeFileSync(path.join(nested, HEAP_SNAPSHOT_SENTINEL_BASENAME), "");
    expect(
      decideHeapSnapshot(config({ dir: nested }), state(), runtime()).trigger,
    ).toBe("sentinel");
  });

  it("is idempotent", () => {
    ensureHeapSnapshotDir(dir);
    expect(() => ensureHeapSnapshotDir(dir)).not.toThrow();
  });
});

describe("decideHeapSnapshot", () => {
  it("consumes the sentinel and requests a snapshot", () => {
    writeFileSync(path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME), "");

    const decision = decideHeapSnapshot(config(), state(), runtime());

    expect(decision).toEqual({ trigger: "sentinel", sentinelConsumed: true });
    // Consumed before the snapshot is attempted: a request is honoured exactly
    // once, so a persistently failing snapshot cannot retry on every poll.
    expect(existsSync(path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME))).toBe(false);
  });

  it("does nothing with no sentinel and the automatic trigger disabled", () => {
    const decision = decideHeapSnapshot(
      config({ autoThresholdBytes: 0 }),
      state(),
      runtime({ heapUsedBytes: () => 100 * GB }),
    );

    expect(decision).toEqual({ trigger: null, sentinelConsumed: false });
  });

  it("fires the automatic trigger only at or above the threshold", () => {
    const cfg = config({ autoThresholdBytes: 4 * GB });

    expect(
      decideHeapSnapshot(cfg, state(), runtime({ heapUsedBytes: () => 3 * GB })).trigger,
    ).toBeNull();
    expect(
      decideHeapSnapshot(cfg, state(), runtime({ heapUsedBytes: () => 4 * GB })).trigger,
    ).toBe("threshold");
  });

  it("holds automatic snapshots apart by the configured interval", () => {
    const cfg = config({ autoThresholdBytes: 1, autoMinIntervalMs: 2 * 60 * 60 * 1000 });
    const nowMs = new Date("2026-09-29T23:00:00.000Z").getTime();
    const rt = runtime({ heapUsedBytes: () => 5 * GB });

    // One hour after the last automatic snapshot: too soon.
    expect(decideHeapSnapshot(cfg, state({ lastAutoSnapshotAtMs: nowMs - 60 * 60 * 1000 }), rt).trigger).toBeNull();
    // Three hours: due. This gap is the deliverable — the diff between two
    // snapshots hours apart is what names an accumulator.
    expect(decideHeapSnapshot(cfg, state({ lastAutoSnapshotAtMs: nowMs - 3 * 60 * 60 * 1000 }), rt).trigger).toBe(
      "threshold",
    );
  });

  it("honours a sentinel even while the automatic trigger is rate-limited", () => {
    // The two clocks are independent on purpose: the automatic gap spaces a
    // *pair* for a diff, which is not what an explicit request means.
    const cfg = config({ autoThresholdBytes: 1, autoMinIntervalMs: 2 * 60 * 60 * 1000 });
    const nowMs = new Date("2026-09-29T23:00:00.000Z").getTime();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME), "");

    const decision = decideHeapSnapshot(cfg, state({ lastAutoSnapshotAtMs: nowMs - 1000 }), runtime());

    expect(decision.trigger).toBe("sentinel");
  });

  it("rate-limits the sentinel, because any pod on the shared claim can write it", () => {
    // Unthrottled, a loop touching the sentinel forces a stop-the-world pause
    // and a multi-gigabyte write on the singleton worker once per poll.
    const cfg = config({ sentinelMinIntervalMs: 5 * 60 * 1000 });
    const nowMs = new Date("2026-09-29T23:00:00.000Z").getTime();
    writeFileSync(path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME), "");

    const decision = decideHeapSnapshot(cfg, state({ lastSentinelSnapshotAtMs: nowMs - 60 * 1000 }), runtime());

    expect(decision.trigger).toBeNull();
    // Consumed anyway: honoured-exactly-once has to hold whether or not the
    // request produced a snapshot, or a backlog would drain one per poll.
    expect(decision.sentinelConsumed).toBe(true);
    expect(existsSync(path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME))).toBe(false);
  });

  it("admits a sentinel again once its own interval has elapsed", () => {
    const cfg = config({ sentinelMinIntervalMs: 5 * 60 * 1000 });
    const nowMs = new Date("2026-09-29T23:00:00.000Z").getTime();
    writeFileSync(path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME), "");

    const decision = decideHeapSnapshot(cfg, state({ lastSentinelSnapshotAtMs: nowMs - 6 * 60 * 1000 }), runtime());

    expect(decision.trigger).toBe("sentinel");
  });
});

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
  describeSentinelOutcome,
  ensureHeapSnapshotDir,
  heapSnapshotSweepKeep,
  listHeapSnapshots,
  listResidualHeapSnapshots,
  planHeapSnapshotStartup,
  pruneHeapSnapshots,
  reclaimableHeapSnapshotBytes,
  takeHeapSnapshot,
} from "../services/heap-snapshot.js";

const GB = 1024 * 1024 * 1024;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Age bound for the cases that are exercising *count* retention.
 *
 * Not cosmetic: the fixtures below carry 1970 mtimes, so any finite bound would
 * expire every one of them and the count assertions would pass for the wrong
 * reason.
 */
const NEVER_EXPIRES = Number.POSITIVE_INFINITY;

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
    sentinelMinIntervalMs: 5 * MINUTE_MS,
    // Isolates the *count* axis, and is load-bearing rather than arbitrary: the
    // fixtures below carry 1970 mtimes, so a finite bound would expire all of
    // them and silently change what the byte-exact free-space cases measure
    // (`reclaimableBytes` would be 4, not 2). The age axis has its own cases;
    // "applies the age bound as well as the retention cap" covers the wiring.
    maxAgeMs: NEVER_EXPIRES,
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

    const removed = pruneHeapSnapshots(dir, 2, NEVER_EXPIRES);

    expect(removed).toEqual([`old${HEAP_SNAPSHOT_EXTENSION}`]);
    expect(readdirSync(dir).sort()).toEqual([`mid${HEAP_SNAPSHOT_EXTENSION}`, `new${HEAP_SNAPSHOT_EXTENSION}`]);
  });

  it("deletes abandoned .partial files regardless of the retention cap", () => {
    // The worker's failure mode is an abrupt SIGABRT on heap exhaustion, so a
    // multi-gigabyte partial outliving its process is the expected leftover.
    writeSnapshotFile(`keep${HEAP_SNAPSHOT_EXTENSION}`, 3000);
    writeSnapshotFile(`abandoned${HEAP_SNAPSHOT_EXTENSION}.partial`, 1000);

    const removed = pruneHeapSnapshots(dir, 10, NEVER_EXPIRES);

    expect(removed).toEqual([`abandoned${HEAP_SNAPSHOT_EXTENSION}.partial`]);
    expect(readdirSync(dir)).toEqual([`keep${HEAP_SNAPSHOT_EXTENSION}`]);
  });

  it("orders by the filename stamp, not mtime, so retrieval cannot retire the newer snapshot", () => {
    // Retrieval is documented as copying these off the shared volume, and copy
    // tooling rewrites mtimes. Here the mtimes say the opposite of the stamps.
    writeSnapshotFile(`2026-09-29T20-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`, 9000);
    writeSnapshotFile(`2026-09-29T23-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`, 1000);

    const removed = pruneHeapSnapshots(dir, 1, NEVER_EXPIRES);

    expect(removed).toEqual([`2026-09-29T20-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`]);
    expect(readdirSync(dir)).toEqual([`2026-09-29T23-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`]);
  });

  it("leaves a recently written .partial alone, since a peer replica may still own it", () => {
    // The tier gate admits both "worker" and the default "all", so a second
    // replica's in-flight write must survive this pod's prune.
    const inflight = `inflight${HEAP_SNAPSHOT_EXTENSION}.partial`;
    writeFileSync(path.join(dir, inflight), "{}");

    expect(pruneHeapSnapshots(dir, 10, NEVER_EXPIRES)).toEqual([]);
    expect(readdirSync(dir)).toEqual([inflight]);
  });

  it("judges an abandoned .partial by its filename stamp, so touching one cannot keep it alive", () => {
    // Ally Suggestion 1, promoted to a condition of acceptance on PEN-3631. A
    // partial holds the same plaintext secrets as a completed snapshot, and
    // unlike one it has no `keep` bound behind it — the age check was the only
    // thing retiring it. Judged by mtime, ordinary retrieval tooling (which
    // rewrites mtimes) could extend that exposure indefinitely.
    const nowMs = Date.parse("2026-09-29T23:00:00.000Z");
    const stale = `2026-09-29T20-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}.partial`;
    // Stamped three hours ago, but touched one minute ago.
    writeSnapshotFile(stale, (nowMs - MINUTE_MS) / 1000);

    expect(pruneHeapSnapshots(dir, 10, NEVER_EXPIRES, nowMs)).toEqual([stale]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("still spares an in-flight .partial whose stamp is recent, even with an ancient mtime", () => {
    // The only-when-it-should half. The abandonment window exists so a peer
    // replica's in-flight write survives this pod's prune, and the fix above
    // must not degenerate into deleting every partial: this one flips the other
    // way, since mtime says 1970 and the stamp says four minutes ago.
    const nowMs = Date.parse("2026-09-29T23:00:00.000Z");
    const inflight = `2026-09-29T22-56-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}.partial`;
    writeSnapshotFile(inflight, 1000);

    expect(pruneHeapSnapshots(dir, 10, NEVER_EXPIRES, nowMs)).toEqual([]);
    expect(readdirSync(dir)).toEqual([inflight]);
  });

  it("falls back to mtime for a partial this module did not name", () => {
    // A stampless name has nothing else to go on, so the prior behaviour stands
    // rather than the file becoming immortal.
    const nowMs = Date.parse("2026-09-29T23:00:00.000Z");
    writeSnapshotFile(`foreign${HEAP_SNAPSHOT_EXTENSION}.partial`, 1000);

    expect(pruneHeapSnapshots(dir, 10, NEVER_EXPIRES, nowMs)).toEqual([
      `foreign${HEAP_SNAPSHOT_EXTENSION}.partial`,
    ]);
  });

  it("leaves unrelated files alone", () => {
    writeFileSync(path.join(dir, "README.md"), "not a snapshot");
    writeFileSync(path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME), "");

    expect(pruneHeapSnapshots(dir, 0, NEVER_EXPIRES)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(["README.md", HEAP_SNAPSHOT_SENTINEL_BASENAME]);
  });

  it("is a no-op on a directory that does not exist yet", () => {
    expect(pruneHeapSnapshots(path.join(dir, "absent"), 2, NEVER_EXPIRES)).toEqual([]);
  });
});

describe("pruneHeapSnapshots age bound", () => {
  // A snapshot holds every string on the worker's heap, including the secrets
  // loadConfig() reads from the environment, and on the deployed cluster the
  // worker shares both the volume and its uid with every agent pod — so no file
  // mode separates the readers and the file's lifetime is the only control
  // left. These cases pin that bound. (CTO review, PEN-3631.)
  const NOW_MS = Date.parse("2026-09-29T23:00:00.000Z");
  const FRESH = `2026-09-29T22-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`; // 1h old
  const STALE = `2026-09-28T22-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`; // 25h old

  it("deletes a snapshot past maxAge even when the retention cap would keep it", () => {
    writeSnapshotFile(FRESH, 1000);
    writeSnapshotFile(STALE, 2000);

    // keep=10 means count retention alone would retain both; only the age bound
    // can remove one. "There are only two of them" is not a security property.
    const removed = pruneHeapSnapshots(dir, 10, DAY_MS, NOW_MS);

    expect(removed).toEqual([STALE]);
    expect(readdirSync(dir)).toEqual([FRESH]);
  });

  it("keeps a snapshot inside the window, so the bound is not simply deleting everything", () => {
    writeSnapshotFile(FRESH, 1000);
    writeSnapshotFile(STALE, 2000);

    // Widen the window past the older file: now neither is expired.
    expect(pruneHeapSnapshots(dir, 10, 48 * 60 * MINUTE_MS, NOW_MS)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual([FRESH, STALE].sort());
  });

  it("ages from the filename stamp, so touching a file cannot extend the exposure", () => {
    // Retrieval is documented as copying these off the shared volume, and copy
    // tooling rewrites mtimes. If age keyed on mtime, any reader could hold a
    // snapshot full of credentials on the volume indefinitely just by reading it.
    writeSnapshotFile(STALE, Math.floor(NOW_MS / 1000));

    const removed = pruneHeapSnapshots(dir, 10, DAY_MS, NOW_MS);

    expect(removed).toEqual([STALE]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("prices expired bytes as reclaimable, so an age prune can unblock a snapshot", () => {
    writeSnapshotFile(STALE, 1000); // 2 bytes of "{}"

    expect(reclaimableHeapSnapshotBytes(dir, 10, DAY_MS, NOW_MS)).toBe(2);
    expect(reclaimableHeapSnapshotBytes(dir, 10, NEVER_EXPIRES, NOW_MS)).toBe(0);
  });
});

describe("heapSnapshotSweepKeep", () => {
  it("retains nothing once capture is disabled, so the flag closes the window", () => {
    // Disabling capture is an operator declaring the window shut. maxAgeMs
    // bounds the exposure while it is open; this is what bounds it at the close,
    // rather than leaving credential-bearing files to age out over the next day.
    expect(heapSnapshotSweepKeep(false, 2)).toBe(0);
    expect(heapSnapshotSweepKeep(false, 100)).toBe(0);
  });

  it("retains the configured cap while capture is enabled", () => {
    // The paired positive. Without it, "always return 0" passes the case above
    // and silently deletes each snapshot as fast as it is written — the retention
    // cap exists to hold a *pair*, which is the whole PEN-3314 deliverable.
    expect(heapSnapshotSweepKeep(true, 2)).toBe(2);
    expect(heapSnapshotSweepKeep(true, 5)).toBe(5);
  });

  it("never returns a negative cap", () => {
    expect(heapSnapshotSweepKeep(true, -1)).toBe(0);
  });
});

describe("planHeapSnapshotStartup", () => {
  // Regression cases for the defect this fixes: every prune used to live inside
  // the capture flag, so ENABLED=false meant the sweep never ran and snapshots
  // full of credentials persisted on the shared volume forever.
  it("keeps polling when capture is OFF but snapshots remain, so the flag cannot freeze the exposure", () => {
    expect(planHeapSnapshotStartup({ captureEnabled: false, residualSnapshotCount: 2 })).toEqual({
      capture: false,
      poll: true,
      warnResidualSnapshots: true,
    });
  });

  it("arms nothing when capture is OFF and no snapshots exist", () => {
    // The paired negative: retention must not be gated on capture, but it must
    // also not conjure a timer on a deployment that never enabled the feature.
    expect(planHeapSnapshotStartup({ captureEnabled: false, residualSnapshotCount: 0 })).toEqual({
      capture: false,
      poll: false,
      warnResidualSnapshots: false,
    });
  });

  it("polls when capture is ON regardless of what is already on disk", () => {
    for (const residualSnapshotCount of [0, 5]) {
      expect(planHeapSnapshotStartup({ captureEnabled: true, residualSnapshotCount })).toEqual({
        capture: true,
        poll: true,
        warnResidualSnapshots: false,
      });
    }
  });

  it("never implies poll from capture alone", () => {
    // States the invariant directly: poll is true in a case where capture is
    // false, so no implementation that derives one from the other can pass.
    const off = planHeapSnapshotStartup({ captureEnabled: false, residualSnapshotCount: 1 });
    expect(off.capture).toBe(false);
    expect(off.poll).toBe(true);
  });
});

describe("listHeapSnapshots", () => {
  // Backs the startup report of leftovers while capture is disabled — the state
  // in which an operator believes the exposure is over.
  it("returns completed snapshots newest first, ignoring partials and other files", () => {
    writeSnapshotFile(`2026-09-28T22-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`, 1000);
    writeSnapshotFile(`2026-09-29T22-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`, 2000);
    writeSnapshotFile(`inflight${HEAP_SNAPSHOT_EXTENSION}.partial`, 3000);
    writeFileSync(path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME), "");

    expect(listHeapSnapshots(dir)).toEqual([
      `2026-09-29T22-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`,
      `2026-09-28T22-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`,
    ]);
  });

  it("is empty for a directory that does not exist", () => {
    expect(listHeapSnapshots(path.join(dir, "absent"))).toEqual([]);
  });
});

describe("listResidualHeapSnapshots", () => {
  // Backs the startup report of leftovers while capture is disabled — the state
  // in which an operator believes the exposure is over. A `.partial` holds the
  // same plaintext secrets as a completed file, and sizing the residual check
  // off completed files alone made the likeliest way to strand one (an OOM
  // during the write) the one case that reported nothing. (Ally Important 1.)
  it("reports a lone .partial, which listHeapSnapshots is blind to by construction", () => {
    const partial = `2026-09-29T22-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}.partial`;
    writeSnapshotFile(partial, 3000);

    // The control that makes this a real finding rather than a restatement:
    // the pre-existing listing genuinely sees nothing here.
    expect(listHeapSnapshots(dir)).toEqual([]);

    const residual = listResidualHeapSnapshots(dir);
    expect(residual.completed).toEqual([]);
    expect(residual.partial).toEqual([partial]);
    expect(residual.completed.length + residual.partial.length).toBe(1);
  });

  it("separates completed from partial and orders each newest first", () => {
    writeSnapshotFile(`2026-09-28T22-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`, 1000);
    writeSnapshotFile(`2026-09-29T22-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`, 2000);
    writeSnapshotFile(`2026-09-27T22-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}.partial`, 3000);
    writeSnapshotFile(`2026-09-29T23-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}.partial`, 4000);
    writeFileSync(path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME), "");
    writeFileSync(path.join(dir, "README.md"), "not a snapshot");

    expect(listResidualHeapSnapshots(dir)).toEqual({
      completed: [
        `2026-09-29T22-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`,
        `2026-09-28T22-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`,
      ],
      partial: [
        `2026-09-29T23-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}.partial`,
        `2026-09-27T22-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}.partial`,
      ],
    });
  });

  it("drives poll and the operator warning on a partial alone", () => {
    // The end-to-end shape of the finding: capture OFF, nothing completed left,
    // one partial. Both flags must come back true, or nothing sweeps it again
    // this process lifetime and the operator is told nothing.
    writeSnapshotFile(`2026-09-29T22-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}.partial`, 3000);

    const residual = listResidualHeapSnapshots(dir);
    expect(
      planHeapSnapshotStartup({
        captureEnabled: false,
        residualSnapshotCount: residual.completed.length + residual.partial.length,
      }),
    ).toEqual({ capture: false, poll: true, warnResidualSnapshots: true });

    // And the pre-fix input, for contrast: counting completed files alone armed
    // nothing at all against the very same directory.
    expect(
      planHeapSnapshotStartup({
        captureEnabled: false,
        residualSnapshotCount: listHeapSnapshots(dir).length,
      }),
    ).toEqual({ capture: false, poll: false, warnResidualSnapshots: false });
  });

  it("is empty for a directory that does not exist", () => {
    expect(listResidualHeapSnapshots(path.join(dir, "absent"))).toEqual({
      completed: [],
      partial: [],
    });
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

  it("prunes BEFORE the write when the write actually needs the room", () => {
    // Paired with the ample-space case below; between them they pin the
    // *condition*, not merely that a prune happens somewhere. Asserting on the
    // final directory would be vacuous here — the post-write prune removes `old`
    // either way — so this observes the directory mid-write, which is the only
    // point at which "before" and "after" are distinguishable.
    writeSnapshotFile(`old${HEAP_SNAPSHOT_EXTENSION}`, 1000);
    writeSnapshotFile(`new${HEAP_SNAPSHOT_EXTENSION}`, 2000);

    let duringWrite: string[] = [];
    // required = 100 + 10*2 = 120; free 118 is short by 2, which the prune covers.
    const result = takeHeapSnapshot(
      config({ minFreeBytes: 100, keep: 2 }),
      "threshold",
      runtime({
        heapUsedBytes: () => 10,
        freeBytes: () => 118,
        writeSnapshot: (filePath: string) => {
          duringWrite = readdirSync(dir);
          writeFileSync(filePath, "{}");
          return filePath;
        },
      }),
    );

    expect("filePath" in result).toBe(true);
    expect(duringWrite).not.toContain(`old${HEAP_SNAPSHOT_EXTENSION}`);
  });

  it("does NOT pre-prune when there is already room, so a write that dies cannot cost the baseline", () => {
    // Ally review, Important 1. The pre-prune buys nothing on the ample-space
    // path and still deletes the older half of the diff pair immediately before
    // the riskiest operation this module performs. An OOMKill is SIGKILL, so no
    // catch can put it back.
    //
    // Observed mid-write rather than at the end, because the post-write prune
    // (keep=2) removes `old` regardless — at the end the two orderings are
    // indistinguishable, which is exactly how this shipped unnoticed.
    writeSnapshotFile(`old${HEAP_SNAPSHOT_EXTENSION}`, 1000);
    writeSnapshotFile(`new${HEAP_SNAPSHOT_EXTENSION}`, 2000);

    let duringWrite: string[] = [];
    const result = takeHeapSnapshot(
      config({ minFreeBytes: 100, keep: 2 }),
      "threshold",
      // required = 100 + 10*2 = 120, free = 10_000: ample, so nothing is spent.
      runtime({
        heapUsedBytes: () => 10,
        freeBytes: () => 10_000,
        writeSnapshot: (filePath: string) => {
          duringWrite = readdirSync(dir);
          writeFileSync(filePath, "{}");
          return filePath;
        },
      }),
    );

    expect("filePath" in result).toBe(true);
    expect(duringWrite).toContain(`old${HEAP_SNAPSHOT_EXTENSION}`);
    expect(duringWrite).toContain(`new${HEAP_SNAPSHOT_EXTENSION}`);
  });

  it("keeps both snapshots when an ample-space write throws, so the pair survives an OOM", () => {
    // The consequence the case above exists to prevent, stated as an outcome:
    // the write dies and the diff pair is still on disk. Under the old
    // unconditional pre-prune `old` was already gone by this point.
    writeSnapshotFile(`old${HEAP_SNAPSHOT_EXTENSION}`, 1000);
    writeSnapshotFile(`new${HEAP_SNAPSHOT_EXTENSION}`, 2000);

    expect(() =>
      takeHeapSnapshot(
        config({ minFreeBytes: 100, keep: 2 }),
        "threshold",
        runtime({
          heapUsedBytes: () => 10,
          freeBytes: () => 10_000,
          writeSnapshot: () => {
            throw new Error("heap exhausted mid-write");
          },
        }),
      ),
    ).toThrow("heap exhausted mid-write");

    expect(readdirSync(dir).sort()).toEqual(
      [`new${HEAP_SNAPSHOT_EXTENSION}`, `old${HEAP_SNAPSHOT_EXTENSION}`].sort(),
    );
  });

  it("applies the age bound as well as the retention cap", () => {
    // Wiring check: config.maxAgeMs has to reach both prune passes inside
    // takeHeapSnapshot, and the clock has to come from runtime.now() so it is
    // the injected one. keep=10 means only the age bound can remove this file.
    const stale = `2026-09-28T22-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`; // 25h before runtime.now()
    writeSnapshotFile(stale, 1000);

    const result = takeHeapSnapshot(config({ keep: 10, maxAgeMs: DAY_MS }), "sentinel", runtime());

    expect("filePath" in result).toBe(true);
    expect(readdirSync(dir)).not.toContain(stale);
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

  it("leaves the cap honoured at rest once the write completes", () => {
    // Deliberately NOT named "prunes before writing": with ample free space the
    // pre-prune is skipped (see the Important-1 cases above) and it is the
    // post-write pass that enforces the cap here. The two mid-write cases are
    // what pin *when* the prune runs; this pins the end state.
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

    expect(decision).toEqual({ trigger: "sentinel", sentinel: "claimed" });
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

    expect(decision).toEqual({ trigger: null, sentinel: "absent" });
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
    expect(decision.sentinel).toBe("rate-limited");
    expect(existsSync(path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME))).toBe(false);
  });

  it("admits a sentinel again once its own interval has elapsed", () => {
    const cfg = config({ sentinelMinIntervalMs: 5 * 60 * 1000 });
    const nowMs = new Date("2026-09-29T23:00:00.000Z").getTime();
    writeFileSync(path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME), "");

    const decision = decideHeapSnapshot(cfg, state({ lastSentinelSnapshotAtMs: nowMs - 6 * 60 * 1000 }), runtime());

    expect(decision.trigger).toBe("sentinel");
  });

  it("reports a sentinel it could not claim as distinct from no sentinel at all", () => {
    // A directory at the sentinel path exists but cannot be unlinked, which is
    // the same shape as losing the race to another replica or hitting a
    // permission fault — without a distinct verdict the caller cannot tell this
    // (file still present, unhonoured) from "absent" (nothing was requested).
    mkdirSync(path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME), { recursive: true });

    const decision = decideHeapSnapshot(config(), state(), runtime());

    expect(decision).toEqual({ trigger: null, sentinel: "claim-failed" });
    expect(existsSync(path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME))).toBe(true);
  });
});

describe("describeSentinelOutcome", () => {
  const nowMs = new Date("2026-09-29T23:00:00.000Z").getTime();

  it("speaks up when a request was claimed and then declined", () => {
    // The regression this pins is *silence*. A declined request has already
    // deleted the request file — the only feedback this interface has — so
    // logging nothing leaves the operator unable to tell a refusal from a
    // snapshot that is still being written.
    const cfg = config({ sentinelMinIntervalMs: 5 * MINUTE_MS });
    writeFileSync(path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME), "");
    const st = state({ lastSentinelSnapshotAtMs: nowMs - MINUTE_MS });

    const decision = decideHeapSnapshot(cfg, st, runtime());
    const log = describeSentinelOutcome(decision, cfg, st);

    expect(decision.trigger).toBeNull();
    expect(log).not.toBeNull();
    expect(log?.level).toBe("info");
    expect(log?.data).toMatchObject({
      sentinelPath: path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME),
      sentinelMinIntervalMs: 5 * MINUTE_MS,
      lastSentinelSnapshotAtMs: nowMs - MINUTE_MS,
    });
    // Says the file is gone and no snapshot is coming, which is the part the
    // operator cannot otherwise observe.
    expect(log?.message).toContain("deleted anyway");
    expect(log?.message).toContain("none will appear");
  });

  it("warns, and differently, when the sentinel could not be claimed", () => {
    // Deliberately a different level and a different remedy: the rate limit is
    // by design and self-clears, an unclaimable file is not and may not.
    mkdirSync(path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME), { recursive: true });
    const cfg = config();

    const log = describeSentinelOutcome(decideHeapSnapshot(cfg, state(), runtime()), cfg, state());

    expect(log?.level).toBe("warn");
    expect(log?.message).toContain("still present");
  });

  it("stays silent when the sentinel was honoured or never existed", () => {
    const cfg = config();

    // Honoured: the snapshot carries its own credential-exposure warning, so a
    // second line here would be noise on the one path that already logs.
    writeFileSync(path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME), "");
    const claimed = decideHeapSnapshot(cfg, state(), runtime());
    expect(claimed.sentinel).toBe("claimed");
    expect(describeSentinelOutcome(claimed, cfg, state())).toBeNull();

    // Absent: every idle poll takes this path, so logging here would be a line
    // per poll forever.
    const absent = decideHeapSnapshot(cfg, state(), runtime());
    expect(absent.sentinel).toBe("absent");
    expect(describeSentinelOutcome(absent, cfg, state())).toBeNull();
  });
});

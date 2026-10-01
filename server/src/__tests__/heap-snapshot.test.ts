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
  findConcurrentSnapshotWriters,
  heapSnapshotSweepKeep,
  listHeapSnapshots,
  listResidualHeapSnapshots,
  newestHeapSnapshotStampMs,
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

/**
 * Realistic fixture names, stamped the way `snapshotBasename` stamps them.
 *
 * Load-bearing, not cosmetic. Retention keys off the embedded stamp and a name
 * that does not parse is deliberately keyed `0` (see `retentionKeyMs`), so the
 * bare `old`/`mid`/`new` labels these replaced all collapsed to one key — and
 * every ordering assertion over them passed on `readdirSync` enumeration order
 * rather than on the property under test. Each is before `runtime().now()`
 * (23:00Z), so a finite `maxAgeMs` sees them as past, not future.
 */
const OLD = `2026-09-29T20-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`;
const MID = `2026-09-29T21-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`;
const NEW = `2026-09-29T22-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`;

describe("pruneHeapSnapshots", () => {
  it("retains the newest N completed snapshots and deletes the rest", () => {
    writeSnapshotFile(OLD, 1000);
    writeSnapshotFile(MID, 2000);
    writeSnapshotFile(NEW, 3000);

    const removed = pruneHeapSnapshots(dir, 2, NEVER_EXPIRES);

    expect(removed).toEqual([OLD]);
    expect(readdirSync(dir).sort()).toEqual([MID, NEW]);
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

  it("expires a completed snapshot whose name it did not write, however fresh its mtime", () => {
    // The hole this closes. `maxAgeMs` is the exposure window and is documented
    // as stamp-based precisely so a reader cannot extend it by touching the
    // file — but the fallback for an unparsed name was that file's mtime, so a
    // secret-bearing snapshot whose name happened not to parse, with a
    // refreshed mtime, never expired at all. keep=10 leaves the age bound as
    // the only thing that can remove anything here. (Ally review, PEN-3631.)
    const nowMs = Date.parse("2026-09-29T23:00:00.000Z");
    const foreign = `heap-paperclip-0${HEAP_SNAPSHOT_EXTENSION}`;
    writeSnapshotFile(foreign, (nowMs - MINUTE_MS) / 1000); // touched one minute ago
    writeSnapshotFile(NEW, 1000);

    expect(pruneHeapSnapshots(dir, 10, DAY_MS, nowMs)).toEqual([foreign]);
    expect(readdirSync(dir)).toEqual([NEW]);
  });

  it("ranks a name it did not write as oldest, in the prune and the listing alike", () => {
    // The ordering half, which needs no adversary. `collectPrunable` keyed an
    // unparsed name at its mtime while `listHeapSnapshots` keyed it at 0, so
    // the two disagreed about which end of the ordering the same file sat on:
    // one called it newest, the other oldest. At keep=2 that spent a retention
    // slot on it and evicted OLD — the older half of the diff pair PEN-3314
    // needs, and the half that cannot be retaken.
    const foreign = `heap-paperclip-0${HEAP_SNAPSHOT_EXTENSION}`;
    writeSnapshotFile(OLD, 1000);
    writeSnapshotFile(NEW, 2000);
    writeSnapshotFile(foreign, Date.now() / 1000); // the freshest mtime in the directory

    expect(listHeapSnapshots(dir)).toEqual([NEW, OLD, foreign]);
    expect(pruneHeapSnapshots(dir, 2, NEVER_EXPIRES)).toEqual([foreign]);
  });

  it("treats a future-dated stamp as oldest, so a rename cannot buy immortality", () => {
    // retentionKeyMs clamped an *unparseable* name to 0 but trusted any stamp
    // that parsed, and a stamp ahead of now defeated both bounds on the same
    // entry: nowMs - stamp is negative so no finite maxAgeMs ever expired it,
    // and the descending sort pinned it at index 0 so it never fell outside
    // keep either. Immortal and permanently holding a keep slot, evicting the
    // real snapshots underneath it.
    //
    // The maxAgeMs docblock claims the embedded stamp is not mutable the way
    // mtime is. It is not mutable by touch — the hole the mtime fallback had —
    // but it is by mv, from any pod on the shared claim, which no file mode
    // separates. The no-adversary route is forward clock skew between pods.
    const nowMs = Date.parse("2026-09-29T23:00:00.000Z");
    const future = `2027-01-01T00-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`;
    writeSnapshotFile(OLD, 1000);
    writeSnapshotFile(NEW, 2000);
    writeSnapshotFile(future, 3000);

    // Sorts oldest despite carrying the newest stamp in the directory, so it
    // cannot hold a keep slot ahead of a real snapshot.
    expect(listHeapSnapshots(dir, nowMs)).toEqual([NEW, OLD, future]);
    expect(pruneHeapSnapshots(dir, 2, NEVER_EXPIRES, nowMs)).toEqual([future]);

    // Re-created because the prune above consumed it. The age bound is the
    // second and independent bound the same entry used to defeat: a negative
    // nowMs - stamp meant no finite maxAgeMs could ever reach it, so it was
    // immune to the exposure window as well as to the retention cap.
    writeSnapshotFile(future, 3000);
    expect(pruneHeapSnapshots(dir, 10, DAY_MS, nowMs)).toEqual([future]);
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

describe("newestHeapSnapshotStampMs", () => {
  const nowMs = Date.parse("2026-09-29T23:00:00.000Z");

  it("reads the newest stamp on the volume, so the limiter survives a restart", () => {
    // The in-memory limiter is initialised on every boot, so without this seed
    // autoMinIntervalMs provides no spacing across a restart at all: a worker
    // that OOM-restarts and re-grows past the threshold inside the interval
    // retains a pair spaced by the crash cycle, and at keep: 2 the prune takes
    // the hours-older half with it. findConcurrentSnapshotWriters cannot catch
    // that — the predecessor wrote before our start and shares no pid with us.
    writeSnapshotFile(OLD, 1000);
    writeSnapshotFile(NEW, 2000);

    expect(newestHeapSnapshotStampMs(dir, nowMs)).toBe(Date.parse("2026-09-29T22:00:00.000Z"));
  });

  it("is null on an empty or absent directory, leaving the first capture unthrottled", () => {
    expect(newestHeapSnapshotStampMs(dir, nowMs)).toBeNull();
    expect(newestHeapSnapshotStampMs(path.join(dir, "absent"), nowMs)).toBeNull();
  });

  it("is null when the only snapshots carry no usable stamp", () => {
    // retentionKeyMs keys an unparseable or future-dated name at 0, which says
    // nothing about when the last capture happened. Seeding the limiter with
    // it would read as "captured at the epoch" and bound nothing, so it is
    // reported as absent instead — the same posture as an empty directory.
    writeSnapshotFile(`heap-paperclip-0${HEAP_SNAPSHOT_EXTENSION}`, 1000);
    writeSnapshotFile(`2027-01-01T00-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`, 2000);

    expect(newestHeapSnapshotStampMs(dir, nowMs)).toBeNull();
  });

  it("ignores partials, which are not a completed capture", () => {
    writeSnapshotFile(`2026-09-29T22-30-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}.partial`, 3000);
    writeSnapshotFile(OLD, 1000);

    expect(newestHeapSnapshotStampMs(dir, nowMs)).toBe(Date.parse("2026-09-29T20:00:00.000Z"));
  });
});

describe("listResidualHeapSnapshots", () => {  // Backs the startup report of leftovers while capture is disabled — the state
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
    writeSnapshotFile(OLD, 1000);
    writeSnapshotFile(NEW, 2000);

    // 1 GB heap => 2 GB estimate, atop a 10 GB floor: 11 GB free is not enough,
    // and the two seeded files are nowhere near closing a 1 GB shortfall.
    const result = takeHeapSnapshot(config(), "threshold", runtime({ freeBytes: () => 11 * GB }));

    expect(result).toEqual({
      skipped: "insufficient-free-space",
      freeBytes: 11 * GB,
      requiredBytes: 12 * GB,
      reclaimableBytes: 2,
    });
    expect(readdirSync(dir).sort()).toEqual([OLD, NEW]);
  });

  it("credits what the pre-prune would reclaim, so the cap still buys headroom", () => {
    // Byte-exact on purpose: required = 100 floor + 10 heap * 2 = 120. Free is
    // 118, and pruning `old` (2 bytes) is exactly what closes the gap.
    writeSnapshotFile(OLD, 1000);
    writeSnapshotFile(NEW, 2000);

    const result = takeHeapSnapshot(
      config({ minFreeBytes: 100, keep: 2 }),
      "threshold",
      runtime({ heapUsedBytes: () => 10, freeBytes: () => 118 }),
    );

    expect("filePath" in result).toBe(true);
    expect(readdirSync(dir)).not.toContain(OLD);
  });

  it("prunes BEFORE the write when the write actually needs the room", () => {
    // Paired with the ample-space case below; between them they pin the
    // *condition*, not merely that a prune happens somewhere. Asserting on the
    // final directory would be vacuous here — the post-write prune removes `old`
    // either way — so this observes the directory mid-write, which is the only
    // point at which "before" and "after" are distinguishable.
    writeSnapshotFile(OLD, 1000);
    writeSnapshotFile(NEW, 2000);

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
    expect(duringWrite).not.toContain(OLD);
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
    writeSnapshotFile(OLD, 1000);
    writeSnapshotFile(NEW, 2000);

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
    expect(duringWrite).toContain(OLD);
    expect(duringWrite).toContain(NEW);
  });

  it("keeps both snapshots when an ample-space write throws, so the pair survives an OOM", () => {
    // The consequence the case above exists to prevent, stated as an outcome:
    // the write dies and the diff pair is still on disk. Under the old
    // unconditional pre-prune `old` was already gone by this point.
    writeSnapshotFile(OLD, 1000);
    writeSnapshotFile(NEW, 2000);

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
      [NEW, OLD].sort(),
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
    writeSnapshotFile(OLD, 1000);
    writeSnapshotFile(NEW, 2000);

    const result = takeHeapSnapshot(
      config({ minFreeBytes: 100, keep: 2 }),
      "threshold",
      runtime({ heapUsedBytes: () => 10, freeBytes: () => 117 }),
    );

    expect("skipped" in result).toBe(true);
    expect(readdirSync(dir).sort()).toEqual([OLD, NEW]);
  });

  it("prices the age prune, so an expired snapshot's bytes prevent a false refusal", () => {
    // Ally suggestion. The early `maxAgeMs` arguments were unfalsifiable: every
    // case reaching the pricing call passed NEVER_EXPIRES, where Infinity and 0
    // are indistinguishable, and the one case with a finite bound had ample
    // free space, so the pre-prune was skipped before the bound mattered.
    //
    // Here the age prune is the *only* thing that can free a byte — keep=10
    // means the count cap frees nothing — and the refusal threshold is exactly
    // one byte away. A pricing call that ignored maxAgeMs would price the prune
    // at 0 and refuse `insufficient-free-space` on a volume the prune would
    // have made room on, which is unrecoverable: a snapshot names a past heap
    // state and cannot be retaken.
    const expired = `2026-09-28T20-00-00-000Z-pid1${HEAP_SNAPSHOT_EXTENSION}`; // 27h before now()
    writeSnapshotFile(expired, 1000);

    // required = 100 floor + 10 heap * 2 = 120; free is 118, and the expired
    // snapshot's 2 bytes are exactly what closes the gap.
    const result = takeHeapSnapshot(
      config({ minFreeBytes: 100, keep: 10, maxAgeMs: DAY_MS }),
      "threshold",
      runtime({ heapUsedBytes: () => 10, freeBytes: () => 118 }),
    );

    expect("filePath" in result).toBe(true);
    expect(readdirSync(dir)).not.toContain(expired);
  });

  it("leaves the cap honoured at rest once the write completes", () => {
    // Deliberately NOT named "prunes before writing": with ample free space the
    // pre-prune is skipped (see the Important-1 cases above) and it is the
    // post-write pass that enforces the cap here. The two mid-write cases are
    // what pin *when* the prune runs; this pins the end state.
    writeSnapshotFile(OLD, 1000);
    writeSnapshotFile(NEW, 2000);

    const result = takeHeapSnapshot(config({ keep: 2 }), "threshold", runtime());

    expect("filePath" in result).toBe(true);
    const names = readdirSync(dir).sort();
    expect(names).toHaveLength(2);
    expect(names).toContain(NEW);
    expect(names).not.toContain(OLD);
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

  it("keeps taking threshold snapshots while a sentinel sits unclaimable", () => {
    // The two triggers are independent, and an unclaimable request file is
    // permanent by definition: it is still there precisely because the delete
    // failed, so every later poll observes it again. Returning early on it would
    // therefore suppress automatic capture for the life of the process — taking
    // out the unattended hours-apart pair that is this feature's deliverable,
    // while the operator is told only that the *request* path is wedged.
    const cfg = config({ autoThresholdBytes: GB / 2, autoMinIntervalMs: 0 });
    const sentinel = path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME);

    // Control: with no sentinel this config fires, so a null below is the
    // sentinel suppressing it rather than the threshold simply not being met.
    expect(decideHeapSnapshot(cfg, state(), runtime()).trigger).toBe("threshold");

    mkdirSync(sentinel, { recursive: true });
    for (const poll of [1, 2, 3]) {
      const decision = decideHeapSnapshot(cfg, state(), runtime());

      expect(decision, `poll ${poll}`).toEqual({ trigger: "threshold", sentinel: "claim-failed" });
      // Still unclaimed, so the warn still fires — the fall-through does not
      // silence the operator-facing half of this.
      expect(describeSentinelOutcome(decision, cfg, state())?.level).toBe("warn");
    }
  });

  it("keeps taking threshold snapshots while the sentinel is rate-limited", () => {
    // Same independence as the unclaimable case above, and the same damage if
    // it returns early instead: a declined request says nothing about the heap
    // either. Anything re-creating the sentinel once per poll — a retry
    // wrapper, a cron drop, an operator retouching while waiting the interval
    // out — makes every poll take the rate-limited branch, so a long
    // sentinelMinIntervalMs becomes a window with no sentinel capture *and* no
    // threshold evaluation while the heap climbs. Rationing the request path
    // must not ration the unattended one.
    const cfg = config({
      autoThresholdBytes: GB / 2,
      autoMinIntervalMs: 0,
      sentinelMinIntervalMs: 5 * MINUTE_MS,
    });
    const nowMs = new Date("2026-09-29T23:00:00.000Z").getTime();
    const sentinelPath = path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME);
    const declined = (): ReturnType<typeof state> =>
      state({ lastSentinelSnapshotAtMs: nowMs - MINUTE_MS });

    // Control: with no sentinel this config fires, so a null below is the
    // sentinel suppressing it rather than the threshold simply not being met.
    expect(decideHeapSnapshot(cfg, declined(), runtime()).trigger).toBe("threshold");

    for (const poll of [1, 2, 3]) {
      writeFileSync(sentinelPath, "");

      const decision = decideHeapSnapshot(cfg, declined(), runtime());

      expect(decision, `poll ${poll}`).toEqual({ trigger: "threshold", sentinel: "rate-limited" });
      // Consumed and still spoken about: falling through does not quietly turn
      // a declined request into a silent one.
      expect(existsSync(sentinelPath), `poll ${poll}`).toBe(false);
      expect(describeSentinelOutcome(decision, cfg, declined())?.level).toBe("info");
    }
  });

  it("spaces automatic snapshots against a sentinel capture, not only its own", () => {
    // The caller stamps one state field per capture, never both, so an arm
    // reading lastAutoSnapshotAtMs alone sees null after a sentinel capture —
    // and with a threshold configured the heap sits above it by definition
    // (that is the PEN-3314 posture), so the very next poll fired
    // unconditionally. That is a second unrequested stop-the-world pause on an
    // already-pressured worker, and at keep: 2 the post-write prune then
    // evicts the hours-older half of the pair being accumulated. Nothing
    // reports it: findConcurrentSnapshotWriters filters on a foreign pid and
    // this is one process, so only prunedCount moves.
    const cfg = config({ autoThresholdBytes: GB / 2, autoMinIntervalMs: 2 * 60 * 60 * 1000 });
    const nowMs = new Date("2026-09-29T23:00:00.000Z").getTime();

    expect(
      decideHeapSnapshot(cfg, state({ lastSentinelSnapshotAtMs: nowMs - MINUTE_MS }), runtime()).trigger,
    ).toBeNull();
    // Control: the same field one interval back does fire, so the null above
    // is the spacing rather than the threshold going unmet.
    expect(
      decideHeapSnapshot(
        cfg,
        state({ lastSentinelSnapshotAtMs: nowMs - 3 * 60 * 60 * 1000 }),
        runtime(),
      ).trigger,
    ).toBe("threshold");
  });

  it("still honours a human request promptly after an automatic capture", () => {
    // The converse of the case above, and the reason the sentinel arm keeps
    // its own field rather than sharing one: spacing the *automatic* trigger
    // against both captures must not make an operator wait out
    // autoMinIntervalMs to be heard.
    const cfg = config({ autoThresholdBytes: GB / 2, autoMinIntervalMs: 2 * 60 * 60 * 1000 });
    const nowMs = new Date("2026-09-29T23:00:00.000Z").getTime();
    writeFileSync(path.join(dir, HEAP_SNAPSHOT_SENTINEL_BASENAME), "");

    const decision = decideHeapSnapshot(
      cfg,
      state({ lastAutoSnapshotAtMs: nowMs - MINUTE_MS }),
      runtime(),
    );

    expect(decision).toEqual({ trigger: "sentinel", sentinel: "claimed" });
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

describe("findConcurrentSnapshotWriters", () => {
  // Our own identity. The discriminator is "a pid that is not ours, stamped at
  // or after we started" — a dead predecessor cannot write after its successor
  // boots, so that holds at any spacing.
  const SELF_PID = 10;
  const BOOTED_AT_MS = Date.parse("2026-09-29T21:00:00.000Z");
  const self = { pid: SELF_PID, startedAtMs: BOOTED_AT_MS };

  it("reports another process writing while we are running", () => {
    // `keep` is a cap over the directory, not over a process. Two live writers
    // mean each round fills every slot and the post-write prune takes the
    // previous round out, so what survives is two processes at one instant
    // rather than one process hours apart — which cannot be diffed. It fails
    // silently otherwise: only `prunedCount` moves.
    expect(
      findConcurrentSnapshotWriters(
        [
          `2026-09-29T22-00-00-000Z-pid10${HEAP_SNAPSHOT_EXTENSION}`,
          `2026-09-29T22-00-30-000Z-pid20${HEAP_SNAPSHOT_EXTENSION}`,
        ],
        self,
      ),
    ).toEqual({ pids: [20], newestStampMs: Date.parse("2026-09-29T22:00:30.000Z") });
  });

  it("stays silent on a restart-spanning pair even minutes apart, which is the deliverable", () => {
    // The regression this shape exists to prevent (Ally review, PEN-3631). The
    // previous discriminator was "different pids closer together than
    // `autoMinIntervalMs`", justified by a guarantee that a restart-spanning
    // pair lands hours apart. There is none: the limiter lives in process
    // memory and is never seeded from disk, so the first trigger after any
    // restart fires unconditionally. An operator who touches the sentinel,
    // suffers the OOM-restart this feature diagnoses, and touches it again ten
    // minutes later gets exactly this pair — the documented deliverable. The
    // old fixture used a 2h gap and so encoded the premise instead of testing
    // it; this one is spaced the way a real restart actually lands.
    expect(
      findConcurrentSnapshotWriters(
        [
          // Predecessor: stamped before we booted at 21:00.
          `2026-09-29T20-50-00-000Z-pid9${HEAP_SNAPSHOT_EXTENSION}`,
          `2026-09-29T21-00-30-000Z-pid10${HEAP_SNAPSHOT_EXTENSION}`,
        ],
        self,
      ),
    ).toBeNull();
  });

  it("stays silent across several restarts, however tightly they crash-loop", () => {
    // Generalises the case above: every pid older than our start is a
    // predecessor, so a crash-loop leaves no residue that reads as concurrency.
    expect(
      findConcurrentSnapshotWriters(
        [
          `2026-09-29T20-58-00-000Z-pid7${HEAP_SNAPSHOT_EXTENSION}`,
          `2026-09-29T20-59-00-000Z-pid8${HEAP_SNAPSHOT_EXTENSION}`,
          `2026-09-29T20-59-30-000Z-pid9${HEAP_SNAPSHOT_EXTENSION}`,
          `2026-09-29T21-05-00-000Z-pid10${HEAP_SNAPSHOT_EXTENSION}`,
        ],
        self,
      ),
    ).toBeNull();
  });

  it("stays silent on one process snapshotting twice in quick succession", () => {
    // A sentinel request is rate-limited by its own, much shorter interval and
    // may legitimately land close to an automatic capture. Our own pid is never
    // the failure mode this detects.
    expect(
      findConcurrentSnapshotWriters(
        [
          `2026-09-29T22-00-00-000Z-pid10${HEAP_SNAPSHOT_EXTENSION}`,
          `2026-09-29T22-00-30-000Z-pid10${HEAP_SNAPSHOT_EXTENSION}`,
        ],
        self,
      ),
    ).toBeNull();
  });

  it("catches a peer spaced wider than any capture interval", () => {
    // The window shape could not see this: 3h exceeds the 2h `autoMinIntervalMs`
    // it was passed, so a slow second writer evicting our pair went unreported.
    expect(
      findConcurrentSnapshotWriters(
        [
          `2026-09-29T22-00-00-000Z-pid10${HEAP_SNAPSHOT_EXTENSION}`,
          `2026-09-30T01-00-00-000Z-pid20${HEAP_SNAPSHOT_EXTENSION}`,
        ],
        self,
      ),
    ).toEqual({ pids: [20], newestStampMs: Date.parse("2026-09-30T01:00:00.000Z") });
  });

  it("ignores partials and names it did not write", () => {
    // Neither can be attributed to a process: a partial is not a retained
    // snapshot and so holds no `keep` slot, and an unparsed name yields no pid.
    // Only our own completed, stamped file remains.
    expect(
      findConcurrentSnapshotWriters(
        [
          `2026-09-29T22-00-00-000Z-pid10${HEAP_SNAPSHOT_EXTENSION}`,
          `2026-09-29T22-00-10-000Z-pid20${HEAP_SNAPSHOT_EXTENSION}.partial`,
          `heap-paperclip-0${HEAP_SNAPSHOT_EXTENSION}`,
        ],
        self,
      ),
    ).toBeNull();
  });

  it("reports every distinct peer and the newest write among them", () => {
    expect(
      findConcurrentSnapshotWriters(
        [
          `2026-09-29T22-00-00-000Z-pid30${HEAP_SNAPSHOT_EXTENSION}`,
          `2026-09-29T22-00-45-000Z-pid20${HEAP_SNAPSHOT_EXTENSION}`,
          `2026-09-29T22-00-50-000Z-pid10${HEAP_SNAPSHOT_EXTENSION}`,
        ],
        self,
      ),
    ).toEqual({ pids: [20, 30], newestStampMs: Date.parse("2026-09-29T22:00:45.000Z") });
  });

  it("is silent on an empty or single-entry directory", () => {
    expect(findConcurrentSnapshotWriters([], self)).toBeNull();
    expect(
      findConcurrentSnapshotWriters([`2026-09-29T22-00-00-000Z-pid10${HEAP_SNAPSHOT_EXTENSION}`], self),
    ).toBeNull();
  });
});

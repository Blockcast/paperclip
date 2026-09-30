/**
 * PEN-3314 — descriptor-class instrument.
 *
 * Three properties carry the whole value of this module and each has a way of
 * failing silently:
 *
 * 1. **Cardinality is bounded.** The leak under investigation is hypothesised
 *    to be per-poll-pass, so a naive `file:<full dirname>` label would itself
 *    grow one series per run directory — the detector reproducing the disease.
 *    Depth bounding and the top-N fold are therefore tested against paths
 *    shaped like this repo's real layout, not against toy strings.
 *
 * 2. **The counts stay a partition.** Truncation, readlink races and the fold
 *    all have to be *reported* rather than dropped, or the gauge silently
 *    under-counts exactly when the process is in the state it exists to
 *    describe (many descriptors).
 *
 * 3. **"Unmeasurable" is distinct from "zero".** A non-Linux runner must
 *    publish no series at all. A zeroed gauge there would be a confident
 *    assertion that nothing is open.
 */

import { describe, expect, it } from "vitest";

import {
  FD_CLASS_OTHER,
  FD_CLASS_TRUNCATED,
  FD_CLASS_UNREADABLE,
  FD_CLASS_VANISHED,
  classifyFdTarget,
  collectFdClassSnapshot,
} from "../services/fd-class-metrics.js";

function enoent(): NodeJS.ErrnoException {
  const err = new Error("ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

describe("classifyFdTarget", () => {
  it("classifies the kernel's non-file descriptor kinds", () => {
    expect(classifyFdTarget("socket:[12345]")).toBe("socket");
    expect(classifyFdTarget("pipe:[67890]")).toBe("pipe");
    expect(classifyFdTarget("memfd:foo (deleted)")).toBe("memfd");
    expect(classifyFdTarget("anon_inode:[eventpoll]")).toBe("anon_inode:eventpoll");
    expect(classifyFdTarget("anon_inode:inotify")).toBe("anon_inode:inotify");
  });

  it("refuses to carry an unconstrained anon_inode subtype into a label", () => {
    // The subtype is text read out of procfs. Bounded alphabet, not trust.
    expect(classifyFdTarget("anon_inode:[weird-1234]")).toBe("anon_inode");
    expect(classifyFdTarget("anon_inode:[" + "x".repeat(64) + "]")).toBe("anon_inode");
  });

  it("bounds a file path to its directory at a fixed depth", () => {
    // Real shape: the label must stop before the company UUID, which churns.
    expect(
      classifyFdTarget(
        "/paperclip/instances/default/projects/b1d3f3d3-adc9/1eb0ea12-97d9/repo/run.log",
      ),
    ).toBe("file:/paperclip/instances/default/projects");
    expect(classifyFdTarget("/dev/null")).toBe("file:/dev");
  });

  it("separates a descriptor held on an unlinked file — the classic leak signature", () => {
    expect(classifyFdTarget("/paperclip/data/diagnostics/heap/x.heapsnapshot (deleted)")).toBe(
      "deleted:/paperclip/data/diagnostics/heap",
    );
  });

  it("never lets a basename reach a label, whatever the path depth", () => {
    // These labels are published to Prometheus. A filename can carry a token or
    // a customer name; a depth-bounded directory cannot.
    expect(classifyFdTarget("/var/run/secrets/kubernetes.io/serviceaccount/token")).toBe(
      "file:/var/run/secrets/kubernetes.io",
    );
    expect(classifyFdTarget("/tmp/agent-session-9f2c-SECRETTOKEN.json")).toBe("file:/tmp");
    expect(classifyFdTarget("/SECRETTOKEN")).toBe("file:/");
  });

  it("surfaces an unrecognized procfs prefix as itself rather than hiding it", () => {
    expect(classifyFdTarget("bpf_map:[7]")).toBe("bpf_map");
    expect(classifyFdTarget("")).toBe(FD_CLASS_UNREADABLE);
  });
});

describe("collectFdClassSnapshot", () => {
  it("returns null when procfs is unreadable, so nothing is published", () => {
    const snapshot = collectFdClassSnapshot({
      dir: "/nope",
      readdir: () => {
        throw enoent();
      },
    });
    // Distinct from `{ classes: empty }`: a zeroed gauge on macOS would assert
    // "no descriptors open", which is never true of a running process.
    expect(snapshot).toBeNull();
  });

  it("counts a realistic table and keeps the classes summing to the total", () => {
    const targets: Record<string, string> = {
      "0": "/dev/null",
      "1": "pipe:[1]",
      "2": "pipe:[2]",
      "3": "socket:[3]",
      "4": "socket:[4]",
      "5": "anon_inode:[eventpoll]",
      "6": "/paperclip/instances/default/projects/co/proj/repo/a.log",
      "7": "/paperclip/instances/default/projects/co/proj/repo/b.log",
    };
    const snapshot = collectFdClassSnapshot({
      dir: "/fake",
      readdir: () => Object.keys(targets),
      readlink: (path) => targets[path.slice("/fake/".length)]!,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot!.total).toBe(8);
    expect(Object.fromEntries(snapshot!.classes)).toEqual({
      "file:/dev": 1,
      pipe: 2,
      socket: 2,
      "anon_inode:eventpoll": 1,
      "file:/paperclip/instances/default/projects": 2,
    });
    const summed = [...snapshot!.classes.values()].reduce((a, b) => a + b, 0);
    expect(summed).toBe(snapshot!.total);
  });

  it("books a readlink race as `vanished` rather than losing the descriptor", () => {
    // readdir opens a descriptor to enumerate the table and closes it before
    // these readlinks run, so roughly one per call is expected and benign. It
    // still has to be counted, or a *rising* race rate would be invisible.
    const snapshot = collectFdClassSnapshot({
      dir: "/fake",
      readdir: () => ["0", "1"],
      readlink: (path) => {
        if (path.endsWith("/1")) throw enoent();
        return "socket:[1]";
      },
    });
    expect(Object.fromEntries(snapshot!.classes)).toEqual({ socket: 1, [FD_CLASS_VANISHED]: 1 });
  });

  it("books a non-ENOENT readlink failure separately from a race", () => {
    const snapshot = collectFdClassSnapshot({
      dir: "/fake",
      readdir: () => ["0"],
      readlink: () => {
        const err = new Error("EACCES") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      },
    });
    expect(Object.fromEntries(snapshot!.classes)).toEqual({ [FD_CLASS_UNREADABLE]: 1 });
  });

  it("caps inspection cost and reports the remainder instead of dropping it", () => {
    let readlinks = 0;
    const snapshot = collectFdClassSnapshot({
      dir: "/fake",
      readdir: () => Array.from({ length: 50 }, (_, i) => String(i)),
      readlink: () => {
        readlinks += 1;
        return "socket:[1]";
      },
      maxEntries: 10,
    });

    // The cost bound is the point: this runs on the scrape path in precisely
    // the scenario where the descriptor count is growing without limit.
    expect(readlinks).toBe(10);
    expect(snapshot!.total).toBe(50);
    expect(snapshot!.classes.get(FD_CLASS_TRUNCATED)).toBe(40);
    const summed = [...snapshot!.classes.values()].reduce((a, b) => a + b, 0);
    expect(summed).toBe(50);
  });

  it("folds the long tail into `other` so the series count stays bounded", () => {
    const snapshot = collectFdClassSnapshot({
      dir: "/fake",
      // 10 distinct top-level directories, one descriptor each except /d0,
      // which gets five so the ranking has something to prefer.
      readdir: () => Array.from({ length: 14 }, (_, i) => String(i)),
      readlink: (path) => {
        const fd = Number(path.slice("/fake/".length));
        return fd < 5 ? "/d0/sub/f" : `/d${fd - 4}/sub/f`;
      },
      maxSeries: 3,
    });

    const classes = Object.fromEntries(snapshot!.classes);
    expect(Object.keys(classes)).toHaveLength(3);
    expect(classes["file:/d0/sub"]).toBe(5);
    expect(classes[FD_CLASS_OTHER]).toBeGreaterThan(0);
    // Fold, not drop — `other` climbing must remain readable as "the leak is in
    // the tail" rather than as descriptors going missing.
    const summed = [...snapshot!.classes.values()].reduce((a, b) => a + b, 0);
    expect(summed).toBe(14);
  });

  it("breaks ranking ties on the class name so the published set is stable", () => {
    // Three classes at one descriptor each, cap of two. Without a deterministic
    // tiebreak the survivor would rotate between scrapes and every class would
    // look like it was appearing and disappearing.
    const build = () =>
      collectFdClassSnapshot({
        dir: "/fake",
        readdir: () => ["2", "0", "1"],
        readlink: (path) => `/d${path.slice("/fake/".length)}/sub/f`,
        maxSeries: 2,
      });
    // Asserted against a literal, not against a second call: comparing two runs
    // of the same code would pass even if the tiebreak were readdir order.
    expect(Object.fromEntries(build()!.classes)).toEqual({
      "file:/d0/sub": 1,
      [FD_CLASS_OTHER]: 2,
    });
  });
});

describe("the real descriptor table", () => {
  const onLinux = process.platform === "linux";

  it.runIf(onLinux)("reads this process's own table and finds live descriptors", () => {
    // A positive control: every assertion above drives injected fakes, so
    // without this the whole suite could pass against a procfs layout that does
    // not exist. It is skipped rather than faked off Linux.
    const snapshot = collectFdClassSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.total).toBeGreaterThan(0);
    const summed = [...snapshot!.classes.values()].reduce((a, b) => a + b, 0);
    expect(summed).toBe(snapshot!.total);
  });
});

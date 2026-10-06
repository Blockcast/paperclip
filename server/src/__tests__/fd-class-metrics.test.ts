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
 *    assertion that nothing is open. The same distinction applies one level
 *    up and is tested separately: "unmeasurable because this host has no
 *    procfs" (absent) must not collapse into "unmeasurable because reading it
 *    failed" (a lone `table-unreadable` series), or an investigator on a Linux
 *    pod is told the instrument is not deployed while it is deployed and
 *    broken.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  FD_CLASS_MAX_SEGMENT_CHARS,
  FD_CLASS_OTHER,
  FD_CLASS_TABLE_UNREADABLE,
  FD_CLASS_TRUNCATED,
  FD_CLASS_UNREADABLE,
  FD_CLASS_VANISHED,
  classifyFdTarget,
  collectFdClassSnapshot,
} from "../services/fd-class-metrics.js";
import {
  PROCESS_OPEN_FDS_BY_CLASS_METRIC,
  __resetMetricsForTest,
  renderMetrics,
  setFdClassMetrics,
} from "../services/metrics.js";

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

  it("classifies the SLASHED memfd spelling the kernel actually emits", () => {
    // Verified against a live Linux kernel, not inferred: memfd_create(
    // "paperclip-heap") readlinks to `/memfd:paperclip-heap (deleted)` — with a
    // leading slash. The unslashed assertion above passes against a string the
    // kernel does not produce, so on its own it would have let every real memfd
    // fall through to the path branch and land in `deleted:/`, polluting the
    // class documented as the classic leak signature. PR #2117 adds heap
    // snapshots via memfd, which is what makes this load-bearing here.
    expect(classifyFdTarget("/memfd:paperclip-heap (deleted)")).toBe("memfd");
    expect(classifyFdTarget("/memfd:foo")).toBe("memfd");
  });

  it("refuses to carry an unconstrained anon_inode subtype into a label", () => {
    // The subtype is text read out of procfs. Bounded alphabet, not trust.
    expect(classifyFdTarget("anon_inode:[weird-1234]")).toBe("anon_inode");
    expect(classifyFdTarget("anon_inode:[" + "x".repeat(64) + "]")).toBe("anon_inode");
  });

  it("keeps the hyphenated subtypes the kernel actually uses", () => {
    // `bpf-map` / `bpf-prog` / `bpf-link` are real kernel anon_inode names. A
    // lowercase-and-underscore-only alphabet collapsed all of them to bare
    // `anon_inode`, discarding real information, and made the `bpf-map:`
    // example in classifyFdTarget's own comment describe behaviour the code
    // did not have. The alphabet stays closed — it just includes `-`.
    expect(classifyFdTarget("anon_inode:[bpf-map]")).toBe("anon_inode:bpf-map");
    expect(classifyFdTarget("bpf-map:[7]")).toBe("bpf-map");
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

  it("redacts a per-run identifier that sits INSIDE the depth bound", () => {
    // The depth bound alone is not a cardinality bound: it stops the identifier
    // only when ≥4 stable segments precede it. These two trees are created once
    // per heartbeat run with the identifier at depth 2 and 3, so under depth
    // bounding alone each run minted a fresh Prometheus series — the detector
    // reproducing the disease it was built to find (property #1 above).
    //
    // `run-scratch.ts` does mkdtemp(`/tmp/paperclip-run-<issue>-<run>-`):
    expect(classifyFdTarget("/tmp/paperclip-run-BLO-38624-abc123def456-XyZ9aB/scratch.json")).toBe(
      "file:/tmp/paperclip-run-*",
    );
    // A second run must produce the SAME label. Asserted against a literal and
    // against each other, since equality alone would hold for any constant.
    expect(classifyFdTarget("/tmp/paperclip-run-PEN-3314-99ffee001122-Qw3rTy/marker")).toBe(
      "file:/tmp/paperclip-run-*",
    );
    // The run-home tree puts the run id one segment deeper:
    expect(
      classifyFdTarget("/runtime-cache/paperclip-runs/7d127898-e955-490d-96b7-fac13ceb8b10/workspace/f"),
    ).toBe("file:/runtime-cache/paperclip-runs/*/workspace");
    // Shape is preserved, not truncated away: collapsing at the identifier
    // would fold every per-run tree into `/runtime-cache/paperclip-runs` and
    // lose the fact that the descriptor is under `workspace`.
    expect(
      classifyFdTarget("/runtime-cache/paperclip-runs/0a9dd3bb-69fa-4761-af14-87063e4da571/cache/f"),
    ).toBe("file:/runtime-cache/paperclip-runs/*/cache");
    // A wholly identifier-shaped segment reduces to the marker on its own.
    expect(classifyFdTarget("/var/lib/b1d3f3d3-adc9-48af-beb1-013a18368d84/sock")).toBe(
      "file:/var/lib/*",
    );
    // Including a UUID whose leading chunks carry no digit: the digit rule
    // alone published `abcdefab-cdef-*`, one series per such run.
    expect(classifyFdTarget("/var/lib/abcdefab-cdef-4abc-bead-defacedbeefa/sock")).toBe(
      "file:/var/lib/*",
    );
    expect(
      classifyFdTarget("/runtime-cache/paperclip-runs/abcdefab-cdef-4abc-bead-defacedbeefa/workspace/f"),
    ).toBe("file:/runtime-cache/paperclip-runs/*/workspace");
  });

  it("keeps stable directory names verbatim, including short digit-bearing ones", () => {
    // The redaction rejects identifier *shapes*; it must not swallow ordinary
    // names, or the instrument stops naming code sites and everything useful
    // collapses into `*`.
    expect(classifyFdTarget("/usr/lib/x86_64-linux-gnu/libc.so")).toBe(
      "file:/usr/lib/x86_64-linux-gnu",
    );
    expect(classifyFdTarget("/opt/node/v1/lib/f")).toBe("file:/opt/node/v1/lib");
    expect(classifyFdTarget("/app/node_modules/.pnpm/f")).toBe("file:/app/node_modules/.pnpm");
  });

  it("caps the verbatim prefix even when every token is individually stable", () => {
    // The residual in shape-rejection: a long all-lowercase hyphenated name
    // passes every token test and would rebuild at unbounded length. Nothing
    // this repo generates has that shape, so this is a backstop — but it is
    // what makes "the label alphabet is bounded" true unconditionally.
    const long = "alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel";
    expect(classifyFdTarget(`/srv/${long}/f`)).toBe("file:/srv/alpha-bravo-charlie-delta-echo-*");
    // A different long name sharing the first 32 chars collapses to the SAME
    // label, which is the property that bounds the series count.
    expect(classifyFdTarget(`/srv/${long}-india-juliet/f`)).toBe(
      "file:/srv/alpha-bravo-charlie-delta-echo-*",
    );
    // Real names stay untouched — the cap must not start mangling ordinary
    // directories, or the instrument stops naming code sites.
    expect(classifyFdTarget("/usr/lib/x86_64-linux-gnu/libc.so")).toBe(
      "file:/usr/lib/x86_64-linux-gnu",
    );
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

  it("holds every emitted segment inside the stated character cap", () => {
    // The cap is a constant a future reader will size something against, so it
    // has to mean its name. It previously charged only `prefix + token`, while
    // the separator and the `*` marker landed in the label too — this exact
    // input measured 34 characters against a ceiling of 32.
    const measured = "/wwwww-xxxxx-yyyyy-zzzzz-ssssssss-ZZ/f";
    expect(classifyFdTarget(measured)).toBe("file:/wwwww-xxxxx-yyyyy-zzzzz-*");

    // Property, not just the one regression: no segment of any emitted label
    // exceeds the cap, including the dotted and fully-volatile forms.
    const inputs = [
      measured,
      "/.cache-aaaaa-bbbbb-ccccc-ddddd-eeeee-ZZ/f",
      "/tmp/paperclip-run-BLO-38624-abc123def456-XyZ9aB/scratch.json",
      "/aaaaa-bbbbb-ccccc-ddddd-eeeee-fffff-GG/f",
      "/usr/lib/x86_64-linux-gnu/libc.so",
    ];
    for (const input of inputs) {
      for (const segment of classifyFdTarget(input).replace(/^file:/, "").split("/")) {
        expect(segment.length).toBeLessThanOrEqual(FD_CLASS_MAX_SEGMENT_CHARS);
      }
    }
  });
});

describe("collectFdClassSnapshot", () => {
  it("returns null when there is no procfs at all, so nothing is published", () => {
    for (const code of ["ENOENT", "ENOTDIR"]) {
      const snapshot = collectFdClassSnapshot({
        dir: "/nope",
        readdir: () => {
          const err = new Error(code) as NodeJS.ErrnoException;
          err.code = code;
          throw err;
        },
      });
      // Distinct from `{ classes: empty }`: a zeroed gauge on macOS would assert
      // "no descriptors open", which is never true of a running process.
      expect(snapshot).toBeNull();
    }
  });

  it("books a failed table enumeration separately from an absent procfs", () => {
    // The whole point of the distinction: on a Linux pod these errnos mean the
    // instrument is deployed and FAILING, and collapsing them into the same
    // `null` as the non-Linux case tells an investigator it is not deployed.
    // Mutating the branch back to a bare `return null` fails here.
    for (const code of ["EACCES", "ENOMEM", "EMFILE"]) {
      const snapshot = collectFdClassSnapshot({
        dir: "/proc/self/fd",
        readdir: () => {
          const err = new Error(code) as NodeJS.ErrnoException;
          err.code = code;
          throw err;
        },
      });
      expect(snapshot).not.toBeNull();
      // Value is 0 and the partition still holds; presence is what carries the
      // signal. Deliberately NOT FD_CLASS_UNREADABLE, which counts descriptors
      // that were inspected and could not be classified.
      expect(Object.fromEntries(snapshot!.classes)).toEqual({ [FD_CLASS_TABLE_UNREADABLE]: 0 });
      expect(snapshot!.total).toBe(0);
    }
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

  it("truncates by descriptor NUMBER, not by readdir's lexicographic order", () => {
    // `readdirSync` on procfs returns lexicographic order under Node —
    // measured: 0,1,10,11,…,2,20,21,3. (The kernel iterates numerically, so
    // sampling this in Python shows numeric order and hides it.) Slicing that
    // raw takes a prefix biased toward low leading digits rather than the
    // lowest-numbered descriptors, and it does so precisely when truncation
    // engages — the leak scenario, where a biased sample of the table is the
    // one thing this must not report.
    const inspectedFds: number[] = [];
    const snapshot = collectFdClassSnapshot({
      dir: "/fake",
      // 25 descriptors handed back in the order procfs+Node really produce.
      readdir: () => [...Array.from({ length: 25 }, (_, i) => String(i))].sort(),
      readlink: (path) => {
        inspectedFds.push(Number(path.slice("/fake/".length)));
        return "socket:[1]";
      },
      maxEntries: 5,
    });

    expect([...inspectedFds].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    // Asserted against a literal: lexicographic slicing would have inspected
    // 0,1,10,11,12 instead, which is a different and biased sample.
    expect(inspectedFds).not.toContain(10);
    expect(snapshot!.total).toBe(25);
    expect(snapshot!.classes.get(FD_CLASS_TRUNCATED)).toBe(20);
    const summed = [...snapshot!.classes.values()].reduce((a, b) => a + b, 0);
    expect(summed).toBe(25);
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

describe("setFdClassMetrics (the publish path)", () => {
  // The collector is covered above; this covers the layer that turns a snapshot
  // into series. Both behaviours asserted here are labelled load-bearing in the
  // source and neither was exercised: deleting `gauge.reset()` left the whole
  // suite green.
  afterEach(() => {
    __resetMetricsForTest();
  });

  async function publishedClasses(): Promise<Record<string, number>> {
    const { body } = await renderMetrics();
    const out: Record<string, number> = {};
    for (const line of body.split("\n")) {
      if (line.startsWith("#") || !line.startsWith(PROCESS_OPEN_FDS_BY_CLASS_METRIC)) continue;
      const matched = /\{fd_class="([^"]*)"\}\s+(\S+)$/.exec(line);
      if (matched) out[matched[1]!] = Number(matched[2]);
    }
    return out;
  }

  it("publishes one series per class", async () => {
    setFdClassMetrics({ classes: new Map([["socket", 3], ["file:/tmp", 2]]), total: 5 });
    expect(await publishedClasses()).toEqual({ socket: 3, "file:/tmp": 2 });
  });

  it("stops publishing a class once its descriptors are closed", async () => {
    // This is what `gauge.reset()` buys. Without it `file:/tmp` keeps reporting
    // 2 forever and reads as a leak that plateaued — the exact misreading this
    // gauge exists to prevent, since the question it answers is which class is
    // *currently* accumulating.
    setFdClassMetrics({ classes: new Map([["socket", 3], ["file:/tmp", 2]]), total: 5 });
    setFdClassMetrics({ classes: new Map([["socket", 4]]), total: 4 });
    expect(await publishedClasses()).toEqual({ socket: 4 });
  });

  it("publishes NO series at all for a null snapshot", async () => {
    // Property #3. Tested here at the publishing layer, not just at the
    // collector returning null: a zeroed-but-present series on a non-Linux
    // runner would be a confident assertion that nothing is open.
    setFdClassMetrics(null);
    expect(await publishedClasses()).toEqual({});
  });

  it("publishes the zero-valued table-unreadable sentinel", async () => {
    // The sentinel's whole mechanism is that the series is *present* at 0, and
    // every other test here uses non-zero counts, so a "skip empty classes"
    // tidy-up in the publish loop would render it as `{}` — identical to the
    // null snapshot above — with the whole suite still green.
    setFdClassMetrics({ classes: new Map([[FD_CLASS_TABLE_UNREADABLE, 0]]), total: 0 });
    expect(await publishedClasses()).toEqual({ [FD_CLASS_TABLE_UNREADABLE]: 0 });
  });

  it("drops the previous scrape's series when procfs becomes unreadable", async () => {
    // The two behaviours interact: `null` must clear as well as publish
    // nothing, or a procfs that stops being readable freezes the last good
    // histogram in place and it reads as live.
    setFdClassMetrics({ classes: new Map([["socket", 3]]), total: 3 });
    setFdClassMetrics(null);
    expect(await publishedClasses()).toEqual({});
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

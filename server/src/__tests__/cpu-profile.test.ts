import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CPU_PROFILE_EXTENSION,
  CPU_PROFILE_SENTINEL_BASENAME,
  maybeDumpStallFlightRecording,
  maybeTakeCpuProfile,
  STALL_PROFILE_COOLDOWN_MS,
  STALL_PROFILE_MIN_STALL_MS,
  startCpuFlightRecorder,
  stopCpuFlightRecorder,
  summarizeCpuProfile,
} from "../services/cpu-profile.js";

describe("maybeTakeCpuProfile (BLO-45336)", () => {
  it("does nothing without the sentinel", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cpuprof-"));
    expect(await maybeTakeCpuProfile({ dir, durationMs: 10, keep: 3 })).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("consumes the sentinel, writes a parseable profile, and keeps only the newest N", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cpuprof-"));
    for (const old of ["2000-01-01T00-00-00-000Z-pid1", "2000-01-02T00-00-00-000Z-pid1"]) {
      writeFileSync(path.join(dir, old + CPU_PROFILE_EXTENSION), "{}");
    }
    writeFileSync(path.join(dir, "keep-me.heapsnapshot"), "x");
    writeFileSync(path.join(dir, CPU_PROFILE_SENTINEL_BASENAME), "");

    const file = (await maybeTakeCpuProfile({ dir, durationMs: 50, keep: 2 }))?.file;

    expect(file).not.toBeNull();
    const profile = JSON.parse(readFileSync(file!, "utf8"));
    expect(Array.isArray(profile.nodes)).toBe(true);
    expect(profile.nodes.length).toBeGreaterThan(0);
    expect(readdirSync(dir).sort()).toEqual(
      ["2000-01-02T00-00-00-000Z-pid1.cpuprofile", path.basename(file!), "keep-me.heapsnapshot"].sort(),
    );
    // Sentinel consumed: a second poll is a no-op.
    expect(await maybeTakeCpuProfile({ dir, durationMs: 10, keep: 2 })).toBeNull();
  });
});

function blockTheLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // busy: a synchronous stall the profile must attribute
  }
}

describe("CPU flight recorder (BLO-51594)", () => {
  afterEach(() => stopCpuFlightRecorder());

  // Assert on the busy run, not a frame name: V8 inlines blockTheLoop once hot.
  const busyMs = (summary: object) => (summary as { longestBusyMs: number }).longestBusyMs;

  it("dumps a profile that contains the stall that happened BEFORE the dump was asked for", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cpuprof-"));
    await startCpuFlightRecorder({ segmentMs: 60_000, samplingIntervalUs: 1_000 });
    blockTheLoop(300);
    const res = await maybeDumpStallFlightRecording(STALL_PROFILE_MIN_STALL_MS, { dir, keep: 3, now: 1e12 });
    expect(res).not.toBeNull();
    expect(Array.isArray(JSON.parse(readFileSync(res!.file, "utf8")).nodes)).toBe(true);
    expect(busyMs(res!.summary)).toBeGreaterThanOrEqual(200);
  });

  it("still finds the stall when a segment rotation ran between the stall and the dump", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cpuprof-"));
    await startCpuFlightRecorder({ segmentMs: 200, samplingIntervalUs: 1_000 });
    blockTheLoop(300);
    // The overdue rotation fires once, right after the block, closing the
    // segment that holds it; the next is 200 ms away.
    await new Promise((r) => setTimeout(r, 50));
    const res = await maybeDumpStallFlightRecording(STALL_PROFILE_MIN_STALL_MS, { dir, keep: 3, now: 2e12 });
    expect(busyMs(res!.summary)).toBeGreaterThanOrEqual(200);
  });

  it("ignores short stalls, honours the cooldown, and is a no-op with no recorder", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cpuprof-"));
    const opts = { dir, keep: 3 };
    expect(await maybeDumpStallFlightRecording(60_000, { ...opts, now: 3e12 })).toBeNull();
    await startCpuFlightRecorder({ segmentMs: 60_000, samplingIntervalUs: 10_000 });
    expect(await maybeDumpStallFlightRecording(STALL_PROFILE_MIN_STALL_MS - 1, { ...opts, now: 4e12 })).toBeNull();
    expect(await maybeDumpStallFlightRecording(STALL_PROFILE_MIN_STALL_MS, { ...opts, now: 4e12 })).not.toBeNull();
    expect(
      await maybeDumpStallFlightRecording(60_000, { ...opts, now: 4e12 + STALL_PROFILE_COOLDOWN_MS - 1 }),
    ).toBeNull();
    expect(
      await maybeDumpStallFlightRecording(60_000, { ...opts, now: 4e12 + STALL_PROFILE_COOLDOWN_MS }),
    ).not.toBeNull();
  });
});

describe("summarizeCpuProfile (BLO-51594)", () => {
  const frame = (id: number, functionName: string, children: number[] = []) => ({
    id,
    callFrame: { functionName, url: "file:///app/x.js", lineNumber: id },
    children,
  });
  // root -> loop -> { sweep -> hot, tick }, plus idle
  const nodes = [frame(1, "(root)", [2, 6]), frame(2, "loop", [3, 5]), frame(3, "sweep", [4]), frame(4, "hot"), frame(5, "tick"), frame(6, "(idle)")];

  it("names the heaviest frame in the longest non-idle run, not the profile-wide total", () => {
    // short busy run on `tick` (30 ms), idle, then an 18 s run dominated by `hot`, idle.
    const samples = [5, 5, 5, 5, 6, 4, 4, 4, 5, 6];
    const timeDeltas = [0, 10e3, 10e3, 10e3, 10e3, 10e3, 6e6, 6e6, 6e6, 1e3];
    const s = summarizeCpuProfile({ nodes, samples, timeDeltas });
    expect(s.longestBusyMs).toBe(18_001);
    expect(s.topFrames[0]).toEqual({
      selfMs: 18_000,
      stack: ["hot file:///app/x.js:5", "sweep file:///app/x.js:4", "loop file:///app/x.js:3"],
    });
    // `tick` also ran 40 ms in the earlier, shorter run; only the stall run counts.
    expect(s.topFrames.map((f) => [f.stack[0].split(" ")[0], f.selfMs])).toEqual([["hot", 18_000], ["tick", 1]]);
  });

  it("is empty, not throwing, on a profile with no samples", () => {
    expect(summarizeCpuProfile({ nodes })).toEqual({ longestBusyMs: 0, topFrames: [] });
  });
});

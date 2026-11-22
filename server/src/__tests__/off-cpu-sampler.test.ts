import { afterEach, describe, expect, it } from "vitest";
import {
  readOffCpuSamples,
  startOffCpuSampler,
  stopOffCpuSampler,
  summarizeOffCpuSamples,
} from "../services/off-cpu-sampler.js";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.runIf(process.platform === "linux")("off-CPU sampler (BLO-58777)", () => {
  afterEach(() => stopOffCpuSampler());

  it("names a stall spent blocked in the kernel, which the CPU profile cannot see", async () => {
    startOffCpuSampler({ beatMs: 20, pollMs: 50, staleMs: 200 });
    await settle(300); // worker boot + a fresh heartbeat
    const from = Date.now();
    // Off-CPU block of the main thread: a futex sleep, the same shape as a sync fs call in D/S state.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
    const samples = await readOffCpuSamples(from, Date.now());
    expect(samples).not.toBeNull();
    const summary = summarizeOffCpuSamples(samples!);
    expect(summary.samples).toBeGreaterThanOrEqual(5);
    // Sleeping, not running: this is the attribution the flight recorder lacks.
    expect(summary.top[0].key).toMatch(/^S /);
    expect(summary.maxPollGapMs).toBeLessThan(500); // worker kept running: main thread blocked, process not stopped
  });

  it("records nothing while the main thread is responsive", async () => {
    startOffCpuSampler({ beatMs: 20, pollMs: 50, staleMs: 200 });
    const from = Date.now();
    await settle(600);
    expect(await readOffCpuSamples(from, Date.now())).toEqual([]);
  });

  it("reads null when not running", async () => {
    expect(await readOffCpuSamples(0, Date.now())).toBeNull();
  });
});

describe("summarizeOffCpuSamples", () => {
  it("ranks state+wchan+syscall and reports the worker's own lateness", () => {
    const s = (state: string, wchan: string, pollGapMs = 250) => ({ t: 0, sinceBeatMs: 0, pollGapMs, state, wchan, syscall: "0 0x5" });
    const out = summarizeOffCpuSamples([s("D", "ceph_mdsc_do_request"), s("D", "ceph_mdsc_do_request", 900), s("R", "0")]);
    expect(out).toEqual({
      samples: 3,
      maxPollGapMs: 900,
      top: [
        { key: "D wchan=ceph_mdsc_do_request syscall=0 0x5", n: 2 },
        { key: "R wchan=0 syscall=0 0x5", n: 1 },
      ],
    });
  });
});

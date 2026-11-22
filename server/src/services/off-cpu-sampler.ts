import { Worker } from "node:worker_threads";

/**
 * Off-CPU stall attribution (BLO-58777).
 *
 * The flight recorder (cpu-profile.ts) only sees on-CPU JS. A 10.5 s stall on
 * 2026-11-22 had 1.4 s of samples: the rest was the main thread blocked in the
 * kernel (uninterruptible sleep delivers no SIGPROF, so V8 records nothing) or
 * the whole process stopped. The stall listener runs on the main thread AFTER
 * the stall, when the thread is running again, so it cannot see that state.
 *
 * So a worker thread watches a heartbeat the main thread writes every
 * `beatMs`. While the heartbeat is older than `staleMs` it reads the main
 * thread's `/proc/<pid>/task/<pid>/{stat,wchan,syscall}` every `pollMs`. On
 * Linux the main thread's tid is the pid. `pollGapMs` is the worker's own
 * lateness: a gap close to the stall means the worker was stopped too, i.e. the
 * whole process was frozen or descheduled, not just the main thread blocked.
 */

export type OffCpuSample = { t: number; sinceBeatMs: number; pollGapMs: number; state: string; wchan: string; syscall: string };
export type OffCpuSummary = { samples: number; maxPollGapMs: number; top: { key: string; n: number }[] };

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { readFileSync } = require("node:fs");
const beat = new BigInt64Array(workerData.beat);
const task = "/proc/" + workerData.pid + "/task/" + workerData.pid + "/";
const read = (f) => { try { return readFileSync(task + f, "utf8").trim(); } catch (e) { return "!" + (e.code || "err"); } };
// "<nr> <arg0> ..." in a syscall, "running" or "-1 ..." otherwise. Keep arg0 only when it looks like an
// fd: a pointer arg (futex address) would split one stall shape into a bucket per address.
const syscallKey = (raw) => { const [nr, a0] = raw.split(" "); return a0 && parseInt(a0, 16) < 0x10000 ? nr + " fd=" + parseInt(a0, 16) : nr; };
const ring = [];
let lastPoll = Date.now();
setInterval(() => {
  const now = Date.now();
  const pollGapMs = now - lastPoll;
  lastPoll = now;
  const sinceBeatMs = now - Number(Atomics.load(beat, 0));
  if (sinceBeatMs < workerData.staleMs && pollGapMs < workerData.staleMs) return;
  const stat = read("stat");
  ring.push({
    t: now, sinceBeatMs, pollGapMs,
    state: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0],
    wchan: read("wchan"),
    syscall: syscallKey(read("syscall")),
  });
  if (ring.length > workerData.keep) ring.shift();
}, workerData.pollMs);
parentPort.on("message", ({ id, from, to }) => parentPort.postMessage({ id, samples: ring.filter((s) => s.t >= from && s.t <= to) }));
`;

type Sampler = { worker: Worker; timer: ReturnType<typeof setInterval>; pending: Map<number, (s: OffCpuSample[]) => void>; nextId: number };
let sampler: Sampler | null = null;

/** Idempotent. Linux only (reads /proc); a no-op elsewhere. */
export function startOffCpuSampler(opts: { beatMs?: number; pollMs?: number; staleMs?: number; keep?: number } = {}): void {
  if (sampler || process.platform !== "linux") return;
  const { beatMs = 200, pollMs = 250, staleMs = 1_000, keep = 400 } = opts;
  const beatBuf = new SharedArrayBuffer(8);
  const beat = new BigInt64Array(beatBuf);
  Atomics.store(beat, 0, BigInt(Date.now()));
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { beat: beatBuf, pid: process.pid, pollMs, staleMs, keep },
    resourceLimits: { maxOldGenerationSizeMb: 16 },
  });
  worker.unref();
  const s: Sampler = {
    worker,
    timer: setInterval(() => Atomics.store(beat, 0, BigInt(Date.now())), beatMs),
    pending: new Map(),
    nextId: 0,
  };
  s.timer.unref?.();
  worker.on("message", ({ id, samples }: { id: number; samples: OffCpuSample[] }) => {
    s.pending.get(id)?.(samples);
    s.pending.delete(id);
  });
  // A dead sampler must not take the worker process with it; readers then time out to null.
  worker.on("error", () => undefined);
  sampler = s;
}

export function stopOffCpuSampler(): void {
  if (!sampler) return;
  clearInterval(sampler.timer);
  void sampler.worker.terminate();
  sampler = null;
}

/** Samples taken in [from, to] (epoch ms). Never rejects: null when not running or the worker does not answer. */
export function readOffCpuSamples(from: number, to: number, timeoutMs = 2_000): Promise<OffCpuSample[] | null> {
  const s = sampler;
  if (!s) return Promise.resolve(null);
  const id = s.nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      s.pending.delete(id);
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    s.pending.set(id, (samples) => {
      clearTimeout(timer);
      resolve(samples);
    });
    s.worker.postMessage({ id, from, to });
  });
}

/** Counts by kernel state + wait channel + syscall; each sample is ~pollMs of the stall. */
export function summarizeOffCpuSamples(samples: OffCpuSample[], top = 5): OffCpuSummary {
  const counts = new Map<string, number>();
  for (const s of samples) {
    const key = `${s.state} wchan=${s.wchan} syscall=${s.syscall}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {
    samples: samples.length,
    maxPollGapMs: samples.reduce((m, s) => Math.max(m, s.pollGapMs), 0),
    top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([key, n]) => ({ key, n })),
  };
}

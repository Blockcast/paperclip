import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { Session } from "node:inspector";
import path from "node:path";

/**
 * On-demand sampled CPU profiles for the worker tier (BLO-45336).
 *
 * The worker's event-loop lag floor is silent synchronous work: no log line
 * occurs around stalls more often than at random, so attribution needs stacks.
 * Same control channel as the heap snapshot (PEN-3631): drop a sentinel into
 * the shared snapshot directory, retrieve the result from any agent seat.
 *
 * Unlike a heap snapshot this is not gated behind a flag. A `.cpuprofile` holds
 * call frames (function name, script URL, line) and sample timings — no heap
 * values, so none of the secrets that make a heap snapshot a credential
 * exposure. Profiling costs a few percent CPU for the capture window only.
 */

export const CPU_PROFILE_SENTINEL_BASENAME = "cpuprofile.request";
export const CPU_PROFILE_EXTENSION = ".cpuprofile";

let capturing = false;

function pruneCpuProfiles(dir: string, keep: number): void {
  // Names start with an ISO stamp, so lexical order is capture order.
  const profiles = readdirSync(dir).filter((n) => n.endsWith(CPU_PROFILE_EXTENSION)).sort();
  for (const name of profiles.slice(0, Math.max(0, profiles.length - keep))) {
    unlinkSync(path.join(dir, name));
  }
}

/**
 * If the sentinel is present, consume it and capture a profile of `durationMs`.
 * Resolves to the written file, or null when there was nothing to do. The
 * sentinel is removed before capture so a failing capture cannot re-trigger on
 * every poll.
 */
export async function maybeTakeCpuProfile(opts: {
  dir: string;
  durationMs: number;
  keep: number;
}): Promise<{ file: string; summary: CpuProfileSummary | { summaryError: string } } | null> {
  const sentinel = path.join(opts.dir, CPU_PROFILE_SENTINEL_BASENAME);
  if (capturing || !existsSync(sentinel)) return null;
  unlinkSync(sentinel);
  return takeCpuProfile(opts);
}

/** Minimum stall that dumps the flight recording, and the gap between two dumps. */
export const STALL_PROFILE_MIN_STALL_MS = 3_000;
export const STALL_PROFILE_COOLDOWN_MS = 15 * 60_000;
let lastStallProfileAt = Number.NEGATIVE_INFINITY;

/**
 * Flight recorder (BLO-51594). The old stall trigger started a profile AFTER
 * the stall, so it could never contain it: 13 captures between 2026-11-06 and
 * 11-08 were triggered by 14-57 s stalls and every one described only the
 * 1-2 s noise that followed. Instead the profiler runs continuously in
 * `segmentMs` segments at a coarse sampling interval, and a stall dumps the
 * segment it happened in.
 *
 * Which segment that is depends on timer order: the stall delays the rotation
 * timer and the stall sampler alike, so if rotation runs first the stall lands
 * in the segment it just closed. Hence the last closed segment is kept and the
 * dump writes whichever of the two holds the longer busy run.
 */
type Recorder = { session: Session; previous: CpuProfile | null; timer: ReturnType<typeof setInterval>; queue: Promise<unknown> };
let recorder: Recorder | null = null;

function postTo(session: Session) {
  return (method: string, params?: object) =>
    new Promise<any>((resolve, reject) =>
      session.post(method, params ?? {}, (err, res) => (err ? reject(err) : resolve(res))),
    );
}

/** Serialize on the recorder so a rotation never interleaves with a dump. */
function onRecorder<T>(rec: Recorder, fn: () => Promise<T>): Promise<T> {
  const next = rec.queue.then(fn);
  rec.queue = next.catch(() => undefined);
  return next;
}

/**
 * Idempotent. The timer is registered synchronously: startServer's tests rely
 * on the heartbeat scheduler being the last timer it registers.
 */
export function startCpuFlightRecorder(opts: { segmentMs: number; samplingIntervalUs: number }): Promise<void> {
  if (recorder) return Promise.resolve();
  const session = new Session();
  session.connect();
  const post = postTo(session);
  const rec: Recorder = {
    session,
    previous: null,
    timer: setInterval(() => {
      void onRecorder(rec, async () => {
        const { profile } = await post("Profiler.stop");
        rec.previous = profile;
        await post("Profiler.start");
      }).catch(() => undefined);
    }, opts.segmentMs),
    queue: Promise.resolve(),
  };
  rec.timer.unref?.();
  recorder = rec;
  return onRecorder(rec, async () => {
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: opts.samplingIntervalUs });
    await post("Profiler.start");
  });
}

export function stopCpuFlightRecorder(): void {
  if (!recorder) return;
  clearInterval(recorder.timer);
  recorder.session.disconnect();
  recorder = null;
}

/** Resolves null when skipped (short stall, cooldown, or no recorder running). */
export function maybeDumpStallFlightRecording(
  stallMs: number,
  opts: { dir: string; keep: number; now?: number },
): Promise<{ file: string; summary: CpuProfileSummary | { summaryError: string } } | null> {
  const now = opts.now ?? Date.now();
  const rec = recorder;
  if (!rec || stallMs < STALL_PROFILE_MIN_STALL_MS) return Promise.resolve(null);
  if (now - lastStallProfileAt < STALL_PROFILE_COOLDOWN_MS) return Promise.resolve(null);
  lastStallProfileAt = now;
  return onRecorder(rec, async () => {
    const post = postTo(rec.session);
    const { profile: current } = await post("Profiler.stop");
    await post("Profiler.start");
    const busy = (p: CpuProfile) => {
      try {
        return summarizeCpuProfile(p, 0).longestBusyMs;
      } catch {
        return -1;
      }
    };
    const previous = rec.previous;
    rec.previous = null;
    const pick = previous && busy(previous) > busy(current) ? previous : current;
    return writeCpuProfile(pick, opts);
  });
}

type ProfileNode = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] };
type CpuProfile = { nodes: ProfileNode[]; samples?: number[]; timeDeltas?: number[] };

export type CpuProfileSummary = {
  /** Longest run of consecutive samples that never returned to the event loop ("(idle)"). */
  longestBusyMs: number;
  /** Heaviest self-time frames inside that run, each with its JS caller chain (innermost first). */
  topFrames: { selfMs: number; stack: string[] }[];
};

/**
 * Name the stall from inside the worker (BLO-51594). The `.cpuprofile` is only
 * reachable with `pods/exec` — isolated agent pods mount subpaths of
 * `paperclip-data`, not the diagnostics directory — so the profile went unread
 * while stalls grew to 18 s. Logging this puts the answer in Loki instead.
 */
export function summarizeCpuProfile(profile: CpuProfile, top = 5): CpuProfileSummary {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const isIdle = (id: number) => byId.get(id)?.callFrame.functionName === "(idle)";

  let best = { start: 0, end: 0, us: 0 };
  let start = 0;
  let us = 0;
  for (let i = 0; i <= samples.length; i++) {
    if (i === samples.length || isIdle(samples[i])) {
      if (us > best.us) best = { start, end: i, us };
      start = i + 1;
      us = 0;
    } else {
      // DevTools convention: sample i lasts until sample i+1, i.e. timeDeltas[i + 1].
      us += deltas[i + 1] ?? 0;
    }
  }

  const self = new Map<number, number>();
  for (let i = best.start; i < best.end; i++) self.set(samples[i], (self.get(samples[i]) ?? 0) + (deltas[i + 1] ?? 0));
  const label = (id: number) => {
    const f = byId.get(id)!.callFrame;
    return `${f.functionName || "(anonymous)"} ${f.url}:${f.lineNumber + 1}`;
  };
  const stackOf = (id: number) => {
    const out: string[] = [];
    for (let cur: number | undefined = id; cur !== undefined && out.length < 8; cur = parent.get(cur)) {
      if (byId.get(cur)!.callFrame.functionName !== "(root)") out.push(label(cur));
    }
    return out;
  };
  const topFrames = [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([id, selfUs]) => ({ selfMs: Math.round(selfUs / 1000), stack: stackOf(id) }));
  return { longestBusyMs: Math.round(best.us / 1000), topFrames };
}

async function writeCpuProfile(
  profile: CpuProfile,
  opts: { dir: string; keep: number },
): Promise<{ file: string; summary: CpuProfileSummary | { summaryError: string } }> {
  mkdirSync(opts.dir, { recursive: true });
  const file = path.join(
    opts.dir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-pid${process.pid}${CPU_PROFILE_EXTENSION}`,
  );
  // Async: a 10-minute profile is megabytes, and this directory is CephFS.
  await writeFile(`${file}.partial`, JSON.stringify(profile));
  await rename(`${file}.partial`, file);
  pruneCpuProfiles(opts.dir, opts.keep);
  // A summarizer bug must not swallow the "profile written" line: the file is the fallback.
  let summary: CpuProfileSummary | { summaryError: string };
  try {
    summary = summarizeCpuProfile(profile);
  } catch (err) {
    summary = { summaryError: String(err) };
  }
  return { file, summary };
}

async function takeCpuProfile(opts: { dir: string; durationMs: number; keep: number }): Promise<{ file: string; summary: CpuProfileSummary | { summaryError: string } }> {
  capturing = true;
  const session = new Session();
  try {
    session.connect();
    const post = postTo(session);
    await post("Profiler.enable");
    await post("Profiler.start");
    await new Promise((r) => setTimeout(r, opts.durationMs).unref());
    const { profile } = await post("Profiler.stop");
    return await writeCpuProfile(profile, opts);
  } finally {
    session.disconnect();
    capturing = false;
  }
}

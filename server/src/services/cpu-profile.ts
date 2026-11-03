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

/** Minimum stall that auto-starts a profile, and the gap between two auto-starts. */
export const STALL_PROFILE_MIN_STALL_MS = 3_000;
export const STALL_PROFILE_COOLDOWN_MS = 60 * 60_000;
let lastStallProfileAt = Number.NEGATIVE_INFINITY;

/**
 * Stall-triggered capture (BLO-45336). A profile cannot look backwards, so it
 * cannot catch the stall that triggers it — but >=3 s stalls arrive in clusters
 * (12 between 11:49Z and 12:10Z on 2026-10-21), so a long window opened by the
 * first one catches the next. An off-CPU block (sync fs on CephFS) should still
 * show as a sample gap whose next sample carries the calling frame — unverified.
 * Resolves null when skipped.
 */
export function maybeStartStallCpuProfile(
  stallMs: number,
  opts: { dir: string; durationMs: number; keep: number; now?: number },
): Promise<{ file: string; summary: CpuProfileSummary | { summaryError: string } } | null> {
  const now = opts.now ?? Date.now();
  if (capturing || stallMs < STALL_PROFILE_MIN_STALL_MS) return Promise.resolve(null);
  if (now - lastStallProfileAt < STALL_PROFILE_COOLDOWN_MS) return Promise.resolve(null);
  lastStallProfileAt = now;
  return takeCpuProfile(opts);
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

async function takeCpuProfile(opts: { dir: string; durationMs: number; keep: number }): Promise<{ file: string; summary: CpuProfileSummary | { summaryError: string } }> {
  capturing = true;
  const session = new Session();
  try {
    session.connect();
    const post = (method: string, params?: object) =>
      new Promise<any>((resolve, reject) =>
        session.post(method, params ?? {}, (err, res) => (err ? reject(err) : resolve(res))),
      );
    await post("Profiler.enable");
    await post("Profiler.start");
    await new Promise((r) => setTimeout(r, opts.durationMs).unref());
    const { profile } = await post("Profiler.stop");
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
  } finally {
    session.disconnect();
    capturing = false;
  }
}

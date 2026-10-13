import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
}): Promise<string | null> {
  const sentinel = path.join(opts.dir, CPU_PROFILE_SENTINEL_BASENAME);
  if (capturing || !existsSync(sentinel)) return null;
  unlinkSync(sentinel);
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
    writeFileSync(`${file}.partial`, JSON.stringify(profile));
    renameSync(`${file}.partial`, file);
    pruneCpuProfiles(opts.dir, opts.keep);
    return file;
  } finally {
    session.disconnect();
    capturing = false;
  }
}

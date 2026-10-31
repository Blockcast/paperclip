import { POD_LOG_STREAM_MARKER } from "./job-manifest.js";

/**
 * PEN-5120 — the COLLECTOR half.
 *
 * `buildPodLogPath` returns two absolute addresses for one file on the premise
 * that the server and the agent pod mount the same volume. PEN-4932 removes
 * that premise: once the Job's claim is per-agent, the file the container tees
 * to is on a volume this process cannot open, `tailPodLogFile` waits 30 s and
 * throws, `Promise.allSettled` turns that into `stdout = ""`, and the result
 * parser has nothing to read.
 *
 * `job-manifest.ts` already lands the EMIT half: on a foreign claim the
 * fail-fast `awk` stamps `POD_LOG_STREAM_MARKER` on every transcript line and
 * stops discarding its stdout, so the run's output also leaves the pod on the
 * container log — a channel that assumes no shared volume. This module is what
 * reads it back.
 *
 * Four properties are load-bearing, and each is a test rather than a comment:
 *
 *  1. **The marker is the only accepted frame.** `readNamespacedPodLog` has no
 *     stream selector, so fd 1 and fd 2 arrive interleaved: the agent's own
 *     stderr, the launcher preflight and the wrapper's diagnostics are in the
 *     same view as the NDJSON. Anything not carrying the marker is somebody
 *     else's line and is dropped. This is also why a bare `tail`-equivalent of
 *     the container log cannot stand in for the file.
 *
 *  2. **A stream end is not proof the run ended.** `@kubernetes/client-node`'s
 *     own `Log.log` carries the comment *"the follow search param still has the
 *     stream close prematurely based on my testing"*, and FAR-10 is the opposite
 *     failure — the API holding a connection open indefinitely. So the follow is
 *     a loop that reconnects until the JOB is observed terminal (`stopSignal`),
 *     not a single await.
 *
 *  3. **Resume is by timestamp, so a reconnect cannot silently skip.**
 *     `timestamps: true` plus `sinceTime` at the last line's second. `sinceTime`
 *     is second-granular and inclusive, so the replay necessarily re-delivers
 *     lines already accepted — dedup within that second is what makes the resume
 *     lossless rather than merely lossy-in-the-other-direction.
 *
 *  4. **Every accepted line is persisted to the server's own `podLogPath`.**
 *     That path is rooted at `SELF_POD_DATA_MOUNT_PATH` — this process's OWN
 *     claim — so it is writable no matter which claim the Job mounted. Keeping
 *     it populated is what leaves the belt-and-braces on-disk re-read,
 *     `reapPodLogFile`'s `unlink` and `isReapablePodLogPath` working unchanged
 *     instead of each needing its own foreign-claim branch.
 */

/** One line of `readNamespacedPodLog(timestamps: true)` output. */
export interface TimestampedLogLine {
  /** RFC3339Nano stamp the kubelet prefixed, or "" when the line carried none. */
  timestamp: string;
  /** Everything after that stamp — still carrying the marker, if it has one. */
  payload: string;
}

/** Matches the kubelet's RFC3339Nano prefix, and nothing that merely starts with digits. */
const RFC3339_NANO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Split a kubelet-stamped log line into its timestamp and payload.
 *
 * Returns `timestamp: ""` rather than null for an unstamped line: such a line is
 * still perfectly usable as output, it just cannot anchor a resume point. Making
 * it null would have thrown away real transcript whenever the stamp was absent.
 */
export function parseTimestampedLogLine(line: string): TimestampedLogLine {
  const space = line.indexOf(" ");
  if (space <= 0) return { timestamp: "", payload: line };
  const candidate = line.slice(0, space);
  if (!RFC3339_NANO.test(candidate)) return { timestamp: "", payload: line };
  return { timestamp: candidate, payload: line.slice(space + 1) };
}

/**
 * Truncate an RFC3339Nano stamp to the second, in Z form.
 *
 * This is the resume point, and the truncation is deliberate rather than
 * lossy-by-accident: the Kubernetes log API parses `sinceTime` as a
 * second-granular `metav1.Time`, so a nanosecond value would be rounded by the
 * server anyway — and rounded in whichever direction the server chooses. Doing
 * it here, downwards, makes the replay a known superset of what we already hold
 * instead of a possible gap.
 */
export function truncateTimestampToSecond(timestamp: string): string | undefined {
  if (!timestamp) return undefined;
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return undefined;
  return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

export interface PodLogStreamDeps {
  /**
   * Open a FOLLOW stream and resolve when it ends; reject if it cannot be
   * opened. `onData` receives raw chunks, not lines.
   */
  follow(input: { sinceTime?: string; onData: (chunk: string) => void }): Promise<void>;
  /** One-shot, non-follow read of the whole container log. */
  read(input: { sinceTime?: string }): Promise<string>;
  /** Mirrors `tailPodLogFile`'s live emission. */
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  /** Persist one accepted transcript line (no trailing newline) to the server's copy. */
  persist?: (line: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export interface PodLogStreamOptions extends PodLogStreamDeps {
  /** Set by `waitForJobCompletion`; the one authority on "the run is over". */
  stopSignal: { stopped: boolean };
  /**
   * Hard bound on reconnects, so a pod whose log endpoint refuses in a tight
   * loop cannot spin for the whole completion timeout. Exceeding it stops the
   * follow; the final non-follow pass still runs, so the run degrades to a
   * single read rather than to nothing.
   */
  maxReconnects?: number;
}

export interface PodLogStreamResult {
  /** The accumulated transcript, newline-joined, exactly as `tailPodLogFile` returns it. */
  stdout: string;
  /** Accepted transcript lines. */
  lines: number;
  /** Follow connections opened beyond the first. */
  reconnects: number;
  /** Lines the resume replay re-delivered and this collector dropped. */
  duplicates: number;
}

const DEFAULT_MAX_RECONNECTS = 50;
const RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000];

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Follow a pod's container log and return the marked transcript it carries.
 *
 * Shaped to be a drop-in for `tailPodLogFile`: same return type, same live
 * `onLog` emission, same "stop when the Job is terminal" contract.
 */
export async function collectPodLogStream(opts: PodLogStreamOptions): Promise<PodLogStreamResult> {
  const { stopSignal, onLog, persist } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const maxReconnects = opts.maxReconnects ?? DEFAULT_MAX_RECONNECTS;

  const accumulator: string[] = [];
  let reconnects = 0;
  let duplicates = 0;

  // Resume state. `seenInSecond` holds only the payloads already accepted at
  // `resumeSecond`, which is the exact window `sinceTime` will replay — so it
  // is bounded by lines-per-second, not by run length. A 10 Mi transcript does
  // not grow it.
  let resumeSecond: string | undefined;
  let seenInSecond = new Set<string>();

  const accept = async (rawLine: string): Promise<void> => {
    const { timestamp, payload } = parseTimestampedLogLine(rawLine);
    if (!payload.startsWith(POD_LOG_STREAM_MARKER)) return; // someone else's fd — see property 1
    const text = payload.slice(POD_LOG_STREAM_MARKER.length);

    const second = truncateTimestampToSecond(timestamp);
    if (second !== undefined) {
      if (second !== resumeSecond) {
        resumeSecond = second;
        seenInSecond = new Set();
      }
      if (seenInSecond.has(text)) {
        duplicates++;
        return;
      }
      seenInSecond.add(text);
    }

    accumulator.push(text);
    if (persist) await persist(text);
    await onLog("stdout", `${text}\n`);
  };

  /** Feed raw chunks, emitting only on complete lines; returns the drain for the tail. */
  const makeLineReader = () => {
    let pending = "";
    const queue: string[] = [];
    return {
      push(chunk: string): void {
        const combined = pending + chunk;
        const lines = combined.split("\n");
        // A chunk boundary is not a line boundary: the last element is a
        // fragment until the next chunk completes it.
        pending = lines.pop() ?? "";
        queue.push(...lines);
      },
      take(): string[] {
        return queue.splice(0, queue.length);
      },
      /** The trailing fragment. Discarded on reconnect (the replay re-delivers
       *  it whole), flushed only at the very end. */
      pending(): string {
        return pending;
      },
    };
  };

  while (!stopSignal.stopped && reconnects <= maxReconnects) {
    const reader = makeLineReader();
    let opened = true;
    try {
      await opts.follow({
        sinceTime: resumeSecond,
        onData: (chunk) => reader.push(chunk),
      });
    } catch (err) {
      opened = false;
      const msg = err instanceof Error ? err.message : String(err);
      await onLog("stderr", `[paperclip] pod log stream could not be opened: ${msg}\n`);
    }
    for (const line of reader.take()) await accept(line);

    if (stopSignal.stopped) break;
    reconnects++;
    if (reconnects > maxReconnects) {
      await onLog(
        "stderr",
        `[paperclip] pod log stream exhausted ${maxReconnects} reconnects before the Job went terminal; `
          + "falling back to a single non-follow read. Output may be incomplete.\n",
      );
      break;
    }
    // Named explicitly rather than logged as a bare retry: a reconnect is the
    // ONLY window in which the kubelet's 10 Mi container-log rotation can lose
    // bytes. While the follow is connected the kubelet reader rolls over with
    // the file and nothing is dropped; it is the gap between connections, bounded
    // by what the node still retains, that can outrun `sinceTime`. Printing the
    // resume point makes such a gap attributable afterwards instead of silent.
    await onLog(
      "stderr",
      `[paperclip] pod log stream ${opened ? "ended" : "failed"} before the Job went terminal; `
        + `reconnecting (#${reconnects})${resumeSecond ? ` from ${resumeSecond}` : " from the start"}.\n`,
    );
    await sleep(RECONNECT_BACKOFF_MS[Math.min(reconnects - 1, RECONNECT_BACKOFF_MS.length - 1)]);
  }

  // Final non-follow pass. The analogue of `tailPodLogFile`'s belt-and-braces
  // on-disk re-read, and it exists for the same reason: the trailing `result`
  // line is written moments before the Job reports Complete, and the follow can
  // be torn down by `stopSignal` in between. A terminated pod's log stays
  // readable until the POD is deleted — which is why this beats `pods/exec`,
  // whose tail dies with the container exactly when that line matters.
  const finalReader = makeLineReader();
  try {
    finalReader.push(await opts.read({ sinceTime: resumeSecond }));
    for (const line of finalReader.take()) await accept(line);
    const trailing = finalReader.pending();
    if (trailing) await accept(trailing);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip] final pod log read failed: ${msg}\n`);
  }

  return { stdout: accumulator.join("\n"), lines: accumulator.length, reconnects, duplicates };
}

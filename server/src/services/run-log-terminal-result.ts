/**
 * Recovers an external-lifecycle run's own terminal verdict from the DURABLE
 * run log, so the Job reconciler can record *why* the pod exited rather than
 * only that it did (PEN-3129).
 *
 * ## Why not the pod artifact
 *
 * `readOrphanedRunTerminalResult` reads a sibling `<runId>.pod.ndjson` that the
 * claude_k8s Job tees directly, and the adapter unlinks it from its cleanup
 * `finally`. A surviving artifact therefore means the adapter owner never
 * completed cleanup — precisely the `job_missing` orphan case that reader was
 * written for, and precisely NOT the `job_failed` case here, where the Job
 * object is present and terminal.
 *
 * That is measured, not assumed. One agent directory on the shared data PVC
 * held 166 `.pod.ndjson` against 6310 durable `<runId>.ndjson` (2.6%), and the
 * `job_failed` run that motivated this change had no pod artifact at all. A
 * reconciler built on that source would have been inert for exactly the
 * population it was added to explain — the failure mode being fixed here, one
 * level down.
 *
 * The durable log is written through `runLogStore.append` as output arrives and
 * is never unlinked, so it is still readable hours later. Its records are
 * `{ts, stream, chunk, seq}` envelopes; the agent's stream-json rides inside
 * `chunk` on `stdout`, which is why the terminal event has to be reassembled
 * rather than simply parsed per line.
 *
 * Nothing here decides anything. It returns the agent's own structured event
 * and the instant it was emitted; the caller extracts the narrow fields it is
 * willing to persist. No transcript text is persisted by that caller — see the
 * provenance write in `heartbeat.ts`.
 */

export type RunLogTerminalResultEvent = {
  /** The agent's own terminal `{"type":"result", ...}` event, verbatim. */
  event: Record<string, unknown>;
  /**
   * When the line completed, from the enclosing envelope's `ts`. The reconciler
   * runs minutes after the pod died, so a relative "retry in Ns" horizon must be
   * resolved against emission time — resolving it against reconcile time would
   * push the window later than the provider ever advertised.
   */
  emittedAtMs: number | null;
};

function parseJsonObject(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Finds the agent's last terminal `result` event in a tail of the durable run
 * log.
 *
 * Two framings are in play and conflating them loses the event. The OUTER
 * framing is one JSON envelope per line. The INNER framing is the agent's own
 * newline-delimited stream-json, which is split across envelopes at whatever
 * boundaries the process happened to flush — so the terminal event routinely
 * spans several `chunk`s and parsing envelopes individually never finds it.
 *
 * `stdout` chunks are therefore concatenated in arrival order and re-split on
 * newlines, which also keeps interleaved `stderr` from corrupting the stream.
 * A tail read can slice the first envelope (and hence the first reassembled
 * line) mid-way; both simply fail to parse and are skipped.
 */
export function findTerminalResultEventInRunLogTail(
  tail: string,
): RunLogTerminalResultEvent | null {
  const lines: { line: string; tsMs: number | null }[] = [];
  let pending = "";
  let pendingTsMs: number | null = null;

  for (const envelopeLine of tail.split("\n")) {
    const envelope = parseJsonObject(envelopeLine);
    if (!envelope) continue;
    if (envelope.stream !== "stdout") continue;
    if (typeof envelope.chunk !== "string") continue;

    const tsMs = parseTimestampMs(envelope.ts);
    pending += envelope.chunk;
    pendingTsMs = tsMs;

    let newlineAt = pending.indexOf("\n");
    while (newlineAt !== -1) {
      // Attribute each completed line to the envelope that completed it, not to
      // the one that started it: that is the instant the agent finished emitting.
      lines.push({ line: pending.slice(0, newlineAt), tsMs });
      pending = pending.slice(newlineAt + 1);
      newlineAt = pending.indexOf("\n");
    }
  }
  // A final line with no trailing newline is still a complete event when the
  // process exited right after writing it — which is exactly the terminal case.
  if (pending.length > 0) lines.push({ line: pending, tsMs: pendingTsMs });

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = lines[index]!;
    const event = parseJsonObject(entry.line);
    if (!event || event.type !== "result") continue;
    return { event, emittedAtMs: entry.tsMs };
  }
  return null;
}

/** The single range read `readRunLogTerminalTail` needs from a log store. */
export type RunLogRangeReader = (range: {
  offset: number;
  limitBytes: number;
}) => Promise<{ content: string; nextOffset?: number; totalBytes?: number }>;

export type RunLogTailRead =
  /** `tail` is the true end of the log. */
  | { kind: "tail"; tail: string; scannedBytes: number }
  /**
   * A size-less store forced a forward walk and the scan cap was reached with
   * bytes still unread, so the window held is a PREFIX of the log, not its
   * tail. Distinguished from `tail` because the terminal event lives at the
   * END: a caller that treats a prefix as a tail reports "no verdict found"
   * from bytes that could not have contained one.
   */
  | { kind: "truncated"; scannedBytes: number };

export const RUN_LOG_TERMINAL_TAIL_BYTES = 256 * 1024;
export const RUN_LOG_TERMINAL_MAX_SCAN_BYTES = 8 * 1024 * 1024;

/**
 * Reads the trailing window of a durable run log, where the terminal event is.
 *
 * Seeks to the end when the store reports a size, which is why this exists as
 * its own function: the original inline version walked FORWARD from byte zero
 * and stopped at a scan cap, so for any log larger than the cap it retained the
 * last 256 KiB *of the cap* — a window that by construction cannot hold the
 * terminal event. It returned null and the caller kept its generic diagnosis,
 * silently, and worst for the longest runs. Durable logs do exceed 8 MiB in
 * production (12.9 MiB observed), so that was live, not theoretical.
 *
 * Memory stays bounded at one window regardless of log size. A store that
 * reports a size is read twice in the common case — the size probe, then either
 * the seek or a revalidation of the end — plus one read per append that landed
 * after the probe.
 */
export async function readRunLogTerminalTail(
  read: RunLogRangeReader,
  opts: { tailBytes?: number; maxScanBytes?: number } = {},
): Promise<RunLogTailRead> {
  const tailBytes = Math.max(1, opts.tailBytes ?? RUN_LOG_TERMINAL_TAIL_BYTES);
  const maxScanBytes = Math.max(tailBytes, opts.maxScanBytes ?? RUN_LOG_TERMINAL_MAX_SCAN_BYTES);

  const first = await read({ offset: 0, limitBytes: tailBytes });
  let scannedBytes = Buffer.byteLength(first.content, "utf8");

  if (typeof first.totalBytes === "number" && Number.isFinite(first.totalBytes)) {
    let tail: string;
    let cursor: number | null;

    if (first.totalBytes <= tailBytes) {
      // The whole log AS OF THE SIZE PROBE is in hand — but the probe is not a
      // seal. Both backends stat/HEAD for the size before serving the range and
      // clamp the range to that size, so a pod flushing its terminal event in
      // between lands past this window, and the store reports no `nextOffset`
      // because it did serve everything the probe knew about. Returning here
      // would therefore drop exactly the event this reader exists to find, and
      // silently: an unparseable window is indistinguishable from "the provider
      // said nothing". Re-probe from the end of what we read instead, so the
      // small-log case follows growth on the same loop the seeked case uses.
      tail = first.content;
      cursor = first.totalBytes;
    } else {
      const seeked = await read({
        offset: first.totalBytes - tailBytes,
        limitBytes: tailBytes,
      });
      scannedBytes += Buffer.byteLength(seeked.content, "utf8");
      tail = seeked.content;
      cursor = seeked.nextOffset ?? null;
    }

    // The pod can append between the two reads, so follow whatever landed after
    // the window, still retaining only the trailing window. Bounded in practice
    // because this runs after the pod is terminal. A store with nothing new to
    // serve answers with an empty chunk and terminates the loop on the first
    // pass, which is what keeps the no-growth case to one extra read.
    while (cursor != null && scannedBytes < maxScanBytes) {
      const chunk = await read({ offset: cursor, limitBytes: tailBytes });
      const chunkBytes = Buffer.byteLength(chunk.content, "utf8");
      scannedBytes += chunkBytes;
      tail = (tail + chunk.content).slice(-tailBytes);
      if (chunkBytes === 0 || chunk.nextOffset == null || chunk.nextOffset <= cursor) break;
      cursor = chunk.nextOffset;
    }
    return { kind: "tail", tail, scannedBytes };
  }

  // Size-less store: walk forward retaining the trailing window. Reaching the
  // cap with bytes outstanding is reported, never passed off as a tail.
  let tail = first.content;
  let offset = first.nextOffset ?? null;
  while (offset != null) {
    if (scannedBytes >= maxScanBytes) return { kind: "truncated", scannedBytes };
    const chunk = await read({
      offset,
      limitBytes: Math.min(tailBytes, maxScanBytes - scannedBytes),
    });
    const chunkBytes = Buffer.byteLength(chunk.content, "utf8");
    scannedBytes += chunkBytes;
    tail = (tail + chunk.content).slice(-tailBytes);
    // `nextOffset` is undefined once the store served the final byte; the
    // `<= offset` guard keeps a misbehaving store from looping forever.
    if (chunkBytes === 0 || chunk.nextOffset == null || chunk.nextOffset <= offset) break;
    offset = chunk.nextOffset;
  }
  return { kind: "tail", tail, scannedBytes };
}

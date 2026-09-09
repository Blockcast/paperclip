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

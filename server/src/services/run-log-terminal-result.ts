/**
 * PEN-3129: recovers the agent's own terminal `result` event out of a run's
 * durable run log, so the external-lifecycle reconciler can record WHY a pod
 * exited non-zero instead of only recording that Kubernetes noticed.
 *
 * Background. Agent Jobs carry `backoffLimit: 0`, so a pod that exits non-zero
 * for ANY reason puts the Job into `Failed` with `reason: BackoffLimitExceeded`
 * / "Job has reached the specified backoff limit". That string is emitted
 * identically for a provider 429 refusal, an OOM, a crash and a clean
 * `exit(1)`, and it is the only thing `externalLifecycleTerminalOutcome` has to
 * work from — its sole input is the Job status. Measured over 1000 runs
 * (2026-09-07/08), 257 were booked `job_failed`, and 19 of 20 sampled pod logs
 * ended on `{"type":"result","is_error":true,"api_error_status":429,...}`
 * followed by the supervisor's own "Retryable ccrotate throttle before model
 * progress" verdict. The true reason is present at the moment the useless label
 * is written; nothing was reading it.
 *
 * This module supplies the missing read. It is a pure parser over log text so
 * the reconciler's I/O stays in one place and the shape contract below is
 * unit-testable without a filesystem or a store.
 *
 * ⚠️ This is a DIMENSION, never a relabel. `heartbeat_runs.error_code` is a
 * consumer key with eleven readers (container-diagnostics capture, retry
 * admission and budget, stranded-issue routing, the alerting gauge's bounded
 * label set, the dashboard series, productivity review, the recovery streak,
 * the triage runbook), so changing the VALUE for a 429-terminated pod would
 * silently rebucket all of them. The caller records what this returns
 * alongside `errorCode`, leaving `errorCode` and every consumer bit-identical.
 * See the caller in `heartbeat.ts` for the retry-admission hazard in
 * particular.
 */

/**
 * Cap the tail read: the terminal `result` event is the last thing the agent
 * emits, so a bounded tail always reaches it, and the reconciler must not pull
 * a multi-megabyte transcript into memory per failed run.
 */
export const RUN_LOG_TERMINAL_RESULT_TAIL_BYTES = 64 * 1024;

/** Per-read window while walking forward to the end of a log of unknown size. */
export const RUN_LOG_TERMINAL_RESULT_SCAN_CHUNK_BYTES = 256 * 1024;

/**
 * Total bytes the reconciler will read per failed run before giving up. A run
 * log longer than this yields no verdict rather than an unbounded read; the run
 * then records exactly what it recorded before this existed.
 */
export const RUN_LOG_TERMINAL_RESULT_MAX_SCAN_BYTES = 4 * 1024 * 1024;

/**
 * Recovers the raw stdout/stderr text from a run-log tail.
 *
 * The durable run log is NOT the agent's stream-json: `run-log-store.append`
 * wraps every chunk in an envelope (`{ts, stream, chunk, seq}`), and a chunk
 * boundary can fall anywhere — including mid-JSON-event — because it is
 * whatever the adapter happened to read off the pod's stream. So the events
 * have to be reassembled by concatenating `chunk` payloads in file order
 * before any line can be parsed. Splitting the envelope lines and hoping each
 * one holds a whole event is the obvious wrong implementation and fails
 * exactly on the long `result` event this exists to read.
 *
 * A line that is not an envelope is passed through verbatim, so the same
 * parser also reads the pod-written `<runId>.pod.ndjson` artifact, which is raw
 * stream-json. A leading partial line (the tail read sliced it) simply fails to
 * parse and is dropped.
 */
function reassembleStreamText(tail: string): string {
  let text = "";
  for (const line of tail.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!trimmed.startsWith("{")) {
      text += `${line}\n`;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Either the sliced first line, or a raw event split across envelopes
      // that we cannot attribute — dropping it is correct either way.
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record.chunk === "string") {
      text += record.chunk;
      continue;
    }
    text += `${trimmed}\n`;
  }
  return text;
}

/**
 * Returns the LAST `{"type":"result"}` event in a run-log tail, or null when the
 * tail carries none.
 *
 * Fail-closed by construction: an absent, truncated or unparseable event yields
 * null, and the caller then records no verdict rather than guessing one. The
 * event is returned as a plain record so the caller can classify it with the
 * SAME exported helpers the in-process finalization path uses
 * (`isRateLimitExhausted`, `isHintlessTransientUpstreamFault`) instead of
 * growing a second, drifting copy of that classification here.
 *
 * Never throws.
 */
export function parseTerminalResultEventFromRunLogTail(
  tail: string,
): Record<string, unknown> | null {
  if (typeof tail !== "string" || tail.length === 0) return null;
  const lines = reassembleStreamText(tail).split("\n");
  // Scan backwards: the terminal result is the last event, and a run that
  // retried internally emits several `result` events — the last one is the
  // verdict the process actually exited on.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const record = event as Record<string, unknown>;
    if (record.type !== "result") continue;
    return record;
  }
  return null;
}

/**
 * The pod's terminal self-report, reduced to the fields worth persisting on the
 * run row.
 *
 * `providerFamily` is deliberately NOT called `errorFamily`, and this object is
 * deliberately nested under `externalLifecycleRecovery` rather than written at
 * the top level of `resultJson`. Both are load-bearing — see the caller.
 */
export interface RunPodTerminalVerdict {
  /** The provider HTTP status the agent's final event carried, verbatim. */
  apiErrorStatus: number | string | null;
  /** The SDK result subtype (`success`, `error_during_execution`, ...). */
  subtype: string | null;
  /** The agent's own `is_error` flag; null when it emitted none. */
  isError: boolean | null;
  /** The supervisor's terminal classification (e.g. `api_error`). */
  terminalReason: string | null;
  /**
   * Family assigned by the SAME classifier the in-process path uses, or null
   * when the terminal event matches none of them. Read this to attribute a
   * `job_failed` run; do not read it as authorization to retry one.
   */
  providerFamily: "rate_limit_exhausted" | "transient_upstream" | null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Projects a terminal `result` event onto {@link RunPodTerminalVerdict}.
 *
 * The classifiers are injected rather than imported so this module stays free
 * of `heartbeat.ts` (which imports half the server) and so a test can prove the
 * projection independently of what the classifiers decide.
 */
export function summarizePodTerminalVerdict(
  event: Record<string, unknown>,
  classifiers: {
    isRateLimitExhausted: (resultJson: Record<string, unknown>) => boolean;
    isHintlessTransientUpstreamFault: (resultJson: Record<string, unknown>) => boolean;
  },
): RunPodTerminalVerdict {
  const status = event.api_error_status;
  return {
    apiErrorStatus:
      typeof status === "number" || (typeof status === "string" && status.length > 0)
        ? status
        : null,
    subtype: readOptionalString(event.subtype),
    isError: typeof event.is_error === "boolean" ? event.is_error : null,
    terminalReason: readOptionalString(event.terminal_reason),
    // Rate limiting is checked first: a 429 satisfies only this classifier, but
    // the ordering is pinned anyway so a future widening of the transient set
    // cannot silently reclassify capacity refusals as gateway brownouts.
    providerFamily: classifiers.isRateLimitExhausted(event)
      ? "rate_limit_exhausted"
      : classifiers.isHintlessTransientUpstreamFault(event)
        ? "transient_upstream"
        : null,
  };
}

// PEN-3129 — the reconciler books a 429 capacity refusal as `job_failed` /
// `BackoffLimitExceeded` because `externalLifecycleTerminalOutcome` sees only
// the Kubernetes Job status. The provider's own verdict survives in the durable
// run log; this is the parser that recovers it.
//
// The cases below pin the two framings that make this non-trivial, and the two
// ways a naive reader scores a refusal as a success.
import { describe, expect, it } from "vitest";
import { findTerminalResultEventInRunLogTail } from "../services/run-log-terminal-result.js";

/** One durable-run-log envelope. The agent's stream-json rides inside `chunk`. */
function envelope(stream: "stdout" | "stderr" | "system", chunk: string, ts: string, seq: number) {
  return JSON.stringify({ ts, stream, chunk, seq });
}

// Shape observed verbatim on run 4d64a1b7-5640-4c6b-b979-33f771fbede5, which the
// reconciler booked as `job_failed` / `BackoffLimitExceeded`.
const REFUSAL_EVENT = {
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: 429,
  terminal_reason: "api_error",
  num_turns: 1,
  result:
    "API Error: Request rejected (429) · All Claude subscription capacity for this tenant is rate-limited; capacity may reset at 2026-09-08T22:00:00.545Z; retry in 250s",
  usage: { input_tokens: 0, output_tokens: 0 },
};

describe("findTerminalResultEventInRunLogTail", () => {
  it("recovers the terminal result from a single stdout envelope", () => {
    const tail = [
      envelope("system", "starting\n", "2026-09-08T21:55:00.000Z", 1),
      envelope("stdout", `${JSON.stringify(REFUSAL_EVENT)}\n`, "2026-09-08T21:55:56.000Z", 16),
      envelope("stderr", "[paperclip] Retryable ccrotate throttle\n", "2026-09-08T21:55:56.500Z", 17),
    ].join("\n");

    const found = findTerminalResultEventInRunLogTail(tail);

    expect(found?.event.api_error_status).toBe(429);
    expect(found?.event.terminal_reason).toBe("api_error");
    // The emission instant, not the reconcile instant: a relative "retry in Ns"
    // horizon resolved against reconcile time lands later than the provider
    // ever advertised.
    expect(found?.emittedAtMs).toBe(Date.parse("2026-09-08T21:55:56.000Z"));
  });

  it("reassembles a terminal result split across stdout envelopes", () => {
    // The agent's stream-json is split at whatever boundary the process flushed,
    // so the terminal event routinely spans envelopes. Parsing each envelope's
    // chunk on its own finds nothing — this is the case that makes a per-line
    // reader silently report "no verdict" on a run that plainly stated one.
    const serialized = `${JSON.stringify(REFUSAL_EVENT)}\n`;
    const cut = Math.floor(serialized.length / 2);
    const tail = [
      envelope("stdout", serialized.slice(0, cut), "2026-09-08T21:55:56.000Z", 15),
      // Interleaved stderr must not corrupt the reassembled stdout stream.
      envelope("stderr", "warning: noise\n", "2026-09-08T21:55:56.100Z", 16),
      envelope("stdout", serialized.slice(cut), "2026-09-08T21:55:56.200Z", 17),
    ].join("\n");

    const found = findTerminalResultEventInRunLogTail(tail);

    expect(found?.event.api_error_status).toBe(429);
    // Attributed to the envelope that COMPLETED the line.
    expect(found?.emittedAtMs).toBe(Date.parse("2026-09-08T21:55:56.200Z"));
  });

  it("recovers a terminal result the process never newline-terminated", () => {
    const tail = envelope("stdout", JSON.stringify(REFUSAL_EVENT), "2026-09-08T21:55:56.000Z", 16);
    expect(findTerminalResultEventInRunLogTail(tail)?.event.api_error_status).toBe(429);
  });

  it("survives a tail read that sliced the first envelope mid-way", () => {
    const whole = [
      envelope("stdout", "{\"type\":\"assistant\"}\n", "2026-09-08T21:50:00.000Z", 3),
      envelope("stdout", `${JSON.stringify(REFUSAL_EVENT)}\n`, "2026-09-08T21:55:56.000Z", 16),
    ].join("\n");

    const found = findTerminalResultEventInRunLogTail(whole.slice(17));

    expect(found?.event.api_error_status).toBe(429);
  });

  it("returns the LAST result event when a run emitted several", () => {
    const earlier = { ...REFUSAL_EVENT, api_error_status: 500, result: "earlier" };
    const tail = [
      envelope("stdout", `${JSON.stringify(earlier)}\n`, "2026-09-08T21:40:00.000Z", 8),
      envelope("stdout", `${JSON.stringify(REFUSAL_EVENT)}\n`, "2026-09-08T21:55:56.000Z", 16),
    ].join("\n");

    expect(findTerminalResultEventInRunLogTail(tail)?.event.api_error_status).toBe(429);
  });

  it("reports the event verbatim so `subtype` cannot be mistaken for the verdict", () => {
    // The trap this exists to make visible: a capacity refusal is emitted as
    // `subtype: "success"` WITH `is_error: true`. Anything keying on subtype
    // scores the refusal as a successful turn.
    const found = findTerminalResultEventInRunLogTail(
      envelope("stdout", `${JSON.stringify(REFUSAL_EVENT)}\n`, "2026-09-08T21:55:56.000Z", 16),
    );

    expect(found?.event.subtype).toBe("success");
    expect(found?.event.is_error).toBe(true);
  });

  it("ignores non-stdout streams", () => {
    // A supervisor line on stderr can quote a result-shaped payload; only the
    // agent's own stdout stream is its structured self-report.
    const tail = envelope(
      "stderr",
      `${JSON.stringify(REFUSAL_EVENT)}\n`,
      "2026-09-08T21:55:56.000Z",
      17,
    );
    expect(findTerminalResultEventInRunLogTail(tail)).toBeNull();
  });

  it("returns null for a log with no result event, empty input, or junk", () => {
    expect(
      findTerminalResultEventInRunLogTail(
        envelope("stdout", "{\"type\":\"assistant\"}\n", "2026-09-08T21:50:00.000Z", 3),
      ),
    ).toBeNull();
    expect(findTerminalResultEventInRunLogTail("")).toBeNull();
    expect(findTerminalResultEventInRunLogTail("not json\n{oops\n")).toBeNull();
  });

  it("tolerates an envelope with an unparseable or absent ts", () => {
    const tail = envelope("stdout", `${JSON.stringify(REFUSAL_EVENT)}\n`, "not-a-date", 16);
    const found = findTerminalResultEventInRunLogTail(tail);

    expect(found?.event.api_error_status).toBe(429);
    // Unknown emission time is reported as unknown, never as "now" — the caller
    // decides what to fall back to.
    expect(found?.emittedAtMs).toBeNull();
  });
});

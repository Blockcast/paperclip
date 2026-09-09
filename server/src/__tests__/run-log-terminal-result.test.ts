// PEN-3129. A pod refused with HTTP 429 by our own capacity router exits
// non-zero, and because agent Jobs run `backoffLimit: 0` Kubernetes describes
// that with `BackoffLimitExceeded: Job has reached the specified backoff limit`
// — the same condition it emits for an OOM, a crash and a clean `exit(1)`. The
// external-lifecycle reconciler had nothing else to read, so it booked every one
// of them as `job_failed`, discarding a provider verdict the pod had printed one
// line earlier. 257 of 1000 runs sampled 2026-09-07/08 landed in that bucket,
// 59 of them simultaneously carrying `scheduledRetryReason: "ccrotate_capacity"`
// — the row contradicting itself.
//
// These pin the reader that recovers the discarded verdict. The load-bearing
// case is `reassembles a result event split across chunk envelopes`: the durable
// run log is NOT stream-json, it is stream-json wrapped one envelope per adapter
// read, and a chunk boundary falls wherever the pod's stream happened to be
// flushed. Parsing envelope lines as events — the obvious implementation — works
// on every short event and fails on exactly the long `result` event this exists
// to read.
import { describe, expect, it } from "vitest";
import {
  parseTerminalResultEventFromRunLogTail,
  summarizePodTerminalVerdict,
} from "../services/run-log-terminal-result.js";
import { isHintlessTransientUpstreamFault, isRateLimitExhausted } from "../services/heartbeat.js";

/** One `run-log-store.append` line. */
function envelope(chunk: string, seq: number) {
  return JSON.stringify({ ts: "2026-09-08T21:55:56.000Z", stream: "stdout", chunk, seq });
}

/** The verdict shape observed on run df9f347b, verbatim in structure. */
const REFUSAL_EVENT = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  api_error_status: 429,
  num_turns: 1,
  result:
    "API Error: Request rejected (429) · All Claude subscription capacity for this tenant is " +
    "rate-limited; capacity may reset at 2026-09-08T22:00:00.545Z; retry in 250s",
  usage: { input_tokens: 0, output_tokens: 0 },
  terminal_reason: "api_error",
} as const;

const CLASSIFIERS = {
  isRateLimitExhausted: (resultJson: Record<string, unknown>) => isRateLimitExhausted(resultJson),
  isHintlessTransientUpstreamFault: (resultJson: Record<string, unknown>) =>
    isHintlessTransientUpstreamFault(resultJson),
};

describe("parseTerminalResultEventFromRunLogTail", () => {
  it("reads the terminal result event out of envelope-wrapped run-log lines", () => {
    const tail = [
      envelope("[paperclip] Skills bundled (0): none\n", 3),
      envelope(`${JSON.stringify(REFUSAL_EVENT)}\n`, 26),
      envelope(
        "[paperclip] Retryable ccrotate throttle before model progress; retrying in 90s (1/6).\n",
        28,
      ),
    ].join("\n");

    expect(parseTerminalResultEventFromRunLogTail(tail)).toMatchObject({
      type: "result",
      api_error_status: 429,
      terminal_reason: "api_error",
    });
  });

  it("reassembles a result event split across chunk envelopes", () => {
    // The failure mode that makes a per-line parser wrong. `append` wraps
    // whatever the adapter read; nothing aligns a chunk boundary to an event
    // boundary, and the `result` event is the longest thing an agent emits, so
    // it is the one most likely to be split.
    const serialized = `${JSON.stringify(REFUSAL_EVENT)}\n`;
    const cut = Math.floor(serialized.length / 2);
    const tail = [
      envelope(serialized.slice(0, cut), 26),
      envelope(serialized.slice(cut), 27),
    ].join("\n");

    expect(parseTerminalResultEventFromRunLogTail(tail)).toMatchObject({
      api_error_status: 429,
      terminal_reason: "api_error",
    });
  });

  it("returns the LAST result event when the supervisor retried in-process", () => {
    // The supervisor retries a throttle up to 6 times, emitting a result event
    // per attempt. The verdict the process exited on is the last one.
    const tail = [
      envelope(`${JSON.stringify({ ...REFUSAL_EVENT, api_error_status: 503 })}\n`, 10),
      envelope(`${JSON.stringify(REFUSAL_EVENT)}\n`, 26),
    ].join("\n");

    expect(parseTerminalResultEventFromRunLogTail(tail)).toMatchObject({ api_error_status: 429 });
  });

  it("also reads raw stream-json, so the same parser serves the pod artifact", () => {
    const tail = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify(REFUSAL_EVENT),
    ].join("\n");

    expect(parseTerminalResultEventFromRunLogTail(tail)).toMatchObject({ api_error_status: 429 });
  });

  it("drops the leading partial line a tail read sliced", () => {
    const tail = `{"ts":"2026-09-08T21:5\n${envelope(`${JSON.stringify(REFUSAL_EVENT)}\n`, 26)}`;
    expect(parseTerminalResultEventFromRunLogTail(tail)).toMatchObject({ api_error_status: 429 });
  });

  it("fails closed on a tail carrying no result event", () => {
    const tail = [
      envelope("[paperclip] Created env Secret: ac-x-env\n", 5),
      envelope(`${JSON.stringify({ type: "assistant", message: {} })}\n`, 6),
    ].join("\n");

    expect(parseTerminalResultEventFromRunLogTail(tail)).toBeNull();
  });

  it("fails closed on an empty, whitespace, or non-JSON tail", () => {
    expect(parseTerminalResultEventFromRunLogTail("")).toBeNull();
    expect(parseTerminalResultEventFromRunLogTail("\n\n  \n")).toBeNull();
    expect(parseTerminalResultEventFromRunLogTail("Killed\n")).toBeNull();
  });

  it("fails closed on a truncated result event rather than guessing", () => {
    const serialized = JSON.stringify(REFUSAL_EVENT);
    const tail = envelope(serialized.slice(0, serialized.length - 20), 26);
    expect(parseTerminalResultEventFromRunLogTail(tail)).toBeNull();
  });

  it("ignores a JSON array line", () => {
    expect(parseTerminalResultEventFromRunLogTail(`[{"type":"result"}]\n`)).toBeNull();
  });
});

describe("summarizePodTerminalVerdict", () => {
  it("projects a 429 refusal onto the rate-limit family", () => {
    expect(summarizePodTerminalVerdict(REFUSAL_EVENT, CLASSIFIERS)).toEqual({
      apiErrorStatus: 429,
      subtype: "error_during_execution",
      isError: true,
      terminalReason: "api_error",
      providerFamily: "rate_limit_exhausted",
    });
  });

  it("accepts the string form of api_error_status the SDK also emits", () => {
    expect(
      summarizePodTerminalVerdict({ type: "result", api_error_status: "429" }, CLASSIFIERS),
    ).toMatchObject({ apiErrorStatus: "429", providerFamily: "rate_limit_exhausted" });
  });

  it("classifies a hintless gateway fault as transient_upstream, not rate-limited", () => {
    expect(
      summarizePodTerminalVerdict(
        { type: "result", is_error: true, api_error_status: 529, terminal_reason: "api_error" },
        CLASSIFIERS,
      ),
    ).toMatchObject({ apiErrorStatus: 529, providerFamily: "transient_upstream" });
  });

  it("assigns no family to an ordinary agent-side failure", () => {
    // An agent that exited 1 on its own logic is NOT a provider fault, and
    // labelling it one would re-create the mislabel this fixes, pointed the
    // other way.
    expect(
      summarizePodTerminalVerdict(
        { type: "result", subtype: "error_during_execution", is_error: true },
        CLASSIFIERS,
      ),
    ).toEqual({
      apiErrorStatus: null,
      subtype: "error_during_execution",
      isError: true,
      terminalReason: null,
      providerFamily: null,
    });
  });

  it("records absent fields as null rather than inventing them", () => {
    expect(summarizePodTerminalVerdict({ type: "result" }, CLASSIFIERS)).toEqual({
      apiErrorStatus: null,
      subtype: null,
      isError: null,
      terminalReason: null,
      providerFamily: null,
    });
  });
});

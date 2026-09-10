// PEN-3129 — the reconciler books a 429 capacity refusal as `job_failed` /
// `BackoffLimitExceeded` because `externalLifecycleTerminalOutcome` sees only
// the Kubernetes Job status. The provider's own verdict survives in the durable
// run log; this is the parser that recovers it.
//
// The cases below pin the two framings that make this non-trivial, and the two
// ways a naive reader scores a refusal as a success.
import { describe, expect, it } from "vitest";
import {
  findTerminalResultEventInRunLogTail,
  readRunLogTerminalTail,
  type RunLogRangeReader,
} from "../services/run-log-terminal-result.js";

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

/**
 * A byte-range store standing in for `runLogStore`, with the same clamping and
 * `nextOffset` contract as the local-file and S3 backends.
 *
 * `reportsSize` models the one axis that decides the read strategy: a store
 * that can say how big the log is lets the reader seek to the end, and one that
 * cannot forces a forward walk.
 */
function fakeRangeStore(body: string, opts: { reportsSize?: boolean } = {}) {
  const reportsSize = opts.reportsSize ?? true;
  const buf = Buffer.from(body, "utf8");
  const reads: { offset: number; limitBytes: number }[] = [];
  const read: RunLogRangeReader = async ({ offset, limitBytes }) => {
    reads.push({ offset, limitBytes });
    const start = Math.max(0, Math.min(offset, buf.length));
    const end = Math.min(start + limitBytes, buf.length);
    const nextOffset = end < buf.length ? end : undefined;
    return {
      content: buf.subarray(start, end).toString("utf8"),
      ...(nextOffset === undefined ? {} : { nextOffset }),
      ...(reportsSize ? { totalBytes: buf.length } : {}),
    };
  };
  return { read, reads };
}

describe("readRunLogTerminalTail", () => {
  const TAIL = 1024;

  /** Filler large enough to push the terminal event past any scan cap. */
  function padTo(bytes: number) {
    const line = `${envelope("stdout", "noise\n", "2026-09-08T21:00:00.000Z", 1)}\n`;
    return line.repeat(Math.ceil(bytes / line.length));
  }

  it("returns the whole log when it is smaller than the tail window", async () => {
    const body = `${envelope("stdout", `${JSON.stringify(REFUSAL_EVENT)}\n`, "2026-09-08T21:55:56.000Z", 4)}\n`;
    const store = fakeRangeStore(body);
    const result = await readRunLogTerminalTail(store.read, { tailBytes: TAIL });

    expect(result.kind).toBe("tail");
    expect(findTerminalResultEventInRunLogTail((result as { tail: string }).tail)?.event).toMatchObject({
      api_error_status: 429,
    });
    // Two reads: the first served the entire log, the second confirms nothing
    // was appended after the size probe. The second answers empty and stops the
    // walk, so a small log costs one extra range read and never loops.
    expect(store.reads).toHaveLength(2);
    expect(store.reads[1]!.offset).toBe(Buffer.byteLength(body, "utf8"));
  });

  // Sibling of the seek-path growth test below, and the one that is easy to
  // miss: here the log is SMALLER than the tail window, so there is no seek to
  // race and the store reports no `nextOffset` — it served everything the size
  // probe knew about. Both backends stat/HEAD before serving and clamp to that
  // size, so an event flushed in between is invisible unless the end is
  // re-probed. Returning `first.content` on this path dropped exactly the
  // terminal event this reader exists to recover.
  it("still reaches the end when a log smaller than the window grows after the size probe", async () => {
    const head = `${envelope("stdout", "starting\n", "2026-09-08T21:55:50.000Z", 1)}\n`;
    const appended = `${envelope("stdout", `${JSON.stringify(REFUSAL_EVENT)}\n`, "2026-09-08T21:55:56.000Z", 2)}\n`;
    const buf = Buffer.from(`${head}${appended}`, "utf8");
    const staleSize = Buffer.byteLength(head, "utf8");
    expect(buf.length).toBeLessThan(TAIL); // the whole log fits the window

    // Reports the pre-append size on the first read and clamps that read to it,
    // exactly as `readLocalRange` does with a stat that precedes the stream.
    let call = 0;
    const read: RunLogRangeReader = async ({ offset, limitBytes }) => {
      call += 1;
      const size = call === 1 ? staleSize : buf.length;
      const start = Math.max(0, Math.min(offset, size));
      const end = Math.min(start + limitBytes, size);
      const nextOffset = end < size ? end : undefined;
      return {
        content: buf.subarray(start, end).toString("utf8"),
        ...(nextOffset === undefined ? {} : { nextOffset }),
        totalBytes: size,
      };
    };

    const result = await readRunLogTerminalTail(read, { tailBytes: TAIL });
    expect(result.kind).toBe("tail");
    expect(findTerminalResultEventInRunLogTail((result as { tail: string }).tail)?.event).toMatchObject({
      type: "result",
      is_error: true,
      api_error_status: 429,
    });
  });

  // The regression this function was extracted for. The previous inline reader
  // walked forward from byte zero and stopped at its scan cap, so for a log
  // bigger than the cap it held the last window OF THE CAP and the terminal
  // event — which is always at the very end — was never in the bytes examined.
  // Production durable logs do exceed 8 MiB (12.9 MiB observed), and the miss
  // was silent: the run simply kept its generic `job_failed`.
  it("finds the terminal event in a log far larger than the scan cap", async () => {
    const maxScanBytes = 4 * TAIL;
    const body = `${padTo(maxScanBytes * 6)}${envelope(
      "stdout",
      `${JSON.stringify(REFUSAL_EVENT)}\n`,
      "2026-09-08T21:55:56.000Z",
      99,
    )}\n`;
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(maxScanBytes);

    const store = fakeRangeStore(body);
    const result = await readRunLogTerminalTail(store.read, { tailBytes: TAIL, maxScanBytes });

    expect(result.kind).toBe("tail");
    const found = findTerminalResultEventInRunLogTail((result as { tail: string }).tail);
    expect(found?.event).toMatchObject({ type: "result", is_error: true, api_error_status: 429 });
    // Seeked rather than walked: two reads regardless of how large the log is,
    // and the scan cap is never approached.
    expect(store.reads).toHaveLength(2);
    expect(store.reads[1]!.offset).toBe(Buffer.byteLength(body, "utf8") - TAIL);
    expect(result.scannedBytes).toBeLessThanOrEqual(2 * TAIL);
  });

  it("keeps memory bounded to one window on a large log", async () => {
    const body = `${padTo(40 * TAIL)}${envelope("stdout", `${JSON.stringify(REFUSAL_EVENT)}\n`, "2026-09-08T21:55:56.000Z", 7)}\n`;
    const result = await readRunLogTerminalTail(fakeRangeStore(body).read, { tailBytes: TAIL });

    expect(result.kind).toBe("tail");
    expect(Buffer.byteLength((result as { tail: string }).tail, "utf8")).toBeLessThanOrEqual(TAIL);
  });

  it("still reaches the end when the log grows between the size probe and the seek", async () => {
    const head = padTo(8 * TAIL);
    const appended = `${envelope("stdout", `${JSON.stringify(REFUSAL_EVENT)}\n`, "2026-09-08T21:55:56.000Z", 12)}\n`;
    const buf = Buffer.from(`${head}${appended}`, "utf8");
    // Reports the pre-append size on the first read, then serves the grown
    // file — the pod can still be flushing when the reconciler reads.
    const staleSize = Buffer.byteLength(head, "utf8");
    let call = 0;
    const read: RunLogRangeReader = async ({ offset, limitBytes }) => {
      call += 1;
      const start = Math.max(0, Math.min(offset, buf.length));
      const end = Math.min(start + limitBytes, buf.length);
      const nextOffset = end < buf.length ? end : undefined;
      return {
        content: buf.subarray(start, end).toString("utf8"),
        ...(nextOffset === undefined ? {} : { nextOffset }),
        totalBytes: call === 1 ? staleSize : buf.length,
      };
    };

    const result = await readRunLogTerminalTail(read, { tailBytes: TAIL });
    expect(result.kind).toBe("tail");
    expect(findTerminalResultEventInRunLogTail((result as { tail: string }).tail)?.event).toMatchObject({
      api_error_status: 429,
    });
  });

  it("reports `truncated` rather than passing a prefix off as the tail", async () => {
    const maxScanBytes = 4 * TAIL;
    const body = `${padTo(maxScanBytes * 4)}${envelope("stdout", `${JSON.stringify(REFUSAL_EVENT)}\n`, "2026-09-08T21:55:56.000Z", 21)}\n`;
    // A store that cannot report a size leaves no option but a forward walk.
    const store = fakeRangeStore(body, { reportsSize: false });
    const result = await readRunLogTerminalTail(store.read, { tailBytes: TAIL, maxScanBytes });

    // The distinction that matters: NOT `{kind:"tail"}` with an unparseable
    // window, which the caller would report as "the provider said nothing".
    expect(result.kind).toBe("truncated");
    expect(result.scannedBytes).toBeGreaterThanOrEqual(maxScanBytes);
  });

  it("walks to EOF on a size-less store when the log fits inside the cap", async () => {
    const body = `${padTo(3 * TAIL)}${envelope("stdout", `${JSON.stringify(REFUSAL_EVENT)}\n`, "2026-09-08T21:55:56.000Z", 31)}\n`;
    const result = await readRunLogTerminalTail(fakeRangeStore(body, { reportsSize: false }).read, {
      tailBytes: TAIL,
      maxScanBytes: 64 * TAIL,
    });

    expect(result.kind).toBe("tail");
    expect(findTerminalResultEventInRunLogTail((result as { tail: string }).tail)?.event).toMatchObject({
      api_error_status: 429,
    });
  });

  it("handles an empty log without looping", async () => {
    const result = await readRunLogTerminalTail(fakeRangeStore("").read, { tailBytes: TAIL });
    expect(result).toEqual({ kind: "tail", tail: "", scannedBytes: 0 });
  });
});

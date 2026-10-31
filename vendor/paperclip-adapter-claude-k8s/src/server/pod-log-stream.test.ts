import { describe, it, expect, vi } from "vitest";
import { POD_LOG_STREAM_MARKER } from "./job-manifest.js";
import {
  collectPodLogStream,
  parseTimestampedLogLine,
  truncateTimestampToSecond,
  type PodLogStreamOptions,
} from "./pod-log-stream.js";

const M = POD_LOG_STREAM_MARKER;

/** One kubelet-stamped line, as `timestamps: true` delivers it. */
const stamped = (ts: string, payload: string): string => `${ts} ${payload}`;
/** A marked transcript line at `ts`. */
const transcript = (ts: string, json: string): string => stamped(ts, `${M}${json}`);

interface Harness {
  opts: PodLogStreamOptions;
  emitted: Array<[string, string]>;
  persisted: string[];
  followCalls: Array<string | undefined>;
  readCalls: Array<string | undefined>;
}

function harness(input: {
  /** One entry per follow connection; each is the raw body that connection delivers. */
  follows: Array<string | (() => string)>;
  /** Body the final non-follow read returns. */
  read?: string | (() => string);
  /** Called after each follow body is delivered — where a test flips the stop signal. */
  afterFollow?: (index: number, stopSignal: { stopped: boolean }) => void;
  maxReconnects?: number;
}): Harness {
  const emitted: Array<[string, string]> = [];
  const persisted: string[] = [];
  const followCalls: Array<string | undefined> = [];
  const readCalls: Array<string | undefined> = [];
  const stopSignal = { stopped: false };
  let followIndex = 0;

  const opts: PodLogStreamOptions = {
    stopSignal,
    maxReconnects: input.maxReconnects,
    sleep: async () => {},
    onLog: async (stream, chunk) => {
      emitted.push([stream, chunk]);
    },
    persist: async (line) => {
      persisted.push(line);
    },
    follow: async ({ sinceTime, onData }) => {
      followCalls.push(sinceTime);
      const index = followIndex++;
      const body = input.follows[index];
      if (body === undefined) {
        // No connection left scripted: behave like a server that accepts the
        // request and immediately closes it, which is what keeps a test honest
        // about reconnect bounds instead of hanging.
        input.afterFollow?.(index, stopSignal);
        return;
      }
      const text = typeof body === "function" ? body() : body;
      if (text) onData(text);
      input.afterFollow?.(index, stopSignal);
    },
    read: async ({ sinceTime }) => {
      readCalls.push(sinceTime);
      const body = input.read ?? "";
      return typeof body === "function" ? body() : body;
    },
  };
  return { opts, emitted, persisted, followCalls, readCalls };
}

describe("parseTimestampedLogLine", () => {
  it("splits the kubelet's RFC3339Nano prefix from the payload", () => {
    const parsed = parseTimestampedLogLine("2026-10-31T07:00:00.123456789Z hello world");
    expect(parsed).toEqual({ timestamp: "2026-10-31T07:00:00.123456789Z", payload: "hello world" });
  });

  it("keeps a whole unstamped line as the payload rather than discarding it", () => {
    // `timestamps: true` is requested, but a line that arrives without one is
    // still real output; it just cannot anchor a resume point.
    expect(parseTimestampedLogLine("no stamp here")).toEqual({ timestamp: "", payload: "no stamp here" });
  });

  it("does not mistake a payload that merely starts with digits for a stamp", () => {
    expect(parseTimestampedLogLine("2026 lines processed")).toEqual({ timestamp: "", payload: "2026 lines processed" });
    expect(parseTimestampedLogLine("2026-10-31 07:00:00 something")).toEqual({
      timestamp: "",
      payload: "2026-10-31 07:00:00 something",
    });
  });

  it("handles a payload that is itself empty", () => {
    expect(parseTimestampedLogLine("2026-10-31T07:00:00Z ")).toEqual({
      timestamp: "2026-10-31T07:00:00Z",
      payload: "",
    });
  });
});

describe("truncateTimestampToSecond", () => {
  it("rounds a nanosecond stamp DOWN to the second", () => {
    // Downwards, deliberately: `sinceTime` is a second-granular metav1.Time, so
    // the replay must be a superset of what we hold, never a gap.
    expect(truncateTimestampToSecond("2026-10-31T07:00:00.999999999Z")).toBe("2026-10-31T07:00:00Z");
  });

  it("returns undefined for an absent or unparseable stamp", () => {
    expect(truncateTimestampToSecond("")).toBeUndefined();
    expect(truncateTimestampToSecond("not-a-time")).toBeUndefined();
  });
});

describe("collectPodLogStream", () => {
  it("returns only the marked transcript, with the marker stripped", async () => {
    const h = harness({
      follows: [
        [
          transcript("2026-10-31T07:00:00.100Z", '{"type":"system"}'),
          transcript("2026-10-31T07:00:00.200Z", '{"type":"assistant"}'),
          "",
        ].join("\n"),
      ],
      afterFollow: (_i, stop) => {
        stop.stopped = true;
      },
    });
    const result = await collectPodLogStream(h.opts);
    expect(result.stdout).toBe('{"type":"system"}\n{"type":"assistant"}');
    expect(result.lines).toBe(2);
  });

  it("drops every line that does not carry the marker", async () => {
    // Property 1: readNamespacedPodLog has no usable stream selector here, so fd 1
    // and fd 2 arrive interleaved. The agent's own stderr, the launcher preflight
    // and the wrapper's diagnostics are all in this view and are NOT the run's
    // stdout. A collector that took the whole view would feed the parser garbage.
    const h = harness({
      follows: [
        [
          stamped("2026-10-31T07:00:00.000Z", "[paperclip] bootstrapping claude runtime"),
          stamped("2026-10-31T07:00:00.050Z", "npm warn deprecated something@1.0.0"),
          transcript("2026-10-31T07:00:00.100Z", '{"type":"result","subtype":"success"}'),
          stamped("2026-10-31T07:00:00.150Z", "[wrapper] terminal rate-limit: ..."),
          "",
        ].join("\n"),
      ],
      afterFollow: (_i, stop) => {
        stop.stopped = true;
      },
    });
    const result = await collectPodLogStream(h.opts);
    expect(result.stdout).toBe('{"type":"result","subtype":"success"}');
    expect(h.persisted).toEqual(['{"type":"result","subtype":"success"}']);
  });

  it("returns an empty transcript when nothing in the view is marked", async () => {
    const h = harness({
      follows: [stamped("2026-10-31T07:00:00Z", "only diagnostics here") + "\n"],
      afterFollow: (_i, stop) => {
        stop.stopped = true;
      },
    });
    const result = await collectPodLogStream(h.opts);
    expect(result.stdout).toBe("");
    expect(result.lines).toBe(0);
  });

  it("emits each accepted line live through onLog, newline-terminated", async () => {
    const h = harness({
      follows: [transcript("2026-10-31T07:00:00.100Z", '{"a":1}') + "\n"],
      afterFollow: (_i, stop) => {
        stop.stopped = true;
      },
    });
    await collectPodLogStream(h.opts);
    expect(h.emitted.filter(([s]) => s === "stdout")).toContainEqual(["stdout", '{"a":1}\n']);
  });

  it("persists every accepted line so the on-disk readers keep working", async () => {
    // Property 4: `podLogPath` is on the SERVER'S own claim, so it is writable
    // whichever claim the Job mounted. Keeping it populated is what leaves
    // reapPodLogFile and orphaned-run-terminal-result.ts unchanged.
    const h = harness({
      follows: [
        [transcript("2026-10-31T07:00:00.1Z", '{"a":1}'), transcript("2026-10-31T07:00:00.2Z", '{"a":2}'), ""].join("\n"),
      ],
      afterFollow: (_i, stop) => {
        stop.stopped = true;
      },
    });
    await collectPodLogStream(h.opts);
    expect(h.persisted).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("joins a line split across two chunks instead of emitting half of it", async () => {
    const stopSignal = { stopped: false };
    const emitted: string[] = [];
    const result = await collectPodLogStream({
      stopSignal,
      sleep: async () => {},
      onLog: async (_s, chunk) => {
        emitted.push(chunk);
      },
      follow: async ({ onData }) => {
        onData(`2026-10-31T07:00:00.1Z ${M}{"ty`);
        onData('pe":"result"}\n');
        stopSignal.stopped = true;
      },
      read: async () => "",
    });
    expect(result.stdout).toBe('{"type":"result"}');
    expect(emitted).toEqual(['{"type":"result"}\n']);
  });

  it("reconnects when the follow ends before the Job is terminal, resuming at the last line's SECOND", async () => {
    // Property 2: @kubernetes/client-node's own Log.log carries the comment
    // "the follow search param still has the stream close prematurely". A
    // stream end is therefore not evidence the run ended, and the Job's
    // terminal condition is the only authority.
    const h = harness({
      follows: [
        transcript("2026-10-31T07:00:05.750Z", '{"i":1}') + "\n",
        transcript("2026-10-31T07:00:09.000Z", '{"i":2}') + "\n",
      ],
      afterFollow: (index, stop) => {
        if (index === 1) stop.stopped = true;
      },
    });
    const result = await collectPodLogStream(h.opts);
    expect(result.reconnects).toBe(1);
    expect(h.followCalls).toEqual([undefined, "2026-10-31T07:00:05Z"]);
    expect(result.stdout).toBe('{"i":1}\n{"i":2}');
  });

  it("de-duplicates the lines the resume replay necessarily re-delivers", async () => {
    // Property 3. `sinceTime` is second-granular and inclusive, so asking to
    // resume at 07:00:05Z replays everything from that second — including the
    // line we already hold. Without dedup the transcript would carry it twice
    // and the parser would see a duplicate `result`.
    const first = [
      transcript("2026-10-31T07:00:05.100Z", '{"i":1}'),
      transcript("2026-10-31T07:00:05.900Z", '{"i":2}'),
      "",
    ].join("\n");
    const replayed = [
      transcript("2026-10-31T07:00:05.100Z", '{"i":1}'),
      transcript("2026-10-31T07:00:05.900Z", '{"i":2}'),
      transcript("2026-10-31T07:00:06.000Z", '{"i":3}'),
      "",
    ].join("\n");
    const h = harness({
      follows: [first, replayed],
      afterFollow: (index, stop) => {
        if (index === 1) stop.stopped = true;
      },
    });
    const result = await collectPodLogStream(h.opts);
    expect(result.stdout).toBe('{"i":1}\n{"i":2}\n{"i":3}');
    expect(result.duplicates).toBe(2);
  });

  it("keeps the dedup window to the resume second, so a long run does not accumulate state", async () => {
    // The dedup set is bounded by lines-per-second, not by run length: a line
    // identical to one from an earlier second is NOT a replay and must be kept.
    const h = harness({
      follows: [
        [
          transcript("2026-10-31T07:00:05.100Z", '{"tick":true}'),
          transcript("2026-10-31T07:00:06.100Z", '{"tick":true}'),
          transcript("2026-10-31T07:00:07.100Z", '{"tick":true}'),
          "",
        ].join("\n"),
      ],
      afterFollow: (_i, stop) => {
        stop.stopped = true;
      },
    });
    const result = await collectPodLogStream(h.opts);
    expect(result.lines).toBe(3);
    expect(result.duplicates).toBe(0);
  });

  it("runs a final non-follow pass that picks up the trailing result line", async () => {
    // The analogue of tailPodLogFile's belt-and-braces on-disk re-read: the
    // trailing `result` is written moments before the Job reports Complete, and
    // the follow can be torn down by the stop signal in between.
    const h = harness({
      follows: [transcript("2026-10-31T07:00:05.100Z", '{"type":"assistant"}') + "\n"],
      read: [
        transcript("2026-10-31T07:00:05.100Z", '{"type":"assistant"}'),
        transcript("2026-10-31T07:00:05.900Z", '{"type":"result","subtype":"success"}'),
        "",
      ].join("\n"),
      afterFollow: (_i, stop) => {
        stop.stopped = true;
      },
    });
    const result = await collectPodLogStream(h.opts);
    expect(result.stdout).toBe('{"type":"assistant"}\n{"type":"result","subtype":"success"}');
    expect(h.readCalls).toEqual(["2026-10-31T07:00:05Z"]);
  });

  it("accepts a final fragment that never got its newline", async () => {
    const h = harness({
      follows: [""],
      read: transcript("2026-10-31T07:00:05.900Z", '{"type":"result"}'),
      afterFollow: (_i, stop) => {
        stop.stopped = true;
      },
    });
    const result = await collectPodLogStream(h.opts);
    expect(result.stdout).toBe('{"type":"result"}');
  });

  it("survives a follow that cannot be opened and retries rather than failing the run", async () => {
    const stopSignal = { stopped: false };
    const stderr: string[] = [];
    let attempt = 0;
    const result = await collectPodLogStream({
      stopSignal,
      sleep: async () => {},
      onLog: async (stream, chunk) => {
        if (stream === "stderr") stderr.push(chunk);
      },
      follow: async ({ onData }) => {
        attempt++;
        if (attempt === 1) throw new Error("socket hang up");
        onData(`2026-10-31T07:00:05.1Z ${M}{"ok":true}\n`);
        stopSignal.stopped = true;
      },
      read: async () => "",
    });
    expect(result.stdout).toBe('{"ok":true}');
    expect(stderr.join("")).toContain("socket hang up");
  });

  it("stops reconnecting at maxReconnects but still runs the final read", async () => {
    const h = harness({
      follows: [],
      read: transcript("2026-10-31T07:00:05.900Z", '{"type":"result"}'),
      maxReconnects: 2,
    });
    const result = await collectPodLogStream(h.opts);
    expect(result.reconnects).toBe(3);
    expect(h.readCalls).toHaveLength(1);
    expect(result.stdout).toBe('{"type":"result"}');
    expect(h.emitted.map(([, c]) => c).join("")).toContain("exhausted 2 reconnects");
  });

  it("does not fail the run when the final read throws", async () => {
    const stopSignal = { stopped: false };
    const stderr: string[] = [];
    const result = await collectPodLogStream({
      stopSignal,
      sleep: async () => {},
      onLog: async (stream, chunk) => {
        if (stream === "stderr") stderr.push(chunk);
      },
      follow: async ({ onData }) => {
        onData(`2026-10-31T07:00:05.1Z ${M}{"ok":true}\n`);
        stopSignal.stopped = true;
      },
      read: async () => {
        throw new Error("pod deleted");
      },
    });
    expect(result.stdout).toBe('{"ok":true}');
    expect(stderr.join("")).toContain("pod deleted");
  });

  it("names the resume point on every reconnect so a rotation gap is attributable", async () => {
    // The kubelet rotates a container log at 10 Mi. While the follow is
    // CONNECTED that is transparent — the reader rolls over with the file. The
    // only window in which bytes can be lost is between connections, so each
    // reconnect prints where it resumed from.
    const h = harness({
      follows: [transcript("2026-10-31T07:00:05.100Z", '{"i":1}') + "\n", ""],
      afterFollow: (index, stop) => {
        if (index === 1) stop.stopped = true;
      },
    });
    await collectPodLogStream(h.opts);
    const stderr = h.emitted.filter(([s]) => s === "stderr").map(([, c]) => c).join("");
    expect(stderr).toContain("reconnecting (#1) from 2026-10-31T07:00:05Z");
  });

  it("never calls persist for a line it filtered out", async () => {
    const persist = vi.fn(async () => {});
    const stopSignal = { stopped: false };
    await collectPodLogStream({
      stopSignal,
      sleep: async () => {},
      onLog: async () => {},
      persist,
      follow: async ({ onData }) => {
        onData("2026-10-31T07:00:05.1Z [paperclip] not the transcript\n");
        stopSignal.stopped = true;
      },
      read: async () => "",
    });
    expect(persist).not.toHaveBeenCalled();
  });
});

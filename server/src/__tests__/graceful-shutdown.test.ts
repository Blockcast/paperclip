import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createServer, get as httpGet, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Response } from "express";

import { sseRegistry } from "../services/sse-registry.js";
import { logShutdownSignal, writeShutdownBreadcrumb } from "../shutdown-log.js";

/**
 * Captures shutdown breadcrumbs by pointing the real write at a temp file.
 *
 * These tests used to stub `process.stderr.write`. That stopped being the sink
 * when `shutdown-log.ts` moved to `fs.writeSync` on the raw fd — but the
 * deeper problem is that stubbing the stream could never have caught the bug
 * that motivated the move: a stub returns synchronously whether or not the
 * underlying write is asynchronous, so "writes synchronously" passed for years
 * against a write that libuv was queueing. Redirecting the fd instead means
 * the assertions below observe bytes that a real `write(2)` has delivered, so
 * `toHaveLength(1)` immediately after the call is now a genuine synchronicity
 * claim. The out-of-process suite in `process-crash-guard-exit.test.ts` covers
 * the other half — surviving a real `process.exit`.
 */
function createStderrCapture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-log-"));
  const file = path.join(dir, "stderr.log");
  const fd = fs.openSync(file, "a+");
  const original = Object.getOwnPropertyDescriptor(process, "stderr");
  let degraded = 0;

  Object.defineProperty(process, "stderr", {
    configurable: true,
    value: {
      fd,
      // The stream path is the *degraded* branch now. Counting it is what
      // makes this harness discriminating: if the implementation regressed to
      // `process.stderr.write`, the bytes would still arrive here and every
      // content assertion would pass — so the tests assert this stays 0.
      write: (chunk: unknown) => {
        degraded += 1;
        fs.writeSync(fd, typeof chunk === "string" ? chunk : String(chunk));
        return true;
      },
    },
  });

  return {
    /** One entry per written line, trailing newline preserved. */
    lines(): string[] {
      const raw = fs.readFileSync(file, "utf8");
      if (raw === "") return [];
      return raw
        .split("\n")
        .slice(0, -1)
        .map((line) => `${line}\n`);
    },
    /** Times the async stream fallback was used instead of the sync fd write. */
    degradedWrites(): number {
      return degraded;
    },
    restore(): void {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
      if (original) Object.defineProperty(process, "stderr", original);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface FakeRes extends EventEmitter {
  _written: string[];
  _ended: boolean;
  writable: boolean;
  write: (chunk: string) => boolean;
  end: () => void;
}

function fakeRes(): FakeRes {
  const emitter = new EventEmitter() as FakeRes;
  emitter._written = [];
  emitter._ended = false;
  emitter.writable = true;
  emitter.write = (chunk: string) => {
    emitter._written.push(chunk);
    return true;
  };
  emitter.end = () => {
    emitter._ended = true;
    emitter.writable = false;
    // Model real Node: 'finish' fires once the underlying socket flushes the
    // queued bytes. The default fake assumes a healthy socket — tests that
    // want to simulate a wedged socket override end() to skip the emit.
    setImmediate(() => emitter.emit("finish"));
  };
  return emitter;
}

describe("sseRegistry", () => {
  beforeEach(async () => {
    // Drain any leftover state between tests
    await sseRegistry.drain({ timeoutMs: 50, reason: "test:reset" });
  });

  it("register adds, unregister removes", () => {
    const r1 = fakeRes();
    const r2 = fakeRes();
    expect(sseRegistry.size()).toBe(0);

    sseRegistry.register(r1 as unknown as Response);
    expect(sseRegistry.size()).toBe(1);

    sseRegistry.register(r2 as unknown as Response);
    expect(sseRegistry.size()).toBe(2);

    sseRegistry.unregister(r1 as unknown as Response);
    expect(sseRegistry.size()).toBe(1);

    sseRegistry.unregister(r2 as unknown as Response);
    expect(sseRegistry.size()).toBe(0);
  });

  it("drain emits final shutdown event and calls res.end() on each tracked response", async () => {
    const r1 = fakeRes();
    const r2 = fakeRes();
    sseRegistry.register(r1 as unknown as Response);
    sseRegistry.register(r2 as unknown as Response);

    await sseRegistry.drain({ timeoutMs: 1000, reason: "shutdown:SIGTERM" });

    for (const r of [r1, r2]) {
      expect(r._ended).toBe(true);
      expect(r.writable).toBe(false);
      // Expect exactly one write containing the shutdown event frame
      expect(r._written.length).toBe(1);
      const frame = r._written[0];
      expect(frame).toContain("event: shutdown\n");
      expect(frame).toContain("data: ");
      // Payload should include the reason and a ts ISO timestamp
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      expect(dataLine).toBeDefined();
      const payload = JSON.parse(dataLine!.slice("data: ".length));
      expect(payload.reason).toBe("shutdown:SIGTERM");
      expect(typeof payload.ts).toBe("string");
      expect(() => new Date(payload.ts)).not.toThrow();
    }

    expect(sseRegistry.size()).toBe(0);
  });

  it("drain enforces the timeout when a response wedges", async () => {
    // A wedged response: writable stays true forever and end() does nothing
    const wedged = fakeRes();
    wedged.end = () => {
      // Simulates an end() that never actually closes — writable remains true
    };
    sseRegistry.register(wedged as unknown as Response);

    const start = Date.now();
    await sseRegistry.drain({ timeoutMs: 50, reason: "shutdown:test" });
    const elapsed = Date.now() - start;

    // Should not block forever — bounded by timeout (with reasonable upper bound)
    expect(elapsed).toBeLessThan(500);
    // Final clear should remove the wedged entry
    expect(sseRegistry.size()).toBe(0);
  });

  it("drain waits for the socket 'finish' event, not just res.writable flipping", async () => {
    // Real-Node semantics: res.end() flips res.writable=false synchronously, but the
    // underlying socket may still be flushing the buffered shutdown frame. drain()
    // must await the 'finish' event so the bytes are guaranteed on the wire before
    // the caller (the SIGTERM handler) proceeds to process.exit(0).
    //
    // The buggy implementation polled res.writable and resolved as soon as it
    // flipped — well before the socket flush completed. process.exit then raced
    // with libuv's pending write and the shutdown frame was lost on the wire.
    const slow = new EventEmitter() as FakeRes;
    slow._written = [];
    slow._ended = false;
    slow.writable = true;
    slow.write = (chunk: string) => {
      slow._written.push(chunk);
      return true;
    };
    slow.end = () => {
      slow._ended = true;
      slow.writable = false; // mimics Node: flips synchronously on .end()
      // 'finish' fires later, after the kernel actually accepts the bytes
      setTimeout(() => slow.emit("finish"), 100);
    };

    sseRegistry.register(slow as unknown as Response);

    let drainResolved = false;
    const drainPromise = sseRegistry
      .drain({ timeoutMs: 1000, reason: "shutdown:SIGTERM" })
      .then(() => {
        drainResolved = true;
      });

    // 40ms in — long enough for the buggy implementation (~10ms polling) to have
    // already resolved, but well before the 100ms-delayed 'finish' event.
    await new Promise((r) => setTimeout(r, 40));
    expect(drainResolved).toBe(false);

    await drainPromise;
    expect(drainResolved).toBe(true);
    expect(slow._ended).toBe(true);
    expect(sseRegistry.size()).toBe(0);
  });

  it(
    "end-to-end: drain delivers shutdown frame to a real SSE client AND unblocks server.close()",
    async () => {
      // This test models the production shutdown sequence end-to-end:
      //   1. boot a real http.Server, register the SSE response in sseRegistry
      //      from inside the request handler (mirrors routes/plugins.ts)
      //   2. open a real HTTP client connection and read it as a stream
      //   3. invoke sseRegistry.drain — must emit the shutdown frame on the wire
      //   4. invoke server.close — must resolve promptly (no SSE keep-alive
      //      deadlock) now that the drain has ended() the response
      //
      // Regression coverage for BLO-4137: the old ordering (server.close before
      // drain) would deadlock here because http.Server.close keeps existing
      // connections open until they end themselves — and a registered SSE
      // never ends on its own.
      const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(":ok\n\n");
        sseRegistry.register(res as unknown as Response);
        res.on("close", () => sseRegistry.unregister(res as unknown as Response));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;

      const received: string[] = [];
      let clientEnded = false;
      const clientReq = httpGet(`http://127.0.0.1:${port}/`, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk) => received.push(chunk as string));
        res.on("end", () => {
          clientEnded = true;
        });
      });

      // Wait until the SSE is registered AND the client has the :ok heartbeat
      const heartbeatDeadline = Date.now() + 2000;
      while (
        (sseRegistry.size() === 0 || !received.some((c) => c.includes(":ok"))) &&
        Date.now() < heartbeatDeadline
      ) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(sseRegistry.size()).toBe(1);
      expect(received.some((c) => c.includes(":ok"))).toBe(true);

      // Drain — must emit shutdown frame and end the response.
      await sseRegistry.drain({ timeoutMs: 5000, reason: "shutdown:SIGTERM" });

      // Client should have received the shutdown frame (the FIN that follows
      // res.end() triggers the client's 'end'; give libuv a tick to flush).
      const drainDeadline = Date.now() + 1000;
      while (
        !received.join("").includes("event: shutdown") &&
        Date.now() < drainDeadline
      ) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const body = received.join("");
      expect(body).toContain("event: shutdown\n");
      expect(body).toContain('"reason":"shutdown:SIGTERM"');

      // server.close() must resolve promptly — with the SSE drained there are
      // no long-lived connections holding the callback. If we ever regress
      // and put server.close before drain, this would hang forever.
      const closeStart = Date.now();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("server.close did not resolve within 2s — SSE drain failed to release the connection")),
          2000,
        );
        server.close((err) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        });
      });
      expect(Date.now() - closeStart).toBeLessThan(1000);

      // Tidy up the client; it's fine if it's already ended.
      clientReq.destroy();
      // Give the 'end' handler a tick if it hasn't fired yet (the FIN sent by
      // res.end() should have driven it before this point).
      if (!clientEnded) {
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    10_000,
  );
});

describe("logShutdownSignal", () => {
  // Redirects the real stderr fd to a temp file — see `createStderrCapture`.
  // `captured` reads back what an actual `write(2)` delivered, which is what
  // makes the synchronicity assertion below meaningful.
  let capture: ReturnType<typeof createStderrCapture>;

  beforeEach(() => {
    capture = createStderrCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it("writes a single line containing the signal name to process.stderr", () => {
    logShutdownSignal("SIGTERM");
    expect(capture.lines().length).toBeGreaterThan(0);
    const joined = capture.lines().join("");
    expect(joined).toContain("SIGTERM");
    // The line is a meaningful breadcrumb — must mention shutdown.
    expect(joined.toLowerCase()).toContain("shutdown");
    // And it must end with a newline so it's a complete log line, not a
    // partial that some downstream reader could fail to flush.
    expect(joined.endsWith("\n")).toBe(true);
  });

  it("writes synchronously — the line is in stderr BEFORE the function returns", () => {
    // This is the load-bearing guarantee. pino's async transport drops logs
    // on process.exit; this module must not. The bytes must be readable back
    // off the fd before the next synchronous statement runs — no
    // setImmediate / setTimeout / await tricks allowed in the implementation,
    // and not via the async stream either (see degradedWrites).
    expect(capture.lines()).toHaveLength(0);
    logShutdownSignal("SIGINT");
    expect(capture.lines()).toHaveLength(1);
    expect(capture.lines()[0]).toContain("SIGINT");
    expect(capture.degradedWrites()).toBe(0);
  });

  it("escapes nothing — signal name appears verbatim", () => {
    logShutdownSignal("SIGTERM");
    // Easy regression: if someone wraps in JSON.stringify or adds quoting
    // later, the kubectl logs grep `Shutdown signal received | grep SIGTERM`
    // recipe in BLO-4137 stops matching.
    expect(capture.lines()[0]).toMatch(/(^|[\s\W])SIGTERM([\s\W]|$)/);
  });
});

describe("writeShutdownBreadcrumb", () => {
  // Same fd-redirect harness as logShutdownSignal — these helpers share the
  // same synchronous-stderr load-bearing guarantee. See that describe block
  // above for the rationale.
  let capture: ReturnType<typeof createStderrCapture>;

  beforeEach(() => {
    capture = createStderrCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it("prefixes every line with [shutdown] and a trailing newline", () => {
    writeShutdownBreadcrumb("stopping embedded PostgreSQL (signal=SIGTERM)");
    expect(capture.lines().length).toBe(1);
    const line = capture.lines()[0];
    expect(line.startsWith("[shutdown] ")).toBe(true);
    expect(line.endsWith("\n")).toBe(true);
    expect(line).toContain("stopping embedded PostgreSQL");
    expect(line).toContain("SIGTERM");
  });

  it("writes synchronously — captured BEFORE the function returns", () => {
    // The load-bearing guarantee: each call must land bytes on the fd before
    // the next synchronous statement runs. The trailing shutdown log lines
    // exist precisely because pino's async transport drops late lines on
    // process.exit; if this helper acquired async semantics — including by
    // falling back to the stream — it would re-introduce the gap.
    expect(capture.lines()).toHaveLength(0);
    writeShutdownBreadcrumb("step one");
    expect(capture.lines()).toHaveLength(1);
    writeShutdownBreadcrumb("step two");
    expect(capture.lines()).toHaveLength(2);
    expect(capture.lines()[0]).toContain("step one");
    expect(capture.lines()[1]).toContain("step two");
    expect(capture.degradedWrites()).toBe(0);
  });

  it("logShutdownSignal shares the [shutdown] prefix so one grep recipe captures both", () => {
    // The BLO-4137 verification flow greps `kubectl logs … | grep '^\[shutdown\]'`
    // to enumerate the breadcrumbs the handler emitted. Keep both helpers
    // funneling through the same prefix so that recipe doesn't grow special
    // cases over time.
    logShutdownSignal("SIGTERM");
    writeShutdownBreadcrumb("handler complete; exiting (signal=SIGTERM)");
    expect(capture.lines().length).toBe(2);
    expect(capture.lines().every((line) => line.startsWith("[shutdown] "))).toBe(true);
  });

  it("does not escape — message payload appears verbatim for kubectl grep", () => {
    // If someone wraps in JSON.stringify later, recipes like
    //   `grep -F 'sseRegistry.drain failed'`
    // stop matching. Pin verbatim semantics.
    writeShutdownBreadcrumb("sseRegistry.drain failed: ECONNRESET");
    expect(capture.lines()[0]).toContain("sseRegistry.drain failed: ECONNRESET");
    expect(capture.lines()[0]).not.toContain('"');
  });
});

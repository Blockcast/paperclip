import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { logger } from "../middleware/logger.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

class FakeUpgradeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  writableEnded = false;
  writableDestroyed = false;
  endedChunks: string[] = [];
  destroyCalls = 0;

  end(chunk?: string) {
    if (chunk) this.endedChunks.push(chunk);
    this.writableEnded = true;
    this.writable = false;
    setImmediate(() => {
      if (this.destroyed) return;
      this.emit("finish");
      if (!this.destroyed) {
        this.emit("close");
      }
    });
    return this;
  }

  destroy() {
    this.destroyCalls += 1;
    this.destroyed = true;
    this.writable = false;
    this.writableDestroyed = true;
    this.emit("close");
    return this;
  }

  emitSocketError(err: Error) {
    this.writable = false;
    this.writableDestroyed = true;
    this.emit("error", err);
  }
}

function createUpgradeRequest(overrides: Partial<IncomingMessage> = {}) {
  return {
    url: "/api/companies/company-1/events/ws",
    headers: {},
    ...overrides,
  } as IncomingMessage;
}

async function flushPromises() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("setupLiveEventsWebSocketServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not write a rejection response after the raw upgrade socket is already closed", async () => {
    const server = new EventEmitter();
    setupLiveEventsWebSocketServer(server as never, {} as never, { deploymentMode: "authenticated" });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    socket.destroy();
    await flushPromises();

    expect(socket.endedChunks).toEqual([]);
    expect(socket.destroyCalls).toBe(1);
  });

  it("handles raw upgrade socket errors during async authorization", async () => {
    const server = new EventEmitter();
    let resolveSession: (value: null) => void = () => undefined;
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders: () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    expect(() => socket.emitSocketError(new Error("write EPIPE"))).not.toThrow();
    resolveSession(null);
    await flushPromises();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), path: "/api/companies/company-1/events/ws" }),
      "live websocket upgrade socket error",
    );
    expect(socket.endedChunks).toEqual([]);
    expect(socket.destroyed).toBe(true);
  });

  it("destroys and cleans up listeners after flushing a rejection response", async () => {
    const server = new EventEmitter();
    setupLiveEventsWebSocketServer(server as never, {} as never, { deploymentMode: "authenticated" });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks[0]).toContain("403 Forbidden");
    expect(socket.destroyed).toBe(true);
    expect(socket.listenerCount("error")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("finish")).toBe(0);
  });
});

// PEN-3549. A browser `WebSocket` constructor cannot set an `Authorization`
// header, so the board authenticates this socket with `?token=` — the global
// pino `redact` in logger.ts names `req.headers.authorization`, which is
// precisely the form these clients cannot use. Both upgrade error paths used
// to log `req.url` raw, writing that agent API key to the log sink in clear.
describe("setupLiveEventsWebSocketServer — upgrade URL never reaches a log raw", () => {
  // Shaped like a real agent API key (`pcp_` + hex, see `createToken` in
  // services/agents.ts) so a substring assertion is meaningful, but minted
  // here and valid nowhere.
  const TOKEN_SENTINEL = "pcp_0000000000000000000000000000000000000000deadbeef";
  const tokenUrl = `/api/companies/company-1/events/ws?token=${TOKEN_SENTINEL}`;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function loggedText(mock: { mock: { calls: unknown[][] } }): string {
    return JSON.stringify(mock.mock.calls);
  }

  it("omits the token from the raw-socket-error path", async () => {
    const server = new EventEmitter();
    let resolveSession: (value: null) => void = () => undefined;
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders: () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest({ url: tokenUrl }), socket as unknown as Duplex, Buffer.alloc(0));
    socket.emitSocketError(new Error("write EPIPE"));
    resolveSession(null);
    await flushPromises();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/api/companies/company-1/events/ws?redactedQueryKeys=1" }),
      "live websocket upgrade socket error",
    );
    expect(loggedText(logger.warn as never)).not.toContain(TOKEN_SENTINEL);
  });

  it("omits the token from the authorization-failure path", async () => {
    const server = new EventEmitter();
    // A token present sends `authorizeUpgrade` down the agent-API-key branch,
    // where this `{}` stand-in for the Db throws — which is the only way the
    // `.catch` that owns this log line is reached. An INVALID token does not
    // reach it: that resolves to `null` and takes the silent 403 branch. So
    // what this path writes is predominantly a LEGITIMATE key caught by an
    // infrastructure fault, not an attacker's own value.
    setupLiveEventsWebSocketServer(server as never, {} as never, { deploymentMode: "authenticated" });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest({ url: tokenUrl }), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/api/companies/company-1/events/ws?redactedQueryKeys=1" }),
      "failed websocket upgrade authorization",
    );
    expect(loggedText(logger.error as never)).not.toContain(TOKEN_SENTINEL);
  });
});

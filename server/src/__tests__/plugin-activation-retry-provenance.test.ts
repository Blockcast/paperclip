/**
 * BLO-22095 — activation retry must use startup provenance rather than the
 * broad legacy message classifier. A plugin-returned setup error can carry the
 * same RPC code as a host timeout, but must still fail closed.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_RPC_ERROR_CODES, JsonRpcCallError } from "@paperclipai/plugin-sdk";

const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: forkMock };
});

import {
  TRANSIENT_ACTIVATION_RETRY_DELAYS_MS,
  isTransientActivationRetryError,
} from "../services/plugin-loader.js";
import {
  WorkerStartupError,
  createPluginWorkerHandle,
} from "../services/plugin-worker-manager.js";

function wrappedInitializeFailure(
  pluginId: string,
  cause: Error,
  options: { transient?: boolean } = {},
): WorkerStartupError {
  const causeCode = cause instanceof JsonRpcCallError ? cause.code : null;
  return new WorkerStartupError(
    `Worker initialize failed for "${pluginId}": ${cause.message}`,
    {
      transient: options.transient ?? false,
      causeCode,
    },
  );
}

class FakeChild extends EventEmitter {
  pid = 4242;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill(signal?: NodeJS.Signals): boolean {
    this.emit("exit", null, signal ?? null);
    return true;
  }
}

const spawned: FakeChild[] = [];

function installForkMock(): void {
  spawned.length = 0;
  forkMock.mockReset();
  forkMock.mockImplementation(() => {
    const child = new FakeChild();
    spawned.push(child);
    return child;
  });
}

function createTestWorkerHandle(autoRestart = false) {
  return createPluginWorkerHandle("example.plugin", {
    entrypointPath: "/tmp/example-plugin/worker.js",
    manifest: { id: "example.plugin", capabilities: [] } as never,
    config: {},
    instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
    apiVersion: 1,
    hostHandlers: {} as never,
    autoRestart,
  });
}

function readNextWorkerRequest(
  child: FakeChild,
): Promise<{ id: string | number | null; method?: string }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) return;
      child.stdin.off("data", onData);
      try {
        resolve(JSON.parse(buffer.slice(0, lineEnd)) as {
          id: string | number | null;
          method?: string;
        });
      } catch (err) {
        reject(err);
      }
    };
    child.stdin.on("data", onData);
  });
}

describe("isTransientActivationRetryError", () => {
  it("uses typed startup provenance instead of the wrapper message", () => {
    const hostTimeout = wrappedInitializeFailure(
      "lucitra.plugin-secrets",
      new JsonRpcCallError({
        code: PLUGIN_RPC_ERROR_CODES.TIMEOUT,
        message: 'RPC call "initialize" timed out after 60000ms',
      }),
      { transient: true },
    );
    expect(isTransientActivationRetryError(hostTimeout)).toBe(true);

    for (const cause of [
      new Error("invalid credentials"),
      new JsonRpcCallError({
        code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
        message: "Error: bad credentials",
      }),
      new JsonRpcCallError({
        code: PLUGIN_RPC_ERROR_CODES.TIMEOUT,
        message: "nested host RPC timed out during setup",
      }),
      new JsonRpcCallError({
        code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
        message: "nested host RPC worker unavailable during setup",
      }),
    ]) {
      const pluginFault = wrappedInitializeFailure("example.plugin", cause);
      expect(pluginFault.message).toContain("Worker initialize failed");
      expect(isTransientActivationRetryError(pluginFault)).toBe(false);
    }
  });

  it("only falls back for an untyped initialize timeout", () => {
    expect(
      isTransientActivationRetryError(
        'RPC call "initialize" timed out after 60000ms',
      ),
    ).toBe(true);
    expect(
      isTransientActivationRetryError(
        new Error('RPC call "jobs.run" timed out after 30000ms'),
      ),
    ).toBe(false);
    expect(
      isTransientActivationRetryError(
        new Error('Worker initialize failed for "example.plugin": bad credentials'),
      ),
    ).toBe(false);
  });
});

describe("worker startup error provenance", () => {
  beforeEach(() => {
    installForkMock();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    PLUGIN_RPC_ERROR_CODES.TIMEOUT,
    PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
  ])("does not mark worker-returned setup code %s as transient", async (code) => {
    const handle = createTestWorkerHandle(false);
    const failure = handle.start().catch((err: unknown) => err);

    expect(spawned).toHaveLength(1);
    const request = await readNextWorkerRequest(spawned[0]!);
    expect(request.method).toBe("initialize");

    spawned[0]!.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code,
          message: `setup nested host RPC failed with ${code}`,
        },
      }) + "\n",
    );

    const err = await failure;
    expect(err).toBeInstanceOf(WorkerStartupError);
    expect((err as WorkerStartupError).causeCode).toBe(code);
    expect((err as WorkerStartupError).transient).toBe(false);
    expect(isTransientActivationRetryError(err)).toBe(false);
  });

  it("marks a host-owned initialize timeout as transient", async () => {
    const handle = createTestWorkerHandle(false);
    const failure = handle.start().catch((err: unknown) => err);

    expect(spawned).toHaveLength(1);
    const request = await readNextWorkerRequest(spawned[0]!);
    expect(request.method).toBe("initialize");

    await vi.advanceTimersByTimeAsync(60_000);

    const err = await failure;
    expect(err).toBeInstanceOf(WorkerStartupError);
    expect((err as WorkerStartupError).causeCode).toBe(
      PLUGIN_RPC_ERROR_CODES.TIMEOUT,
    );
    expect((err as WorkerStartupError).transient).toBe(true);
    expect(isTransientActivationRetryError(err)).toBe(true);
  });
});

describe("worker startup crash retry cleanup", () => {
  beforeEach(() => {
    installForkMock();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not self-restart before the activation retry delay expires", async () => {
    const handle = createTestWorkerHandle(true);
    const failure = handle.start().catch((err: unknown) => err);

    expect(spawned).toHaveLength(1);
    spawned[0]!.emit("exit", 1, null);

    const err = await failure;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Worker initialize failed");

    await vi.advanceTimersByTimeAsync(TRANSIENT_ACTIVATION_RETRY_DELAYS_MS[0]!);

    expect(spawned).toHaveLength(1);
    expect(handle.status).not.toBe("running");
  });
});

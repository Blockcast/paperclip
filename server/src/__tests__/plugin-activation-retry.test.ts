/**
 * BLO-20410 — a transient 60s `initialize` timeout at pod start used to latch a
 * plugin at status='error' forever. Four of eleven plugins (including
 * `lucitra.plugin-secrets`) sat dead for 9+ hours and every one of them
 * recovered from a single manual `/enable` with no other change.
 *
 * Two guarantees are covered here:
 *   1. the timeout is classified transient (retried) while a real plugin fault
 *      is still classified terminal (fails closed on the first attempt);
 *   2. boot activation is bounded, so the plugin set no longer contends for one
 *      60s initialize window.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_RPC_ERROR_CODES, JsonRpcCallError } from "@paperclipai/plugin-sdk";

// ESM namespaces are not configurable, so `fork` has to be replaced at module
// resolution time rather than with vi.spyOn.
const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: forkMock };
});

import {
  TRANSIENT_ACTIVATION_RETRY_DELAYS_MS,
  isTransientActivationError,
  mapWithConcurrency,
  resolveActivationConcurrency,
} from "../services/plugin-loader.js";
import {
  WorkerStartupError,
  createPluginWorkerHandle,
} from "../services/plugin-worker-manager.js";

/**
 * Build the error `startWorker()` actually throws, rather than hand-writing the
 * string. BLO-22095: the wrapper prefix `Worker initialize failed for "<id>"`
 * is applied to *every* initialize failure, so a test that constructs the
 * message by hand can assert a classification the production shape never
 * produces.
 */
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
  killed = false;
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
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

describe("isTransientActivationError", () => {
  it("classifies the observed production initialize timeout as transient", () => {
    // Verbatim from the four errored plugins' lastError (BLO-20410), rebuilt
    // through the production wrapper so the typed cause is present.
    const observed = wrappedInitializeFailure(
      "lucitra.plugin-secrets",
      new JsonRpcCallError({
        code: PLUGIN_RPC_ERROR_CODES.TIMEOUT,
        message: 'RPC call "initialize" timed out after 60000ms',
      }),
      { transient: true },
    );
    expect(observed.message).toBe(
      'Worker initialize failed for "lucitra.plugin-secrets": ' +
        'RPC call "initialize" timed out after 60000ms',
    );
    expect(isTransientActivationError(observed)).toBe(true);
  });

  it("classifies a worker that dies before initialize resolves as transient", () => {
    // The real message: handleProcessExit() rejects the in-flight initialize
    // with this, tagged WORKER_UNAVAILABLE. The previous marker list carried
    // "Worker exited during startup", which no production code ever throws.
    const died = wrappedInitializeFailure(
      "example.plugin",
      new JsonRpcCallError({
        code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
        message: "Worker process exited (code=1, signal=null)",
      }),
      { transient: true },
    );
    expect(isTransientActivationError(died)).toBe(true);
  });

  it("does NOT retry a plugin whose initialize handler throws (BLO-22095)", () => {
    // The regression: every initialize failure is wrapped in the same
    // `Worker initialize failed` prefix, so a substring match on that prefix
    // classified a genuine plugin fault as contention and retried it 3x.
    for (const cause of [
      new Error("invalid credentials"),
      new Error("missing required config key 'apiToken'"),
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
      const wrapped = wrappedInitializeFailure("example.plugin", cause);
      expect(wrapped.message).toContain("Worker initialize failed");
      expect(isTransientActivationError(wrapped)).toBe(false);
    }
  });

  it("does NOT retry a plugin that reports a real fault inside the budget", () => {
    // ok=false is the plugin answering "I am broken" — retrying just delays a
    // legitimate error latch.
    expect(
      isTransientActivationError(
        wrappedInitializeFailure(
          "example.plugin",
          new Error("Worker initialize returned ok=false"),
        ),
      ),
    ).toBe(false);
  });

  it("does NOT retry structural faults", () => {
    for (const message of [
      "Worker entrypoint not found: dist/worker.js",
      "Invalid plugin manifest: missing 'id'",
      "ERR_MODULE_NOT_FOUND: cannot find package 'left-pad'",
    ]) {
      expect(isTransientActivationError(new Error(message))).toBe(false);
    }
  });

  it("handles non-Error rejections without throwing", () => {
    expect(isTransientActivationError('RPC call "initialize" timed out after 60000ms')).toBe(
      true,
    );
    expect(isTransientActivationError(undefined)).toBe(false);
  });

  it("does not classify an unrelated RPC timeout as an activation failure", () => {
    // The old marker was a bare "timed out after", which matched any RPC.
    expect(
      isTransientActivationError(
        new Error('RPC call "jobs.run" timed out after 30000ms'),
      ),
    ).toBe(false);
  });

  it("budgets more than one retry but keeps the added boot delay small", () => {
    // Each attempt can burn the full 60s initialize budget, so the schedule has
    // to stay short or a bad boot serializes into minutes.
    expect(TRANSIENT_ACTIVATION_RETRY_DELAYS_MS.length).toBeGreaterThanOrEqual(1);
    const total = TRANSIENT_ACTIVATION_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(30_000);
  });
});

describe("resolveActivationConcurrency", () => {
  const KEY = "PAPERCLIP_PLUGIN_ACTIVATION_CONCURRENCY";
  const withEnv = (value: string | undefined, run: () => void) => {
    const prior = process.env[KEY];
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    try {
      run();
    } finally {
      if (prior === undefined) delete process.env[KEY];
      else process.env[KEY] = prior;
    }
  };

  it("defaults to a bounded value rather than unbounded fan-out", () => {
    withEnv(undefined, () => {
      const value = resolveActivationConcurrency();
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(8);
    });
  });

  it("honours a valid override", () => {
    withEnv("2", () => expect(resolveActivationConcurrency()).toBe(2));
  });

  it("falls back to the default on garbage or non-positive input", () => {
    withEnv("not-a-number", () => expect(resolveActivationConcurrency()).toBe(4));
    withEnv("0", () => expect(resolveActivationConcurrency()).toBe(4));
    withEnv("-3", () => expect(resolveActivationConcurrency()).toBe(4));
  });
});

describe("mapWithConcurrency", () => {
  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 11 }, (_, i) => i);

    await mapWithConcurrency(items, 4, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return item;
    });

    // The regression: 11 plugins all entering the 60s initialize window at once.
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("preserves input order in the results", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const results = await mapWithConcurrency(items, 2, async (item, index) => {
      // Invert the delay so completion order differs from input order.
      await new Promise((r) => setTimeout(r, (items.length - index) * 4));
      return item.toUpperCase();
    });

    expect(results.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
    ]);
  });

  it("isolates failures so one bad plugin cannot abort the rest", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error("activation exploded");
      return item * 10;
    });

    expect(results[0]).toEqual({ status: "fulfilled", value: 10 });
    expect(results[1]?.status).toBe("rejected");
    expect(results[2]).toEqual({ status: "fulfilled", value: 30 });
  });

  it("runs every item even when the list is longer than the limit", async () => {
    const seen: number[] = [];
    const items = Array.from({ length: 25 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (item) => {
      seen.push(item);
      return item;
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it("handles an empty list without hanging", async () => {
    await expect(mapWithConcurrency([], 4, async (x) => x)).resolves.toEqual([]);
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
  ])(
    "does not mark worker-returned setup code %s as transient",
    async (code) => {
      const handle = createTestWorkerHandle(false);

      const start = handle.start();
      const failure = start.catch((err: unknown) => err);

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
      expect(isTransientActivationError(err)).toBe(false);
      expect(spawned).toHaveLength(1);
    },
  );

  it("marks a host-owned initialize timeout as transient", async () => {
    const handle = createTestWorkerHandle(false);

    const start = handle.start();
    const failure = start.catch((err: unknown) => err);

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
    expect(isTransientActivationError(err)).toBe(true);
  });
});

/**
 * BLO-22095 finding 2 — a worker that crashes before `initialize` resolves
 * schedules its own restart on a 750–1250ms backoff. The activation retry loop
 * then sleeps TRANSIENT_ACTIVATION_RETRY_DELAYS_MS[0] (2000ms) before its own
 * next attempt, and `killProcess()` did not cancel the pending timer, so the
 * worker resurrected itself inside that window — one unbudgeted start racing
 * the retry the loop was about to make.
 */
describe("worker startup crash does not self-restart during the activation retry delay", () => {
  beforeEach(() => {
    installForkMock();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns exactly once when the worker dies before initialize resolves", async () => {
    const handle = createPluginWorkerHandle("example.plugin", {
      entrypointPath: "/tmp/example-plugin/worker.js",
      manifest: { id: "example.plugin", capabilities: [] } as never,
      config: {},
      instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
      apiVersion: 1,
      hostHandlers: {} as never,
      // Default (true) — the restart machinery must be armed for this to be a
      // real regression test; disabling it would trivially pass.
      autoRestart: true,
    });

    const start = handle.start();
    const failure = start.catch((err: unknown) => err);

    // The worker dies before answering initialize. This is the production
    // crash-before-initialize path, not the dead "Worker exited during
    // startup" marker.
    expect(spawned).toHaveLength(1);
    spawned[0]!.emit("exit", 1, null);

    const err = await failure;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Worker initialize failed");

    // Backoff is MIN_BACKOFF_MS (1000ms) ±25% jitter, so any pending restart
    // fires strictly inside the 2000ms activation retry sleep.
    await vi.advanceTimersByTimeAsync(TRANSIENT_ACTIVATION_RETRY_DELAYS_MS[0]!);

    expect(spawned).toHaveLength(1);
    expect(handle.status).not.toBe("running");
  });
});

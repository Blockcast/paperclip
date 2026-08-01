import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  CRASH_GUARD_EXIT_CODE,
  installProcessCrashGuard,
  serializeCauseChain,
} from "../process-crash-guard.js";

// BLO-19722: before this guard existed there was no process.on("uncaughtException")
// anywhere in server/src, so an async throw we do not own — in practice the
// postgres.js null-socket race, porsager/postgres#1154 — killed the worker with
// a bare stack and orphaned every run it supervised.
//
// These are the pure-process-level halves of the contract. The DB-facing half
// (what happens to the in-flight runs) lives in
// heartbeat-worker-crash-marking.test.ts.

/** Stand-in for `process` so tests never install real handlers. */
function fakeProcess() {
  const emitter = new EventEmitter();
  // Node warns past 10 listeners; these tests intentionally add/remove many.
  emitter.setMaxListeners(50);
  return emitter as unknown as Pick<NodeJS.Process, "on" | "off"> & EventEmitter;
}

function fakeLogger() {
  return { error: vi.fn(), flush: vi.fn() };
}

describe("serializeCauseChain", () => {
  it("flattens a nested cause chain outermost-first", () => {
    const root = new Error("socket write failed");
    const mid = new Error("query aborted", { cause: root });
    const top = new Error("heartbeat tick failed", { cause: mid });

    const chain = serializeCauseChain(top);

    expect(chain.map((entry) => entry.message)).toEqual([
      "heartbeat tick failed",
      "query aborted",
      "socket write failed",
    ]);
    // The stack is what an operator actually needs; losing it is how the
    // original incident reached us as an unattributable one-liner.
    expect(chain[0]?.stack).toContain("heartbeat tick failed");
  });

  it("captures non-Error throwables rather than coercing them", () => {
    // `throw "boom"` and rejected plain objects both reach the guard; the shape
    // of what was thrown is itself a clue about which library threw it.
    expect(serializeCauseChain("boom")[0]).toMatchObject({ name: "string", raw: "boom" });
    expect(serializeCauseChain({ code: "ECONNRESET" })[0]?.raw).toBe('{"code":"ECONNRESET"}');
  });

  it("terminates on a self-referential cause chain", () => {
    // `cause` is library-controlled. A cycle here would hang the crash path,
    // converting a fast crash-and-restart into a silent wedge.
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;

    const chain = serializeCauseChain(b);

    expect(chain.length).toBeGreaterThan(0);
    expect(chain.length).toBeLessThanOrEqual(10);
  });

  it("survives throwing name/message/stack/cause getters", () => {
    // `name`/`message`/`stack`/`cause` are plain properties on a normal Error but
    // getters on subclasses and proxies. This runs before the synchronous
    // breadcrumb, and installing the guard suppresses Node's default printer —
    // so a throw here would lose both the breadcrumb and the stack we'd have got
    // for free without the guard, which is worse than not having one.
    const hostile = new Error("unreadable");
    for (const field of ["name", "message", "stack", "cause"]) {
      Object.defineProperty(hostile, field, {
        get() {
          throw new Error(`hostile ${field} getter`);
        },
      });
    }

    const chain = serializeCauseChain(hostile);

    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ name: "Error", message: "<unreadable message>" });
    expect(chain[0]?.stack).toBeUndefined();
  });
});

describe("installProcessCrashGuard (BLO-19722)", () => {
  it("runs crash bookkeeping and then exits non-zero on uncaughtException", async () => {
    const processRef = fakeProcess();
    const exit = vi.fn();
    const onCrash = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();

    installProcessCrashGuard({ logger, onCrash, exit, processRef });
    processRef.emit("uncaughtException", new Error("null socket write"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(onCrash).toHaveBeenCalledTimes(1);
    expect(onCrash.mock.calls[0]![0]).toMatchObject({ kind: "uncaughtException" });
    // Deliberate non-zero exit — the point is that the death is ours and
    // labelled, not Node's default bare-stack teardown.
    expect(exit).toHaveBeenCalledWith(CRASH_GUARD_EXIT_CODE);
    expect(logger.error).toHaveBeenCalled();
  });

  it("treats an unhandled rejection the same way", async () => {
    const processRef = fakeProcess();
    const exit = vi.fn();
    const onCrash = vi.fn().mockResolvedValue(undefined);

    installProcessCrashGuard({ logger: fakeLogger(), onCrash, exit, processRef });
    processRef.emit("unhandledRejection", new Error("pool drained"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(CRASH_GUARD_EXIT_CODE));

    expect(onCrash.mock.calls[0]![0]).toMatchObject({ kind: "unhandledRejection" });
  });

  it("exits even when crash bookkeeping never settles", async () => {
    const processRef = fakeProcess();
    const exit = vi.fn();
    // The most likely reason we are in the handler at all is that the database
    // driver just died, so the DB-touching bookkeeping is assumed to hang.
    // A crash guard that can wedge is worse than the crash it replaces.
    const onCrash = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    installProcessCrashGuard({ logger: fakeLogger(), onCrash, exit, processRef, timeoutMs: 20 });
    processRef.emit("uncaughtException", new Error("db gone"));

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(CRASH_GUARD_EXIT_CODE), { timeout: 2_000 });
  });

  it("sets process exitCode immediately while crash bookkeeping is pending", () => {
    const processRef = fakeProcess();
    const exit = vi.fn();
    const setExitCode = vi.fn();
    const onCrash = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    installProcessCrashGuard({
      logger: fakeLogger(),
      onCrash,
      exit,
      setExitCode,
      processRef,
      timeoutMs: 10_000,
    });
    processRef.emit("uncaughtException", new Error("db gone"));

    expect(setExitCode).toHaveBeenCalledWith(CRASH_GUARD_EXIT_CODE);
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits even when crash bookkeeping throws", async () => {
    const processRef = fakeProcess();
    const exit = vi.fn();
    const onCrash = vi.fn().mockRejectedValue(new Error("update failed"));

    installProcessCrashGuard({ logger: fakeLogger(), onCrash, exit, processRef });
    processRef.emit("uncaughtException", new Error("db gone"));

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(CRASH_GUARD_EXIT_CODE));
  });

  it("still exits when the thrown error's own getters throw", async () => {
    // End-to-end companion to the serializeCauseChain case above: a hostile
    // error must not be able to preempt the exit, which is the one thing the
    // guard has to guarantee.
    const processRef = fakeProcess();
    const exit = vi.fn();
    const onCrash = vi.fn().mockResolvedValue(undefined);
    const hostile = new Error("unreadable");
    Object.defineProperty(hostile, "stack", {
      get() {
        throw new Error("hostile stack getter");
      },
    });

    installProcessCrashGuard({ logger: fakeLogger(), onCrash, exit, processRef });
    processRef.emit("uncaughtException", hostile);

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(CRASH_GUARD_EXIT_CODE));
    expect(onCrash).toHaveBeenCalled();
  });

  it("exits immediately if a second crash arrives while handling the first", async () => {
    const processRef = fakeProcess();
    const exit = vi.fn();
    let releaseFirst: (() => void) | null = null;
    const onCrash = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    );

    installProcessCrashGuard({ logger: fakeLogger(), onCrash, exit, processRef, timeoutMs: 10_000 });
    processRef.emit("uncaughtException", new Error("first"));
    // Bookkeeping itself can throw — re-entering must not start a second
    // bounded wait, or the process never dies.
    processRef.emit("uncaughtException", new Error("second, from the handler"));

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(CRASH_GUARD_EXIT_CODE));
    expect(onCrash).toHaveBeenCalledTimes(1);
    releaseFirst?.();
  });

  it("still exits when no bookkeeping hook is supplied", async () => {
    const processRef = fakeProcess();
    const exit = vi.fn();

    installProcessCrashGuard({ logger: fakeLogger(), exit, processRef });
    processRef.emit("uncaughtException", new Error("boom"));

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(CRASH_GUARD_EXIT_CODE));
  });

  it("uninstalls cleanly", () => {
    const processRef = fakeProcess();
    const exit = vi.fn();

    const uninstall = installProcessCrashGuard({ logger: fakeLogger(), exit, processRef });
    uninstall();
    processRef.emit("uncaughtException", new Error("after uninstall"));

    expect(exit).not.toHaveBeenCalled();
  });
});

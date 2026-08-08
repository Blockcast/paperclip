import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markInFlightRunsForWorkerCrash,
  registerCrashTimeRunMarker,
  resetCrashTimeRunMarkerForTest,
} from "../crash-run-marking.js";
import { CRASH_GUARD_EXIT_CODE, installProcessCrashGuard } from "../process-crash-guard.js";

// BLO-19722 AC 2/3. `markRunsInterruptedByWorkerCrash` was fully tested and had
// no production caller for three review rounds: the unit under test was the
// function, never the wiring, so nothing failed while real crashes still fell
// through to being rediscovered as `job_missing`. These tests cover the wiring
// itself — the link from a real crash event to the marker.
//
// The pure guard contract (breadcrumb, cause chain, deliberate non-zero exit)
// lives in process-crash-guard.test.ts; the DB-facing half of marking lives in
// heartbeat-worker-crash-marking.test.ts.

/** Stand-in for `process` so tests never install real handlers. */
function fakeProcess() {
  const emitter = Object.assign(new EventEmitter(), { exitCode: undefined as number | undefined });
  emitter.setMaxListeners(50);
  return emitter as unknown as Pick<NodeJS.Process, "on" | "off" | "exitCode"> & EventEmitter;
}

afterEach(() => {
  resetCrashTimeRunMarkerForTest();
});

describe("markInFlightRunsForWorkerCrash (BLO-19722 AC 2/3)", () => {
  it("is inert when no marker is registered", async () => {
    // A replica with the heartbeat scheduler disabled supervises no runs. The
    // crash path must not throw there — a throwing hook costs the crash record
    // its bookkeeping breadcrumb.
    await expect(
      markInFlightRunsForWorkerCrash({ kind: "uncaughtException", error: new Error("boom") }),
    ).resolves.toBeUndefined();
  });

  it("hands the marker a reason naming the crash, not the symptom", async () => {
    const marker = vi.fn(async () => ({ markedRunIds: ["run-a", "run-b"] }));
    registerCrashTimeRunMarker(marker);

    await markInFlightRunsForWorkerCrash({
      kind: "uncaughtException",
      error: new Error("Cannot read properties of null (reading 'write')"),
    });

    // The operator-visible reason is the entire point of AC 2/3: it must name
    // worker death and the throw that caused it, never `job_missing`.
    expect(marker).toHaveBeenCalledExactlyOnceWith(
      "uncaughtException: Cannot read properties of null (reading 'write')",
    );
  });

  it("labels an unhandled rejection distinctly", async () => {
    const marker = vi.fn(async () => ({ markedRunIds: ["run-a"] }));
    registerCrashTimeRunMarker(marker);

    await markInFlightRunsForWorkerCrash({
      kind: "unhandledRejection",
      error: new Error("pool drained"),
    });

    expect(marker).toHaveBeenCalledExactlyOnceWith("unhandledRejection: pool drained");
  });

  it("renders non-Error throwables rather than dropping them", async () => {
    const marker = vi.fn(async () => ({ markedRunIds: [] }));
    registerCrashTimeRunMarker(marker);

    await markInFlightRunsForWorkerCrash({ kind: "uncaughtException", error: "boom" });

    expect(marker).toHaveBeenCalledExactlyOnceWith("uncaughtException: boom");
  });

  it("propagates a marker failure instead of swallowing it", async () => {
    // The guard catches this and appends `crash bookkeeping failed: …` to the
    // crash record. Swallowing here would make a failed mark read identically
    // to "nothing to mark" — the same silent gap this issue exists to close.
    registerCrashTimeRunMarker(async () => {
      throw new Error("db gone");
    });

    await expect(
      markInFlightRunsForWorkerCrash({ kind: "uncaughtException", error: new Error("boom") }),
    ).rejects.toThrow("db gone");
  });

  it("restores the previous marker when the registration is disposed", async () => {
    const first = vi.fn(async () => ({ markedRunIds: [] }));
    const second = vi.fn(async () => ({ markedRunIds: [] }));
    registerCrashTimeRunMarker(first);
    const dispose = registerCrashTimeRunMarker(second);

    dispose();
    await markInFlightRunsForWorkerCrash({ kind: "uncaughtException", error: new Error("boom") });

    expect(second).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledOnce();
  });
});
describe("crash guard wiring (BLO-19722 AC 2/3)", () => {
  it("marks in-flight runs when a real crash event reaches the installed guard", async () => {
    // Proves the hook is correct and guard-compatible: the real
    // `installProcessCrashGuard` invokes it for a real crash event, and marking
    // does not cost us the labelled exit. It does NOT prove the entrypoint
    // passes the hook — `installWorkerCrashGuard` below is what pins that.
    const marker = vi.fn(async () => ({ markedRunIds: ["run-a"] }));
    registerCrashTimeRunMarker(marker);
    const processRef = fakeProcess();
    const exit = vi.fn();
    const logger = { error: vi.fn(), flush: vi.fn() };

    installProcessCrashGuard({
      logger,
      onCrash: markInFlightRunsForWorkerCrash,
      exit,
      processRef,
    });
    processRef.emit("uncaughtException", new Error("null socket write"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(marker).toHaveBeenCalledExactlyOnceWith("uncaughtException: null socket write");
    // Marking must not cost us the deliberate labelled exit.
    expect(exit).toHaveBeenCalledWith(CRASH_GUARD_EXIT_CODE);
  });

  it("still exits when marking hangs past the guard's budget", async () => {
    // The database driver dying is the motivating crash, so the marker is
    // assumed to hang. A crash guard that can wedge converts a fast
    // crash-and-restart into a silent hang kubelet only catches at the liveness
    // probe — strictly worse than the bug it replaces.
    registerCrashTimeRunMarker(() => new Promise<{ markedRunIds: string[] }>(() => {}));
    const processRef = fakeProcess();
    const exit = vi.fn();

    installProcessCrashGuard({
      logger: { error: vi.fn(), flush: vi.fn() },
      onCrash: markInFlightRunsForWorkerCrash,
      exit,
      processRef,
      timeoutMs: 20,
    });
    processRef.emit("uncaughtException", new Error("db gone"));

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(CRASH_GUARD_EXIT_CODE));
  });
});

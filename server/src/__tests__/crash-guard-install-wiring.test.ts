import { describe, expect, it, vi } from "vitest";

// BLO-19722 AC 2/3. The one link the behavioural tests in
// crash-run-marking.test.ts cannot cover: that the worker's guard is actually
// *installed with* the marking hook. That test supplies `onCrash` itself, so it
// would keep passing if the entrypoint stopped passing one — which is precisely
// the failure that survived three review rounds (`markRunsInterruptedByWorkerCrash`
// fully tested, never called in production).
//
// Delete `onCrash` from `installWorkerCrashGuard` and this test fails while
// every other crash-guard and crash-marking test still passes.

const { installProcessCrashGuardMock } = vi.hoisted(() => ({
  installProcessCrashGuardMock: vi.fn(() =>
    Object.assign(() => {}, { waitForCrashExit: () => null }),
  ),
}));

vi.mock("../process-crash-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process-crash-guard.js")>();
  return { ...actual, installProcessCrashGuard: installProcessCrashGuardMock };
});

const { installWorkerCrashGuard, markInFlightRunsForWorkerCrash } = await import(
  "../crash-run-marking.js"
);

describe("installWorkerCrashGuard (BLO-19722 AC 2/3)", () => {
  it("installs the guard with crash-time run marking attached", () => {
    installWorkerCrashGuard();

    expect(installProcessCrashGuardMock).toHaveBeenCalledOnce();
    const options = installProcessCrashGuardMock.mock.calls[0]![0] as {
      onCrash?: unknown;
      logger?: unknown;
    };
    // Identity, not just "some function": a wrapper that forgot to await or
    // that dropped the context would satisfy a looser assertion.
    expect(options.onCrash).toBe(markInFlightRunsForWorkerCrash);
    // Without a logger the guard cannot record the crash it is exiting for.
    expect(options.logger).toBeDefined();
  });
});

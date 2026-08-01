/**
 * Out-of-process regression test for the crash guard's breadcrumb path
 * (BLO-20618, review round 6).
 *
 * The sibling `process-crash-guard.test.ts` drives the guard in-process with a
 * fake `EventEmitter` and a mocked `exit`. That is right for the control flow
 * (re-entrancy, timeout racing, cause chains) but structurally blind to the
 * defect this file exists for: whether the bytes reach the fd *before* the
 * process dies. A mocked `exit` never tears down the event loop, so an
 * asynchronous `process.stderr.write` always appears to succeed.
 *
 * So these tests spawn a real child with real piped stderr — the deployed
 * kubelet shape — let it really crash, and read what actually survived.
 *
 * Falsification: against the pre-fix `shutdown-log.ts` (which used
 * `process.stderr.write`) the padded cases fail, losing the trailing
 * `exiting 1 after uncaughtException` breadcrumb while the first short line
 * still lands. That asymmetry is why the bug survived two review rounds, and
 * it is the specific thing these assertions pin.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "crash-guard-exit-fixture.ts");
const tsx = path.resolve(here, "..", "..", "node_modules", ".bin", "tsx");

/** Enough to overrun the 64 KB pipe buffer several times over. */
const PIPE_PRESSURE_BYTES = 200_000;

interface CrashResult {
  code: number | null;
  stderr: string;
}

interface StalledCrashResult {
  code: number | null;
  elapsedMs: number;
}

function runFixture(kind: "throw" | "reject", padBytes: number): Promise<CrashResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsx, [fixture, kind, String(padBytes)], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr });
    });
  });
}

function runFixtureWithStalledStderr(): Promise<StalledCrashResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(tsx, [fixture, "throw", String(PIPE_PRESSURE_BYTES)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.pause();

    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("crash guard did not exit while stderr was stalled"));
    }, 2_000);

    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(watchdog);
      child.stderr.destroy();
      resolve({ code, elapsedMs: Date.now() - startedAt });
    });
  });
}

describe("process crash guard — real process exit", () => {
  it.each([
    ["uncaughtException", "throw"],
    ["unhandledRejection", "reject"],
  ] as const)("writes the breadcrumb, stack and exit line for %s", async (label, kind) => {
    const { code, stderr } = await runFixture(kind, 0);

    expect(code).toBe(1);
    expect(stderr).toContain(`[shutdown] ${label}: Error: BOOM_SENTINEL`);
    // The stack breadcrumb — the guard writes `causeChain[0].stack` separately.
    expect(stderr).toContain("crash-guard-exit-fixture.ts");
    expect(stderr).toContain(`[shutdown] exiting 1 after ${label}`);
  });

  it.each([
    ["uncaughtException", "throw"],
    ["unhandledRejection", "reject"],
  ] as const)(
    "does not drop the trailing breadcrumb for %s when the stack overruns the pipe buffer",
    async (label, kind) => {
      const { code, stderr } = await runFixture(kind, PIPE_PRESSURE_BYTES);

      expect(code).toBe(1);
      // Pre-fix this line landed (uv_try_write on an empty pipe) …
      expect(stderr).toContain(`[shutdown] ${label}: Error: BOOM_SENTINEL`);
      // … the padding filled the buffer …
      expect(stderr.length).toBeGreaterThan(PIPE_PRESSURE_BYTES);
      // … and this one was discarded by `process.exit`. It must survive now.
      expect(stderr).toContain(`[shutdown] exiting 1 after ${label}`);
    },
  );

  it("still exits when stderr is not drained", async () => {
    const { code, elapsedMs } = await runFixtureWithStalledStderr();

    expect(code).toBe(1);
    expect(elapsedMs).toBeLessThan(1_500);
  });
});

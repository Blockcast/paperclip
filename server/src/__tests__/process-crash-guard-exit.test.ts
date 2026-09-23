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
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "crash-guard-exit-fixture.ts");
const tsx = path.resolve(here, "..", "..", "node_modules", ".bin", "tsx");

/**
 * Padding for the *crash message*, to make the guard's breadcrumb writes large.
 * The three `runFixture` cases that pass it drain stderr, so they assert on content
 * rather than on the channel filling up, and this constant carries no backpressure
 * assumption. It used to be described as overrunning "the 64 KB pipe buffer":
 * `stdio: "pipe"` is really a unix socketpair sized by net.core.wmem_default (212992
 * by default), and betting a constant against that unknown is exactly what made the
 * stalled-stderr case flake (BLO-25854). The stalled case now fills until the stream
 * reports backpressure instead of guessing.
 */
const PIPE_PRESSURE_BYTES = 200_000;
/** Child startup is outside the measured crash deadline and can lag on loaded CI runners. */
const FIXTURE_STARTUP_TIMEOUT_MS = 10_000;
/**
 * Harness backstop for `runFixture`, never the thing under test: those tests assert
 * exit code and stderr content and never elapsed time, so unlike the stalled-exit
 * watchdog below this one competes with no assertion. It is derived rather than
 * literal because at a bare 5_000 it contradicted the constant directly above — this
 * budget spans spawn through child exit, a superset of the startup that
 * FIXTURE_STARTUP_TIMEOUT_MS already says can take 10s on a loaded runner, and it
 * additionally has to cover the crash and draining PIPE_PRESSURE_BYTES through the
 * stderr socket. Deriving it keeps the two watchdogs in this file from disagreeing
 * again about how slow a loaded runner is allowed to be.
 */
const FIXTURE_RUN_WATCHDOG_MS = FIXTURE_STARTUP_TIMEOUT_MS + 5_000;
/**
 * The behaviour under test: with stderr stalled, the guard must still exit this fast.
 * This is the contract — tighten or loosen it only when the guard's own deadline moves.
 *
 * Deliberately left at 1_500 by BLO-25854, which fixed the *other* failure signature on
 * this test and stopped short of this one. This bound spends only 30% of the guard's
 * DEFAULT_CRASH_GUARD_TIMEOUT_MS, and has been seen failing at 1547ms on a loaded
 * runner — a 3% overshoot against 70% unused budget. Deriving it from that constant is
 * the obvious repair, but a mutation test (deleting the `timer.unref()` early exit the
 * assertion exists to protect) failed through the startup watchdog rather than through
 * this assertion, so the re-derivation could not be shown to preserve what it catches.
 * Tracked as BLO-22985 (hardcoded wall-clock budgets under CI load) rather than changed
 * here on an unvalidated rationale.
 */
const STALLED_EXIT_DEADLINE_MS = 1_500;
/**
 * Harness backstop, never the thing under test. It must stay well clear of
 * STALLED_EXIT_DEADLINE_MS: a slow-but-working exit has to fail the assertion with a
 * measured elapsed time, not get SIGKILLed into "did not exit" — a claim this harness
 * cannot support, because it killed the child rather than watching it fail to die.
 * The startup watchdog next door needed 5x headroom for loaded runners; a deadline
 * measured on the same runners needs the same, and at 2s it had 500ms.
 */
const STALLED_EXIT_WATCHDOG_MS = STALLED_EXIT_DEADLINE_MS * 5;

interface CrashResult {
  code: number | null;
  stderr: string;
}

interface StalledCrashResult {
  code: number | null;
  elapsedMs: number;
}

function runFixture(kind: "throw" | "reject", padBytes: number, strictRejections = false): Promise<CrashResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsx, [fixture, kind, String(padBytes)], {
      env: strictRejections
        ? {
            ...process.env,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, "--unhandled-rejections=strict"].filter(Boolean).join(" "),
          }
        : process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `crash fixture (${kind}) had not exited ${FIXTURE_RUN_WATCHDOG_MS}ms after spawn ` +
            `(harness backstop; these tests assert output rather than timing, so the child was ` +
            `SIGKILLed here, not observed failing)`,
        ),
      );
    }, FIXTURE_RUN_WATCHDOG_MS);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(watchdog);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(watchdog);
      resolve({ code, stderr });
    });
  });
}

/**
 * Whatever the deliberately-undrained stderr pipe still holds now the child is gone.
 * Reading it earlier would drain the stall this test exists to create; discarding it
 * (what `child.stderr.destroy()` used to do on this path) is why five occurrences of
 * `fixture exited before reporting stderr backpressure` were unattributable.
 *
 * Stderr here is a socket, so `writeShutdownBreadcrumb` and
 * `writeShutdownBreadcrumbsBounded` fall through their `isRegularFile` guard to
 * `process.stderr.write`. Padding and breadcrumbs therefore share one stream and are
 * strictly FIFO behind it; they do not interleave. Behind a full socket, a breadcrumb
 * queued at crash time can be dropped at exit instead of landing after the padding.
 *
 * Keep both ends, not one: head and tail are both cheap context. Truncating to either
 * end alone was observed burying the one line that names the cause under the padding.
 */
function readRemainingStderr(stream: Readable): Promise<string> {
  return new Promise((done) => {
    let out = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(bail);
      stream.destroy();
      done(
        out.length > 2_000
          ? `${out.slice(0, 1_000)} …(${out.length} bytes, middle elided)… ${out.slice(-1_000)}`
          : out,
      );
    };
    const bail = setTimeout(finish, 1_000);
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      out += chunk;
    });
    stream.once("end", finish);
    stream.once("error", finish);
    stream.resume();
  });
}

function runFixtureWithStalledStderr(): Promise<StalledCrashResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsx, [fixture, "throw", "0", "prefill-stderr"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.pause();

    let startedAt: number | undefined;
    let watchdog: NodeJS.Timeout | undefined;
    const startupWatchdog = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("fixture did not observe stderr backpressure"));
    }, FIXTURE_STARTUP_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (startedAt !== undefined || !chunk.includes("BACKPRESSURE")) return;
      clearTimeout(startupWatchdog);
      startedAt = Date.now();
      watchdog = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(
            `crash guard had not exited ${STALLED_EXIT_WATCHDOG_MS}ms after the stall ` +
              `(harness backstop; the asserted deadline is ${STALLED_EXIT_DEADLINE_MS}ms)`,
          ),
        );
      }, STALLED_EXIT_WATCHDOG_MS);
      child.stdin.end("CRASH\n");
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(startupWatchdog);
      if (watchdog) clearTimeout(watchdog);
      if (startedAt === undefined) {
        void readRemainingStderr(child.stderr)
          .then((stderr) => {
            reject(
              new Error(
                `fixture exited before reporting stderr backpressure ` +
                  `(code=${code}, signal=${signal}); its stderr said: ${stderr.trim() || "<nothing>"}`,
              ),
            );
          })
          .catch(reject);
        return;
      }
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
    expect(elapsedMs).toBeLessThan(STALLED_EXIT_DEADLINE_MS);
  });

  it("flushes one complete crash record for a strict unhandled rejection", async () => {
    const { code, stderr } = await runFixture("reject", PIPE_PRESSURE_BYTES, true);

    expect(code).toBe(1);
    expect(stderr).toContain("[shutdown] unhandledRejection: Error: BOOM_SENTINEL");
    expect(stderr).toContain("[shutdown] exiting 1 after unhandledRejection");
    expect(stderr).not.toContain("crash-guard re-entered");
  });
});

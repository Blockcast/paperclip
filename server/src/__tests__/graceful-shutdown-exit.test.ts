import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "graceful-shutdown-exit-fixture.ts");
const tsx = path.resolve(here, "..", "..", "node_modules", ".bin", "tsx");
const serverRoot = path.resolve(here, "..", "..");

/**
 * Worst warm `tsx` start measured on a 4-CPU cgroup at the 128-spinner arm, rounded
 * (PEN-3381). Both watchdogs below cover the same operation this number was measured
 * against: spawning `tsx` on a fixture in this directory and waiting for its dependency
 * closure to load. The measurement lives in `process-crash-guard-exit.test.ts`, which
 * spawns the same binary on a sibling fixture:
 *
 *     spinners   warm start -> closure loaded (min / med / max)
 *            0       311ms /   331ms /   334ms
 *           24      2002ms /  2200ms /  3001ms
 *           48      8520ms / 10889ms / 14817ms
 *          128     13996ms / 18690ms / 23191ms
 *
 * It is COPIED rather than imported: a test file importing another test file's constant
 * couples two suites that vitest may shard onto different runners, and the value is a
 * measurement of the host, not of either file. If the measurement is ever retaken, both
 * copies move.
 */
const FIXTURE_WARM_START_CEILING_MS = 24_000;
/**
 * Multiple of that ceiling a contended runner is allowed. Bounded at the top by vitest's
 * `testTimeout` (60_000, `server/vitest.config.ts`; this file sets no per-test override):
 * the watchdog's entire value is producing an informative rejection, so if it passes that
 * timeout vitest kills the test first and the message never appears. At 1.5x it lands
 * 1.67x clear.
 */
const FIXTURE_WATCHDOG_HEADROOM = 1.5;
/**
 * Backstop for both child spawns, never the thing under test: these tests assert stdout
 * content, exit code and stderr length, and NEVER elapsed time, so this budget competes
 * with no assertion and headroom weakens no detector. It is also free on the passing
 * path -- both watchdogs are cleared by the child's `close` event, which in a green
 * whole-file run arrives in ~2s, so the budget is paid only on a run that is already
 * failing.
 *
 * It was a bare `5_000` until PEN-3381, which is 4.8x BELOW the ceiling above for the
 * same operation, and `graceful shutdown fixture timed out` duly failed shard 3/6 of
 * `General tests` on 2026-11-15T11:43Z (job 132786905615) on a dependabot PR that
 * touches no file under `server/`. The identical bare `5_000` was removed from
 * `process-crash-guard-exit.test.ts` for the identical reason; this file was missed.
 */
const FIXTURE_RUN_WATCHDOG_MS = FIXTURE_WARM_START_CEILING_MS * FIXTURE_WATCHDOG_HEADROOM;

describe("graceful shutdown — real process exit", () => {
  it("flushes the final breadcrumb through pressured piped stderr before exit", async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(tsx, [fixture], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const watchdog = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("graceful shutdown fixture timed out"));
      }, FIXTURE_RUN_WATCHDOG_MS);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(watchdog);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(watchdog);
        resolve({ code, stdout, stderr });
      });
    });

    expect(result.stdout).toContain("BACKPRESSURE");
    expect(result.code).toBe(0);
    expect(result.stderr.length).toBeGreaterThan(200_000);
    expect(result.stderr).toContain("[shutdown] handler complete; exiting (signal=SIGTERM)\n");
  });

  it("flushes a fatal record when the crash starts after the final shutdown breadcrumb", async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", fixture, "crash-during-shutdown"], {
        cwd: serverRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let signalSent = false;
      const watchdog = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("shutdown/crash race fixture timed out"));
      }, FIXTURE_RUN_WATCHDOG_MS);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (!signalSent && stdout.includes("READY")) {
          signalSent = true;
          child.kill("SIGTERM");
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(watchdog);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(watchdog);
        resolve({ code, stdout, stderr });
      });
    });

    expect(result.stdout).toContain("BACKPRESSURE");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("[shutdown] uncaughtException: Error: SHUTDOWN_CRASH_SENTINEL");
    expect(result.stderr).toContain("[shutdown] handler complete; exiting (signal=SIGTERM)\n");
    expect(result.stderr).toContain("[shutdown] exiting 1 after uncaughtException");
  });
});

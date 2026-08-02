/**
 * Real-process fixture for the final graceful-shutdown breadcrumb. The initial
 * write pressures piped stderr; awaiting the final write must preserve stream
 * ordering before the forced exit.
 */

import { writeShutdownBreadcrumbsBounded } from "../../shutdown-log.js";
import { installProcessCrashGuard } from "../../process-crash-guard.js";

if (process.argv[2] === "crash-during-shutdown") {
  const keepAlive = setInterval(() => {}, 60_000);

  const crashGuard = installProcessCrashGuard({
    logger: { error: () => {}, flush: () => {} },
    // Keep the crash path pending long enough for the graceful continuation to
    // reach its exit decision while the fatal record is still being flushed.
    onCrash: () => new Promise<void>(() => {}),
    timeoutMs: 200,
  });

  process.once("SIGTERM", () => {
    void (async () => {
      const accepted = process.stderr.write("P".repeat(200_000));
      process.stdout.write(accepted ? "NO_BACKPRESSURE\n" : "BACKPRESSURE\n");

      await writeShutdownBreadcrumbsBounded(["handler complete; exiting (signal=SIGTERM)"]);

      queueMicrotask(() => {
        throw new Error("SHUTDOWN_CRASH_SENTINEL");
      });

      // Mirrors pending instrumentation shutdown after the final graceful
      // breadcrumb. The crash starts during this await.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const crashExit = crashGuard.waitForCrashExit();
      if (crashExit) {
        await crashExit;
        return;
      }
      clearInterval(keepAlive);
      process.exit(process.exitCode ?? 0);
    })();
  });

  process.stdout.write("READY\n");
} else {
  const accepted = process.stderr.write("P".repeat(200_000));
  process.stdout.write(accepted ? "NO_BACKPRESSURE\n" : "BACKPRESSURE\n");

  await writeShutdownBreadcrumbsBounded(["handler complete; exiting (signal=SIGTERM)"]);
  process.exit(0);
}

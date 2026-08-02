/**
 * Real-process fixture for the final graceful-shutdown breadcrumb. The initial
 * write pressures piped stderr; awaiting the final write must preserve stream
 * ordering before the forced exit.
 */

import { writeShutdownBreadcrumbsBounded } from "../../shutdown-log.js";
import { installProcessCrashGuard } from "../../process-crash-guard.js";

if (process.argv[2] === "crash-during-shutdown") {
  const keepAlive = setInterval(() => {}, 60_000);

  installProcessCrashGuard({
    logger: { error: () => {}, flush: () => {} },
    // Keep the crash guard's final exit pending so the graceful continuation
    // wins the race. Its exit code must still reflect the fatal error.
    onCrash: () => new Promise<void>(() => {}),
  });

  process.once("SIGTERM", () => {
    void (async () => {
      const accepted = process.stderr.write("P".repeat(200_000));
      process.stdout.write(accepted ? "NO_BACKPRESSURE\n" : "BACKPRESSURE\n");

      queueMicrotask(() => {
        throw new Error("SHUTDOWN_CRASH_SENTINEL");
      });

      await writeShutdownBreadcrumbsBounded(["handler complete; exiting (signal=SIGTERM)"]);
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

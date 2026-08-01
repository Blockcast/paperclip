/**
 * Child-process fixture for `process-crash-guard-exit.test.ts`.
 *
 * Deliberately NOT a `*.test.ts` file — it is spawned as a real program so the
 * crash guard runs against a real `process.exit()` and a real piped stderr.
 * The in-process suite mocks `exit`, so it cannot observe whether breadcrumbs
 * actually survive the exit; that is the whole point of this fixture.
 *
 * argv[2] — crash kind: "throw" (uncaughtException) | "reject" (unhandledRejection)
 * argv[3] — bytes of padding to inflate the error message, and therefore the
 *           stack breadcrumb, past the 64 KB pipe buffer. Real postgres errors
 *           embed query text and get large; padding makes the pressure
 *           deterministic instead of hoping a stack is big enough.
 */

import { installProcessCrashGuard } from "../../process-crash-guard.js";

const kind = process.argv[2] ?? "throw";
const padBytes = Number(process.argv[3] ?? 0);

// A silent logger keeps stderr to breadcrumbs only, so the assertions pin the
// synchronous path rather than incidental pino output.
installProcessCrashGuard({
  logger: { error: () => {}, flush: () => {} },
});

const message = `BOOM_SENTINEL${padBytes > 0 ? ` ${"P".repeat(padBytes)}` : ""}`;

if (kind === "reject") {
  setImmediate(() => {
    void Promise.reject(new Error(message));
  });
} else {
  // `setImmediate` reproduces the shape of the production crash: a throw from a
  // macrotask with no frame of ours on the stack (postgres `nextWrite`).
  setImmediate(() => {
    throw new Error(message);
  });
}

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
 *           stack breadcrumb. Real postgres errors embed query text and get
 *           large; padding makes the pressure deterministic instead of hoping a
 *           stack is big enough.
 * argv[4] — "prefill-stderr" fills stderr until the stream reports backpressure,
 *           reports that on stdout, then waits for a parent ack on stdin before
 *           triggering the crash.
 */

import { installProcessCrashGuard } from "../../process-crash-guard.js";

const kind = process.argv[2] ?? "throw";
const padBytes = Number(process.argv[3] ?? 0);
const prefillStderr = process.argv[4] === "prefill-stderr";

// A silent logger keeps stderr to breadcrumbs only, so the assertions pin the
// synchronous path rather than incidental pino output.
installProcessCrashGuard({
  logger: { error: () => {}, flush: () => {} },
});

const message = `BOOM_SENTINEL${padBytes > 0 ? ` ${"P".repeat(padBytes)}` : ""}`;

function triggerCrash(): void {
  if (kind === "reject") {
    setImmediate(() => {
      void Promise.reject(new Error(message));
    });
    return;
  }

  // `setImmediate` reproduces the shape of the production crash: a throw from a
  // macrotask with no frame of ours on the stack (postgres `nextWrite`).
  setImmediate(() => {
    throw new Error(message);
  });
}

if (prefillStderr) {
  // Fill until the stream actually reports backpressure, rather than betting a
  // constant beats the buffer.
  //
  // `stdio: "pipe"` is a unix socketpair, not the 64 KB pipe this fixture used to
  // assume. `write()` returns false only when libuv's non-blocking writev cannot
  // take the WHOLE buffer at once, so what governs is the largest SINGLE write the
  // socket accepts — not its total capacity. Those are not the same number and not
  // close: measured on one host, single-write threshold ~146 KB against ~288 KB
  // cumulative. Re-deriving this by measuring capacity alone yields a figure over
  // 200 KB and the wrong conclusion that the old constant was safe.
  //
  // Both scale with the runner's net.core.wmem_default (212992 by default, higher on
  // tuned hosts). On a runner whose single-write threshold clears 200 KB, the old
  // `write("P".repeat(200_000))` was accepted, so this threw before stdout ever saw
  // BACKPRESSURE and the parent reported only "fixture exited before reporting
  // stderr backpressure" — reproduced exactly by lowering the constant under one
  // host's threshold. That is the whole of BLO-25854: a host-dependent buffer
  // assumption, not the CI-load race the issue was filed as. Looping removes the bet
  // rather than re-tuning it, so it holds whatever the host is tuned to.
  const CHUNK_BYTES = 64_000;
  const CEILING_BYTES = 8_000_000;
  let accepted = true;
  let written = 0;
  while (accepted && written < CEILING_BYTES) {
    accepted = process.stderr.write("P".repeat(CHUNK_BYTES));
    written += CHUNK_BYTES;
  }
  if (accepted) throw new Error(`stderr did not report backpressure after ${written} bytes`);

  // Do not let child exit race the parent's stdout listener. The ack arrives
  // only after the parent has observed backpressure and started its deadline.
  process.stdin.once("data", triggerCrash);
  process.stdout.write("BACKPRESSURE\n");
} else {
  triggerCrash();
}

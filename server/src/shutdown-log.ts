/**
 * Synchronous shutdown breadcrumbs.
 *
 * The SIGTERM handler in {@link ./index.ts} uses pino for everything else,
 * but pino runs an async transport — on `process.exit(0)` the queued log
 * lines can race libuv and be dropped before they reach kubelet. That race
 * was observed in production after BLO-4137 (PR #90): the drain code is
 * correct per its unit + integration tests, but the handler's own
 * `logger.info("Shutdown signal received…")` line stopped appearing in
 * `kubectl logs --previous`, leaving us unable to confirm from kubectl
 * alone that the handler was even invoked.
 *
 * **`process.stderr.write` does not provide that guarantee, and this module
 * used to claim it did.** Node's stream semantics are per-target: writes are
 * synchronous for files and for POSIX TTYs, but *asynchronous for pipes and
 * sockets on POSIX* — which is exactly what stderr is under kubelet. The
 * previous version of this comment asserted the opposite ("when stderr is
 * piped … libuv issues the write synchronously"), and every caller was
 * written against that false premise. `process.exit()` then "will force the
 * process to exit … even if there are still asynchronous operations pending,
 * including I/O operations to `process.stdout` and `process.stderr`", so a
 * breadcrumb written immediately before exit can be discarded.
 *
 * It is not theoretical, and it is nastier than a clean always-fails bug.
 * libuv attempts an eager `uv_try_write` first, so a short line into an empty
 * pipe usually does land — which is why this survived two review rounds. Once
 * the pipe backs up (a crashing worker spewing a stack, kubelet not draining
 * instantly) the remainder is queued and dropped. Measured on Node v24.16.0
 * with stderr piped: of three breadcrumbs totalling ~200 KB, the first landed
 * and the final `exiting 1 after uncaughtException` line was lost.
 *
 * So the breadcrumb goes through `fs.writeSync` on the raw stderr fd, which is
 * a real `write(2)` and has completed by the time it returns. Partial writes
 * are looped; `EAGAIN`/`EINTR` (stderr can be a non-blocking pipe) are retried
 * under a deadline. The deadline matters as much as the write: this is the
 * fatal path, and a breadcrumb that blocks forever on a full pipe would wedge
 * the crash handler — converting a fast crash-and-restart into a silent hang
 * that only the liveness probe catches. Losing the line is bad; hanging the
 * process to guarantee it is worse. On give-up we fall back to the async
 * `process.stderr.write`, which is no worse than the old behaviour.
 *
 * Pair with the existing `logger.info(...)` calls in the SIGTERM handler;
 * these are the "did we even get here" breadcrumbs, not a replacement for
 * structured logging.
 */

// Namespace import (not `import { writeSync }`) so the property is resolved at
// call time: the unit tests intercept the real syscall by spying on this
// object, rather than on a stream method that is no longer the sink.
import * as nodeFs from "node:fs";

/** POSIX `STDERR_FILENO`; used when `process.stderr.fd` is unavailable. */
const STDERR_FD = 2;

/**
 * Upper bound on how long one breadcrumb may block retrying a would-block fd.
 * Small on purpose — see the header: the crash path must stay bounded.
 */
const MAX_WRITE_WAIT_MS = 100;

/**
 * Genuinely synchronous sleep. `Atomics.wait` is permitted on Node's main
 * thread and yields the CPU, unlike a spin loop — which on a full pipe would
 * burn a core for the whole deadline while the reader tries to drain it.
 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable under some flags; fall through to retry */
  }
}

/**
 * Writes the whole buffer to `fd` with a real `write(2)`.
 *
 * Returns false rather than throwing: callers are mid-crash and a throw here
 * would cost them the very diagnosis this module exists to deliver.
 */
function writeAllSync(fd: number, text: string): boolean {
  const buf = Buffer.from(text, "utf8");
  const deadline = Date.now() + MAX_WRITE_WAIT_MS;
  let offset = 0;

  while (offset < buf.length) {
    try {
      // A short write is normal on a pipe near capacity, not an error.
      offset += nodeFs.writeSync(fd, buf, offset, buf.length - offset);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EAGAIN" && code !== "EINTR") return false;
      if (Date.now() >= deadline) return false;
      sleepSync(1);
    }
  }

  return true;
}

/**
 * Writes a single `[shutdown] <line>\n` breadcrumb to stderr synchronously.
 *
 * The `[shutdown]` prefix matches the existing `logShutdownSignal` line so
 * a single `kubectl logs … | grep '^\[shutdown\]'` recipe lists every
 * synchronous shutdown breadcrumb the handler emitted.
 */
export function writeShutdownBreadcrumb(line: string): void {
  const text = `[shutdown] ${line}\n`;
  const fd = typeof process.stderr?.fd === "number" ? process.stderr.fd : STDERR_FD;

  if (writeAllSync(fd, text)) return;

  // Degraded path: the fd would block past our deadline, or is not writable
  // as a raw fd at all. Queue it and hope — strictly no worse than the
  // behaviour this function replaced.
  try {
    process.stderr.write(text);
  } catch {
    /* stderr is gone; there is nothing left to say */
  }
}

/**
 * "Did we even enter the handler?" — the first breadcrumb the SIGTERM/SIGINT
 * handler writes. Kept as a named helper so callers don't have to assemble
 * the canonical line shape; tests + the BLO-4137 grep recipe pin the
 * format.
 */
export function logShutdownSignal(signal: NodeJS.Signals): void {
  writeShutdownBreadcrumb(`${signal} received — entering graceful drain`);
}

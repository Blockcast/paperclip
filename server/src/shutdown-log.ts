/**
 * Shutdown breadcrumbs with bounded fatal-path flushing.
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
 * A raw synchronous write is safe only when stderr is a regular file. A
 * blocking pipe/socket write cannot be bounded by a JavaScript deadline: the
 * event loop never regains control to check it. Pipe/socket breadcrumbs use
 * Node's non-blocking stream path instead. Fatal callers use the bounded async
 * helper below, which waits for the stream callback or a timer before exiting.
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

const MAX_WRITE_WAIT_MS = 100;

/**
 * Writes the whole buffer to `fd` with a real `write(2)`.
 *
 * Returns false rather than throwing: callers are mid-crash and a throw here
 * would cost them the very diagnosis this module exists to deliver.
 */
function writeAllSync(fd: number, text: string): boolean {
  const buf = Buffer.from(text, "utf8");
  let offset = 0;

  while (offset < buf.length) {
    try {
      const written = nodeFs.writeSync(fd, buf, offset, buf.length - offset);
      if (written <= 0) return false;
      offset += written;
    } catch {
      return false;
    }
  }

  return true;
}

function isRegularFile(fd: number): boolean {
  try {
    return nodeFs.fstatSync(fd).isFile();
  } catch {
    return false;
  }
}

/**
 * Writes a single `[shutdown] <line>\n` breadcrumb to stderr.
 *
 * Regular-file stderr is written synchronously. Pipe/socket stderr uses Node's
 * non-blocking stream path; fatal callers must use the bounded helper below.
 *
 * The `[shutdown]` prefix matches the existing `logShutdownSignal` line so
 * a single `kubectl logs … | grep '^\[shutdown\]'` recipe lists every
 * synchronous shutdown breadcrumb the handler emitted.
 */
export function writeShutdownBreadcrumb(line: string): void {
  const text = `[shutdown] ${line}\n`;
  const fd = typeof process.stderr?.fd === "number" ? process.stderr.fd : STDERR_FD;

  if (isRegularFile(fd) && writeAllSync(fd, text)) return;

  // Never issue a blocking raw write to a pipe or socket. Normal shutdown does
  // not force an immediate exit, so its stream write drains with the process.
  try {
    process.stderr.write(text);
  } catch {
    /* stderr is gone; there is nothing left to say */
  }
}

/**
 * Writes fatal-path breadcrumbs without allowing stalled stderr to stall exit.
 */
export function writeShutdownBreadcrumbsBounded(
  lines: string[],
  timeoutMs = MAX_WRITE_WAIT_MS,
): Promise<void> {
  const text = lines.map((line) => `[shutdown] ${line}\n`).join("");
  const fd = typeof process.stderr?.fd === "number" ? process.stderr.fd : STDERR_FD;

  if (isRegularFile(fd)) {
    writeAllSync(fd, text);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);

    try {
      process.stderr.write(text, finish);
    } catch {
      finish();
    }
  });
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

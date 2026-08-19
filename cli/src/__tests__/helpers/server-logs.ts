import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const SERVER_LOG_TAIL_BYTES = 8_000;

// Single source for a test server's log directory: the code that writes the
// server config points the server here, and the code that reports a startup
// failure reads it back. Deriving both from one function is the point -- a
// second path literal would let the reader drift away from the writer, and the
// symptom would be silent, because an empty log directory in a failure message
// reads exactly like "the server logged nothing".
export const serverLogDir = (tempRoot: string) => path.join(tempRoot, "logs");

/**
 * Read back what a spawned test server wrote to its log directory.
 *
 * Tests that boot a real server configure it with `logging.mode: "file"`, which
 * means the server's own diagnostics go to disk and NOT to the stdout/stderr the
 * test captures from the child process. A startup probe that fails therefore has
 * nothing useful to report -- and the temp dir holding the one artifact that
 * would explain the stall is deleted in `afterAll`. Every occurrence of such a
 * flake destroys its own evidence (BLO-28818).
 *
 * Never throws: this runs on a failure path, and a diagnostic that can mask the
 * real error with its own is worse than no diagnostic. A missing or empty log
 * directory is itself reported as a finding, since it distinguishes "the server
 * died before opening a log" from "the server was alive but silent".
 */
export function readServerLogTail(logDir: string, tailBytes = SERVER_LOG_TAIL_BYTES): string {
  let entries: string[];
  try {
    entries = readdirSync(logDir).sort();
  } catch (error) {
    return `(no server logs: ${logDir} unreadable: ${String(error)})`;
  }

  if (entries.length === 0) {
    return `(no server logs: ${logDir} exists but is empty -- the server never wrote a line)`;
  }

  return entries
    .map((entry) => {
      const file = path.join(logDir, entry);
      try {
        const body = readFileSync(file, "utf8");
        const tail = body.slice(-tailBytes);
        const elided =
          tail.length < body.length ? ` (last ${tail.length} of ${body.length} bytes)` : "";
        return `--- ${entry}${elided} ---\n${tail}`;
      } catch (error) {
        return `--- ${entry} (unreadable: ${String(error)}) ---`;
      }
    })
    .join("\n");
}

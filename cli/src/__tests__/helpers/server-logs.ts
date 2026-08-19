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

  // A zero budget must not mean "no limit". The obvious `slice(-tailBytes)`
  // spelling silently does exactly that, because `-0 === 0` and `s.slice(0)`
  // is the whole string -- so a caller asking for nothing would get the entire
  // log dumped into a failure message. Clamp, then index from the front.
  const budget = Math.max(1, tailBytes);

  return entries
    .map((entry) => {
      const file = path.join(logDir, entry);
      try {
        // Read as a Buffer and slice BYTES. Reading utf8 first would make the
        // budget count UTF-16 code units instead: the server logs through
        // pino-pretty, whose box glyphs ("◇ │ ✓ └") are 7 units but 15 bytes,
        // so a "8000 byte" cap could admit several times that and the byte
        // figures reported below would be wrong.
        const body = readFileSync(file);
        const start = Math.max(0, body.length - budget);
        // Slicing bytes can split a multi-byte character at the boundary; utf8
        // decoding renders that first partial char as U+FFFD. Acceptable for a
        // diagnostic tail, and honest -- the alternative is lying about size.
        const tail = body.subarray(start).toString("utf8");
        const elided = start > 0 ? ` (last ${body.length - start} of ${body.length} bytes)` : "";
        return `--- ${entry}${elided} ---\n${tail}`;
      } catch (error) {
        return `--- ${entry} (unreadable: ${String(error)}) ---`;
      }
    })
    .join("\n");
}

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readServerLogTail, serverLogDir } from "./helpers/server-logs.js";

// Guards the startup-failure diagnostic added for BLO-28818. This runs on a
// failure path that, by definition, only executes when something else already
// went wrong -- so it is never exercised by a green run, and a regression here
// would only surface as "the flake is still undiagnosable" months later.
describe("readServerLogTail", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "server-logs-test-"));
  });

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("derives the log directory from the temp root", () => {
    expect(serverLogDir("/tmp/example")).toBe(path.join("/tmp/example", "logs"));
  });

  it("reports a missing directory instead of throwing", () => {
    const missing = path.join(root, "never-created");

    // The whole point: a diagnostic that throws would replace the real failure
    // with its own, which is how you lose an incident twice.
    expect(() => readServerLogTail(missing)).not.toThrow();
    expect(readServerLogTail(missing)).toContain("no server logs");
    expect(readServerLogTail(missing)).toContain(missing);
  });

  it("distinguishes an empty log directory from a silent server", () => {
    const dir = path.join(root, "logs");
    mkdirSync(dir);

    // "Directory exists but is empty" and "server wrote nothing useful" are
    // different findings; collapsing them to a bare empty string is what made
    // the original failure unactionable.
    expect(readServerLogTail(dir)).toContain("exists but is empty");
  });

  it("reports a path that is a file rather than a directory", () => {
    const notADir = path.join(root, "logs");
    writeFileSync(notADir, "oops");

    expect(readServerLogTail(notADir)).toContain("unreadable");
  });

  it("includes every log file, in a stable order, with its contents", () => {
    const dir = path.join(root, "logs");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "b.log"), "second file body");
    writeFileSync(path.join(dir, "a.log"), "first file body");

    const report = readServerLogTail(dir);

    expect(report).toContain("first file body");
    expect(report).toContain("second file body");
    // Sorted, so a multi-file report reads the same way every time.
    expect(report.indexOf("a.log")).toBeLessThan(report.indexOf("b.log"));
  });

  it("keeps the TAIL when a log exceeds the byte budget, and says so", () => {
    const dir = path.join(root, "logs");
    mkdirSync(dir);
    // The tail is the half that matters: a stalled startup fails at the END of
    // whatever it managed to log.
    writeFileSync(path.join(dir, "server.log"), `${"o".repeat(50)}THE-LAST-LINE`);

    const report = readServerLogTail(dir, 13);

    expect(report).toContain("THE-LAST-LINE");
    expect(report).not.toContain("oooooooooo");
    expect(report).toContain("last 13 of 63 bytes");
  });

  it("does not claim truncation when the log fits", () => {
    const dir = path.join(root, "logs");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "server.log"), "short");

    const report = readServerLogTail(dir, 8_000);

    expect(report).toContain("short");
    expect(report).not.toContain("last ");
  });

  it("budgets in BYTES, not UTF-16 code units", () => {
    const dir = path.join(root, "logs");
    mkdirSync(dir);
    // The server logs through pino-pretty, whose box glyphs are 3 bytes each.
    // "◇◇◇◇TAIL" is 8 code units but 16 bytes, so a char-counting
    // implementation reads a 8-unit budget as "the whole thing fits" and
    // reports no truncation at all -- while silently admitting 2x the bytes
    // the caller asked for.
    writeFileSync(path.join(dir, "server.log"), "◇◇◇◇TAIL");

    const report = readServerLogTail(dir, 8);

    expect(report).toContain("TAIL");
    expect(report).toContain("last 8 of 16 bytes");
    // All four glyphs surviving would mean nothing was actually trimmed.
    expect(report).not.toContain("◇◇◇◇");
  });

  it("treats a zero budget as a floor, not as unlimited", () => {
    const dir = path.join(root, "logs");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "server.log"), "abcdef");

    // `slice(-0)` is `slice(0)` -- the whole string -- so the natural spelling
    // turns "give me nothing" into "give me everything", which is how a
    // failure message ends up carrying an entire log.
    const report = readServerLogTail(dir, 0);

    expect(report).not.toContain("abcdef");
    expect(report).toContain("last 1 of 6 bytes");
  });

  it("reports an unreadable entry without losing the readable ones", () => {
    const dir = path.join(root, "logs");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "a-server.log"), "readable body");
    // A directory entry, not a permission trick: `chmod 000` is still readable
    // as root, so it cannot exercise this branch in a container that runs as
    // uid 0. `readFileSync` on a directory throws EISDIR on every platform and
    // every uid -- and a rotated-log subdirectory is a plausible real layout.
    mkdirSync(path.join(dir, "b-rotated"));

    const report = readServerLogTail(dir);

    expect(report).toContain("readable body");
    expect(report).toContain("b-rotated");
    expect(report).toContain("unreadable");
    expect(report).toContain("EISDIR");
  });
});

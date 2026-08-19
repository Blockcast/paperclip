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
});

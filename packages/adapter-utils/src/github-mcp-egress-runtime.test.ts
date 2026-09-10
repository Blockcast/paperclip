import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { redactionMarker } from "./github-egress-scrub.js";
import { MAX_FRAME_BYTES, splitFrames, transformFrame } from "./github-mcp-egress-runtime.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeEntryPoint = path.join(sourceDirectory, "github-mcp-egress-runtime.ts");

// Derived, not literal — see the fixture note in github-mcp-egress-shim.test.ts
// on why a credential-shaped literal must not appear in a new commit, and the
// PEM_LABEL note there on why the PEM header in particular is assembled.
const PEM_LABEL = "RSA PRIVATE KEY";

const SYNTHETIC_PEM = [
  `-----BEGIN ${PEM_LABEL}-----`,
  Buffer.from("SYNTHETIC-NOT-A-REAL-KEY-".repeat(3), "utf8").toString("base64"),
  `-----END ${PEM_LABEL}-----`,
].join("\n");

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A stand-in for `github-mcp-server`: records every stdin frame it received to
 * a file, and writes one response frame so the response leg is exercised too.
 */
function makeFakeServer(): { server: string; record: string } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "paperclip-gh-mcp-egress-"));
  temporaryDirectories.push(directory);
  const server = path.join(directory, "fake-mcp-server.mjs");
  const record = path.join(directory, "received.txt");

  writeFileSync(
    server,
    [
      "import { appendFileSync } from 'node:fs';",
      "const record = process.argv[2];",
      "let buffer = '';",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk.toString('utf8');",
      "  let at;",
      "  while ((at = buffer.indexOf('\\n')) >= 0) {",
      "    appendFileSync(record, buffer.slice(0, at) + '\\n');",
      "    buffer = buffer.slice(at + 1);",
      "  }",
      "});",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) + '\\n');",
      "  process.exit(7);",
      "});",
    ].join("\n"),
    "utf8",
  );

  return { server, record };
}

function runRuntime(input: string): { record: string; status: number | null; stdout: string; stderr: string } {
  const { server, record } = makeFakeServer();
  writeFileSync(record, "", "utf8");

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", runtimeEntryPoint, process.execPath, server, record],
    { input, encoding: "utf8" },
  );

  return {
    record: readFileSync(record, "utf8"),
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("github MCP egress runtime", () => {
  describe("splitFrames", () => {
    it("splits complete lines and keeps the unterminated remainder", () => {
      expect(splitFrames('{"a":1}\n{"b":2}\n{"c":')).toEqual({
        lines: ['{"a":1}', '{"b":2}'],
        rest: '{"c":',
      });
    });

    it("returns no lines when no newline has arrived", () => {
      expect(splitFrames('{"partial"')).toEqual({ lines: [], rest: '{"partial"' });
    });

    it("yields an empty trailing remainder when the buffer ends on a newline", () => {
      expect(splitFrames('{"a":1}\n')).toEqual({ lines: ['{"a":1}'], rest: "" });
    });

    it("preserves empty frames rather than collapsing them", () => {
      expect(splitFrames("\n\n").lines).toEqual(["", ""]);
    });
  });

  describe("transformFrame", () => {
    it("re-appends exactly one newline to a clean frame", () => {
      const line = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
      const notify = [] as string[][];
      expect(transformFrame(line, { notify: (c) => notify.push([...c]) })).toBe(`${line}\n`);
      expect(notify).toEqual([]);
    });

    it("preserves a CRLF client's carriage return", () => {
      const line = '{"jsonrpc":"2.0","id":1,"method":"ping"}\r';
      expect(transformFrame(line, { notify: () => {} })).toBe(`${line}\n`);
    });

    it("notifies with CLASSES only, never the matched content", () => {
      const notified: string[][] = [];
      const line = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { arguments: { body: SYNTHETIC_PEM } },
      });

      const out = transformFrame(line, { notify: (classes) => notified.push([...classes]) });

      expect(notified).toEqual([["private-key-block"]]);
      expect(out).toContain(redactionMarker("private-key-block"));
      expect(out.endsWith("\n")).toBe(true);
    });

    it("keeps the frame delimiter intact when the redaction changes the payload length", () => {
      const line = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { arguments: { body: `before\n${SYNTHETIC_PEM}\nafter` } },
      });

      const out = transformFrame(line, { notify: () => {} });

      // Exactly one terminator, and no interior newline that would be read as
      // a second frame.
      expect(out.match(/\n/g)).toHaveLength(1);
      expect(out.endsWith("\n")).toBe(true);
    });
  });

  describe("end to end through a real child process", () => {
    it("delivers a clean frame byte-for-byte", () => {
      const line = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_me", arguments: {} },
      });

      const { record } = runRuntime(`${line}\n`);

      expect(record).toBe(`${line}\n`);
    });

    it("the server never sees credential material an agent wrote", () => {
      const line = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "add_issue_comment",
          arguments: { owner: "o", repo: "r", issue_number: 1, body: SYNTHETIC_PEM },
        },
      });

      const { record, stderr } = runRuntime(`${line}\n`);

      expect(record).not.toContain(PEM_LABEL);
      expect(record).toContain(redactionMarker("private-key-block"));
      // Still a single well-formed frame the server can parse.
      expect(record.trimEnd().split("\n")).toHaveLength(1);
      expect(JSON.parse(record.trimEnd())).toMatchObject({ id: 2, method: "tools/call" });
      // Audit signal names the class and nothing else.
      expect(stderr).toContain("private-key-block");
      expect(stderr).not.toContain(PEM_LABEL);
    });

    it("handles a frame split across stdin chunks", () => {
      // spawnSync hands the whole input at once, so exercise the buffering
      // boundary by sending two frames where the second is only completed by
      // the final newline.
      const first = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "a", params: {} });
      const second = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "b",
        params: { arguments: { body: SYNTHETIC_PEM } },
      });

      const { record } = runRuntime(`${first}\n${second}\n`);

      const lines = record.trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(first);
      expect(lines[1]).toContain(redactionMarker("private-key-block"));
    });

    it("drops an unterminated trailing fragment instead of forwarding a truncated message", () => {
      const complete = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "a", params: {} });

      const { record } = runRuntime(`${complete}\n{"jsonrpc":"2.0","id":2,"meth`);

      expect(record).toBe(`${complete}\n`);
    });

    it("propagates the server's exit code", () => {
      const { status } = runRuntime('{"jsonrpc":"2.0","id":1,"method":"a","params":{}}\n');
      expect(status).toBe(7);
    });

    it("passes the server's stdout through untouched", () => {
      // stdout is inherited, so the response leg does not enter this process.
      const { stdout } = runRuntime('{"jsonrpc":"2.0","id":1,"method":"a","params":{}}\n');
      expect(JSON.parse(stdout.trim())).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    });
  });

  describe("fail closed", () => {
    it("caps the unterminated buffer well above any legitimate frame", () => {
      // Guard the constant itself: a future edit that drops it to a plausible
      // payload size would start refusing real traffic.
      expect(MAX_FRAME_BYTES).toBeGreaterThanOrEqual(16 * 1024 * 1024);
    });

    it("refuses a frame it cannot walk rather than forwarding it", () => {
      let nested = '{"deep":1}';
      for (let i = 0; i < 260; i += 1) nested = `{"a":${nested}}`;

      const { record, status, stderr } = runRuntime(
        `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":${nested}}\n`,
      );

      expect(record).toBe("");
      expect(status).not.toBe(0);
      expect(stderr).toContain("refusing to forward it unscrubbed");
    });
  });
});

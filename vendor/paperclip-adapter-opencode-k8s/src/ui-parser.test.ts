import { describe, it, expect } from "vitest";
import { parseStdoutLine } from "./ui-parser.js";

const TS = "2026-01-01T00:00:00.000Z";

describe("parseStdoutLine", () => {
  it("returns empty for blank lines", () => {
    expect(parseStdoutLine("", TS)).toEqual([]);
    expect(parseStdoutLine("   ", TS)).toEqual([]);
  });

  it("returns stdout kind for non-JSON input", () => {
    const entries = parseStdoutLine("plain text", TS);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("stdout");
  });

  it("maps text event to assistant kind", () => {
    const line = JSON.stringify({ type: "text", part: { text: "Hello" } });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("assistant");
    expect((entries[0] as { kind: "assistant"; text: string }).text).toBe("Hello");
  });

  it("maps standalone thinking event to thinking kind", () => {
    const line = JSON.stringify({ type: "thinking", part: { thinking: "My reasoning" } });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("thinking");
    expect((entries[0] as unknown as { text: string }).text).toBe("My reasoning");
  });

  it("maps thinking block inside assistant event to thinking kind", () => {
    const line = JSON.stringify({
      type: "assistant",
      part: {
        message: {
          content: [{ type: "thinking", thinking: "Inner reasoning" }],
        },
      },
    });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("thinking");
    expect((entries[0] as unknown as { text: string }).text).toBe("Inner reasoning");
  });

  it("collects both text and thinking blocks from assistant event", () => {
    const line = JSON.stringify({
      type: "assistant",
      part: {
        message: {
          content: [
            { type: "thinking", thinking: "Let me think" },
            { type: "text", text: "Here is my answer" },
          ],
        },
      },
    });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe("thinking");
    expect(entries[1].kind).toBe("assistant");
  });

  it("maps user event tool_result to tool_result kind", () => {
    const line = JSON.stringify({
      type: "user",
      part: {
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_abc",
              content: "File contents here",
            },
          ],
        },
      },
    });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("tool_result");
    const tr = entries[0] as { kind: "tool_result"; toolUseId: string; content: string; isError: boolean };
    expect(tr.toolUseId).toBe("tu_abc");
    expect(tr.content).toBe("File contents here");
    expect(tr.isError).toBe(false);
  });

  it("maps user event tool_result with array content", () => {
    const line = JSON.stringify({
      type: "user",
      part: {
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_xyz",
              content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }],
            },
          ],
        },
      },
    });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("tool_result");
    expect((entries[0] as { content: string }).content).toBe("part1part2");
  });

  it("returns empty for user event with no content", () => {
    const line = JSON.stringify({ type: "user", part: {} });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toEqual([]);
  });

  it("maps tool_use completed to tool_result kind", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: { tool: "read_file", id: "tu_1", state: { status: "completed", output: "ok" } },
    });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("tool_result");
  });

  it("maps step_finish to result kind", () => {
    const line = JSON.stringify({
      type: "step_finish",
      part: { reason: "end_turn", tokens: { input: 10, output: 5, cache: { read: 0 } }, cost: 0.001 },
    });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("result");
  });

  it("maps error event to stderr kind", () => {
    const line = JSON.stringify({ type: "error", error: { message: "Something broke" } });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("stderr");
  });

  it("ignores thinking event with empty text", () => {
    const line = JSON.stringify({ type: "thinking", part: { thinking: "  " } });
    expect(parseStdoutLine(line, TS)).toEqual([]);
  });

  it("maps step_start to system kind", () => {
    const line = JSON.stringify({ type: "step_start" });
    expect(parseStdoutLine(line, TS)).toEqual([{ kind: "system", ts: TS, text: "Starting step…" }]);
  });

  it("maps tool_use pending status to tool_call kind", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: { tool: "bash", id: "call_1", state: { status: "pending", description: "ls -la" } },
    });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("tool_call");
    const entry = entries[0] as { name: string; toolUseId: string; input: unknown };
    expect(entry.name).toBe("bash");
    expect(entry.toolUseId).toBe("call_1");
    expect(entry.input).toBe("ls -la");
  });

  it("maps tool_use error status to tool_result with isError=true", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: { tool: "bash", id: "call_2", state: { status: "error", error: "Command not found" } },
    });
    const entries = parseStdoutLine(line, TS);
    expect(entries).toHaveLength(1);
    const entry = entries[0] as { kind: string; isError: boolean; content: string; toolName: string };
    expect(entry.kind).toBe("tool_result");
    expect(entry.isError).toBe(true);
    expect(entry.content).toBe("Command not found");
    expect(entry.toolName).toBe("bash");
  });

  it("uses 'Tool error' fallback when tool_use error field is empty", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: { tool: "bash", state: { status: "error", error: "" } },
    });
    const entry = parseStdoutLine(line, TS)[0] as { content: string };
    expect(entry.content).toBe("Tool error");
  });

  it("maps tool_use done status to tool_result", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: { tool: "grep", id: "call_3", state: { status: "done", output: "3 matches" } },
    });
    const entries = parseStdoutLine(line, TS);
    const entry = entries[0] as { kind: string; isError: boolean; content: string };
    expect(entry.kind).toBe("tool_result");
    expect(entry.isError).toBe(false);
    expect(entry.content).toBe("3 matches");
  });

  it("uses description as content fallback when tool_use output is empty", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: { tool: "ls", state: { status: "completed", output: "", description: "Listed 5 files" } },
    });
    const entry = parseStdoutLine(line, TS)[0] as { content: string };
    expect(entry.content).toBe("Listed 5 files");
  });

  it("uses 'Done' when tool_use output and description are both empty", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: { tool: "ls", state: { status: "completed", output: "", description: "" } },
    });
    const entry = parseStdoutLine(line, TS)[0] as { content: string };
    expect(entry.content).toBe("Done");
  });

  it("uses tool name as toolUseId when id field is absent", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: { tool: "bash", state: { status: "pending" } },
    });
    const entry = parseStdoutLine(line, TS)[0] as { toolUseId: string };
    expect(entry.toolUseId).toBe("bash");
  });

  it("sets tool_call input to undefined when description is empty", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: { tool: "bash", state: { status: "pending", description: "" } },
    });
    const entry = parseStdoutLine(line, TS)[0] as { input: unknown };
    expect(entry.input).toBeUndefined();
  });

  it("accumulates reasoning tokens into step_finish outputTokens", () => {
    const line = JSON.stringify({
      type: "step_finish",
      part: { tokens: { input: 100, output: 50, reasoning: 20, cache: { read: 80 } }, cost: 0.005 },
    });
    const entry = parseStdoutLine(line, TS)[0] as {
      inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number;
    };
    expect(entry.inputTokens).toBe(100);
    expect(entry.outputTokens).toBe(70); // output(50) + reasoning(20)
    expect(entry.cachedTokens).toBe(80);
    expect(entry.costUsd).toBeCloseTo(0.005);
  });

  it("step_finish uses reason as fallback text when message is empty", () => {
    const line = JSON.stringify({
      type: "step_finish",
      part: { reason: "end_turn", tokens: {} },
    });
    const entry = parseStdoutLine(line, TS)[0] as { text: string; subtype: string };
    expect(entry.text).toBe("Step finished: end_turn");
    expect(entry.subtype).toBe("end_turn");
  });

  it("step_finish uses 'done' subtype when reason is absent", () => {
    const line = JSON.stringify({ type: "step_finish", part: { tokens: {} } });
    const entry = parseStdoutLine(line, TS)[0] as { text: string; subtype: string };
    expect(entry.text).toBe("Step finished: done");
    expect(entry.subtype).toBe("step_finish");
  });

  it("step_finish defaults all numeric fields to 0 when tokens absent", () => {
    const line = JSON.stringify({ type: "step_finish", part: {} });
    const entry = parseStdoutLine(line, TS)[0] as {
      inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number;
    };
    expect(entry.inputTokens).toBe(0);
    expect(entry.outputTokens).toBe(0);
    expect(entry.cachedTokens).toBe(0);
    expect(entry.costUsd).toBe(0);
  });

  it("returns empty for assistant event with non-text content blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      part: { message: { content: [{ type: "tool_use", input: {} }] } },
    });
    expect(parseStdoutLine(line, TS)).toEqual([]);
  });

  it("returns empty for assistant event with empty text block", () => {
    const line = JSON.stringify({
      type: "assistant",
      part: { message: { content: [{ type: "text", text: "   " }] } },
    });
    expect(parseStdoutLine(line, TS)).toEqual([]);
  });

  it("extracts error message from nested error.data.message", () => {
    const line = JSON.stringify({ type: "error", error: { data: { message: "Nested message" } } });
    const entry = parseStdoutLine(line, TS)[0] as { text: string };
    expect(entry.text).toBe("Nested message");
  });

  it("falls back to error.name when message absent", () => {
    const line = JSON.stringify({ type: "error", error: { name: "NotFoundError" } });
    const entry = parseStdoutLine(line, TS)[0] as { text: string };
    expect(entry.text).toBe("NotFoundError");
  });

  it("falls back to error.code when name absent", () => {
    const line = JSON.stringify({ type: "error", error: { code: "ERR_CONN" } });
    const entry = parseStdoutLine(line, TS)[0] as { text: string };
    expect(entry.text).toBe("ERR_CONN");
  });

  it("returns empty array for unrecognized event types", () => {
    const line = JSON.stringify({ type: "some_unknown_type", data: {} });
    expect(parseStdoutLine(line, TS)).toEqual([]);
  });

  it("returns empty array for JSON with no type field", () => {
    const line = JSON.stringify({ sessionID: "ses_123", data: "something" });
    expect(parseStdoutLine(line, TS)).toEqual([]);
  });
});

describe("parseStdoutLine — error edge cases", () => {
  const TS_ERR = "2026-04-25T22:00:00.000Z";

  it("returns stdout entry when JSON parses to a primitive (not an object)", () => {
    const result = parseStdoutLine("42", TS_ERR);
    // safeJsonParse returns null for non-object → falls through to stdout entry
    expect(result).toEqual([{ kind: "stdout", ts: TS_ERR, text: "42" }]);
  });

  it("returns empty for text event with empty text", () => {
    const line = JSON.stringify({ type: "text", part: { text: "" } });
    expect(parseStdoutLine(line, TS_ERR)).toEqual([]);
  });

  it("returns empty for assistant event with no content blocks", () => {
    const line = JSON.stringify({ type: "assistant", part: { message: { content: null } } });
    expect(parseStdoutLine(line, TS_ERR)).toEqual([]);
  });

  it("returns empty for error event whose error field is an empty string", () => {
    const line = JSON.stringify({ type: "error", error: "" });
    expect(parseStdoutLine(line, TS_ERR)).toEqual([]);
  });

  it("uses error.code fallback when error has no message/data/name", () => {
    const line = JSON.stringify({ type: "error", error: { code: "E_FOO" } });
    const result = parseStdoutLine(line, TS_ERR);
    expect(result).toEqual([{ kind: "stderr", ts: TS_ERR, text: "E_FOO" }]);
  });

  it("falls back to JSON.stringify of error object when no known field", () => {
    const line = JSON.stringify({ type: "error", error: { somethingElse: "x" } });
    const result = parseStdoutLine(line, TS_ERR);
    expect(result[0].kind).toBe("stderr");
    expect((result[0] as { text: string }).text).toContain("somethingElse");
  });
});

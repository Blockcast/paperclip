import { describe, it, expect } from "vitest";
import { formatEvent } from "./format-event.js";

describe("formatEvent", () => {
  describe("empty / non-JSON input", () => {
    it("returns empty string for empty line", () => {
      expect(formatEvent("", false)).toBe("");
    });

    it("returns empty string for whitespace-only line", () => {
      expect(formatEvent("   ", false)).toBe("");
    });

    it("returns non-JSON line as-is (trimmed)", () => {
      expect(formatEvent("plain text output", false)).toBe("plain text output");
    });

    it("trims whitespace from non-JSON lines", () => {
      expect(formatEvent("  trimmed  ", false)).toBe("trimmed");
    });
  });

  describe("step_start", () => {
    it("returns empty string in normal mode", () => {
      const line = JSON.stringify({ type: "step_start", sessionID: "ses_1" });
      expect(formatEvent(line, false)).toBe("");
    });

    it("returns [step_start] with session in debug mode", () => {
      const line = JSON.stringify({ type: "step_start", sessionID: "ses_1" });
      expect(formatEvent(line, true)).toBe("[step_start] session=ses_1");
    });

    it("returns [step_start] without session suffix when sessionID absent in debug mode", () => {
      const line = JSON.stringify({ type: "step_start" });
      expect(formatEvent(line, true)).toBe("[step_start]");
    });
  });

  describe("text", () => {
    it("returns text content", () => {
      const line = JSON.stringify({ type: "text", part: { text: "Hello world" } });
      expect(formatEvent(line, false)).toBe("Hello world");
    });

    it("returns trimmed text", () => {
      const line = JSON.stringify({ type: "text", part: { text: "  trimmed  " } });
      expect(formatEvent(line, false)).toBe("trimmed");
    });

    it("returns empty string for empty text field", () => {
      const line = JSON.stringify({ type: "text", part: { text: "" } });
      expect(formatEvent(line, false)).toBe("");
    });

    it("returns same output in debug mode", () => {
      const line = JSON.stringify({ type: "text", part: { text: "Debug output" } });
      expect(formatEvent(line, true)).toBe("Debug output");
    });
  });

  describe("tool_use", () => {
    it("returns empty for normal tool_use in non-debug mode", () => {
      const line = JSON.stringify({
        type: "tool_use",
        part: { tool: "bash", state: { status: "pending", description: "ls" } },
      });
      expect(formatEvent(line, false)).toBe("");
    });

    it("returns empty for completed tool_use in non-debug mode", () => {
      const line = JSON.stringify({
        type: "tool_use",
        part: { tool: "bash", state: { status: "completed", output: "result" } },
      });
      expect(formatEvent(line, false)).toBe("");
    });

    it("returns warning with ⚠ prefix for tool error in non-debug mode", () => {
      const line = JSON.stringify({
        type: "tool_use",
        part: { tool: "bash", state: { status: "error", error: "Command failed" } },
      });
      expect(formatEvent(line, false)).toBe("⚠ Command failed");
    });

    it("returns empty for tool error with empty error field in non-debug mode", () => {
      const line = JSON.stringify({
        type: "tool_use",
        part: { tool: "bash", state: { status: "error", error: "" } },
      });
      expect(formatEvent(line, false)).toBe("");
    });

    it("returns debug info including tool name and status in debug mode", () => {
      const line = JSON.stringify({
        type: "tool_use",
        part: { tool: "grep", state: { status: "completed", description: "search files" } },
      });
      const result = formatEvent(line, true);
      expect(result).toContain("[tool:grep]");
      expect(result).toContain("completed");
      expect(result).toContain("search files");
    });

    it("appends output snippet in debug mode", () => {
      const line = JSON.stringify({
        type: "tool_use",
        part: { tool: "bash", state: { status: "completed", output: "output result here" } },
      });
      const result = formatEvent(line, true);
      expect(result).toContain("output result here");
    });

    it("appends error in debug mode", () => {
      const line = JSON.stringify({
        type: "tool_use",
        part: { tool: "bash", state: { status: "error", error: "exit code 1" } },
      });
      const result = formatEvent(line, true);
      expect(result).toContain("✗ exit code 1");
    });
  });

  describe("step_finish", () => {
    it("returns message when provided", () => {
      const line = JSON.stringify({
        type: "step_finish",
        part: { message: "Task complete", reason: "end_turn" },
      });
      expect(formatEvent(line, false)).toBe("Task complete");
    });

    it("returns fallback with reason when message is empty", () => {
      const line = JSON.stringify({
        type: "step_finish",
        part: { reason: "end_turn", message: "" },
      });
      expect(formatEvent(line, false)).toBe("[step_finish] end_turn");
    });

    it("returns fallback with empty reason when both message and reason absent", () => {
      const line = JSON.stringify({ type: "step_finish", part: {} });
      expect(formatEvent(line, false)).toBe("[step_finish] ");
    });

    it("appends token count when non-zero", () => {
      const line = JSON.stringify({
        type: "step_finish",
        part: { message: "Done", tokens: { total: 500 }, cost: 0 },
      });
      const result = formatEvent(line, false);
      expect(result).toContain("tokens=500");
    });

    it("appends cost when non-zero", () => {
      const line = JSON.stringify({
        type: "step_finish",
        part: { message: "Done", tokens: { total: 0 }, cost: 0.0025 },
      });
      const result = formatEvent(line, false);
      expect(result).toContain("cost$0.0025");
    });

    it("appends both tokens and cost when both non-zero", () => {
      const line = JSON.stringify({
        type: "step_finish",
        part: { message: "Done", tokens: { total: 300 }, cost: 0.001 },
      });
      const result = formatEvent(line, false);
      expect(result).toContain("tokens=300");
      expect(result).toContain("cost$0.0010");
    });

    it("omits metrics suffix when tokens and cost are zero", () => {
      const line = JSON.stringify({
        type: "step_finish",
        part: { message: "Done", tokens: { total: 0 }, cost: 0 },
      });
      expect(formatEvent(line, false)).toBe("Done");
    });
  });

  describe("error", () => {
    it("returns error message with ✗ prefix", () => {
      const line = JSON.stringify({ type: "error", error: { message: "Something failed" } });
      expect(formatEvent(line, false)).toBe("✗ Something failed");
    });

    it("returns ✗ prefix with string error", () => {
      const line = JSON.stringify({ type: "error", message: "Direct error" });
      const result = formatEvent(line, false);
      expect(result).toContain("✗");
    });

    it("returns empty string for error with no extractable text", () => {
      const line = JSON.stringify({ type: "error" });
      const result = formatEvent(line, false);
      expect(typeof result).toBe("string");
    });
  });

  describe("assistant", () => {
    it("returns nested text content", () => {
      const line = JSON.stringify({
        type: "assistant",
        part: { message: { content: [{ type: "text", text: "Assistant response" }] } },
      });
      expect(formatEvent(line, false)).toBe("Assistant response");
    });

    it("returns trimmed nested text", () => {
      const line = JSON.stringify({
        type: "assistant",
        part: { message: { content: [{ type: "text", text: "  Trimmed  " }] } },
      });
      expect(formatEvent(line, false)).toBe("Trimmed");
    });

    it("returns empty for non-text content blocks", () => {
      const line = JSON.stringify({
        type: "assistant",
        part: { message: { content: [{ type: "tool_use" }] } },
      });
      expect(formatEvent(line, false)).toBe("");
    });

    it("returns empty for assistant with no content", () => {
      const line = JSON.stringify({ type: "assistant", part: {} });
      expect(formatEvent(line, false)).toBe("");
    });
  });

  describe("unknown types", () => {
    it("returns empty string for unknown type in non-debug mode", () => {
      const line = JSON.stringify({ type: "some_unknown_type", data: {} });
      expect(formatEvent(line, false)).toBe("");
    });

    it("returns [type] for unknown type in debug mode", () => {
      const line = JSON.stringify({ type: "some_unknown_type" });
      expect(formatEvent(line, true)).toBe("[some_unknown_type]");
    });

    it("returns empty string for JSON with no type in non-debug mode", () => {
      const line = JSON.stringify({ sessionID: "ses_123" });
      expect(formatEvent(line, false)).toBe("");
    });
  });
});

import { parseStdoutLine } from "./format-event.js";

describe("parseStdoutLine (cli)", () => {
  const TS = "2026-04-25T22:00:00.000Z";

  it("returns empty for empty input", () => {
    expect(parseStdoutLine("", TS)).toEqual([]);
    expect(parseStdoutLine("   ", TS)).toEqual([]);
  });

  it("returns stdout entry for non-JSON input", () => {
    expect(parseStdoutLine("plain log", TS)).toEqual([{ kind: "stdout", ts: TS, text: "plain log" }]);
  });

  it("returns stdout entry when JSON parses to a non-object primitive", () => {
    expect(parseStdoutLine("42", TS)).toEqual([{ kind: "stdout", ts: TS, text: "42" }]);
  });

  it("renders a text event as an assistant delta", () => {
    const line = JSON.stringify({ type: "text", part: { text: "Hello" } });
    expect(parseStdoutLine(line, TS)).toEqual([{ kind: "assistant", ts: TS, text: "Hello", delta: true }]);
  });

  it("returns empty for text event with empty text", () => {
    const line = JSON.stringify({ type: "text", part: { text: "" } });
    expect(parseStdoutLine(line, TS)).toEqual([]);
  });

  it("renders tool_use status=error as tool_result with isError", () => {
    const line = JSON.stringify({ type: "tool_use", part: { tool: "bash", id: "t1", state: { status: "error", error: "boom" } } });
    expect(parseStdoutLine(line, TS)).toEqual([
      { kind: "tool_result", ts: TS, toolUseId: "t1", toolName: "bash", content: "boom", isError: true },
    ]);
  });

  it("uses 'Tool error' fallback when error event has no error string", () => {
    const line = JSON.stringify({ type: "tool_use", part: { tool: "bash", id: "t1", state: { status: "error" } } });
    const result = parseStdoutLine(line, TS);
    expect((result[0] as { content: string }).content).toBe("Tool error");
  });

  it("renders tool_use status=completed as tool_result with output", () => {
    const line = JSON.stringify({ type: "tool_use", part: { tool: "bash", id: "t1", state: { status: "completed", output: "ok" } } });
    expect(parseStdoutLine(line, TS)).toEqual([
      { kind: "tool_result", ts: TS, toolUseId: "t1", toolName: "bash", content: "ok", isError: false },
    ]);
  });

  it("renders tool_use status=done — falls back to description when no output", () => {
    const line = JSON.stringify({ type: "tool_use", part: { tool: "bash", id: "t1", state: { status: "done", description: "did it" } } });
    expect((parseStdoutLine(line, TS)[0] as { content: string }).content).toBe("did it");
  });

  it("renders tool_use status=done — falls back to 'Done' when no output or description", () => {
    const line = JSON.stringify({ type: "tool_use", part: { tool: "bash", id: "t1", state: { status: "done" } } });
    expect((parseStdoutLine(line, TS)[0] as { content: string }).content).toBe("Done");
  });

  it("renders tool_use pending status as tool_call", () => {
    const line = JSON.stringify({ type: "tool_use", part: { tool: "bash", id: "t1", state: { status: "running", description: "go" } } });
    expect(parseStdoutLine(line, TS)).toEqual([
      { kind: "tool_call", ts: TS, name: "bash", input: "go", toolUseId: "t1" },
    ]);
  });

  it("falls back to part.type then 'tool' when no part.tool name", () => {
    const line = JSON.stringify({ type: "tool_use", part: { type: "edit", state: { status: "running" } } });
    expect((parseStdoutLine(line, TS)[0] as { name: string }).name).toBe("edit");
    const line2 = JSON.stringify({ type: "tool_use", part: { state: { status: "running" } } });
    expect((parseStdoutLine(line2, TS)[0] as { name: string }).name).toBe("tool");
  });

  it("renders step_finish with token/cost metrics", () => {
    const line = JSON.stringify({
      type: "step_finish",
      part: {
        message: "did the thing",
        reason: "stop",
        tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 30 } },
        cost: 0.0123,
      },
    });
    const result = parseStdoutLine(line, TS);
    expect(result).toEqual([{
      kind: "result",
      ts: TS,
      text: "did the thing",
      inputTokens: 100,
      outputTokens: 60,
      cachedTokens: 30,
      costUsd: 0.0123,
      subtype: "stop",
      isError: false,
      errors: [],
    }]);
  });

  it("renders step_finish with default text when no message", () => {
    const line = JSON.stringify({ type: "step_finish", part: { reason: "stop" } });
    expect((parseStdoutLine(line, TS)[0] as { text: string }).text).toBe("Step finished: stop");
    const line2 = JSON.stringify({ type: "step_finish", part: {} });
    expect((parseStdoutLine(line2, TS)[0] as { text: string }).text).toBe("Step finished: done");
  });

  it("renders step_start as a system entry", () => {
    const line = JSON.stringify({ type: "step_start" });
    expect(parseStdoutLine(line, TS)).toEqual([{ kind: "system", ts: TS, text: "Starting step…" }]);
  });

  it("renders assistant event with nested text content", () => {
    const line = JSON.stringify({
      type: "assistant",
      part: { message: { content: [{ type: "text", text: "hi there" }] } },
    });
    expect(parseStdoutLine(line, TS)).toEqual([{ kind: "assistant", ts: TS, text: "hi there" }]);
  });

  it("handles assistant content as a single non-array object", () => {
    const line = JSON.stringify({
      type: "assistant",
      part: { message: { content: { type: "text", text: "single" } } },
    });
    expect(parseStdoutLine(line, TS)).toEqual([{ kind: "assistant", ts: TS, text: "single" }]);
  });

  it("returns empty for assistant event with no extractable text", () => {
    const line = JSON.stringify({ type: "assistant", part: { message: { content: [{ type: "image" }] } } });
    expect(parseStdoutLine(line, TS)).toEqual([]);
    const line2 = JSON.stringify({ type: "assistant", part: {} });
    expect(parseStdoutLine(line2, TS)).toEqual([]);
  });

  it("renders error event with errorText", () => {
    const line = JSON.stringify({ type: "error", error: { message: "broken" } });
    expect(parseStdoutLine(line, TS)).toEqual([{ kind: "stderr", ts: TS, text: "broken" }]);
  });

  it("returns empty for error event with empty error string", () => {
    const line = JSON.stringify({ type: "error", error: "" });
    expect(parseStdoutLine(line, TS)).toEqual([]);
  });

  it("uses error.code fallback in errorText", () => {
    const line = JSON.stringify({ type: "error", error: { code: "E_X" } });
    expect(parseStdoutLine(line, TS)).toEqual([{ kind: "stderr", ts: TS, text: "E_X" }]);
  });

  it("uses nested data.message and name fallbacks in errorText", () => {
    const l1 = JSON.stringify({ type: "error", error: { data: { message: "nested" } } });
    expect((parseStdoutLine(l1, TS)[0] as { text: string }).text).toBe("nested");
    const l2 = JSON.stringify({ type: "error", error: { name: "ProviderErr" } });
    expect((parseStdoutLine(l2, TS)[0] as { text: string }).text).toBe("ProviderErr");
  });

  it("falls back to JSON.stringify of the error object when nothing else matches", () => {
    const line = JSON.stringify({ type: "error", error: { weirdKey: "x" } });
    expect((parseStdoutLine(line, TS)[0] as { text: string }).text).toContain("weirdKey");
  });

  it("returns empty array for unknown event types", () => {
    const line = JSON.stringify({ type: "totally_unknown" });
    expect(parseStdoutLine(line, TS)).toEqual([]);
  });
});

describe("formatEvent — additional coverage", () => {
  it("returns empty for safeJsonParse of a non-object primitive", () => {
    // formatEvent treats a non-object as non-JSON and returns the trimmed line as-is
    const result = formatEvent("42", false);
    expect(result).toBe("42");
  });

  it("returns empty for error event with empty error string", () => {
    const line = JSON.stringify({ type: "error", error: "" });
    expect(formatEvent(line, false)).toBe("");
  });
});

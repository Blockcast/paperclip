/**
 * Self-contained stdout parser for OpenCode JSONL output.
 * Zero external imports — required by the Paperclip adapter plugin UI parser contract.
 *
 * Maps OpenCode event types to rich TranscriptEntry kinds so the Paperclip UI
 * renders structured assistant messages, tool calls, results, etc. instead of
 * plain stdout text.
 */

type TranscriptEntry =
  | { kind: "assistant"; ts: string; text: string; delta?: boolean }
  | { kind: "thinking"; ts: string; text: string }
  | { kind: "tool_call"; ts: string; name: string; input: unknown; toolUseId?: string }
  | { kind: "tool_result"; ts: string; toolUseId: string; toolName?: string; content: string; isError: boolean }
  | { kind: "result"; ts: string; text: string; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number; subtype: string; isError: boolean; errors: string[] }
  | { kind: "system"; ts: string; text: string }
  | { kind: "stderr"; ts: string; text: string }
  | { kind: "stdout"; ts: string; text: string };

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  return fallback;
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = asRecord(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

/**
 * Parse a single stdout line into transcript entries for UI display.
 * This is the Paperclip UI parser contract.
 */
export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  const event = safeJsonParse(trimmed);
  if (!event) {
    // Non-JSON — treat as raw stdout (e.g. K8s pod lifecycle messages)
    return [{ kind: "stdout", ts, text: trimmed }];
  }

  const type = asString(event.type, "");
  const part = asRecord(event.part ?? {});

  // Assistant text fragments — render as assistant chat bubbles
  if (type === "text") {
    const text = asString(part.text, "");
    if (text) return [{ kind: "assistant", ts, text, delta: true }];
    return [];
  }

  // Tool use events — map to tool_call / tool_result depending on status
  if (type === "tool_use") {
    const toolName = asString(part.tool, "") || asString(part.type, "tool");
    const state = asRecord(part.state ?? {});
    const status = asString(state.status, "");
    const toolUseId = asString(part.id ?? part.toolUseId ?? "", "") || toolName;
    const description = asString(state.description, "").trim();

    if (status === "error") {
      const err = asString(state.error, "").trim();
      return [{
        kind: "tool_result",
        ts,
        toolUseId,
        toolName,
        content: err || "Tool error",
        isError: true,
      }];
    }

    if (status === "completed" || status === "done") {
      const output = asString(state.output, "").trim();
      return [{
        kind: "tool_result",
        ts,
        toolUseId,
        toolName,
        content: output || description || "Done",
        isError: false,
      }];
    }

    // pending / running / other — show as a tool call invocation
    const input = description || undefined;
    return [{ kind: "tool_call", ts, name: toolName, input, toolUseId }];
  }

  // Step finish — render as a structured result with token/cost metrics
  if (type === "step_finish") {
    const message = asString(part.message, "").trim();
    const reason = asString(part.reason, "");
    const tokens = asRecord(part.tokens ?? {});
    const cache = asRecord(tokens.cache ?? {});
    const inputTokens = asNumber(tokens.input, 0);
    const outputTokens = asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
    const cachedTokens = asNumber(cache.read, 0);
    const costUsd = asNumber(part.cost, 0);

    return [{
      kind: "result",
      ts,
      text: message || `Step finished: ${reason || "done"}`,
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd,
      subtype: reason || "step_finish",
      isError: false,
      errors: [],
    }];
  }

  // Step start — render as system message
  if (type === "step_start") {
    return [{ kind: "system", ts, text: "Starting step…" }];
  }

  // Standalone thinking event (extended reasoning)
  if (type === "thinking") {
    const text = asString(part.thinking ?? part.text, "").trim();
    if (text) return [{ kind: "thinking", ts, text }];
    return [];
  }

  // Assistant message (nested content blocks — text and thinking)
  if (type === "assistant") {
    const content = part.message ?? part;
    const contentRecord = asRecord(content);
    if (contentRecord.content) {
      const contentArr = Array.isArray(contentRecord.content)
        ? contentRecord.content
        : [contentRecord.content];
      const entries: TranscriptEntry[] = [];
      for (const item of contentArr) {
        const itemRecord = asRecord(item);
        if (itemRecord.type === "text" && typeof itemRecord.text === "string") {
          const text = (itemRecord.text as string).trim();
          if (text) entries.push({ kind: "assistant", ts, text });
        } else if (itemRecord.type === "thinking" && typeof itemRecord.thinking === "string") {
          const text = (itemRecord.thinking as string).trim();
          if (text) entries.push({ kind: "thinking", ts, text });
        }
      }
      return entries;
    }
    return [];
  }

  // User turn — surface tool_result blocks so they appear in the transcript
  if (type === "user") {
    const content = part.message ?? part;
    const contentRecord = asRecord(content);
    if (contentRecord.content) {
      const contentArr = Array.isArray(contentRecord.content)
        ? contentRecord.content
        : [contentRecord.content];
      const entries: TranscriptEntry[] = [];
      for (const item of contentArr) {
        const itemRecord = asRecord(item);
        if (itemRecord.type === "tool_result") {
          const toolUseId = asString(itemRecord.tool_use_id ?? itemRecord.toolUseId ?? "", "");
          const contentVal = itemRecord.content;
          let resultText = "";
          if (typeof contentVal === "string") {
            resultText = contentVal.trim();
          } else if (Array.isArray(contentVal)) {
            resultText = contentVal
              .map((c) => asString(asRecord(c).text, ""))
              .join("")
              .trim();
          }
          if (toolUseId || resultText) {
            entries.push({
              kind: "tool_result",
              ts,
              toolUseId: toolUseId || "unknown",
              content: resultText,
              isError: false,
            });
          }
        }
      }
      return entries;
    }
    return [];
  }

  // Error events
  if (type === "error") {
    const text = errorText(event.error ?? event.message ?? event).trim();
    if (text) return [{ kind: "stderr", ts, text }];
    return [];
  }

  return [];
}

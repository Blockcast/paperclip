import { describe, it, expect } from "vitest";
import {
  parseClaudeStreamJson,
  extractClaudeLoginUrl,
  detectClaudeLoginRequired,
  describeClaudeFailure,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
  isClaudeImmutableThinkingBlockError,
  isClaudeTransientUpstreamError,
  matchClaudeUpstreamCapacityCode,
  classifyClaudeUpstreamFailure,
  isClaudeSkillNotFoundStartupFailure,
  extractClaudeRetryNotBefore,
} from "./parse.js";

describe("parseClaudeStreamJson", () => {
  it("returns empty result for blank input", () => {
    const result = parseClaudeStreamJson("");
    expect(result.sessionId).toBeNull();
    expect(result.model).toBe("");
    expect(result.costUsd).toBeNull();
    expect(result.usage).toBeNull();
    expect(result.summary).toBe("");
    expect(result.resultJson).toBeNull();
  });

  it("returns empty result for non-JSON lines", () => {
    const result = parseClaudeStreamJson("hello world\nnot json\n");
    expect(result.summary).toBe("");
    expect(result.resultJson).toBeNull();
  });

  it("parses system/init event for sessionId and model", () => {
    const stdout = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "sess_abc123",
      model: "claude-opus-4-6",
    });
    const result = parseClaudeStreamJson(stdout);
    expect(result.sessionId).toBe("sess_abc123");
    expect(result.model).toBe("claude-opus-4-6");
  });

  it("parses assistant text blocks", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        session_id: "sess_abc",
        message: { content: [{ type: "text", text: "Hello" }] },
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "sess_abc",
        message: { content: [{ type: "text", text: " world" }] },
      }),
    ].join("\n");
    const result = parseClaudeStreamJson(lines);
    expect(result.summary).toBe("Hello\n\n world");
  });

  it("parses thinking blocks", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "Let me think..." }] },
      }),
    ].join("\n");
    const result = parseClaudeStreamJson(lines);
    // thinking is not included in summary
    expect(result.summary).toBe("");
  });

  it("parses tool_use blocks without crashing", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            name: "Bash",
            input: { command: "ls" },
            id: "tool_123",
          }],
        },
      }),
    ].join("\n");
    const result = parseClaudeStreamJson(lines);
    expect(result.resultJson).toBeNull(); // no result event yet
  });

  it("parses result event with usage and cost", () => {
    const lines = [
      JSON.stringify({
        type: "result",
        session_id: "sess_abc",
        result: "Done",
        subtype: "stop",
        total_cost_usd: 0.005,
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_read_input_tokens: 50,
        },
      }),
    ].join("\n");
    const result = parseClaudeStreamJson(lines);
    expect(result.sessionId).toBe("sess_abc");
    expect(result.costUsd).toBe(0.005);
    expect(result.resultJson).not.toBeNull();
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.outputTokens).toBe(200);
    expect(result.usage?.cachedInputTokens).toBe(50);
  });

  it("returns null cost for non-finite total_cost_usd", () => {
    const lines = [
      JSON.stringify({
        type: "result",
        total_cost_usd: Infinity,
        result: "Done",
      }),
    ].join("\n");
    const result = parseClaudeStreamJson(lines);
    expect(result.costUsd).toBeNull();
  });

  it("falls back to assistant texts when no result event", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Some output" }] },
      }),
    ].join("\n");
    const result = parseClaudeStreamJson(lines);
    expect(result.summary).toBe("Some output");
    expect(result.resultJson).toBeNull();
  });

  it("handles mixed JSON and non-JSON lines", () => {
    const lines = `some raw output
${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "JSON output" }] } })}
more raw output`;
    const result = parseClaudeStreamJson(lines);
    // Non-JSON lines don't contribute to summary; only parsed JSON content does
    expect(result.summary).toContain("JSON output");
    expect(result.summary).not.toContain("some raw output");
  });

  it("deduplicates identical assistant text blocks from reconnect replays", () => {
    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    });
    // Simulate the same assistant event appearing twice (log stream reconnect replay)
    const stdout = `${assistantEvent}\n${assistantEvent}\n`;
    const result = parseClaudeStreamJson(stdout);
    expect(result.summary).toBe("Hello world");
    // Should not be "Hello world\n\nHello world"
    expect(result.summary.split("Hello world").length).toBe(2);
  });

  it("sets llmApiEmptyResponse=true when stop_reason:null and usage.output_tokens:0", () => {
    const initLine = JSON.stringify({ type: "system", subtype: "init", model: "MiniMax-M2.7", session_id: "sess_1" });
    const assistantEvent = JSON.stringify({
      type: "assistant",
      session_id: "sess_1",
      message: {
        id: "msg_abc",
        stop_reason: null,
        usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        content: [],
      },
    });
    const result = parseClaudeStreamJson([initLine, assistantEvent].join("\n"));
    expect(result.llmApiEmptyResponse).toBe(true);
    expect(result.resultJson).toBeNull();
  });

  it("sets llmApiEmptyResponse=true when stop_reason:null and message-level output_tokens:0", () => {
    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: { stop_reason: null, output_tokens: 0, content: [] },
    });
    const result = parseClaudeStreamJson(assistantEvent);
    expect(result.llmApiEmptyResponse).toBe(true);
  });

  it("does not set llmApiEmptyResponse when stop_reason is non-null", () => {
    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: {
        stop_reason: "end_turn",
        usage: { output_tokens: 0 },
        content: [],
      },
    });
    const result = parseClaudeStreamJson(assistantEvent);
    expect(result.llmApiEmptyResponse).toBe(false);
  });

  it("does not set llmApiEmptyResponse when output_tokens > 0", () => {
    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: {
        stop_reason: null,
        usage: { output_tokens: 5 },
        content: [{ type: "text", text: "hello" }],
      },
    });
    const result = parseClaudeStreamJson(assistantEvent);
    expect(result.llmApiEmptyResponse).toBe(false);
  });

  it("clears llmApiEmptyResponse when a result event follows the empty assistant event", () => {
    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: { stop_reason: null, usage: { output_tokens: 0 }, content: [] },
    });
    const resultEvent = JSON.stringify({
      type: "result",
      result: "Done",
      subtype: "stop",
      total_cost_usd: 0.001,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
    });
    const result = parseClaudeStreamJson([assistantEvent, resultEvent].join("\n"));
    expect(result.llmApiEmptyResponse).toBe(false);
    expect(result.resultJson).not.toBeNull();
  });

  it("sets truncatedMidStream=true when assistant event with output_tokens>0 has no result (FAR-95)", () => {
    const initLine = JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-7", session_id: "sess_1" });
    const assistantEvent = JSON.stringify({
      type: "assistant",
      session_id: "sess_1",
      message: {
        id: "msg_abc",
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 35, cache_creation_input_tokens: 523, cache_read_input_tokens: 46295 },
        content: [{ type: "tool_use", id: "tool_1", name: "Bash", input: { command: "echo hi" } }],
      },
    });
    const result = parseClaudeStreamJson([initLine, assistantEvent].join("\n"));
    expect(result.truncatedMidStream).toBe(true);
    expect(result.llmApiEmptyResponse).toBe(false);
    expect(result.resultJson).toBeNull();
  });

  it("clears truncatedMidStream when a result event follows assistant content", () => {
    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: { stop_reason: null, usage: { output_tokens: 35 }, content: [] },
    });
    const resultEvent = JSON.stringify({
      type: "result",
      result: "Done",
      subtype: "stop",
      total_cost_usd: 0.001,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
    });
    const result = parseClaudeStreamJson([assistantEvent, resultEvent].join("\n"));
    expect(result.truncatedMidStream).toBe(false);
    expect(result.resultJson).not.toBeNull();
  });

  it("does not set truncatedMidStream when assistant has output_tokens=0", () => {
    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: { stop_reason: null, usage: { output_tokens: 0 }, content: [] },
    });
    const result = parseClaudeStreamJson(assistantEvent);
    expect(result.truncatedMidStream).toBe(false);
  });

  it("sets llmApiEmptyResponse=false for normal result", () => {
    const resultEvent = JSON.stringify({
      type: "result",
      result: "Done",
      subtype: "stop",
      total_cost_usd: 0.005,
      usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 50 },
    });
    const result = parseClaudeStreamJson(resultEvent);
    expect(result.llmApiEmptyResponse).toBe(false);
  });
});

describe("isClaudeTransientUpstreamError", () => {
  it("classifies malformed HTTP 200 API responses as transient upstream", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "API Error: API returned an empty or malformed response (HTTP 200)",
        },
      }),
    ).toBe(true);
  });

  it("does not classify deterministic Claude failures as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: { result: "Please log in. Run `claude login` first." },
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          result:
            "API Error: 400 messages.65.content.172: `thinking` blocks in the latest assistant message cannot be modified.",
        },
      }),
    ).toBe(false);
  });
});

describe("matchClaudeUpstreamCapacityCode", () => {
  it("returns the penstock exhaustion code from Claude's embedded provider JSON", () => {
    expect(
      matchClaudeUpstreamCapacityCode({
        parsed: {
          type: "result",
          is_error: true,
          result:
            "API Error: Request rejected (429) · {\"error\":\"capacity unavailable\",\"code\":\"capacity_retry_exhausted\",\"resume_at\":\"2026-07-15T01:59:59.952Z\"}",
        },
      }),
    ).toBe("capacity_retry_exhausted");
    expect(
      matchClaudeUpstreamCapacityCode({
        errorMessage: "Claude run failed: API Error: 503 {\"code\":\"provider_retry_exhausted\"}",
      }),
    ).toBe("provider_retry_exhausted");
    expect(
      matchClaudeUpstreamCapacityCode({ stderr: "upstream said route_exhausted" }),
    ).toBe("route_exhausted");
  });

  it("returns null for a generic throttle with no penstock exhaustion code", () => {
    expect(
      matchClaudeUpstreamCapacityCode({
        parsed: { result: "API Error: 429 rate_limit_error overloaded, try again later" },
      }),
    ).toBeNull();
    expect(matchClaudeUpstreamCapacityCode({})).toBeNull();
  });
});

describe("classifyClaudeUpstreamFailure", () => {
  const capacityResult = {
    type: "result",
    is_error: true,
    result:
      "API Error: Request rejected (429) · {\"code\":\"capacity_retry_exhausted\",\"resume_at\":\"2026-07-15T01:59:59.952Z\"}",
  };

  it("classifies a zero-progress penstock exhaustion as terminal (not transient)", () => {
    expect(
      classifyClaudeUpstreamFailure({ failed: true, zeroTokenProgress: true, parsed: capacityResult }),
    ).toEqual({
      family: "upstream_capacity_exhausted",
      errorCode: "claude_upstream_capacity_exhausted",
      capacityCode: "capacity_retry_exhausted",
    });
  });

  it("keeps a capacity error TRANSIENT when the run already made token progress", () => {
    // Mid-run exhaustion (tokens already produced) — a resumed retry is worthwhile,
    // and the same text still matches the transient regex (429).
    expect(
      classifyClaudeUpstreamFailure({ failed: true, zeroTokenProgress: false, parsed: capacityResult }),
    ).toEqual({ family: "transient_upstream", errorCode: "claude_transient_upstream", capacityCode: null });
  });

  it("classifies a momentary overload (no exhaustion code) as transient", () => {
    expect(
      classifyClaudeUpstreamFailure({
        failed: true,
        zeroTokenProgress: true,
        parsed: { result: "API Error: 529 {\"type\":\"overloaded_error\"}" },
      }),
    ).toEqual({ family: "transient_upstream", errorCode: "claude_transient_upstream", capacityCode: null });
  });

  it("does not classify a non-failed run", () => {
    expect(
      classifyClaudeUpstreamFailure({ failed: false, zeroTokenProgress: true, parsed: capacityResult }),
    ).toEqual({ family: null, errorCode: null, capacityCode: null });
  });

  it("does not classify a deterministic error as an upstream failure", () => {
    expect(
      classifyClaudeUpstreamFailure({
        failed: true,
        zeroTokenProgress: true,
        parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
      }),
    ).toEqual({ family: null, errorCode: null, capacityCode: null });
  });

  it("classifies a missing Skill as deterministic configuration failure", () => {
    expect(
      classifyClaudeUpstreamFailure({
        failed: true,
        zeroTokenProgress: true,
        parsed: { subtype: "error", result: 'Error: Skill "verification-before-completion" not found' },
      }),
    ).toEqual({ family: null, errorCode: "skill_not_found", capacityCode: null });
  });

  it("does not classify a successful output mentioning the error", () => {
    expect(
      classifyClaudeUpstreamFailure({
        failed: false,
        zeroTokenProgress: true,
        parsed: { subtype: "error", result: 'Skill "verification-before-completion" not found' },
      }),
    ).toEqual({ family: null, errorCode: null, capacityCode: null });
  });

  // A run can exit non-zero while its result event still carries
  // `subtype: "success"` — observed on BLO-7991 itself as
  // `Claude run failed: subtype=success: Failed to authenticate…`. On such an
  // event `parsed.result` is the model's OWN final message, so trusting it
  // would re-admit exactly the model-prose false positive the transcript fix
  // removed, one turn narrower. `errorMessage` embeds that same text verbatim
  // (describeClaudeFailure uses `result` as its detail), so it is gated too —
  // this asserts the leak is closed on both surfaces at once.
  it("does not classify model prose in a subtype=success result as a skill failure", () => {
    const modelProse = "Root cause: the run died with Skill 'verification-before-completion' not found.";
    expect(modelProse).toContain("Skill 'verification-before-completion' not found");
    expect(
      classifyClaudeUpstreamFailure({
        failed: true,
        zeroTokenProgress: false,
        parsed: { subtype: "success", result: modelProse },
        errorMessage: `Claude run failed: subtype=success: ${modelProse}`,
      }),
    ).toEqual({ family: null, errorCode: null, capacityCode: null });
  });

  // `stdout` is the WHOLE pod log (execute.ts sets it from the tailed/on-disk
  // log file), so it contains every intermediate assistant message. Matching
  // the skill phrase there lets a failed run be reclassified as deterministic
  // purely because the model *talked about* a missing skill — and
  // `skill_not_found` is in NON_RETRYABLE_CONTINUATION_ERROR_CODES and is
  // excluded from the zero-token session reset, so a false positive
  // permanently suppresses retries. That is the opposite blast radius from the
  // transient codes, where a false positive costs one extra retry.
  //
  // The quoting matters: a JSON-encoded transcript escapes `"` as `\"`, which
  // the regex's `["'`]` class rejects. Single quotes and backticks are NOT
  // escaped inside a JSON string, so prose like `Skill 'x' not found` reaches
  // the matcher verbatim. This run failed on an upstream overload while
  // discussing BLO-7991 — it must stay retryable.
  it("does not classify a transcript that merely discusses a missing skill", () => {
    const transcript = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":',
      "\"Root cause: the run died with Skill 'verification-before-completion' not found.\"}]}}",
      '{"type":"result","subtype":"error","result":"Overloaded"}',
    ].join("\n");
    // Precondition: the phrase really is present unescaped, so this test
    // cannot pass merely because the fixture failed to reproduce it.
    expect(transcript).toContain("Skill 'verification-before-completion' not found");
    expect(
      classifyClaudeUpstreamFailure({
        failed: true,
        zeroTokenProgress: false,
        stdout: transcript,
        errorMessage: "Claude run failed: subtype=error: Overloaded",
      }),
    ).toEqual({
      family: "transient_upstream",
      errorCode: "claude_transient_upstream",
      capacityCode: null,
    });
  });

  // The production call site passes `parsed`/`stdout`/`errorMessage` and never
  // `stderr`, so detection has to work through the structured error envelope.
  it("classifies a missing Skill reported in the structured error envelope", () => {
    expect(
      classifyClaudeUpstreamFailure({
        failed: true,
        zeroTokenProgress: true,
        parsed: {
          subtype: "error",
          errors: [{ message: 'Skill "verification-before-completion" not found' }],
        },
      }),
    ).toEqual({ family: null, errorCode: "skill_not_found", capacityCode: null });
  });
});

describe("extractClaudeRetryNotBefore", () => {
  it("extracts Penstock resume_at from Claude's embedded provider JSON", () => {
    expect(
      extractClaudeRetryNotBefore({
        parsed: {
          type: "result",
          is_error: true,
          result:
            "API Error: Request rejected (429) · {\"error\":\"capacity unavailable\",\"code\":\"capacity_retry_exhausted\",\"resume_at\":\"2026-07-15T01:59:59.952Z\"}",
        },
      }),
    ).toBe("2026-07-15T01:59:59.952Z");
  });

  it("prefers an explicit structured retryNotBefore field", () => {
    expect(
      extractClaudeRetryNotBefore({
        parsed: {
          retryNotBefore: "2026-07-15T02:00:00Z",
          result: "not structured",
        },
      }),
    ).toBe("2026-07-15T02:00:00.000Z");
  });

  it("ignores malformed embedded response data", () => {
    expect(
      extractClaudeRetryNotBefore({
        parsed: { result: "API Error: Request rejected (429) · {not-json}" },
      }),
    ).toBeNull();
  });
});

describe("extractClaudeLoginUrl", () => {
  it("returns null for no URL in text", () => {
    expect(extractClaudeLoginUrl("not a url")).toBeNull();
  });

  it("extracts and cleans URLs with trailing punctuation", () => {
    expect(extractClaudeLoginUrl("Visit https://auth.anthropic.com/ for login!")).toBe("https://auth.anthropic.com/");
  });

  it("returns first URL when no anthropic/claude keywords", () => {
    expect(extractClaudeLoginUrl("Go to https://example.com/page")).toBe("https://example.com/page");
  });

  it("filters by claude/anthropic/auth keywords", () => {
    const text = "See https://example.com and https://auth.anthropic.com/login";
    expect(extractClaudeLoginUrl(text)).toBe("https://auth.anthropic.com/login");
  });

  it("returns null when no URL matches filter", () => {
    expect(extractClaudeLoginUrl("Visit https://example.com only")).toBe("https://example.com");
  });
});

describe("detectClaudeLoginRequired", () => {
  const loginPhrases = [
    "Please log in",
    "not logged in",
    "please run `claude login`",
    "login required",
    "unauthorized",
    "authentication required",
  ];

  it("returns requiresLogin false when no auth phrases", () => {
    const result = detectClaudeLoginRequired({
      parsed: { result: "All good" },
      stdout: "",
      stderr: "",
    });
    expect(result.requiresLogin).toBe(false);
    expect(result.loginUrl).toBeNull();
  });

  it("detects login required from result text", () => {
    const result = detectClaudeLoginRequired({
      parsed: { result: "Please log in to continue" },
      stdout: "",
      stderr: "",
    });
    expect(result.requiresLogin).toBe(true);
  });

  it("detects login required from error array", () => {
    const result = detectClaudeLoginRequired({
      parsed: { errors: ["not logged in", "please log in"] },
      stdout: "",
      stderr: "",
    });
    expect(result.requiresLogin).toBe(true);
  });

  it("extracts login URL from stdout", () => {
    const result = detectClaudeLoginRequired({
      parsed: {},
      stdout: "Visit https://auth.anthropic.com to login",
      stderr: "",
    });
    expect(result.requiresLogin).toBe(false);
    expect(result.loginUrl).toBe("https://auth.anthropic.com");
  });

  it("extracts login URL from stderr", () => {
    const result = detectClaudeLoginRequired({
      parsed: {},
      stdout: "",
      stderr: "Error. See https://auth.anthropic.com/setup",
    });
    expect(result.requiresLogin).toBe(false);
    expect(result.loginUrl).toBe("https://auth.anthropic.com/setup");
  });

  it("detects requiresLogin with URL extraction combined", () => {
    const result = detectClaudeLoginRequired({
      parsed: { result: "please log in" },
      stdout: "Visit https://auth.anthropic.com/",
      stderr: "",
    });
    expect(result.requiresLogin).toBe(true);
    expect(result.loginUrl).toBe("https://auth.anthropic.com/");
  });
});

describe("describeClaudeFailure", () => {
  it("returns null when no failure info", () => {
    expect(describeClaudeFailure({})).toBeNull();
  });

  it("returns null when result is empty", () => {
    expect(describeClaudeFailure({ result: "  " })).toBeNull();
  });

  it("formats with subtype and result", () => {
    const result = describeClaudeFailure({ subtype: "error_rate_limit", result: "Too many requests" });
    expect(result).toBe("Claude run failed: subtype=error_rate_limit: Too many requests");
  });

  it("falls back to first error message", () => {
    const result = describeClaudeFailure({
      subtype: "",
      result: "",
      errors: ["something went wrong"],
    });
    expect(result).toBe("Claude run failed: something went wrong");
  });
});

describe("isClaudeMaxTurnsResult", () => {
  it("returns false for null/undefined", () => {
    expect(isClaudeMaxTurnsResult(null)).toBe(false);
    expect(isClaudeMaxTurnsResult(undefined)).toBe(false);
  });

  it("detects error_max_turns subtype", () => {
    expect(isClaudeMaxTurnsResult({ subtype: "error_max_turns" })).toBe(true);
  });

  it("detects max_turns stop_reason", () => {
    expect(isClaudeMaxTurnsResult({ stop_reason: "max_turns" })).toBe(true);
  });

  it("detects max turns in result text", () => {
    expect(isClaudeMaxTurnsResult({ result: "Reached maximum turns" })).toBe(true);
    expect(isClaudeMaxTurnsResult({ result: "Maximum turns exceeded" })).toBe(true);
    expect(isClaudeMaxTurnsResult({ result: "result is ready" })).toBe(false);
  });

  it("is case insensitive", () => {
    expect(isClaudeMaxTurnsResult({ result: "MAXIMUM TURNS" })).toBe(true);
    expect(isClaudeMaxTurnsResult({ subtype: "Error_Max_Turns" })).toBe(true);
  });
});

describe("isClaudeUnknownSessionError", () => {
  it("detects 'no conversation found with session id'", () => {
    expect(isClaudeUnknownSessionError({ result: "no conversation found with session id abc" })).toBe(true);
  });

  it("detects 'unknown session'", () => {
    expect(isClaudeUnknownSessionError({ result: "unknown session: sess_123" })).toBe(true);
  });

  it("detects 'session not found'", () => {
    expect(isClaudeUnknownSessionError({ result: "session sess_xyz not found" })).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isClaudeUnknownSessionError({ result: "something went wrong" })).toBe(false);
  });

  it("checks error array messages", () => {
    expect(isClaudeUnknownSessionError({ errors: ["session abc not found"] })).toBe(true);
  });
});

describe("isClaudeImmutableThinkingBlockError", () => {
  it("detects immutable thinking block API errors in result text", () => {
    expect(isClaudeImmutableThinkingBlockError({
      result:
        "API Error: 400 messages.65.content.172: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.",
    })).toBe(true);
  });

  it("detects immutable thinking block API errors in error array messages", () => {
    expect(isClaudeImmutableThinkingBlockError({
      errors: [{
        message:
          "messages.1.content.100: `redacted_thinking` blocks in the latest assistant message cannot be modified",
      }],
    })).toBe(true);
  });

  it("returns false for unrelated thinking text", () => {
    expect(isClaudeImmutableThinkingBlockError({ result: "thinking about the next step" })).toBe(false);
  });
});

// When the CLI dies before emitting a `type:"result"` event, execute.ts's
// `!parsed` branch returns before classifyClaudeUpstreamFailure is ever
// called, so AC3 was inert on exactly the startup-time fault BLO-7991
// describes. `stdout` is the only surface left there, and scanning it is safe
// only because the guard reads that same raw surface: the parsed
// `assistantContentSeen` flag does NOT imply the model stayed silent, so it
// cannot bound what the raw scan sees.
describe("isClaudeSkillNotFoundStartupFailure", () => {
  const startupLog = [
    '{"type":"system","subtype":"init"}',
    'Error: Skill "verification-before-completion" not found',
  ].join("\n");

  it("classifies a skill death that produced no assistant output", () => {
    expect(
      isClaudeSkillNotFoundStartupFailure({ stdout: startupLog, assistantContentSeen: false }),
    ).toBe(true);
  });

  // The guard, not a comment, is what keeps the transcript scan safe: once the
  // model has spoken, the same phrase may be its own prose about a missing
  // skill, and `skill_not_found` suppresses retries permanently.
  it("refuses to scan the transcript once assistant output exists", () => {
    const transcript = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":',
      "\"Root cause: the run died with Skill 'verification-before-completion' not found.\"}]}}",
    ].join("\n");
    expect(transcript).toContain("Skill 'verification-before-completion' not found");
    expect(
      isClaudeSkillNotFoundStartupFailure({ stdout: transcript, assistantContentSeen: true }),
    ).toBe(false);
  });

  // Shape (a): an OOMKill mid-first-assistant-message. The truncated line
  // fails parseJson, so it never sets `assistantContentSeen` — yet it sits
  // verbatim in `stdout`. Misclassifying this as `skill_not_found` would
  // permanently suppress retries for a transient pod kill, so the raw-surface
  // guard has to catch it even though the parsed flag is false.
  it("refuses to scan when a truncated, unparseable assistant line is present", () => {
    const transcript = [
      '{"type":"system","subtype":"init"}',
      // Truncated mid-write: no closing braces, so parseJson rejects it.
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Skill \'verification-before-completion\' not found is the err',
    ].join("\n");
    expect(transcript).toContain("Skill 'verification-before-completion' not found");
    const parsed = parseClaudeStreamJson(transcript);
    // Precondition: the parser really does leave the flag false here.
    expect(parsed.truncatedMidStream).toBe(false);
    expect(
      isClaudeSkillNotFoundStartupFailure({
        stdout: transcript,
        assistantContentSeen: parsed.truncatedMidStream,
      }),
    ).toBe(false);
  });

  // Shape (b): a complete, parseable assistant event carrying text but no
  // usage data at all. `outputTokens` defaults to -1, so `outputTokens > 0` is
  // false and the flag stays clear even though the model demonstrably spoke.
  it("refuses to scan when an assistant event carries text but no usage data", () => {
    const transcript = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Root cause: Skill \'verification-before-completion\' not found."}]}}',
    ].join("\n");
    const parsed = parseClaudeStreamJson(transcript);
    // Preconditions: the model's text was captured, yet the flag is false.
    expect(parsed.summary).toContain("Skill 'verification-before-completion' not found");
    expect(parsed.truncatedMidStream).toBe(false);
    expect(
      isClaudeSkillNotFoundStartupFailure({
        stdout: transcript,
        assistantContentSeen: parsed.truncatedMidStream,
      }),
    ).toBe(false);
  });

  // Shape (c): a `user`-typed event before any `assistant` event. `user` events
  // carry tool_result content, i.e. arbitrary text the harness did not author —
  // and this very issue's text contains the trigger phrase verbatim, so a run
  // reading BLO-7991 is the natural first false positive. The parser ignores
  // `user` events entirely (no branch in parseClaudeStreamJson), so the flag
  // stays false. `buildPartialRunError`'s own "skips user events alongside
  // system events" test (execute.test.ts) models exactly this init -> user ->
  // error ordering on this same `!parsed` path, so the shape is one the adapter
  // already expects rather than one hypothesised here.
  it("refuses to scan when a user event precedes any assistant event", () => {
    const toolResult =
      'Skill \'verification-before-completion\' not found — quoted from the issue body';
    const transcript = [
      '{"type":"system","subtype":"init"}',
      `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":${JSON.stringify(toolResult)}}]}}`,
      "Error: pod terminated",
    ].join("\n");
    // Preconditions: the phrase is present verbatim, no assistant event exists,
    // and the parser leaves the flag false — so only the guard can save this.
    expect(transcript).toContain("Skill 'verification-before-completion' not found");
    expect(transcript).not.toContain('"type":"assistant"');
    const parsed = parseClaudeStreamJson(transcript);
    expect(parsed.truncatedMidStream).toBe(false);
    expect(
      isClaudeSkillNotFoundStartupFailure({
        stdout: transcript,
        assistantContentSeen: parsed.truncatedMidStream,
      }),
    ).toBe(false);
  });

  // The generalisation, and the reason this guard is an allowlist rather than a
  // fourth blocklist entry. `stream_event` wraps partial assistant deltas, so
  // it carries model prose exactly as shapes (a)-(c) do, and it was enumerated
  // by no previous version of this guard — so it must fail closed on that basis
  // alone rather than on being recognised.
  //
  // Not hypothetical, and not merely reachable in principle: running
  // `claude --print - --output-format stream-json --verbose
  // --include-partial-messages` on v2.1.210 emits 9 `stream_event`s for a
  // two-word prompt, and the line below is that observed shape (nested
  // `event.delta.text_delta`, with `session_id`/`parent_tool_use_id`/`uuid`
  // siblings). `--include-partial-messages` is not in the adapter's argv, but
  // `job-manifest.ts` appends `config.extraArgs` verbatim, so any one agent's
  // `adapterConfig` turns this on with no code change and no review.
  it("refuses to scan when an unenumerated event type carries the phrase", () => {
    const delta = "Skill 'verification-before-completion' not found";
    const transcript = [
      '{"type":"system","subtype":"init"}',
      `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(delta)}}},"session_id":"e45846ad","parent_tool_use_id":null,"uuid":"e07a5776"}`,
      "Error: pod terminated",
    ].join("\n");
    // Preconditions: the phrase is present verbatim, and this event is not one
    // of the roles any previous version of this guard enumerated — so only an
    // allowlist can catch it.
    expect(transcript).toContain("Skill 'verification-before-completion' not found");
    expect(transcript).not.toContain('"type":"assistant"');
    expect(transcript).not.toContain('"type":"user"');
    const parsed = parseClaudeStreamJson(transcript);
    expect(parsed.truncatedMidStream).toBe(false);
    expect(
      isClaudeSkillNotFoundStartupFailure({
        stdout: transcript,
        assistantContentSeen: parsed.truncatedMidStream,
      }),
    ).toBe(false);
  });

  // The counterweight to the test above, and the one that keeps this fix from
  // becoming a silent disabling of the feature: a REAL init line is far richer
  // than the minimal fixture at the top of this describe, and detection must
  // survive that richness. Field set captured from the CLI this adapter runs
  // (`claude --print - --output-format stream-json --verbose`, v2.1.210) — a
  // 1717-byte line. Note what it does NOT contain: `mcp_servers` entries are
  // `{name, status}` with no `type` of their own, and `output_style` is a bare
  // string, so the whole line carries exactly ONE `"type"`. That measurement is
  // the point of the assertion below — it is the fact that makes per-line
  // scoping defence-in-depth rather than a fix for a live break. Note the
  // assertion pins the FIXTURE's shape, not the CLI's: `initLine` is a
  // hardcoded literal, so no CLI change can redden it. It documents the
  // measured invariant; it does not detect drift away from it.
  it("still classifies on a full production-shaped init line", () => {
    const initLine = JSON.stringify({
      type: "system",
      subtype: "init",
      cwd: "/runtime-cache/workspace",
      session_id: "76be93da-ad0c-44d0-98f1-d6a400d48ee5",
      tools: ["Task", "Bash", "Read", "Edit", "Write"],
      mcp_servers: [{ name: "gbrain", status: "connected" }],
      model: "claude-opus-4-8[1m]",
      permissionMode: "bypassPermissions",
      slash_commands: ["verify", "code-review"],
      apiKeySource: "ANTHROPIC_API_KEY",
      claude_code_version: "2.1.210",
      output_style: "default",
      agents: ["claude", "Explore"],
      skills: ["verify", "code-review"],
      plugins: [],
      capabilities: ["interrupt_receipt_v1", "msg_lifecycle_v1"],
      uuid: "6a5da5b1-9274-4b86-b930-a350a1e22e12",
      fast_mode_state: "off",
    });
    // The measured invariant, pinned so a CLI change breaks this and not prod.
    expect(initLine.match(/"type"\s*:\s*"/g)).toHaveLength(1);
    const transcript = [initLine, 'Error: Skill "verification-before-completion" not found'].join("\n");
    expect(
      isClaudeSkillNotFoundStartupFailure({ stdout: transcript, assistantContentSeen: false }),
    ).toBe(true);
  });

  // Forward-looking, and labelled as such: no CLI version measured here emits a
  // nested `type` on an init line (see the assertion above). This pins the
  // behaviour if one ever does — the line keeps its detection, because the
  // guard reads only the first type per line. Without per-line scoping this
  // case would fail closed and silently disable detection in production while
  // every minimal fixture in this file kept passing.
  it("still classifies if an allowlisted line ever carries a nested type", () => {
    const initLine = JSON.stringify({
      type: "system",
      subtype: "init",
      mcp_servers: [{ name: "gbrain", type: "http", status: "connected" }],
    });
    const transcript = [initLine, 'Error: Skill "verification-before-completion" not found'].join("\n");
    // Precondition: the line really does carry a nested non-system type.
    expect(initLine).toContain('"type":"http"');
    expect(initLine).not.toContain('"type":"assistant"');
    expect(
      isClaudeSkillNotFoundStartupFailure({ stdout: transcript, assistantContentSeen: false }),
    ).toBe(true);
  });

  // v2.1.210 emits `subtype:"status"` before the first turn under
  // `--include-partial-messages` (across 3 runs it appeared in no plain
  // `--print --output-format stream-json --verbose` invocation). That is also
  // the mode in which `init -> status -> death` is a real startup shape —
  // before any `stream_event` exists to reject the transcript — so the
  // allowlist entry is load-bearing rather than incidental.
  it("still classifies when a system:status event follows init", () => {
    const transcript = [
      '{"type":"system","subtype":"init"}',
      '{"type":"system","subtype":"status","status":"requesting","uuid":"3d1a9017","session_id":"e45846ad"}',
      'Error: Skill "verification-before-completion" not found',
    ].join("\n");
    expect(
      isClaudeSkillNotFoundStartupFailure({ stdout: transcript, assistantContentSeen: false }),
    ).toBe(true);
  });

  // Second detection-preserving case: a harness-authored event type other than
  // `system` legitimately follows init with no model output at all.
  // `rate_limit_event` is not hypothetical — `[initLine, rateLimitEvent]` is
  // the verbatim FAR-32 production repro in execute.test.ts. Its payload is
  // counters and ids, so it cannot carry the trigger phrase, and rejecting it
  // would lose a real detection for nothing.
  it("still classifies when a harness-authored rate_limit_event follows init", () => {
    const rateLimitEvent = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: 1777056000, rateLimitType: "five_hour" },
      uuid: "3ab8f9eb-b9d6-4bf6-9c39-4608427717fc",
      session_id: "ad5f3e11-3c0c-4144-b53d-d4b959e57cee",
    });
    const transcript = [
      '{"type":"system","subtype":"init"}',
      rateLimitEvent,
      'Error: Skill "verification-before-completion" not found',
    ].join("\n");
    expect(
      isClaudeSkillNotFoundStartupFailure({ stdout: transcript, assistantContentSeen: false }),
    ).toBe(true);
  });

  // `system` is a multiplexer, so admitting the type wholesale would reproduce
  // the very defect this file's guard fixes, one level down: a new subtype
  // admitted by default, exactly as a new top-level type was admitted by the
  // old blocklist. This is not future-proofing — the v2.1.210 binary builds
  // `{type:"system",subtype:"hook_response",…,output,stdout,stderr}`, embedding
  // a hook process's raw stdout. Hooks are operator-configured via `--settings`,
  // which `job-manifest.ts` appends verbatim from `config.extraArgs` — the same
  // one-config-edit-away channel that motivated inverting this guard at all.
  it("refuses to scan when a system event carries operator-configured hook output", () => {
    // Single-quoted on purpose: `JSON.stringify` escapes `"` to `\"`, and the
    // phrase regex does not match across the backslash, so a double-quoted
    // fixture here would pass vacuously — proving nothing about the subtype
    // gate. Single quotes survive JSON encoding unescaped and do match.
    const phrase = "Error: Skill 'verification-before-completion' not found";
    const hookResponse = JSON.stringify({
      type: "system",
      subtype: "hook_response",
      hook_id: "b0d1f2a3",
      hook_name: "SessionStart",
      hook_event: "SessionStart",
      output: phrase,
      stdout: phrase,
      stderr: "",
      exit_code: 0,
      outcome: "success",
    });
    const transcript = ['{"type":"system","subtype":"init"}', hookResponse].join("\n");
    // Precondition: the phrase really is present *and* in a form the scan
    // matches, so a pass here would be a false positive and therefore
    // *permanent* retry suppression.
    expect(hookResponse).toContain("Skill 'verification-before-completion' not found");
    expect(
      isClaudeSkillNotFoundStartupFailure({ stdout: transcript, assistantContentSeen: false }),
    ).toBe(false);
  });

  // An unreadable subtype fails closed like an unrecognised type. Truncation
  // drops the tail, not the head, so a real `init` line is either whole or too
  // short to carry the trigger phrase — the lost detection costs one
  // classification, which is the safe direction.
  it("refuses to scan when a system event has no readable subtype", () => {
    const transcript = [
      '{"type":"system","session_id":"e45846ad"}',
      'Error: Skill "verification-before-completion" not found',
    ].join("\n");
    expect(
      isClaudeSkillNotFoundStartupFailure({ stdout: transcript, assistantContentSeen: false }),
    ).toBe(false);
  });

  // Reading only the first type per line rests on Claude emitting the
  // discriminator first. This pins the direction in which that assumption is
  // allowed to fail: a re-ordered line whose nested type appears first is still
  // rejected, because no nested type the CLI emits is on the allowlist. The
  // symmetric cost — a re-ordered `system` line losing its detection — is the
  // safe direction, since a missed detection degrades to the untyped
  // `buildPartialRunError` while a false positive suppresses retries for good.
  it("refuses to scan a conversation event whose type key is not first", () => {
    const transcript = [
      '{"type":"system","subtype":"init"}',
      '{"message":{"content":[{"type":"text","text":"Skill \'verification-before-completion\' not found"}]},"type":"assistant"}',
    ].join("\n");
    expect(transcript).toContain("Skill 'verification-before-completion' not found");
    expect(
      isClaudeSkillNotFoundStartupFailure({ stdout: transcript, assistantContentSeen: false }),
    ).toBe(false);
  });

  it("returns false for an unrelated startup failure", () => {
    expect(
      isClaudeSkillNotFoundStartupFailure({
        stdout: "Error: connect ECONNREFUSED 10.0.0.1:443",
        assistantContentSeen: false,
      }),
    ).toBe(false);
  });

  it("returns false when there is no stdout at all", () => {
    expect(isClaudeSkillNotFoundStartupFailure({ stdout: null, assistantContentSeen: false })).toBe(false);
  });
});

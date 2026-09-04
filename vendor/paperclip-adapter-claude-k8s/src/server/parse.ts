import type { UsageSummary } from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject, parseJson } from "@paperclipai/adapter-utils/server-utils";

const CLAUDE_AUTH_REQUIRED_RE = /(?:not\s+logged\s+in|please\s+log\s+in|please\s+run\s+`?claude\s+login`?|login\s+required|requires\s+login|unauthorized|authentication\s+required)/i;
const URL_RE = /(https?:\/\/[^\s'"`<>()[\]{};,!?]+[^\s'"`<>()[\]{};,!.?:]+)/gi;
const CLAUDE_TRANSIENT_UPSTREAM_RE =
  /(?:rate[-\s]?limit(?:ed)?|rate_limit_error|too\s+many\s+requests|\b429\b|overloaded(?:_error)?|server\s+overloaded|service\s+unavailable|\b503\b|\b529\b|high\s+demand|try\s+again\s+later|temporarily\s+unavailable|throttl(?:ed|ing)|throttlingexception|servicequotaexceededexception|out\s+of\s+extra\s+usage|extra\s+usage\b|claude\s+usage\s+limit\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|usage\s+limit\s+reached|usage\s+cap\s+reached|api\s+returned\s+an\s+empty\s+or\s+malformed\s+response)/i;

export function parseClaudeStreamJson(stdout: string) {
  let sessionId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];
  // Belt-and-braces dedup: key by (message.id, textIndex) so a session that
  // legitimately emits the same text twice in different turns isn't collapsed
  // (finding #11, FAR-15).  The log-dedup filter handles reconnect overlaps
  // at the line level; this guard only needs to protect against the same
  // message block being parsed twice.
  const seenBlocks = new Set<string>();
  // Set when we see stop_reason:null + output_tokens:0 on an assistant event
  // with no subsequent result event — indicates the upstream LLM API returned
  // an empty/malformed response (e.g. MiniMax degraded performance).
  let llmApiEmptyResponse = false;
  // Set when an assistant event with output_tokens > 0 was seen but no result
  // event arrived — indicates the run was truncated mid-stream (pod terminated,
  // OOMKill, or claude CLI crash after producing content).
  let assistantContentSeen = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "system" && asString(event.subtype, "") === "init") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      model = asString(event.model, model);
      continue;
    }

    if (type === "assistant") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      const message = parseObject(event.message);
      const messageId = asString(message.id, "");
      const content = Array.isArray(message.content) ? message.content : [];

      // Detect empty LLM API response: stop_reason:null with zero output tokens.
      // output_tokens may appear directly on message or nested under message.usage.
      const stopReason = message.stop_reason;
      const usageObj = parseObject(message.usage as Record<string, unknown>);
      const outputTokens = typeof message.output_tokens === "number"
        ? message.output_tokens
        : asNumber(usageObj.output_tokens, -1);
      if (stopReason === null && outputTokens === 0) {
        llmApiEmptyResponse = true;
      }
      if (outputTokens > 0) {
        assistantContentSeen = true;
      }

      for (let i = 0; i < content.length; i++) {
        const entry = content[i];
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const block = entry as Record<string, unknown>;
        if (asString(block.type, "") === "text") {
          const text = asString(block.text, "");
          if (!text) continue;
          // Prefer (messageId, index) when the message has an id; fall back
          // to text content when it doesn't (legacy/partial events).
          const key = messageId ? `${messageId}:${i}` : `text:${text}`;
          if (!seenBlocks.has(key)) {
            seenBlocks.add(key);
            assistantTexts.push(text);
          }
        }
      }
      continue;
    }

    if (type === "result") {
      finalResult = event;
      llmApiEmptyResponse = false; // result event means Claude completed normally
      assistantContentSeen = false; // result event means stream was not truncated
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
    }
  }

  if (!finalResult) {
    return {
      sessionId,
      model,
      costUsd: null as number | null,
      usage: null as UsageSummary | null,
      summary: assistantTexts.join("\n\n").trim(),
      resultJson: null as Record<string, unknown> | null,
      llmApiEmptyResponse,
      truncatedMidStream: assistantContentSeen,
    };
  }

  const usageObj = parseObject(finalResult.usage);
  const usage: UsageSummary = {
    inputTokens: asNumber(usageObj.input_tokens, 0),
    cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
    outputTokens: asNumber(usageObj.output_tokens, 0),
  };
  const costRaw = finalResult.total_cost_usd;
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
  const summary = asString(finalResult.result, assistantTexts.join("\n\n")).trim();

  return {
    sessionId,
    model,
    costUsd,
    usage,
    summary,
    resultJson: finalResult,
    llmApiEmptyResponse: false,
    truncatedMidStream: false,
  };
}

function extractClaudeErrorMessages(parsed: Record<string, unknown>): string[] {
  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  const messages: string[] = [];

  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const obj = entry as Record<string, unknown>;
    const msg = asString(obj.message, "") || asString(obj.error, "") || asString(obj.code, "");
    if (msg) {
      messages.push(msg);
      continue;
    }

    try {
      messages.push(JSON.stringify(obj));
    } catch {
      // skip non-serializable entry
    }
  }

  return messages;
}

export function extractClaudeLoginUrl(text: string): string | null {
  const match = text.match(URL_RE);
  if (!match || match.length === 0) return null;
  for (const rawUrl of match) {
    const cleaned = rawUrl.replace(/[\])}.!,?;:'\"]+$/g, "");
    if (cleaned.includes("claude") || cleaned.includes("anthropic") || cleaned.includes("auth")) {
      return cleaned;
    }
  }
  return match[0]?.replace(/[\])}.!,?;:'\"]+$/g, "") ?? null;
}

export function detectClaudeLoginRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean; loginUrl: string | null } {
  const resultText = asString(input.parsed?.result, "").trim();
  const messages = [resultText, ...extractClaudeErrorMessages(input.parsed ?? {}), input.stdout, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const requiresLogin = messages.some((line) => CLAUDE_AUTH_REQUIRED_RE.test(line));
  return {
    requiresLogin,
    loginUrl: extractClaudeLoginUrl([input.stdout, input.stderr].join("\n")),
  };
}

export function describeClaudeFailure(parsed: Record<string, unknown>): string | null {
  const subtype = asString(parsed.subtype, "");
  const resultText = asString(parsed.result, "").trim();
  const errors = extractClaudeErrorMessages(parsed);

  let detail = resultText;
  if (!detail && errors.length > 0) {
    detail = errors[0] ?? "";
  }

  const parts = ["Claude run failed"];
  if (subtype) parts.push(`subtype=${subtype}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

export function isClaudeMaxTurnsResult(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;

  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype === "error_max_turns") return true;

  const stopReason = asString(parsed.stop_reason, "").trim().toLowerCase();
  if (stopReason === "max_turns") return true;

  const resultText = asString(parsed.result, "").trim();
  return /max(?:imum)?\s+turns?/i.test(resultText);
}

export function isClaudeUnknownSessionError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /no conversation found with session id|unknown session|session .* not found/i.test(msg),
  );
}

export function isClaudeImmutableThinkingBlockError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /thinking|redacted_thinking/i.test(msg) &&
    /latest assistant message cannot be modified|blocks must remain as they were in the original response/i.test(msg),
  );
}

function buildClaudeTransientHaystack(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): string {
  const parsed = input.parsed ?? null;
  const resultText = parsed ? asString(parsed.result, "") : "";
  const parsedErrors = parsed ? extractClaudeErrorMessages(parsed) : [];
  return [
    input.errorMessage ?? "",
    resultText,
    ...parsedErrors,
    input.stdout ?? "",
    input.stderr ?? "",
  ]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function retryNotBeforeFromObject(value: Record<string, unknown>): string | null {
  const raw = value.retryNotBefore ?? value.retry_not_before ?? value.resumeAt ?? value.resume_at;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const timestamp = new Date(raw).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function parseEmbeddedJsonObject(text: string): Record<string, unknown> | null {
  const direct = parseJson(text.trim());
  if (direct) return direct;

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return parseJson(text.slice(start, end + 1));
}

/**
 * Extract an absolute retry timestamp from Claude's structured provider error.
 * Claude Code embeds proxy JSON in the result string instead of exposing HTTP
 * response headers, so parse that JSON rather than scraping the human message.
 */
export function extractClaudeRetryNotBefore(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): string | null {
  const parsed = input.parsed ?? null;
  if (parsed) {
    const direct = retryNotBeforeFromObject(parsed);
    if (direct) return direct;
  }

  const texts = [
    parsed ? asString(parsed.result, "") : "",
    ...(parsed ? extractClaudeErrorMessages(parsed) : []),
    input.errorMessage ?? "",
    input.stdout ?? "",
    input.stderr ?? "",
  ];
  for (const text of texts) {
    if (!text) continue;
    const embedded = parseEmbeddedJsonObject(text);
    if (!embedded) continue;
    const retryNotBefore = retryNotBeforeFromObject(embedded);
    if (retryNotBefore) return retryNotBefore;
  }
  return null;
}

export function isClaudeTransientUpstreamError(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const parsed = input.parsed ?? null;
  if (parsed && (
    isClaudeMaxTurnsResult(parsed) ||
    isClaudeUnknownSessionError(parsed) ||
    isClaudeImmutableThinkingBlockError(parsed)
  )) {
    return false;
  }
  const loginMeta = detectClaudeLoginRequired({
    parsed,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
  });
  if (loginMeta.requiresLogin) return false;

  const haystack = buildClaudeTransientHaystack(input);
  if (!haystack) return false;
  return CLAUDE_TRANSIENT_UPSTREAM_RE.test(haystack);
}

/**
 * Penstock's machine-readable pool-exhaustion outcome codes, surfaced in the
 * client-facing error body (penstock-llm-proxy-core `writeProxyError`:
 * `code: <code>`) and embedded by Claude Code into its result text (the same
 * embedded proxy JSON `extractClaudeRetryNotBefore` reads). Each means the proxy
 * tried every subscription for the requested model and none could serve it:
 *   - `capacity_retry_exhausted` — all subscriptions rate-limited (429 + Retry-After)
 *   - `provider_retry_exhausted` — provider retries exhausted across the pool (503)
 *   - `route_exhausted`          — no eligible node/route for the request (503)
 * These tokens are distinctive and only appear in penstock's structured error.
 */
const CLAUDE_UPSTREAM_CAPACITY_EXHAUSTED_RE =
  /(capacity_retry_exhausted|provider_retry_exhausted|route_exhausted)/i;

/**
 * Return the penstock pool-exhaustion code present in a failed run's output, or
 * `null`. Matches the code token anywhere in the failure haystack.
 */
export function matchClaudeUpstreamCapacityCode(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): string | null {
  const haystack = buildClaudeTransientHaystack(input);
  if (!haystack) return null;
  const match = haystack.match(CLAUDE_UPSTREAM_CAPACITY_EXHAUSTED_RE);
  return match ? match[1].toLowerCase() : null;
}

export type ClaudeUpstreamFailureFamily = "upstream_capacity_exhausted" | "transient_upstream";

export interface ClaudeUpstreamClassification {
  readonly family: ClaudeUpstreamFailureFamily | null;
  readonly errorCode: "claude_upstream_capacity_exhausted" | "claude_transient_upstream" | "skill_not_found" | null;
  /** The penstock exhaustion code, set only when `family === "upstream_capacity_exhausted"`. */
  readonly capacityCode: string | null;
}

const CLAUDE_SKILL_NOT_FOUND_RE = /\bskill\s+["'`][^\r\n"'`]{1,240}["'`]\s+not\s+found\b/i;

// Presence of an assistant event in the RAW transcript. Read on the same
// surface as the skill scan below, which is the whole point: a parsed signal
// cannot bound what a raw regex sees. Whitespace-tolerant because this matches
// text rather than JSON structure, and a truncated event still carries this
// prefix — truncation drops the tail, not the leading `"type":"assistant"`.
const CLAUDE_ASSISTANT_EVENT_RE = /"type"\s*:\s*"assistant"/;

/**
 * Detect Claude's "Skill "<name>" not found" death (BLO-7991 AC3).
 *
 * Deliberately does NOT read `stdout`. `stdout` is the entire pod log — every
 * intermediate assistant message — so an agent that merely *discusses* a
 * missing skill would match. Unlike the transient families, where a false
 * positive costs one extra retry, `skill_not_found` is listed in
 * NON_RETRYABLE_CONTINUATION_ERROR_CODES and is excluded from the zero-token
 * session reset, so a false positive suppresses retries permanently. That
 * asymmetry is why this classifier reads only bounded, harness-authored error
 * surfaces.
 *
 * `stderr` is NOT among them: the sole production call site (execute.ts) never
 * passes it, and the k8s adapter has no separate Claude-CLI stderr to pass —
 * `onLog("stderr", …)` is the adapter's own log channel to Paperclip.
 *
 * `parsed.result` is only harness-authored on an *error* subtype. A run can
 * exit non-zero while carrying `subtype: "success"` (observed on this very
 * issue: `Claude run failed: subtype=success: Failed to authenticate…`), and
 * on such an event `result` is the model's own final message — model prose
 * again, just the last turn instead of the whole transcript. `errorMessage` is
 * `describeClaudeFailure(parsed)`, which embeds that same `result` text
 * verbatim, so the two are gated together. The structured `errors[]` envelope
 * is always harness-authored and needs no gate.
 */
function isClaudeSkillNotFoundError(input: {
  parsed?: Record<string, unknown> | null;
  errorMessage?: string | null;
}): boolean {
  const parsed = input.parsed ?? null;
  const surfaces: (string | null | undefined)[] = parsed ? extractClaudeErrorMessages(parsed) : [];
  const subtype = parsed ? asString(parsed.subtype, "") : "";
  if (subtype !== "" && subtype !== "success") {
    surfaces.push(parsed ? asString(parsed.result, "") : "", input.errorMessage);
  }
  return surfaces.some((value) => typeof value === "string" && CLAUDE_SKILL_NOT_FOUND_RE.test(value));
}

/**
 * The `!parsed` counterpart of the classifier above (BLO-7991 AC3).
 *
 * When the CLI dies before emitting a `type: "result"` event there is no
 * structured envelope at all — `stdout` (the whole pod log) is the only
 * surface left, and execute.ts's `!parsed` branch returns an *untyped* partial
 * run error. Scanning that transcript is normally unsafe for a retry-killing
 * code, so it is guarded twice, and the second guard is the load-bearing one.
 *
 * `assistantContentSeen` is a *parsed* signal and is NOT equivalent to "the
 * model has not spoken", so it cannot bound what a raw scan sees. Two shapes
 * slip between them, both of which the parser produces deliberately:
 *
 *   (a) A line that fails `parseJson` is skipped (`:33`) and never touches the
 *       flag, yet it remains verbatim in the `stdout` being tested. This is the
 *       OOMKill-mid-first-message shape.
 *   (b) `outputTokens` falls back to `-1` (`:54`) when neither
 *       `message.output_tokens` nor `message.usage.output_tokens` is present,
 *       so a fully-written assistant event carrying text still leaves the flag
 *       false — `assistantTexts` is populated (`:74`) while the flag is not.
 *
 * Either shape reaches this scan with model prose in `stdout` and the flag
 * false. Because `skill_not_found` is in NON_RETRYABLE_CONTINUATION_ERROR_CODES
 * and is excluded from the zero-token session reset, that false positive
 * suppresses retries *permanently* — so a transient OOM whose truncated message
 * happened to discuss a missing skill would never be retried. Single quotes and
 * backticks are not escaped inside a JSON string, so quoting does not prevent
 * the match (this file's own fixtures rely on that).
 *
 * The fix is to guard on the same surface the scan reads: positive evidence of
 * an assistant event anywhere in the raw transcript. That is strictly stronger
 * than the token flag and immune to both shapes. A genuine startup skill death
 * has only the `system:init` line and the error, so detection is unaffected.
 * The parsed flag is retained as a cheap first check, not as the guarantee.
 */
export function isClaudeSkillNotFoundStartupFailure(input: {
  stdout?: string | null;
  assistantContentSeen: boolean;
}): boolean {
  if (input.assistantContentSeen) return false;
  if (typeof input.stdout !== "string") return false;
  if (CLAUDE_ASSISTANT_EVENT_RE.test(input.stdout)) return false;
  return CLAUDE_SKILL_NOT_FOUND_RE.test(input.stdout);
}

/**
 * Classify a failed Claude run's upstream-provider outcome. Precedence:
 *   1. A penstock pool-exhaustion code + ZERO token progress => terminal
 *      (`upstream_capacity_exhausted`): the requested model tier has no usable
 *      capacity, so retrying it as a transient throttle loops forever with no
 *      forward progress (the Fable-5 pool-throttle pathology). Fail fast and
 *      surface it; the agent's normal heartbeat cadence provides paced retries.
 *   2. Otherwise a momentary throttle/overload => `transient_upstream` (retry).
 *   3. Otherwise not an upstream failure (`null`) — a deterministic error.
 * `zeroTokenProgress` gates (1): a mid-run exhaustion that already produced
 * tokens is NOT treated as a no-capacity tier — a resumed retry is worthwhile.
 * Pure and side-effect-free for unit testing.
 */
export function classifyClaudeUpstreamFailure(input: {
  failed: boolean;
  zeroTokenProgress: boolean;
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): ClaudeUpstreamClassification {
  if (!input.failed) {
    return { family: null, errorCode: null, capacityCode: null };
  }
  // This is a deterministic configuration failure from Claude's Skill tool,
  // not an upstream outage. Keep it out of every transient retry family.
  if (isClaudeSkillNotFoundError(input)) {
    return { family: null, errorCode: "skill_not_found", capacityCode: null };
  }
  if (input.zeroTokenProgress) {
    const capacityCode = matchClaudeUpstreamCapacityCode(input);
    if (capacityCode) {
      return {
        family: "upstream_capacity_exhausted",
        errorCode: "claude_upstream_capacity_exhausted",
        capacityCode,
      };
    }
  }
  if (isClaudeTransientUpstreamError(input)) {
    return { family: "transient_upstream", errorCode: "claude_transient_upstream", capacityCode: null };
  }
  return { family: null, errorCode: null, capacityCode: null };
}

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

/**
 * Is `parsed` the CLI's terminal `result` event, as opposed to some other JSON
 * object that merely reached the same variable?
 *
 * In THIS copy the distinction is provably inert: `execute.ts` derives `parsed`
 * from `parseClaudeStreamJson().resultJson` (assigned only on `type === "result"`)
 * with recovery via `scanForResultEvent`, which hard-checks `.type === "result"`
 * too — so `parsed` is always null or a genuine result event. It is written on
 * the shape anyway to match the `claude-local` twin, where it is NOT inert: that
 * copy derives `parsed` as `parsedStream.resultJson ?? parseJson(stdout)`, and
 * the second arm is a bare `JSON.parse` that admits any single parseable object.
 * Testing the shape here means the narrowing stays correct if this copy ever
 * gains a similar fallback, and keeps the two mechanisms from drifting apart —
 * which is how this rule's own defect arose.
 */
function isClaudeTerminalResultEvent(parsed: Record<string, unknown> | null): boolean {
  return parsed !== null && asString(parsed.type, "") === "result";
}

/**
 * The bounded error surfaces of a *finished* run: the terminal `result` event and
 * the failure message derived from it. Deliberately does NOT read `stdout`.
 *
 * `stdout` is the entire pod log — every assistant message, every tool result,
 * every file the agent read — so a haystack containing it decides the label from
 * *transcript content* rather than from the fault. Measured on 964 retained run
 * logs (2026-09-12 onward, PEN-3223): of the 41 runs whose terminal event carries
 * `api_error_status: 403`, **20 classified `claude_transient_upstream`** off tokens
 * that appear only in the transcript (`429` ×13, `503` ×3, `throttled` ×2, `529`,
 * `rate-limited`, `throttling`). None of those 41 match on these surfaces. An agent
 * working on a rate-limit ticket poisons its own failure label; this issue's own
 * text would do it.
 *
 * Narrowing costs no detection, on three independent legs:
 *  1. STRUCTURAL — `classifyClaudeUpstreamFailure` is only reachable with a truthy
 *     `parsed` (its sole call site, execute.ts:2551, sits after the `!parsed`
 *     branch returns at :2503). The one case where `stdout` is genuinely the only
 *     surface — the CLI dying before it emits a `result` event — never consults
 *     this classifier at all. That is the case
 *     `isClaudeSkillNotFoundStartupFailure` exists to serve, and it keeps its own
 *     transcript scan under the `claudeLineIsHarnessAuthored` line guard.
 *  2. EMPIRICAL — every run in that corpus carrying an authoritative upstream
 *     status keeps its signal here: `api_error_status: 429` 9/9, `503` 6/6.
 *  3. THE ONE STRUCTURAL CANDIDATE IS ABSENT — `rate_limit_event` is the only
 *     harness-authored event type that could carry a rate-limit verdict outside
 *     the result event. It occurs **0 times** in the corpus's 93,336 event lines
 *     (positive control, same scan: `assistant` 36873, `user` 18193, `system`
 *     9374, `result` 466). The CLI this adapter runs never emits one.
 *
 * Line-level attribution — reusing `claudeLineIsHarnessAuthored`, as the skill
 * rule does — was measured and rejected for THIS rule: it leaves 29 of the 95
 * transcript-403 runs still mislabelled, because a line with no `"type"` is
 * admitted as harness-authored by design (the CLI's own untyped prose is exactly
 * what that rule must detect), and the untyped lines here are `[paperclip]`
 * operational text quoting upstream statuses. That guard is right for a
 * distinctive phrase and wrong for an alternation of bare numbers.
 *
 * Unlike `isClaudeSkillNotFoundError`, `result` is NOT gated on a non-`success`
 * subtype. A genuine upstream refusal is reported as `subtype: "success"` with
 * `is_error: true` and `api_error_status: 429`, so that gate would discard the
 * true positives this rule exists for — all 15 of the 429/503 runs above are
 * `subtype: "success"`. The asymmetry is the reverse of the skill rule's: there a
 * false positive suppresses retries permanently, here it *grants* them.
 *
 * `api_error_status` is included so the verdict does not rest solely on CLI prose.
 */
function buildClaudeTerminalResultHaystack(input: {
  parsed?: Record<string, unknown> | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): string {
  const parsed = input.parsed ?? null;
  const resultText = parsed ? asString(parsed.result, "") : "";
  const parsedErrors = parsed ? extractClaudeErrorMessages(parsed) : [];
  const apiErrorStatus = parsed ? asNumber(parsed.api_error_status, 0) : 0;
  return [
    input.errorMessage ?? "",
    resultText,
    ...parsedErrors,
    apiErrorStatus > 0 ? `api_error_status=${apiErrorStatus}` : "",
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
  // The login veto deliberately still reads the whole transcript, and that is a
  // scope line rather than a clean bill of health. It can only ever SUPPRESS the
  // transient label, so narrowing it would widen what this function grants — the
  // opposite of this rule's defect — and a login prompt is emitted before any
  // result event, where this classifier is unreachable anyway.
  //
  // It does carry the same defect mirrored into suppression, and that is live, not
  // theoretical: in the PEN-3223 corpus 2 of the 9 genuine `api_error_status: 429`
  // capacity refusals are vetoed here despite their own bounded surfaces matching,
  // because an auth-shaped token appears somewhere in their transcript. Tracked
  // separately rather than fixed alongside, because relaxing a veto grants retry
  // families and needs its own evidence.
  const loginMeta = detectClaudeLoginRequired({
    parsed,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
  });
  if (loginMeta.requiresLogin) return false;

  // Narrow to the terminal-result surfaces only when a `result` event actually
  // exists. In THIS copy that is the only reachable case — leg 1 above — so the
  // no-result branch is defensive rather than live. It is kept because the
  // `claude-local` twin IS reachable that way, from both its `!parsed` fallback
  // and its `parseJson(stdout)` arm (which yields a truthy NON-result object), and
  // a silent divergence between the two copies is what this rule's own defect grew
  // out of. With no result event there are no bounded surfaces to read, so the
  // transcript is the only evidence available.
  const haystack = isClaudeTerminalResultEvent(parsed)
    ? buildClaudeTerminalResultHaystack(input)
    : buildClaudeTransientHaystack(input);
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
 *
 * Still reads the transcript, and that is a deliberate scope line rather than an
 * oversight (PEN-3223). This rule carries the same latent defect — in the same
 * 964-log corpus, 11 runs have a capacity code in `stdout` and nowhere else, and
 * all 48 such lines are `type: "user"` `tool_result` payloads, i.e. agents reading
 * files that merely *mention* the token. But it is not reachable: the sole call
 * site gates on `zeroTokenProgress` (:680), and **0 of those 11 runs are
 * zero-token** — every one had substantial tool output, so none could arrive here.
 *
 * It is also not safely narrowable on present evidence: the corpus contains zero
 * *legitimate* occurrences of these codes (none reached `parsed.result`), so a
 * narrowed version could not be shown to still work. Narrowing it would trade a
 * latent, gated false positive for an unvalidated regression in the one direction
 * that fails a run permanently. Left as-is, deliberately and with the measurement
 * recorded, rather than swept in.
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

// Stream-json event types the *harness* authors end to end: the CLI emits them
// itself, and none of their fields can carry model output or tool results.
// This is an allowlist rather than a blocklist of conversation roles, because
// `parseClaudeStreamJson` branches on exactly three types (`system`+`init`,
// `assistant`, `result`) and ignores every other one — so each newly-appearing
// event shape slipped through a blocklist by default. That is how `assistant`
// alone proved insufficient and `user` had to be added; enumerating the unsafe
// set means re-widening this guard every time the CLI grows an event.
//
// Membership criterion, so a future entry is a judgement and not a guess: the
// event's payload must be entirely harness-authored scalars.
//   - `system`           — but only on the subtypes below, NOT wholesale.
//   - `rate_limit_event` — `rate_limit_info` counters + `uuid`/`session_id`.
// `result` is deliberately absent: its `result` field is the model's own final
// message. A parseable `result` event cannot reach this scan (its presence is
// what makes `parsed` truthy), but a *truncated* one can, and must fail closed.
// `stream_event` is likewise absent, and is the case this allowlist exists for:
// v2.1.210 emits it under `--include-partial-messages`, wrapping model prose in
// `event.delta.text_delta`, and it was enumerated by no previous guard.
const CLAUDE_HARNESS_AUTHORED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "system",
  "rate_limit_event",
]);

// `system` is a multiplexer, so admitting the type wholesale would reproduce
// this guard's own defect one level down: a new subtype would be admitted by
// default, exactly as a new top-level type was admitted by the old blocklist.
// The criterion above is stated per *payload*, so it has to be applied per
// (type, subtype) wherever a type demultiplexes.
//
// Measured against the v2.1.210 binary this adapter runs, `system` carries at
// least six subtypes — `init`, `status`, `compact_boundary`, `hook_started`,
// `hook_response`, `mcp_status`. Only `init` is admitted:
//   - `init`   — session_id, model, tool names; the startup line itself.
// `hook_response` is the concrete reason this gate exists rather than being
// future-proofing: the binary constructs it as
// `{type:"system",subtype:"hook_response",…,output,stdout,stderr}` — i.e. it
// embeds a hook process's raw stdout, which is operator-configured and not
// harness-authored at all. That is not merely reachable through `--settings`:
// Paperclip provisions hooks itself, so it is live today. A real pod log on
// this instance opens with a `SessionStart:startup` `hook_response` whose
// `output` is a 344-byte operator message, and another carries an nginx 503
// HTML error page — arbitrary external text inside a `system` event, in
// production. `hook_started` is admitted nowhere for the same reason its
// sibling is not: its `hook_name` is operator-derived.
// (`hook_error` appears in no v2.1.210 string table — not a subtype at this
// version. Corroborated behaviourally: a hook exiting 3 with stderr output
// still emits `subtype:"hook_response"` with `exit_code:3`.)
//
// `status` is NOT admitted, and was until BLO-31955. It carries
// `compact_result`/`compact_error`, compaction summaries derived from model
// output, and the earlier justification for admitting it anyway — "compaction
// cannot occur before the first turn, so any such transcript also contains an
// `assistant` line, which this guard rejects independently" — was a
// whole-transcript-veto argument. Under per-line attribution (below) an
// `assistant` line elsewhere rejects nothing, so a `status` line whose
// `compact_result` quoted the trigger phrase would have been attributed to the
// harness and classified `skill_not_found`: permanent retry suppression, the
// asymmetry every other decision here is careful about. Nor is the entry
// load-bearing any more: in the `init -> status -> death` startup shape (seen
// under `--include-partial-messages`) the death is the bare error line, which
// is trusted on its own, and a `status` line that does not carry the phrase is
// never consulted. So `status` fails closed like every other subtype.
//
// A `system` line with no readable subtype fails closed, like any unrecognised
// type. Truncation drops the tail, not the head, so a genuine `init` line is
// either whole or too short to carry the trigger phrase — and a truncated
// `hook_response`, the more interesting case since truncation is the class that
// produced the original bug, still carries its leading subtype and so fails
// closed on that read regardless of what its severed tail contained.
const CLAUDE_HARNESS_AUTHORED_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  "init",
]);

// The first `"type":"…"` on a line. Whitespace-tolerant because this matches
// text rather than JSON structure, and a truncated event still carries its
// leading `"type":"<role>"` prefix — truncation drops the tail, not the head.
// The value is unbounded on purpose: a length cap would fail to match at the
// position of an over-long type and let the scan advance to a *nested* type
// instead, which is the one direction that could wrongly allowlist a line.
const CLAUDE_EVENT_TYPE_RE = /"type"\s*:\s*"([^"\r\n]*)"/;

// The first `"subtype":"…"` on a line, read with the same tolerances and for
// the same reason as the type above.
const CLAUDE_EVENT_SUBTYPE_RE = /"subtype"\s*:\s*"([^"\r\n]*)"/;

/**
 * True when this single line is one the harness authored end to end.
 *
 * Read on the same surface as the skill scan below, which is the whole point: a
 * parsed signal cannot bound what a raw regex sees. Deliberately does NOT
 * `JSON.parse` — an unparseable half-written line is exactly the shape the
 * guard exists to catch, and parsing would skip it (`firstContentLine` in
 * execute.ts can parse because a *missed* protocol line there is cosmetic).
 *
 * Reads only the FIRST type on the line, so that a nested `"type"` cannot veto
 * the line that contains it. Measured rather than assumed: against the CLI this
 * adapter actually runs (v2.1.210), a real `system:init` line is 1717 bytes
 * with `mcp_servers` populated and carries exactly ONE `"type"` — its own. Its
 * `mcp_servers` entries are `{name, status}` with no `type`, and `output_style`
 * is a bare string.
 *
 * Claude emits the discriminator first, so a line's first type is its top-level
 * type, and the same holds for the `system` subtype (the binary constructs it
 * immediately after the type). Where that ever fails to hold the error is
 * one-directional: every nested type the CLI emits (`text`, `tool_result`,
 * `tool_use`, `thinking`,
 * `image`) is absent from the allowlist, so a re-ordered *dangerous* line still
 * fails closed, and a re-ordered `system` line costs only a missed detection —
 * which degrades to the untyped `buildPartialRunError`, i.e. pre-BLO-7991
 * behaviour. Under a retry-killing code that asymmetry is the whole design:
 * a false negative is one classification lost, a false positive is permanent.
 *
 * Lines with no `"type"` at all are content, not events — the CLI's own
 * `Error: Skill "<name>" not found` output is one, so they cannot be rejected
 * without rejecting the very thing being detected. In stream-json mode every
 * model token and tool result is wrapped in a JSON event, so a line carrying no
 * type is the CLI speaking outside the protocol rather than a payload that can
 * relay model or tool text.
 *
 * That trust is STRUCTURAL, not a sample. The surface this reads has exactly
 * one writer: the `tee` in the pipeline `job-manifest.ts` builds in
 * `claudeInvocation` — `cat … | ${launcherCommand} … | tee <podLogPath> |
 * <failFastFilter> > /dev/null` — which carries no `2>&1` on any stage. The
 * file therefore receives that stage's stdout and nothing else. Hook stderr,
 * MCP-server stderr and the fail-fast `[wrapper]` line (written to
 * `/dev/stderr` by `job-manifest.ts`'s `failFastFilter`, and downstream of the
 * `tee` regardless) all bypass it by construction, as does the prompt.
 * Operator- and MCP-authored text cannot reach this predicate as a bare line
 * at all — which is why trusting bare lines is safe, rather than merely
 * observed to be safe. The 6893-line production sample recorded in
 * PROVENANCE.md corroborates that; it is not what establishes it.
 *
 * Three things void this, and none shows a diff at this call site. The first
 * two break the single-writer premise; the third breaks the other one, that
 * the binary writing stdout speaks only stream-json:
 *
 *   1. Adding `2>&1` before the `tee` in `job-manifest.ts`'s
 *      `claudeInvocation` — an entirely reasonable change, e.g. to capture CLI
 *      diagnostics in the pod log — which starts routing operator-authored
 *      stderr here as bare, TRUSTED lines.
 *   2. Feeding a merged container-log read into the parse surface. Container
 *      logs interleave both streams, so `readPodContainerLogTail`
 *      (in `execute.ts`, via `readNamespacedPodLog`) must stay confined to
 *      diagnostics. Today `stdout` is assigned only from `podLogPath`
 *      (in `execute.ts`: the `tailResult.value` tail, and the `stdout =
 *      onDisk` re-read), so both paths read the same single-writer file.
 *   3. Pointing `adapterConfig.agentCommand` at a launcher that writes any
 *      line of its own to stdout. Stage 2 above is `launcherCommand`, not
 *      `claude` — `job-manifest.ts` resolves it from `validateAgentCommand(
 *      config.agentCommand, "claude")`, an operator-editable text field
 *      ("Agent Launcher" in `config-schema.ts`). This one needs NO code edit,
 *      no diff and no review, which is what makes it live regardless of how
 *      often it is actually used — so nothing below is load-bearing. Note the
 *      code default IS `claude`, and this repository records only that a
 *      launcher is AVAILABLE to point at, never that any agent points at one:
 *      selection lives entirely in per-agent `adapterConfig`, which is not in
 *      this tree. A dated instance reading, corroboration only: 14 of 15
 *      `claude_k8s` agents had a non-default `adapterConfig.agentCommand` on
 *      2026-09-16 (all `/opt/penstock/bin/penstock-agent-runtime.mjs`).
 *      Re-measure by counting agents whose `adapterConfig.agentCommand`
 *      differs from `"claude"` — but first check the field is visible at all,
 *      because `adapterConfig` comes back `{}` for a caller without config
 *      visibility and that reads as 0 of 15 rather than as a failed read.
 *      The trust therefore assumes that launcher is a stream-json
 *      PASSTHROUGH: `job-manifest.ts` encodes that expectation where it sets
 *      `PENSTOCK_AGENT_COMMAND` ("the launcher owns provider credentials and
 *      starts the native Claude protocol itself"), and a proxy that surfaced
 *      an upstream error body on stdout would emit it here as a bare, trusted
 *      line — the same shape as the nginx 503 page already seen in a
 *      `hook_response`.
 *
 * Any one re-opens BLO-7991's hole with no diff on this guard — the failure
 * mode every prior iteration in this family took (BLO-7991 → #1525 → BLO-31794).
 */
function claudeLineIsHarnessAuthored(line: string): boolean {
  const match = CLAUDE_EVENT_TYPE_RE.exec(line);
  if (!match) return true;
  if (!CLAUDE_HARNESS_AUTHORED_EVENT_TYPES.has(match[1])) return false;
  // `system` demultiplexes, so the allowlist has to reach its subtype too.
  if (match[1] === "system") {
    const subtype = CLAUDE_EVENT_SUBTYPE_RE.exec(line);
    if (!subtype || !CLAUDE_HARNESS_AUTHORED_SYSTEM_SUBTYPES.has(subtype[1])) return false;
  }
  return true;
}

/**
 * True when the trigger phrase appears on a line the harness authored.
 *
 * This ATTRIBUTES the phrase to its line rather than demanding the whole
 * transcript be clean, and that distinction is the correction to BLO-31794's
 * first cut. A whole-transcript veto is unsatisfiable in production: hooks are
 * Paperclip-provisioned, so `system:hook_started` / `hook_response` open the
 * transcript BEFORE `init` on the large majority of real runs — measured at
 * 6510 of 8036 `init`-carrying pod logs on this instance (81%), and in a 399-log
 * sample where both appear the hook line preceded `init` 399/399 times. Under a
 * whole-transcript veto every one of those runs loses detection outright, which
 * is precisely the "fix the false positive by disabling detection entirely"
 * failure mode this issue's own acceptance criteria warn about — and it would
 * have shipped green, because the suite's only positive fixture is the synthetic
 * two-line shape that no production run has.
 *
 * Attribution is also the more faithful invariant. Every false positive in this
 * family — a truncated `assistant` line, a complete `assistant` event with no
 * usage, a pre-assistant `user`/`tool_result`, a `stream_event` delta, a
 * `hook_response` payload — is the phrase sitting INSIDE an event that can
 * carry text the harness did not author. The genuine signal is the phrase on a
 * line that cannot. So the question worth asking is not "is this transcript
 * clean?" but "did the harness write THIS line?", and unrelated untrusted text
 * elsewhere no longer vetoes a real death.
 *
 * Unknown types still fail closed, so the allowlist keeps the property this
 * issue was filed for: a newly-appearing event shape is excluded by default
 * rather than admitted by default.
 *
 * One deliberate narrowing versus the whole-string test: `CLAUDE_SKILL_NOT_FOUND_RE`
 * has `\s+` between its tokens, which matches a newline, so the phrase could in
 * principle straddle two lines and match the transcript while matching no single
 * line. The CLI emits the error on one line, so this costs nothing observed; and
 * the direction is the safe one — a missed classification degrades to the
 * retryable `buildPartialRunError`, whereas the alternative is a permanent
 * retry suppression.
 */
function claudeTranscriptHasHarnessAuthoredSkillPhrase(stdout: string): boolean {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!CLAUDE_SKILL_NOT_FOUND_RE.test(line)) continue;
    if (claudeLineIsHarnessAuthored(line)) return true;
  }
  return false;
}

/**
 * Detect Claude's "Skill "<name>" not found" death (BLO-7991 AC3).
 *
 * Deliberately does NOT read `stdout`. `stdout` is the pod log's stdout stream
 * — every intermediate assistant message — so an agent that merely *discusses* a
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
 * model has not spoken", so it cannot bound what a raw scan sees. Three shapes
 * slip between them, all of which the parser produces deliberately:
 *
 *   (a) A line that fails `parseJson` is skipped (`:33`) and never touches the
 *       flag, yet it remains verbatim in the `stdout` being tested. This is the
 *       OOMKill-mid-first-message shape.
 *   (b) `outputTokens` falls back to `-1` (`:54`) when neither
 *       `message.output_tokens` nor `message.usage.output_tokens` is present,
 *       so a fully-written assistant event carrying text still leaves the flag
 *       false — `assistantTexts` is populated (`:74`) while the flag is not.
 *   (c) A `user`-typed event before any `assistant` event. These carry
 *       tool_result content — text the harness did not author, which can quote
 *       the trigger phrase (BLO-7991's own body does) — and the parser has no
 *       `user` branch at all, so the flag is never touched.
 *       `buildPartialRunError` already models this `init` -> `user` -> error
 *       ordering on this same `!parsed` path.
 *
 * Each shape reaches this scan with the phrase in `stdout` and the flag false.
 * Because `skill_not_found` is in NON_RETRYABLE_CONTINUATION_ERROR_CODES
 * and is excluded from the zero-token session reset, that false positive
 * suppresses retries *permanently* — so a transient OOM whose truncated message
 * happened to discuss a missing skill would never be retried. Single quotes and
 * backticks are not escaped inside a JSON string, so quoting does not prevent
 * the match (this file's own fixtures rely on that).
 *
 * The fix is to guard on the same surface the scan reads, and to state the
 * requirement positively: every event line in the raw transcript must be one
 * the harness authored. That is strictly stronger than the token flag, immune
 * to all three shapes above, and — unlike enumerating the unsafe roles — it
 * does not need re-widening each time the CLI grows an event type, because an
 * unrecognised type fails closed. A genuine skill death at startup has only the
 * `system:init` line and the error, so detection is unaffected. The parsed flag
 * is retained as a cheap first check, not as the guarantee.
 */
export function isClaudeSkillNotFoundStartupFailure(input: {
  stdout?: string | null;
  assistantContentSeen: boolean;
}): boolean {
  if (input.assistantContentSeen) return false;
  if (typeof input.stdout !== "string") return false;
  // Cheap whole-transcript phrase test before the per-line walk. Both are pure
  // and neither regex is `/g`, so this is semantically a pre-filter only: the
  // walk below re-tests each line and is what actually decides. The phrase is
  // absent on the overwhelming majority of failed runs, and `stdout` is the pod
  // log's stdout stream, so this skips the eager `split` outright on that path.
  if (!CLAUDE_SKILL_NOT_FOUND_RE.test(input.stdout)) return false;
  return claudeTranscriptHasHarnessAuthoredSkillPhrase(input.stdout);
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

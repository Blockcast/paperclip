/**
 * Response scrubbing: strip secret material out of MCP tool results before
 * they reach the agent (PEN-2370).
 *
 * WHY THIS EXISTS
 *
 * `pods_get` and `resources_get` on the Kubernetes MCP servers return the full
 * resource, including `spec.containers[].env[].value`, in the clear. Any agent
 * holding the read-only k8s grant can read every other agent's pod, so one
 * read-only grant yields fleet-wide credentials. The reader cannot avoid it:
 * these tools have no field selector, so fetching a pod's image or phase — the
 * legitimate diagnostic use the grant exists for — returns the secrets anyway.
 * Correct, careful use causes the exposure.
 *
 * DESIGN CONSTRAINTS, each of which is load-bearing:
 *
 * 1. STRUCTURAL, NOT NAME-MATCHING. We redact *every* value inside an `env`
 *    block, whatever the variable is called. We deliberately do NOT match
 *    names against a `/(TOKEN|SECRET|KEY|PASSWORD|...)/i` fragment list: such a
 *    matcher falls through to the literal value for any name outside the list,
 *    so it is not default-deny and a credential named `SIGNING_MATERIAL` or
 *    `DSN` walks straight through. Redact everything; keep the names.
 *
 * 2. NAMES ARE PRESERVED. Knowing *which* variables are set is the diagnostic
 *    value of the grant. We return `value: "<redacted>"`, not a deleted key,
 *    and `valueFrom:` references (`secretKeyRef`, `configMapKeyRef`) are left
 *    intact — they name a source, they do not carry the material.
 *
 * 3. NO NEW DEPENDENCIES. This package ships `"dependencies": {}` on purpose:
 *    it is an unauthenticated-reachable proxy, and its supply chain is part of
 *    its threat model. So we do not pull in a YAML parser. The k8s MCP servers
 *    serialize resources as YAML text inside a JSON-RPC content block, so we
 *    walk that text with an indentation-aware scanner instead.
 *
 * 4. FAIL CLOSED. Where the scanner cannot confidently tell where a value ends
 *    (block scalars, flow mappings), it removes more rather than less. A
 *    scrubber that guesses in the permissive direction is worse than none: it
 *    produces false assurance.
 *
 * SCOPE HONESTY: this closes the `env`-value path on responses that traverse
 * this gateway. It is not a general secret detector, and it does not by itself
 * establish the fleet-wide invariant that agent-visible tool output is
 * systematically scrubbed — see PEN-2370 ask 3.
 */

export const REDACTED = "<redacted>";

/**
 * Annotations whose value embeds a serialized copy of the whole resource, and
 * therefore a second copy of every env value in it.
 *
 * `kubectl.kubernetes.io/last-applied-configuration` is the one that matters:
 * kubectl writes the entire applied manifest into it as a single-line JSON
 * string. Redacting `env:` in the YAML body while leaving this annotation
 * intact would leak exactly what we just removed, one field further down the
 * same response. It is a client-side bookkeeping detail with little diagnostic
 * value, so we drop the value wholesale rather than try to rewrite JSON
 * embedded in a YAML scalar.
 */
const RESOURCE_ECHO_ANNOTATIONS = [
  "kubectl.kubernetes.io/last-applied-configuration",
];

/**
 * Cheap pre-filter. Scrubbing is a no-op for the overwhelming majority of
 * responses (tool listings, metrics, Linear payloads), and we are on the hot
 * path for every proxied response, so skip the scan unless the body could
 * plausibly contain something we redact.
 */
function mightContainSecrets(text: string): boolean {
  if (text.includes("env:") || text.includes('"env"')) return true;
  return RESOURCE_ECHO_ANNOTATIONS.some((a) => text.includes(a));
}

function leadingIndent(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === " ") i += 1;
  return i;
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/**
 * True when `line` still belongs to the `env:` block that opened at
 * `blockIndent`.
 *
 * YAML permits a sequence to sit at the same indentation as the key that owns
 * it, which is exactly how kubectl renders env:
 *
 *     env:
 *     - name: A
 *       value: B
 *
 * so "indent <= blockIndent ends the block" would terminate it immediately, on
 * the first entry. A line at the block indent continues the block only when it
 * opens a sequence entry; anything else at that indent or shallower is a
 * sibling key and ends it.
 */
function continuesBlock(line: string, blockIndent: number): boolean {
  if (isBlank(line)) return true;
  const indent = leadingIndent(line);
  if (indent > blockIndent) return true;
  if (indent < blockIndent) return false;
  return line.slice(indent).startsWith("- ");
}

/** Matches a `value:` key, optionally as the first key of a sequence entry. */
const VALUE_KEY = /^(\s*)(-\s+)?value:(.*)$/;
/** Matches an `env:` key that opens a block (nothing but a comment after it). */
const ENV_BLOCK_KEY = /^(\s*)(-\s+)?env:\s*(#.*)?$/;
/** Matches an `env:` key whose value is inline (flow style, or an alias). */
const ENV_INLINE_KEY = /^(\s*)(-\s+)?env:[ \t]+(\S.*)$/;
/** Matches an annotation key we drop wholesale. */
const ECHO_ANNOTATION_KEY = new RegExp(
  `^(\\s*)(-\\s+)?(["']?)(${RESOURCE_ECHO_ANNOTATIONS.map(escapeRegExp).join("|")})\\3:(.*)$`,
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redact env values in a YAML-serialized Kubernetes resource.
 *
 * Operates line by line, tracking the indentation of any open `env:` block.
 * Only `value:` keys *inside* such a block are touched, so the rest of the
 * spec — images, phases, restart counts, resource limits — survives intact.
 */
export function scrubYamlText(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];

  // Indentation of the currently open `env:` block, or null when outside one.
  let envBlockIndent: number | null = null;
  // While set, we are swallowing the continuation lines of a redacted block
  // scalar; every line indented deeper than this is part of the value.
  let swallowDeeperThan: number | null = null;

  for (const line of lines) {
    if (swallowDeeperThan !== null) {
      if (isBlank(line) || leadingIndent(line) > swallowDeeperThan) {
        // Part of the block scalar we already replaced. Drop it.
        continue;
      }
      swallowDeeperThan = null;
    }

    if (envBlockIndent !== null && !continuesBlock(line, envBlockIndent)) {
      envBlockIndent = null;
    }

    // Drop annotations that echo the entire resource (and thus its env values).
    const echo = ECHO_ANNOTATION_KEY.exec(line);
    if (echo) {
      const [, indent, dash = "", quote, key, rest] = echo;
      out.push(`${indent}${dash}${quote}${key}${quote}: "${REDACTED}"`);
      if (opensBlockScalar(rest ?? "")) {
        swallowDeeperThan = leadingIndent(line) + (dash?.length ?? 0);
      }
      continue;
    }

    if (envBlockIndent !== null) {
      const value = VALUE_KEY.exec(line);
      if (value) {
        const [, indent, dash = "", rest] = value;
        out.push(`${indent}${dash}value: "${REDACTED}"`);
        if (opensBlockScalar(rest ?? "")) {
          // `value: |` — the material is on the following, deeper-indented
          // lines. Swallow them, or we would redact the key and print the
          // secret directly underneath it.
          swallowDeeperThan = indent.length + dash.length;
        }
        continue;
      }
    }

    // `env: [{name: A, value: B}]` — flow style on one line. We cannot cheaply
    // rewrite the mapping in place, so we fail closed and drop the whole flow
    // value rather than let an unparsed one through.
    const inlineEnv = ENV_INLINE_KEY.exec(line);
    if (inlineEnv) {
      const [, indent, dash = "", rest] = inlineEnv;
      if (rest.startsWith("[") || rest.startsWith("{")) {
        out.push(`${indent}${dash}env: "${REDACTED}"`);
        continue;
      }
      // An alias/anchor (`env: *shared`) carries no material by itself.
      out.push(line);
      continue;
    }

    const envBlock = ENV_BLOCK_KEY.exec(line);
    if (envBlock) {
      const [, indent, dash = ""] = envBlock;
      // The block's contents are owned by the `env` key itself. When env is the
      // first key of a sequence entry (`- env:`), the dash is part of the
      // indentation its children align against.
      envBlockIndent = indent.length + dash.length;
      out.push(line);
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
}

/** True when a YAML scalar header defers the value to following lines. */
function opensBlockScalar(rest: string): boolean {
  return /^\s*[|>]/.test(rest);
}

/**
 * Redact env values in a structurally-parsed JSON resource.
 *
 * The k8s MCP servers currently emit YAML, but the format is theirs to change
 * and other upstreams may return JSON directly. Handling both means a server
 * upgrade cannot silently turn this scrubber into a no-op.
 */
export function scrubJsonValue(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(scrubJsonValue);
  if (!node || typeof node !== "object") return node;

  const source = node as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === "env" && Array.isArray(value)) {
      result[key] = value.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const envVar = entry as Record<string, unknown>;
        // Preserve `name` and any `valueFrom` reference; drop only the literal.
        return "value" in envVar ? { ...envVar, value: REDACTED } : envVar;
      });
      continue;
    }
    if (RESOURCE_ECHO_ANNOTATIONS.includes(key) && typeof value === "string") {
      result[key] = REDACTED;
      continue;
    }
    if (typeof value === "string") {
      // Resource echoes also appear as YAML/JSON text nested in string fields
      // (annotation maps, `content[].text`). Recurse into the text.
      result[key] = mightContainSecrets(value) ? scrubText(value) : value;
      continue;
    }
    result[key] = scrubJsonValue(value);
  }

  return result;
}

/**
 * Scrub a text payload that may be YAML, JSON, or several YAML documents.
 */
export function scrubText(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(scrubJsonValue(JSON.parse(text)));
    } catch {
      // Not valid JSON after all — fall through to the YAML scanner, which
      // degrades gracefully on arbitrary text.
    }
  }
  return scrubYamlText(text);
}

/**
 * Scrub a full MCP response body.
 *
 * Handles both plain JSON-RPC bodies and SSE framing (`event:`/`data:` lines),
 * which is how the streamable-HTTP MCP transport delivers most tool results.
 * Anything we cannot parse is returned unchanged: this is a proxy, and a
 * scrubber that corrupts unrelated traffic is a worse failure than one that
 * misses a body we did not recognize. The formats we *do* recognize are the
 * ones that carry k8s resources.
 */
export function scrubResponseBody(body: Buffer, contentType?: string | null): Buffer {
  const text = body.toString("utf8");
  if (!mightContainSecrets(text)) return body;

  const isSse = (contentType ?? "").includes("text/event-stream") || /^(event|data):/m.test(text);
  const scrubbed = isSse ? scrubSseFrames(text) : scrubJsonRpcBody(text);
  return scrubbed === null ? body : Buffer.from(scrubbed, "utf8");
}

function scrubJsonRpcBody(text: string): string | null {
  try {
    return JSON.stringify(scrubJsonValue(JSON.parse(text)));
  } catch {
    return null;
  }
}

/**
 * Rewrite the JSON payload of each SSE `data:` line, preserving framing.
 *
 * SSE payloads may be split across consecutive `data:` lines that concatenate
 * into one JSON document, so we buffer a run of them and scrub the join. Blank
 * lines terminate an event and are emitted verbatim to keep the stream valid.
 */
function scrubSseFrames(text: string): string {
  const out: string[] = [];
  let pending: string[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    const joined = pending.join("");
    const scrubbed = scrubJsonRpcBody(joined);
    out.push(`data: ${scrubbed ?? joined}`);
    pending = [];
  };

  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) {
      pending.push(line.slice("data:".length).trimStart());
      continue;
    }
    flush();
    out.push(line);
  }
  flush();

  return out.join("\n");
}

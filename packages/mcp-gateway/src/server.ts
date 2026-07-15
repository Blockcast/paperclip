#!/usr/bin/env node
/**
 * paperclip-mcp-gateway entry point.
 *
 * Listens on $PORT (default 8080) and reverse-proxies inbound MCP
 * requests to upstream MCP servers based on the path prefix. Catches
 * `Session not found` 404s from upstreams and transparently replays
 * the cached `initialize` request to mint a fresh upstream session,
 * then retries the original call. The client never sees the failure.
 *
 * Routing config: penstock state via `PAPERCLIP_MCP_UPSTREAMS_STATE_URL`,
 * with a last-known-good cache fallback, or legacy local JSON env/file.
 *
 * Health check: GET / → 200 with the current upstream table.
 */

import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  CredentialCustodyError,
  applyCustodiedAuthorization,
  configForPrefix,
  invalidateCustodiedToken,
  loadCredentialCustodyState,
  resolveCustodiedToken,
  type CredentialCustodyConfig,
  type CredentialCustodyState,
  type CredentialCustodyToken,
} from "./credential-custody.js";
import { buildCredentialHeaders, loadUpstreams, matchUpstream, type UpstreamConfig, type UpstreamMap } from "./upstreams.js";
import { CircuitBreaker, type CircuitBreakerConfig } from "./circuit-breaker.js";
import {
  MCP_SESSION_HEADER,
  SessionStore,
  type PersistedSessionRecord,
  isSessionNotFoundResponse,
  looksLikeInitializeRequest,
  extractUpstreamSessionId,
  buildDefaultInitializePayload,
  buildInitializedNotificationPayload,
} from "./session-keepalive.js";

/**
 * Default per-upstream request timeout. Without an explicit abort signal,
 * `fetch` inherits undici's ~300s header/body timeouts, so a single hung
 * upstream holds its connection + buffered body that whole time. Under load
 * (many agents retrying a dead backend) those hung requests accumulate until
 * the gateway OOMs. This bounds any single upstream call.
 */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000;
export const DEFAULT_BREAKER_FAILURE_THRESHOLD = 5;
export const DEFAULT_BREAKER_OPEN_COOLDOWN_MS = 30_000;
export const DEFAULT_BREAKER_HALF_OPEN_MAX_PROBES = 1;

export interface GatewayConfig {
  upstreamTimeoutMs: number;
  breaker: CircuitBreakerConfig;
  sessionPersistenceFile: string | null;
  oauthDiscovery: OAuthDiscoveryConfig | null;
}

export interface OAuthDiscoveryConfig {
  resource: string;
  authorizationServer: string;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const publicUrl = env.PAPERCLIP_MCP_PUBLIC_URL?.trim().replace(/\/+$/, "");
  const authorizationServer = env.PAPERCLIP_MCP_AUTHORIZATION_SERVER?.trim().replace(/\/+$/, "");
  if ((publicUrl && !authorizationServer) || (!publicUrl && authorizationServer)) {
    throw new Error("PAPERCLIP_MCP_PUBLIC_URL and PAPERCLIP_MCP_AUTHORIZATION_SERVER must be configured together");
  }
  return {
    upstreamTimeoutMs: parsePositiveInt(env.PAPERCLIP_MCP_UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS),
    breaker: {
      failureThreshold: parsePositiveInt(
        env.PAPERCLIP_MCP_BREAKER_FAILURE_THRESHOLD,
        DEFAULT_BREAKER_FAILURE_THRESHOLD,
      ),
      openCooldownMs: parsePositiveInt(
        env.PAPERCLIP_MCP_BREAKER_OPEN_COOLDOWN_MS,
        DEFAULT_BREAKER_OPEN_COOLDOWN_MS,
      ),
      halfOpenMaxProbes: parsePositiveInt(
        env.PAPERCLIP_MCP_BREAKER_HALF_OPEN_MAX_PROBES,
        DEFAULT_BREAKER_HALF_OPEN_MAX_PROBES,
      ),
    },
    sessionPersistenceFile: env.PAPERCLIP_MCP_SESSION_STORE_FILE?.trim() || null,
    oauthDiscovery: publicUrl && authorizationServer
      ? { resource: `${publicUrl}/mcp`, authorizationServer }
      : null,
  };
}

export interface GatewayState {
  upstreams: UpstreamMap;
  sessions: Map<string, SessionStore>;
  upstreamCallCounts: Map<string, number>;
  breaker: CircuitBreaker;
  upstreamTimeoutMs: number;
  credentialCustody?: CredentialCustodyState;
  oauthDiscovery?: OAuthDiscoveryConfig | null;
  sessionPersistenceFile?: string | null;
  sessionPersistenceLoaded?: boolean;
  sessionPersistenceWrite?: Promise<void>;
}

interface PersistedSessionSnapshot {
  version: 1;
  prefixes: Record<string, PersistedSessionRecord[]>;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Request headers we must NOT copy verbatim to the upstream fetch.
 *
 * `host` is re-derived from the upstream URL. `content-length` and
 * `transfer-encoding` are framing headers that undici recomputes from the
 * body we hand it — critically, undici's fetch rejects ANY request whose
 * headers carry `transfer-encoding` with `UND_ERR_INVALID_ARG: invalid
 * transfer-encoding header`, so a chunked-framed inbound request (as the
 * upstream auth-proxy sends) would 502 if forwarded. The remainder are the
 * RFC 7230 §6.1 hop-by-hop headers, which are per-connection and meaningless
 * on the new gateway→upstream connection.
 *
 * Names are lowercase because Node lowercases all incoming header names.
 */
const STRIPPED_REQUEST_HEADERS = [
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

function getOrCreateStore(state: GatewayState, prefix: string): SessionStore {
  const existing = state.sessions.get(prefix);
  if (existing) return existing;
  const fresh = new SessionStore();
  state.sessions.set(prefix, fresh);
  return fresh;
}

async function loadPersistedSessions(state: GatewayState): Promise<void> {
  const file = state.sessionPersistenceFile;
  if (!file) return;
  let parsed: PersistedSessionSnapshot;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8")) as PersistedSessionSnapshot;
  } catch {
    return;
  }
  if (!parsed || parsed.version !== 1 || !parsed.prefixes || typeof parsed.prefixes !== "object") return;
  for (const [prefix, records] of Object.entries(parsed.prefixes)) {
    if (!Array.isArray(records)) continue;
    getOrCreateStore(state, prefix).restore(records);
  }
}

async function ensurePersistedSessionsLoaded(state: GatewayState): Promise<void> {
  if (!state.sessionPersistenceFile || state.sessionPersistenceLoaded) return;
  await loadPersistedSessions(state);
  state.sessionPersistenceLoaded = true;
}

async function persistSessions(state: GatewayState): Promise<void> {
  const prior = state.sessionPersistenceWrite ?? Promise.resolve();
  const write = prior.catch(() => undefined).then(() => persistSessionsNow(state));
  state.sessionPersistenceWrite = write;
  await write;
}

async function persistSessionsNow(state: GatewayState): Promise<void> {
  const file = state.sessionPersistenceFile;
  if (!file) return;
  // Best-effort shared cache only: concurrent replicas can race between the
  // reload and atomic rename, but a lost mapping self-heals by re-initializing
  // the upstream session on the next aggregate call.
  await loadPersistedSessions(state);
  const snapshot: PersistedSessionSnapshot = {
    version: 1,
    prefixes: Object.fromEntries(Array.from(state.sessions.entries()).map(([prefix, store]) => [prefix, store.snapshot()])),
  };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (e) {
    try {
      await fs.rm(tmp, { force: true });
    } catch {
      // best-effort cleanup only
    }
    // eslint-disable-next-line no-console
    console.warn(`[mcp-gateway] failed to persist session store: ${(e as Error).message}`);
  }
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

interface ForwardResult {
  status: number;
  headers: Headers;
  body: Buffer;
}

export function buildInitializeReplayHeaders(
  inboundHeaders: http.IncomingHttpHeaders,
): http.IncomingHttpHeaders {
  const headers: http.IncomingHttpHeaders = { ...inboundHeaders };
  delete headers[MCP_SESSION_HEADER];
  headers["content-type"] = "application/json";
  headers.accept = "application/json, text/event-stream";
  return headers;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function parseJsonRpcRequest(bodyText: string): JsonRpcRequest | null {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as JsonRpcRequest;
  } catch {
    return null;
  }
}

function buildJsonRpcResponse(id: JsonRpcRequest["id"], result: unknown): Buffer {
  return Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }));
}

function buildJsonRpcError(id: JsonRpcRequest["id"], code: number, message: string): Buffer {
  return Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }));
}

async function notifyUpstreamInitialized(
  upstreamUrl: string,
  inboundHeaders: http.IncomingHttpHeaders,
  upstreamSessionId: string,
  timeoutMs: number,
  credentialToken?: CredentialCustodyToken,
  upstreamConfig?: UpstreamConfig,
): Promise<boolean> {
  const result = await forward(
    upstreamUrl,
    "POST",
    buildInitializeReplayHeaders(inboundHeaders),
    buildInitializedNotificationPayload(),
    upstreamSessionId,
    timeoutMs,
    credentialToken,
    upstreamConfig,
  );
  if (isSuccess(result.status)) return true;
  // eslint-disable-next-line no-console
  console.warn(`[mcp-gateway] upstream initialized notification failed: status=${result.status}`);
  return false;
}

async function createUpstreamSession(
  upstreamUrl: string,
  inboundHeaders: http.IncomingHttpHeaders,
  initializePayload: Buffer,
  timeoutMs: number,
  credentialToken?: CredentialCustodyToken,
  upstreamConfig?: UpstreamConfig,
  custodyConfig?: MatchedCustodyConfig,
  clientSessionId?: string,
): Promise<string | null> {
  const initializeResult = await forward(
    upstreamUrl,
    "POST",
    buildInitializeReplayHeaders(inboundHeaders),
    initializePayload,
    null,
    timeoutMs,
    credentialToken,
    upstreamConfig,
  );
  invalidateMatchedCustodyTokenIfUnauthorized(initializeResult, custodyConfig, inboundHeaders, clientSessionId);
  const initializeBody = initializeResult.body.toString("utf8");
  const upstreamSessionId = extractUpstreamSessionId(initializeResult.headers, initializeBody);
  if (!isSuccess(initializeResult.status) || !upstreamSessionId) return null;
  await notifyUpstreamInitialized(upstreamUrl, inboundHeaders, upstreamSessionId, timeoutMs, credentialToken, upstreamConfig);
  return upstreamSessionId;
}

async function ensureUpstreamSession(
  state: GatewayState,
  prefix: string,
  upstream: UpstreamConfig,
  inboundHeaders: http.IncomingHttpHeaders,
  clientSessionId: string,
  initializePayload: Buffer,
  custodyConfig?: MatchedCustodyConfig,
): Promise<string | null> {
  const store = getOrCreateStore(state, prefix);
  const existing = store.get(clientSessionId);
  if (existing) return existing.upstreamSessionId;
  const credentialToken = await resolveMatchedCustodyToken(custodyConfig, inboundHeaders, clientSessionId);
  const upstreamSessionId = await createUpstreamSession(
    upstream.url,
    inboundHeaders,
    initializePayload,
    state.upstreamTimeoutMs,
    credentialToken,
    upstream,
    custodyConfig,
    clientSessionId,
  );
  if (!upstreamSessionId) return null;
  store.createInitialized({ clientSessionId, upstreamSessionId, initializePayload });
  await persistSessions(state);
  return upstreamSessionId;
}

async function forwardAggregateWithSessionRecovery(
  state: GatewayState,
  prefix: string,
  upstream: UpstreamConfig,
  inboundHeaders: http.IncomingHttpHeaders,
  method: string,
  body: Buffer,
  clientSessionId: string,
  initializePayload: Buffer,
  custodyConfig?: MatchedCustodyConfig,
): Promise<ForwardResult | null> {
  const upstreamSessionId = await ensureUpstreamSession(
    state,
    prefix,
    upstream,
    inboundHeaders,
    clientSessionId,
    initializePayload,
    custodyConfig,
  );
  if (!upstreamSessionId) return null;
  const store = getOrCreateStore(state, prefix);
  const credentialToken = await resolveMatchedCustodyToken(custodyConfig, inboundHeaders, clientSessionId);
  let result = await forward(upstream.url, method, inboundHeaders, body, upstreamSessionId, state.upstreamTimeoutMs, credentialToken, upstream);
  invalidateMatchedCustodyTokenIfUnauthorized(result, custodyConfig, inboundHeaders, clientSessionId);
  const text = result.body.toString("utf8");
  if (!isSessionNotFoundResponse(result.status, text)) return result;

  const retryCredentialToken = await resolveMatchedCustodyToken(custodyConfig, inboundHeaders, clientSessionId);
  const newUpstreamSessionId = await createUpstreamSession(
    upstream.url,
    inboundHeaders,
    initializePayload,
    state.upstreamTimeoutMs,
    retryCredentialToken,
    upstream,
    custodyConfig,
    clientSessionId,
  );
  if (!newUpstreamSessionId) return null;
  store.rotateUpstream(clientSessionId, newUpstreamSessionId);
  result = await forward(upstream.url, method, inboundHeaders, body, newUpstreamSessionId, state.upstreamTimeoutMs, retryCredentialToken, upstream);
  invalidateMatchedCustodyTokenIfUnauthorized(result, custodyConfig, inboundHeaders, clientSessionId);
  await persistSessions(state);
  return result;
}

async function forward(
  upstreamUrl: string,
  method: string,
  inboundHeaders: http.IncomingHttpHeaders,
  body: Buffer,
  upstreamSessionId: string | null,
  timeoutMs: number,
  credentialToken?: CredentialCustodyToken,
  upstreamConfig?: UpstreamConfig,
): Promise<ForwardResult> {
  const headers = buildForwardHeaders(inboundHeaders, credentialToken, upstreamConfig);
  // Override Mcp-Session-Id with the upstream id (or remove it for fresh init).
  delete headers[MCP_SESSION_HEADER];
  if (upstreamSessionId) {
    headers[MCP_SESSION_HEADER] = upstreamSessionId;
  }
  applyCustodiedAuthorization(headers, credentialToken);
  const init: RequestInit = {
    method,
    headers,
    // Bound the call: abort a hung upstream instead of holding the connection
    // and buffered body until undici's ~300s default timeouts fire. A fired
    // timeout rejects with a TimeoutError, surfaced as 504 by safeOnError.
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (method !== "GET" && method !== "HEAD" && body.length > 0) {
    // Buffer subclasses Uint8Array, but TS's RequestInit BodyInit type
    // doesn't include Buffer directly. Cast via Uint8Array — at runtime
    // fetch handles both equivalently.
    init.body = new Uint8Array(body);
  }
  const resp = await fetch(upstreamUrl, init);
  const respBody = Buffer.from(await resp.arrayBuffer());
  return { status: resp.status, headers: resp.headers, body: respBody };
}

function buildForwardHeaders(
  inboundHeaders: http.IncomingHttpHeaders,
  credentialToken?: CredentialCustodyToken,
  upstreamConfig?: UpstreamConfig,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (credentialToken) {
    copyHeader(headers, inboundHeaders, "accept");
    copyHeader(headers, inboundHeaders, "content-type");
    applyCustodiedAuthorization(headers, credentialToken);
    return headers;
  }

  for (const [k, v] of Object.entries(inboundHeaders)) {
    if (Array.isArray(v)) {
      headers[k] = v.join(", ");
    } else if (typeof v === "string") {
      headers[k] = v;
    }
  }
  // Strip framing + hop-by-hop headers we shouldn't forward (see
  // STRIPPED_REQUEST_HEADERS). Leaving `transfer-encoding` in place makes
  // undici reject the fetch with UND_ERR_INVALID_ARG.
  for (const h of STRIPPED_REQUEST_HEADERS) delete headers[h];
  if (upstreamConfig) {
    Object.assign(headers, buildCredentialHeaders(upstreamConfig));
  }
  return headers;
}

function copyHeader(
  headers: Record<string, string>,
  inboundHeaders: http.IncomingHttpHeaders,
  name: string,
): void {
  const value = inboundHeaders[name];
  if (Array.isArray(value)) {
    headers[name] = value.join(", ");
  } else if (typeof value === "string") {
    headers[name] = value;
  }
}

function writeResponse(
  res: http.ServerResponse,
  result: ForwardResult,
  exposedClientSessionId: string | null,
): void {
  res.statusCode = result.status;
  for (const [k, v] of result.headers.entries()) {
    // Replace upstream's session header with the stable client one.
    if (k.toLowerCase() === MCP_SESSION_HEADER) continue;
    // Skip hop-by-hop headers.
    if (k.toLowerCase() === "transfer-encoding" || k.toLowerCase() === "content-encoding") continue;
    res.setHeader(k, v);
  }
  if (exposedClientSessionId) {
    res.setHeader(MCP_SESSION_HEADER, exposedClientSessionId);
  }
  res.end(result.body);
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: GatewayState,
): Promise<void> {
  const url = req.url ?? "/";
  const pathName = url.split("?", 1)[0] ?? "/";

  if (serveOAuthDiscovery(pathName, res, state.oauthDiscovery)) return;

  // Health endpoint.
  if (pathName === "/" || pathName === "/healthz") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      upstreams: Object.keys(state.upstreams),
      breakers: state.breaker.snapshot(),
      upstreamCallCounts: Object.fromEntries(state.upstreamCallCounts.entries()),
      sessions: Object.fromEntries(
        Array.from(state.sessions.entries()).map(([prefix, store]) => [prefix, store.size()]),
      ),
    }));
    return;
  }

  if (pathName === "/mcp" || pathName.startsWith("/mcp/")) {
    await handleAggregateRequest(req, res, state);
    return;
  }

  const matched = matchUpstream(pathName, state.upstreams);
  if (!matched) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      error: "no upstream matched",
      path: pathName,
      knownPrefixes: Object.keys(state.upstreams),
    }));
    return;
  }
  const prefix = (() => {
    const trimmed = pathName.startsWith("/") ? pathName.slice(1) : pathName;
    const slashIdx = trimmed.indexOf("/");
    return slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx);
  })();
  await ensurePersistedSessionsLoaded(state);
  const store = getOrCreateStore(state, prefix);
  state.upstreamCallCounts.set(prefix, (state.upstreamCallCounts.get(prefix) ?? 0) + 1);

  const body = await readBody(req);
  const bodyText = body.toString("utf8");
  const clientSessionId = (() => {
    const v = req.headers[MCP_SESSION_HEADER];
    return Array.isArray(v) ? v[0] : (v as string | undefined);
  })();

  // Circuit breaker: if this upstream has been failing (hung / OOMing /
  // unreachable), fail fast with 503 instead of forwarding into it and
  // accumulating buffered in-flight requests until the gateway OOMs.
  if (!state.breaker.tryAcquire(prefix)) {
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.setHeader("retry-after", String(Math.ceil(state.upstreamTimeoutMs / 1000)));
    res.end(JSON.stringify({ error: "upstream circuit open", prefix }));
    return;
  }

  // A thrown error (timeout / network) or a 5xx response means the upstream
  // is unhealthy and counts against the breaker; anything else (2xx, or an
  // application 4xx like auth/session-not-found) is a healthy round-trip.
  try {
    const status = await serveMatched(
      req,
      res,
      matched,
      store,
      body,
      bodyText,
      clientSessionId,
      state.upstreamTimeoutMs,
      matchedCustodyConfig(state.credentialCustody, prefix, matched.config),
      () => persistSessions(state),
    );
    if (status >= 500) state.breaker.recordFailure(prefix);
    else state.breaker.recordSuccess(prefix);
  } catch (e) {
    if (!(e instanceof CredentialCustodyError)) {
      state.breaker.recordFailure(prefix);
    }
    throw e;
  }
}

async function handleAggregateRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: GatewayState,
): Promise<void> {
  await ensurePersistedSessionsLoaded(state);
  const body = await readBody(req);
  const bodyText = body.toString("utf8");
  const message = parseJsonRpcRequest(bodyText);
  const inboundSessionId = (() => {
    const v = req.headers[MCP_SESSION_HEADER];
    return Array.isArray(v) ? v[0] : (v as string | undefined);
  })();
  const clientSessionId = inboundSessionId || randomUUID();
  const initializePayload = looksLikeInitializeRequest(bodyText) ? body : buildDefaultInitializePayload();

  if (!message?.method) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "invalid JSON-RPC request" }));
    return;
  }

  if (message.method === "initialize") {
    await Promise.allSettled(Object.entries(state.upstreams).map(async ([prefix, upstream]) => {
      if (!state.breaker.tryAcquire(prefix)) return;
      state.upstreamCallCounts.set(prefix, (state.upstreamCallCounts.get(prefix) ?? 0) + 1);
      try {
        const upstreamSessionId = await ensureUpstreamSession(
          state,
          prefix,
          upstream,
          req.headers,
          clientSessionId,
          initializePayload,
          matchedCustodyConfig(state.credentialCustody, prefix, upstream),
        );
        if (upstreamSessionId) state.breaker.recordSuccess(prefix);
        else state.breaker.recordFailure(prefix);
      } catch (e) {
        if (!(e instanceof CredentialCustodyError)) state.breaker.recordFailure(prefix);
        // eslint-disable-next-line no-console
        console.warn(`[mcp-gateway] aggregate initialize skipped prefix=${prefix}: ${(e as Error).message}`);
      }
    }));
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader(MCP_SESSION_HEADER, clientSessionId);
    res.end(buildJsonRpcResponse(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "paperclip-mcp-gateway", version: "0.1.0" },
    }));
    return;
  }

  if (message.method === "notifications/initialized") {
    res.statusCode = 202;
    res.setHeader(MCP_SESSION_HEADER, clientSessionId);
    res.end();
    return;
  }

  if (message.method === "tools/list") {
    const tools: unknown[] = [];
    for (const [prefix, upstream] of Object.entries(state.upstreams)) {
      if (!state.breaker.tryAcquire(prefix)) continue;
      state.upstreamCallCounts.set(prefix, (state.upstreamCallCounts.get(prefix) ?? 0) + 1);
      try {
        const result = await forwardAggregateWithSessionRecovery(
          state,
          prefix,
          upstream,
          req.headers,
          req.method ?? "POST",
          body,
          clientSessionId,
          initializePayload,
          matchedCustodyConfig(state.credentialCustody, prefix, upstream),
        );
        if (!result) {
          state.breaker.recordFailure(prefix);
          continue;
        }
        if (result.status >= 500) state.breaker.recordFailure(prefix);
        else state.breaker.recordSuccess(prefix);
        if (!isSuccess(result.status)) continue;
        const parsed = JSON.parse(result.body.toString("utf8")) as { result?: { tools?: unknown[] } };
        for (const tool of parsed.result?.tools ?? []) {
          if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
          const record = tool as Record<string, unknown>;
          if (typeof record.name !== "string" || record.name.length === 0) continue;
          tools.push({ ...record, name: `${prefix}__${record.name}` });
        }
      } catch (e) {
        if (!(e instanceof CredentialCustodyError)) state.breaker.recordFailure(prefix);
        // eslint-disable-next-line no-console
        console.warn(`[mcp-gateway] aggregate tools/list skipped prefix=${prefix}: ${(e as Error).message}`);
      }
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader(MCP_SESSION_HEADER, clientSessionId);
    res.end(buildJsonRpcResponse(message.id, { tools }));
    return;
  }

  if (message.method === "tools/call") {
    const toolName = typeof message.params?.name === "string" ? message.params.name : "";
    const separatorIndex = toolName.indexOf("__");
    const prefix = separatorIndex > 0 ? toolName.slice(0, separatorIndex) : "";
    const upstreamToolName = separatorIndex > 0 ? toolName.slice(separatorIndex + 2) : "";
    const upstream = prefix ? state.upstreams[prefix] : undefined;
    if (!upstream || upstreamToolName.length === 0) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader(MCP_SESSION_HEADER, clientSessionId);
      res.end(buildJsonRpcError(message.id, -32602, `unknown aggregated tool name "${toolName}"`));
      return;
    }
    if (!state.breaker.tryAcquire(prefix)) {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.setHeader("retry-after", String(Math.ceil(state.upstreamTimeoutMs / 1000)));
      res.end(JSON.stringify({ error: "upstream circuit open", prefix }));
      return;
    }
    state.upstreamCallCounts.set(prefix, (state.upstreamCallCounts.get(prefix) ?? 0) + 1);
    const rewritten = Buffer.from(JSON.stringify({
      ...message,
      params: { ...(message.params ?? {}), name: upstreamToolName },
    }));
    const result = await forwardAggregateWithSessionRecovery(
      state,
      prefix,
      upstream,
      req.headers,
      req.method ?? "POST",
      rewritten,
      clientSessionId,
      initializePayload,
      matchedCustodyConfig(state.credentialCustody, prefix, upstream),
    );
    if (!result) {
      state.breaker.recordFailure(prefix);
      res.statusCode = 502;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "failed to initialize upstream session", prefix }));
      return;
    }
    if (result.status >= 500) state.breaker.recordFailure(prefix);
    else state.breaker.recordSuccess(prefix);
    writeResponse(res, result, clientSessionId);
    return;
  }

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.setHeader(MCP_SESSION_HEADER, clientSessionId);
  res.end(buildJsonRpcError(message.id, -32601, `method "${message.method}" is not supported by aggregate endpoint`));
}

/**
 * Forward a matched request to its upstream, applying the session-keepalive
 * replay/bootstrap logic. Returns the final HTTP status written to the client
 * so the caller can update the circuit breaker. Throws on network/timeout
 * failure (surfaced as 502/504 by safeOnError).
 */
async function serveMatched(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  matched: { upstreamUrl: string; remainder: string; config: UpstreamConfig },
  store: SessionStore,
  body: Buffer,
  bodyText: string,
  clientSessionId: string | undefined,
  timeoutMs: number,
  custodyConfig?: MatchedCustodyConfig,
  persistSessionStore?: () => Promise<void>,
): Promise<number> {
  // Fast path: known client session, look up upstream id, forward.
  if (clientSessionId) {
    const record = store.get(clientSessionId);
    if (record) {
      const credentialToken = custodyConfig
        ? await resolveCustodiedToken(custodyConfig.state, custodyConfig.config, req.headers, record.clientSessionId)
        : undefined;
      const result = await forward(
        matched.upstreamUrl,
        req.method ?? "POST",
        req.headers,
        body,
        record.upstreamSessionId,
        timeoutMs,
        credentialToken,
        matched.config,
      );
      const text = result.body.toString("utf8");
      if (result.status === 401 && custodyConfig) {
        invalidateCustodiedToken(custodyConfig.state, custodyConfig.config, req.headers, record.clientSessionId);
      }
      if (isSessionNotFoundResponse(result.status, text)) {
        // Replay path: re-issue the cached initialize, get a fresh upstream id, retry.
        if (!record.initializePayload) {
          // No cached initialize — can't recover. Pass the failure through.
          writeResponse(res, result, clientSessionId);
          return result.status;
        }
        const replayInitResult = await forward(
          matched.upstreamUrl,
          "POST",
          buildInitializeReplayHeaders(req.headers),
          record.initializePayload,
          null,
          timeoutMs,
          credentialToken,
          matched.config,
        );
        const replayBody = replayInitResult.body.toString("utf8");
        const newUpstreamId = extractUpstreamSessionId(replayInitResult.headers, replayBody);
        if (isSuccess(replayInitResult.status) && newUpstreamId) {
          await notifyUpstreamInitialized(matched.upstreamUrl, req.headers, newUpstreamId, timeoutMs, credentialToken, matched.config);
          store.rotateUpstream(clientSessionId, newUpstreamId);
          // Retry the original call with the new upstream id.
          const retryResult = await forward(
            matched.upstreamUrl,
            req.method ?? "POST",
            req.headers,
            body,
            newUpstreamId,
            timeoutMs,
            credentialToken,
            matched.config,
          );
          writeResponse(res, retryResult, clientSessionId);
          await persistSessionStore?.();
          return retryResult.status;
        }
        // Re-init failed; pass the original 404 through so the client can recover its own way.
        writeResponse(res, result, clientSessionId);
        return result.status;
      }
      writeResponse(res, result, clientSessionId);
      return result.status;
    }
    // Client supplied a sessionId we don't know — treat as new init below.
  }

  const requestMethod = req.method ?? "POST";
  const isInitializeRequest = looksLikeInitializeRequest(bodyText);
  const nextClientSessionId = clientSessionId ?? randomUUID();
  const credentialToken = custodyConfig
    ? await resolveCustodiedToken(custodyConfig.state, custodyConfig.config, req.headers, nextClientSessionId)
    : undefined;

  if (!isInitializeRequest && requestMethod !== "GET" && requestMethod !== "HEAD" && body.length > 0) {
    const initializePayload = buildDefaultInitializePayload();
    const upstreamSessionId = await createUpstreamSession(
      matched.upstreamUrl,
      req.headers,
      initializePayload,
      timeoutMs,
      credentialToken,
      matched.config,
    );
    if (upstreamSessionId) {
      const record = store.createInitialized({
        clientSessionId: nextClientSessionId,
        upstreamSessionId,
        initializePayload,
      });
      const retryResult = await forward(
        matched.upstreamUrl,
        requestMethod,
        req.headers,
        body,
        upstreamSessionId,
        timeoutMs,
        credentialToken,
        matched.config,
      );
      writeResponse(res, retryResult, record.clientSessionId);
      await persistSessionStore?.();
      if (retryResult.status === 401 && custodyConfig) {
        invalidateCustodiedToken(custodyConfig.state, custodyConfig.config, req.headers, record.clientSessionId);
      }
      return retryResult.status;
    }
  }

  // No (known) session id. If this is an initialize call, capture the
  // response sessionId for future replay, and immediately complete the
  // upstream lifecycle so clients that omit notifications/initialized do
  // not leave the upstream session stuck in its initialization phase.
  const result = await forward(matched.upstreamUrl, requestMethod, req.headers, body, null, timeoutMs, credentialToken, matched.config);
  const text = result.body.toString("utf8");
  if (isInitializeRequest && isSuccess(result.status)) {
    const upstreamId = extractUpstreamSessionId(result.headers, text);
    if (upstreamId) {
      await notifyUpstreamInitialized(matched.upstreamUrl, req.headers, upstreamId, timeoutMs, credentialToken, matched.config);
      const record = store.createInitialized({
        clientSessionId: nextClientSessionId,
        upstreamSessionId: upstreamId,
        initializePayload: body,
      });
      writeResponse(res, result, record.clientSessionId);
      await persistSessionStore?.();
      if (result.status === 401 && custodyConfig) {
        invalidateCustodiedToken(custodyConfig.state, custodyConfig.config, req.headers, record.clientSessionId);
      }
      return result.status;
    }
  }
  writeResponse(res, result, clientSessionId ?? null);
  if (result.status === 401 && custodyConfig) {
    invalidateCustodiedToken(custodyConfig.state, custodyConfig.config, req.headers, nextClientSessionId);
  }
  return result.status;
}

interface MatchedCustodyConfig {
  readonly state: CredentialCustodyState;
  readonly config: CredentialCustodyConfig;
}

function matchedCustodyConfig(
  state: CredentialCustodyState | undefined,
  prefix: string,
  upstream: UpstreamConfig,
): MatchedCustodyConfig | undefined {
  if (upstream.execution === "tenant_node") return undefined;
  const config = configForPrefix(state, prefix);
  return state && config ? { state, config } : undefined;
}

function serveOAuthDiscovery(
  pathName: string,
  res: http.ServerResponse,
  config: OAuthDiscoveryConfig | null | undefined,
): boolean {
  if (!config) return false;
  if (pathName === "/.well-known/oauth-protected-resource" || pathName === "/.well-known/oauth-protected-resource/mcp") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      resource: config.resource,
      authorization_servers: [config.authorizationServer],
      bearer_methods_supported: ["header"],
    }));
    return true;
  }
  if (pathName === "/.well-known/oauth-authorization-server" || pathName === "/.well-known/openid-configuration") {
    res.statusCode = 307;
    res.setHeader("location", `${config.authorizationServer}${pathName}`);
    res.end();
    return true;
  }
  return false;
}

async function resolveMatchedCustodyToken(
  custodyConfig: MatchedCustodyConfig | undefined,
  inboundHeaders: http.IncomingHttpHeaders,
  clientSessionId: string,
): Promise<CredentialCustodyToken | undefined> {
  return custodyConfig
    ? resolveCustodiedToken(custodyConfig.state, custodyConfig.config, inboundHeaders, clientSessionId)
    : undefined;
}

function invalidateMatchedCustodyTokenIfUnauthorized(
  result: ForwardResult,
  custodyConfig: MatchedCustodyConfig | undefined,
  inboundHeaders: http.IncomingHttpHeaders,
  clientSessionId: string | undefined,
): void {
  if (result.status === 401 && custodyConfig && clientSessionId) {
    invalidateCustodiedToken(custodyConfig.state, custodyConfig.config, inboundHeaders, clientSessionId);
  }
}

export function createGatewayServer(state: GatewayState): http.Server {
  return http.createServer((req, res) => {
    handleRequest(req, res, state).catch((e) => safeOnError(e, req, res));
  });
}

function safeOnError(e: unknown, req: http.IncomingMessage, res: http.ServerResponse): void {
  const cause = (e as { cause?: unknown }).cause;
  const causeCode = (cause as { code?: string } | undefined)?.code;
  const causeMessage = (cause as { message?: string } | undefined)?.message;
  // A fired AbortSignal.timeout rejects with a TimeoutError; undici's own
  // header/body timeouts surface as UND_ERR_*_TIMEOUT. Either way the upstream
  // was too slow → 504 Gateway Timeout rather than a generic 502.
  const isTimeout =
    (e as Error).name === "TimeoutError" ||
    causeCode === "UND_ERR_HEADERS_TIMEOUT" ||
    causeCode === "UND_ERR_BODY_TIMEOUT";
  // eslint-disable-next-line no-console
  console.error(
    `[mcp-gateway] request handler error: method=${req.method} url=${req.url} cause=${causeCode ?? (e as Error).name}: ${causeMessage ?? (e as Error).message}`,
  );
  if (!res.headersSent) {
    res.statusCode = e instanceof CredentialCustodyError ? e.statusCode : isTimeout ? 504 : 502;
    res.setHeader("content-type", "application/json");
    if (e instanceof CredentialCustodyError && e.retryAfter) {
      res.setHeader("retry-after", e.retryAfter);
    }
    res.end(JSON.stringify({ error: isTimeout ? "gateway timeout" : "gateway error", detail: (e as Error).message }));
  } else {
    res.end();
  }
}

async function main(): Promise<void> {
  const upstreams = await loadUpstreams();
  const config = loadGatewayConfig();
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  const state: GatewayState = {
    upstreams,
    sessions: new Map(),
    upstreamCallCounts: new Map(),
    breaker: new CircuitBreaker(config.breaker),
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    credentialCustody: loadCredentialCustodyState(),
    oauthDiscovery: config.oauthDiscovery,
    sessionPersistenceFile: config.sessionPersistenceFile,
  };
  await loadPersistedSessions(state);
  state.sessionPersistenceLoaded = true;

  const server = createGatewayServer(state);

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[mcp-gateway] listening on :${port}; upstreams: ${Object.keys(upstreams).join(", ")}; ` +
        `timeout=${config.upstreamTimeoutMs}ms breaker(threshold=${config.breaker.failureThreshold},cooldown=${config.breaker.openCooldownMs}ms) ` +
        `sessionStore=${config.sessionPersistenceFile ?? "memory"}`,
    );
  });

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      // eslint-disable-next-line no-console
      console.log(`[mcp-gateway] ${sig} received, shutting down`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(`[mcp-gateway] startup failed: ${(e as Error).message}`);
    process.exit(1);
  });
}

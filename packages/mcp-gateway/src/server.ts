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
 *
 * Optionally also binds a second, probe-only listener on
 * `$PAPERCLIP_MCP_HEALTH_PORT` serving nothing but `GET /healthz`
 * (`createHealthServer`). Unset by default. It exists so a network policy can
 * deny the proxy port from the host network without denying the kubelet's
 * probes along with it — see PEN-3052.
 */

import http from "node:http";
import net from "node:net";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { scrubResponseBody, stripLeadingBom } from "./response-scrub.js";
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
import {
  buildCredentialHeaders,
  isToolAllowed,
  loadUpstreams,
  matchUpstream,
  upstreamsPrincipalHash,
  type UpstreamConfig,
  type UpstreamMap,
} from "./upstreams.js";
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
export const DEFAULT_PORT = 8080;

export interface GatewayConfig {
  port: number;
  /** Probe-only listener; null (the default) binds no second socket. */
  healthPort: number | null;
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

/**
 * Strict parse for a listener port. Deliberately not `parsePositiveInt`:
 * falling back on junk is right for a tuning knob and wrong for a port. The
 * Deployment points both kubelet probes at whatever these values say, so a typo
 * that silently resolved to some other port would leave the probes hitting a
 * closed socket — and liveness failure restarts the container. Refusing at
 * startup names the cause; falling back hides it behind a CrashLoop.
 *
 * The regex is load-bearing. `Number.parseInt` accepts "8081abc" (→ 8081),
 * "0x1f9" (→ 0) and " +8081"; a bare `Number()` accepts "Infinity". Rejecting
 * anything that is not pure digits is what makes the 1-65535 bound below mean
 * what it says.
 *
 * Applied to `PORT` as well as the health port (PEN-3052 review). `PORT="8O81"`
 * with a letter O parsed to 8 under the old lenient read, and the
 * `must differ from PORT` guard below would then have compared the health port
 * against that wrong value — the guard is only as good as the number it checks.
 */
function parsePort(raw: string | undefined, varName: string): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const port = /^[0-9]+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${varName} must be an integer in 1-65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const publicUrl = env.PAPERCLIP_MCP_PUBLIC_URL?.trim().replace(/\/+$/, "");
  const authorizationServer = env.PAPERCLIP_MCP_AUTHORIZATION_SERVER?.trim().replace(/\/+$/, "");
  if ((publicUrl && !authorizationServer) || (!publicUrl && authorizationServer)) {
    throw new Error("PAPERCLIP_MCP_PUBLIC_URL and PAPERCLIP_MCP_AUTHORIZATION_SERVER must be configured together");
  }
  const port = parsePort(env.PORT, "PORT") ?? DEFAULT_PORT;
  const healthPort = parsePort(env.PAPERCLIP_MCP_HEALTH_PORT, "PAPERCLIP_MCP_HEALTH_PORT");
  // Same port would mean one socket again, which defeats the whole point: the
  // network policy denies the proxy port by number, so the probe has to live
  // somewhere that deny does not reach. EADDRINUSE would catch it eventually,
  // but only after the proxy listener is already up and serving.
  if (healthPort !== null && healthPort === port) {
    throw new Error(
      `PAPERCLIP_MCP_HEALTH_PORT (${healthPort}) must differ from PORT (${port}); ` +
        "the health listener exists to be reachable when the proxy port is denied",
    );
  }
  return {
    port,
    healthPort,
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
  routingPrincipalHash?: string;
}

interface PersistedSessionSnapshot {
  version: 2;
  principalHash: string;
  routeBindings: Record<string, string>;
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
  if (
    !parsed ||
    parsed.version !== 2 ||
    parsed.principalHash !== (state.routingPrincipalHash ?? "") ||
    !parsed.routeBindings ||
    typeof parsed.routeBindings !== "object" ||
    !parsed.prefixes ||
    typeof parsed.prefixes !== "object"
  ) return;
  for (const [prefix, records] of Object.entries(parsed.prefixes)) {
    if (!Array.isArray(records)) continue;
    const upstream = state.upstreams[prefix];
    if (!upstream || parsed.routeBindings[prefix] !== routeBinding(upstream)) continue;
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
    version: 2,
    principalHash: state.routingPrincipalHash ?? "",
    routeBindings: Object.fromEntries(
      Object.entries(state.upstreams).map(([prefix, upstream]) => [prefix, routeBinding(upstream)]),
    ),
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

function routeBinding(upstream: UpstreamConfig): string {
  return `${upstream.execution ?? "house"}\0${upstream.routeId ?? ""}\0${upstream.url}\0${upstream.registryRevision ?? ""}`;
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
    // `stripLeadingBom` for the reason it documents: `JSON.parse` rejects a
    // leading BOM, so without this a BOM-prefixed body reads as unparseable.
    // That is not only an audit gap (the request logs as its HTTP verb rather
    // than its JSON-RPC method) — it is a fail-open, because a body we cannot
    // classify is a body the PEN-2735 tool guard cannot examine.
    const parsed = JSON.parse(stripLeadingBom(bodyText)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as JsonRpcRequest;
  } catch {
    return null;
  }
}

/**
 * The tool named by an inbound `tools/call` that this upstream may not expose,
 * or `null` if there is nothing to refuse (PEN-2735).
 *
 * Enforced on the REQUEST, before the forward, because the response filter can
 * only remove a tool from a listing — it cannot un-execute a call. Filtering
 * `tools/list` alone would leave every denied tool advertised-but-absent and
 * still perfectly callable by name, which is a partial fix that reads as a whole
 * one.
 *
 * Two shapes are checked, not one. `parseJsonRpcRequest` rejects arrays, so a
 * JSON-RPC *batch* reaches `serveMatched` with `inboundMessage === null` and is
 * forwarded unexamined — a guard written against the single-object shape alone
 * would be bypassed by wrapping the same call in `[ ]`. A batch containing any
 * denied call is refused whole rather than split: partial execution of a batch
 * is a worse contract than refusing it, and refusing is the fail-closed side.
 */
function deniedToolCall(bodyText: string, upstream: UpstreamConfig): string | null {
  if (!Array.isArray(upstream.tools)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripLeadingBom(bodyText));
  } catch {
    // Not JSON, so not a JSON-RPC tools/call. The upstream will reject it on its
    // own terms; there is no tool name here to authorize.
    return null;
  }
  for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const record = message as { method?: unknown; params?: unknown };
    if (record.method !== "tools/call") continue;
    const params = record.params;
    const name = params && typeof params === "object" && !Array.isArray(params)
      ? (params as { name?: unknown }).name
      : undefined;
    if (!isToolAllowed(upstream, name)) return typeof name === "string" ? name : "";
  }
  return null;
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
  const initialized = await notifyUpstreamInitialized(
    upstreamUrl,
    inboundHeaders,
    upstreamSessionId,
    timeoutMs,
    credentialToken,
    upstreamConfig,
  );
  if (!initialized) return null;
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
  return store.runLifecycleExclusive(async () => {
    const current = store.get(clientSessionId);
    if (current) return current.upstreamSessionId;
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
  });
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

  return store.runLifecycleExclusive(async () => {
    const current = store.get(clientSessionId);
    let retryUpstreamSessionId = current?.upstreamSessionId;
    const retryCredentialToken = await resolveMatchedCustodyToken(custodyConfig, inboundHeaders, clientSessionId);
    if (!retryUpstreamSessionId || retryUpstreamSessionId === upstreamSessionId) {
      retryUpstreamSessionId = await createUpstreamSession(
        upstream.url,
        inboundHeaders,
        initializePayload,
        state.upstreamTimeoutMs,
        retryCredentialToken,
        upstream,
        custodyConfig,
        clientSessionId,
      ) ?? undefined;
      if (!retryUpstreamSessionId) return null;
      if (current) store.rotateUpstream(clientSessionId, retryUpstreamSessionId);
      else store.createInitialized({ clientSessionId, upstreamSessionId: retryUpstreamSessionId, initializePayload });
      await persistSessions(state);
    }
    result = await forward(
      upstream.url,
      method,
      inboundHeaders,
      body,
      retryUpstreamSessionId,
      state.upstreamTimeoutMs,
      retryCredentialToken,
      upstream,
    );
    invalidateMatchedCustodyTokenIfUnauthorized(result, custodyConfig, inboundHeaders, clientSessionId);
    return result;
  });
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
    redirect: upstreamConfig?.execution === "tenant_node" ? "manual" : "follow",
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
  if (upstreamConfig?.execution === "tenant_node") {
    copyHeader(headers, inboundHeaders, "accept");
    copyHeader(headers, inboundHeaders, "content-type");
    copyHeader(headers, inboundHeaders, "last-event-id");
    copyHeader(headers, inboundHeaders, "mcp-protocol-version");
    if (!upstreamConfig.relayAuthorization) {
      throw new Error("tenant-node route is missing authenticated relay authorization");
    }
    headers.authorization = upstreamConfig.relayAuthorization;
    return headers;
  }
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

/**
 * Per-request audit line: who (source IP) called what (matched prefix +
 * JSON-RPC method, and tool name for tools/call) through the gateway. This
 * is the only record of gateway callers — the upstream MCP servers log only
 * an opaque session id, and `upstreamCallCounts`/session counts are fan-out
 * artifacts of the aggregate endpoint (one aggregate initialize/tools/list
 * touches every upstream), not a per-caller count. Emitted exactly once per
 * inbound HTTP request regardless of outcome; never includes the request
 * body, `authorization` header value, or tool-call arguments.
 */
function logMcpRequest(
  req: http.IncomingMessage,
  requestId: string,
  prefix: string,
  method: string,
  tool?: string,
): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    event: "mcp_gateway_request",
    requestId,
    sourceIp: req.socket.remoteAddress ?? "unknown",
    prefix,
    method,
    ...(tool ? { tool } : {}),
  }));
}

function jsonRpcMethodLabel(req: http.IncomingMessage, message: JsonRpcRequest | null): string {
  return message?.method ?? req.method ?? "unknown";
}

/**
 * Wrap a body the gateway itself constructed (health, JSON-RPC errors, the
 * aggregate replies) in the same shape a proxied result has, so it can leave
 * through the one chokepoint below.
 *
 * PEN-2370: routing gateway-built bodies through the scrubber too is not
 * defence against our own string literals — it is so that no author ever has
 * to decide whether a given body is "upstream-derived enough" to need
 * scrubbing. That judgement is what failed on `tools/list`, where a reply
 * assembled from upstream records was written directly. The scrub is inert on
 * a body carrying nothing it redacts, so the safe rule is also the cheap one.
 */
function gatewayResult(
  status: number,
  body: Buffer | string,
  extraHeaders: Record<string, string> = {},
): ForwardResult {
  return {
    status,
    headers: new Headers({ "content-type": "application/json", ...extraHeaders }),
    body: typeof body === "string" ? Buffer.from(body) : body,
  };
}

/**
 * The single place a response body reaches the client.
 *
 * PEN-2370: this is enforced, not merely intended — `server.test.ts` asserts
 * that `res.end` is called with a body exactly once in this file. An earlier
 * version of this comment claimed every proxied response left through here
 * while the aggregate `tools/list` reply, built by spreading upstream tool
 * records, was written directly and reached agents unscrubbed. A second
 * response path is the recurring failure in this module; the test makes
 * adding one fail CI instead of relying on the next author reading this.
 *
 * PEN-2735: `upstream` is REQUIRED rather than optional, and that is the whole
 * design. It carries the tool allowlist to apply to this body, and a required
 * parameter means a new call site that forgets it is a compile error instead of
 * a route where filtering silently stops. Pass `null` only where the body is
 * gateway-built and belongs to no upstream (health, 404, circuit-open, the
 * error path) — an explicit `null` is a statement a reviewer can check, which an
 * omitted argument is not.
 */
function writeResponse(
  res: http.ServerResponse,
  result: ForwardResult,
  exposedClientSessionId: string | null,
  upstream: UpstreamConfig | null,
): void {
  const body = scrubResponseBody(result.body, result.headers.get("content-type"), {
    toolFilter: (toolName) => (upstream ? isToolAllowed(upstream, toolName) : true),
  });

  res.statusCode = result.status;
  for (const [k, v] of result.headers.entries()) {
    // Replace upstream's session header with the stable client one.
    if (k.toLowerCase() === MCP_SESSION_HEADER) continue;
    // Skip hop-by-hop headers.
    if (k.toLowerCase() === "transfer-encoding" || k.toLowerCase() === "content-encoding") continue;
    // Scrubbing changes the body length, so the upstream's content-length no
    // longer describes what we are about to send. Forwarding it would either
    // truncate the response or hang the client waiting for bytes that never
    // arrive; Node recomputes it from the buffer we pass to end().
    if (k.toLowerCase() === "content-length") continue;
    res.setHeader(k, v);
  }
  if (exposedClientSessionId) {
    res.setHeader(MCP_SESSION_HEADER, exposedClientSessionId);
  }
  res.end(body);
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: GatewayState,
): Promise<void> {
  const requestId = randomUUID();
  const url = req.url ?? "/";
  const pathName = url.split("?", 1)[0] ?? "/";

  if (serveOAuthDiscovery(pathName, res, state.oauthDiscovery)) return;

  // Health endpoint.
  if (pathName === "/" || pathName === "/healthz") {
    writeResponse(res, gatewayResult(200, JSON.stringify({
      ok: true,
      upstreams: Object.keys(state.upstreams),
      breakers: state.breaker.snapshot(),
      upstreamCallCounts: Object.fromEntries(state.upstreamCallCounts.entries()),
      sessions: Object.fromEntries(
        Array.from(state.sessions.entries()).map(([prefix, store]) => [prefix, store.size()]),
      ),
    })), null, null);
    return;
  }

  if (pathName === "/mcp" || pathName.startsWith("/mcp/")) {
    await handleAggregateRequest(req, res, state, requestId);
    return;
  }

  const matched = matchUpstream(pathName, state.upstreams);
  if (!matched) {
    writeResponse(res, gatewayResult(404, JSON.stringify({
      error: "no upstream matched",
      path: pathName,
      knownPrefixes: Object.keys(state.upstreams),
    })), null, null);
    return;
  }
  const prefix = (() => {
    const trimmed = pathName.startsWith("/") ? pathName.slice(1) : pathName;
    const slashIdx = trimmed.indexOf("/");
    return slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx);
  })();
  // Body consumption and session-store setup can throw (aborted connection,
  // stream error, disk error loading persisted sessions) before we've parsed
  // enough of the request to log it — that would leave exactly the failing
  // calls unaccounted for in the audit trail. Emit a fallback line (matched
  // prefix + HTTP method) if anything in here throws, so every request that
  // reaches this function logs exactly once either way.
  let body: Buffer;
  let bodyText: string;
  let inboundMessage: JsonRpcRequest | null;
  try {
    await ensurePersistedSessionsLoaded(state);
    body = await readBody(req);
    bodyText = body.toString("utf8");
    inboundMessage = parseJsonRpcRequest(bodyText);
  } catch (e) {
    logMcpRequest(req, requestId, prefix, jsonRpcMethodLabel(req, null));
    throw e;
  }
  const store = getOrCreateStore(state, prefix);
  state.upstreamCallCounts.set(prefix, (state.upstreamCallCounts.get(prefix) ?? 0) + 1);
  const clientSessionId = (() => {
    const v = req.headers[MCP_SESSION_HEADER];
    return Array.isArray(v) ? v[0] : (v as string | undefined);
  })();

  const logMethod = jsonRpcMethodLabel(req, inboundMessage);
  const logTool = logMethod === "tools/call" && typeof inboundMessage?.params?.name === "string"
    ? inboundMessage.params.name
    : undefined;
  logMcpRequest(req, requestId, prefix, logMethod, logTool);

  // PEN-2735: refuse a call to a tool this upstream is not permitted to expose,
  // before it reaches the upstream. Placed after the audit line on purpose — a
  // refused attempt is exactly the event an audit trail should carry — and
  // before the breaker, since a call we never forwarded is not evidence about
  // upstream health either way.
  const denied = deniedToolCall(bodyText, matched.config);
  if (denied !== null) {
    writeResponse(
      res,
      gatewayResult(200, buildJsonRpcError(inboundMessage?.id ?? null, -32602, `unknown tool "${denied}"`)),
      clientSessionId ?? null,
      null,
    );
    return;
  }

  // Circuit breaker: if this upstream has been failing (hung / OOMing /
  // unreachable), fail fast with 503 instead of forwarding into it and
  // accumulating buffered in-flight requests until the gateway OOMs.
  if (!state.breaker.tryAcquire(prefix)) {
    writeResponse(res, gatewayResult(503, JSON.stringify({ error: "upstream circuit open", prefix }), {
      "retry-after": String(Math.ceil(state.upstreamTimeoutMs / 1000)),
    }), null, null);
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
  requestId: string,
): Promise<void> {
  // See the matching comment in handleRequest: log a fallback line if setup
  // or body consumption throws, so a failure here isn't left unaccounted for.
  let body: Buffer;
  let bodyText: string;
  let message: JsonRpcRequest | null;
  try {
    await ensurePersistedSessionsLoaded(state);
    body = await readBody(req);
    bodyText = body.toString("utf8");
    message = parseJsonRpcRequest(bodyText);
  } catch (e) {
    logMcpRequest(req, requestId, "*", jsonRpcMethodLabel(req, null));
    throw e;
  }
  const inboundSessionId = (() => {
    const v = req.headers[MCP_SESSION_HEADER];
    return Array.isArray(v) ? v[0] : (v as string | undefined);
  })();
  const clientSessionId = inboundSessionId || randomUUID();
  const initializePayload = looksLikeInitializeRequest(bodyText) ? body : buildDefaultInitializePayload();

  // Exactly one line per inbound request, even for `initialize`/`tools/list`,
  // which fan out to every upstream below — the requestId (and, for
  // `tools/call`, the resolved prefix) is what makes that fan-out
  // attributable to a single caller rather than ten indistinguishable lines.
  const logMethod = jsonRpcMethodLabel(req, message);
  const logTool = logMethod === "tools/call" && typeof message?.params?.name === "string"
    ? message.params.name
    : undefined;
  const logToolSeparatorIndex = logTool ? logTool.indexOf("__") : -1;
  const logPrefix = logToolSeparatorIndex > 0 ? logTool!.slice(0, logToolSeparatorIndex) : "*";
  logMcpRequest(req, requestId, logPrefix, logMethod, logTool);

  if (!message?.method) {
    writeResponse(res, gatewayResult(400, JSON.stringify({ error: "invalid JSON-RPC request" })), null, null);
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
    writeResponse(res, gatewayResult(200, buildJsonRpcResponse(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "paperclip-mcp-gateway", version: "0.1.0" },
    })), clientSessionId, null);
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
          // PEN-2735: authorize on the UPSTREAM name, before the `prefix__` is
          // added — the same question the prefixed route asks of the same
          // predicate, so the two routes cannot disagree about what is exposed.
          if (!isToolAllowed(upstream, record.name)) continue;
          tools.push({ ...record, name: `${prefix}__${record.name}` });
        }
      } catch (e) {
        if (!(e instanceof CredentialCustodyError)) state.breaker.recordFailure(prefix);
        // eslint-disable-next-line no-console
        console.warn(`[mcp-gateway] aggregate tools/list skipped prefix=${prefix}: ${(e as Error).message}`);
      }
    }
    writeResponse(res, gatewayResult(200, buildJsonRpcResponse(message.id, { tools })), clientSessionId, null);
    return;
  }

  if (message.method === "tools/call") {
    const toolName = typeof message.params?.name === "string" ? message.params.name : "";
    const separatorIndex = toolName.indexOf("__");
    const prefix = separatorIndex > 0 ? toolName.slice(0, separatorIndex) : "";
    const upstreamToolName = separatorIndex > 0 ? toolName.slice(separatorIndex + 2) : "";
    const upstream = prefix ? state.upstreams[prefix] : undefined;
    // A tool the allowlist denies is reported exactly as a tool that does not
    // exist. That is not obfuscation for its own sake — it is the truthful
    // answer, because the same allowlist kept it out of `tools/list`, so from
    // this client's view it genuinely is not an aggregated tool. Splitting this
    // into a distinct "forbidden" branch would make the gateway advertise the
    // existence of what it just refused to expose.
    if (!upstream || upstreamToolName.length === 0 || !isToolAllowed(upstream, upstreamToolName)) {
      writeResponse(res, gatewayResult(200, buildJsonRpcError(message.id, -32602, `unknown aggregated tool name "${toolName}"`)), clientSessionId, null);
      return;
    }
    if (!state.breaker.tryAcquire(prefix)) {
      writeResponse(res, gatewayResult(503, JSON.stringify({ error: "upstream circuit open", prefix }), {
        "retry-after": String(Math.ceil(state.upstreamTimeoutMs / 1000)),
      }), null, null);
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
      writeResponse(res, gatewayResult(502, JSON.stringify({ error: "failed to initialize upstream session", prefix })), null, null);
      return;
    }
    if (result.status >= 500) state.breaker.recordFailure(prefix);
    else state.breaker.recordSuccess(prefix);
    writeResponse(res, result, clientSessionId, upstream);
    return;
  }

  writeResponse(res, gatewayResult(200, buildJsonRpcError(message.id, -32601, `method "${message.method}" is not supported by aggregate endpoint`)), clientSessionId, null);
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
      const attemptedUpstreamSessionId = record.upstreamSessionId;
      const credentialToken = custodyConfig
        ? await resolveCustodiedToken(custodyConfig.state, custodyConfig.config, req.headers, record.clientSessionId)
        : undefined;
      const result = await forward(
        matched.upstreamUrl,
        req.method ?? "POST",
        req.headers,
        body,
        attemptedUpstreamSessionId,
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
          writeResponse(res, result, clientSessionId, matched.config);
          return result.status;
        }
        const retryResult = await store.runLifecycleExclusive(async () => {
          const current = store.get(clientSessionId);
          let retryUpstreamId = current?.upstreamSessionId;
          if (!retryUpstreamId || retryUpstreamId === attemptedUpstreamSessionId) {
            retryUpstreamId = await createUpstreamSession(
              matched.upstreamUrl,
              req.headers,
              record.initializePayload!,
              timeoutMs,
              credentialToken,
              matched.config,
            ) ?? undefined;
            if (!retryUpstreamId) return null;
            if (current) store.rotateUpstream(clientSessionId, retryUpstreamId);
            else store.createInitialized({
              clientSessionId,
              upstreamSessionId: retryUpstreamId,
              initializePayload: record.initializePayload!,
            });
            await persistSessionStore?.();
          }
          return forward(
            matched.upstreamUrl,
            req.method ?? "POST",
            req.headers,
            body,
            retryUpstreamId,
            timeoutMs,
            credentialToken,
            matched.config,
          );
        });
        if (retryResult) {
          writeResponse(res, retryResult, clientSessionId, matched.config);
          return retryResult.status;
        }
        // Re-init failed; pass the original 404 through so the client can recover its own way.
        writeResponse(res, result, clientSessionId, matched.config);
        return result.status;
      }
      writeResponse(res, result, clientSessionId, matched.config);
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
    const bootstrapResult = await store.runLifecycleExclusive(async () => {
      const current = store.get(nextClientSessionId);
      if (current) {
        const result = await forward(
          matched.upstreamUrl,
          requestMethod,
          req.headers,
          body,
          current.upstreamSessionId,
          timeoutMs,
          credentialToken,
          matched.config,
        );
        return { result, clientSessionId: current.clientSessionId };
      }
      const initializePayload = buildDefaultInitializePayload();
      const upstreamSessionId = await createUpstreamSession(
        matched.upstreamUrl,
        req.headers,
        initializePayload,
        timeoutMs,
        credentialToken,
        matched.config,
      );
      if (!upstreamSessionId) return null;
      const record = store.createInitialized({
        clientSessionId: nextClientSessionId,
        upstreamSessionId,
        initializePayload,
      });
      await persistSessionStore?.();
      const result = await forward(
        matched.upstreamUrl,
        requestMethod,
        req.headers,
        body,
        upstreamSessionId,
        timeoutMs,
        credentialToken,
        matched.config,
      );
      return { result, clientSessionId: record.clientSessionId };
    });
    if (bootstrapResult) {
      writeResponse(res, bootstrapResult.result, bootstrapResult.clientSessionId, matched.config);
      if (bootstrapResult.result.status === 401 && custodyConfig) {
        invalidateCustodiedToken(custodyConfig.state, custodyConfig.config, req.headers, bootstrapResult.clientSessionId);
      }
      return bootstrapResult.result.status;
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
      writeResponse(res, result, record.clientSessionId, matched.config);
      await persistSessionStore?.();
      if (result.status === 401 && custodyConfig) {
        invalidateCustodiedToken(custodyConfig.state, custodyConfig.config, req.headers, record.clientSessionId);
      }
      return result.status;
    }
  }
  writeResponse(res, result, clientSessionId ?? null, matched.config);
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
    writeResponse(res, gatewayResult(200, JSON.stringify({
      resource: config.resource,
      authorization_servers: [config.authorizationServer],
      bearer_methods_supported: ["header"],
    })), null, null);
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

function writeHealthResponse(res: http.ServerResponse, status: number, payload: unknown): void {
  // Through the same chokepoint as every other body in this process. Nothing
  // here is upstream-derived, so the scrubber is a no-op on it — but PEN-2370's
  // guard is "exactly one exit", not "one exit plus the ones we vouched for",
  // and a second `res.end(body)` is how that invariant stops being checkable.
  writeResponse(res, gatewayResult(status, JSON.stringify(payload)), null, null);
}

/**
 * Probe-only listener, bound on `PAPERCLIP_MCP_HEALTH_PORT` (PEN-3052).
 *
 * Why a second socket exists at all: the kubelet probes a pod from the *node's*
 * host network, so a CiliumNetworkPolicy that denies the proxy port from
 * `fromEntities: [host, remote-node]` denies the probe along with the bypass it
 * is closing. On this Deployment both probes target the proxy port and liveness
 * failure restarts the container, so adding that deny without first moving the
 * probes off that port CrashLoops the gateway.
 *
 * ⛔ This server must never route to an upstream. The deny it exists to permit
 * names ONE port; anything reachable here is reachable around that deny, so a
 * proxying health listener would be a wider hole than the one being closed. The
 * `does not proxy` cases in server.test.ts pin that.
 *
 * The body is deliberately barer than `/healthz` on the proxy port, which
 * reports upstream names, breaker state and per-prefix session counts. No deny
 * covers this port, so treat everything it emits as readable by anything that
 * can route to the pod.
 *
 * `isServing` keeps the signal honest. A static 200 would report healthy with
 * the proxy listener closed — strictly weaker than the probe it replaces, which
 * at least had to reach the proxy socket to answer. It may return a promise;
 * see `createProxyAcceptProbe` for why the production one does.
 */
export function createHealthServer(isServing: () => boolean | Promise<boolean>): http.Server {
  // Bounded in the constructor rather than as properties at the `listen` call
  // site, for two reasons: a second caller cannot then bind this server
  // unbounded, and `connectionsCheckingInterval` is settable ONLY here
  // (PEN-3052 review).
  //
  // Why this listener needs tighter bounds than Node's defaults (60s headers,
  // 300s request): it sits OUTSIDE the deny by construction — that is the
  // entire reason it exists — so it is reachable by exactly the `host` /
  // `remote-node` entities the deny excludes from the proxy port, with nothing
  // in front of it authenticating.
  //
  // `connectionsCheckingInterval` is the load-bearing line and is the easy one
  // to omit. Node arms no per-socket timer for `headersTimeout` /
  // `requestTimeout`; it sweeps for expired connections from `checkConnections`
  // on an interval that defaults to 30_000ms, so a byte-silent socket survives
  // until the first sweep *after* the timeout elapses. Measured on this shape:
  // 30040ms to enforce a 2s `headersTimeout` at the default interval, against
  // ~2–3s at 1_000ms (measured 2007ms). Because the reap lands on a sweep and
  // not on a per-socket timer, that is a range whose floor is the timeout and
  // whose ceiling is one interval past it; 2007ms is a sample at the floor, not
  // the enforcement figure to compute from. Without this line the bound stated
  // below and in README.md is ~15x looser than written — which is exactly the
  // arithmetic the cost of holding a socket here is computed from.
  //
  // `keepAliveTimeout` reclaims an idle keep-alive socket in 2s rather than
  // Node's 5s. Read that narrowly: it bounds the idle and the malformed socket,
  // not a determined client. `requestTimeout` restarts per request, so anything
  // willing to send one cheap request per keep-alive window — roughly 40 bytes
  // every 2s — holds its socket indefinitely. What these timeouts bound is the
  // cost *per socket*, as a floor under the holder's effort. They do not bound
  // how many sockets are held, and neither does anything else here; see the
  // `maxConnections` block below for why that is accepted rather than capped.
  const health = http.createServer(
    {
      connectionsCheckingInterval: 1_000,
      headersTimeout: 2_000,
      requestTimeout: 5_000,
      keepAliveTimeout: 2_000,
    },
    (req, res) => {
      const pathName = (req.url ?? "/").split("?", 1)[0] ?? "/";
      if (pathName !== "/" && pathName !== "/healthz") {
        writeHealthResponse(res, 404, { error: "not found" });
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        writeHealthResponse(res, 405, { error: "method not allowed" });
        return;
      }
      void (async () => {
        let serving: boolean;
        try {
          serving = await isServing();
        } catch {
          // A liveness signal that throws must read as unhealthy, never as a
          // thrown request. Failing closed here is the whole point of the check.
          serving = false;
        }
        try {
          if (!serving) {
            writeHealthResponse(res, 503, { ok: false, error: "proxy listener is not accepting connections" });
            return;
          }
          writeHealthResponse(res, 200, { ok: true });
        } catch {
          // The probe hung up while the check was in flight. Nothing to report
          // to and nobody to report it — but this handler is now async, so an
          // escaping rejection would be an unhandled rejection, which Node 22
          // turns into a process exit. On the liveness listener that is the one
          // outcome worth more than a dropped response.
          res.destroy();
        }
      })();
    },
  );

  // Deliberately NO `maxConnections` (PEN-3052 review). An earlier revision set
  // it to 64, reasoning that `createProxyAcceptProbe` needs an fd, so unbounded
  // socket-holding here could push the process toward fd pressure, fail the
  // probe, and turn a 503 into a liveness restart of the authenticated proxy.
  // At 64 the cap does not prevent that outcome. It makes it enormously cheaper
  // to cause — 64 sockets instead of the process fd limit.
  //
  // Node drops the *incoming* socket once `_connections >= maxConnections`
  // (`net.js` `onconnection` closes the new handle with no response), so the
  // sockets already held win and the kubelet's next probe connection is the one
  // refused. Measured against a cap: ECONNRESET with no HTTP status, in 9ms.
  // Three of those is a liveness failure and a restart of the authenticated
  // proxy — the exact outcome these bounds exist to put further out of reach.
  //
  // The review that produced this block offered a second branch — keep a cap
  // but set it well clear of anything a probe contends with — and that branch
  // is ACCEPTED AGAINST rather than refuted. It is a real proposal: a cap
  // bounds something the timeouts above do not, namely how many descriptors
  // this unauthenticated listener can take from the process. The cost of
  // exhausting them is not confined to this port, which is the part worth
  // stating plainly — an fd-exhausted process cannot accept on the proxy port
  // and cannot open outbound sockets to upstreams, so the authenticated proxy
  // is already degraded for the window before liveness notices and restarts.
  //
  // It is still not taken, for three reasons, recorded so the next reader does
  // not have to re-derive them:
  //   1. Both designs end in a restart. Anything able to hold sockets here
  //      causes one either way; a high cap changes only whether the proxy keeps
  //      serving during the window before it.
  //   2. It buys that window by LOWERING the effort needed to trigger the
  //      restart — from the process fd limit down to the cap. That is the same
  //      trade the 64 cap was rejected for, moved along the axis, not off it.
  //   3. A constant cannot be shown to bind. The fd limit is set by the
  //      container runtime, not here, so any fixed cap is either inert (limit
  //      far above it) or load-bearing (limit near it) depending on where this
  //      is deployed. A stated bound that silently does not bind is worse than
  //      a recorded acceptance, which is what this block is.
  //
  // So: unbounded descriptor consumption on this port is ACCEPTED. What stands
  // against it is the timeouts above, which put a floor under the per-socket
  // cost of holding this port, and the deny-scoping of who can route to it at
  // all — not a cap. If that scoping is ever widened, this is the paragraph to
  // revisit, and a cap derived from the live fd limit rather than a constant is
  // the form to revisit it in.
  //
  // Unchanged deliberate non-change: an EMFILE that happens anyway still reads
  // as 503, not 200. A process out of descriptors is accurately described as
  // "not serving", and a restart is the correct recovery; masking it would be
  // the bug. That is a separate question from the one above — it is about the
  // honesty of the signal once descriptors are gone, not about bounding them.
  return health;
}

/**
 * Accept-path liveness for the proxy listener (PEN-3052 review).
 *
 * `server.listening` is a bare `!!this._handle` check, so it stays true for a
 * socket that is *bound* but no longer *accepting*. That distinction did not
 * matter while the kubelet probed the proxy port directly — a wedged accept
 * queue timed the probe out and liveness restarted the pod. The moment both
 * probes move to the health port, the same state would answer `200 {ok:true}`
 * and the pod would never self-heal. Recovering a wedged listener is precisely
 * what liveness is for, so the check has to actually open a connection.
 *
 * A pod-local loopback connect is outside the deny this listener exists to
 * permit: `fromEntities: [host, remote-node]` does not match traffic the pod
 * originates to itself. `server.listen(port, cb)` is called with no host, so
 * Node binds `::`/`0.0.0.0` and a `127.0.0.1` connect lands either way — this
 * is not the `localhost` → `::1` hazard.
 *
 * That address is fixed rather than an option (PEN-3052 review). Loopback is
 * the only value for which the paragraph above holds; an override would be an
 * invitation to probe an address the deny does cover, which would report the
 * deny's verdict rather than this process's. The one caller that passed it was
 * the connect-timeout test, which now mocks `net.connect` outright.
 *
 * What this does and does not catch, stated precisely so the next reader does
 * not over-trust it:
 *   - **Saturated accept queue** → caught. Linux drops the SYN once the queue
 *     is full (`tcp_abort_on_overflow=0`), the connect never completes, the
 *     timeout fires, 503.
 *   - **Blocked event loop** → caught, but by the health handler sharing that
 *     loop, not by this probe. The kernel completes the handshake without the
 *     process, so the connect itself is unaffected by the stall — but the
 *     *verdict* was, until the `setImmediate` at the timeout below. Node
 *     services the timers phase before the poll phase, so a loop that was
 *     blocked past `timeoutMs` delivers the expired timer first and the
 *     already-completed connect second; `finish(false)` won that race and the
 *     probe reported a healthy listener wedged. Measured on a healthy
 *     `http.Server` under a 400ms synchronous stall: 20 of 40 trials `false`
 *     before the deferral, 0 of 40 after (PEN-3052 review).
 *
 *     That verdict mattered more than a dropped sample, which is why it is
 *     fixed rather than noted: this probe's 250ms timeout is 4x stricter than
 *     the kubelet's 1s default `timeoutSeconds`, and the result is cached for
 *     `ttlMs`, so one stall could outlive the request that caused it. The
 *     handler going quiet under the kubelet's own timeout is the intended
 *     detection for a blocked loop; this probe must not quietly tighten it
 *     into a restart on transient loop latency.
 *
 * The result is cached for `ttlMs` because nothing in front of this port
 * authenticates. Without it, each unauthenticated health request would open a
 * fresh connection to the proxy listener — a small amplification into the very
 * accept queue being measured. One connect per TTL bounds that regardless of
 * request rate, and is still far finer-grained than the 5s/15s probe periods.
 *
 * Two properties of that cache are load-bearing rather than incidental
 * (PEN-3052 review):
 *   - The window is measured on `performance.now()`, not `Date.now()`. A
 *     backwards wall-clock step (NTP correction, VM snapshot restore, resume
 *     from suspend) makes `now - at` negative, which compares as *inside* the
 *     TTL — pinning the cached answer for the whole duration of the jump. A
 *     pinned `true` is exactly the stale positive this probe exists to avoid.
 *   - An in-flight connect is shared regardless of age. `ttlMs` and
 *     `timeoutMs` are independent options, so a caller passing
 *     `timeoutMs > ttlMs` would otherwise get the inverse of the documented
 *     behaviour: unbounded concurrent connects, worst exactly when the accept
 *     queue is wedged and every connect is running to its full timeout. This
 *     cannot pin a stale result, because `connectOnce` always settles within
 *     `timeoutMs` plus one loop turn — the socket timeout is armed before any
 *     await point, and the `setImmediate` below adds that single turn.
 */
export function createProxyAcceptProbe(
  port: number,
  { timeoutMs = 250, ttlMs = 1000 }: { timeoutMs?: number; ttlMs?: number } = {},
): () => Promise<boolean> {
  let cached: { at: number; result: Promise<boolean>; pending: boolean } | null = null;

  const connectOnce = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        // Torn down immediately rather than lingering: the probe wants its fd
        // back, and a connection that sent no bytes is a no-op for the http
        // server on the other end — it registers no `clientError`, which is
        // raised for parse failures, not for a peer that never spoke.
        socket.destroy();
        resolve(ok);
      };
      // `setImmediate` rather than deciding in the timer callback (PEN-3052
      // review). A fired timer means `timeoutMs` elapsed; it does NOT mean the
      // accept queue is wedged, because the loop being blocked expires the
      // timer just as readily. Node runs timers before poll, so on resume the
      // expired timer is serviced before a connect the kernel already
      // completed. Deferring to the check phase puts the decision after poll,
      // so that connect lands first; `finish` is idempotent via `settled`, so
      // this becomes a no-op rather than a second verdict. Costs one loop turn
      // on a genuine timeout, against 250ms.
      socket.setTimeout(timeoutMs, () => setImmediate(() => finish(false)));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });

  return () => {
    const now = performance.now();
    if (cached && (cached.pending || now - cached.at < ttlMs)) return cached.result;
    const result = connectOnce();
    const entry = { at: now, result, pending: true };
    cached = entry;
    void result.then(() => {
      entry.pending = false;
    });
    return result;
  };
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
    // `detail` is an error message, and an upstream failure can quote the body
    // that caused it — so this path carries upstream text too, which is why it
    // goes through the chokepoint rather than straight out.
    writeResponse(res, gatewayResult(
      e instanceof CredentialCustodyError ? e.statusCode : isTimeout ? 504 : 502,
      JSON.stringify({ error: isTimeout ? "gateway timeout" : "gateway error", detail: (e as Error).message }),
      e instanceof CredentialCustodyError && e.retryAfter ? { "retry-after": e.retryAfter } : {},
    ), null, null);
  } else {
    res.end();
  }
}

async function main(): Promise<void> {
  const upstreams = await loadUpstreams();
  const config = loadGatewayConfig();
  const port = config.port;
  const state: GatewayState = {
    upstreams,
    sessions: new Map(),
    upstreamCallCounts: new Map(),
    breaker: new CircuitBreaker(config.breaker),
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    credentialCustody: loadCredentialCustodyState(),
    oauthDiscovery: config.oauthDiscovery,
    sessionPersistenceFile: config.sessionPersistenceFile,
    routingPrincipalHash: upstreamsPrincipalHash(),
  };
  await loadPersistedSessions(state);
  state.sessionPersistenceLoaded = true;

  const server = createGatewayServer(state);
  let healthServer: http.Server | null = null;

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[mcp-gateway] listening on :${port}; upstreams: ${Object.keys(upstreams).join(", ")}; ` +
        `timeout=${config.upstreamTimeoutMs}ms breaker(threshold=${config.breaker.failureThreshold},cooldown=${config.breaker.openCooldownMs}ms) ` +
        `sessionStore=${config.sessionPersistenceFile ?? "memory"}`,
    );

    // Started from inside the proxy listener's callback so the health port can
    // never be up while the proxy socket is unbound — the one window in which
    // a 200 here would be a lie that `isServing` cannot catch.
    if (config.healthPort === null) return;
    const acceptProbe = createProxyAcceptProbe(port);
    // Both conditions, cheapest first: `listening` settles the unbound case
    // without opening a socket, the probe settles the bound-but-wedged one.
    const health = createHealthServer(async () => server.listening && (await acceptProbe()));

    // Bind failure only. The Deployment points both probes at this port, so a
    // port that never comes up kills the container regardless; exiting here
    // makes the cause legible instead of surfacing as an unexplained
    // CrashLoopBackOff with a healthy-looking proxy log above it.
    //
    // Scoped to the bind window on purpose (PEN-3052 review). Left registered
    // for the server's lifetime, this would turn any later socket error on the
    // *non-essential* listener — EMFILE on accept under fd pressure being the
    // realistic one in a proxy — into an immediate kill that drops in-flight
    // MCP requests and skips the SIGTERM drain below. Post-bind, log and let
    // liveness drive a graceful restart; that path is strictly better.
    const onBindError = (e: Error): void => {
      // eslint-disable-next-line no-console
      console.error(`[mcp-gateway] health listener on :${config.healthPort} failed to bind: ${e.message}`);
      process.exit(1);
    };
    health.once("error", onBindError);
    healthServer = health;
    health.listen(config.healthPort, () => {
      // Bind succeeded: swap the kill for a log. From here on a socket error is
      // the probe's problem to report, not a reason to drop live traffic.
      health.off("error", onBindError);
      health.on("error", (e: Error) => {
        // eslint-disable-next-line no-console
        console.error(
          `[mcp-gateway] health listener on :${config.healthPort} error after bind: ${e.message} ` +
            "(left running; liveness will restart the pod if probes stop succeeding)",
        );
      });
      // eslint-disable-next-line no-console
      console.log(`[mcp-gateway] health listening on :${config.healthPort} (GET /healthz)`);
    });
  });

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      // eslint-disable-next-line no-console
      console.log(`[mcp-gateway] ${sig} received, shutting down`);
      // Health first so the probe port stops answering immediately. That is all
      // the ordering buys, and it is worth being precise about what it does not:
      // the pod leaves its Service endpoints because the EndpointSlice
      // controller acts on its `deletionTimestamp`, which it gets concurrently
      // with this signal — not because readiness flipped. Readiness could not
      // flip in time anyway. It needs `failureThreshold` consecutive failures,
      // i.e. `periodSeconds × (failureThreshold − 1)` ≈ 10s at the documented
      // `periodSeconds: 5` / `failureThreshold: 3` (see README), which outlasts
      // the 5s cap below; the process is gone before the kubelet records a
      // single failure. Making readiness the mechanism is a Deployment-side
      // change — a longer `terminationGracePeriodSeconds` and a drain to match
      // — not something this ordering can deliver.
      healthServer?.close();
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

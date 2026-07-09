import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_SESSION_HEADER } from "./session-keepalive.js";
import { buildInitializeReplayHeaders, createGatewayServer, type GatewayState } from "./server.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import {
  DEFAULT_CREDENTIAL_CUSTODY_TOKEN_CACHE_MAX_ENTRIES,
  loadCredentialCustodyState,
  type CredentialCustodyState,
} from "./credential-custody.js";

interface StrictMcpUpstream {
  server: http.Server;
  url: string;
  methods: string[];
  receivedHeaders: http.IncomingHttpHeaders[];
  receivedToolCalls: string[];
  clearSessions: () => void;
  rejectNextInitialize: () => void;
  close: () => Promise<void>;
}

interface CustodyService {
  url: string;
  leaseRequests: Array<{ authorization?: string; mcpSessionId?: string }>;
  credentialRequests: string[];
  close: () => Promise<void>;
}

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function createStrictMcpUpstream(tools: Array<Record<string, unknown>> = [{ name: "ping", description: "Ping" }]): Promise<StrictMcpUpstream> {
  let nextSession = 1;
  let rejectNextInitialize = false;
  const sessions = new Map<string, { initialized: boolean }>();
  const methods: string[] = [];
  const receivedHeaders: http.IncomingHttpHeaders[] = [];
  const receivedToolCalls: string[] = [];
  const server = http.createServer(async (req, res) => {
    receivedHeaders.push(req.headers);
    const bodyText = await readBody(req);
    const message = JSON.parse(bodyText) as { id?: number; method?: string };
    const method = message.method ?? "";
    methods.push(method);

    if (method === "initialize") {
      if (rejectNextInitialize) {
        rejectNextInitialize = false;
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "init failed" }));
        return;
      }
      const sessionId = `upstream-${nextSession++}`;
      sessions.set(sessionId, { initialized: false });
      res.statusCode = 200;
      res.setHeader(MCP_SESSION_HEADER, sessionId);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 0, result: { protocolVersion: "2024-11-05" } }));
      return;
    }

    const sessionId = req.headers[MCP_SESSION_HEADER];
    const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (!session) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    if (method === "notifications/initialized") {
      session.initialized = true;
      res.statusCode = 202;
      res.end();
      return;
    }

    if (!session.initialized) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: `method "${method}" is invalid during session initialization` }));
      return;
    }

    if (method === "tools/list") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 1, result: { tools } }));
      return;
    }

    if (method === "tools/call") {
      const params = (message as { params?: { name?: string } }).params;
      receivedToolCalls.push(params?.name ?? "");
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 1, result: { content: [{ type: "text", text: params?.name ?? "" }] } }));
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 1, result: { ok: true } }));
  });
  const url = await listen(server);
  return {
    server,
    url,
    methods,
    receivedHeaders,
    receivedToolCalls,
    clearSessions: () => sessions.clear(),
    rejectNextInitialize: () => {
      rejectNextInitialize = true;
    },
    close: () => closeServer(server),
  };
}

/**
 * POST to the gateway over a raw HTTP/1.1 connection using chunked transfer
 * encoding (Node sets `Transfer-Encoding: chunked` automatically when a body
 * is written without a Content-Length). This faithfully reproduces what the
 * upstream auth-proxy does for some requests — and what the global `fetch`
 * client cannot send (undici forbids a caller-set transfer-encoding header).
 */
function postChunked(url: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers, // no content-length → Node frames the body as chunked
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function createHangingUpstream(): Promise<{ url: string }> {
  // Never responds — models a hung/dead upstream (figma's OOM / websocket-drop
  // state) so the gateway's own timeout + circuit breaker are exercised rather
  // than inheriting undici's ~300s default timeout.
  const server = http.createServer(() => {
    /* intentionally never calls res.end() */
  });
  const url = await listen(server);
  return { url };
}

async function createRejectingInitializeUpstream(): Promise<{ url: string; methods: string[] }> {
  const methods: string[] = [];
  const server = http.createServer(async (req, res) => {
    const bodyText = await readBody(req);
    const message = JSON.parse(bodyText) as { method?: string };
    methods.push(message.method ?? "");
    if (message.method === "initialize") {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "init failed" }));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  });
  const url = await listen(server);
  return { url, methods };
}

async function createGateway(
  upstreamUrl: string,
  opts?: { timeoutMs?: number; failureThreshold?: number },
): Promise<{ url: string; state: GatewayState }> {
  const state: GatewayState = {
    upstreams: { "k8s-admin": { url: upstreamUrl, credentialHeaders: [] } },
    sessions: new Map(),
    upstreamCallCounts: new Map(),
    upstreamTimeoutMs: opts?.timeoutMs ?? 60_000,
    breaker: new CircuitBreaker({
      failureThreshold: opts?.failureThreshold ?? 5,
      openCooldownMs: 30_000,
      halfOpenMaxProbes: 1,
    }),
  };
  const server = createGatewayServer(state);
  const url = await listen(server);
  return { url: url.replace(/\/mcp$/, "/k8s-admin/mcp"), state };
}

async function createFigmaGateway(
  upstreamUrl: string,
  custodyUrl: string,
  opts?: { custodyTimeoutMs?: number; maxTokenCacheEntries?: number },
): Promise<{ url: string; state: GatewayState }> {
  const custody: CredentialCustodyState = {
    configs: {
      figma: {
        prefix: "figma",
        app: "figma",
        leaseUrl: `${custodyUrl}/leases`,
        credentialBaseUrl: `${custodyUrl}/credentials`,
        controlPlaneTimeoutMs: opts?.custodyTimeoutMs ?? 60_000,
        leaseMode: "exclusive",
        leaseTtlMs: 60_000,
        upstreamAuthorizationScheme: "Bearer",
      },
    },
    tokenCache: new Map(),
    maxTokenCacheEntries: opts?.maxTokenCacheEntries ?? DEFAULT_CREDENTIAL_CUSTODY_TOKEN_CACHE_MAX_ENTRIES,
  };
  const state: GatewayState = {
    upstreams: { figma: upstreamUrl },
    sessions: new Map(),
    upstreamTimeoutMs: 60_000,
    upstreamCallCounts: new Map(),
    breaker: new CircuitBreaker({
      failureThreshold: 5,
      openCooldownMs: 30_000,
      halfOpenMaxProbes: 1,
    }),
    credentialCustody: custody,
  };
  const server = createGatewayServer(state);
  const url = await listen(server);
  return { url: url.replace(/\/mcp$/, "/figma/mcp"), state };
}

async function createAggregateGateway(
  upstreams: GatewayState["upstreams"],
  opts?: { sessionPersistenceFile?: string; timeoutMs?: number; failureThreshold?: number },
): Promise<{ url: string; state: GatewayState }> {
  const state: GatewayState = {
    upstreams,
    sessions: new Map(),
    upstreamCallCounts: new Map(),
    upstreamTimeoutMs: opts?.timeoutMs ?? 60_000,
    sessionPersistenceFile: opts?.sessionPersistenceFile,
    breaker: new CircuitBreaker({
      failureThreshold: opts?.failureThreshold ?? 5,
      openCooldownMs: 30_000,
      halfOpenMaxProbes: 1,
    }),
  };
  const server = createGatewayServer(state);
  const url = await listen(server);
  return { url: url.replace(/\/mcp$/, "/mcp"), state };
}

async function createCustodyService(opts?: {
  credentialValue?: string;
  credentialValueForRequest?: (request: { authorization?: string; mcpSessionId?: string }) => string;
  failRepeatedLeaseForSession?: boolean;
  leaseFailureStatus?: number;
  hangLease?: boolean;
  hangCredential?: boolean;
}): Promise<CustodyService> {
  const leaseRequests: Array<{ authorization?: string; mcpSessionId?: string }> = [];
  const credentialRequests: string[] = [];
  const activeLeases = new Set<string>();
  const issuedCredentials = new Map<string, string>();
  const server = http.createServer(async (req, res) => {
    const bodyText = await readBody(req);
    if (req.url === "/leases" && req.method === "POST") {
      const body = JSON.parse(bodyText) as { mcp_session_id?: string };
      if (opts?.hangLease) {
        return;
      }
      if (opts?.leaseFailureStatus) {
        res.statusCode = opts.leaseFailureStatus;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "lease failed" }));
        return;
      }
      if (opts?.failRepeatedLeaseForSession && body.mcp_session_id && activeLeases.has(body.mcp_session_id)) {
        res.statusCode = 409;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "exclusive lease already held" }));
        return;
      }
      const leaseRequest = {
        authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
        mcpSessionId: body.mcp_session_id,
      };
      leaseRequests.push(leaseRequest);
      if (body.mcp_session_id) activeLeases.add(body.mcp_session_id);
      const credentialRef = `figma-mcp-token-${leaseRequests.length}`;
      issuedCredentials.set(
        credentialRef,
        opts?.credentialValueForRequest?.(leaseRequest) ?? opts?.credentialValue ?? "figma-upstream-auth",
      );
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ lease: { credential_ref: credentialRef } }));
      return;
    }
    if (req.url?.startsWith("/credentials/") && req.method === "GET") {
      credentialRequests.push(req.url);
      if (opts?.hangCredential) {
        return;
      }
      const credentialRef = decodeURIComponent(req.url.slice("/credentials/".length));
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ credential: { credential_id: credentialRef, value: issuedCredentials.get(credentialRef) ?? "figma-upstream-auth" } }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const url = (await listen(server)).replace(/\/mcp$/, "");
  return { url, leaseRequests, credentialRequests, close: () => closeServer(server) };
}

function jsonHeaders(sessionId?: string): HeadersInit {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(sessionId ? { [MCP_SESSION_HEADER]: sessionId } : {}),
  };
}

describe("buildInitializeReplayHeaders", () => {
  it("preserves caller auth and identity headers for session replay", () => {
    const headers = buildInitializeReplayHeaders({
      authorization: "Bearer pcp_user_123",
      "x-paperclip-user-id": "user_123",
      "x-paperclip-company-id": "company_123",
      accept: "application/json",
      "content-type": "application/json-rpc",
      [MCP_SESSION_HEADER]: "client-session",
    });

    expect(headers.authorization).toBe("Bearer pcp_user_123");
    expect(headers["x-paperclip-user-id"]).toBe("user_123");
    expect(headers["x-paperclip-company-id"]).toBe("company_123");
    expect(headers.accept).toBe("application/json, text/event-stream");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers[MCP_SESSION_HEADER]).toBeUndefined();
  });
});

describe("loadCredentialCustodyState", () => {
  it("loads the Figma custody token cache bound with a safe default and env override", () => {
    expect(loadCredentialCustodyState({}).maxTokenCacheEntries).toBe(
      DEFAULT_CREDENTIAL_CUSTODY_TOKEN_CACHE_MAX_ENTRIES,
    );

    const baseUrlEnv = "PAPERCLIP_MCP_FIGMA_" + "CREDENTIAL_BASE_URL";
    const state = loadCredentialCustodyState({
      PAPERCLIP_MCP_FIGMA_LEASE_URL: "https://custody.example/leases",
      [baseUrlEnv]: "https://custody.example/credentials",
      PAPERCLIP_MCP_FIGMA_TOKEN_CACHE_MAX_ENTRIES: "37",
    });

    expect(state.maxTokenCacheEntries).toBe(37);
  });
});

describe("mcp gateway lifecycle compatibility", () => {
  it("injects configured credential headers from env into upstream calls", async () => {
    const upstream = await createStrictMcpUpstream();
    const state: GatewayState = {
      upstreams: {
        "k8s-admin": {
          url: upstream.url,
          credentialHeaders: [{ header: "authorization", env: "TEST_MCP_TOKEN", scheme: "Bearer" }],
        },
      },
      sessions: new Map(),
      upstreamCallCounts: new Map(),
      upstreamTimeoutMs: 60_000,
      breaker: new CircuitBreaker({ failureThreshold: 5, openCooldownMs: 30_000, halfOpenMaxProbes: 1 }),
    };
    const previous = process.env.TEST_MCP_TOKEN;
    const previousAllowlist = process.env.PAPERCLIP_MCP_UPSTREAM_CREDENTIAL_ENVS;
    process.env.TEST_MCP_TOKEN = "secret-token";
    process.env.PAPERCLIP_MCP_UPSTREAM_CREDENTIAL_ENVS = "TEST_MCP_TOKEN";
    const server = createGatewayServer(state);
    const url = (await listen(server)).replace(/\/mcp$/, "/k8s-admin/mcp");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });

      expect(res.status).toBe(200);
      expect(upstream.receivedHeaders[0]?.authorization).toBe("Bearer secret-token");
    } finally {
      if (previous === undefined) delete process.env.TEST_MCP_TOKEN;
      else process.env.TEST_MCP_TOKEN = previous;
      if (previousAllowlist === undefined) delete process.env.PAPERCLIP_MCP_UPSTREAM_CREDENTIAL_ENVS;
      else process.env.PAPERCLIP_MCP_UPSTREAM_CREDENTIAL_ENVS = previousAllowlist;
    }
  });

  it("reports per-upstream call counts on health", async () => {
    const upstream = await createStrictMcpUpstream();
    const gateway = await createGateway(upstream.url);

    await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const health = await fetch(gateway.url.replace(/\/k8s-admin\/mcp$/, "/healthz"));
    const body = await health.json() as { upstreamCallCounts: Record<string, number> };

    expect(body.upstreamCallCounts["k8s-admin"]).toBe(1);
  });

  it("sends initialized after a client initialize request", async () => {
    const upstream = await createStrictMcpUpstream();
    const gateway = await createGateway(upstream.url);

    const initialize = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    expect(initialize.status).toBe(200);
    expect(clientSessionId).toBeTruthy();

    const toolsList = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(clientSessionId ?? undefined),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(toolsList.status).toBe(200);
    expect(upstream.methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });

  it("bootstraps and initializes an upstream session for unknown non-initialize requests", async () => {
    const upstream = await createStrictMcpUpstream();
    const gateway = await createGateway(upstream.url);

    const toolsList = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(toolsList.status).toBe(200);
    expect(toolsList.headers.get(MCP_SESSION_HEADER)).toBeTruthy();
    expect(upstream.methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });

  it("bootstraps unknown tools/call requests that mention initialize in params", async () => {
    const upstream = await createStrictMcpUpstream();
    const gateway = await createGateway(upstream.url);

    const toolsCall = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "x",
          arguments: {
            note: "initialize",
          },
        },
      }),
    });

    expect(toolsCall.status).toBe(200);
    expect(toolsCall.headers.get(MCP_SESSION_HEADER)).toBeTruthy();
    expect(upstream.methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  });

  it("strips the hop-by-hop transfer-encoding header from a chunked inbound request", async () => {
    // Regression: undici's fetch throws `UND_ERR_INVALID_ARG: invalid
    // transfer-encoding header` for ANY request whose headers carry
    // `transfer-encoding`. The gateway must strip hop-by-hop headers (RFC 7230
    // §6.1) before forwarding, or every chunked-framed request 502s.
    const upstream = await createStrictMcpUpstream();
    const gateway = await createGateway(upstream.url);

    const res = await postChunked(
      gateway.url,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
      { "content-type": "application/json", accept: "application/json, text/event-stream" },
    );

    expect(res.status).toBe(200);
    // The upstream must never see the hop-by-hop transfer-encoding header.
    for (const headers of upstream.receivedHeaders) {
      expect(headers["transfer-encoding"]).toBeUndefined();
    }
  });

  it("replays initialize and initialized before retrying a missing upstream session", async () => {
    const upstream = await createStrictMcpUpstream();
    const gateway = await createGateway(upstream.url);

    const initialize = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    expect(clientSessionId).toBeTruthy();

    upstream.clearSessions();
    const toolsList = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(clientSessionId ?? undefined),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });

    expect(toolsList.status).toBe(200);
    expect(toolsList.headers.get(MCP_SESSION_HEADER)).toBe(clientSessionId);
    expect(upstream.methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
  });

  it("leases Figma credentials server-side and only forwards the resolved token upstream", async () => {
    const upstream = await createStrictMcpUpstream();
    const custody = await createCustodyService({ failRepeatedLeaseForSession: true });
    const gateway = await createFigmaGateway(upstream.url, custody.url);

    const initialize = await fetch(gateway.url, {
      method: "POST",
      headers: {
        ...jsonHeaders(),
        authorization: "Bearer caller-auth",
        cookie: "session=caller-cookie",
        "x-api-key": "caller-api-key",
        "proxy-authorization": "Basic caller-proxy",
        "x-penstock-tenant": "tenant-a",
        "x-request-id": "figma-init-1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    expect(initialize.status).toBe(200);
    expect(clientSessionId).toBeTruthy();

    const toolsList = await fetch(gateway.url, {
      method: "POST",
      headers: {
        ...jsonHeaders(clientSessionId ?? undefined),
        authorization: "Bearer caller-auth",
        cookie: "session=caller-cookie",
        "x-api-key": "caller-api-key",
        "proxy-authorization": "Basic caller-proxy",
        "x-penstock-tenant": "tenant-a",
        "x-request-id": "figma-tools-1",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });

    expect(toolsList.status).toBe(200);
    expect(custody.leaseRequests.map((request) => request.authorization)).toEqual(["Bearer caller-auth"]);
    expect(custody.credentialRequests).toHaveLength(1);
    expect(new Set(custody.leaseRequests.map((request) => request.mcpSessionId))).toEqual(
      new Set([clientSessionId]),
    );
    expect(upstream.receivedHeaders.map((headers) => headers.authorization)).toEqual([
      "Bearer figma-upstream-auth",
      "Bearer figma-upstream-auth",
      "Bearer figma-upstream-auth",
    ]);
    expect(upstream.receivedHeaders.map((headers) => headers.authorization)).not.toContain(
      "Bearer caller-auth",
    );
    for (const headers of upstream.receivedHeaders) {
      expect(headers.cookie).toBeUndefined();
      expect(headers["x-api-key"]).toBeUndefined();
      expect(headers["proxy-authorization"]).toBeUndefined();
      expect(headers["x-penstock-tenant"]).toBeUndefined();
      expect(headers["x-request-id"]).toBeUndefined();
      expect(headers.accept).toBe("application/json, text/event-stream");
      expect(headers["content-type"]).toContain("application/json");
    }
  });

  it("bounds Figma custody token cache growth without mixing caller sessions", async () => {
    const upstream = await createStrictMcpUpstream();
    const custody = await createCustodyService({
      credentialValueForRequest: (request) => `upstream-for-${request.mcpSessionId}-${request.authorization}`,
    });
    const gateway = await createFigmaGateway(upstream.url, custody.url, { maxTokenCacheEntries: 2 });
    const sessions: string[] = [];

    for (const caller of ["a", "b", "c"]) {
      const initialize = await globalThis["fetch"](gateway.url, {
        method: "POST",
        headers: { ...jsonHeaders(), authorization: `Bearer caller-${caller}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
        }),
      });
      const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
      expect(initialize.status).toBe(200);
      expect(clientSessionId).toBeTruthy();
      sessions.push(clientSessionId ?? "");
    }

    expect(gateway.state.credentialCustody?.tokenCache.size).toBe(2);
    expect(custody.leaseRequests.map((request) => request.authorization)).toEqual([
      "Bearer caller-a",
      "Bearer caller-b",
      "Bearer caller-c",
    ]);

    const evictedCallerResponse = await globalThis["fetch"](gateway.url, {
      method: "POST",
      headers: { ...jsonHeaders(sessions[0]), authorization: "Bearer caller-a" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });

    expect(evictedCallerResponse.status).toBe(200);
    expect(gateway.state.credentialCustody?.tokenCache.size).toBe(2);
    expect(custody.leaseRequests.map((request) => request.authorization)).toEqual([
      "Bearer caller-a",
      "Bearer caller-b",
      "Bearer caller-c",
      "Bearer caller-a",
    ]);
    expect(upstream.receivedHeaders.at(-1)?.authorization).toBe(
      `Bearer upstream-for-${sessions[0]}-Bearer caller-a`,
    );
    expect(upstream.receivedHeaders.at(-1)?.authorization).not.toContain("caller-b");
    expect(upstream.receivedHeaders.at(-1)?.authorization).not.toContain("caller-c");
  });

  it("does not trip the Figma breaker for custody lease failures", async () => {
    const upstream = await createStrictMcpUpstream();
    const custody = await createCustodyService({ leaseFailureStatus: 409 });
    const gateway = await createFigmaGateway(upstream.url, custody.url);

    const response = await fetch(gateway.url, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: "Bearer caller-auth" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });

    expect(response.status).toBe(409);
    expect(upstream.methods).toEqual([]);
    expect(gateway.state.breaker.stateOf("figma")).toBe("closed");
  });

  it("times out hung Figma custody lease requests and clears the pending token", async () => {
    const upstream = await createStrictMcpUpstream();
    const custody = await createCustodyService({ hangLease: true });
    const gateway = await createFigmaGateway(upstream.url, custody.url, { custodyTimeoutMs: 100 });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    const call = () => fetch(gateway.url, { method: "POST", headers: { ...jsonHeaders(), authorization: "Bearer caller-auth" }, body });

    const start = Date.now();
    const [first, second] = await Promise.all([call(), call()]);
    const elapsed = Date.now() - start;

    expect(first.status).toBe(504);
    expect(second.status).toBe(504);
    expect(elapsed).toBeLessThan(3000);
    expect(upstream.methods).toEqual([]);
    expect(gateway.state.breaker.stateOf("figma")).toBe("closed");
    expect(gateway.state.credentialCustody?.tokenCache.size).toBe(0);
  });

  it("times out hung Figma credential resolution and clears the pending token", async () => {
    const upstream = await createStrictMcpUpstream();
    const custody = await createCustodyService({ hangCredential: true });
    const gateway = await createFigmaGateway(upstream.url, custody.url, { custodyTimeoutMs: 100 });

    const start = Date.now();
    const response = await fetch(gateway.url, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: "Bearer caller-auth" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });
    const elapsed = Date.now() - start;

    expect(response.status).toBe(504);
    expect(elapsed).toBeLessThan(3000);
    expect(custody.leaseRequests).toHaveLength(1);
    expect(custody.credentialRequests).toHaveLength(1);
    expect(upstream.methods).toEqual([]);
    expect(gateway.state.breaker.stateOf("figma")).toBe("closed");
    expect(gateway.state.credentialCustody?.tokenCache.size).toBe(0);
  });

  it("classifies invalid custodied credential values before forwarding", async () => {
    const upstream = await createStrictMcpUpstream();
    const custody = await createCustodyService({ credentialValue: "bad\r\nvalue" });
    const gateway = await createFigmaGateway(upstream.url, custody.url);

    const response = await fetch(gateway.url, {
      method: "POST",
      headers: { ...jsonHeaders(), authorization: "Bearer caller-auth" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });

    expect(response.status).toBe(502);
    expect(upstream.methods).toEqual([]);
    expect(gateway.state.breaker.stateOf("figma")).toBe("closed");
  });

  it("fails closed for configured Figma custody when caller auth is missing", async () => {
    const upstream = await createStrictMcpUpstream();
    const custody = await createCustodyService();
    const gateway = await createFigmaGateway(upstream.url, custody.url);

    const response = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });

    expect(response.status).toBe(401);
    expect(custody.leaseRequests).toEqual([]);
    expect(upstream.methods).toEqual([]);
    expect(gateway.state.breaker.stateOf("figma")).toBe("closed");
  });

  it("aggregates tool names at one logical /mcp endpoint and rewrites calls upstream", async () => {
    const alpha = await createStrictMcpUpstream([{ name: "search", description: "Alpha search" }]);
    const beta = await createStrictMcpUpstream([{ name: "search", description: "Beta search" }]);
    const gateway = await createAggregateGateway({
      alpha: { url: alpha.url, credentialHeaders: [] },
      beta: { url: beta.url, credentialHeaders: [] },
    });

    const initialize = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    expect(initialize.status).toBe(200);
    expect(clientSessionId).toBeTruthy();

    const list = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(clientSessionId ?? undefined),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const listBody = await list.json() as { result: { tools: Array<{ name: string }> } };
    expect(listBody.result.tools.map((tool) => tool.name).sort()).toEqual(["alpha__search", "beta__search"]);

    const call = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(clientSessionId ?? undefined),
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "beta__search", arguments: {} } }),
    });
    expect(call.status).toBe(200);
    expect(beta.receivedToolCalls).toEqual(["search"]);
    expect(alpha.receivedToolCalls).toEqual([]);
  });

  it("keeps aggregate initialize available when one upstream is unhealthy", async () => {
    const alpha = await createStrictMcpUpstream([{ name: "search", description: "Alpha search" }]);
    const hanging = await createHangingUpstream();
    const gateway = await createAggregateGateway(
      {
        alpha: { url: alpha.url, credentialHeaders: [] },
        stuck: { url: hanging.url, credentialHeaders: [] },
      },
      { timeoutMs: 150, failureThreshold: 1 },
    );

    const start = Date.now();
    const initialize = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const elapsed = Date.now() - start;
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);

    expect(initialize.status).toBe(200);
    expect(clientSessionId).toBeTruthy();
    expect(elapsed).toBeLessThan(1000);
    expect(gateway.state.breaker.stateOf("stuck")).toBe("open");

    const list = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(clientSessionId ?? undefined),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const listBody = await list.json() as { result: { tools: Array<{ name: string }> } };
    expect(list.status).toBe(200);
    expect(listBody.result.tools.map((tool) => tool.name)).toEqual(["alpha__search"]);
  });

  it("opens the aggregate breaker when tools/list session bootstrap is rejected", async () => {
    const alpha = await createStrictMcpUpstream([{ name: "search", description: "Alpha search" }]);
    const rejecting = await createRejectingInitializeUpstream();
    const gateway = await createAggregateGateway(
      {
        alpha: { url: alpha.url, credentialHeaders: [] },
        bad: { url: rejecting.url, credentialHeaders: [] },
      },
      { failureThreshold: 1 },
    );

    const initialize = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    expect(initialize.status).toBe(200);

    const list = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(clientSessionId ?? undefined),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const listBody = await list.json() as { result: { tools: Array<{ name: string }> } };

    expect(list.status).toBe(200);
    expect(listBody.result.tools.map((tool) => tool.name)).toEqual(["alpha__search"]);
    expect(gateway.state.breaker.stateOf("bad")).toBe("open");
    expect(rejecting.methods).toEqual(["initialize"]);
  });

  it("opens the aggregate breaker when tools/call session bootstrap is rejected", async () => {
    const rejecting = await createRejectingInitializeUpstream();
    const gateway = await createAggregateGateway(
      { bad: { url: rejecting.url, credentialHeaders: [] } },
      { failureThreshold: 1 },
    );

    const call = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders("client-session"),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bad__ping", arguments: {} } }),
    });

    expect(call.status).toBe(502);
    expect(gateway.state.breaker.stateOf("bad")).toBe("open");
    expect(rejecting.methods).toEqual(["initialize"]);
  });

  it("reloads persisted aggregate sessions after gateway restart", async () => {
    const upstream = await createStrictMcpUpstream([{ name: "ping", description: "Ping" }]);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gateway-sessions-"));
    const sessionPersistenceFile = path.join(tmpDir, "sessions.json");
    const first = await createAggregateGateway({ alpha: { url: upstream.url, credentialHeaders: [] } }, { sessionPersistenceFile });

    const initialize = await fetch(first.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    expect(clientSessionId).toBeTruthy();

    const second = await createAggregateGateway({ alpha: { url: upstream.url, credentialHeaders: [] } }, { sessionPersistenceFile });
    const call = await fetch(second.url, {
      method: "POST",
      headers: jsonHeaders(clientSessionId ?? undefined),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "alpha__ping", arguments: {} } }),
    });

    expect(call.status).toBe(200);
    expect(upstream.receivedToolCalls).toEqual(["ping"]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("replays stale upstream sessions on aggregate tool calls", async () => {
    const upstream = await createStrictMcpUpstream([{ name: "ping", description: "Ping" }]);
    const gateway = await createAggregateGateway({ alpha: { url: upstream.url, credentialHeaders: [] } });

    const initialize = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    upstream.clearSessions();

    const call = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(clientSessionId ?? undefined),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "alpha__ping", arguments: {} } }),
    });

    expect(call.status).toBe(200);
    expect(upstream.methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
  });

  it("opens the aggregate breaker when stale-session recovery bootstrap is rejected", async () => {
    const upstream = await createStrictMcpUpstream([{ name: "ping", description: "Ping" }]);
    const gateway = await createAggregateGateway(
      { alpha: { url: upstream.url, credentialHeaders: [] } },
      { failureThreshold: 1 },
    );

    const initialize = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    upstream.clearSessions();
    upstream.rejectNextInitialize();

    const call = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(clientSessionId ?? undefined),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "alpha__ping", arguments: {} } }),
    });

    expect(call.status).toBe(502);
    expect(gateway.state.breaker.stateOf("alpha")).toBe("open");
    expect(upstream.methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "initialize",
    ]);
  });
});

describe("upstream resilience: timeout + circuit breaker", () => {
  it("returns 504 when the upstream hangs past the configured timeout", async () => {
    const hanging = await createHangingUpstream();
    const gateway = await createGateway(hanging.url, { timeoutMs: 200 });

    const start = Date.now();
    const res = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(504);
    // Aborted at ~200ms, not undici's ~300s default header/body timeout.
    expect(elapsed).toBeLessThan(3000);
  });

  it("opens the circuit after repeated failures and then fast-fails with 503", async () => {
    const hanging = await createHangingUpstream();
    const gateway = await createGateway(hanging.url, { timeoutMs: 150, failureThreshold: 2 });
    const call = () =>
      fetch(gateway.url, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });

    // First two calls reach the hung upstream and time out (504), tripping the breaker.
    expect((await call()).status).toBe(504);
    expect((await call()).status).toBe(504);
    expect(gateway.state.breaker.stateOf("k8s-admin")).toBe("open");

    // Third call is short-circuited by the open breaker: 503 (only reachable
    // via the breaker gate) with a retry-after hint, without touching upstream.
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("keeps a healthy upstream closed across many calls", async () => {
    const upstream = await createStrictMcpUpstream();
    const gateway = await createGateway(upstream.url, { failureThreshold: 2 });

    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(gateway.url, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/list", params: {} }),
      });
      expect(res.status).toBe(200);
    }
    expect(gateway.state.breaker.stateOf("k8s-admin")).toBe("closed");
  });
});

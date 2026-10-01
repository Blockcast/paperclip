import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_SESSION_HEADER } from "./session-keepalive.js";
import { buildInitializeReplayHeaders, createGatewayServer, createHealthServer, createProxyAcceptProbe, DEFAULT_PORT, loadGatewayConfig, type GatewayState } from "./server.js";
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
  resetSessionInitialization: (responseFormat?: "json" | "sse") => void;
  raceNextRecovery: () => void;
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
  let lifecycleErrorResponseFormat: "json" | "sse" = "json";
  let supersedeSessionsOnInitialize = false;
  let initializedNotificationDelayMs = 0;
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
      if (supersedeSessionsOnInitialize) sessions.clear();
      sessions.set(sessionId, { initialized: false });
      res.statusCode = 200;
      res.setHeader(MCP_SESSION_HEADER, sessionId);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 0, result: { protocolVersion: "2024-11-05" } }));
      return;
    }

    if (method === "notifications/initialized" && initializedNotificationDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, initializedNotificationDelayMs));
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
      const lifecycleError = JSON.stringify({
        jsonrpc: "2.0",
        id: message.id ?? 0,
        error: { code: 0, message: `method "${method}" is invalid during session initialization` },
      });
      res.statusCode = 200;
      res.setHeader("content-type", lifecycleErrorResponseFormat === "sse" ? "text/event-stream" : "application/json");
      res.end(lifecycleErrorResponseFormat === "sse" ? `event: message\ndata: ${lifecycleError}\n\n` : lifecycleError);
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
    resetSessionInitialization: (responseFormat = "json") => {
      lifecycleErrorResponseFormat = responseFormat;
      for (const session of sessions.values()) session.initialized = false;
    },
    raceNextRecovery: () => {
      supersedeSessionsOnInitialize = true;
      initializedNotificationDelayMs = 25;
    },
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
function postChunked(url: string, body: string, headers: Record<string, string>): Promise<{ status: number; headers: Headers; body: string }> {
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
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) responseHeaders.set(name, value.join(", "));
            else if (value !== undefined) responseHeaders.set(name, value);
          }
          resolve({ status: res.statusCode ?? 0, headers: responseHeaders, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function postJson(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = jsonHeaders(),
): Promise<{ status: number; headers: Headers; json: () => Promise<unknown> }> {
  const payload = JSON.stringify(body);
  return postChunked(url, payload, { ...headers, "content-length": Buffer.byteLength(payload).toString() }).then((res) => ({
    status: res.status,
    headers: res.headers,
    json: async () => JSON.parse(res.body),
  }));
}

// Announces a body larger than what it actually sends, then destroys the
// socket before the announced Content-Length is reached — this is what an
// aborted upload / dropped client connection looks like to readBody()'s
// `for await` iteration over the request stream, and is the failure mode the
// audit-coverage regression test below exercises.
function destroySocketMidBody(url: string): Promise<void> {
  const parsed = new URL(url);
  return new Promise((resolve) => {
    const socket = net.connect(Number(parsed.port), parsed.hostname, () => {
      socket.write(
        `POST ${parsed.pathname} HTTP/1.1\r\n` +
          `Host: ${parsed.host}\r\n` +
          "Content-Type: application/json\r\n" +
          "Content-Length: 200\r\n\r\n" +
          '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping"',
      );
      setTimeout(() => {
        socket.destroy();
        setTimeout(resolve, 150);
      }, 50);
    });
    socket.on("error", () => undefined);
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
    upstreams: { figma: { url: upstreamUrl, credentialHeaders: [] } },
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
  opts?: {
    sessionPersistenceFile?: string;
    timeoutMs?: number;
    failureThreshold?: number;
    credentialCustody?: CredentialCustodyState;
    routingPrincipalHash?: string;
  },
): Promise<{ url: string; state: GatewayState }> {
  const state: GatewayState = {
    upstreams,
    sessions: new Map(),
    upstreamCallCounts: new Map(),
    upstreamTimeoutMs: opts?.timeoutMs ?? 60_000,
    credentialCustody: opts?.credentialCustody,
    routingPrincipalHash: opts?.routingPrincipalHash,
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

describe("OAuth discovery", () => {
  it("requires the public resource and authorization server together", () => {
    expect(() => loadGatewayConfig({ PAPERCLIP_MCP_PUBLIC_URL: "https://tenant.example" })).toThrow(/configured together/);
  });

  it("serves protected-resource metadata and redirects authorization discovery", async () => {
    const upstream = await createStrictMcpUpstream();
    const gateway = await createGateway(upstream.url);
    gateway.state.oauthDiscovery = {
      resource: "https://tenant.example/mcp",
      authorizationServer: "https://auth.example",
    };
    const baseUrl = gateway.url.replace(/\/k8s-admin\/mcp$/, "");

    const protectedResource = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(protectedResource.status).toBe(200);
    expect(await protectedResource.json()).toEqual({
      resource: "https://tenant.example/mcp",
      authorization_servers: ["https://auth.example"],
      bearer_methods_supported: ["header"],
    });

    const authorization = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, { redirect: "manual" });
    expect(authorization.status).toBe(307);
    expect(authorization.headers.get("location")).toBe("https://auth.example/.well-known/oauth-authorization-server");
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
      credentialCustody: {
        configs: {
          github: {
            prefix: "github",
            app: "github",
            leaseUrl: "https://control-plane.invalid/leases",
            credentialBaseUrl: "https://control-plane.invalid/credentials",
            controlPlaneTimeoutMs: 60_000,
            leaseMode: "exclusive",
            leaseTtlMs: 60_000,
            upstreamAuthorizationScheme: "Bearer",
          },
        },
        tokenCache: new Map(),
        maxTokenCacheEntries: DEFAULT_CREDENTIAL_CUSTODY_TOKEN_CACHE_MAX_ENTRIES,
      },
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

  it("forwards only MCP protocol headers to tenant-node routes", async () => {
    const upstream = await createStrictMcpUpstream();
    const state: GatewayState = {
      upstreams: {
        github: {
          url: upstream.url,
          execution: "tenant_node",
          routeId: "github",
          relayAuthorization: "Bearer relay-tenant-a",
          credentialHeaders: [{ header: "authorization", env: "TEST_MCP_TOKEN", scheme: "Bearer" }],
        },
      },
      sessions: new Map(),
      upstreamCallCounts: new Map(),
      upstreamTimeoutMs: 60_000,
      breaker: new CircuitBreaker({ failureThreshold: 5, openCooldownMs: 30_000, halfOpenMaxProbes: 1 }),
    };
    const previous = process.env.TEST_MCP_TOKEN;
    process.env.TEST_MCP_TOKEN = "must-stay-on-node";
    const server = createGatewayServer(state);
    const url = (await listen(server)).replace(/\/mcp$/, "/github/mcp");
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          ...jsonHeaders(),
          accept: "application/json, text/event-stream",
          authorization: "Bearer caller-secret",
          cookie: "session=caller-secret",
          "mcp-protocol-version": "2025-06-18",
          "x-api-key": "caller-secret",
          "x-penstock-node": "attacker-node",
          "x-penstock-tenant": "attacker-tenant",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });

      expect(response.status).toBe(200);
      expect(upstream.receivedHeaders[0]).toMatchObject({
        accept: "application/json, text/event-stream",
        authorization: "Bearer relay-tenant-a",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      });
      expect(upstream.receivedHeaders[0]?.authorization).not.toBe("Bearer caller-secret");
      expect(upstream.receivedHeaders[0]).not.toHaveProperty("cookie");
      expect(upstream.receivedHeaders[0]).not.toHaveProperty("x-api-key");
      expect(upstream.receivedHeaders[0]).not.toHaveProperty("x-penstock-node");
      expect(upstream.receivedHeaders[0]).not.toHaveProperty("x-penstock-tenant");
    } finally {
      if (previous === undefined) delete process.env.TEST_MCP_TOKEN;
      else process.env.TEST_MCP_TOKEN = previous;
    }
  });

  it("does not follow redirects from tenant relay routes", async () => {
    let redirectedRequests = 0;
    const targetUrl = await listen(http.createServer((_req, res) => {
      redirectedRequests += 1;
      res.statusCode = 200;
      res.end("unexpected egress");
    }));
    const redirectUrl = await listen(http.createServer((_req, res) => {
      res.statusCode = 307;
      res.setHeader("location", targetUrl);
      res.end();
    }));
    const state: GatewayState = {
      upstreams: {
        github: {
          url: redirectUrl,
          execution: "tenant_node",
          routeId: "github",
          relayAuthorization: "Bearer relay-tenant-a",
          credentialHeaders: [],
        },
      },
      sessions: new Map(),
      upstreamCallCounts: new Map(),
      upstreamTimeoutMs: 60_000,
      breaker: new CircuitBreaker({ failureThreshold: 5, openCooldownMs: 30_000, halfOpenMaxProbes: 1 }),
    };
    const gatewayUrl = (await listen(createGatewayServer(state))).replace(/\/mcp$/, "/github/mcp");

    const response = await postJson(gatewayUrl, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    expect(response.status).toBe(307);
    expect(redirectedRequests).toBe(0);
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

  it("reinitializes when an idle upstream resets lifecycle state with an HTTP 200 JSON-RPC error", async () => {
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

    upstream.resetSessionInitialization();
    const toolsCall = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(clientSessionId ?? undefined),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping", arguments: {} } }),
    });

    expect(toolsCall.status).toBe(200);
    expect(await toolsCall.json()).toMatchObject({ result: { content: [{ text: "ping" }] } });
    expect(toolsCall.headers.get(MCP_SESSION_HEADER)).toBe(clientSessionId);
    expect(upstream.methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
  });

  it("reinitializes when an idle upstream returns an SSE-wrapped lifecycle error", async () => {
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

    upstream.resetSessionInitialization("sse");
    const toolsCall = await fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(clientSessionId ?? undefined),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping", arguments: {} } }),
    });

    expect(toolsCall.status).toBe(200);
    expect(await toolsCall.json()).toMatchObject({ result: { content: [{ text: "ping" }] } });
    expect(toolsCall.headers.get(MCP_SESSION_HEADER)).toBe(clientSessionId);
    expect(upstream.methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
  });

  it("single-flights initialization and retries concurrent calls after replica connection churn", async () => {
    const upstream = await createStrictMcpUpstream();
    const firstGateway = await createGateway(upstream.url);
    const secondGateway = await createGateway(upstream.url);

    const initialize = await fetch(firstGateway.url, {
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

    upstream.resetSessionInitialization("sse");
    upstream.raceNextRecovery();
    const call = (id: number) => fetch(secondGateway.url, {
      method: "POST",
      headers: jsonHeaders(clientSessionId ?? undefined),
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ping", arguments: {} } }),
    });
    const responses = await Promise.all([call(2), call(3)]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual([
      expect.objectContaining({ result: { content: [{ type: "text", text: "ping" }] } }),
      expect.objectContaining({ result: { content: [{ type: "text", text: "ping" }] } }),
    ]);
    expect(upstream.methods.filter((method) => method === "initialize")).toHaveLength(2);
    expect(upstream.receivedToolCalls).toEqual(["ping", "ping"]);
  });

  it("single-flights concurrent stale-session recovery on a path-prefixed route", async () => {
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
    upstream.raceNextRecovery();
    const call = (id: number) => fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(clientSessionId ?? undefined),
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ping", arguments: {} } }),
    });
    const responses = await Promise.all([call(2), call(3)]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual([
      expect.objectContaining({ result: { content: [{ type: "text", text: "ping" }] } }),
      expect.objectContaining({ result: { content: [{ type: "text", text: "ping" }] } }),
    ]);
    expect(upstream.methods.filter((method) => method === "initialize")).toHaveLength(2);
    expect(upstream.receivedToolCalls).toEqual(["ping", "ping"]);
  });

  it("serializes concurrent cold calls without a shared client session", async () => {
    const upstream = await createStrictMcpUpstream();
    const gateway = await createGateway(upstream.url);
    upstream.raceNextRecovery();

    const call = (id: number) => fetch(gateway.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ping", arguments: {} } }),
    });
    const responses = await Promise.all([call(1), call(2), call(3), call(4)]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual([
      expect.objectContaining({ result: { content: [{ type: "text", text: "ping" }] } }),
      expect.objectContaining({ result: { content: [{ type: "text", text: "ping" }] } }),
      expect.objectContaining({ result: { content: [{ type: "text", text: "ping" }] } }),
      expect.objectContaining({ result: { content: [{ type: "text", text: "ping" }] } }),
    ]);
    expect(upstream.methods.filter((method) => method === "initialize")).toHaveLength(4);
    expect(upstream.receivedToolCalls).toEqual(["ping", "ping", "ping", "ping"]);
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

    const initialize = await postJson(gateway.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    expect(initialize.status).toBe(200);
    expect(clientSessionId).toBeTruthy();

    const list = await postJson(
      gateway.url,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      jsonHeaders(clientSessionId ?? undefined),
    );
    const listBody = await list.json() as { result: { tools: Array<{ name: string }> } };
    expect(listBody.result.tools.map((tool) => tool.name).sort()).toEqual(["alpha__search", "beta__search"]);

    const call = await postJson(
      gateway.url,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "beta__search", arguments: {} } },
      jsonHeaders(clientSessionId ?? undefined),
    );
    expect(call.status).toBe(200);
    expect(beta.receivedToolCalls).toEqual(["search"]);
    expect(alpha.receivedToolCalls).toEqual([]);
  });

  it("single-flights concurrent aggregate session bootstrap", async () => {
    const upstream = await createStrictMcpUpstream([{ name: "ping", description: "Ping" }]);
    const gateway = await createAggregateGateway({ alpha: { url: upstream.url, credentialHeaders: [] } });
    const clientSessionId = "aggregate-bootstrap-session";
    upstream.raceNextRecovery();

    const call = (id: number) => postJson(
      gateway.url,
      { jsonrpc: "2.0", id, method: "tools/call", params: { name: "alpha__ping", arguments: {} } },
      jsonHeaders(clientSessionId),
    );
    const responses = await Promise.all([call(1), call(2)]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual([
      expect.objectContaining({ result: { content: [{ type: "text", text: "ping" }] } }),
      expect.objectContaining({ result: { content: [{ type: "text", text: "ping" }] } }),
    ]);
    expect(upstream.methods.filter((method) => method === "initialize")).toHaveLength(1);
    expect(upstream.receivedToolCalls).toEqual(["ping", "ping"]);
  });

  it("applies credential custody to aggregate upstream sessions", async () => {
    const upstream = await createStrictMcpUpstream([{ name: "inspect", description: "Inspect" }]);
    const custody = await createCustodyService({ failRepeatedLeaseForSession: true });
    const gateway = await createAggregateGateway(
      { figma: { url: upstream.url, credentialHeaders: [] } },
      {
        credentialCustody: {
          configs: {
            figma: {
              prefix: "figma",
              app: "figma",
              leaseUrl: `${custody.url}/leases`,
              credentialBaseUrl: `${custody.url}/credentials`,
              controlPlaneTimeoutMs: 60_000,
              leaseMode: "exclusive",
              leaseTtlMs: 60_000,
              upstreamAuthorizationScheme: "Bearer",
            },
          },
          tokenCache: new Map(),
          maxTokenCacheEntries: DEFAULT_CREDENTIAL_CUSTODY_TOKEN_CACHE_MAX_ENTRIES,
        },
      },
    );

    const callerHeaders = {
      ...jsonHeaders(),
      authorization: "Bearer caller-auth",
      cookie: "session=caller-cookie",
      "x-api-key": "caller-api-key",
      "proxy-authorization": "Basic caller-proxy",
      "x-penstock-tenant": "tenant-a",
    };
    const initialize = await postJson(
      gateway.url,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      callerHeaders,
    );
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    expect(initialize.status).toBe(200);
    expect(clientSessionId).toBeTruthy();

    const aggregateHeaders = { ...callerHeaders, [MCP_SESSION_HEADER]: clientSessionId ?? "" };
    const list = await postJson(
      gateway.url,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      aggregateHeaders,
    );
    const call = await postJson(
      gateway.url,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "figma__inspect", arguments: {} } },
      aggregateHeaders,
    );

    expect(list.status).toBe(200);
    expect(call.status).toBe(200);
    expect(custody.leaseRequests.map((request) => request.authorization)).toEqual(["Bearer caller-auth"]);
    expect(custody.credentialRequests).toHaveLength(1);
    expect(new Set(custody.leaseRequests.map((request) => request.mcpSessionId))).toEqual(
      new Set([clientSessionId]),
    );
    expect(upstream.receivedHeaders.map((headers) => headers.authorization)).toEqual([
      "Bearer figma-upstream-auth",
      "Bearer figma-upstream-auth",
      "Bearer figma-upstream-auth",
      "Bearer figma-upstream-auth",
    ]);
    expect(upstream.receivedHeaders.map((headers) => headers.authorization)).not.toContain("Bearer caller-auth");
    for (const headers of upstream.receivedHeaders) {
      expect(headers.cookie).toBeUndefined();
      expect(headers["x-api-key"]).toBeUndefined();
      expect(headers["proxy-authorization"]).toBeUndefined();
      expect(headers["x-penstock-tenant"]).toBeUndefined();
    }
  });

  it("invalidates aggregate custody tokens after upstream 401 responses", async () => {
    let nextSession = 1;
    const sessions = new Set<string>();
    const receivedHeaders: http.IncomingHttpHeaders[] = [];
    const server = http.createServer(async (req, res) => {
      receivedHeaders.push(req.headers);
      const message = JSON.parse(await readBody(req)) as { id?: number; method?: string };
      if (message.method === "initialize") {
        const sessionId = `upstream-${nextSession++}`;
        sessions.add(sessionId);
        res.statusCode = 200;
        res.setHeader(MCP_SESSION_HEADER, sessionId);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 0, result: { protocolVersion: "2024-11-05" } }));
        return;
      }
      const sessionId = req.headers[MCP_SESSION_HEADER];
      if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }
      if (message.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (req.headers.authorization === "Bearer stale-upstream-auth") {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "stale token" }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 1, result: { tools: [] } }));
    });
    const upstreamUrl = await listen(server);
    let issuedCredentials = 0;
    const custody = await createCustodyService({
      credentialValueForRequest: () => issuedCredentials++ === 0 ? "stale-upstream-auth" : "fresh-upstream-auth",
    });
    const gateway = await createAggregateGateway(
      { figma: { url: upstreamUrl, credentialHeaders: [] } },
      {
        credentialCustody: {
          configs: {
            figma: {
              prefix: "figma",
              app: "figma",
              leaseUrl: `${custody.url}/leases`,
              credentialBaseUrl: `${custody.url}/credentials`,
              controlPlaneTimeoutMs: 60_000,
              leaseMode: "exclusive",
              leaseTtlMs: 60_000,
              upstreamAuthorizationScheme: "Bearer",
            },
          },
          tokenCache: new Map(),
          maxTokenCacheEntries: DEFAULT_CREDENTIAL_CUSTODY_TOKEN_CACHE_MAX_ENTRIES,
        },
      },
    );

    const initialize = await postJson(
      gateway.url,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { ...jsonHeaders(), authorization: "Bearer caller-auth" },
    );
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    expect(clientSessionId).toBeTruthy();
    const headers = { ...jsonHeaders(clientSessionId ?? undefined), authorization: "Bearer caller-auth" };

    const staleList = await postJson(gateway.url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, headers);
    const freshList = await postJson(gateway.url, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, headers);

    expect(staleList.status).toBe(200);
    expect(freshList.status).toBe(200);
    expect(custody.leaseRequests).toHaveLength(2);
    expect(receivedHeaders.map((headers) => headers.authorization)).toEqual([
      "Bearer stale-upstream-auth",
      "Bearer stale-upstream-auth",
      "Bearer stale-upstream-auth",
      "Bearer fresh-upstream-auth",
    ]);
  });

  it("keeps aggregate initialize available when one upstream is unhealthy", async () => {
    const alpha = await createStrictMcpUpstream([{ name: "search", description: "Alpha search" }]);
    const hanging = await createHangingUpstream();
    // `GatewayState.upstreamTimeoutMs` is ONE global budget, not per-upstream,
    // so this deadline applies to the healthy `alpha` as much as to `stuck`.
    // With `failureThreshold: 1`, a single `alpha` response slower than the
    // budget opens its breaker for the rest of the test and `tools/list`
    // returns `[]`. At the previous 150 ms that left a local in-process
    // upstream almost no margin: on a CPU-starved runner it lost the race and
    // this test failed `expected [] to deeply equal [ 'alpha__search' ]`,
    // ejecting the merge group for #1952 on 2026-09-21.
    //
    // `hanging` never answers at all, so raising the budget does not weaken
    // what this test checks — it only costs wall-clock. Reproduced directly:
    // squeezing this to 1 ms reproduces that exact assertion locally.
    const UPSTREAM_TIMEOUT_MS = 1_000;
    const gateway = await createAggregateGateway(
      {
        alpha: { url: alpha.url, credentialHeaders: [] },
        stuck: { url: hanging.url, credentialHeaders: [] },
      },
      { timeoutMs: UPSTREAM_TIMEOUT_MS, failureThreshold: 1 },
    );

    const start = Date.now();
    const initialize = await postJson(gateway.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const elapsed = Date.now() - start;
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);

    expect(initialize.status).toBe(200);
    expect(clientSessionId).toBeTruthy();
    // Proportional to the budget above, not an absolute wall-clock number:
    // what this asserts is "initialize returns near the timeout rather than
    // hanging on `stuck`", and an absolute bound re-introduces exactly the
    // steal sensitivity this change removes.
    expect(elapsed).toBeLessThan(UPSTREAM_TIMEOUT_MS * 5);
    expect(gateway.state.breaker.stateOf("stuck")).toBe("open");

    const list = await postJson(
      gateway.url,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      jsonHeaders(clientSessionId ?? undefined),
    );
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

    const initialize = await postJson(gateway.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    expect(initialize.status).toBe(200);

    const list = await postJson(
      gateway.url,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      jsonHeaders(clientSessionId ?? undefined),
    );
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

    const call = await postJson(
      gateway.url,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bad__ping", arguments: {} } },
      jsonHeaders("client-session"),
    );

    expect(call.status).toBe(502);
    expect(gateway.state.breaker.stateOf("bad")).toBe("open");
    expect(rejecting.methods).toEqual(["initialize"]);
  });

  it("reloads persisted aggregate sessions after gateway restart", async () => {
    const upstream = await createStrictMcpUpstream([{ name: "ping", description: "Ping" }]);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gateway-sessions-"));
    const sessionPersistenceFile = path.join(tmpDir, "sessions.json");
    const first = await createAggregateGateway({ alpha: { url: upstream.url, credentialHeaders: [] } }, { sessionPersistenceFile });

    const initialize = await postJson(first.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    expect(clientSessionId).toBeTruthy();

    const second = await createAggregateGateway({ alpha: { url: upstream.url, credentialHeaders: [] } }, { sessionPersistenceFile });
    const call = await postJson(
      second.url,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "alpha__ping", arguments: {} } },
      jsonHeaders(clientSessionId ?? undefined),
    );

    expect(call.status).toBe(200);
    expect(upstream.receivedToolCalls).toEqual(["ping"]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not restore sessions after the authenticated principal rotates", async () => {
    const upstream = await createStrictMcpUpstream([{ name: "ping", description: "Ping" }]);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gateway-sessions-"));
    const sessionPersistenceFile = path.join(tmpDir, "sessions.json");
    const first = await createAggregateGateway(
      { alpha: { url: upstream.url, credentialHeaders: [] } },
      { sessionPersistenceFile, routingPrincipalHash: "tenant-a" },
    );
    const initialize = await postJson(first.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    const methodCount = upstream.methods.length;

    const second = await createAggregateGateway(
      { alpha: { url: upstream.url, credentialHeaders: [] } },
      { sessionPersistenceFile, routingPrincipalHash: "tenant-b" },
    );
    await postJson(
      second.url,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "alpha__ping", arguments: {} } },
      jsonHeaders(clientSessionId ?? undefined),
    );

    expect(upstream.methods.slice(methodCount)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not restore sessions after the authenticated registry version changes", async () => {
    const upstream = await createStrictMcpUpstream([{ name: "ping", description: "Ping" }]);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gateway-sessions-"));
    const sessionPersistenceFile = path.join(tmpDir, "sessions.json");
    const first = await createAggregateGateway(
      { alpha: { url: upstream.url, credentialHeaders: [], registryRevision: "revision-1" } },
      { sessionPersistenceFile, routingPrincipalHash: "tenant-a" },
    );
    const initialize = await postJson(first.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    const methodCount = upstream.methods.length;

    const second = await createAggregateGateway(
      { alpha: { url: upstream.url, credentialHeaders: [], registryRevision: "revision-2" } },
      { sessionPersistenceFile, routingPrincipalHash: "tenant-a" },
    );
    await postJson(
      second.url,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "alpha__ping", arguments: {} } },
      jsonHeaders(clientSessionId ?? undefined),
    );

    expect(upstream.methods.slice(methodCount)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not restore sessions after a tenant route swap", async () => {
    const oldUpstream = await createStrictMcpUpstream([{ name: "ping", description: "Ping" }]);
    const newUpstream = await createStrictMcpUpstream([{ name: "ping", description: "Ping" }]);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gateway-sessions-"));
    const sessionPersistenceFile = path.join(tmpDir, "sessions.json");
    const first = await createAggregateGateway(
      { alpha: { url: oldUpstream.url, credentialHeaders: [] } },
      { sessionPersistenceFile, routingPrincipalHash: "tenant-a" },
    );
    const initialize = await postJson(first.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);

    const second = await createAggregateGateway(
      { alpha: { url: newUpstream.url, credentialHeaders: [] } },
      { sessionPersistenceFile, routingPrincipalHash: "tenant-a" },
    );
    await postJson(
      second.url,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "alpha__ping", arguments: {} } },
      jsonHeaders(clientSessionId ?? undefined),
    );

    expect(newUpstream.methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not rewrite persisted aggregate sessions on steady-state tools/list", async () => {
    const upstream = await createStrictMcpUpstream([{ name: "ping", description: "Ping" }]);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gateway-sessions-"));
    const sessionPersistenceFile = path.join(tmpDir, "sessions.json");
    const gateway = await createAggregateGateway({ alpha: { url: upstream.url, credentialHeaders: [] } }, { sessionPersistenceFile });

    const initialize = await postJson(gateway.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    const before = fs.statSync(sessionPersistenceFile).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 25));

    const list = await postJson(
      gateway.url,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      jsonHeaders(clientSessionId ?? undefined),
    );

    expect(list.status).toBe(200);
    expect(fs.statSync(sessionPersistenceFile).mtimeMs).toBe(before);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("replays stale upstream sessions on aggregate tool calls", async () => {
    const upstream = await createStrictMcpUpstream([{ name: "ping", description: "Ping" }]);
    const gateway = await createAggregateGateway({ alpha: { url: upstream.url, credentialHeaders: [] } });

    const initialize = await postJson(gateway.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    upstream.clearSessions();

    const call = await postJson(
      gateway.url,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "alpha__ping", arguments: {} } },
      jsonHeaders(clientSessionId ?? undefined),
    );

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

  it("single-flights concurrent stale-session recovery on aggregate tool calls", async () => {
    const upstream = await createStrictMcpUpstream([{ name: "ping", description: "Ping" }]);
    const gateway = await createAggregateGateway({ alpha: { url: upstream.url, credentialHeaders: [] } });

    const initialize = await postJson(gateway.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    expect(clientSessionId).toBeTruthy();
    upstream.clearSessions();
    upstream.raceNextRecovery();

    const call = (id: number) => postJson(
      gateway.url,
      { jsonrpc: "2.0", id, method: "tools/call", params: { name: "alpha__ping", arguments: {} } },
      jsonHeaders(clientSessionId ?? undefined),
    );
    const responses = await Promise.all([call(2), call(3)]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual([
      expect.objectContaining({ result: { content: [{ type: "text", text: "ping" }] } }),
      expect.objectContaining({ result: { content: [{ type: "text", text: "ping" }] } }),
    ]);
    expect(upstream.methods.filter((method) => method === "initialize")).toHaveLength(2);
    expect(upstream.receivedToolCalls).toEqual(["ping", "ping"]);
  });

  it("opens the aggregate breaker when stale-session recovery bootstrap is rejected", async () => {
    const upstream = await createStrictMcpUpstream([{ name: "ping", description: "Ping" }]);
    const gateway = await createAggregateGateway(
      { alpha: { url: upstream.url, credentialHeaders: [] } },
      { failureThreshold: 1 },
    );

    const initialize = await postJson(gateway.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const clientSessionId = initialize.headers.get(MCP_SESSION_HEADER);
    upstream.clearSessions();
    upstream.rejectNextInitialize();

    const call = await postJson(
      gateway.url,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "alpha__ping", arguments: {} } },
      jsonHeaders(clientSessionId ?? undefined),
    );

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

describe("mcp gateway request logging", () => {
  it("logs source ip, matched prefix, and tool name for a direct tools/call, and never leaks the Authorization header or arguments", async () => {
    const upstream = await createStrictMcpUpstream([{ name: "ping", description: "Ping" }]);
    const gateway = await createGateway(upstream.url);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const response = await fetch(gateway.url, {
        method: "POST",
        headers: { ...jsonHeaders(), authorization: "Bearer super-secret-caller-token" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "ping", arguments: { secret: "arg-value" } },
        }),
      });
      expect(response.status).toBe(200);

      const lines = logSpy.mock.calls.map((call) => String(call[0]));
      const requestLine = lines.find((line) => line.includes("mcp_gateway_request"));
      expect(requestLine).toBeTruthy();
      const parsed = JSON.parse(requestLine!) as Record<string, unknown>;
      expect(parsed).toMatchObject({ prefix: "k8s-admin", method: "tools/call", tool: "ping" });
      expect(parsed.sourceIp).toBeTruthy();
      expect(parsed.requestId).toBeTruthy();

      for (const line of lines) {
        expect(line).not.toContain("super-secret-caller-token");
        expect(line).not.toContain("arg-value");
      }
    } finally {
      logSpy.mockRestore();
    }
  });

  it("bounds aggregate fan-out to exactly one log line per inbound initialize request", async () => {
    const alpha = await createStrictMcpUpstream([{ name: "search", description: "Alpha search" }]);
    const beta = await createStrictMcpUpstream([{ name: "search", description: "Beta search" }]);
    const gateway = await createAggregateGateway({
      alpha: { url: alpha.url, credentialHeaders: [] },
      beta: { url: beta.url, credentialHeaders: [] },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const response = await postJson(gateway.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      expect(response.status).toBe(200);

      const requestLines = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("mcp_gateway_request"));
      expect(requestLines).toHaveLength(1);
      expect(JSON.parse(requestLines[0]) as Record<string, unknown>).toMatchObject({ method: "initialize" });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("logs the qualified tool name and resolved prefix for an aggregate tools/call", async () => {
    const upstream = await createStrictMcpUpstream([{ name: "inspect", description: "Inspect" }]);
    const gateway = await createAggregateGateway({ "k8s-admin": { url: upstream.url, credentialHeaders: [] } });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const response = await postJson(
        gateway.url,
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "k8s-admin__inspect", arguments: {} } },
        { ...jsonHeaders("aggregate-session"), authorization: "Bearer super-secret-caller-token" },
      );
      expect(response.status).toBe(200);

      const lines = logSpy.mock.calls.map((call) => String(call[0]));
      const requestLine = lines.find((line) => line.includes("mcp_gateway_request"));
      expect(requestLine).toBeTruthy();
      expect(JSON.parse(requestLine!) as Record<string, unknown>).toMatchObject({
        prefix: "k8s-admin",
        method: "tools/call",
        tool: "k8s-admin__inspect",
      });
      for (const line of lines) {
        expect(line).not.toContain("super-secret-caller-token");
      }
    } finally {
      logSpy.mockRestore();
    }
  });

  it("logs one fallback line (matched prefix, HTTP method) when body consumption fails on the direct route", async () => {
    const upstream = await createStrictMcpUpstream([{ name: "ping", description: "Ping" }]);
    const gateway = await createGateway(upstream.url);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await destroySocketMidBody(gateway.url);

      const requestLines = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("mcp_gateway_request"));
      expect(requestLines).toHaveLength(1);
      expect(JSON.parse(requestLines[0]) as Record<string, unknown>).toMatchObject({
        prefix: "k8s-admin",
        method: "POST",
      });
      expect((JSON.parse(requestLines[0]) as Record<string, unknown>).tool).toBeUndefined();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("logs one fallback line (prefix '*', HTTP method) when body consumption fails on the aggregate route", async () => {
    const upstream = await createStrictMcpUpstream([{ name: "ping", description: "Ping" }]);
    const gateway = await createAggregateGateway({ "k8s-admin": { url: upstream.url, credentialHeaders: [] } });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await destroySocketMidBody(gateway.url);

      const requestLines = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("mcp_gateway_request"));
      expect(requestLines).toHaveLength(1);
      expect(JSON.parse(requestLines[0]) as Record<string, unknown>).toMatchObject({ prefix: "*", method: "POST" });
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
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

/**
 * PEN-2370 ask 3 — a control that closes the class rather than the spelling.
 *
 * This module's recurring failure is not any one leak: it is that a SECOND
 * path to the client keeps appearing beside the one that scrubs. The scrubber
 * was wired into `writeResponse`, whose comment claimed it covered every
 * response — while the aggregate `tools/list` reply, assembled by spreading
 * upstream tool records, was written straight to the socket and reached agents
 * unscrubbed. Six earlier fixes each closed the spelling an observer had
 * probed; none made the next bypass fail.
 *
 * So the invariant is asserted against the source itself, and it is an
 * allowlist of exactly one: a body may reach the client through `writeResponse`
 * and nowhere else. Adding a body-bearing write anywhere in `server.ts` fails
 * here, whether or not anyone remembers the scrubber exists.
 *
 * The scan is over the AST, not over source text, and it deliberately matches
 * MORE than today's single call site. A text scan is a denylist of spellings —
 * which is the exact failure mode this suite exists to close — and the first
 * version of it was blind to three bypasses that all still leak:
 *
 *   - `res.end(\n  body,\n)` — the argument starts on the next line, so a
 *     per-line regex never sees it.
 *   - `response.end(body)` — same call, receiver renamed.
 *   - `res.write(body)` — a body-bearing exit that is not `end` at all.
 *
 * So the predicate is: any call to a member named `end` or `write`, on any
 * receiver, spelled with dot or bracket access, carrying at least one
 * argument. That is broad on purpose. It fails CLOSED — a legitimate new
 * `.write()` on some non-response object trips it and costs one reviewer a
 * conversation, whereas a miss costs a fleet-wide credential leak — and the
 * breadth is the point: the allowlist is "one exit", not "one spelling".
 *
 * A bodyless `res.end()` is not in scope: it carries nothing to disclose.
 */

/** A call that hands at least one argument to `.end()`/`.write()`. */
interface BodyBearingWrite {
  line: number;
  text: string;
  node: ts.CallExpression;
}

function parseServerSource(source: string): ts.SourceFile {
  return ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** The member name being called, for `a.end()` and `a["end"]()` alike. */
function calledMemberName(expression: ts.LeftHandSideExpression): string | null {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return null;
}

function findBodyBearingWrites(sourceFile: ts.SourceFile): BodyBearingWrite[] {
  const found: BodyBearingWrite[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const member = calledMemberName(node.expression);
      if ((member === "end" || member === "write") && node.arguments.length > 0) {
        found.push({
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          // Collapsed so a multiline call still reports as one readable line.
          text: node.getText(sourceFile).replace(/\s+/g, " "),
          node,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

/** The first call to a free function named `name` within `root`, if any. */
function findCallTo(root: ts.Node, name: string): ts.CallExpression | null {
  let found: ts.CallExpression | null = null;

  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(root);
  return found;
}

describe("PEN-2370: response bodies have exactly one exit", () => {
  const source = fs.readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  const sourceFile = parseServerSource(source);

  it("writes a response body in exactly one place", () => {
    const writes = findBodyBearingWrites(sourceFile);

    expect(
      writes.map(({ line, text }) => `${line}: ${text}`),
      "every response body must leave through writeResponse, so that it passes the scrubber on the "
        + "way out — see this suite's comment. If this is a legitimate non-response `.write()`/`.end()`, "
        + "that judgement belongs in review, not in a widened regex.",
    ).toHaveLength(1);
  });

  it("puts that one exit inside writeResponse, downstream of the scrubber", () => {
    const writeResponse = sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "writeResponse",
    );
    expect(writeResponse, "writeResponse must exist for the single exit to live inside it").toBeDefined();

    const [exit] = findBodyBearingWrites(sourceFile);
    expect(exit, "there must be a body-bearing write to place").toBeDefined();

    // Containment by source position: the exit is lexically inside writeResponse.
    expect(exit!.node.getStart(sourceFile)).toBeGreaterThan(writeResponse!.getStart(sourceFile));
    expect(exit!.node.getEnd()).toBeLessThan(writeResponse!.getEnd());

    // ...and the scrubber runs ahead of it in the same function, so the value
    // being written cannot be the unscrubbed one.
    const scrub = findCallTo(writeResponse!, "scrubResponseBody");
    expect(scrub, "writeResponse must call scrubResponseBody").not.toBeNull();
    expect(scrub!.getStart(sourceFile)).toBeLessThan(exit!.node.getStart(sourceFile));
  });

  // Fixtures for the detector itself. Without these the guard could silently
  // stop detecting anything — a scan that matches nothing also reports "one
  // exit is fine" once the real call site drifts out of its predicate.
  it("counts a body-bearing exit however it is spelled", () => {
    const bypasses: Record<string, string> = {
      "argument on the next line": "res.end(\n  body,\n);",
      "receiver renamed": "response.end(body);",
      "write instead of end": "res.write(body);",
      "bracket access": 'res["end"](body);',
      "chained off an expression": "getRes(req).end(body);",
    };

    for (const [label, snippet] of Object.entries(bypasses)) {
      expect(findBodyBearingWrites(parseServerSource(snippet)), label).toHaveLength(1);
    }
  });

  it("does not count a bodyless end, which carries nothing to disclose", () => {
    expect(findBodyBearingWrites(parseServerSource("res.end();\nres.end();"))).toHaveLength(0);
  });
});

describe("PEN-3052: probe-only health listener on a second port", () => {
  // Why this exists: the kubelet probes from the node's host network, so the
  // CiliumNetworkPolicy that denies the proxy port from `fromEntities: [host,
  // remote-node]` would deny the probes too. Both probes on
  // `paperclip-mcp-gateway-k8s-ro` target the proxy port and liveness failure
  // restarts the container, so the deny cannot land until they move.

  async function startHealthServer(
    isServing: () => boolean | Promise<boolean> = () => true,
  ): Promise<string> {
    const server = createHealthServer(isServing);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it("answers the probe paths and nothing else", async () => {
    const base = await startHealthServer();

    for (const probePath of ["/healthz", "/"]) {
      const res = await fetch(`${base}${probePath}`);
      expect(res.status, probePath).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }

    const withQuery = await fetch(`${base}/healthz?probe=kubelet`);
    expect(withQuery.status).toBe(200);
  });

  // THE security property. The deny this listener exists to permit names one
  // port; anything reachable here is reachable around that deny. A health
  // listener that proxied would be a wider hole than the one being closed.
  it("does not proxy — no MCP route is reachable on the health port", async () => {
    const base = await startHealthServer();

    const paths = ["/mcp", "/mcp/", "/k8s-admin/mcp", "/k8s-admin/mcp/tools", "/.well-known/oauth-protected-resource"];
    for (const path of paths) {
      const res = await fetch(`${base}${path}`, { method: "POST", body: "{}" });
      expect(res.status, path).toBe(404);
    }

    // ...and a GET of the same routes is not a way around the POST check.
    for (const path of paths) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, `GET ${path}`).toBe(404);
    }
  });

  it("refuses a write method even on a probe path", async () => {
    const base = await startHealthServer();
    const res = await fetch(`${base}/healthz`, { method: "POST", body: "{}" });
    expect(res.status).toBe(405);
  });

  // HEAD is explicitly allowed alongside GET. Without this, dropping the
  // `&& req.method !== "HEAD"` clause passes the suite and every HEAD probe
  // starts answering 405.
  it("allows HEAD on the probe paths", async () => {
    const base = await startHealthServer();
    for (const probePath of ["/healthz", "/"]) {
      const res = await fetch(`${base}${probePath}`, { method: "HEAD" });
      expect(res.status, probePath).toBe(200);
    }
    // ...and a HEAD of a non-probe path is still not a way in.
    expect((await fetch(`${base}/mcp`, { method: "HEAD" })).status).toBe(404);
  });

  // A static 200 would report healthy with the proxy socket shut, which is
  // strictly weaker than the probe it replaces — that one at least had to
  // reach the proxy listener to answer at all.
  it("reports 503 when the proxy listener is not serving", async () => {
    let serving = false;
    const base = await startHealthServer(() => serving);

    const down = await fetch(`${base}/healthz`);
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ ok: false });

    serving = true;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  // `isServing` may be async, because the production one opens a socket.
  it("awaits an async isServing, and fails closed when it rejects", async () => {
    let answer: () => Promise<boolean> = async () => false;
    const base = await startHealthServer(() => answer());

    expect((await fetch(`${base}/healthz`)).status).toBe(503);

    answer = async () => true;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);

    // A check that throws must read as unhealthy, not as a thrown request.
    answer = async () => {
      throw new Error("probe exploded");
    };
    const errored = await fetch(`${base}/healthz`);
    expect(errored.status).toBe(503);
    expect(await errored.json()).toMatchObject({ ok: false });
  });

  // `server.listening` is `!!this._handle`, so it stays true for a socket that
  // is bound but no longer accepting. While liveness targets the proxy port
  // directly a wedged accept queue times the probe out and the pod restarts on
  // its own; served from the health port on `listening` alone, that same state
  // would answer 200 forever and the pod would never self-heal.
  describe("createProxyAcceptProbe", () => {
    it("is true for a listener that accepts, false for a port nobody holds", async () => {
      const listener = net.createServer();
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const { port } = listener.address() as AddressInfo;

      // Closed here rather than in afterEach: the second half of this test
      // needs the port genuinely unbound, and closing twice rejects.
      try {
        expect(await createProxyAcceptProbe(port, { ttlMs: 0 })()).toBe(true);
      } finally {
        await new Promise<void>((resolve) => listener.close(() => resolve()));
      }

      expect(await createProxyAcceptProbe(port, { ttlMs: 0 })()).toBe(false);
    });

    it("reports false rather than hanging when the connect does not complete", async () => {
      // The saturated-accept-queue shape: the SYN is dropped rather than
      // refused, so the connect neither completes nor errors.
      //
      // Pinned with a socket that emits neither event rather than with a real
      // unroutable address (TEST-NET-3, which this test used to dial). In a
      // no-egress sandbox that address fails immediately with ENETUNREACH
      // through the `once("error")` branch, well inside the bound — so that
      // shape passed even with `socket.setTimeout` deleted, and what it proved
      // depended on the host's egress rather than on the code.
      const connect = vi.spyOn(net, "connect").mockImplementation(() => new net.Socket());
      try {
        const probe = createProxyAcceptProbe(9, { timeoutMs: 50, ttlMs: 0 });
        const started = Date.now();
        expect(await probe()).toBe(false);
        // Bounded by the timeout, not by the OS connect retry schedule.
        expect(Date.now() - started).toBeLessThan(2000);
        expect(connect).toHaveBeenCalledTimes(1);
      } finally {
        connect.mockRestore();
      }
    });

    // A fired timer means `timeoutMs` elapsed, not that the accept queue is
    // wedged — a blocked event loop expires it just as readily, and Node runs
    // the timers phase before the poll phase, so on resume the expired timer is
    // delivered before a connect the kernel already completed. Without the
    // `setImmediate` in the timeout handler, `finish(false)` wins that race and
    // the probe reports a healthy listener dead. Against a real `http.Server`
    // under a 400ms synchronous stall that was 20 of 40 trials; a restart of
    // the authenticated proxy needs three.
    //
    // Pinned on emit order rather than on a real stall, which is a genuine race
    // and would land here as a flaky test. Emitting the timeout first, then the
    // connect, is exactly the ordering the loop produces on resume.
    //
    // The `nextTick` drain between the two emits is load-bearing, not padding
    // (PEN-3052 review). It is what pins *which phase* the decision is deferred
    // to, rather than merely that it is deferred. Emitting both in one
    // synchronous turn — as this test first did — lets the `connect` land first
    // under any deferral at all, so `setImmediate` → `queueMicrotask` or
    // `process.nextTick` kept it green while fully restoring the defect: both
    // of those queues drain at the end of the timers phase, still ahead of
    // poll. Measured against a real `http.Server` under a 400ms stall,
    // `setImmediate` reports healthy 20/20 while `queueMicrotask` and
    // `process.nextTick` manage 10/20 each — the identical rate to the pre-fix
    // direct call. Draining nextTick (which also drains the microtasks queued
    // behind it) leaves only a check-phase deferral alive to see the `connect`,
    // so all three shapes now fail here. A bare `await Promise.resolve()` is
    // NOT sufficient: it catches `queueMicrotask`, but `process.nextTick`
    // survives it.
    it("defers the timeout verdict past poll, so an already-completed connect wins", async () => {
      const socket = new net.Socket();
      const connect = vi.spyOn(net, "connect").mockImplementation(() => socket);
      try {
        const probe = createProxyAcceptProbe(9, { timeoutMs: 50, ttlMs: 0 });
        const result = probe();

        socket.emit("timeout");
        await new Promise((resolve) => process.nextTick(resolve));
        socket.emit("connect");

        expect(await result).toBe(true);
      } finally {
        connect.mockRestore();
      }
    });

    // Nothing in front of the health port authenticates, so without the cache
    // each unauthenticated request would open a fresh connection into the very
    // accept queue being measured.
    it("collapses repeated calls within the TTL, and re-probes once it lapses", async () => {
      let accepted = 0;
      const listener = net.createServer((socket) => {
        accepted += 1;
        socket.destroy();
      });
      servers.push(listener as unknown as http.Server);
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const { port } = listener.address() as AddressInfo;

      const probe = createProxyAcceptProbe(port, { ttlMs: 20 });
      expect(await Promise.all([probe(), probe(), probe()])).toEqual([true, true, true]);
      // The client resolves on its own `connect`; the server's `connection`
      // event is a separate turn, so settle before counting.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(accepted).toBe(1);

      // ...and the other half of the window, which is the half that matters
      // (PEN-3052 review). Asserting only collapse *within* the TTL leaves
      // `now - cached.at < ttlMs` free to be deleted: the probe then memoises
      // its first successful connect forever, so a later wedged accept queue
      // answers 200 indefinitely and liveness never restarts the pod —
      // precisely the failure this listener exists to prevent. The 50ms settle
      // above is already past the 20ms TTL, so this call must re-probe.
      expect(await probe()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(accepted).toBe(2);
    });

    // The window is measured on `performance.now()`, not `Date.now()`. Under a
    // backwards wall-clock step `now - cached.at` goes negative, which compares
    // as inside the TTL — pinning the cached answer for the duration of the
    // jump. A pinned `true` is the stale positive this probe exists to avoid.
    it("measures its TTL on a monotonic clock", async () => {
      let accepted = 0;
      const listener = net.createServer((socket) => {
        accepted += 1;
        socket.destroy();
      });
      servers.push(listener as unknown as http.Server);
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const { port } = listener.address() as AddressInfo;

      const probe = createProxyAcceptProbe(port, { ttlMs: 20 });
      expect(await probe()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(accepted).toBe(1);

      // An hour-long backwards step, i.e. far larger than the TTL.
      const realNow = Date.now;
      const skewed = vi.spyOn(Date, "now").mockImplementation(() => realNow() - 3_600_000);
      try {
        expect(await probe()).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(accepted).toBe(2);
      } finally {
        skewed.mockRestore();
      }
    });

    // The other direction, on the same fixture (PEN-3052 review). The backwards
    // test above would still pass with the TTL term deleted outright, because
    // its 50ms settle already exceeds the 20ms TTL and the re-probe is due on
    // elapsed time alone. Stepping *forward* inside a TTL that has not lapsed
    // pins the complementary property: the cache is not keyed on wall-clock at
    // all, so a forward jump cannot expire a still-valid entry and stampede
    // connects into the accept queue being measured.
    it("does not let a forward wall-clock step expire a live cache entry", async () => {
      let accepted = 0;
      const listener = net.createServer((socket) => {
        accepted += 1;
        socket.destroy();
      });
      servers.push(listener as unknown as http.Server);
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const { port } = listener.address() as AddressInfo;

      // TTL far longer than anything this test waits, so the entry stays live
      // on a monotonic clock and only a wall-clock read could expire it.
      const probe = createProxyAcceptProbe(port, { ttlMs: 60_000 });
      expect(await probe()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(accepted).toBe(1);

      const realNow = Date.now;
      const skewed = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 3_600_000);
      try {
        expect(await probe()).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(accepted).toBe(1);
      } finally {
        skewed.mockRestore();
      }
    });
  });

  // This listener sits OUTSIDE the deny by construction — that is why it
  // exists — so it is reachable by exactly the `host` / `remote-node` entities
  // the deny excludes from the proxy port, with nothing authenticating in
  // front of it. Node's defaults (60s headers, 300s request, swept every 30s)
  // hold a byte-silent socket for a minute each. Asserted on the constructed
  // server, not at the `listen` call site, so a second caller cannot bind it
  // unbounded.
  it("bounds connection timeouts, since nothing in front of this port authenticates", () => {
    // Never bound: these are properties of the constructed server, so the test
    // needs no listener and nothing to tear down.
    const health = createHealthServer(() => true);

    // Pinned exactly, not as upper bounds (PEN-3052 review). A `<= 2_000`
    // assertion admits `headersTimeout = 1`, which would cut a real probe off
    // mid-headers on a loaded node; README.md names these specific numbers as
    // properties of the port, so the test should fail when they move either
    // way.
    expect(health.headersTimeout).toBe(2_000);
    expect(health.requestTimeout).toBe(5_000);

    // The one that makes the two above mean what they say. Node sweeps for
    // expired connections on this interval — default 30_000ms — so at the
    // default a 2s headers timeout is enforced in ~30s. Settable only as a
    // `createServer` option, which is why this is pinned rather than assumed.
    expect(health.connectionsCheckingInterval).toBe(1_000);

    // Idle keep-alive sockets reclaimed faster than Node's 5s default. Set in
    // the options object with the three above, so this also fails against a
    // refactor that rebuilds the server without it.
    expect(health.keepAliveTimeout).toBe(2_000);

    // Deliberately never assigned. A cap refuses the *incoming* socket once it
    // is reached, so the sockets already held win and the kubelet's next probe
    // connection is the one reset — making a liveness restart of the
    // authenticated proxy reachable at the cap instead of at the process fd
    // limit. A cap set well clear of probe contention would avoid that and
    // would bound descriptor consumption, which nothing here bounds; it is
    // accepted against rather than refuted, and `createHealthServer` records
    // the three reasons. Read them before changing this line: unbounded
    // descriptor use on this port is a recorded acceptance, not an oversight.
    expect(health.maxConnections).toBeUndefined();
  });

  // The property assertions above pin the configuration; this pins the
  // behaviour they are configured for (PEN-3052 review). At Node's default
  // 30_000ms sweep interval this same `headersTimeout` is enforced in ~30s, so
  // a 10s bound here fails if the interval is ever dropped back to the default
  // — including by a refactor that rebuilds the server without the options
  // object, which no property assertion would catch.
  it("actually reaps a byte-silent socket inside the stated headers timeout", async () => {
    const health = createHealthServer(() => true);
    servers.push(health);
    await new Promise<void>((resolve) => health.listen(0, "127.0.0.1", resolve));
    const { port } = health.address() as AddressInfo;

    const reaped = new Promise<{ ms: number; banner: string }>((resolve) => {
      const started = Date.now();
      // Headers opened and never terminated: the request can never complete, so
      // only the timeout sweep can end it.
      const socket = net.connect({ port, host: "127.0.0.1" }, () => socket.write("GET /healthz HTTP/1.1\r\nHost: x\r\n"));
      let banner = "";
      // Flowing mode is load-bearing, not incidental. With the readable left
      // paused, Node withholds `close` until the buffered 408 is consumed — so
      // this test would hang against a server that reaped exactly on time.
      socket.on("data", (chunk: Buffer) => {
        banner += chunk.toString("utf8");
      });
      socket.on("error", () => {});
      socket.on("close", () => resolve({ ms: Date.now() - started, banner }));
    });

    const { ms, banner } = await reaped;
    // The specific status matters: it is what distinguishes the headers-timeout
    // sweep from any other reason the socket might have closed. It is Node's
    // *default* `clientError` handling that writes it, which holds only while
    // this server has no `clientError` listener of its own — true today. Worth
    // knowing because the realistic way this breaks is a refactor that shares
    // construction with the proxy listener and brings a handler along: the
    // failure would then point at the sweep interval this test exists to pin,
    // rather than at the cause.
    expect(banner.startsWith("HTTP/1.1 408")).toBe(true);
    expect(ms).toBeLessThan(10_000);
  }, 15_000);

  it("discloses less than /healthz on the proxy port, which no deny covers here", async () => {
    const base = await startHealthServer();
    const body = await (await fetch(`${base}/healthz`)).json();

    // The proxy port's /healthz reports these; this port must not.
    for (const leaky of ["upstreams", "breakers", "sessions", "upstreamCallCounts"]) {
      expect(Object.keys(body as object), leaky).not.toContain(leaky);
    }
  });

  describe("PAPERCLIP_MCP_HEALTH_PORT parsing", () => {
    it("binds no second socket unless configured", () => {
      expect(loadGatewayConfig({}).healthPort).toBeNull();
      expect(loadGatewayConfig({ PAPERCLIP_MCP_HEALTH_PORT: "" }).healthPort).toBeNull();
      expect(loadGatewayConfig({ PAPERCLIP_MCP_HEALTH_PORT: "   " }).healthPort).toBeNull();
    });

    it("accepts a port and leaves PORT alone", () => {
      const config = loadGatewayConfig({ PORT: "8080", PAPERCLIP_MCP_HEALTH_PORT: " 8081 " });
      expect(config.healthPort).toBe(8081);
      expect(config.port).toBe(8080);
      expect(loadGatewayConfig({}).port).toBe(DEFAULT_PORT);
    });

    // `Number.parseInt` is lenient in ways that matter for a port: it reads
    // "8081abc" as 8081 and "0x1f9" as 0, and a bare `Number()` accepts
    // "Infinity". Falling back on junk would leave the kubelet probing a
    // socket nobody bound, which liveness turns into a CrashLoop with no
    // stated cause.
    it("refuses anything that is not a port, rather than falling back", () => {
      for (const raw of ["Infinity", "-1", "0", "70000", "65536", "8081abc", "0x1f9", "+8081", "80.5", "eighty"]) {
        expect(() => loadGatewayConfig({ PAPERCLIP_MCP_HEALTH_PORT: raw }), raw).toThrow(/1-65535/);
      }
      expect(loadGatewayConfig({ PAPERCLIP_MCP_HEALTH_PORT: "65535" }).healthPort).toBe(65535);
      expect(loadGatewayConfig({ PAPERCLIP_MCP_HEALTH_PORT: "1" }).healthPort).toBe(1);
    });

    it("refuses a health port equal to the proxy port", () => {
      expect(() => loadGatewayConfig({ PORT: "8080", PAPERCLIP_MCP_HEALTH_PORT: "8080" }))
        .toThrow(/must differ from PORT/);
      // Default PORT is implied, not just the explicit one.
      expect(() => loadGatewayConfig({ PAPERCLIP_MCP_HEALTH_PORT: "8080" })).toThrow(/must differ from PORT/);
    });

    // The `must differ` guard above is only as good as the number it compares
    // against, and `Number.parseInt` read PORT="8O81" (letter O) as 8. PORT now
    // gets the same strict parse as the health port.
    it("parses PORT as strictly as the health port", () => {
      for (const raw of ["8O81", "8081abc", "0x1f9", "+8081", "0", "70000", "Infinity", "eighty"]) {
        expect(() => loadGatewayConfig({ PORT: raw }), raw).toThrow(/PORT must be an integer in 1-65535/);
      }
      expect(loadGatewayConfig({ PORT: " 8080 " }).port).toBe(8080);
      // Unset or blank still falls back to the default; only junk is refused.
      expect(loadGatewayConfig({ PORT: "" }).port).toBe(DEFAULT_PORT);
    });
  });
});

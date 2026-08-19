import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayServer, type GatewayState } from "./server.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { MCP_SESSION_HEADER } from "./session-keepalive.js";

/**
 * End-to-end proof for PEN-2370.
 *
 * The unit tests in `response-scrub.test.ts` exercise the scrubber directly.
 * They cannot tell us whether it is actually *wired into* the proxy path — a
 * scrubber that is never called passes every one of them. This drives a real
 * request through the real gateway server against a fake upstream that behaves
 * like the Kubernetes MCP server, and asserts on the bytes an agent would see.
 */

const LEAK = "LEAKED_PLAINTEXT_MUST_NOT_SURVIVE";

/** A pod as the k8s MCP server returns it: YAML text in a content block. */
const POD_YAML = [
  "apiVersion: v1",
  "kind: Pod",
  "metadata:",
  "  name: some-other-agent",
  "  namespace: paperclip",
  "spec:",
  "  containers:",
  "  - name: agent",
  "    image: harbor.example.net/agent:v1",
  "    env:",
  "    - name: OPENAI_API_KEY",
  `      value: ${LEAK}`,
  "    - name: AGENT_JWT",
  `      value: ${LEAK}`,
  "    - name: LOG_LEVEL",
  "      value: debug",
  "status:",
  "  phase: Running",
].join("\n");

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Fake k8s MCP upstream. `format` selects the transport framing so we cover
 * both the plain-JSON and SSE paths the real server can use.
 */
async function createPodUpstream(format: "json" | "sse"): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const message = JSON.parse(await readBody(req)) as { id?: number; method?: string };

    if (message.method === "initialize") {
      res.statusCode = 200;
      res.setHeader(MCP_SESSION_HEADER, "upstream-session-1");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id ?? 1,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "k8s", version: "1" } },
        }),
      );
      return;
    }

    if (message.method?.startsWith("notifications/")) {
      res.statusCode = 202;
      res.end();
      return;
    }

    // tools/call -> pods_get
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: message.id ?? 1,
      result: { content: [{ type: "text", text: POD_YAML }] },
    });

    res.statusCode = 200;
    if (format === "sse") {
      res.setHeader("content-type", "text/event-stream");
      res.end(`event: message\ndata: ${payload}\n\n`);
    } else {
      res.setHeader("content-type", "application/json");
      // Deliberately set a content-length matching the UNSCRUBBED body. The
      // gateway must not forward it once the body changes, or the client sees
      // a truncated response.
      res.setHeader("content-length", Buffer.byteLength(payload).toString());
      res.end(payload);
    }
  });
  return listen(server);
}

async function createGateway(upstreamUrl: string): Promise<string> {
  const state: GatewayState = {
    upstreams: { "k8s-ro": { url: upstreamUrl, credentialHeaders: [] } },
    sessions: new Map(),
    upstreamCallCounts: new Map(),
    upstreamTimeoutMs: 60_000,
    breaker: new CircuitBreaker({ failureThreshold: 5, openCooldownMs: 30_000, halfOpenMaxProbes: 1 }),
  };
  const url = await listen(createGatewayServer(state));
  return url.replace(/\/mcp$/, "/k8s-ro/mcp");
}

async function callPodsGet(gatewayUrl: string): Promise<{ status: number; text: string }> {
  const response = await fetch(gatewayUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "pods_get", arguments: { name: "some-other-agent", namespace: "paperclip" } },
    }),
  });
  return { status: response.status, text: await response.text() };
}

describe("PEN-2370 end-to-end: pods_get through the gateway", () => {
  it.each(["json", "sse"] as const)(
    "does not deliver plaintext env values to the caller (%s framing)",
    async (format) => {
      const gatewayUrl = await createGateway(await createPodUpstream(format));

      const { status, text } = await callPodsGet(gatewayUrl);

      expect(status).toBe(200);

      // The whole point: the agent-visible bytes carry no plaintext value.
      expect(text).not.toContain(LEAK);
      expect(text).toContain("<redacted>");

      // ...while the diagnostic content the grant exists for survives.
      expect(text).toContain("OPENAI_API_KEY");
      expect(text).toContain("AGENT_JWT");
      expect(text).toContain("phase: Running");
      expect(text).toContain("harbor.example.net/agent:v1");
    },
  );

  it("returns a complete, parseable body after scrubbing changes its length", async () => {
    // Guards the content-length bug: forwarding the upstream's length would
    // truncate the scrubbed body or hang the client.
    const gatewayUrl = await createGateway(await createPodUpstream("json"));

    const { text } = await callPodsGet(gatewayUrl);

    const parsed = JSON.parse(text) as { result?: { content?: Array<{ text?: string }> } };
    const podText = parsed.result?.content?.[0]?.text ?? "";
    expect(podText).toContain("kind: Pod");
    expect(podText).toContain("phase: Running");
    expect(podText).not.toContain(LEAK);
  });
});

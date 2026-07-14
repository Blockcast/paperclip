#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import { readConfigFromEnv, normalizeApiUrl, type PaperclipExternalConfig } from "./config.js";
import { runWithBearer } from "./auth-context.js";

const HOST = process.env.MCP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.MCP_PORT ?? "9011");
const MCP_PATH = "/mcp";

async function readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.byteLength;
    if (total > maxBytes) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createHttpServer(config: PaperclipExternalConfig = readConfigFromEnv()) {
  // Idempotent: readConfigFromEnv() already normalizes, but direct/programmatic
  // callers (tests) may pass an unnormalized apiUrl — normalize here too.
  config = { ...config, apiUrl: normalizeApiUrl(config.apiUrl) };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== MCP_PATH) {
      res.writeHead(404).end();
      return;
    }
    // Capture the inbound bearer for the WHOLE request lifecycle.
    const bearer = req.headers.authorization ?? null;
    await runWithBearer(bearer, async () => {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      // Stateless streamable-HTTP (sessionIdGenerator: undefined): no session id
      // is issued or expected, and every request is fully self-contained. A fresh
      // transport + server per request means ANY replica can serve ANY request
      // with zero session affinity — this is the fix for the round-robin
      // "Session not found" 404s a multi-replica Deployment hit when sessions
      // lived in a per-replica in-memory Map. Trade-off: there is no standing GET
      // SSE stream, so resource push-subscriptions are not offered (createMcpServer
      // gates them off in stateless mode); resources/read and resources/list still
      // work over plain request/response. GET (405) and DELETE (200 no-op) are
      // handled by the transport itself in stateless mode.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const { server } = createMcpServer(config, { stateless: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    });
  }

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err) => {
      console.error("mcp-external request error:", err);
      if (res.headersSent) return;
      const status: number = (err && typeof err === "object" && "status" in err && typeof (err as any).status === "number") ? (err as any).status : 500;
      const code = status === 413 ? -32000 : err instanceof SyntaxError ? -32700 : -32603;
      const message = status === 413 ? "Request body too large" : err instanceof SyntaxError ? "Parse error" : "internal error";
      res.writeHead(status === 500 && err instanceof SyntaxError ? 400 : status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createHttpServer();
  server.listen(PORT, HOST, () => {
    console.error(`paperclip mcp-external listening on http://${HOST}:${PORT}${MCP_PATH}`);
  });
}

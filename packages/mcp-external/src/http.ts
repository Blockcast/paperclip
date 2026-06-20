#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./server.js";
import { readConfigFromEnv, type PaperclipExternalConfig } from "./config.js";
import { runWithBearer } from "./auth-context.js";

const HOST = process.env.MCP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.MCP_PORT ?? "9011");
const MCP_PATH = "/mcp";

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createHttpServer(config: PaperclipExternalConfig = readConfigFromEnv()) {
  // One transport per active session id (stateful streamable-HTTP).
  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== MCP_PATH) {
      res.writeHead(404).end();
      return;
    }
    // Capture the inbound bearer for the WHOLE request lifecycle.
    const bearer = req.headers.authorization ?? null;
    await runWithBearer(bearer, async () => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;
      const body = req.method === "POST" ? await readBody(req) : undefined;

      if (!transport) {
        if (req.method !== "POST" || !isInitializeRequest(body)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session; send initialize first." }, id: null }));
          return;
        }
        const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string): void => { transports.set(sid, created); },
        });
        created.onclose = () => {
          if (created.sessionId) transports.delete(created.sessionId);
        };
        const { server } = createMcpServer(config);
        await server.connect(created);
        transport = created;
      }
      await transport!.handleRequest(req, res, body);
    });
  }

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err) => {
      console.error("mcp-external request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }));
      }
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createHttpServer();
  server.listen(PORT, HOST, () => {
    console.error(`paperclip mcp-external listening on http://${HOST}:${PORT}${MCP_PATH}`);
  });
}

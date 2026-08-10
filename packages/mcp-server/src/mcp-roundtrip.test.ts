import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPaperclipMcpServer } from "./index.js";

const CONFIG = {
  apiUrl: "http://localhost:3100/api",
  apiKey: "token-123",
  companyId: "11111111-1111-1111-1111-111111111111",
  agentId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
};

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Wire a real McpServer to a real MCP Client over an in-memory transport. */
async function connectedClient() {
  const { server } = createPaperclipMcpServer(CONFIG);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

// BLO-18466 (review follow-up): the unit tests assert that `ToolDefinition.execute`
// returns `isError: true`, but the property that actually matters is what an MCP
// *client* sees after the result crosses `server.tool()` and the transport. If the
// SDK dropped the flag on the way out, every unit test would still pass while real
// agents kept reading denials as successes. This exercises the real boundary.
describe("MCP tools/call round trip", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers a denied write to the client as isError: true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockJsonResponse({ error: "deny_missing_grant", boundary: "grant" }, 403),
      ),
    );

    const client = await connectedClient();
    const result = await client.callTool({
      name: "paperclipUpdateIssue",
      arguments: {
        issueId: "75901b6e-8c97-40e1-8576-514de1f3f972",
        priority: "critical",
      },
    });

    expect(result.isError).toBe(true);

    const content = result.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]!.text) as Record<string, unknown>;
    expect(payload.status).toBe(403);
    // The BLO-18466 failure mode: no `priority` key to misread as unchanged.
    expect(payload).not.toHaveProperty("priority");
  });

  it("does not flag a successful write to the client", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockJsonResponse({ id: "75901b6e-8c97-40e1-8576-514de1f3f972", priority: "critical" }),
      ),
    );

    const client = await connectedClient();
    const result = await client.callTool({
      name: "paperclipUpdateIssue",
      arguments: {
        issueId: "75901b6e-8c97-40e1-8576-514de1f3f972",
        priority: "critical",
      },
    });

    expect(result.isError).toBeFalsy();
  });
});

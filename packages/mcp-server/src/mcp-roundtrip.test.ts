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

// BLO-27561: `q` is a literal contiguous ILIKE, so a multi-word phrase silently returns
// `[]` — indistinguishable from "no such issue exists" — while fleet-wide agent
// instructions mandate this exact call as the pre-filing duplicate gate. The fix is a
// call-time warning, which is only worth anything if it survives into the schema an MCP
// client actually receives. Asserting on the source constant would pass even if zod
// dropped `.describe()` on the way through `tools/list`, so this reads the served
// schema back over a real client, the same way an agent does.
describe("MCP tools/list served schema — BLO-27561 q substring warning", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  async function servedParamDescription(toolName: string, param: string) {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === toolName);
    expect(tool, `${toolName} missing from tools/list`).toBeDefined();

    const properties = (tool!.inputSchema as { properties?: Record<string, { description?: string }> })
      .properties;
    return { description: properties?.[param]?.description, toolDescription: tool!.description };
  }

  for (const [toolName, param] of [
    ["paperclipListIssues", "q"],
    ["paperclip_search_issues", "query"],
  ] as const) {
    it(`warns that ${toolName}.${param} is a non-tokenized substring match`, async () => {
      const { description } = await servedParamDescription(toolName, param);

      expect(description, `${toolName}.${param} has no served description`).toBeDefined();
      // The three things an agent must learn at call time: what the match IS, that
      // multi-word input is unreliable, and what to do instead.
      expect(description).toMatch(/NOT tokenized/);
      expect(description).toMatch(/MULTI-WORD INPUT IS UNRELIABLE/);
      expect(description).toMatch(/\b(one|single) distinctive token\b/i);
    });
  }

  it("keeps the alias and the primary parameter descriptions identical", async () => {
    const primary = await servedParamDescription("paperclipListIssues", "q");
    const alias = await servedParamDescription("paperclip_search_issues", "query");

    // The alias is the tool whose name most invites a phrase query, so it must not be
    // possible to fix the warning on one tool and leave the other stale.
    expect(alias.description).toBe(primary.description);
  });

  it("does not describe the alias as free-text 'search' in its tool description", async () => {
    const { toolDescription } = await servedParamDescription("paperclip_search_issues", "query");

    // "Search Paperclip issues by text" was the original wording, and it actively
    // invited the multi-word phrase queries that silently false-clear.
    expect(toolDescription).not.toMatch(/^Search Paperclip issues by text\./);
    expect(toolDescription).toMatch(/substring/i);
  });
});

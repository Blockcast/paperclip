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

async function connectedClient() {
  const { server } = createPaperclipMcpServer(CONFIG);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

// BLO-41373: every tool used to be registered as
// `server.tool(name, description, tool.schema.shape, execute)`. Passing the raw
// `ZodRawShape` made the SDK rebuild its OWN non-strict `z.object()`, so an
// undeclared argument was stripped before `execute` ran — and therefore before
// `makeTool`'s own `schema.parse(input)` could see it. A caller's filter vanished
// and the call returned a clean success over the unfiltered result.
//
// These assertions have to run over the real client/server transport. A
// schema-level test cannot see this defect: our schema was never the thing doing
// the stripping.
describe("MCP undeclared tool arguments — BLO-41373", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses an undeclared argument and names the offending key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const client = await connectedClient();
    const result = await client.callTool({
      name: "paperclipListAgents",
      arguments: { zzz_not_a_param: "x" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/zzz_not_a_param/);
    // The pre-fix behaviour was not just a missing error — the request went out
    // as if the key had never been passed. Nothing may reach the API.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a near-miss on a tool that does declare neighbouring params", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const client = await connectedClient();
    // `limit` and `offset` are real; `limitt` is the typo an agent actually makes,
    // and silently dropping it returned an unbounded page that read as complete.
    const result = await client.callTool({
      name: "paperclipListIssues",
      arguments: { status: "todo", limitt: 5 },
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toMatch(/limitt/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Non-vacuity: the suite above would also pass against a build that rejected
  // every call. A fully-supported argument set must still succeed AND still reach
  // the server carrying its arguments.
  it("still accepts a fully-supported argument set and passes it through", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const client = await connectedClient();
    const result = await client.callTool({
      name: "paperclipListIssues",
      arguments: { status: "todo", limit: 3, q: "BLO-41373" },
    });

    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toMatch(/status=todo/);
    expect(url).toMatch(/limit=3/);
    expect(url).toMatch(/q=BLO-41373/);
  });

  it("still accepts a no-argument call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: CONFIG.agentId }));
    vi.stubGlobal("fetch", fetchMock);

    const client = await connectedClient();
    const result = await client.callTool({ name: "paperclipMe", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The refusal is also advertised, so a client that validates locally can see it
  // without making the call. This reads the served `tools/list` schema the way an
  // agent does — asserting on our Zod object instead would pass even if the SDK
  // dropped strictness on the way out, which is exactly how the original defect
  // stayed invisible.
  it("serves additionalProperties: false for every built-in tool", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();

    expect(tools.length).toBeGreaterThan(40);
    const lax = tools.filter(
      (tool) => (tool.inputSchema as Record<string, unknown>).additionalProperties !== false,
    );
    expect(lax.map((tool) => tool.name)).toEqual([]);
  });
});

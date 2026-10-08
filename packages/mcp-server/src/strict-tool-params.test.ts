import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const openClients: Client[] = [];

async function connectedClient() {
  const { server } = createPaperclipMcpServer(CONFIG);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  openClients.push(client);
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

  // `restoreAllMocks` does not undo `stubGlobal`, and an unclosed linked pair
  // outlives its test; both would leak into the next case.
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(openClients.splice(0).map((client) => client.close()));
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

  // Every built-in tool, over the transport. The served `tools/list` schema
  // cannot carry this property: `additionalProperties: false` is emitted for a
  // plain zod object as well as a strict one, so it read the same before the fix.
  // The error has to NAME the junk key -- tools with required params fail
  // pre-fix too, but on the missing params, with the junk key already stripped.
  it("refuses an undeclared argument on every built-in tool, by name, before any request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(40);

    const accepted: string[] = [];
    for (const tool of tools) {
      const result = await client.callTool({
        name: tool.name,
        arguments: { zzz_not_a_param: "x" },
      });
      const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
      if (result.isError !== true || !text.includes("zzz_not_a_param")) accepted.push(tool.name);
    }
    expect(accepted).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // BLO-41373 blast radius: `summary` is the one key agents send most often to
  // paperclipAddComment. A bare "Unrecognized key" names it without saying where
  // the text belongs, so it is declared and refused with the remedy instead.
  it("refuses `summary` on paperclipAddComment and says the text goes in `body`", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const client = await connectedClient();
    const result = await client.callTool({
      name: "paperclipAddComment",
      arguments: { issueId: "BLO-1", body: "done", summary: "done" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/summary/);
    expect(text).toMatch(/`body`/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

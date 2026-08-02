import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperclipApiClient } from "./client.js";
import { loadPluginToolDefinitions } from "./plugin-tools.js";

function makeClient() {
  return new PaperclipApiClient({
    apiUrl: "http://localhost:3100/api",
    apiKey: "token-123",
    companyId: "11111111-1111-1111-1111-111111111111",
    agentId: "22222222-2222-2222-2222-222222222222",
    runId: "33333333-3333-3333-3333-333333333333",
  });
}

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TOOL_REGISTRY = [
  {
    name: "acme.linear:search-issues",
    description: "Search Linear issues",
    pluginId: "acme.linear",
    parametersSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
];

/**
 * Stub the registry fetch, then the `/plugins/tools/execute` fetch, and return
 * the single wrapped plugin tool.
 */
async function loadToolWithExecuteResponse(executeResponse: Response) {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(mockJsonResponse(TOOL_REGISTRY))
    .mockResolvedValueOnce(executeResponse);
  vi.stubGlobal("fetch", fetchMock);

  const [tool] = await loadPluginToolDefinitions(makeClient());
  if (!tool) throw new Error("Expected a wrapped plugin tool");
  return { tool, fetchMock };
}

describe("plugin tool wrapper", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // BLO-18466 (review follow-up): `POST /plugins/tools/execute` answers
  // `ToolExecutionResult` — `{ pluginId, toolName, result: ToolResult }` — and a
  // failing plugin tool reports it as `result.error` on an HTTP *200*. The
  // wrapper previously tested a nonexistent top-level `ok === false`, so these
  // failures never reached `formatErrorResponse` and MCP clients received them
  // as successful calls: the same success-shaped-failure class this issue is
  // about, on the plugin path rather than the built-in one.
  it("surfaces an HTTP-200 plugin failure as an MCP error", async () => {
    const { tool } = await loadToolWithExecuteResponse(
      mockJsonResponse({
        pluginId: "acme.linear",
        toolName: "search-issues",
        result: { error: "Linear API rate limit exceeded" },
      }),
    );

    const response = await tool.execute({ query: "open bugs" });

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0]!.text) as Record<string, unknown>;
    expect(payload.error).toContain("Linear API rate limit exceeded");
    // The tool name is retained so the agent knows which call failed.
    expect(payload.error).toContain("acme.linear:search-issues");
  });

  it("does not mark a successful plugin tool call as an error", async () => {
    const { tool } = await loadToolWithExecuteResponse(
      mockJsonResponse({
        pluginId: "acme.linear",
        toolName: "search-issues",
        result: { content: "3 issues found", data: { count: 3 } },
      }),
    );

    const response = await tool.execute({ query: "open bugs" });

    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.content[0]!.text)).toMatchObject({
      content: "3 issues found",
    });
  });

  // An empty-string `error` is not a failure signal under the SDK contract
  // ("if present, indicates the tool call failed" — a blank string is not).
  it("treats an empty error string as success rather than a failure", async () => {
    const { tool } = await loadToolWithExecuteResponse(
      mockJsonResponse({
        pluginId: "acme.linear",
        toolName: "search-issues",
        result: { content: "no matches", error: "" },
      }),
    );

    const response = await tool.execute({ query: "open bugs" });

    expect(response.isError).toBeUndefined();
  });

  it("surfaces a non-2xx execute response as an MCP error", async () => {
    const { tool } = await loadToolWithExecuteResponse(
      mockJsonResponse({ error: "worker for plugin acme.linear is not running" }, 502),
    );

    const response = await tool.execute({ query: "open bugs" });

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0]!.text) as Record<string, unknown>;
    expect(payload.status).toBe(502);
  });
});

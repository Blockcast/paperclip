import { describe, it, expect, vi } from "vitest";
import { createToolDefinitions } from "./tools.js";
import { runWithBearer } from "./auth-context.js";
import { PaperclipApiError } from "./client.js";

function clientReturning(body: unknown) {
  return { requestJson: vi.fn(async () => body) } as any;
}

// NOTE: these tests call tool.execute(args) directly, bypassing the MCP SDK's
// Zod parse. So an absent optional arrives as `undefined`, not its schema
// default (e.g. company_id default "") — resolveCompany handles both identically
// (see client.test.ts resolveCompany suite). Assertions reflect the direct-call path.
function okClient(body: unknown = { ok: "data" }) {
  return {
    requestJson: vi.fn(async () => body),
    resolveCompany: vi.fn(async (i: { override?: string | null } = {}) => i.override?.trim() || "co-default"),
  } as any;
}
function tool(client: any, name: string) {
  return createToolDefinitions(client).find((t) => t.name === name)!;
}

describe("get_agent tool", () => {
  it("is registered as snake_case get_agent", () => {
    const tools = createToolDefinitions(clientReturning({}));
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_agent");
  });

  it("defaults agent_id to 'me' → GET /agents/me", async () => {
    const client = clientReturning({ id: "agent-me" });
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    const res = await runWithBearer("Bearer X", () => tool.execute({ agent_id: "me" }, {} as any));
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/agents/me");
    expect(res.content[0].text).toContain("agent-me");
  });

  it("routes a concrete id to /agents/<id>", async () => {
    const client = clientReturning({ id: "abc" });
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    await tool.execute({ agent_id: "abc" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/agents/abc");
  });

  it("treats empty/whitespace agent_id as 'me'", async () => {
    const client = clientReturning({ id: "x" });
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    await tool.execute({ agent_id: "   " }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/agents/me");
  });

  it("URL-encodes a non-'me' agent_id path segment", async () => {
    const client = clientReturning({ id: "x" });
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    await tool.execute({ agent_id: "a/b c" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/agents/a%2Fb%20c");
  });
});

describe("runTool (via get_agent)", () => {
  it("maps an empty/null API result to { ok: true }", async () => {
    const client = { requestJson: vi.fn(async () => null) } as any;
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    const res = await tool.execute({ agent_id: "me" }, {} as any);
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true });
  });

  it("maps a 409 to Python's do-not-retry payload", async () => {
    const client = {
      requestJson: vi.fn(async () => {
        throw new PaperclipApiError({ status: 409, method: "GET", path: "/agents/me", body: null, message: "x" });
      }),
    } as any;
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    const res = await tool.execute({ agent_id: "me" }, {} as any);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.isError).toBe(true);
    expect(payload.status).toBe(409);
    expect(payload.message).toMatch(/Do not retry/i);
  });

  it("maps a non-409 API error to { isError, status, message }", async () => {
    const client = {
      requestJson: vi.fn(async () => {
        throw new PaperclipApiError({ status: 403, method: "GET", path: "/agents/me", body: "forbidden", message: "x" });
      }),
    } as any;
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    const res = await tool.execute({ agent_id: "me" }, {} as any);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.isError).toBe(true);
    expect(payload.status).toBe(403);
    expect(payload.message).toMatch(/HTTP 403 from Paperclip API/);
    expect(payload.message).toMatch(/forbidden/);
  });

  it("re-throws non-PaperclipApiError errors", async () => {
    const client = {
      requestJson: vi.fn(async () => {
        throw new Error("company not found");
      }),
    } as any;
    const tool = createToolDefinitions(client).find((t) => t.name === "get_agent")!;
    await expect(tool.execute({ agent_id: "me" }, {} as any)).rejects.toThrow("company not found");
  });
});

describe("list_issues", () => {
  it("GETs the company issues path with default status/limit and resolved company", async () => {
    const client = okClient([]);
    await tool(client, "list_issues").execute({}, {} as any);
    expect(client.resolveCompany).toHaveBeenCalledWith({ override: undefined });
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/companies/co-default/issues", {
      query: { status: "todo,in_progress", limit: 50 },
      companyId: "co-default",
    });
  });

  it("passes filters and clamps limit to 200", async () => {
    const client = okClient([]);
    await tool(client, "list_issues").execute(
      { status: "done", assignee_agent_id: "ag-1", project_id: "pr-1", label: "bug", q: "crash", limit: 9999, company_id: "PEN" },
      {} as any,
    );
    expect(client.resolveCompany).toHaveBeenCalledWith({ override: "PEN" });
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/companies/PEN/issues", {
      query: { status: "done", limit: 200, assigneeAgentId: "ag-1", projectId: "pr-1", label: "bug", q: "crash" },
      companyId: "PEN",
    });
  });
});

describe("get_issue", () => {
  it("GETs /issues/<id> with no company scoping", async () => {
    const client = okClient({ id: "PEN-1" });
    await tool(client, "get_issue").execute({ issue_id: "PEN-1" }, {} as any);
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/issues/PEN-1");
    expect(client.resolveCompany).not.toHaveBeenCalled();
  });
});

describe("paperclip_search_issues", () => {
  it("is registered and forwards query as q to the issues path", async () => {
    const client = okClient([]);
    await tool(client, "paperclip_search_issues").execute({ query: "crash", limit: 10 }, {} as any);
    expect(client.resolveCompany).toHaveBeenCalledWith({ override: undefined });
    expect(client.requestJson).toHaveBeenCalledWith("GET", "/companies/co-default/issues", {
      query: { status: "todo,in_progress", limit: 10, q: "crash" },
      companyId: "co-default",
    });
  });
});

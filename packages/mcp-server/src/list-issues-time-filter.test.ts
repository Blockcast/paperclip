import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TIME_FILTER_PREFIXES, TIME_FILTER_SUFFIXES } from "@paperclipai/shared";
import { createPaperclipMcpServer } from "./index.js";

/**
 * Regression test for BLO-40145, at the MCP boundary.
 *
 * `GET /companies/:id/issues` implements no time bound. The route now 400s any
 * param of that shape — but that rejection is UNREACHABLE from an MCP caller,
 * which is the caller the defect was reported against. `index.ts` registers
 * tools as `server.tool(name, desc, schema.shape, execute)`, and the SDK
 * rebuilds its own non-strict object from the raw shape, so an UNDECLARED key
 * is stripped before the request is built. Measured before the fix, over this
 * same real client/server transport: `paperclipListIssues` with `updated_after`
 * issued `?q=Cilium&limit=3` — no `updated_after` — and returned no error.
 *
 * So the route test and this one are not duplicates: they cover two different
 * layers, and only this one exercises the path named in the issue. It runs over
 * the real transport for the same reason the BLO-18466 round-trip test does —
 * what matters is what a client actually sees.
 */

const CONFIG = {
  apiUrl: "http://localhost:3100/api",
  apiKey: "token-123",
  companyId: "11111111-1111-1111-1111-111111111111",
  agentId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
};

async function connectedClient(onFetch: (url: string) => void) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      onFetch(String(url));
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );

  const { server } = createPaperclipMcpServer(CONFIG);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

// Every snake_case and camelCase alias of the shared prefix x suffix lists the
// route regex is built from — derived here rather than hand-listed, so a list
// entry the tool fails to declare (and so silently strips) turns this red.
const TIME_FILTER_ALIASES = TIME_FILTER_PREFIXES.flatMap((prefix) =>
  TIME_FILTER_SUFFIXES.flatMap((suffix) => [
    `${prefix}_${suffix}`,
    `${prefix}${suffix[0].toUpperCase()}${suffix.slice(1)}`,
  ]),
);

/**
 * The refusal arrives as a RESULT carrying `isError: true`, not as a thrown
 * McpError — the SDK's `validateToolInput` rejects the arguments against the
 * registered shape before `makeTool` runs, and the SDK's CallTool handler turns
 * that McpError into an error result. Asserting on a rejection instead would
 * fail against a perfectly good refusal, and asserting only on `isError` would
 * pass against any unrelated error, so check the text.
 */
function errorText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  expect(result.isError).toBe(true);
  return JSON.stringify(result.content);
}

describe("paperclipListIssues time-bound params", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it.each(TIME_FILTER_ALIASES)("refuses %s instead of silently dropping it", async (param) => {
    const urls: string[] = [];
    const client = await connectedClient((u) => urls.push(u));

    const result = await client.callTool({
      name: "paperclipListIssues",
      arguments: { [param]: "2026-10-04T13:31:15Z", limit: 3 },
    });

    expect(errorText(result)).toContain("not supported on this endpoint");
    // The real damage was serving a corpus-wide page that read as a bounded
    // census, so assert no request was issued at all — not merely that an
    // error came back.
    expect(urls).toEqual([]);
  });

  // The originally-filed reproducer. Refused with and without the narrowing
  // filters, so the "it composes badly" theory cannot be re-derived.
  it.each([
    ["with q", { q: "Cilium" }],
    ["with originKind", { originKind: "plugin:paperclip-plugin-alertmanager" }],
    ["with both", { q: "Cilium", originKind: "manual" }],
  ])("refuses updated_after %s", async (_label, extra) => {
    const urls: string[] = [];
    const client = await connectedClient((u) => urls.push(u));

    const result = await client.callTool({
      name: "paperclipListIssues",
      arguments: { updated_after: "2026-10-04T13:31:15Z", limit: 3, ...extra },
    });

    expect(errorText(result)).toContain("not supported on this endpoint");
    expect(urls).toEqual([]);
  });

  it("names where a real time bound lives, so the caller is not just blocked", async () => {
    const client = await connectedClient(() => {});
    const result = await client.callTool({
      name: "paperclipListIssues",
      arguments: { updated_after: "2026-10-04T13:31:15Z" },
    });

    expect(errorText(result)).toContain("companies/:companyId/search");
  });

  // Non-vacuity: a suite that only asserts rejections passes just as well on a
  // tool that rejects everything. These are the filters the defect report said
  // "void" the bound — they must still work, and still reach the server.
  it("still serves the filters the bug was blamed on", async () => {
    const urls: string[] = [];
    const client = await connectedClient((u) => urls.push(u));

    const result = await client.callTool({
      name: "paperclipListIssues",
      arguments: {
        q: "Cilium",
        originKind: "manual",
        status: "blocked",
        projectId: "584f37b3-a054-4678-a149-38e9eab86d2c",
        limit: 3,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("q=Cilium");
    expect(urls[0]).toContain("originKind=manual");
    expect(urls[0]).toContain("status=blocked");
    expect(urls[0]).not.toContain("updated_after");
  });
});

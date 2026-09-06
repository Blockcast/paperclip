import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayServer, type GatewayState } from "./server.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { MCP_SESSION_HEADER } from "./session-keepalive.js";
import type { UpstreamConfig } from "./upstreams.js";

/**
 * End-to-end proof for PEN-2735: the gateway's GRANT axis.
 *
 * PEN-2370 closed the *response-content* axis — what a permitted read hands
 * back. This closes the other one that ticket names: which tools an upstream is
 * permitted to expose at all. The two are not substitutes. `prometheus`'s
 * `get_targets` returns `discoveredLabels`, a verbatim copy of every annotation
 * on every scraped object — including `kubectl.kubernetes.io/last-applied-
 * configuration`, which embeds the same `spec.containers[].env` PEN-2370 exists
 * to redact. No response scrubber reaches a disclosure whose right control is
 * "this tool should not be offered".
 *
 * These tests drive the real gateway against a fake upstream that RECORDS every
 * request it receives, because the load-bearing claim is a negative: a denied
 * `tools/call` must never reach the upstream. Asserting only on the reply would
 * pass just as happily if the call executed and its result were discarded.
 *
 * Both agent-facing endpoints are exercised for every rule. `/mcp` aggregates
 * and `/<prefix>/mcp` proxies, they are different code paths, and the seeded
 * agent config dials the prefixed one. A guard proven on the aggregate alone
 * would be a control on the route nobody uses — the entry-point-shaped coverage
 * gap this series has now hit five times.
 */

const LEAK = "LEAKED_PLAINTEXT_MUST_NOT_SURVIVE";

/** The tool we deny: PEN-2735's actual subject. */
const DENIED_TOOL = "get_targets";
const ALLOWED_TOOLS = ["execute_query", "list_metrics"];

/**
 * A tool description carrying pod env material, the way `get_targets` carries it
 * in `discoveredLabels`. On an ALLOWED tool this must still be redacted — the
 * allowlist removes a tool, it does not excuse the scrubber from the rest.
 */
const DESCRIPTION_WITH_ENV = [
  "Runs a query. Example target:",
  "spec:",
  "  containers:",
  "  - name: agent",
  "    env:",
  "    - name: OPENAI_API_KEY",
  `      value: ${LEAK}`,
].join("\n");

interface UpstreamRecorder {
  url: string;
  /** Every JSON-RPC method the upstream was actually asked to run. */
  received: Array<{ method: string; tool?: string }>;
}

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
 * Fake metrics MCP upstream. `format` selects the framing of the `tools/list`
 * reply so the filter is proven on both transports the real servers use — the
 * filter shares the scrubber's classifier precisely so it cannot know only one.
 */
async function createToolUpstream(format: "json" | "sse" = "json"): Promise<UpstreamRecorder> {
  const received: UpstreamRecorder["received"] = [];
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    // A JSON-RPC request may be a single object or a BATCH array, and a batch
    // is answered with an array of responses. Deriving that from the request
    // rather than from a `format` flag keeps the fake honest: the array-shaped
    // reply exists here for the same reason it exists in a real upstream.
    const parsed = JSON.parse(raw) as unknown;
    const batched = Array.isArray(parsed);
    const message = (batched ? (parsed as unknown[])[0] : parsed) as {
      id?: number;
      method?: string;
      params?: { name?: string };
    };

    if (message.method === "initialize") {
      res.statusCode = 200;
      res.setHeader(MCP_SESSION_HEADER, "upstream-session-1");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id ?? 1,
        result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "metrics", version: "1" } },
      }));
      return;
    }
    if (message.method?.startsWith("notifications/")) {
      res.statusCode = 202;
      res.end();
      return;
    }

    // Only lifecycle traffic is excluded from the ledger: `initialize` and the
    // notification are session plumbing the gateway issues on its own, not calls
    // an agent made. Everything else is recorded, so "never reached upstream"
    // is a claim about this array.
    received.push({ method: message.method ?? "?", ...(message.params?.name ? { tool: message.params.name } : {}) });

    if (message.method === "tools/list") {
      const response = {
        jsonrpc: "2.0",
        id: message.id ?? 1,
        result: {
          tools: [
            { name: ALLOWED_TOOLS[0], description: DESCRIPTION_WITH_ENV },
            { name: DENIED_TOOL, description: "Returns discoveredLabels for every scrape target." },
            { name: ALLOWED_TOOLS[1], description: "Lists metric names." },
          ],
        },
      };
      const payload = JSON.stringify(batched ? [response] : response);

      res.statusCode = 200;
      if (format === "sse") {
        res.setHeader("content-type", "text/event-stream");
        res.end(`event: message\ndata: ${payload}\n\n`);
      } else {
        res.setHeader("content-type", "application/json");
        res.end(payload);
      }
      return;
    }

    if (message.method === "resources/read") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id ?? 1,
        result: { contents: [{ uri: "k8s://pod", text: DESCRIPTION_WITH_ENV }] },
      }));
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id ?? 1,
      result: { content: [{ type: "text", text: `executed ${message.params?.name ?? "?"}` }] },
    }));
  });
  return { url: await listen(server), received };
}

async function createGatewayEndpoints(
  upstreamUrl: string,
  tools?: string[],
): Promise<{ prefixed: string; aggregate: string }> {
  const upstream: UpstreamConfig = { url: upstreamUrl, credentialHeaders: [], ...(tools ? { tools } : {}) };
  const state: GatewayState = {
    upstreams: { prometheus: upstream },
    sessions: new Map(),
    upstreamCallCounts: new Map(),
    upstreamTimeoutMs: 60_000,
    breaker: new CircuitBreaker({ failureThreshold: 5, openCooldownMs: 30_000, halfOpenMaxProbes: 1 }),
  };
  const aggregate = await listen(createGatewayServer(state));
  return { aggregate, prefixed: aggregate.replace(/\/mcp$/, "/prometheus/mcp") };
}

async function post(url: string, body: string | Buffer): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: typeof body === "string" ? body : new Uint8Array(body),
  });
  return { status: response.status, text: await response.text() };
}

function listRequest(): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
}

function callRequest(name: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: {} } });
}

/**
 * Lift the JSON-RPC document out of whichever framing carried it, so a test can
 * assert on its *shape* rather than only on substrings of the wire body.
 */
function documentOf(text: string, format: "json" | "sse"): string {
  if (format !== "sse") return text;
  const data = text.split(/\r\n|\n|\r/).find((line) => line.startsWith("data:"));
  if (!data) throw new Error(`no SSE data line in response: ${text}`);
  return data.slice("data:".length).trim();
}

describe("PEN-2735: an upstream can only expose the tools its grant allows", () => {
  describe.each(["json", "sse"] as const)("tools/list filtering (%s framing)", (format) => {
    it("omits the denied tool from the prefixed route, the one the agent seed dials", async () => {
      const upstream = await createToolUpstream(format);
      const { prefixed } = await createGatewayEndpoints(upstream.url, ALLOWED_TOOLS);

      const { status, text } = await post(prefixed, listRequest());

      expect(status).toBe(200);
      expect(text).not.toContain(DENIED_TOOL);
      for (const allowed of ALLOWED_TOOLS) expect(text).toContain(allowed);
    });
  });

  describe.each(["json", "sse"] as const)(
    "tools/list filtering inside a JSON-RPC BATCH response (%s framing)",
    (format) => {
      it("omits the denied tool when the upstream answers with an array of responses", async () => {
        // A batch request is answered with an ARRAY of response objects. The
        // filter previously bailed on any array document, so a batched
        // `tools/list` returned denied tool definitions in full while
        // single-object listings were filtered — the guard read as done and was
        // open on the sibling spelling. The request side already inspects calls
        // inside a batch (see "refuses a denied call wrapped in a JSON-RPC batch
        // array"), so this was the response-side mirror of a hole already closed
        // in the other direction, which is this file's recurring shape.
        const upstream = await createToolUpstream(format);
        const { prefixed } = await createGatewayEndpoints(upstream.url, ALLOWED_TOOLS);

        const { status, text } = await post(prefixed, `[${listRequest()}]`);

        expect(status).toBe(200);
        // Assert the batch framing actually survived, so a future change that
        // unwraps the array cannot make this pass for the wrong reason. The
        // document has to be lifted out of its SSE frame first — the response
        // keeps whatever framing the upstream used.
        expect(JSON.parse(documentOf(text, format))).toBeInstanceOf(Array);
        expect(text).not.toContain(DENIED_TOOL);
        for (const allowed of ALLOWED_TOOLS) expect(text).toContain(allowed);
      });

      it("still redacts env material inside a batch, so both arms agree on what a document is", async () => {
        // The redaction arm always walked arrays; the tool filter did not. That
        // disagreement inside one composed transform is the actual defect, so
        // pin both arms on the same batch body rather than the filter alone.
        const upstream = await createToolUpstream(format);
        const { prefixed } = await createGatewayEndpoints(upstream.url, ALLOWED_TOOLS);

        const { text } = await post(prefixed, `[${listRequest()}]`);

        expect(text).not.toContain(LEAK);
        expect(text).toContain("<redacted>");
        expect(text).toContain("OPENAI_API_KEY");
        expect(text).toContain(ALLOWED_TOOLS[0]!);
      });
    },
  );

  it("omits the denied tool from the aggregate route", async () => {
    const upstream = await createToolUpstream("json");
    const { aggregate } = await createGatewayEndpoints(upstream.url, ALLOWED_TOOLS);

    const { text } = await post(aggregate, listRequest());

    expect(text).not.toContain(DENIED_TOOL);
    expect(text).toContain(`prometheus__${ALLOWED_TOOLS[0]}`);
  });

  it("documents a PRE-EXISTING aggregate limitation: an SSE upstream contributes no tools", async () => {
    // Not caused by, and not fixed by, this change — the same assertion holds on
    // the parent commit. The aggregate `tools/list` assembly parses each
    // upstream reply with a bare `JSON.parse`, so an upstream that frames its
    // listing as SSE (legal, and what the streamable-HTTP transport does) throws,
    // is caught, warns, and contributes nothing.
    //
    // Recorded rather than quietly worked around, because it is a THIRD place
    // that decides where a document begins, next to the two `response-scrub.ts`
    // was refactored to unify. It is out of scope here for one reason only: it
    // fails CLOSED. Tools go missing; nothing is disclosed. That makes it an
    // availability bug to be fixed on its own ticket, not a hole in this guard —
    // and the prefixed route above, which the agent seed actually dials, filters
    // both framings correctly.
    const upstream = await createToolUpstream("sse");
    const { aggregate } = await createGatewayEndpoints(upstream.url, ALLOWED_TOOLS);

    const { text } = await post(aggregate, listRequest());

    expect(text).toContain('"tools":[]');
  });

  it("still redacts env material in the descriptions of the tools it keeps", async () => {
    // The allowlist removes a tool; it does not turn the scrubber off for the
    // rest of the same body. Both rewrites ride one pass over one parse, and
    // this is the assertion that they compose rather than displace each other.
    const upstream = await createToolUpstream();
    const { prefixed } = await createGatewayEndpoints(upstream.url, ALLOWED_TOOLS);

    const { text } = await post(prefixed, listRequest());

    expect(text).not.toContain(LEAK);
    expect(text).toContain("<redacted>");
    expect(text).toContain("OPENAI_API_KEY");
  });

  it("leaves an upstream with no allowlist completely unrestricted", async () => {
    // Absence of `tools` must mean "as before". Every upstream in the seed is in
    // this state until its registry entry opts in, so a regression here is a
    // silent outage across the fleet rather than a security finding.
    const upstream = await createToolUpstream();
    const { prefixed, aggregate } = await createGatewayEndpoints(upstream.url);

    expect((await post(prefixed, listRequest())).text).toContain(DENIED_TOOL);
    expect((await post(aggregate, listRequest())).text).toContain(`prometheus__${DENIED_TOOL}`);

    const { text } = await post(prefixed, callRequest(DENIED_TOOL));
    expect(text).toContain(`executed ${DENIED_TOOL}`);
    expect(upstream.received).toContainEqual({ method: "tools/call", tool: DENIED_TOOL });
  });

  it("denies every tool when the allowlist is empty, rather than reading it as 'all'", async () => {
    const upstream = await createToolUpstream();
    const { prefixed } = await createGatewayEndpoints(upstream.url, []);

    const { text } = await post(prefixed, listRequest());

    for (const name of [...ALLOWED_TOOLS, DENIED_TOOL]) expect(text).not.toContain(name);
  });
});

/**
 * The half that matters most. A response filter can only remove a tool from a
 * listing — it cannot un-execute a call. Every case here asserts the negative
 * against the upstream's own ledger, not against the gateway's reply.
 */
describe("PEN-2735: a denied tools/call never reaches the upstream", () => {
  it("refuses the call on the prefixed route", async () => {
    const upstream = await createToolUpstream();
    const { prefixed } = await createGatewayEndpoints(upstream.url, ALLOWED_TOOLS);

    const { status, text } = await post(prefixed, callRequest(DENIED_TOOL));

    expect(status).toBe(200);
    expect(text).toContain("unknown tool");
    expect(text).not.toContain("executed");
    expect(upstream.received).toEqual([]);
  });

  it("refuses the call on the aggregate route", async () => {
    const upstream = await createToolUpstream();
    const { aggregate } = await createGatewayEndpoints(upstream.url, ALLOWED_TOOLS);

    const { text } = await post(aggregate, callRequest(`prometheus__${DENIED_TOOL}`));

    expect(text).toContain("unknown aggregated tool name");
    expect(upstream.received).toEqual([]);
  });

  it("still forwards an allowed call, so the guard is not simply refusing everything", async () => {
    // Without this, every assertion above is satisfied by a gateway that denies
    // unconditionally — a control that blocks all traffic passes every
    // "must not reach upstream" test ever written.
    const upstream = await createToolUpstream();
    const { prefixed } = await createGatewayEndpoints(upstream.url, ALLOWED_TOOLS);

    const { text } = await post(prefixed, callRequest(ALLOWED_TOOLS[0]!));

    expect(text).toContain(`executed ${ALLOWED_TOOLS[0]}`);
    expect(upstream.received).toContainEqual({ method: "tools/call", tool: ALLOWED_TOOLS[0] });
  });

  it("refuses a denied call on an ALREADY-ESTABLISHED session", async () => {
    // `serveMatched` has a fast path for a known client session that skips the
    // bootstrap entirely. A guard proven only on a first, session-less request
    // would be a guard on the cold path — every real agent call after the first
    // takes this one.
    const upstream = await createToolUpstream();
    const { prefixed } = await createGatewayEndpoints(upstream.url, ALLOWED_TOOLS);

    const first = await fetch(prefixed, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: callRequest(ALLOWED_TOOLS[0]!),
    });
    expect(await first.text()).toContain(`executed ${ALLOWED_TOOLS[0]}`);
    const session = first.headers.get(MCP_SESSION_HEADER);
    expect(session, "the allowed call must establish a session for this test to mean anything").toBeTruthy();

    const denied = await fetch(prefixed, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        [MCP_SESSION_HEADER]: session!,
      },
      body: callRequest(DENIED_TOOL),
    });

    expect(await denied.text()).toContain("unknown tool");
    expect(upstream.received).toEqual([{ method: "tools/call", tool: ALLOWED_TOOLS[0] }]);
  });

  it("refuses a denied call wrapped in a JSON-RPC batch array", async () => {
    // `parseJsonRpcRequest` rejects arrays, so a batch reaches the proxy with
    // no parsed message at all and is forwarded unexamined. A guard written
    // against the single-object shape is bypassed by adding two brackets.
    const upstream = await createToolUpstream();
    const { prefixed } = await createGatewayEndpoints(upstream.url, ALLOWED_TOOLS);

    const { text } = await post(prefixed, `[${callRequest(DENIED_TOOL)}]`);

    expect(text).toContain("unknown tool");
    expect(upstream.received).toEqual([]);
  });

  it("refuses a denied call whose body opens on a UTF-8 BOM", async () => {
    // `JSON.parse` rejects a leading BOM, so a request parser that does not
    // strip it reads the body as unparseable and forwards it unexamined. This
    // is the request-side mirror of the BOM fail-open PEN-2370 closed on the
    // response side; the two now share one `stripLeadingBom`.
    const upstream = await createToolUpstream();
    const { prefixed } = await createGatewayEndpoints(upstream.url, ALLOWED_TOOLS);

    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(callRequest(DENIED_TOOL))]);
    const { text } = await post(prefixed, body);

    expect(text).toContain("unknown tool");
    expect(upstream.received).toEqual([]);
  });

  it("refuses a tools/call carrying no usable tool name", async () => {
    // Fail closed: a malformed call must not be the way past an allowlist.
    const upstream = await createToolUpstream();
    const { prefixed } = await createGatewayEndpoints(upstream.url, ALLOWED_TOOLS);

    const { text } = await post(
      prefixed,
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { arguments: {} } }),
    );

    expect(text).toContain("unknown tool");
    expect(upstream.received).toEqual([]);
  });
});

/**
 * ⭐ The residual, asserted rather than asserted-in-a-comment.
 *
 * PEN-2370's standing method: after a remediation, go looking for the same
 * material by another route. Applied to this patch, the answer is that the
 * allowlist is TOOLS-scoped, and MCP has other primitives. A reader who takes
 * "the grant axis is closed" literally would be wrong, so the boundary is pinned
 * here as executable fact — the shape that has bitten this series six times is a
 * scope claim that lived only in prose.
 *
 * Two facts, both load-bearing, and they point in opposite directions:
 *   - a non-tool primitive is NOT filtered by the allowlist, and
 *   - it IS still covered by PEN-2370's response scrubber.
 *
 * So the residual is narrow but real: an upstream could disclose material
 * through `resources/read` that the allowlist has no opinion about. It is
 * bounded by the scrubber, not by the grant. If these ever disagree — a
 * primitive that is neither tool-filtered nor scrubbed — that is door #N, and
 * this test is where it should surface.
 */
describe("PEN-2735 residual: the allowlist governs tools, and only tools", () => {
  it("does not filter a non-tool primitive, but does still scrub it", async () => {
    const upstream = await createToolUpstream();
    const { prefixed } = await createGatewayEndpoints(upstream.url, ALLOWED_TOOLS);

    const { text } = await post(
      prefixed,
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "resources/read", params: { uri: "k8s://pod" } }),
    );

    // Not tool-filtered: the request reached the upstream and was answered.
    expect(upstream.received).toContainEqual({ method: "resources/read" });
    // ...but the scrubber still stands between that answer and the agent.
    expect(text).not.toContain(LEAK);
    expect(text).toContain("<redacted>");
  });

  it("gives the aggregate endpoint no non-tool route at all", async () => {
    // The aggregate handles initialize/tools-list/tools-call and refuses the
    // rest, so the residual above is reachable on the prefixed route only.
    const upstream = await createToolUpstream();
    const { aggregate } = await createGatewayEndpoints(upstream.url, ALLOWED_TOOLS);

    const { text } = await post(
      aggregate,
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "resources/read", params: { uri: "k8s://pod" } }),
    );

    expect(text).toContain("is not supported by aggregate endpoint");
    expect(upstream.received).toEqual([]);
  });
});

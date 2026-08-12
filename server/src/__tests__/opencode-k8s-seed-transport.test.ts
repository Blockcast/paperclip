import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const statefulSetPath = path.join(repoRoot, "deploy/helm/paperclip/templates/statefulset.yaml");
const opencodeBin = path.join(repoRoot, "server/node_modules/.bin/opencode");
// Steady-state bound for a regression run: once the state home is migrated, a healthy run finishes
// in well under this, so it still fails fast on a genuinely hung subprocess while leaving room for
// slower CI hosts. Most of a healthy run is the deliberate CALLER_TIMEOUT_MS hung-call assertion.
const RUN_WATCHDOG_MS = 60_000;
// OpenCode migrates its SQLite store once per state home and warns the migration "may take a few
// minutes". That is startup cost, not regression work, so it gets a budget of its own.
const MIGRATION_TIMEOUT_MS = 240_000;
// Keep the vitest budget above both spawns' watchdogs so a hang is reported by the watchdog, with
// its stdout/stderr diagnostics, rather than as an opaque vitest timeout.
const TEST_TIMEOUT_MS = RUN_WATCHDOG_MS * 2 + 30_000;
const IDLE_WINDOW_MS = 610_000;
const OPENCODE_FALLBACK_TIMEOUT_MS = 1_000;
const CALLER_TIMEOUT_MS = 10_000;
const CALLER_TIMEOUT_EARLY_TOLERANCE_MS = 1_500;
const FIXTURE_CLOSE_OBSERVATION_TOLERANCE_MS = 5_000;

type SeedEntry = { type: "http" | "sse"; url: string };
type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
};
type PlannedCall = {
  tool: "pods_list_in_namespace" | "persistent_volume_claims" | "events_list" | "nodes_list";
  arguments: Record<string, unknown>;
};
type CapturedCall = PlannedCall & {
  status: "ok" | "initialization_error" | "timed_out";
  atMs: number;
};

const servers: Server[] = [];
const tempDirs: string[] = [];
const suiteDirs: string[] = [];
// One migrated OpenCode state home is shared by every spawn in this suite; each spawn still gets
// its own project directory, so runs stay isolated without re-paying the migration.
let opencodeStateHome = "";

function readK8sRoSeed(): SeedEntry {
  const source = readFileSync(statefulSetPath, "utf8");
  const entryStart = source.indexOf('"k8s-ro": {');
  if (entryStart < 0) throw new Error("k8s-ro is absent from the shared MCP seed");
  const objectStart = source.indexOf("{", entryStart);
  const closingIndent = "\n                  ";
  const objectEnd = source.indexOf(`${closingIndent}}`, objectStart);
  if (objectEnd < 0) throw new Error("k8s-ro shared MCP seed entry is malformed");
  return JSON.parse(source.slice(objectStart, objectEnd + closingIndent.length + 1)) as SeedEntry;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function rpcResult(message: JsonRpcMessage, result: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id: message.id ?? 0, result });
}

function rpcError(message: JsonRpcMessage, error: string) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: message.id ?? 0,
    error: { code: 0, message: error },
  });
}

function initializeResult() {
  return {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "k8s-ro-regression", version: "1.0.0" },
  };
}

function toolsResult() {
  return {
    tools: [
      {
        name: "pods_list_in_namespace",
        inputSchema: {
          type: "object",
          properties: { namespace: { type: "string" } },
          required: ["namespace"],
        },
      },
      {
        name: "resources_list",
        inputSchema: {
          type: "object",
          properties: {
            apiVersion: { type: "string" },
            kind: { type: "string" },
            namespace: { type: "string" },
          },
          required: ["apiVersion", "kind"],
        },
      },
      { name: "events_list", inputSchema: { type: "object", properties: { namespace: { type: "string" } } } },
    ],
  };
}

function classifyCall(message: JsonRpcMessage): PlannedCall {
  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  if (name === "pods_list_in_namespace") return { tool: "pods_list_in_namespace", arguments: args };
  if (name === "events_list") return { tool: "events_list", arguments: args };
  if (name === "resources_list" && args.kind === "PersistentVolumeClaim") {
    return { tool: "persistent_volume_claims", arguments: args };
  }
  if (name === "resources_list" && args.kind === "Node") {
    return { tool: "nodes_list", arguments: args };
  }
  throw new Error(`unexpected Kubernetes tool call: ${name} ${JSON.stringify(args)}`);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function startK8sMcpFixture() {
  let now = 0;
  let legacyInitializedAt: number | null = null;
  let legacyStream: ServerResponse | null = null;
  let hangNextCall = false;
  let resolveTimeoutObserved: (elapsedMs: number) => void = () => undefined;
  const timeoutObserved = new Promise<number>((resolve) => {
    resolveTimeoutObserved = resolve;
  });
  const calls: CapturedCall[] = [];

  const handleToolCall = (message: JsonRpcMessage, res: ServerResponse | null) => {
    const call = classifyCall(message);
    if (hangNextCall) {
      hangNextCall = false;
      const startedAt = performance.now();
      res?.on("close", () => {
        const elapsedMs = performance.now() - startedAt;
        calls.push({ ...call, status: "timed_out", atMs: now });
        resolveTimeoutObserved(elapsedMs);
      });
      return;
    }
    calls.push({ ...call, status: "ok", atMs: now });
    const result = { content: [{ type: "text", text: `${call.tool}: ok` }] };
    if (res) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(rpcResult(message, result));
    } else {
      legacyStream?.write(`event: message\ndata: ${rpcResult(message, result)}\n\n`);
    }
  };

  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://fixture.invalid");

    if (req.method === "GET" && requestUrl.pathname === "/sse") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      legacyStream = res;
      res.write("event: endpoint\ndata: /messages?sessionId=legacy\n\n");
      req.on("close", () => {
        if (legacyStream === res) legacyStream = null;
      });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/sse") {
      res.writeHead(405).end();
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/messages") {
      const message = (await readJson(req)) as JsonRpcMessage;
      res.writeHead(202).end();
      if (!legacyStream) return;
      if (message.method === "initialize") {
        legacyStream.write(`event: message\ndata: ${rpcResult(message, initializeResult())}\n\n`);
        return;
      }
      if (message.method === "notifications/initialized") {
        legacyInitializedAt = now;
        return;
      }
      if (legacyInitializedAt === null || now - legacyInitializedAt >= IDLE_WINDOW_MS) {
        if (message.method === "tools/call") {
          calls.push({ ...classifyCall(message), status: "initialization_error", atMs: now });
        }
        legacyStream.write(
          `event: message\ndata: ${rpcError(message, `method "${message.method}" is invalid during session initialization`)}\n\n`,
        );
        return;
      }
      if (message.method === "tools/list") {
        legacyStream.write(`event: message\ndata: ${rpcResult(message, toolsResult())}\n\n`);
        return;
      }
      if (message.method === "tools/call") handleToolCall(message, null);
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/mcp") {
      const message = (await readJson(req)) as JsonRpcMessage;
      if (message.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (message.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(rpcResult(message, initializeResult()));
        return;
      }
      if (message.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(rpcResult(message, toolsResult()));
        return;
      }
      if (message.method === "tools/call") {
        handleToolCall(message, res);
        return;
      }
    }

    res.writeHead(404).end();
  });

  return {
    baseUrl: await listen(server),
    calls,
    advancePastIdle() {
      now += IDLE_WINDOW_MS;
    },
    hangNextCall() {
      hangNextCall = true;
    },
    waitForTimeout() {
      return timeoutObserved;
    },
  };
}

function streamCompletion(res: ServerResponse, chunks: Record<string, unknown>[]) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end("data: [DONE]\n\n");
}

function completionChunk(id: string, delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function startModelFixture(
  plan: PlannedCall[],
  onAfterBaseline: () => void,
  onBeforeCall: (index: number) => void = () => undefined,
) {
  let responseIndex = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    const body = await readJson(req);
    const tools = body.tools as Array<{ function?: { name?: string } }>;
    if (responseIndex === 1) onAfterBaseline();

    if (responseIndex < plan.length) {
      onBeforeCall(responseIndex);
      const planned = plan[responseIndex];
      const suffix = planned.tool === "persistent_volume_claims" || planned.tool === "nodes_list"
        ? "resources_list"
        : planned.tool;
      const toolName = tools.find((tool) => tool.function?.name?.endsWith(`_${suffix}`))?.function?.name;
      if (!toolName) throw new Error(`OpenCode did not expose ${suffix}: ${JSON.stringify(tools)}`);
      const callId = `call-${responseIndex + 1}`;
      responseIndex += 1;
      streamCompletion(res, [
        completionChunk(callId, { role: "assistant" }),
        completionChunk(callId, {
          tool_calls: [{
            index: 0,
            id: callId,
            type: "function",
            function: { name: toolName, arguments: JSON.stringify(planned.arguments) },
          }],
        }),
        completionChunk(callId, {}, "tool_calls"),
      ]);
      return;
    }

    streamCompletion(res, [
      completionChunk("final", { role: "assistant" }),
      completionChunk("final", { content: "k8s-ro regression complete" }),
      completionChunk("final", {}, "stop"),
    ]);
  });
  return { baseUrl: await listen(server) };
}

function opencodeEnv(home: string, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    ...extra,
  };
}

function spawnOpenCode(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; label: string },
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(opencodeBin, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    let watchdogExpired = false;
    const watchdog = setTimeout(() => {
      watchdogExpired = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      action();
    };
    child.once("error", (error) => settle(() => reject(error)));
    child.once("close", (code) => {
      settle(() => {
        if (watchdogExpired) {
          reject(new Error(
            `${options.label} timed out after ${options.timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ));
        } else if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`${options.label} exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      });
    });
  });
}

async function runOpenCode(mcpUrl: string, modelUrl: string) {
  const project = mkdtempSync(path.join(tmpdir(), "paperclip-opencode-k8s-"));
  tempDirs.push(project);
  const config = {
    share: "disabled",
    autoupdate: false,
    formatter: false,
    lsp: false,
    model: "fake/fake-model",
    small_model: "fake/fake-model",
    provider: {
      fake: {
        id: "fake",
        name: "k8s-ro deterministic provider",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "fake-model": {
            id: "fake-model",
            name: "fake-model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "fake-key", baseURL: `${modelUrl}/v1`, timeout: 5_000 },
      },
    },
    mcp: {
      "k8s-ro": { type: "remote", url: mcpUrl, oauth: false, timeout: CALLER_TIMEOUT_MS },
    },
    permission: { "*": "allow" },
  };

  return spawnOpenCode(
    ["run", "--model", "fake/fake-model", "--format", "json", "--title", "k8s-ro-regression", "Run the deterministic Kubernetes reads."],
    {
      cwd: project,
      env: opencodeEnv(opencodeStateHome, {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_AUTH_CONTENT: "{}",
      }),
      timeoutMs: RUN_WATCHDOG_MS,
      label: "OpenCode regression",
    },
  );
}

beforeAll(async () => {
  opencodeStateHome = mkdtempSync(path.join(tmpdir(), "paperclip-opencode-home-"));
  suiteDirs.push(opencodeStateHome);
  // Pay OpenCode's one-time SQLite migration here rather than inside a regression run's watchdog:
  // `db path` initializes the store and prints its location, and every later spawn reuses it.
  const { stdout } = await spawnOpenCode(["db", "path"], {
    cwd: opencodeStateHome,
    env: opencodeEnv(opencodeStateHome),
    timeoutMs: MIGRATION_TIMEOUT_MS,
    label: "OpenCode state migration",
  });
  const dbPath = stdout.trim().split("\n").pop()?.trim() ?? "";
  // If a future OpenCode release stops migrating here, the migration would silently move back
  // inside a run's watchdog and the cold-start flake would return; fail loudly instead.
  expect(existsSync(dbPath)).toBe(true);
}, MIGRATION_TIMEOUT_MS + 30_000);

afterAll(() => {
  while (suiteDirs.length) rmSync(suiteDirs.pop()!, { recursive: true, force: true });
});

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    if (!server) continue;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("opencode_k8s production k8s-ro connector after idle", () => {
  it("runs baseline Pod -> simulated 610s idle -> post-idle Pod/PVC/Event/Node and bounds timeout; legacy SSE fails", async () => {
    const legacyMcp = await startK8sMcpFixture();
    const legacyPlan: PlannedCall[] = [
      { tool: "pods_list_in_namespace", arguments: { namespace: "hindsight" } },
      { tool: "pods_list_in_namespace", arguments: { namespace: "hindsight" } },
    ];
    const legacyModel = await startModelFixture(legacyPlan, legacyMcp.advancePastIdle);
    // OpenCode 1.15.12 does not await its JSON event stream, so fixture calls are the stable process-boundary oracle.
    await runOpenCode(`${legacyMcp.baseUrl}/sse`, legacyModel.baseUrl);
    expect(legacyMcp.calls.map(({ tool, status, atMs }) => ({ tool, status, atMs }))).toEqual([
      { tool: "pods_list_in_namespace", status: "ok", atMs: 0 },
      { tool: "pods_list_in_namespace", status: "initialization_error", atMs: IDLE_WINDOW_MS },
    ]);
    console.info("[k8s-ro regression] legacy SSE baseline passed, then failed after simulated 610-second idle");

    const seed = readK8sRoSeed();
    expect(seed.type).toBe("http");
    const seedUrl = new URL(seed.url);
    expect(seedUrl.protocol).toBe("http:");
    expect(seedUrl.hostname).toBe("kubernetes-mcp-server-readonly.paperclip.svc.cluster.local");
    expect(seedUrl.port).toBe("8080");
    expect(seedUrl.pathname).toBe("/mcp");
    const currentMcp = await startK8sMcpFixture();
    const currentPlan: PlannedCall[] = [
      { tool: "pods_list_in_namespace", arguments: { namespace: "hindsight" } },
      { tool: "pods_list_in_namespace", arguments: { namespace: "hindsight" } },
      {
        tool: "persistent_volume_claims",
        arguments: { apiVersion: "v1", kind: "PersistentVolumeClaim", namespace: "hindsight" },
      },
      { tool: "events_list", arguments: { namespace: "hindsight" } },
      { tool: "nodes_list", arguments: { apiVersion: "v1", kind: "Node" } },
      { tool: "nodes_list", arguments: { apiVersion: "v1", kind: "Node" } },
    ];
    const currentModel = await startModelFixture(
      currentPlan,
      currentMcp.advancePastIdle,
      (index) => {
        if (index === currentPlan.length - 1) currentMcp.hangNextCall();
      },
    );
    await runOpenCode(
      new URL(seedUrl.pathname, currentMcp.baseUrl).toString(),
      currentModel.baseUrl,
    );
    const timeoutObservedMs = await currentMcp.waitForTimeout();
    expect(currentMcp.calls.map(({ tool, status, atMs }) => ({ tool, status, atMs }))).toEqual([
      { tool: "pods_list_in_namespace", status: "ok", atMs: 0 },
      { tool: "pods_list_in_namespace", status: "ok", atMs: IDLE_WINDOW_MS },
      { tool: "persistent_volume_claims", status: "ok", atMs: IDLE_WINDOW_MS },
      { tool: "events_list", status: "ok", atMs: IDLE_WINDOW_MS },
      { tool: "nodes_list", status: "ok", atMs: IDLE_WINDOW_MS },
      { tool: "nodes_list", status: "timed_out", atMs: IDLE_WINDOW_MS },
    ]);
    expect(CALLER_TIMEOUT_MS - CALLER_TIMEOUT_EARLY_TOLERANCE_MS).toBeGreaterThan(
      OPENCODE_FALLBACK_TIMEOUT_MS + FIXTURE_CLOSE_OBSERVATION_TOLERANCE_MS,
    );
    expect(timeoutObservedMs).toBeGreaterThanOrEqual(
      CALLER_TIMEOUT_MS - CALLER_TIMEOUT_EARLY_TOLERANCE_MS,
    );
    expect(timeoutObservedMs).toBeLessThanOrEqual(
      CALLER_TIMEOUT_MS + FIXTURE_CLOSE_OBSERVATION_TOLERANCE_MS,
    );
    // A healthy run spends most of its time deliberately waiting out the hung call above, so the
    // watchdog has to outlast that by a wide margin or it would kill passing runs on slow hosts.
    expect(RUN_WATCHDOG_MS).toBeGreaterThan(
      (CALLER_TIMEOUT_MS + FIXTURE_CLOSE_OBSERVATION_TOLERANCE_MS) * 3,
    );
    console.info("[k8s-ro regression] post-idle Pod/PVC/Event/Node passed in one OpenCode session; timeout bounded");
  }, TEST_TIMEOUT_MS);
});

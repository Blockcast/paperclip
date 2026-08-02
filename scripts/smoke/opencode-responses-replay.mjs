import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const EXPECTED_OUTPUT = "framed Responses replay completed";
const SECRET_INSTRUCTION = "INSTRUCTION_SHOULD_NOT_LEAK_7f3d";
const SECRET_CREDENTIAL = "sk-fixture-SHOULD_NOT_LEAK-c82a";
const SECRET_SCHEMA = "TOOL_SCHEMA_SHOULD_NOT_LEAK_51be";
const MAX_CAPTURE_BYTES = 16 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;

const response = (id, output = [], extra = {}) => ({
  id,
  object: "response",
  created_at: 1,
  status: "in_progress",
  model: "gpt-5.6-sol",
  instructions: SECRET_INSTRUCTION,
  tools: [
    {
      type: "function",
      name: "read",
      description: SECRET_SCHEMA.repeat(256),
      parameters: {
        type: "object",
        properties: { filePath: { type: "string" } },
        required: ["filePath"],
        additionalProperties: false,
      },
    },
  ],
  output,
  ...extra,
});

const frame = (event) =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

const completedToolCall = {
  type: "function_call",
  id: "item_read",
  call_id: "call_read",
  name: "read",
  arguments: '{"filePath":"missing-fixture-file"}',
  status: "completed",
};

const firstTurn = [
  { type: "response.created", response: response("resp_tool") },
  { type: "response.in_progress", response: response("resp_tool") },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      type: "function_call",
      id: "item_read",
      call_id: "call_read",
      name: "read",
      arguments: "",
      status: "in_progress",
    },
  },
  {
    type: "response.function_call_arguments.delta",
    item_id: "item_read",
    output_index: 0,
    delta: '{"filePath":"missing-fixture-file"}',
  },
  {
    type: "response.function_call_arguments.done",
    item_id: "item_read",
    output_index: 0,
    arguments: '{"filePath":"missing-fixture-file"}',
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: completedToolCall,
  },
  {
    type: "response.completed",
    response: response("resp_tool", [completedToolCall], {
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    }),
  },
];

const completedMessage = {
  type: "message",
  id: "msg_final",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: EXPECTED_OUTPUT, annotations: [] }],
};

const finalTurn = [
  { type: "response.in_progress", response: response("resp_final") },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      type: "message",
      id: "msg_final",
      role: "assistant",
      status: "in_progress",
      content: [],
    },
  },
  {
    type: "response.content_part.added",
    item_id: "msg_final",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  },
  {
    type: "response.output_text.delta",
    item_id: "msg_final",
    output_index: 0,
    content_index: 0,
    delta: EXPECTED_OUTPUT,
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: completedMessage,
  },
  {
    type: "response.completed",
    response: response("resp_final", [completedMessage], {
      status: "completed",
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
    }),
  },
];

const sse = (events) => `${events.map(frame).join("")}data: [DONE]\n\n`;

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });

const close = (server) => new Promise((resolve) => server.close(resolve));

const readJsonRequest = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        reject(new Error(`request exceeded ${MAX_REQUEST_BYTES} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("request body was not valid JSON"));
      }
    });
    request.once("error", reject);
  });

const containsToolResult = (value) => {
  if (Array.isArray(value)) return value.some(containsToolResult);
  if (!value || typeof value !== "object") return false;
  if (
    value.type === "function_call_output" &&
    value.call_id === "call_read" &&
    typeof value.output === "string" &&
    value.output.length > 0
  ) {
    return true;
  }
  return Object.values(value).some(containsToolResult);
};

const summarizeCallItems = (value, items = []) => {
  if (items.length >= 20 || !value || typeof value !== "object") return items;
  if (Array.isArray(value)) {
    for (const entry of value) summarizeCallItems(entry, items);
    return items;
  }
  if (
    "call_id" in value ||
    "callID" in value ||
    String(value.type).includes("output")
  ) {
    items.push({
      type: value.type ?? null,
      callId: value.call_id ?? value.callID ?? null,
      outputType: typeof value.output,
      role: value.role ?? null,
    });
  }
  for (const entry of Object.values(value)) summarizeCallItems(entry, items);
  return items;
};

const runOpenCode = (binary, cwd, config, message) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      binary,
      [
        "run",
        message,
        "--pure",
        "--auto",
        "--format",
        "json",
        "--model",
        "openai/gpt-5.6-sol",
        "--agent",
        "build",
        "--title",
        "Responses replay fixture",
        "--dir",
        cwd,
      ],
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          HOME: cwd,
          XDG_CACHE_HOME: path.join(cwd, "cache"),
          XDG_CONFIG_HOME: path.join(cwd, "config"),
          XDG_DATA_HOME: path.join(cwd, "data"),
          XDG_STATE_HOME: path.join(cwd, "state"),
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          OPENCODE_DISABLE_MODELS_FETCH: "true",
          OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
          OPENAI_API_KEY: SECRET_CREDENTIAL,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const captured = [];
    const stdout = [];
    let capturedBytes = 0;
    let stdoutBytes = 0;
    let totalBytes = 0;
    let overflow = false;
    const capture = (chunk, stream) => {
      totalBytes += chunk.length;
      const remaining = MAX_CAPTURE_BYTES - capturedBytes;
      if (remaining > 0) {
        const slice = chunk.subarray(0, remaining);
        captured.push(slice);
        capturedBytes += slice.length;
      }
      if (stream === "stdout") {
        const stdoutRemaining = MAX_CAPTURE_BYTES - stdoutBytes;
        if (stdoutRemaining > 0) {
          const slice = chunk.subarray(0, stdoutRemaining);
          stdout.push(slice);
          stdoutBytes += slice.length;
        }
      }
      if (totalBytes > MAX_CAPTURE_BYTES * 4) {
        overflow = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", (chunk) => capture(chunk, "stdout"));
    child.stderr.on("data", (chunk) => capture(chunk, "stderr"));
    child.once("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        output: Buffer.concat(captured).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
        totalBytes,
        overflow,
      });
    });
  });

const configFor = (port) => ({
  enabled_providers: ["openai"],
  tools: { read: true },
  provider: {
    openai: {
      options: {
        apiKey: SECRET_CREDENTIAL,
        baseURL: `http://127.0.0.1:${port}/v1`,
      },
      models: {
        "gpt-5.6-sol": {
          name: "Replay fixture",
          reasoning: true,
          tool_call: true,
          limit: { context: 1_050_000, output: 128_000 },
        },
      },
    },
  },
});

const assertRedactedAndBounded = (result) => {
  if (Buffer.byteLength(result.output) > MAX_CAPTURE_BYTES || result.overflow) {
    throw new Error(
      `malformed replay diagnostics exceeded ${MAX_CAPTURE_BYTES} bytes`,
    );
  }
  for (const secret of [SECRET_INSTRUCTION, SECRET_CREDENTIAL, SECRET_SCHEMA]) {
    if (result.output.includes(secret))
      throw new Error("malformed replay diagnostics leaked fixture secrets");
  }
};

const assertExactAssistantOutput = (stdout) => {
  const assistantResults = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    let event;
    try {
      event = JSON.parse(rawLine);
    } catch {
      throw new Error("framed replay emitted non-JSON stdout");
    }
    if (event.type === "text" && typeof event.part?.text === "string") {
      assistantResults.push(event.part.text);
    }
  }
  if (
    assistantResults.length !== 1 ||
    assistantResults[0] !== EXPECTED_OUTPUT
  ) {
    throw new Error(
      `framed replay returned ${assistantResults.length} non-exact assistant results`,
    );
  }
};

const summarizeStdoutTypes = (stdout) =>
  stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        const event = JSON.parse(line);
        if (event.type !== "error")
          return `${event.type ?? "unknown"}:${event.part?.state?.status ?? ""}`;
        let detail = JSON.stringify(event.error ?? event.message ?? "");
        for (const secret of [
          SECRET_INSTRUCTION,
          SECRET_CREDENTIAL,
          SECRET_SCHEMA,
        ]) {
          detail = detail.replaceAll(secret, "[redacted]");
        }
        return `error:${detail.slice(0, 300)}`;
      } catch {
        return "non-json";
      }
    })
    .slice(0, 20);

const assertPersistedStateRedacted = async (root) => {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!entry.isFile()) continue;
      const content = await readFile(target);
      for (const secret of [
        SECRET_INSTRUCTION,
        SECRET_CREDENTIAL,
        SECRET_SCHEMA,
      ]) {
        if (content.includes(Buffer.from(secret))) {
          throw new Error(
            `malformed replay persisted fixture secrets in ${path.relative(root, target)}`,
          );
        }
      }
    }
  }
};

const main = async () => {
  const binary = process.env.OPENCODE_REPLAY_BINARY || "opencode";
  const root = await mkdtemp(path.join(tmpdir(), "opencode-responses-replay-"));
  await Promise.all(
    ["cache", "config", "data", "state"].map((dir) =>
      mkdir(path.join(root, dir)),
    ),
  );

  try {
    let requestCount = 0;
    let toolResultValidated = false;
    let secondRequestShape = [];
    let offeredToolNames = [];
    let firstRequestKeys = [];
    const successServer = createServer(async (request, reply) => {
      try {
        const body = await readJsonRequest(request);
        if (requestCount === 0) {
          firstRequestKeys = Object.keys(body);
          offeredToolNames = Array.isArray(body.tools)
            ? body.tools.map((tool) => tool.name).filter(Boolean)
            : [];
          requestCount += 1;
          reply.writeHead(200, { "content-type": "text/event-stream" });
          reply.end(sse(firstTurn));
          return;
        }
        requestCount += 1;
        secondRequestShape = summarizeCallItems(body.input);
        toolResultValidated = containsToolResult(body.input);
        if (requestCount !== 2 || !toolResultValidated) {
          reply.writeHead(400, { "content-type": "application/json" });
          reply.end('{"error":{"message":"missing matching tool result"}}');
          return;
        }
        reply.writeHead(200, { "content-type": "text/event-stream" });
        reply.end(sse(finalTurn));
      } catch {
        reply.writeHead(400, { "content-type": "application/json" });
        reply.end('{"error":{"message":"invalid bounded request"}}');
      }
    });
    const successPort = await listen(successServer);
    const success = await runOpenCode(
      binary,
      root,
      configFor(successPort),
      "Run the framed replay fixture.",
    );
    await close(successServer);
    if (
      success.code !== 0 ||
      success.signal ||
      requestCount !== 2 ||
      !offeredToolNames.includes("read") ||
      !toolResultValidated
    ) {
      throw new Error(
        `framed replay failed: exit=${success.code} signal=${success.signal} requests=${requestCount} toolResult=${toolResultValidated} parserError=${success.output.includes("JSON parsing failed")} requestKeys=${JSON.stringify(firstRequestKeys)} offered=${JSON.stringify(offeredToolNames.slice(0, 30))} events=${JSON.stringify(summarizeStdoutTypes(success.stdout))} shape=${JSON.stringify(secondRequestShape)}`,
      );
    }
    if (success.output.includes("JSON parsing failed"))
      throw new Error("intermediate frame reached final JSON parser");
    assertExactAssistantOutput(success.stdout);

    const malformedPayload = `${frame({
      type: "response.in_progress",
      response: response("resp_bad"),
    })}data: {malformed${"x".repeat(MAX_CAPTURE_BYTES * 2)}\n\n`;
    if (Buffer.byteLength(malformedPayload) <= MAX_CAPTURE_BYTES) {
      throw new Error("malformed fixture did not exceed diagnostic cap");
    }
    const malformedServer = createServer((request, reply) => {
      request.resume();
      reply.writeHead(200, { "content-type": "text/event-stream" });
      reply.end(malformedPayload);
    });
    const malformedPort = await listen(malformedServer);
    const malformed = await runOpenCode(
      binary,
      root,
      configFor(malformedPort),
      "Run the malformed replay fixture.",
    );
    await close(malformedServer);
    if (malformed.code === 0 || malformed.signal) {
      throw new Error(
        `malformed replay was not rejected deterministically: exit=${malformed.code}`,
      );
    }
    if (!malformed.output.includes("JSON parsing failed")) {
      throw new Error(
        "malformed replay did not fail in the Responses JSON parser",
      );
    }
    assertRedactedAndBounded(malformed);
    await assertPersistedStateRedacted(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

await main();

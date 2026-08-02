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

const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

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
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "function_call",
      id: "item_read",
      call_id: "call_read",
      name: "read",
      arguments: '{"filePath":"missing-fixture-file"}',
      status: "completed",
    },
  },
  {
    type: "response.completed",
    response: response("resp_tool", [], {
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    }),
  },
];

const finalTurn = [
  { type: "response.in_progress", response: response("resp_final") },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", id: "msg_final", role: "assistant", status: "in_progress", content: [] },
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
    item: {
      type: "message",
      id: "msg_final",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: EXPECTED_OUTPUT, annotations: [] }],
    },
  },
  {
    type: "response.completed",
    response: response("resp_final", [], {
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
    let output = "";
    let totalBytes = 0;
    let overflow = false;
    const capture = (chunk) => {
      totalBytes += chunk.length;
      if (Buffer.byteLength(output) < MAX_CAPTURE_BYTES) output += chunk.toString("utf8");
      if (totalBytes > MAX_CAPTURE_BYTES * 4) {
        overflow = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, totalBytes, overflow });
    });
  });

const configFor = (port) => ({
  enabled_providers: ["openai"],
  provider: {
    openai: {
      options: { apiKey: SECRET_CREDENTIAL, baseURL: `http://127.0.0.1:${port}/v1` },
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
  if (result.totalBytes > MAX_CAPTURE_BYTES || result.overflow) {
    throw new Error(`malformed replay diagnostics exceeded ${MAX_CAPTURE_BYTES} bytes`);
  }
  for (const secret of [SECRET_INSTRUCTION, SECRET_CREDENTIAL, SECRET_SCHEMA]) {
    if (result.output.includes(secret)) throw new Error("malformed replay diagnostics leaked fixture secrets");
  }
};

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
      for (const secret of [SECRET_INSTRUCTION, SECRET_CREDENTIAL, SECRET_SCHEMA]) {
        if (content.includes(Buffer.from(secret))) {
          throw new Error(`malformed replay persisted fixture secrets in ${path.relative(root, target)}`);
        }
      }
    }
  }
};

const main = async () => {
  const binary = process.env.OPENCODE_REPLAY_BINARY || "opencode";
  const root = await mkdtemp(path.join(tmpdir(), "opencode-responses-replay-"));
  await Promise.all(["cache", "config", "data", "state"].map((dir) => mkdir(path.join(root, dir))));

  try {
    let requestCount = 0;
    const successServer = createServer((request, reply) => {
      request.resume();
      reply.writeHead(200, { "content-type": "text/event-stream" });
      reply.end(sse(requestCount++ === 0 ? firstTurn : finalTurn));
    });
    const successPort = await listen(successServer);
    const success = await runOpenCode(binary, root, configFor(successPort), "Run the framed replay fixture.");
    await close(successServer);
    if (success.code !== 0 || success.signal || requestCount !== 2 || !success.output.includes(EXPECTED_OUTPUT)) {
      throw new Error(`framed replay failed: exit=${success.code} signal=${success.signal} requests=${requestCount}`);
    }
    if (success.output.includes("JSON parsing failed")) throw new Error("intermediate frame reached final JSON parser");

    const malformedServer = createServer((request, reply) => {
      request.resume();
      reply.writeHead(200, { "content-type": "text/event-stream" });
      reply.end(`${frame({ type: "response.in_progress", response: response("resp_bad") })}data: {malformed\n\n`);
    });
    const malformedPort = await listen(malformedServer);
    const malformed = await runOpenCode(binary, root, configFor(malformedPort), "Run the malformed replay fixture.");
    await close(malformedServer);
    if (malformed.code === 0 || malformed.signal) {
      throw new Error(`malformed replay was not rejected deterministically: exit=${malformed.code}`);
    }
    assertRedactedAndBounded(malformed);
    await assertPersistedStateRedacted(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

await main();

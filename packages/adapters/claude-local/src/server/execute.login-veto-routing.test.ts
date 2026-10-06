import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PEN-3259: execute.ts classifies a terminal result event off its bounded surfaces
// (the result event, stderr, errorMessage), not the transcript. These drive the
// real execute() — not a restated mirror of its composition — so a classifier call
// on the parsed path that is handed the whole transcript fails here.

const RUN_CHILD_PROCESS_TEST_TIMEOUT_MS = 30_000;

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs, state } = vi.hoisted(() => {
  const state = { stdout: "" };
  const runChildProcess = vi.fn(async (_runId: string, command: string, args: string[]) => {
    // ccrotate advance (only reached on claude_auth_required): report it absent.
    if (command === "sh" && args.some((arg) => arg.includes("ccrotate"))) {
      return {
        exitCode: 127,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "ccrotate: not found",
        pid: 200,
        startedAt: new Date().toISOString(),
      };
    }
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: state.stdout,
      stderr: "",
      pid: 101,
      startedAt: new Date().toISOString(),
    };
  });
  return {
    runChildProcess,
    ensureCommandResolvable: vi.fn(async () => undefined),
    resolveCommandForLogs: vi.fn(async () => "claude"),
    state,
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, ensureCommandResolvable, resolveCommandForLogs, runChildProcess };
});

import { execute } from "./execute.js";

const ISOLATED_ENV_KEYS = [
  "PAPERCLIP_TASK_ID",
  "PAPERCLIP_WAKE_REASON",
  "PAPERCLIP_WAKE_COMMENT_ID",
  "PAPERCLIP_WAKE_PAYLOAD_JSON",
  "PAPERCLIP_HOME",
  "PAPERCLIP_INSTANCE_ID",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "HOME",
] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>(
  ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]),
);

// A tool_result line: transcript content the agent's own tools produced.
const toolResultLine = (text: string) =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ tool_use_id: "t1", type: "tool_result", content: text }] },
  });

const runStdout = (transcript: string, result: Record<string, unknown>) =>
  [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet" }),
    toolResultLine(transcript),
    JSON.stringify({ type: "result", subtype: "success", is_error: true, session_id: "s1", ...result }),
  ].join("\n");

describe("execute.ts classifies a terminal result event off bounded surfaces (PEN-3259)", () => {
  const cleanupDirs: string[] = [];

  beforeEach(async () => {
    for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-home-"));
    cleanupDirs.push(homeDir);
    process.env.HOME = homeDir;
    process.env.PAPERCLIP_HOME = path.join(homeDir, "paperclip");
  });

  afterEach(async () => {
    for (const key of ISOLATED_ENV_KEYS) {
      const value = ORIGINAL_ENV.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runWith(stdout: string) {
    state.stdout = stdout;
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-login-veto-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    return execute({
      runId: "run-login-veto-routing",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: { engine: "cli" },
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", command: "claude" },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    });
  }

  // `ServiceQuotaExceededException` is in both the provider-quota and the
  // transient-upstream regexes and in neither the quota-exhausted one, so it needs
  // no co-occurring token. Handing the quota classifier the whole transcript let
  // its internal login veto fire on the tool output, and the run fell through to
  // claude_transient_upstream.
  it(
    "routes a provider-quota result to the quota family when only the transcript mentions auth",
    async () => {
      const result = await runWith(
        runStdout("deploy.log: worker failed to authenticate against the registry", {
          result: "API Error: ServiceQuotaExceededException: Too many tokens, please wait before trying again.",
        }),
      );
      expect(result.errorCode).toBe("provider_quota");
      expect(result.errorFamily).toBe("provider_quota");
    },
    RUN_CHILD_PROCESS_TEST_TIMEOUT_MS,
  );

  // Narrowing only the quota rule's input would leave the transient rule's
  // internal quota suppression on the whole transcript: a quota token in the tool
  // output then vetoes the transient verdict while the narrowed quota rule says
  // "not quota", and a genuine 429 drops to no retry family at all.
  it(
    "routes a 429 result to transient upstream when only the transcript mentions a usage limit",
    async () => {
      const result = await runWith(
        runStdout("src/parse.ts: const RE = /claude usage limit reached/i;", {
          api_error_status: 429,
          result: "API Error: Request rejected (429) · rate-limited; retry in 30s",
        }),
      );
      expect(result.errorCode).toBe("claude_transient_upstream");
      expect(result.errorFamily).toBe("transient_upstream");
    },
    RUN_CHILD_PROCESS_TEST_TIMEOUT_MS,
  );
});

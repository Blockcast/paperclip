import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// BLO-22497: the session-unavailable fallback in execute.ts starts a genuinely new
// codex session via runAttempt(null), but the prompt used to be built exactly once,
// keyed on the *original* sessionId. That left the recovered attempt with a
// resume-delta prompt (no instructions prefix, no bootstrap prompt, no task-context
// prompt) even though it was starting fresh. These tests drive execute() through a
// simulated unknown-session first attempt and assert on what the *second* attempt's
// stdin actually contains.

const RUN_CHILD_PROCESS_TEST_TIMEOUT_MS = 30_000;

const RESUME_SESSION_ID = "cdx-session-abc";
const FRESH_SESSION_ID = "cdx-session-fresh";

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => {
  const runChildProcess = vi.fn(
    async (
      _runId: string,
      _command: string,
      args: string[],
      _opts: { stdin?: string },
    ) => {
      if (args.includes("resume")) {
        // The resumed thread is gone, which isCodexUnknownSessionError() must
        // classify as the recovery trigger. It reads the *raw* stderr.
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: `Error: unknown session ${RESUME_SESSION_ID}`,
          pid: 101,
          startedAt: new Date().toISOString(),
        };
      }
      // Fresh session (no resume subcommand): the recovered attempt.
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: FRESH_SESSION_ID }),
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "recovered" } }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
          }),
        ].join("\n"),
        stderr: "",
        pid: 102,
        startedAt: new Date().toISOString(),
      };
    },
  );
  return {
    runChildProcess,
    ensureCommandResolvable: vi.fn(async () => undefined),
    resolveCommandForLogs: vi.fn(async () => "codex"),
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

import { execute } from "./execute.js";

const ISOLATED_ENV_KEYS = [
  "PAPERCLIP_TASK_ID",
  "PAPERCLIP_WAKE_REASON",
  "PAPERCLIP_WAKE_COMMENT_ID",
  "PAPERCLIP_WAKE_PAYLOAD_JSON",
  "PAPERCLIP_CODEX_PROVIDERS",
  "PAPERCLIP_CODEX_USE_HOST_HOME",
  "OPENAI_API_KEY",
  "CODEX_HOME",
  "HOME",
] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>(
  ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]),
);

const BOOTSTRAP_MARKER = "BOOTSTRAP-MARKER-BLO-22497";
const TASK_CONTEXT_MARKER = "TASK-CONTEXT-MARKER-BLO-22497";

function codexRunCalls(): Array<[string, string, string[], { stdin?: string }]> {
  return runChildProcess.mock.calls.filter(
    (entry) => Array.isArray(entry[2]) && entry[2].includes("exec"),
  ) as Array<[string, string, string[], { stdin?: string }]>;
}

describe("codex local execution — session-unavailable recovery prompt (BLO-22497)", () => {
  const cleanupDirs: string[] = [];
  let codexHome = "";

  beforeEach(async () => {
    for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    cleanupDirs.push(homeDir);
    process.env.HOME = homeDir;
    // An external CODEX_HOME keeps execute() out of the managed-home credential
    // gate, which otherwise throws before any attempt runs.
    codexHome = path.join(homeDir, "codex");
    await mkdir(codexHome, { recursive: true });
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
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeWorkspaceDir(prefix: string): Promise<string> {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  function baseConfig(workspaceDir: string) {
    return {
      engine: "cli",
      command: "codex",
      cwd: workspaceDir,
      env: { CODEX_HOME: codexHome, OPENAI_API_KEY: "test-key" },
      promptTemplate: `${TASK_CONTEXT_MARKER} {{agentId}}`,
      bootstrapPromptTemplate: `${BOOTSTRAP_MARKER} {{agentId}}`,
    };
  }

  function baseContext(workspaceDir: string) {
    return {
      paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      paperclipWake: { issue: { id: "issue-1", title: "Fix the thing" } },
    };
  }

  const AGENT = {
    id: "agent-1",
    companyId: "company-1",
    name: "Codex Coder",
    adapterType: "codex_local",
    adapterConfig: { engine: "cli" },
  } as const;

  it(
    "renders a fresh-session prompt (bootstrap + full task context, no resume-delta phrasing) on the recovered attempt, while leaving the original resume attempt's prompt unchanged",
    async () => {
      const workspaceDir = await makeWorkspaceDir("paperclip-codex-session-recovery-");

      const result = await execute({
        runId: "run-session-recovery",
        agent: AGENT,
        runtime: {
          sessionId: RESUME_SESSION_ID,
          sessionParams: { sessionId: RESUME_SESSION_ID, cwd: workspaceDir },
          sessionDisplayId: RESUME_SESSION_ID,
          taskKey: null,
        },
        config: baseConfig(workspaceDir),
        context: baseContext(workspaceDir),
        onLog: async () => {},
      });

      expect(result.sessionId).toBe(FRESH_SESSION_ID);

      const runCalls = codexRunCalls();
      expect(runCalls).toHaveLength(2);

      const [resumeCall, recoveredCall] = runCalls;
      expect(resumeCall?.[2]).toEqual(expect.arrayContaining(["resume", RESUME_SESSION_ID]));
      expect(recoveredCall?.[2]).not.toContain("resume");

      // Guard: the original (resumed) attempt keeps today's resume-delta prompt.
      const resumeStdin = resumeCall?.[3].stdin ?? "";
      expect(resumeStdin).toContain("## Paperclip Resume Delta");
      expect(resumeStdin).not.toContain("## Paperclip Wake Payload");
      expect(resumeStdin).not.toContain(BOOTSTRAP_MARKER);
      expect(resumeStdin).not.toContain(TASK_CONTEXT_MARKER);

      // The defect: the recovered attempt must get fresh-session semantics.
      const recoveredStdin = recoveredCall?.[3].stdin ?? "";
      expect(recoveredStdin).toContain(BOOTSTRAP_MARKER);
      expect(recoveredStdin).toContain(TASK_CONTEXT_MARKER);
      expect(recoveredStdin).toContain("## Paperclip Wake Payload");
      expect(recoveredStdin).not.toContain("## Paperclip Resume Delta");
    },
    RUN_CHILD_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "guard: a cold start (no prior session) already renders fresh-session semantics on its only attempt — no prompt-size regression from this fix",
    async () => {
      const workspaceDir = await makeWorkspaceDir("paperclip-codex-cold-start-");

      const result = await execute({
        runId: "run-cold-start",
        agent: AGENT,
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: baseConfig(workspaceDir),
        context: baseContext(workspaceDir),
        onLog: async () => {},
      });

      expect(result.sessionId).toBe(FRESH_SESSION_ID);

      const runCalls = codexRunCalls();
      expect(runCalls).toHaveLength(1);

      const stdin = runCalls[0]?.[3].stdin ?? "";
      expect(stdin).toContain(BOOTSTRAP_MARKER);
      expect(stdin).toContain(TASK_CONTEXT_MARKER);
      expect(stdin).toContain("## Paperclip Wake Payload");
      expect(stdin).not.toContain("## Paperclip Resume Delta");
    },
    RUN_CHILD_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "a recovery-shaped wake still suppresses the task-context prompt on the recovered attempt, matching a cold start on the same payload",
    async () => {
      const workspaceDir = await makeWorkspaceDir("paperclip-codex-recovery-wake-");

      await execute({
        runId: "run-recovery-wake",
        agent: AGENT,
        runtime: {
          sessionId: RESUME_SESSION_ID,
          sessionParams: { sessionId: RESUME_SESSION_ID, cwd: workspaceDir },
          sessionDisplayId: RESUME_SESSION_ID,
          taskKey: null,
        },
        config: baseConfig(workspaceDir),
        context: {
          ...baseContext(workspaceDir),
          paperclipWake: {
            issue: { id: "issue-1", title: "Fix the thing" },
            reason: "source_scoped_recovery_action",
          },
        },
        onLog: async () => {},
      });

      const runCalls = codexRunCalls();
      expect(runCalls).toHaveLength(2);
      const recoveredStdin = runCalls[1]?.[3].stdin ?? "";

      // Cold-start parity is the invariant, not "always include the task prompt":
      // isPaperclipRecoveryWakePayload is session-id-independent, so a recovery-shaped
      // wake legitimately suppresses the task-context prompt on both paths.
      expect(recoveredStdin).not.toContain(TASK_CONTEXT_MARKER);
      expect(recoveredStdin).toContain(BOOTSTRAP_MARKER);
      expect(recoveredStdin).not.toContain("## Paperclip Resume Delta");
    },
    RUN_CHILD_PROCESS_TEST_TIMEOUT_MS,
  );
});

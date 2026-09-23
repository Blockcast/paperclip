import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// BLO-22497: the session-unavailable fallback in execute.ts starts a genuinely new
// gemini session via runAttempt(null), but the prompt used to be built exactly once,
// keyed on the *original* sessionId. That left the recovered attempt with a
// resume-delta prompt (no bootstrap prompt, no task-context prompt) even though it
// was starting fresh. gemini passes the prompt through argv (`--prompt <value>`)
// rather than stdin, so these tests assert on the *second* attempt's --prompt value.

const RUN_CHILD_PROCESS_TEST_TIMEOUT_MS = 30_000;

const RESUME_SESSION_ID = "gemini-session-abc";
const FRESH_SESSION_ID = "gemini-session-fresh";

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => {
  const runChildProcess = vi.fn(
    async (
      _runId: string,
      _command: string,
      args: string[],
      _opts: { stdin?: string },
    ) => {
      if (args.includes("--resume")) {
        // The resumed session is gone, which isGeminiSessionUnrecoverableError()
        // must classify as the recovery trigger.
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: `Error: unknown session '${RESUME_SESSION_ID}'`,
          pid: 101,
          startedAt: new Date().toISOString(),
        };
      }
      // Fresh session (no --resume flag): the recovered attempt.
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({
            type: "system",
            subtype: "init",
            session_id: FRESH_SESSION_ID,
            model: "gemini-2.5-pro",
          }),
          JSON.stringify({ type: "message", role: "assistant", content: "recovered" }),
          JSON.stringify({
            type: "result",
            status: "success",
            session_id: FRESH_SESSION_ID,
            stats: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
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
    resolveCommandForLogs: vi.fn(async () => "gemini"),
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
  "HOME",
] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>(
  ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]),
);

const BOOTSTRAP_MARKER = "BOOTSTRAP-MARKER-BLO-22497";
const TASK_CONTEXT_MARKER = "TASK-CONTEXT-MARKER-BLO-22497";

const AGENT = {
  id: "agent-1",
  companyId: "company-1",
  name: "Gemini Coder",
  adapterType: "gemini_local",
  adapterConfig: { engine: "cli" },
} as const;

function geminiRunCalls(): Array<[string, string, string[], { stdin?: string }]> {
  return runChildProcess.mock.calls.filter(
    (entry) => Array.isArray(entry[2]) && entry[2].includes("--prompt"),
  ) as Array<[string, string, string[], { stdin?: string }]>;
}

// gemini passes the prompt via argv, not stdin.
function promptArg(call: [string, string, string[], { stdin?: string }] | undefined): string {
  const args = call?.[2] ?? [];
  const index = args.indexOf("--prompt");
  return index >= 0 ? args[index + 1] ?? "" : "";
}

describe("gemini local execution — session-unavailable recovery prompt (BLO-22497)", () => {
  const cleanupDirs: string[] = [];

  beforeEach(async () => {
    for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
    // Avoid execute()'s skill-injection step touching the real ~/.gemini/skills.
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-home-"));
    cleanupDirs.push(homeDir);
    process.env.HOME = homeDir;
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

  function baseConfig() {
    return {
      engine: "cli",
      command: "gemini",
      env: { GEMINI_API_KEY: "test-key", NO_COLOR: "1" },
      promptTemplate: `${TASK_CONTEXT_MARKER} {{agentId}}`,
      bootstrapPromptTemplate: `${BOOTSTRAP_MARKER} {{agentId}}`,
      paperclipSkillSync: { desiredSkills: [] },
    };
  }

  function baseContext(workspaceDir: string) {
    return {
      paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      paperclipWake: { issue: { id: "issue-1", title: "Fix the thing" } },
    };
  }

  it(
    "renders a fresh-session prompt (bootstrap + full task context, no resume-delta phrasing) on the recovered attempt, while leaving the original resume attempt's prompt unchanged",
    async () => {
      const workspaceDir = await makeWorkspaceDir("paperclip-gemini-session-recovery-");

      const result = await execute({
        runId: "run-session-recovery",
        agent: AGENT,
        runtime: {
          sessionId: RESUME_SESSION_ID,
          sessionParams: { sessionId: RESUME_SESSION_ID, cwd: workspaceDir },
          sessionDisplayId: RESUME_SESSION_ID,
          taskKey: null,
        },
        config: baseConfig(),
        context: baseContext(workspaceDir),
        onLog: async () => {},
      });

      expect(result.sessionId).toBe(FRESH_SESSION_ID);

      const runCalls = geminiRunCalls();
      expect(runCalls).toHaveLength(2);

      const [resumeCall, recoveredCall] = runCalls;
      expect(resumeCall?.[2]).toEqual(expect.arrayContaining(["--resume", RESUME_SESSION_ID]));
      expect(recoveredCall?.[2]).not.toContain("--resume");

      // Guard: the original (resumed) attempt keeps today's resume-delta prompt.
      const resumePrompt = promptArg(resumeCall);
      expect(resumePrompt).toContain("## Paperclip Resume Delta");
      expect(resumePrompt).not.toContain("## Paperclip Wake Payload");
      expect(resumePrompt).not.toContain(BOOTSTRAP_MARKER);
      expect(resumePrompt).not.toContain(TASK_CONTEXT_MARKER);

      // The defect: the recovered attempt must get fresh-session semantics.
      const recoveredPrompt = promptArg(recoveredCall);
      expect(recoveredPrompt).toContain(BOOTSTRAP_MARKER);
      expect(recoveredPrompt).toContain(TASK_CONTEXT_MARKER);
      expect(recoveredPrompt).toContain("## Paperclip Wake Payload");
      expect(recoveredPrompt).not.toContain("## Paperclip Resume Delta");
    },
    RUN_CHILD_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "guard: a cold start (no prior session) already renders fresh-session semantics on its only attempt — no prompt-size regression from this fix",
    async () => {
      const workspaceDir = await makeWorkspaceDir("paperclip-gemini-cold-start-");

      const result = await execute({
        runId: "run-cold-start",
        agent: AGENT,
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: baseConfig(),
        context: baseContext(workspaceDir),
        onLog: async () => {},
      });

      expect(result.sessionId).toBe(FRESH_SESSION_ID);

      const runCalls = geminiRunCalls();
      expect(runCalls).toHaveLength(1);

      const prompt = promptArg(runCalls[0]);
      expect(prompt).toContain(BOOTSTRAP_MARKER);
      expect(prompt).toContain(TASK_CONTEXT_MARKER);
      expect(prompt).toContain("## Paperclip Wake Payload");
      expect(prompt).not.toContain("## Paperclip Resume Delta");
    },
    RUN_CHILD_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "a recovery-shaped wake still suppresses the task-context prompt on the recovered attempt, matching a cold start on the same payload",
    async () => {
      const workspaceDir = await makeWorkspaceDir("paperclip-gemini-recovery-wake-");

      await execute({
        runId: "run-recovery-wake",
        agent: AGENT,
        runtime: {
          sessionId: RESUME_SESSION_ID,
          sessionParams: { sessionId: RESUME_SESSION_ID, cwd: workspaceDir },
          sessionDisplayId: RESUME_SESSION_ID,
          taskKey: null,
        },
        config: baseConfig(),
        context: {
          ...baseContext(workspaceDir),
          paperclipWake: {
            issue: { id: "issue-1", title: "Fix the thing" },
            reason: "source_scoped_recovery_action",
          },
        },
        onLog: async () => {},
      });

      const runCalls = geminiRunCalls();
      expect(runCalls).toHaveLength(2);
      const recoveredPrompt = promptArg(runCalls[1]);

      // Cold-start parity is the invariant, not "always include the task prompt":
      // isPaperclipRecoveryWakePayload is session-id-independent, so a recovery-shaped
      // wake legitimately suppresses the task-context prompt on both paths.
      expect(recoveredPrompt).not.toContain(TASK_CONTEXT_MARKER);
      expect(recoveredPrompt).toContain(BOOTSTRAP_MARKER);
      expect(recoveredPrompt).not.toContain("## Paperclip Resume Delta");
    },
    RUN_CHILD_PROCESS_TEST_TIMEOUT_MS,
  );
});

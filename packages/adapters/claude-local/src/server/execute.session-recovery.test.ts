import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// BLO-22497: claude-local has TWO fresh-session fallbacks that call runAttempt(null)
// — the session-unavailable/poisoned retry and the ccrotate rotation retry — but the
// stdin prompt used to be built exactly once, keyed on the *original* sessionId. That
// left both recovered attempts with a resume-delta prompt (no bootstrap prompt, no
// task-context prompt) even though each starts a genuinely new session. These tests
// drive execute() through each fallback and assert on what the *second* attempt's
// stdin actually contains.

const RUN_CHILD_PROCESS_TEST_TIMEOUT_MS = 30_000;

const RESUME_SESSION_ID = "3f1c0a4e-7c2d-4b91-9a3f-1d2e5b6c7a80";
const FRESH_SESSION_ID = "claude-session-fresh";

type ResumeFailureMode = "unknown_session" | "auth_required";

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs, state } = vi.hoisted(() => {
  const state = { resumeFailureMode: "unknown_session" as ResumeFailureMode };

  const successStdout = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-fresh", model: "claude-sonnet" }),
    JSON.stringify({
      type: "assistant",
      session_id: "claude-session-fresh",
      message: { content: [{ type: "text", text: "recovered" }] },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "claude-session-fresh",
      result: "recovered",
      usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    }),
  ].join("\n");

  const runChildProcess = vi.fn(
    async (
      _runId: string,
      command: string,
      args: string[],
      _opts: { stdin?: string },
    ) => {
      // ccrotate advance runs as `sh -lc "... ccrotate --target claude next --yes ..."`.
      if (command === "sh" && args.some((arg) => arg.includes("ccrotate"))) {
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "✓ Switched to account: rotated@example.com (standard)\n",
          stderr: "",
          pid: 200,
          startedAt: new Date().toISOString(),
        };
      }

      if (args.includes("--resume")) {
        if (state.resumeFailureMode === "auth_required") {
          // Auth failure keeps exitCode 0 on purpose: requiresLogin overrides
          // claudeReportedSuccess, and a non-zero exit would instead trip the
          // session-unavailable branch and never reach the ccrotate fallback.
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: JSON.stringify({
              type: "result",
              subtype: "success",
              is_error: false,
              session_id: RESUME_SESSION_ID,
              result: "Not logged in · Please run /login",
            }),
            stderr: "",
            pid: 101,
            startedAt: new Date().toISOString(),
          };
        }
        // The resumed session is gone server-side, which
        // isClaudeUnknownSessionError() classifies as the recovery trigger.
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: JSON.stringify({
            type: "result",
            subtype: "error",
            is_error: true,
            session_id: RESUME_SESSION_ID,
            result: `Error: No conversation found with session id ${RESUME_SESSION_ID}`,
          }),
          stderr: "",
          pid: 101,
          startedAt: new Date().toISOString(),
        };
      }

      // Fresh session (no --resume flag): the recovered attempt.
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: successStdout,
        stderr: "",
        pid: 102,
        startedAt: new Date().toISOString(),
      };
    },
  );

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
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

import { execute } from "./execute.js";
import { prepareClaudePromptBundle } from "./prompt-cache.js";

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

const BOOTSTRAP_MARKER = "BOOTSTRAP-MARKER-BLO-22497";
const TASK_CONTEXT_MARKER = "TASK-CONTEXT-MARKER-BLO-22497";

const AGENT = {
  id: "agent-1",
  companyId: "company-1",
  name: "Claude Coder",
  adapterType: "claude_local",
  adapterConfig: { engine: "cli" },
} as const;

function claudeRunCalls(): Array<[string, string, string[], { stdin?: string }]> {
  return runChildProcess.mock.calls.filter(
    (entry) => Array.isArray(entry[2]) && entry[2].includes("--print"),
  ) as Array<[string, string, string[], { stdin?: string }]>;
}

describe("claude local execution — fresh-session recovery prompt (BLO-22497)", () => {
  const cleanupDirs: string[] = [];

  beforeEach(async () => {
    for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
    state.resumeFailureMode = "unknown_session";
    // Keep the prompt-bundle cache, the run MCP config, and the shared Claude
    // config dir out of the real Paperclip instance root / $HOME.
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

  // claude-local only resumes when the recorded prompt-bundle key still matches the
  // one this run computes, so derive it rather than hardcoding the hash.
  async function resolvePromptBundleKey(): Promise<string> {
    const bundle = await prepareClaudePromptBundle({
      companyId: AGENT.companyId,
      skills: [],
      instructionsContents: null,
      onLog: async () => {},
    });
    return bundle.bundleKey;
  }

  function baseConfig() {
    return {
      engine: "cli",
      command: "claude",
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

  it(
    "session-unavailable fallback renders a fresh-session prompt on the recovered attempt, leaving the resume attempt's prompt unchanged",
    async () => {
      const workspaceDir = await makeWorkspaceDir("paperclip-claude-session-recovery-");
      const promptBundleKey = await resolvePromptBundleKey();

      const result = await execute({
        runId: "run-session-recovery",
        agent: AGENT,
        runtime: {
          sessionId: RESUME_SESSION_ID,
          sessionParams: { sessionId: RESUME_SESSION_ID, cwd: workspaceDir, promptBundleKey },
          sessionDisplayId: RESUME_SESSION_ID,
          taskKey: null,
        },
        config: baseConfig(),
        context: baseContext(workspaceDir),
        onLog: async () => {},
      });

      expect(result.sessionId).toBe(FRESH_SESSION_ID);

      const runCalls = claudeRunCalls();
      expect(runCalls).toHaveLength(2);

      const [resumeCall, recoveredCall] = runCalls;
      expect(resumeCall?.[2]).toEqual(expect.arrayContaining(["--resume", RESUME_SESSION_ID]));
      expect(recoveredCall?.[2]).not.toContain("--resume");

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
    "ccrotate rotation fallback also renders a fresh-session prompt on its retry (the second runAttempt(null) site)",
    async () => {
      const workspaceDir = await makeWorkspaceDir("paperclip-claude-ccrotate-recovery-");
      const promptBundleKey = await resolvePromptBundleKey();
      state.resumeFailureMode = "auth_required";

      const result = await execute({
        runId: "run-ccrotate-recovery",
        agent: AGENT,
        runtime: {
          sessionId: RESUME_SESSION_ID,
          sessionParams: { sessionId: RESUME_SESSION_ID, cwd: workspaceDir, promptBundleKey },
          sessionDisplayId: RESUME_SESSION_ID,
          taskKey: null,
        },
        config: baseConfig(),
        context: baseContext(workspaceDir),
        onLog: async () => {},
      });

      expect(result.sessionId).toBe(FRESH_SESSION_ID);

      // Prove we actually went through the ccrotate branch and not the
      // session-unavailable one, so this case really does cover the second site.
      const ccrotateCalls = runChildProcess.mock.calls.filter(
        (entry) => entry[1] === "sh" && (entry[2] as string[]).some((arg) => arg.includes("ccrotate")),
      );
      expect(ccrotateCalls).toHaveLength(1);

      const runCalls = claudeRunCalls();
      expect(runCalls).toHaveLength(2);

      const [authFailedCall, rotatedCall] = runCalls;
      expect(authFailedCall?.[2]).toEqual(expect.arrayContaining(["--resume", RESUME_SESSION_ID]));
      expect(rotatedCall?.[2]).not.toContain("--resume");

      const authFailedStdin = authFailedCall?.[3].stdin ?? "";
      expect(authFailedStdin).toContain("## Paperclip Resume Delta");
      expect(authFailedStdin).not.toContain(BOOTSTRAP_MARKER);
      expect(authFailedStdin).not.toContain(TASK_CONTEXT_MARKER);

      const rotatedStdin = rotatedCall?.[3].stdin ?? "";
      expect(rotatedStdin).toContain(BOOTSTRAP_MARKER);
      expect(rotatedStdin).toContain(TASK_CONTEXT_MARKER);
      expect(rotatedStdin).toContain("## Paperclip Wake Payload");
      expect(rotatedStdin).not.toContain("## Paperclip Resume Delta");
    },
    RUN_CHILD_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "guard: a cold start (no prior session) already renders fresh-session semantics on its only attempt — no prompt-size regression from this fix",
    async () => {
      const workspaceDir = await makeWorkspaceDir("paperclip-claude-cold-start-");

      const result = await execute({
        runId: "run-cold-start",
        agent: AGENT,
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: baseConfig(),
        context: baseContext(workspaceDir),
        onLog: async () => {},
      });

      expect(result.sessionId).toBe(FRESH_SESSION_ID);

      const runCalls = claudeRunCalls();
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
      const workspaceDir = await makeWorkspaceDir("paperclip-claude-recovery-wake-");
      const promptBundleKey = await resolvePromptBundleKey();
      const recoveryWake = {
        issue: { id: "issue-1", title: "Fix the thing" },
        reason: "source_scoped_recovery_action",
      };

      await execute({
        runId: "run-recovery-wake",
        agent: AGENT,
        runtime: {
          sessionId: RESUME_SESSION_ID,
          sessionParams: { sessionId: RESUME_SESSION_ID, cwd: workspaceDir, promptBundleKey },
          sessionDisplayId: RESUME_SESSION_ID,
          taskKey: null,
        },
        config: baseConfig(),
        context: { ...baseContext(workspaceDir), paperclipWake: recoveryWake },
        onLog: async () => {},
      });

      const runCalls = claudeRunCalls();
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

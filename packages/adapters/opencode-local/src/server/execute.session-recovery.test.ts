import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// BLO-22301: the session-unavailable fallback in execute.ts starts a genuinely new
// opencode session via runAttempt(null), but the prompt used to be built exactly
// once, keyed on the *original* sessionId. That left the recovered attempt with a
// resume-delta prompt (no bootstrap prompt, no task-context prompt) even though it
// was starting fresh. These tests drive execute() through a simulated
// "Session unavailable" first attempt and assert on what the *second* attempt's
// stdin actually contains.

const RUN_CHILD_PROCESS_TEST_TIMEOUT_MS = 30_000;

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => {
  const runChildProcess = vi.fn(
    async (
      _runId: string,
      _command: string,
      args: string[],
      _opts: { stdin?: string },
    ) => {
      if (args.includes("models")) {
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "test-provider/test-model\n",
          stderr: "",
          pid: 100,
          startedAt: new Date().toISOString(),
        };
      }
      if (args.includes("--session")) {
        // The resumed session is gone server-side: opencode reports it as an
        // unknown/missing session, which isOpenCodeUnknownSessionError() must
        // classify as the recovery trigger.
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: [
            JSON.stringify({ type: "error", error: { message: "Session not found: session-abc" } }),
          ].join("\n"),
          stderr: "",
          pid: 101,
          startedAt: new Date().toISOString(),
        };
      }
      // Fresh session (no --session flag): the recovered attempt.
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "step_start", sessionID: "session_fresh" }),
          JSON.stringify({ type: "text", sessionID: "session_fresh", part: { text: "recovered" } }),
          JSON.stringify({
            type: "step_finish",
            sessionID: "session_fresh",
            part: { cost: 0.001, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
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
    resolveCommandForLogs: vi.fn(async () => "opencode"),
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
  "OPENCODE_ALLOW_ALL_MODELS",
  "PAPERCLIP_TASK_ID",
  "PAPERCLIP_WAKE_REASON",
  "PAPERCLIP_WAKE_COMMENT_ID",
  "PAPERCLIP_WAKE_PAYLOAD_JSON",
  "HOME",
] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>(
  ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]),
);

const BOOTSTRAP_MARKER = "BOOTSTRAP-MARKER-BLO-22301";
const TASK_CONTEXT_MARKER = "TASK-CONTEXT-MARKER-BLO-22301";

function findRunCall(): [string, string, string[], { stdin?: string }] | undefined {
  return runChildProcess.mock.calls.find(
    (entry) => Array.isArray(entry[2]) && entry[2].includes("run"),
  ) as [string, string, string[], { stdin?: string }] | undefined;
}

describe("opencode local execution — session-unavailable recovery prompt (BLO-22301)", () => {
  const cleanupDirs: string[] = [];

  beforeEach(async () => {
    for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
    // Avoid execute()'s skill-injection step touching the real $HOME/.claude/skills.
    process.env.HOME = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-home-"));
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

  it(
    "renders a fresh-session prompt (bootstrap + full task context, no resume-delta phrasing) on the recovered attempt, while leaving the original resume attempt's prompt unchanged",
    async () => {
      const workspaceDir = await makeWorkspaceDir("paperclip-opencode-session-recovery-");

      const result = await execute({
        runId: "run-session-recovery",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Builder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: "session-abc",
          sessionParams: { sessionId: "session-abc", cwd: workspaceDir },
          sessionDisplayId: "session-abc",
          taskKey: null,
        },
        config: {
          command: "opencode",
          model: "test-provider/test-model",
          promptTemplate: `${TASK_CONTEXT_MARKER} {{agentId}}`,
          bootstrapPromptTemplate: `${BOOTSTRAP_MARKER} {{agentId}}`,
          paperclipSkillSync: { desiredSkills: [] },
        },
        context: {
          paperclipWorkspace: {
            cwd: workspaceDir,
            source: "project_primary",
          },
          paperclipWake: {
            issue: { id: "issue-1", title: "Fix the thing" },
          },
        },
        onLog: async () => {},
      });

      expect(result.sessionId).toBe("session_fresh");
      // The retry succeeded and produced a real session id, so there is nothing
      // to clear — clearSession only fires when even the retry comes back
      // without a session id.
      expect(result.clearSession).toBe(false);

      const runCalls = runChildProcess.mock.calls.filter(
        (entry) => Array.isArray(entry[2]) && entry[2].includes("run"),
      ) as Array<[string, string, string[], { stdin?: string }]>;
      expect(runCalls).toHaveLength(2);

      const [resumeCall, recoveredCall] = runCalls;
      expect(resumeCall?.[2]).toEqual(expect.arrayContaining(["--session", "session-abc"]));
      expect(recoveredCall?.[2]).not.toContain("--session");

      // Guard: the original (resumed) attempt keeps today's resume-delta prompt —
      // no bootstrap, no full task-context prompt, resume-delta phrasing only.
      const resumeStdin = resumeCall?.[3].stdin ?? "";
      expect(resumeStdin).toContain("## Paperclip Resume Delta");
      expect(resumeStdin).not.toContain("## Paperclip Wake Payload");
      expect(resumeStdin).not.toContain(BOOTSTRAP_MARKER);
      expect(resumeStdin).not.toContain(TASK_CONTEXT_MARKER);

      // The defect: the recovered attempt must get fresh-session semantics —
      // bootstrap prompt included, wake prompt rendered with resumedSession: false
      // (no resume-delta phrasing), and the full task-context prompt included.
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
      const workspaceDir = await makeWorkspaceDir("paperclip-opencode-cold-start-");

      const result = await execute({
        runId: "run-cold-start",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Builder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "opencode",
          model: "test-provider/test-model",
          promptTemplate: `${TASK_CONTEXT_MARKER} {{agentId}}`,
          bootstrapPromptTemplate: `${BOOTSTRAP_MARKER} {{agentId}}`,
          paperclipSkillSync: { desiredSkills: [] },
        },
        context: {
          paperclipWorkspace: {
            cwd: workspaceDir,
            source: "project_primary",
          },
          paperclipWake: {
            issue: { id: "issue-1", title: "Fix the thing" },
          },
        },
        onLog: async () => {},
      });

      expect(result.sessionId).toBe("session_fresh");

      const runCalls = runChildProcess.mock.calls.filter(
        (entry) => Array.isArray(entry[2]) && entry[2].includes("run"),
      ) as Array<[string, string, string[], { stdin?: string }]>;
      expect(runCalls).toHaveLength(1);

      const stdin = runCalls[0]?.[3].stdin ?? "";
      expect(stdin).toContain(BOOTSTRAP_MARKER);
      expect(stdin).toContain(TASK_CONTEXT_MARKER);
      expect(stdin).toContain("## Paperclip Wake Payload");
      expect(stdin).not.toContain("## Paperclip Resume Delta");
    },
    RUN_CHILD_PROCESS_TEST_TIMEOUT_MS,
  );
});

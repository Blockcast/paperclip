// PEN-3156: process wrapper for the `git` egress door.
//
// Two modes, one module, because they must agree about what a push is:
//
//   wrapper   node github-git-egress-runtime.js <git> <argv...>
//             Classifies argv. On a push it closes the hook bypass and points
//             git at the hooks directory below, then execs the real git.
//
//   hook      node github-git-egress-runtime.js --pre-push-hook <remote> <url>
//             Runs as git's pre-push hook. Reads the ref updates git computes on
//             stdin, scans what they would publish, and exits non-zero — which
//             is what aborts the push — naming the commit to amend.
//
// Why a hook rather than scanning in the wrapper: git already resolves
// refspecs, `push.default`, and tracking config to decide what it is about to
// send, and hands that result to the hook as exact `<local sha> <remote sha>`
// pairs. Re-deriving it in the wrapper would mean a second implementation of
// those rules that could disagree with the push actually taking place, and
// disagreeing in the permissive direction is a silent hole.
//
// Why the wrapper is still needed: a hook alone is bypassable with
// `--no-verify`, and `core.hooksPath` has to be injected by something. The
// wrapper is the part an agent cannot route around, because it is what `git`
// resolves to on PATH.

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyGitInvocation,
  formatRefusal,
  parsePrePushInput,
  scanPrePushUpdates,
  type GitReader,
} from "./github-git-egress-shim.js";

/** Where the Helm seed writes the pre-push hook. */
export const DEFAULT_HOOKS_DIR = "/paperclip/.local/share/paperclip-git-hooks";

/** The real git, for the hook's own read-only queries. */
export const DEFAULT_GIT_BINARY = "/usr/bin/git";

export function hooksDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.PAPERCLIP_GIT_EGRESS_HOOKS_DIR || DEFAULT_HOOKS_DIR;
}

export function gitBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.PAPERCLIP_GIT_EGRESS_GIT || DEFAULT_GIT_BINARY;
}

export class GitEgressRuntimeError extends Error {
  constructor(
    message: string,
    readonly exitCode = 64,
  ) {
    super(message);
    this.name = "GitEgressRuntimeError";
  }
}

/**
 * Build the argv the real git is invoked with.
 *
 * `core.hooksPath` is injected only for a push. Setting it unconditionally
 * would shadow every OTHER hook a repository defines — pre-commit, commit-msg —
 * because a hooks directory holding only `pre-push` makes the rest silently stop
 * running. Scoping the injection to the one command whose hook we supply keeps
 * that blast radius off unrelated workflows.
 */
export function buildGitArgv(
  argv: readonly string[],
  options: { hooksDir: string; resolveAlias?: (name: string) => string | null },
): string[] {
  const classification = classifyGitInvocation(argv, options.resolveAlias);
  if (!classification.isPush) return [...argv];

  if (classification.hasNoVerify) {
    throw new GitEgressRuntimeError(
      "paperclip-github-egress: --no-verify is disabled on publish, because it skips the hook that checks whether the commits carry credential-shaped material. Re-run without it.",
    );
  }

  // Global options must precede the subcommand, so this goes at the front.
  return ["-c", `core.hooksPath=${options.hooksDir}`, ...argv];
}

export function makeGitReader(gitPath: string, cwd?: string): GitReader {
  return (args: string[]) => {
    const result = spawnSync(gitPath, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) return null;
    return result.stdout;
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buffer = "";
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
    });
    process.stdin.on("end", () => resolve(buffer));
    process.stdin.on("error", () => resolve(buffer));
  });
}

/**
 * The pre-push hook. Exit 0 lets the push proceed; non-zero aborts it.
 *
 * Every remote is guarded, not only github.com. The material this refuses is
 * credential-shaped wherever it lands, and scoping the check by remote URL would
 * turn `git remote add` into the bypass.
 */
export async function runPrePushHook(options: {
  input: string;
  runGit: GitReader;
  stderr?: (message: string) => void;
}): Promise<number> {
  const write = options.stderr ?? ((message: string) => process.stderr.write(`${message}\n`));
  const updates = parsePrePushInput(options.input);
  if (updates.length === 0) return 0;

  const findings = scanPrePushUpdates(updates, options.runGit);
  if (findings.length === 0) return 0;

  write(formatRefusal(findings));
  return 1;
}

export function runGitEgressRuntime(options: {
  target: string;
  argv: string[];
  hooksDir: string;
}): Promise<number> {
  const resolveAlias = (name: string): string | null => {
    const result = spawnSync(options.target, ["config", "--get", `alias.${name}`], {
      encoding: "utf8",
    });
    if (result.error || result.status !== 0) return null;
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  };

  const argv = buildGitArgv(options.argv, { hooksDir: options.hooksDir, resolveAlias });

  return new Promise((resolve, reject) => {
    const child = spawn(options.target, argv, { stdio: "inherit" });
    let forwardedSignal = false;
    let settled = false;
    const forwardSignal = (signal: NodeJS.Signals) => {
      forwardedSignal = true;
      child.kill(signal);
    };
    process.on("SIGINT", forwardSignal);
    process.on("SIGTERM", forwardSignal);
    const cleanup = () => {
      process.off("SIGINT", forwardSignal);
      process.off("SIGTERM", forwardSignal);
    };

    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new GitEgressRuntimeError(`unable to start git (${error.code ?? "unknown error"})`, 1));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== null) {
        resolve(code);
        return;
      }
      resolve(forwardedSignal ? 128 : signal ? 128 + (signal === "SIGINT" ? 2 : 15) : 1);
    });
  });
}

function reportRuntimeError(error: unknown): void {
  const message = error instanceof Error ? error.message : "unexpected preparation failure";
  const exitCode = error instanceof GitEgressRuntimeError ? error.exitCode : 1;
  console.error(message.startsWith("paperclip-github-egress") ? message : `paperclip-github-egress: ${message}`);
  process.exitCode = exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--pre-push-hook") {
    void readStdin()
      .then((input) =>
        runPrePushHook({ input, runGit: makeGitReader(gitBinary()) }),
      )
      .then((exitCode) => {
        process.exitCode = exitCode;
      })
      .catch(reportRuntimeError);
  } else {
    const target = process.argv[2];
    const argv = process.argv.slice(3);
    try {
      if (!target) throw new GitEgressRuntimeError("missing git target");
      void runGitEgressRuntime({ target, argv, hooksDir: hooksDirectory() })
        .then((exitCode) => {
          process.exitCode = exitCode;
        })
        .catch(reportRuntimeError);
    } catch (error) {
      reportRuntimeError(error);
    }
  }
}

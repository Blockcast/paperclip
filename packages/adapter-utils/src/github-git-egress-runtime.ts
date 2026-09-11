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
  formatScanFailure,
  gitGlobalOptions,
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
 *
 * Placement is a security property, not a style choice. Git takes the LAST `-c`
 * given for a key, so injecting at the FRONT lets a caller-supplied
 * `git -c core.hooksPath=/tmp/empty push` override the guard and skip the
 * scanner entirely. The guard therefore goes immediately before the subcommand,
 * after every global option the caller passed, where it is the last value git
 * sees. Measured against git 2.47.3: from that position it also beats
 * `--config-env=core.hooksPath=...`, the case-folded `CORE.HOOKSPATH` spelling,
 * a repository's own `core.hooksPath` config, and `GIT_CONFIG_KEY_*` in the
 * environment.
 */
export function buildGitArgv(
  argv: readonly string[],
  options: {
    hooksDir: string;
    resolveAlias?: (name: string) => string | null;
    env?: NodeJS.ProcessEnv;
  },
): string[] {
  const classification = classifyGitInvocation(argv, options.resolveAlias, options.env ?? {});
  if (!classification.isPush) return [...argv];

  if (classification.hasNoVerify) {
    throw new GitEgressRuntimeError(
      "paperclip-github-egress: --no-verify is disabled on publish, because it skips the hook that checks whether the commits carry credential-shaped material. Re-run without it.",
    );
  }

  // Injecting last already wins over this, so the refusal is not what makes the
  // guard hold — it is here so a caller who asked for a different hooks
  // directory is told their request was rejected rather than silently dropped,
  // and so the control does not rest on ordering alone.
  if (classification.hooksPathOverride) {
    throw new GitEgressRuntimeError(
      `paperclip-github-egress: refusing to publish — this invocation sets core.hooksPath itself (\`${classification.hooksPathOverride}\`), which would replace the hook that checks whether these commits carry credential-shaped material. Re-run the push without it.`,
    );
  }

  // An alias is the one case injection cannot win: git expands it AFTER the
  // command line, so a `-c core.hooksPath=` or `--no-verify` inside the
  // expansion is the last thing git sees no matter where the guard is placed.
  // Refusal is the only enforcement available here.
  if (classification.aliasBypass) {
    const { alias, expansion, reason } = classification.aliasBypass;
    const what =
      reason === "no-verify"
        ? "skips the pre-push hook with --no-verify"
        : "points core.hooksPath somewhere else";
    throw new GitEgressRuntimeError(
      `paperclip-github-egress: refusing to publish — the alias \`${alias}\` expands to a push that ${what} (\`${expansion}\`), which would bypass the check for credential-shaped material. Invoke the push directly instead of through the alias, or redefine the alias without it.`,
    );
  }

  // Immediately before the subcommand: after the caller's global options, so
  // this is the last `core.hooksPath` git reads, and still ahead of the
  // subcommand, which is where git requires global options to sit.
  const at = classification.subcommandIndex;
  return [
    ...argv.slice(0, at),
    "-c",
    `core.hooksPath=${options.hooksDir}`,
    ...argv.slice(at),
  ];
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
 *
 * The scan is wrapped so that ANY failure aborts the push. A guard whose error
 * path is "allow" is not a guard: a git read that fails, a buffer that
 * overflows on a large diff, or an unanticipated throw would each otherwise
 * publish the commits unscanned, and the larger the push the likelier that gets.
 */
export async function runPrePushHook(options: {
  input: string;
  runGit: GitReader;
  stderr?: (message: string) => void;
}): Promise<number> {
  const write = options.stderr ?? ((message: string) => process.stderr.write(`${message}\n`));
  const updates = parsePrePushInput(options.input);
  if (updates.length === 0) return 0;

  let findings;
  try {
    findings = scanPrePushUpdates(updates, options.runGit);
  } catch (error) {
    // Deliberately catching everything, not just GitEgressScanError. An
    // unexpected throw is exactly the case where the scanner's verdict is
    // unknown, which must refuse rather than pass.
    write(formatScanFailure(error));
    return 1;
  }

  if (findings.length === 0) return 0;

  write(formatRefusal(findings));
  return 1;
}

export function runGitEgressRuntime(options: {
  target: string;
  argv: string[];
  hooksDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  const env = options.env ?? process.env;

  // Resolve aliases under the same effective configuration git itself will use.
  // A bare `git config --get` reads whichever config files the WRAPPER's cwd
  // selects, which is not necessarily the set the invocation selects: `-C`,
  // `--git-dir` and `--work-tree` all change it, so `git -C /elsewhere yolo`
  // would be looked up against the wrong repository. Forwarding the caller's
  // own global options puts the lookup in the same place as the push.
  //
  // `--no-pager` goes last so it beats a caller's `-p`, which would otherwise
  // hand this read to a pager. Nothing here can run a hook: `config` is a read.
  //
  // This does NOT cover `-c alias.x=...`; a definition on the command line is
  // unreachable from a second process no matter what it is passed. That case is
  // closed in `classifyGitInvocation`, which reads such definitions straight out
  // of argv and consults them before this callback.
  const globals = gitGlobalOptions(options.argv);
  const resolveAlias = (name: string): string | null => {
    const result = spawnSync(
      options.target,
      [...globals, "--no-pager", "config", "--get", `alias.${name}`],
      { encoding: "utf8", env, timeout: 10_000 },
    );
    if (result.error || result.status !== 0) return null;
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  };

  const argv = buildGitArgv(options.argv, { hooksDir: options.hooksDir, resolveAlias, env });

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

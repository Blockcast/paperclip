// PEN-2527: process adapter-utils' GitHub egress transform at the `gh` binary
// boundary. The Helm seed writes a small shell launcher for this module into
// /paperclip/.local/bin, which is first on every agent Job's PATH.

import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  hasGitHubCliStdinTextFile,
  scrubGitHubCliInvocation,
} from "./github-cli-egress-shim.js";

export interface GitHubCliEgressRuntimeOptions {
  target: string;
  argv: string[];
}

export class GitHubCliEgressRuntimeError extends Error {
  constructor(
    message: string,
    readonly exitCode = 64,
  ) {
    super(message);
    this.name = "GitHubCliEgressRuntimeError";
  }
}

export function prepareGitHubCliInvocation(options: GitHubCliEgressRuntimeOptions): {
  argv: string[];
  temporaryDirectory: string | null;
} {
  const { target, argv } = options;
  if (!target) throw new GitHubCliEgressRuntimeError("missing GitHub CLI target");

  // `gh --body-file -` and `gh --notes-file -` stream authored text directly
  // from stdin. Reject them before spawning gh: there is no safe way to let a
  // child consume the stream while guaranteeing that every byte has passed
  // through the structural scrubber first. This is intentionally fail-closed.
  if (hasGitHubCliStdinTextFile(argv)) {
    throw new GitHubCliEgressRuntimeError(
      "--body-file -/--notes-file - is disabled; use a file-backed body so it can be scrubbed",
    );
  }

  let temporaryDirectory: string | null = null;
  const result = scrubGitHubCliInvocation(argv, {
    readText: (filePath) => readFileSync(filePath, "utf8"),
    writeTempText: (contents) => {
      if (!temporaryDirectory) {
        const tempRoot = process.env.TMPDIR || os.tmpdir();
        temporaryDirectory = mkdtempSync(path.join(tempRoot, "paperclip-gh-egress-"));
      }
      const filePath = path.join(temporaryDirectory, `body-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      writeFileSync(filePath, contents, { encoding: "utf8", mode: 0o600 });
      return filePath;
    },
  });

  return { argv: result.argv, temporaryDirectory };
}

export function runGitHubCliEgressRuntime(
  options: GitHubCliEgressRuntimeOptions,
): Promise<number> {
  const invocation = prepareGitHubCliInvocation(options);
  return new Promise((resolve, reject) => {
    const child = spawn(options.target, invocation.argv, { stdio: "inherit" });
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
      if (invocation.temporaryDirectory) {
        rmSync(invocation.temporaryDirectory, { recursive: true, force: true });
      }
    };

    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new GitHubCliEgressRuntimeError(
          `unable to start GitHub CLI (${error.code ?? "unknown error"})`,
          1,
        ),
      );
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== null) {
        resolve(code);
        return;
      }
      // Preserve the conventional signal exit status when the child was not
      // already terminated by a signal forwarded from this process.
      resolve(forwardedSignal ? 128 : signal ? 128 + (signal === "SIGINT" ? 2 : 15) : 1);
    });
  });
}

function reportRuntimeError(error: unknown): void {
  const message = error instanceof Error ? error.message : "unexpected preparation failure";
  const exitCode = error instanceof GitHubCliEgressRuntimeError ? error.exitCode : 1;
  console.error(`paperclip-github-egress: ${message}`);
  process.exitCode = exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  const argv = process.argv.slice(3);
  try {
    void runGitHubCliEgressRuntime({ target: target ?? "", argv })
      .then((exitCode) => {
        process.exitCode = exitCode;
      })
      .catch(reportRuntimeError);
  } catch (error) {
    reportRuntimeError(error);
  }
}

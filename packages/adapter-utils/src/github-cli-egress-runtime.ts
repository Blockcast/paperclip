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
import {
  type CommitReachability,
  evaluateReviewSubmission,
  type ReviewAttestationGuardIo,
} from "./github-review-attestation.js";

export interface GitHubCliEgressRuntimeOptions {
  target: string;
  argv: string[];
  /** Override the review-attestation guard's I/O. Tests inject a resolver so
   *  the guard can be exercised without a network or a real repository. */
  guardIo?: ReviewAttestationGuardIo;
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

  // `gh --body-file -`, `gh --notes-file -`, and `gh api --input -` stream
  // authored text directly from stdin. Typed `gh api --field key=@-` has the
  // same property. Reject them before spawning gh: there is no safe way to let
  // a child consume the stream while guaranteeing that every byte has passed
  // through the structural scrubber first. This is intentionally fail-closed.
  if (hasGitHubCliStdinTextFile(argv)) {
    throw new GitHubCliEgressRuntimeError(
      "stdin-backed GitHub text/request body is disabled; use file-backed text so it can be scrubbed",
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

  // BLO-33171: a repository-content field that trips a detector is refused, not
  // rewritten. Scrubbing it in place would silently corrupt the bytes that get
  // committed — #1542 landed with 9 `sk-` test fixtures replaced, and the diff
  // read on review as a deliberate weakening of a redaction test. Exempting the
  // field instead would be a credential-exfiltration bypass, since a blob in a
  // public repo is as public as a PR comment. Same fail-closed reasoning as the
  // stdin rejection above: refuse, and say exactly what to fix.
  if (result.refusals.length > 0) {
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    const detail = result.refusals
      .map((refusal) => {
        const where = refusal.path ? ` (${refusal.path})` : "";
        return `\`${refusal.field}\`${where} matched ${refusal.classes.join(", ")}`;
      })
      .join("; ");
    throw new GitHubCliEgressRuntimeError(
      `refusing to rewrite GitHub repository content: ${detail}. ` +
        "Content fields are never scrubbed in place — a silent rewrite would corrupt the committed bytes. " +
        "Remove the credential-shaped material; if it is a test fixture, derive the value at runtime " +
        "rather than embedding a literal.",
    );
  }

  return { argv: result.argv, temporaryDirectory };
}

/**
 * Run the real GitHub CLI and capture its output.
 *
 * `target` is the binary this wrapper fronts (/usr/bin/gh in the pod), never
 * the wrapper itself, so the guard's own probe calls cannot recurse back
 * through this runtime.
 */
function captureTarget(
  target: string,
  argv: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(target, [...argv], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      resolve({ code: null, stdout, stderr: `${stderr}${error.code ?? "spawn failed"}` });
    });
    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

// A definite "this commit is not in this repository". `gh api` reports a
// nonexistent SHA as 422 ("No commit found for SHA") and a missing or
// invisible repository as 404. Anything else — a 5xx, a DNS failure, an auth
// problem — is deliberately NOT matched here, so it falls through to
// "indeterminate" and is refused rather than mistaken for a clean negative.
const DEFINITE_ABSENCE_PATTERN = /HTTP 404|HTTP 422|Not Found|No commit found/i;

/**
 * Build the guard's I/O against the real GitHub CLI.
 *
 * Reachability is asked via `GET /repos/{owner}/{repo}/commits/{sha}` rather
 * than commit search: search is index-backed and returns an empty result for a
 * commit pushed moments earlier, which would refuse legitimate reviews of a
 * fresh head. The direct endpoint is authoritative.
 */
export function createReviewAttestationGuardIo(target: string): ReviewAttestationGuardIo {
  return {
    readText: (filePath) => readFileSync(filePath, "utf8"),
    resolveCommitReachability: async (repo, sha): Promise<CommitReachability> => {
      const result = await captureTarget(target, [
        "api",
        `repos/${repo}/commits/${sha}`,
        "--jq",
        ".sha",
      ]);
      if (result.code === 0 && result.stdout.trim().length > 0) return "reachable";
      if (DEFINITE_ABSENCE_PATTERN.test(result.stderr)) return "unreachable";
      return "indeterminate";
    },
    resolveDefaultRepo: async () => {
      const result = await captureTarget(target, [
        "repo",
        "view",
        "--json",
        "nameWithOwner",
        "--jq",
        ".nameWithOwner",
      ]);
      if (result.code !== 0) return null;
      const name = result.stdout.trim();
      return name.length > 0 ? name : null;
    },
  };
}

export async function runGitHubCliEgressRuntime(
  options: GitHubCliEgressRuntimeOptions,
): Promise<number> {
  // BLO-32844: refuse an incoherent review before anything is scrubbed or
  // spawned. This runs first because it is the only check whose failure means
  // the call must not happen at all — the scrub rewrites a call that is going
  // to proceed, whereas this one cancels it.
  const refusal = await evaluateReviewSubmission(
    options.argv,
    options.guardIo ?? createReviewAttestationGuardIo(options.target),
  );
  if (refusal) {
    throw new GitHubCliEgressRuntimeError(`${refusal.message} [${refusal.reason}]`, 65);
  }

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

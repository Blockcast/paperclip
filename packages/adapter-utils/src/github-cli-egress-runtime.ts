// PEN-2527: process adapter-utils' GitHub egress transform at the `gh` binary
// boundary. A small shell launcher for this module ships in the image at
// /usr/local/libexec/paperclip/bin (PEN-3713), which leads every agent Job's
// PATH. It used to be seeded onto the PVC at /paperclip/.local/bin; that
// agent-writable generation was retired in PEN-3840.

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
  type GitHubCliContentRefusal,
  type GitHubCliRewrite,
  hasGitHubCliStdinTextFile,
  scrubGitHubCliInvocation,
} from "./github-cli-egress-shim.js";
import { GITHUB_EGRESS_REGION_CLASSES } from "./github-egress-scrub.js";
import { brokerSocketPath, runPublishBrokerClient } from "./github-publish-broker-client.js";
import {
  type CommitReachability,
  evaluateReviewSubmission,
  type ReviewAttestationGuardIo,
} from "./github-review-attestation.js";

/** Where a rewrite notice goes. Split out so tests can capture it, exactly as
 *  {@link GitHubMcpEgressRuntimeIo} does at the MCP door. */
export interface GitHubCliEgressRuntimeIo {
  /** One already-formatted notice. Receives CLASSES and SCRUBBED excerpts
   *  only, never the material that fired. */
  notify(message: string): void;
}

const defaultIo: GitHubCliEgressRuntimeIo = {
  notify: (message) => {
    console.error(message);
  },
};

export interface GitHubCliEgressRuntimeOptions {
  target: string;
  argv: string[];
  /** Override the review-attestation guard's I/O. Tests inject a resolver so
   *  the guard can be exercised without a network or a real repository. */
  guardIo?: ReviewAttestationGuardIo;
  /** Override where the PEN-5734 rewrite notice is written. */
  io?: GitHubCliEgressRuntimeIo;
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
  /** PEN-5734: every value that was rewritten in place and is still being
   *  sent. Already announced via `io.notify` by the time this returns; it is
   *  returned as well so an embedding caller can act on the rewrite
   *  programmatically rather than by parsing stderr. Empty on a clean call. */
  rewrites: GitHubCliRewrite[];
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
    const detail = result.refusals.map(describeSpan).join("; ");
    throw new GitHubCliEgressRuntimeError(
      `refusing to rewrite GitHub repository content: ${detail}\n` +
        "Content fields are never scrubbed in place — a silent rewrite would corrupt the committed bytes. " +
        "Remove the credential-shaped material; if it is a test fixture, derive the value at runtime " +
        "rather than embedding a literal.",
    );
  }

  // PEN-5734: say what was rewritten. Everything above this point either
  // passed through byte-exact or was refused; everything that reaches here has
  // had agent-authored text REPLACED IN PLACE and is about to be published
  // anyway, which is the one outcome the caller could not previously detect.
  //
  // Measured first-hand on 2026-11-06: `gh pr edit --body-file` carrying a
  // `--force-with-lease=<ref>:<oid>` recipe ran, exited 0, printed nothing on
  // either stream, and served back a body with a redaction marker where the
  // branch name had been. Nothing in the tool result, the exit code or the
  // output distinguished that from a clean write, so an agent that trusts its
  // own success publishes a corrupted instruction and reports the step done.
  //
  // WHY THIS IS A NOTICE AND NOT A REFUSAL, since the two other doors choose
  // differently and the asymmetry has to be deliberate:
  //
  //  - The `git` push door (PEN-3156) refuses, and the content-field branch
  //    above refuses, because both carry BYTES THAT GET COMMITTED. A rewrite
  //    there survives into the repository and reads on review as an
  //    intentional change (#1542).
  //  - This branch carries PROSE — a review body, a PR description, a comment.
  //    Removing the material and publishing the rest IS the containment
  //    PEN-2527 was built to perform. Refusing instead would mean an agent
  //    that accidentally pastes a token cannot post its review at all, and the
  //    whole body is then retyped by hand around a control nobody can see.
  //
  // So the defect was never the rewrite. It was the silence.
  //
  // THE EXIT CODE STAYS THE CHILD'S, deliberately. This notice is emitted
  // BEFORE `gh` is spawned, so the author sees it whether the call then
  // succeeds or fails; but failing the invocation after a successful publish
  // would be a lie in the other direction — the artifact exists, and a caller
  // that retries on non-zero would post it twice.
  //
  // Format mirrors the refusal above, field by field, because the fleet
  // already parses that shape and because the two differ only in disposition.
  //
  // IT GOES TO STDERR, AND THAT IS VISIBLE TO STREAM-MERGING CALLERS. A caller
  // that merges the two streams — `gh api … 2>&1 | jq` is a common agent idiom
  // — gets this notice as a non-JSON leader in front of the payload, and its
  // parse fails (Ally, review 5797006954). That is deliberate and it is the
  // right trade: a loud parse failure on a call whose payload WAS rewritten is
  // strictly better than the silent corruption this notice replaces, and it is
  // recognisable by `REWRITE_NOTICE_PREFIX` rather than needing prose parsing.
  // A caller that wants the clean payload should read stderr separately rather
  // than suppress it — `2>/dev/null` here restores the exact PEN-5734 defect.
  if (result.rewrites.length > 0) {
    const io = options.io ?? defaultIo;
    io.notify(
      `${REWRITE_NOTICE_PREFIX} ${result.rewrites.map(describeSpan).join("; ")}\n` +
        "The text above is what GitHub will receive — it is NOT what you wrote. " +
        "Re-read the artifact after this call, and rewrite the marked span if the published form matters " +
        "(a literal a control requires can usually be assigned to a shell variable and interpolated).",
    );
  }

  return { argv: result.argv, temporaryDirectory, rewrites: result.rewrites };
}

/** Stable leader on the PEN-5734 rewrite notice, so a caller can recognise one
 *  without parsing prose. Distinct from the `paperclip-github-egress:` error
 *  leader `reportRuntimeError` uses, because this call is NOT failing. */
export const REWRITE_NOTICE_PREFIX = "paperclip-github-egress: REWROTE outbound text:";

/**
 * Describe one scrubbed span — the field, where its bytes came from, which
 * classes fired, and on which lines.
 *
 * Shared by the refusal and the rewrite notice so the two cannot drift: they
 * report the same evidence and differ only in what the runtime does next.
 *
 * BLO-41262: name the lines. Without them, finding the match in a 3000-line
 * draft took ~12 bisecting API calls. The excerpt is the SCRUBBED line, so
 * neither message can carry the material it removed.
 */
function describeSpan(span: GitHubCliContentRefusal | GitHubCliRewrite): string {
  const where = span.path ? ` (${span.path})` : "";
  const lines = span.locations
    .map((location) => {
      const key = location.key ? `${location.key}:` : "";
      return `\n    ${key}${location.line}: ${location.excerpt}`;
    })
    .join("");
  // A region class never has line attribution (see locateGitHubEgressMatches),
  // so say so rather than print nothing. Keyed on the class, not on
  // `locations.length === 0`: in an --input body one key can trip a region
  // class while another prints a line, and the region key still needs
  // explaining. The lines that do print come from other keys, so say that too
  // rather than read as a contradiction.
  const unlocated = span.classes.some((cls) => GITHUB_EGRESS_REGION_CLASSES.includes(cls))
    ? " (spans lines; no per-line location is reported for environment-dump or private-key-block;" +
      " any lines listed are other, single-line matches)"
    : "";
  return `\`${span.field}\`${where} matched ${span.classes.join(", ")}${unlocated}${lines}`;
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

  // PEN-4933: `gh` authenticates with the same credential as `git` and the MCP
  // server (PEN-3183 §4.1), so in a brokered deployment this container holds
  // none of it and every `gh` call is performed by the broker.
  //
  // Forwarded BEFORE `prepareGitHubCliInvocation`, not after. The scrub has to
  // happen on the side that performs the call: a scrub run here and then
  // trusted there would be a scrub the agent can skip, which is the "gate on
  // issuance, not on use" error PEN-3183 §5 names. So this process does the
  // review-attestation refusal above (a caller error, best answered locally)
  // and then hands the ORIGINAL argv over; the broker re-enters this same
  // runtime with the same shim, which is what keeps door parity true.
  //
  // Unlike the `git` door there is no local branch. Every `gh` invocation
  // reaches GitHub, so there is nothing for a credential-less container to do
  // with one.
  const brokerSocket = brokerSocketPath();
  if (brokerSocket) {
    return runPublishBrokerClient({
      socketPath: brokerSocket,
      tool: "gh",
      argv: [...options.argv],
      cwd: process.cwd(),
    });
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

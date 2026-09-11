// PEN-3152: process the MCP egress transform at the `github-mcp-server`
// boundary, mirroring github-cli-egress-runtime.ts at the `gh` boundary.
//
// The Helm seed writes a shell launcher for this module into
// /paperclip/.local/bin/github-mcp-server, which is what the seeded `.mcp.json`
// names as the `github` upstream's command. So this sits between the agent's
// MCP client and the real server, in the same position the CLI runtime occupies
// in front of /usr/bin/gh.
//
// ## Only stdin is piped, and that is a security property
//
// The child is spawned with stdout and stderr INHERITED. Responses therefore
// travel from the server to the client without passing through this process at
// all — there is no buffer here that could reorder them, no parser that could
// reject one, and no code path that could alter one. The inbound leg stays
// PEN-2370's to own, and "this runtime cannot affect responses" is a fact about
// the process topology rather than a claim about the code below.
//
// ## Fail-closed policy
//
// A frame is forwarded only after it has been scrubbed. If it cannot be
// scrubbed — unparseable depth, or a frame over the size cap whether or not it
// arrived terminated — the runtime tears down rather than passing it through.
// An agent seeing its MCP server drop is a loud, diagnosable failure; an agent
// whose secret reached a public repository is not.

import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import {
  GitHubMcpEgressFrameError,
  scrubGitHubMcpClientFrame,
} from "./github-mcp-egress-shim.js";

/**
 * Largest client frame this runtime will forward, in bytes.
 *
 * The cap applies to every frame, not only to a partial one still awaiting its
 * newline. Two distinct things need it: a frame must be complete before it can
 * be scrubbed, so without a cap a stream that never emits a newline grows
 * without bound; and a frame that arrives complete but enormous is one this
 * process would have to hold, walk and rewrite in memory before forwarding.
 *
 * 64 MiB is far above any legitimate MCP frame — GitHub's own contents API
 * rejects blobs orders of magnitude smaller — and exceeding it means the stream
 * is not carrying MCP traffic, at which point refusing is correct.
 */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export interface GitHubMcpEgressRuntimeOptions {
  target: string;
  argv: string[];
}

export class GitHubMcpEgressRuntimeError extends Error {
  constructor(
    message: string,
    readonly exitCode = 64,
  ) {
    super(message);
    this.name = "GitHubMcpEgressRuntimeError";
  }
}

/** Where a redaction notice goes. Split out so tests can capture it. */
export interface GitHubMcpEgressRuntimeIo {
  /** Structured audit line. Receives the fired CLASSES only, never the content. */
  notify(classes: readonly string[]): void;
}

const defaultIo: GitHubMcpEgressRuntimeIo = {
  notify: (classes) => {
    // Classes only. Logging the matched text would re-publish the very material
    // this runtime exists to contain, into a stream the operator then reads.
    console.error(
      `paperclip-github-mcp-egress: redacted outbound frame (${classes.join(", ")})`,
    );
  },
};

/**
 * Refuse an over-cap frame.
 *
 * Terminated and unterminated frames are refused at the same limit but are
 * distinguishable failures, and the message says which: an unterminated frame
 * may merely have been still growing, whereas a terminated one was delivered
 * oversized in full.
 */
function refuseOversizedFrame(byteLength: number, terminated: boolean): never {
  throw new GitHubMcpEgressRuntimeError(
    terminated
      ? `client frame of ${byteLength} bytes exceeded the ${MAX_FRAME_BYTES}-byte cap; refusing to forward it unscrubbed`
      : `client frame exceeded ${MAX_FRAME_BYTES} bytes with no newline terminator; refusing to forward it unscrubbed`,
  );
}

/**
 * Split a chunk-accumulated buffer into complete lines plus the trailing
 * remainder, enforcing the frame cap on EVERY frame — each complete line as
 * well as the remainder.
 *
 * Capping only the remainder leaves the cap trivially evadable: a read
 * carrying an oversized line *together with its newline* leaves a short
 * remainder, so the remainder check passes and the oversized frame is
 * forwarded anyway. That was the shipped behaviour until the Ally review of
 * `fd577e4` caught it.
 *
 * The cap belongs to the frame rather than to the leftover, so it is enforced
 * here instead of by the caller — an exported splitter that hands back an
 * over-cap line is a splitter whose next caller forgets to check it. Refusal
 * discards the whole read, including any well-sized lines that preceded the
 * offender, which is the fail-closed reading: a stream that produced one
 * impossible frame has stopped being MCP traffic.
 *
 * Exported for tests: the buffering is where a stdio proxy usually goes wrong,
 * and it is worth asserting directly rather than only through a spawned child.
 *
 * @throws {GitHubMcpEgressRuntimeError} if any frame exceeds `MAX_FRAME_BYTES`.
 */
export function splitFrames(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const at = buffer.indexOf("\n", start);
    if (at < 0) break;
    const line = buffer.slice(start, at);
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > MAX_FRAME_BYTES) refuseOversizedFrame(lineBytes, true);
    lines.push(line);
    start = at + 1;
  }

  const rest = buffer.slice(start);
  const restBytes = Buffer.byteLength(rest, "utf8");
  if (restBytes > MAX_FRAME_BYTES) refuseOversizedFrame(restBytes, false);

  return { lines, rest };
}

/**
 * Transform one client frame, returning the bytes to forward.
 *
 * Newline handling is deliberate: the terminator is re-appended here rather
 * than carried through the scrubber, so a redaction that changes the payload
 * length cannot lose or double the frame delimiter.
 */
export function transformFrame(
  line: string,
  io: GitHubMcpEgressRuntimeIo,
): string {
  // The MCP stdio transport is newline-delimited JSON. A frame that arrived
  // with a CR (a client on \r\n) keeps it: strip for parsing, restore on the
  // way out, so the child sees exactly the framing its client chose.
  const hasCr = line.endsWith("\r");
  const payload = hasCr ? line.slice(0, -1) : line;

  const result = scrubGitHubMcpClientFrame(payload);
  if (result.redacted) io.notify(result.classes);

  return `${result.line}${hasCr ? "\r" : ""}\n`;
}

/**
 * Build a stateful reader that turns raw stdin chunks into complete frames.
 *
 * It carries the two pieces of cross-chunk state, which is why this is a named
 * unit rather than a few lines inside the data handler:
 *
 * - a `StringDecoder`, so a multi-byte code point split across a chunk
 *   boundary is completed rather than decoded as two U+FFFDs;
 * - the partial-frame buffer, so a frame split across chunks is reassembled.
 *
 * Exported so tests can drive chunk boundaries exactly. The inputs that matter
 * here — a code point bisected between two reads, an oversized frame arriving
 * whole — are precisely the ones a spawned child cannot be made to produce on
 * demand, because chunking is the kernel's choice and not the writer's.
 *
 * @throws {GitHubMcpEgressRuntimeError} if any frame exceeds `MAX_FRAME_BYTES`.
 */
export function createFrameReader(): (chunk: Buffer | string) => string[] {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  return (chunk) => {
    // A chunk that is already a string was decoded upstream, so it bypasses
    // the decoder rather than being re-encoded on the way in.
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    const { lines, rest } = splitFrames(buffer);
    buffer = rest;
    return lines;
  };
}

export function runGitHubMcpEgressRuntime(
  options: GitHubMcpEgressRuntimeOptions,
  io: GitHubMcpEgressRuntimeIo = defaultIo,
): Promise<number> {
  const { target, argv } = options;
  if (!target) {
    return Promise.reject(new GitHubMcpEgressRuntimeError("missing GitHub MCP server target"));
  }

  return new Promise((resolve, reject) => {
    // stdin piped so frames can be rewritten; stdout/stderr inherited so the
    // response leg never enters this process. See the header note.
    const child = spawn(target, argv, { stdio: ["pipe", "inherit", "inherit"] });

    let settled = false;
    let forwardedSignal = false;
    // Per-stream: the carry-over bytes and partial frame belong to this stdin.
    const readFrames = createFrameReader();

    const forwardSignal = (signal: NodeJS.Signals) => {
      forwardedSignal = true;
      child.kill(signal);
    };
    process.on("SIGINT", forwardSignal);
    process.on("SIGTERM", forwardSignal);

    const cleanup = () => {
      process.off("SIGINT", forwardSignal);
      process.off("SIGTERM", forwardSignal);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Fail closed: kill the server rather than leaving a half-guarded
      // channel open behind a runtime that has stopped scrubbing.
      child.kill("SIGKILL");
      reject(error);
    };

    // The child exiting first is normal (the client closed the session), so a
    // write racing that exit must not surface as a crash.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") return;
      fail(new GitHubMcpEgressRuntimeError(`MCP server stdin failed (${error.code ?? "unknown"})`, 1));
    });

    function onData(chunk: Buffer | string): void {
      let lines: string[];
      try {
        lines = readFrames(chunk);
      } catch (error) {
        fail(
          error instanceof GitHubMcpEgressRuntimeError
            ? error
            : new GitHubMcpEgressRuntimeError("unable to frame outbound MCP traffic"),
        );
        return;
      }

      for (const line of lines) {
        let out: string;
        try {
          out = transformFrame(line, io);
        } catch (error) {
          fail(
            error instanceof GitHubMcpEgressFrameError
              ? new GitHubMcpEgressRuntimeError(error.message)
              : new GitHubMcpEgressRuntimeError("unable to scrub outbound MCP frame"),
          );
          return;
        }
        if (settled) return;
        // Honour backpressure so a slow server cannot make this process the
        // place where frames pile up.
        if (!child.stdin.write(out)) {
          process.stdin.pause();
          child.stdin.once("drain", () => process.stdin.resume());
        }
      }
    }

    function onEnd(): void {
      // A trailing fragment with no newline is not a frame. Forwarding it would
      // hand the server a truncated message; dropping it is what a newline-
      // delimited transport already implies.
      child.stdin.end();
    }

    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.resume();

    child.once("error", (error: NodeJS.ErrnoException) => {
      fail(
        new GitHubMcpEgressRuntimeError(
          `unable to start GitHub MCP server (${error.code ?? "unknown error"})`,
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
      resolve(forwardedSignal ? 128 : signal ? 128 + (signal === "SIGINT" ? 2 : 15) : 1);
    });
  });
}

function reportRuntimeError(error: unknown): void {
  const message = error instanceof Error ? error.message : "unexpected preparation failure";
  const exitCode = error instanceof GitHubMcpEgressRuntimeError ? error.exitCode : 1;
  console.error(`paperclip-github-mcp-egress: ${message}`);
  process.exitCode = exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  const argv = process.argv.slice(3);
  try {
    void runGitHubMcpEgressRuntime({ target: target ?? "", argv })
      .then((exitCode) => {
        process.exitCode = exitCode;
      })
      .catch(reportRuntimeError);
  } catch (error) {
    reportRuntimeError(error);
  }
}

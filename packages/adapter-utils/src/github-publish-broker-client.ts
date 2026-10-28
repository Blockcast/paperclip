// PEN-4933 / PEN-3183 D1: the agent-side half of the publish broker.
//
// This runs at uid 1000, in a container that holds no GitHub credential. It
// hands a tool invocation to the broker over a unix socket and relays the
// child's stdio back, so that from the caller's point of view `git push` still
// behaves like `git push` — it prints what git prints, and exits with what git
// exits with.
//
// Nothing here is a security control. The agent can edit, replace or simply not
// call this module, and that is fine: the boundary is the credential, which
// lives in a container this uid cannot read into. An agent that bypasses this
// client reaches `/usr/bin/git` with no token and fails to authenticate, which
// is precisely the outcome PEN-3183 §5 asks for. Do not add integrity checks
// here (§8 prohibits them, and §3 says why they cannot work).

import net from "node:net";
import type { Readable, Writable } from "node:stream";

import {
  ClientFrameKind,
  createFrameReader,
  encodeFrame,
  encodePublishBrokerRequest,
  MAX_FRAME_BYTES,
  ServerFrameKind,
  type BrokeredTool,
  type PublishBrokerExit,
} from "./github-publish-broker-protocol.js";

/**
 * Environment variable naming the broker socket.
 *
 * Read from the environment, which the agent controls — see the header. Unset
 * means "no broker in this deployment", which is the pre-PEN-4933 arrangement
 * and the shape every developer checkout and CI job has. Each door therefore
 * falls back to running the real binary locally when this is absent, and that
 * fallback is safe for exactly one reason: where there is no broker there is
 * also no credential to withhold.
 */
export const BROKER_SOCKET_ENV = "PAPERCLIP_GITHUB_BROKER_SOCKET";

/**
 * Marks the process that IS the broker.
 *
 * The three egress runtimes forward to the broker unless this is set, so the
 * broker's own children (which are those same runtimes) must not forward again.
 * A loop here would be an immediate, total outage of all three doors rather
 * than a subtle fault, which is why it is a plain env marker and not something
 * cleverer: it is set by the broker on the child it spawns, one hop, and both
 * ends of that hop are in this repository.
 */
export const BROKER_ROLE_ENV = "PAPERCLIP_GITHUB_BROKER_ROLE";
export const BROKER_ROLE_SERVER = "server";

/** True when this process is the broker, and must therefore run the tool itself. */
export function isBrokerServerProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BROKER_ROLE_ENV] === BROKER_ROLE_SERVER;
}

/**
 * The broker socket this process should use, or null to run locally.
 *
 * Returns null inside the broker even when the socket variable is set, so that
 * a stray inherited value cannot make the broker dial itself.
 */
export function brokerSocketPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (isBrokerServerProcess(env)) return null;
  const value = env[BROKER_SOCKET_ENV];
  return value && value.length > 0 ? value : null;
}

export interface PublishBrokerClientOptions {
  socketPath: string;
  tool: BrokeredTool;
  argv: string[];
  cwd: string;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  /** Injected for tests; production uses `net.connect`. */
  connect?: (socketPath: string) => net.Socket;
}

/**
 * Forward one invocation to the broker and relay its stdio.
 *
 * Resolves with the child's exit code. Rejects only when the broker could not
 * be reached or spoke something this client cannot parse — both of which the
 * callers turn into a non-zero exit with a diagnostic, never into a silent
 * fall-through to a local run. A door that quietly degrades to "no credential,
 * no error" is how a fleet-wide credential fault presented as `gh` doing
 * nothing on a pod that reported healthy (BLO-37977); this one says so.
 */
export function runPublishBrokerClient(options: PublishBrokerClientOptions): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  return new Promise<number>((resolve, reject) => {
    const socket = (options.connect ?? ((p: string) => net.connect(p)))(options.socketPath);
    const read = createFrameReader();
    let settled = false;
    let exitCode: number | null = null;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.on("error", (error: NodeJS.ErrnoException) => {
      fail(
        new Error(
          `paperclip-github-broker: cannot reach the publish broker at ${options.socketPath} ` +
            `(${error.code ?? error.message}). The GitHub credential lives in the broker container, so ` +
            "this is a deployment fault, not something to work around by calling git or gh directly — " +
            "those have no credential to use.",
        ),
      );
    });

    socket.on("connect", () => {
      socket.write(encodePublishBrokerRequest({ tool: options.tool, argv: options.argv, cwd: options.cwd }));
      // Chunked against the frame cap rather than written whole: stdin on the
      // MCP door is an unbounded relay, and on `gh --body-file` it can be a
      // large file. The cap is a per-frame memory bound on the far side, not a
      // limit on how much may be sent.
      stdin.on("data", (chunk: Buffer | string) => {
        let buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        while (buffer.length > 0) {
          const slice = buffer.subarray(0, MAX_FRAME_BYTES);
          buffer = buffer.subarray(slice.length);
          if (!socket.write(encodeFrame(ClientFrameKind.STDIN, slice))) stdin.pause();
        }
      });
      socket.on("drain", () => stdin.resume());
      stdin.on("end", () => socket.write(encodeFrame(ClientFrameKind.STDIN_EOF, Buffer.alloc(0))));
      stdin.on("error", () => socket.write(encodeFrame(ClientFrameKind.STDIN_EOF, Buffer.alloc(0))));
    });

    socket.on("data", (chunk: Buffer) => {
      let frames;
      try {
        frames = read(chunk);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      for (const frame of frames) {
        switch (frame.kind) {
          case ServerFrameKind.STDOUT:
            stdout.write(frame.payload);
            break;
          case ServerFrameKind.STDERR:
            stderr.write(frame.payload);
            break;
          case ServerFrameKind.EXIT: {
            try {
              const parsed = JSON.parse(frame.payload.toString("utf8")) as PublishBrokerExit;
              exitCode = typeof parsed.code === "number" ? parsed.code : 1;
            } catch {
              exitCode = 1;
            }
            break;
          }
          default:
            // An unknown frame kind is not a reason to carry on: the broker and
            // this client ship in the same image, so a kind neither recognises
            // means the two are not the pair they are supposed to be.
            fail(new Error(`paperclip-github-broker: unknown frame kind 0x${frame.kind.toString(16)} from the broker`));
            return;
        }
      }
    });

    socket.on("close", () => {
      if (settled) return;
      settled = true;
      if (exitCode === null) {
        // Fail closed. A connection that ends without an EXIT frame is a broker
        // that died mid-publish, and reporting success there would tell the
        // caller a push landed that may not have.
        reject(
          new Error(
            "paperclip-github-broker: the broker closed the connection without reporting an exit status; " +
              "treat the outcome of this command as unknown and check the remote before retrying.",
          ),
        );
        return;
      }
      resolve(exitCode);
    });
  });
}

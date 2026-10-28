// PEN-4933 / PEN-3183 D1: the wire between an agent container that holds no
// GitHub credential and the broker container that does.
//
// This module is PURE. It frames bytes and validates a request shape; it opens
// no socket, spawns nothing, and reads no environment. Everything about the
// boundary that can be decided without I/O is decided here so it can be tested
// without one.
//
// ## Why a request to PUBLISH and not a request for a token
//
// PEN-3183 §5 is explicit that the obvious implementation — a credential helper
// that scans and then emits the token — is not a boundary at all: anything that
// hands the credential to uid 1000 has handed it to the agent, which can then
// call the helper itself and skip the scan. So there is deliberately NO frame
// kind in this protocol that carries a credential, in either direction, and the
// broker has no code path that could add one. A reviewer checking that property
// should be able to do it by reading {@link ClientFrameKind} and
// {@link ServerFrameKind} and finding nothing credential-shaped. Keep it that
// way: a `TOKEN` frame added here would silently undo the whole change.
//
// ## Framing
//
// `[1 byte kind][4 byte big-endian length][length bytes payload]`, in both
// directions, over a unix stream socket.
//
// Length-prefixed rather than newline-delimited because two of the three doors
// carry arbitrary bytes. `gh` writes binary to stdout (`gh api` on a blob, `gh
// release download`), and the MCP leg relays a JSON-RPC stream whose own
// framing is newline-delimited — re-using newlines here would make the outer
// and inner framings alias, and a frame boundary that depends on the payload's
// content is a parser bug waiting for a payload that contains it.

/** Protocol version. Bumped only on an incompatible change to the request shape. */
export const PUBLISH_BROKER_PROTOCOL_VERSION = 1;

/** Frames the agent-side client sends. */
export const ClientFrameKind = {
  /** JSON {@link PublishBrokerRequest}. Exactly one, first, per connection. */
  REQUEST: 0x01,
  /** Raw stdin bytes for the brokered child. */
  STDIN: 0x02,
  /** Stdin is finished. Zero-length payload. */
  STDIN_EOF: 0x03,
} as const;

/** Frames the broker sends back. */
export const ServerFrameKind = {
  /** Raw stdout bytes from the brokered child. */
  STDOUT: 0x11,
  /** Raw stderr bytes from the brokered child, and the broker's own refusals. */
  STDERR: 0x12,
  /** JSON {@link PublishBrokerExit}. Last frame; the broker closes after it. */
  EXIT: 0x13,
} as const;

/**
 * Largest single frame payload, 8 MiB.
 *
 * Applies to stdin and stdout chunks, which are chunked by the sender, so this
 * is a memory bound and not a limit on total transferred bytes. The REQUEST
 * frame gets its own, much smaller, bound below: an argv that needs megabytes
 * is not an argv, and accepting one would let a connection that has not yet
 * been authorised to do anything allocate like one that has.
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Largest REQUEST payload, 1 MiB. See {@link MAX_FRAME_BYTES}. */
export const MAX_REQUEST_BYTES = 1024 * 1024;

/** The three doors PEN-3183 §4.1 identifies as sharing one credential. */
export const BROKERED_TOOLS = ["git", "gh", "github-mcp-server"] as const;
export type BrokeredTool = (typeof BROKERED_TOOLS)[number];

export function isBrokeredTool(value: unknown): value is BrokeredTool {
  return typeof value === "string" && (BROKERED_TOOLS as readonly string[]).includes(value);
}

/**
 * What the agent asks the broker to do.
 *
 * Note what is NOT here: the caller's environment. The broker builds its
 * child's environment from scratch (see `github-publish-broker.ts`), because
 * the environment of a process that holds a credential is an input to that
 * credential's safety — `GIT_CONFIG_PARAMETERS`, `GIT_ASKPASS`,
 * `GIT_EXTERNAL_DIFF`, `GH_HOST` and `LD_PRELOAD` are each a way to turn
 * "perform this publish" into "run this code next to the token". Forwarding
 * the caller's env would reproduce, inside the boundary, exactly the authority
 * the boundary exists to remove.
 */
export interface PublishBrokerRequest {
  v: number;
  tool: BrokeredTool;
  /** The caller's argv, excluding argv[0]. */
  argv: string[];
  /** Absolute working directory. Validated against the workspace root by the broker. */
  cwd: string;
}

export interface PublishBrokerExit {
  /** Process exit code, or 128+n for a signal, matching the runtimes' own convention. */
  code: number;
}

export class PublishBrokerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishBrokerProtocolError";
  }
}

export function encodeFrame(kind: number, payload: Uint8Array | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  if (body.length > MAX_FRAME_BYTES) {
    throw new PublishBrokerProtocolError(`frame of ${body.length} bytes exceeds the ${MAX_FRAME_BYTES}-byte cap`);
  }
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(kind, 0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

export interface DecodedFrame {
  kind: number;
  payload: Buffer;
}

/**
 * Incremental frame reader.
 *
 * Returns a function that accepts whatever a socket `data` event produced and
 * yields the frames completed by it. A stream parser rather than a
 * read-it-all-then-parse is required on both legs: the MCP door is a long-lived
 * bidirectional relay with no end, and a `git push` streams progress for as
 * long as the pack takes to upload.
 *
 * Over-long frames throw rather than being skipped. A frame this reader cannot
 * hold is one it cannot deliver, and silently dropping it would desynchronise
 * every subsequent frame against a length prefix it never consumed — a parser
 * that resyncs on attacker-chosen content is worse than one that stops.
 */
export function createFrameReader(maxFrameBytes: number = MAX_FRAME_BYTES): (chunk: Buffer) => DecodedFrame[] {
  let buffer = Buffer.alloc(0);
  return (chunk: Buffer): DecodedFrame[] => {
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
    const frames: DecodedFrame[] = [];
    for (;;) {
      if (buffer.length < 5) break;
      const length = buffer.readUInt32BE(1);
      if (length > maxFrameBytes) {
        throw new PublishBrokerProtocolError(
          `frame declares ${length} bytes, over the ${maxFrameBytes}-byte cap`,
        );
      }
      if (buffer.length < 5 + length) break;
      frames.push({ kind: buffer.readUInt8(0), payload: buffer.subarray(5, 5 + length) });
      buffer = buffer.subarray(5 + length);
    }
    return frames;
  };
}

/**
 * Parse and validate a REQUEST payload.
 *
 * Deliberately strict about types rather than coercing. The caller is the
 * account this boundary exists to constrain, so a field that is not the shape
 * it claims to be is a reason to refuse the connection, not a reason to guess.
 */
export function parsePublishBrokerRequest(payload: Buffer): PublishBrokerRequest {
  if (payload.length > MAX_REQUEST_BYTES) {
    throw new PublishBrokerProtocolError(`request of ${payload.length} bytes exceeds the ${MAX_REQUEST_BYTES}-byte cap`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new PublishBrokerProtocolError("request is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PublishBrokerProtocolError("request is not a JSON object");
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.v !== PUBLISH_BROKER_PROTOCOL_VERSION) {
    throw new PublishBrokerProtocolError(
      `unsupported protocol version ${String(candidate.v)}; this broker speaks ${PUBLISH_BROKER_PROTOCOL_VERSION}`,
    );
  }
  if (!isBrokeredTool(candidate.tool)) {
    throw new PublishBrokerProtocolError(
      `unknown tool ${JSON.stringify(candidate.tool)}; expected one of ${BROKERED_TOOLS.join(", ")}`,
    );
  }
  if (!Array.isArray(candidate.argv) || candidate.argv.some((a) => typeof a !== "string")) {
    throw new PublishBrokerProtocolError("argv must be an array of strings");
  }
  // NUL is rejected rather than stripped: it terminates a C string, so an argv
  // element containing one is read differently by this process and by the
  // execve that follows. A guard that inspects the JavaScript string and a
  // kernel that reads the bytes up to the NUL do not have to agree about what
  // the command is, and that disagreement is the whole bypass.
  if ((candidate.argv as string[]).some((a) => a.includes("\0"))) {
    throw new PublishBrokerProtocolError("argv contains a NUL byte");
  }
  if (typeof candidate.cwd !== "string" || candidate.cwd.length === 0 || candidate.cwd.includes("\0")) {
    throw new PublishBrokerProtocolError("cwd must be a non-empty NUL-free string");
  }
  return {
    v: PUBLISH_BROKER_PROTOCOL_VERSION,
    tool: candidate.tool,
    argv: candidate.argv as string[],
    cwd: candidate.cwd,
  };
}

export function encodePublishBrokerRequest(request: Omit<PublishBrokerRequest, "v">): Buffer {
  return encodeFrame(
    ClientFrameKind.REQUEST,
    JSON.stringify({ v: PUBLISH_BROKER_PROTOCOL_VERSION, ...request }),
  );
}

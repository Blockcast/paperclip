// PEN-3152: the SECOND egress choke point for agent-authored text bound for
// GitHub — the one PEN-2527 did not know existed.
//
// PEN-2527 wrapped the `gh` binary (github-cli-egress-shim.ts) and reasoned
// that this was "the single interposition point in front of the GitHub CLI in
// the sandbox". True, and insufficient: the `github` MCP server is a separate
// outbound path to the same destination, launched from its own wrapper in
// deploy/helm/paperclip/templates/statefulset.yaml, holding the same seat
// token, and exposing the complete write toolset — `add_issue_comment`,
// `pull_request_review_write`, `create_pull_request`, `create_or_update_file`,
// `push_files`. Every one of those takes free-form model-authored text and
// publishes it. None of them passed a scrubber before this module.
//
// The asymmetry was the dangerous part. An agent has no way to tell that
// `gh issue comment` is scrubbed while `mcp__github__add_issue_comment` is not,
// so ordinary tool selection drifted toward the unguarded door. The fix is
// therefore NOT a second policy — it is the same policy at the second door:
// this module and the CLI shim both delegate every decision to
// `scrubGitHubEgressText`, so the two doors cannot drift.
//
// ## Why this transform is broader than the CLI shim's
//
// The CLI shim knows which argv flags carry authored text and scrubs those
// (`--body`, `--body-file`, `--raw-field`, ...). That allowlist is safe there
// because `gh`'s surface is fixed and versioned.
//
// MCP has no such surface. Tool schemas are supplied by the server at runtime,
// so the set of parameter names that can carry authored text is not knowable
// here and grows whenever github-mcp-server is upgraded. An allowlist would be
// a hole with a release cadence. So this module scrubs EVERY string in the
// frame's payload members and keys on nothing at all — a tool added upstream
// tomorrow is covered on the day it ships, with no change here.
//
// ## Direction
//
// Client -> server ONLY. Responses (server -> client) are the inbound leg and
// belong to PEN-2370's `packages/mcp-gateway/src/response-scrub.ts`; two
// directions, two controls, as PEN-2527 put it. The runtime enforces that
// structurally rather than by convention: it pipes only the child's stdin and
// leaves stdout inherited, so there is no code path here that could alter a
// response even by mistake.

import {
  type GitHubEgressScrubClass,
  scrubGitHubEgressText,
} from "./github-egress-scrub.js";

/**
 * JSON-RPC envelope members. These route the message; they are never a payload.
 *
 * Everything NOT listed here is treated as payload and deep-scrubbed, so the
 * default for an unrecognised member is to scrub it. That direction matters:
 * a future MCP revision that adds a payload-bearing member gets covered
 * automatically, whereas an allowlist of payload members would silently miss it.
 */
const ENVELOPE_MEMBERS = new Set(["jsonrpc", "id", "method"]);

/**
 * Nesting depth beyond which a frame is refused rather than scrubbed.
 *
 * A frame this deep is not a real tool call, and recursing it risks a stack
 * overflow inside the one process that is supposed to be guarding the channel.
 * Refusing is the fail-closed choice: see `GitHubMcpEgressFrameError`.
 */
const MAX_DEPTH = 200;

/** Raised when a frame cannot be scrubbed. Callers MUST NOT forward the frame. */
export class GitHubMcpEgressFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubMcpEgressFrameError";
  }
}

export interface GitHubMcpFrameScrubResult {
  /** The frame to forward. Byte-identical to the input when nothing fired. */
  line: string;
  /** True when any detector fired. */
  redacted: boolean;
  /** Which classes fired, deduped, in a stable order. */
  classes: GitHubEgressScrubClass[];
}

const CLASS_ORDER: readonly GitHubEgressScrubClass[] = [
  "private-key-block",
  "credentialed-uri",
  "jwt",
  "vendor-key",
  "environment-dump",
  "high-entropy-assignment",
];

/**
 * Scrub one newline-delimited JSON-RPC frame travelling from the MCP client to
 * the GitHub MCP server.
 *
 * Returns the input string unchanged (byte-exact, same reference) when no
 * detector fires, so a clean frame is forwarded without re-serialisation. That
 * is not just an optimisation: re-encoding every frame would silently normalise
 * key order and number formatting on the way to the server, which makes this
 * shim observable to correct traffic. It should not be.
 *
 * A frame that is not JSON is forwarded unchanged. It carries no scrubbable
 * payload by definition, and rejecting it here would turn this shim into a
 * second, worse JSON-RPC validator in front of the real one.
 *
 * @throws GitHubMcpEgressFrameError when the frame parses but cannot be walked.
 */
export function scrubGitHubMcpClientFrame(line: string): GitHubMcpFrameScrubResult {
  const clean: GitHubMcpFrameScrubResult = { line, redacted: false, classes: [] };
  if (line.trim().length === 0) return clean;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Not JSON — nothing to walk. Let the server be the one to complain.
    return clean;
  }
  if (typeof parsed !== "object" || parsed === null) return clean;

  const fired = new Set<GitHubEgressScrubClass>();
  const scrubbed = scrubMessage(parsed, fired, 0);
  if (fired.size === 0) return clean;

  return {
    // JSON.stringify escapes any newline inside a value, so the framing
    // invariant (one message per line, no embedded newlines) survives a
    // multi-line redaction.
    line: JSON.stringify(scrubbed),
    redacted: true,
    classes: CLASS_ORDER.filter((cls) => fired.has(cls)),
  };
}

/**
 * Walk a single message (or every member of a JSON-RPC batch), scrubbing the
 * payload members and leaving the envelope alone.
 */
function scrubMessage(
  message: object,
  fired: Set<GitHubEgressScrubClass>,
  depth: number,
): unknown {
  if (Array.isArray(message)) {
    // JSON-RPC 2.0 batch. MCP's current revision drops batching, but a client
    // that still emits one must not slip past unscrubbed.
    return message.map((entry) =>
      typeof entry === "object" && entry !== null
        ? scrubMessage(entry, fired, depth + 1)
        : scrubValue(entry, fired, depth + 1),
    );
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(message)) {
    out[key] = ENVELOPE_MEMBERS.has(key) ? value : scrubValue(value, fired, depth + 1);
  }
  return out;
}

/** Recursively scrub every string in a payload value. Keys are structural and are left intact. */
function scrubValue(
  value: unknown,
  fired: Set<GitHubEgressScrubClass>,
  depth: number,
): unknown {
  if (depth > MAX_DEPTH) {
    throw new GitHubMcpEgressFrameError(
      `JSON-RPC frame nests deeper than ${MAX_DEPTH} levels; refusing to forward it unscrubbed`,
    );
  }

  if (typeof value === "string") {
    const result = scrubGitHubEgressText(value);
    if (!result.redacted) return value;
    for (const cls of result.classes) fired.add(cls);
    return result.text;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => scrubValue(entry, fired, depth + 1));
  }

  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      out[key] = scrubValue(member, fired, depth + 1);
    }
    return out;
  }

  // Numbers, booleans and null carry no credential shape.
  return value;
}

import { describe, expect, it } from "vitest";

import { redactionMarker } from "./github-egress-scrub.js";
import {
  GitHubMcpEgressFrameError,
  scrubGitHubMcpClientFrame,
} from "./github-mcp-egress-shim.js";

// Every fixture below is SYNTHETIC and DERIVED — assembled at runtime rather
// than written as a literal. Two separate reasons, both load-bearing:
//
//  1. PEN-2526's standing rule: never paste real material into a test "to make
//     it realistic".
//  2. CI scans the COMMIT RANGE with gitleaks, not the worktree. A
//     credential-shaped literal in a new commit trips the gate and cannot be
//     cleared by a follow-up commit that deletes it — only by rewriting the
//     commit. Sibling fixtures already on master are outside the range and so
//     are never rescanned; their literals are not precedent for a new file.
//     Deriving closes the finding at source instead.

/** Deterministic LCG over a 62-char alphabet: mixed case + digits, high per-character entropy. */
function syntheticOpaque(length: number, seed: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  let x = seed;
  for (let i = 0; i < length; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += alphabet[x % alphabet.length] as string;
  }
  return out;
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The PEM label is a named constant rather than an inline literal because
// gitleaks' default `private-key` rule matches `-----BEGIN <...> PRIVATE KEY-----`
// as one token. Spelling that out inline plants a scanner finding inside the
// security PR that exists to stop credential material reaching GitHub. Breaking
// the adjacency keeps the fixture material to the scrubber and invisible to the
// scanner, and gives the assertions below a single source of truth.
const PEM_LABEL = "RSA PRIVATE KEY";

const SYNTHETIC_PEM = [
  `-----BEGIN ${PEM_LABEL}-----`,
  Buffer.from("SYNTHETIC-NOT-A-REAL-KEY-".repeat(3), "utf8").toString("base64"),
  `-----END ${PEM_LABEL}-----`,
].join("\n");

const SYNTHETIC_JWT = [
  base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  base64Url("synthetic-payload-not-real"),
  base64Url("synthetic-signature"),
].join(".");

const SYNTHETIC_OPAQUE = syntheticOpaque(32, 7);

// Assembled from parts so the prefix and the tail never sit adjacent in source.
const SYNTHETIC_VENDOR_KEY = `gh${"p"}_${syntheticOpaque(36, 11)}`;

function frame(method: string, params: unknown, id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

describe("scrubGitHubMcpClientFrame", () => {
  describe("byte-exact pass-through", () => {
    it("returns the identical string when nothing matches", () => {
      const line = frame("tools/call", {
        name: "add_issue_comment",
        arguments: {
          owner: "Blockcast",
          repo: "paperclip",
          issue_number: 1435,
          body: "## Review\n\nOne finding in `server/src/routes/issues.ts`. LGTM otherwise.",
        },
      });

      const result = scrubGitHubMcpClientFrame(line);

      expect(result.redacted).toBe(false);
      expect(result.classes).toEqual([]);
      // Byte-exact, not merely equivalent: a clean frame must not be
      // re-serialised on its way to the server.
      expect(result.line).toBe(line);
    });

    it("leaves a non-JSON line alone rather than becoming a second protocol validator", () => {
      const result = scrubGitHubMcpClientFrame("not json at all");
      expect(result).toEqual({ line: "not json at all", redacted: false, classes: [] });
    });

    it("leaves an empty or whitespace-only line alone", () => {
      expect(scrubGitHubMcpClientFrame("")).toEqual({ line: "", redacted: false, classes: [] });
      expect(scrubGitHubMcpClientFrame("   ")).toEqual({ line: "   ", redacted: false, classes: [] });
    });

    it("leaves a JSON scalar alone", () => {
      expect(scrubGitHubMcpClientFrame("42").redacted).toBe(false);
      expect(scrubGitHubMcpClientFrame('"a string"').redacted).toBe(false);
    });
  });

  describe("the write tools PEN-3152 found unguarded", () => {
    it("scrubs a PEM out of add_issue_comment's body", () => {
      const result = scrubGitHubMcpClientFrame(
        frame("tools/call", {
          name: "add_issue_comment",
          arguments: { owner: "o", repo: "r", issue_number: 1, body: `rotation notes\n${SYNTHETIC_PEM}\nend` },
        }),
      );

      expect(result.redacted).toBe(true);
      expect(result.classes).toEqual(["private-key-block"]);
      expect(result.line).toContain(redactionMarker("private-key-block"));
      expect(result.line).not.toContain(PEM_LABEL);
      // The envelope survives intact.
      const parsed = JSON.parse(result.line) as { jsonrpc: string; id: number; method: string };
      expect(parsed).toMatchObject({ jsonrpc: "2.0", id: 1, method: "tools/call" });
    });

    it("scrubs pull_request_review_write's body — the exact shape of the PEN-2526 exposure", () => {
      const result = scrubGitHubMcpClientFrame(
        frame("tools/call", {
          name: "pull_request_review_write",
          arguments: {
            method: "create",
            owner: "Blockcast",
            repo: "paperclip",
            pullNumber: 1435,
            event: "COMMENT",
            body: `Reviewed. Runtime context:\n${SYNTHETIC_PEM}\nand token ${SYNTHETIC_VENDOR_KEY}`,
          },
        }),
      );

      expect(result.redacted).toBe(true);
      expect(result.classes).toEqual(["private-key-block", "vendor-key"]);
      expect(result.line).not.toContain(SYNTHETIC_VENDOR_KEY);
    });

    it("scrubs create_or_update_file CONTENT, not just comment prose", () => {
      const result = scrubGitHubMcpClientFrame(
        frame("tools/call", {
          name: "create_or_update_file",
          arguments: {
            owner: "o",
            repo: "r",
            branch: "main",
            path: "deploy/values.yaml",
            message: "chore: add config",
            content: `appToken: ${SYNTHETIC_VENDOR_KEY}\n`,
          },
        }),
      );

      expect(result.redacted).toBe(true);
      expect(result.classes).toContain("vendor-key");
      expect(result.line).not.toContain(SYNTHETIC_VENDOR_KEY);
    });

    it("scrubs every file in a push_files array, not only the first", () => {
      const result = scrubGitHubMcpClientFrame(
        frame("tools/call", {
          name: "push_files",
          arguments: {
            owner: "o",
            repo: "r",
            branch: "main",
            message: "chore: bulk add",
            files: [
              { path: "a.txt", content: "harmless" },
              { path: "b.env", content: `AUTH=${SYNTHETIC_OPAQUE}` },
              { path: "c.pem", content: SYNTHETIC_PEM },
            ],
          },
        }),
      );

      expect(result.redacted).toBe(true);
      expect(result.classes).toEqual(["private-key-block", "high-entropy-assignment"]);

      const parsed = JSON.parse(result.line) as {
        params: { arguments: { files: { path: string; content: string }[] } };
      };
      const files = parsed.params.arguments.files;
      expect(files[0]?.content).toBe("harmless");
      expect(files[1]?.content).not.toContain(SYNTHETIC_OPAQUE);
      expect(files[2]?.content).not.toContain(PEM_LABEL);
      // Paths are structural and must survive untouched.
      expect(files.map((f) => f.path)).toEqual(["a.txt", "b.env", "c.pem"]);
    });
  });

  describe("no allowlist to outgrow", () => {
    it("scrubs a parameter name this module has never heard of", () => {
      const result = scrubGitHubMcpClientFrame(
        frame("tools/call", {
          name: "some_tool_added_next_release",
          arguments: { totally_new_field: `see ${SYNTHETIC_JWT}` },
        }),
      );

      expect(result.redacted).toBe(true);
      expect(result.classes).toEqual(["jwt"]);
    });

    it("scrubs an unrecognised payload member, not only `params`", () => {
      // A client-to-server `result` (an MCP sampling reply) is payload too.
      const line = JSON.stringify({ jsonrpc: "2.0", id: 9, result: { text: SYNTHETIC_PEM } });
      const result = scrubGitHubMcpClientFrame(line);

      expect(result.redacted).toBe(true);
      expect(result.classes).toEqual(["private-key-block"]);
    });

    it("scrubs deeply nested payload strings", () => {
      const result = scrubGitHubMcpClientFrame(
        frame("tools/call", {
          name: "x",
          arguments: { a: { b: { c: [{ d: { e: SYNTHETIC_PEM } }] } } },
        }),
      );

      expect(result.redacted).toBe(true);
      expect(result.classes).toEqual(["private-key-block"]);
    });

    it("scrubs each member of a JSON-RPC batch", () => {
      const line = JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { arguments: { body: "clean" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { arguments: { body: SYNTHETIC_PEM } } },
      ]);

      const result = scrubGitHubMcpClientFrame(line);

      expect(result.redacted).toBe(true);
      const parsed = JSON.parse(result.line) as { params: { arguments: { body: string } } }[];
      expect(parsed[0]?.params.arguments.body).toBe("clean");
      expect(parsed[1]?.params.arguments.body).toContain(redactionMarker("private-key-block"));
    });
  });

  describe("protocol integrity", () => {
    it("keeps the envelope's `method` intact even though it is a string", () => {
      // `method` routes the message. Scrubbing it would break dispatch, so it
      // is excluded by name — the one place a name-based rule is correct.
      const line = frame("tools/call", { name: "n", arguments: { body: SYNTHETIC_PEM } });
      const parsed = JSON.parse(scrubGitHubMcpClientFrame(line).line) as { method: string };
      expect(parsed.method).toBe("tools/call");
    });

    it("keeps object KEYS intact", () => {
      const result = scrubGitHubMcpClientFrame(
        frame("tools/call", { name: "n", arguments: { body: SYNTHETIC_PEM, keep_me: 1 } }),
      );
      const parsed = JSON.parse(result.line) as { params: { arguments: Record<string, unknown> } };
      expect(Object.keys(parsed.params.arguments)).toEqual(["body", "keep_me"]);
    });

    it("emits no embedded newline even when the redacted value spanned lines", () => {
      const result = scrubGitHubMcpClientFrame(
        frame("tools/call", { name: "n", arguments: { body: `a\n${SYNTHETIC_PEM}\nb` } }),
      );
      expect(result.redacted).toBe(true);
      // The framing invariant: one message per line.
      expect(result.line).not.toContain("\n");
    });

    it("preserves non-string scalars exactly", () => {
      const result = scrubGitHubMcpClientFrame(
        frame("tools/call", {
          name: "n",
          arguments: { issue_number: 1435, draft: false, milestone: null, body: SYNTHETIC_PEM },
        }),
      );
      const parsed = JSON.parse(result.line) as {
        params: { arguments: { issue_number: number; draft: boolean; milestone: null } };
      };
      expect(parsed.params.arguments).toMatchObject({
        issue_number: 1435,
        draft: false,
        milestone: null,
      });
    });
  });

  describe("fail closed", () => {
    it("throws rather than forwarding a frame nested past the walk limit", () => {
      let nested = '{"deep":1}';
      for (let i = 0; i < 260; i += 1) nested = `{"a":${nested}}`;
      const line = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":${nested}}`;

      expect(() => scrubGitHubMcpClientFrame(line)).toThrow(GitHubMcpEgressFrameError);
    });
  });

  describe("fixture self-checks", () => {
    // A fixture that stopped tripping its detector would make the assertions
    // above pass for the wrong reason. Assert the fixtures are still material.
    it("each derived fixture still trips the detector it targets", () => {
      expect(scrubGitHubMcpClientFrame(frame("m", { a: SYNTHETIC_PEM })).classes).toEqual([
        "private-key-block",
      ]);
      expect(scrubGitHubMcpClientFrame(frame("m", { a: SYNTHETIC_JWT })).classes).toEqual(["jwt"]);
      expect(scrubGitHubMcpClientFrame(frame("m", { a: SYNTHETIC_VENDOR_KEY })).classes).toEqual([
        "vendor-key",
      ]);
      expect(
        scrubGitHubMcpClientFrame(frame("m", { a: `AUTH=${SYNTHETIC_OPAQUE}` })).classes,
      ).toEqual(["high-entropy-assignment"]);
    });
  });
});

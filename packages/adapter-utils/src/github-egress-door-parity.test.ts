import { describe, expect, it } from "vitest";

import type { GitHubEgressScrubClass } from "./github-egress-scrub.js";
import { scrubGitHubCliInvocation } from "./github-cli-egress-shim.js";
import { scrubGitHubMcpClientFrame } from "./github-mcp-egress-shim.js";

/**
 * PEN-3152 done-when 3: "a regression test that fails if a `github` MCP write
 * tool can publish text the `gh` path would scrub."
 *
 * This file asserts PARITY rather than either door's behaviour in isolation,
 * because the defect PEN-3152 recorded was not that the MCP door scrubbed
 * badly — it was that the two doors DISAGREED, while looking to an agent like
 * interchangeable ways to do the same thing:
 *
 *   > an agent has no way to tell that `mcp__github__add_issue_comment` is
 *   > unscrubbed while `gh issue comment` is scrubbed. The safe path is the one
 *   > with the *worse* ergonomics, so ordinary tool selection drifts toward the
 *   > unguarded door.
 *
 * A per-door test cannot catch a re-divergence: both would keep passing while
 * one door quietly stopped covering a class. Only a differential test does.
 *
 * The two shims delegate every decision to `scrubGitHubEgressText`, so parity
 * is currently structural and these assertions are cheap. That is the point —
 * they fail the moment someone gives one door its own policy, which is exactly
 * how the original gap was introduced.
 */

// Derived fixtures. See github-mcp-egress-shim.test.ts on why no
// credential-shaped literal appears in a new commit.
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
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Assembled, not written out — see the PEM_LABEL note in
// github-mcp-egress-shim.test.ts on why an inline PEM header trips gitleaks.
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

const SYNTHETIC_VENDOR_KEY = `gh${"p"}_${syntheticOpaque(36, 11)}`;
const SYNTHETIC_OPAQUE = syntheticOpaque(32, 7);

/**
 * One payload per scrub class, plus the prose control.
 *
 * Every class the shared core can emit must appear here. The final test in this
 * file asserts that, so adding a seventh class to `GitHubEgressScrubClass`
 * fails until it is exercised through both doors.
 */
const PAYLOADS: readonly { name: string; text: string }[] = [
  { name: "private-key-block", text: `rotation notes\n${SYNTHETIC_PEM}\ndone` },
  {
    name: "credentialed-uri",
    text: `clone from https://oauth2:${SYNTHETIC_OPAQUE}@github.com/o/r.git and retry`,
  },
  { name: "jwt", text: `Authorization: Bearer ${SYNTHETIC_JWT}` },
  { name: "vendor-key", text: `the seat token is ${SYNTHETIC_VENDOR_KEY}` },
  {
    name: "environment-dump",
    text: [
      "PAPERCLIP_ONE=alpha",
      "PAPERCLIP_TWO=beta",
      "PAPERCLIP_THREE=gamma",
      "PAPERCLIP_FOUR=delta",
      "PAPERCLIP_FIVE=epsilon",
    ].join("\n"),
  },
  { name: "high-entropy-assignment", text: `SOME_UNENUMERATED_NAME=${SYNTHETIC_OPAQUE}` },
  {
    name: "clean prose (control)",
    text: "## Review\n\nOne finding in `server/src/routes/issues.ts`. LGTM otherwise.",
  },
];

/** What the `gh` door does with a body. */
function throughCliDoor(text: string): { redacted: boolean; classes: GitHubEgressScrubClass[] } {
  const result = scrubGitHubCliInvocation(["issue", "comment", "1435", "--body", text], {
    readText: () => {
      throw new Error("no file-backed text in this fixture");
    },
    writeTempText: () => {
      throw new Error("no file-backed text in this fixture");
    },
  });
  return { redacted: result.redacted, classes: result.classes };
}

/** What the MCP door does with the same body. */
function throughMcpDoor(
  text: string,
  tool = "add_issue_comment",
  field = "body",
): { redacted: boolean; classes: GitHubEgressScrubClass[] } {
  const result = scrubGitHubMcpClientFrame(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: { owner: "o", repo: "r", issue_number: 1435, [field]: text } },
    }),
  );
  return { redacted: result.redacted, classes: result.classes };
}

describe("GitHub egress doors agree", () => {
  describe.each(PAYLOADS)("$name", ({ text }) => {
    it("both doors reach the same verdict and fire the same classes", () => {
      const cli = throughCliDoor(text);
      const mcp = throughMcpDoor(text);

      expect(mcp.redacted).toBe(cli.redacted);
      expect(mcp.classes).toEqual(cli.classes);
    });

    it("the MCP door never publishes what the CLI door removed", () => {
      const cli = throughCliDoor(text);
      if (!cli.redacted) return;

      const raw = scrubGitHubMcpClientFrame(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "add_issue_comment", arguments: { body: text } },
        }),
      );

      // Whatever the CLI door judged to be material must not survive in the
      // frame the MCP server is handed.
      for (const marker of [SYNTHETIC_PEM, SYNTHETIC_JWT, SYNTHETIC_VENDOR_KEY, SYNTHETIC_OPAQUE]) {
        if (text.includes(marker)) expect(raw.line).not.toContain(marker);
      }
    });
  });

  /**
   * The write tools PEN-3152 attested were live in an agent session, with the
   * free-text parameter each one publishes.
   *
   * This list is the row's own evidence turned into an assertion. Its value is
   * that it names TOOLS, so it keeps holding if the transform is ever narrowed
   * from "every payload string" to something field-aware — which is the most
   * likely future regression, since a field allowlist is the obvious
   * optimisation and is precisely what would reopen the gap.
   */
  const WRITE_TOOLS: readonly { tool: string; field: string }[] = [
    { tool: "add_issue_comment", field: "body" },
    { tool: "pull_request_review_write", field: "body" },
    { tool: "add_comment_to_pending_review", field: "body" },
    { tool: "add_reply_to_pull_request_comment", field: "body" },
    { tool: "create_pull_request", field: "body" },
    { tool: "create_pull_request", field: "title" },
    { tool: "update_pull_request", field: "body" },
    { tool: "issue_write", field: "body" },
    { tool: "create_or_update_file", field: "content" },
    { tool: "create_or_update_file", field: "message" },
    { tool: "push_files", field: "message" },
  ];

  describe.each(WRITE_TOOLS)("$tool.$field", ({ tool, field }) => {
    it("cannot publish a private key", () => {
      const result = throughMcpDoor(`context:\n${SYNTHETIC_PEM}`, tool, field);
      expect(result.redacted).toBe(true);
      expect(result.classes).toContain("private-key-block");
    });

    it("cannot publish a seat token", () => {
      const result = throughMcpDoor(`token ${SYNTHETIC_VENDOR_KEY}`, tool, field);
      expect(result.redacted).toBe(true);
      expect(result.classes).toContain("vendor-key");
    });
  });

  it("exercises every class the shared core can emit", () => {
    // Keeps PAYLOADS exhaustive. If a new detector class is added to
    // github-egress-scrub.ts, this fails until both doors are shown to agree
    // on it — rather than the new class silently going untested at one door.
    const allClasses: readonly GitHubEgressScrubClass[] = [
      "private-key-block",
      "credentialed-uri",
      "jwt",
      "vendor-key",
      "environment-dump",
      "high-entropy-assignment",
    ];

    const covered = new Set<GitHubEgressScrubClass>();
    for (const { text } of PAYLOADS) {
      for (const cls of throughMcpDoor(text).classes) covered.add(cls);
    }

    expect([...covered].sort()).toEqual([...allClasses].sort());
  });
});

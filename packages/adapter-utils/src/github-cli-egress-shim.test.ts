import { describe, expect, it } from "vitest";

import {
  hasGitHubCliStdinTextFile,
  scrubGitHubCliInvocation,
  type GitHubCliScrubIo,
} from "./github-cli-egress-shim.js";
import { redactionMarker } from "./github-egress-scrub.js";

// Synthetic throughout — see github-egress-scrub.test.ts for the standing rule.
const SYNTHETIC_OPAQUE_VALUE = "s7Kq2Vt9Lm4Xb8Nd3Wp6Zc1Yr5Hj0Tg";
const SYNTHETIC_PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "U1lOVEhFVElDLU5PVC1BLVJFQUwtS0VZLXBhZGRpbmctbGluZS1vbmUtLS0tLS0t",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

function makeIo(files: Record<string, string> = {}): GitHubCliScrubIo & {
  written: string[];
} {
  const written: string[] = [];
  return {
    written,
    readText(path: string) {
      const found = files[path];
      if (found === undefined) throw new Error(`unexpected read: ${path}`);
      return found;
    },
    writeTempText(contents: string) {
      written.push(contents);
      return `/tmp/scrubbed-${written.length}`;
    },
  };
}

describe("scrubGitHubCliInvocation", () => {
  describe("pass-through", () => {
    it("leaves a clean invocation byte-identical", () => {
      const argv = ["pr", "review", "1435", "--comment", "--body", "LGTM, shipping."];
      const io = makeIo();
      const result = scrubGitHubCliInvocation(argv, io);

      expect(result.argv).toEqual(argv);
      expect(result.redacted).toBe(false);
      expect(result.classes).toEqual([]);
      expect(io.written).toEqual([]);
    });

    it("does not rewrite a clean body file", () => {
      const io = makeIo({ "/tmp/review.md": "## Review\n\nNo findings." });
      const result = scrubGitHubCliInvocation(
        ["pr", "review", "--body-file", "/tmp/review.md"],
        io,
      );

      expect(result.argv).toEqual(["pr", "review", "--body-file", "/tmp/review.md"]);
      expect(result.redacted).toBe(false);
      // No temp file created — the original path is still what gh will read.
      expect(io.written).toEqual([]);
    });

    it("ignores flags that do not carry authored text", () => {
      const argv = ["api", "-X", "POST", "/repos/a/b/issues", "--jq", ".number"];
      const result = scrubGitHubCliInvocation(argv, makeIo());
      expect(result.argv).toEqual(argv);
      expect(result.redacted).toBe(false);
    });
  });

  describe("inline text flags", () => {
    it("scrubs --body given as a separate argument", () => {
      const result = scrubGitHubCliInvocation(
        ["pr", "comment", "--body", `token ${SYNTHETIC_OPAQUE_VALUE ? "ghp_S7kq2Vt9Lm4Xb8Nd3Wp6Zc1Yr5Hj0TgAbCd" : ""}`],
        makeIo(),
      );

      expect(result.redacted).toBe(true);
      expect(result.classes).toContain("vendor-key");
      expect(result.argv[3]).not.toContain("ghp_");
    });

    it("scrubs the fused --body=<text> form", () => {
      const result = scrubGitHubCliInvocation(
        ["pr", "comment", `--body=key is ${SYNTHETIC_PEM}`],
        makeIo(),
      );

      expect(result.redacted).toBe(true);
      expect(result.classes).toContain("private-key-block");
      expect(result.argv[2]).toMatch(/^--body=/);
      expect(result.argv[2]).not.toContain("BEGIN RSA PRIVATE KEY");
    });

    it("scrubs -b, --title and -m", () => {
      for (const flag of ["-b", "--title", "-m"]) {
        const result = scrubGitHubCliInvocation(
          ["pr", "create", flag, `x ghp_S7kq2Vt9Lm4Xb8Nd3Wp6Zc1Yr5Hj0TgAbCd`],
          makeIo(),
        );
        expect(result.redacted, `flag ${flag}`).toBe(true);
        expect(result.argv[3]).not.toContain("ghp_");
      }
    });
  });

  describe("body files — the PEN-2526 path", () => {
    // Ally posts its consolidated review with `gh pr review --body-file`.
    it("rewrites argv to a scrubbed temp file and never mutates the original", () => {
      const original = [
        "## Ally review",
        "",
        "Looks good. Runtime env is",
        `PAPERCLIP_AGENT_JWT_SECRET=${SYNTHETIC_OPAQUE_VALUE}`,
        "SERVICE_HOST=paperclip-api.default.svc",
        "SERVICE_PORT=3000",
        "NODE_ENV=production",
        "FEATURE_FLAG_A=true",
        "",
        "so the gate is fine.",
      ].join("\n");
      const io = makeIo({ "/tmp/review.md": original });

      const result = scrubGitHubCliInvocation(
        ["pr", "review", "1435", "--comment", "--body-file", "/tmp/review.md"],
        io,
      );

      expect(result.redacted).toBe(true);
      // argv now points at the scrubbed copy, not the original.
      expect(result.argv[5]).toBe("/tmp/scrubbed-1");
      expect(io.written).toHaveLength(1);

      const scrubbed = io.written[0] as string;
      expect(scrubbed).not.toContain(SYNTHETIC_OPAQUE_VALUE);
      expect(scrubbed).toContain("## Ally review");
      expect(scrubbed).toContain("so the gate is fine.");
    });

    it("handles the fused --body-file=<path> form", () => {
      const io = makeIo({ "/tmp/r.md": `k ${SYNTHETIC_PEM}` });
      const result = scrubGitHubCliInvocation(["pr", "review", "--body-file=/tmp/r.md"], io);

      expect(result.argv[2]).toBe("--body-file=/tmp/scrubbed-1");
      expect(io.written[0]).not.toContain("BEGIN RSA PRIVATE KEY");
    });

    it("identifies stdin-backed body files so the runtime can reject them", () => {
      const io = makeIo();
      const result = scrubGitHubCliInvocation(["pr", "review", "--body-file", "-"], io);

      // makeIo throws on any read; reaching here proves none was attempted.
      expect(result.argv).toEqual(["pr", "review", "--body-file", "-"]);
      expect(result.redacted).toBe(false);
      expect(hasGitHubCliStdinTextFile(result.argv)).toBe(true);
    });

    it("identifies fused stdin-backed body and notes files", () => {
      expect(hasGitHubCliStdinTextFile(["pr", "review", "--body-file=-"])).toBe(true);
      expect(hasGitHubCliStdinTextFile(["pr", "edit", "--notes-file", "-"])).toBe(true);
      expect(hasGitHubCliStdinTextFile(["pr", "edit", "--body-file", "/tmp/body.md"])).toBe(false);
    });
  });

  describe("gh api request bodies and fields", () => {
    it("scrubs raw and typed fields that carry comment text", () => {
      for (const flag of ["-f", "--raw-field", "-F", "--field"]) {
        const result = scrubGitHubCliInvocation(
          [
            "api",
            "repos/acme/widget/issues/7/comments",
            flag,
            `body=comment text ${"ghp_S7kq2Vt9Lm4Xb8Nd3Wp6Zc1Yr5Hj0TgAbCd"}`,
          ],
          makeIo(),
        );

        expect(result.redacted, `flag ${flag}`).toBe(true);
        expect(result.argv[3]).toMatch(/^body=/);
        expect(result.argv[3]).not.toContain("ghp_");
      }
    });

    it("scrubs fused raw and typed field forms", () => {
      const result = scrubGitHubCliInvocation(
        [
          "api",
          "repos/acme/widget/issues/7",
          "--raw-field=body=issue text ghp_S7kq2Vt9Lm4Xb8Nd3Wp6Zc1Yr5Hj0TgAbCd",
          "-F=body=PR text ghp_S7kq2Vt9Lm4Xb8Nd3Wp6Zc1Yr5Hj0TgAbCd",
        ],
        makeIo(),
      );

      expect(result.argv[2]).toMatch(/^--raw-field=body=/);
      expect(result.argv[2]).not.toContain("ghp_");
      expect(result.argv[3]).toMatch(/^-F=body=/);
      expect(result.argv[3]).not.toContain("ghp_");
      expect(result.classes).toContain("vendor-key");
    });

    it("scrubs a generic --input request body without mutating the source file", () => {
      const original = `{"body":"comment ghp_S7kq2Vt9Lm4Xb8Nd3Wp6Zc1Yr5Hj0TgAbCd"}`;
      const io = makeIo({ "/tmp/request.json": original });

      const result = scrubGitHubCliInvocation(
        ["api", "repos/acme/widget/issues/7/comments", "--input", "/tmp/request.json"],
        io,
      );

      expect(result.argv[3]).not.toBe("/tmp/request.json");
      expect(io.written).toHaveLength(1);
      expect(io.written[0]).toContain('"body":"comment');
      expect(io.written[0]).not.toContain("ghp_");
      expect(original).toContain("ghp_");
    });

    it("scrubs a typed @file field before gh reads it", () => {
      const io = makeIo({
        "/tmp/comment.txt": "comment ghp_S7kq2Vt9Lm4Xb8Nd3Wp6Zc1Yr5Hj0TgAbCd",
      });

      const result = scrubGitHubCliInvocation(
        ["api", "repos/acme/widget/issues/7/comments", "-F", "body=@/tmp/comment.txt"],
        io,
      );

      expect(result.argv[3]).toBe("body=@/tmp/scrubbed-1");
      expect(io.written[0]).not.toContain("ghp_");
    });

    it("recognizes request-body stdin forms as fail-closed inputs", () => {
      expect(hasGitHubCliStdinTextFile(["api", "repos/acme/widget/issues/7", "--input", "-"])).toBe(true);
      expect(hasGitHubCliStdinTextFile(["api", "repos/acme/widget/issues/7", "--input=-"])).toBe(true);
      expect(hasGitHubCliStdinTextFile(["api", "repos/acme/widget/issues/7", "-F", "body=@-"])).toBe(true);
      expect(hasGitHubCliStdinTextFile(["api", "repos/acme/widget/issues/7", "--field=body=@-"])).toBe(true);
      expect(hasGitHubCliStdinTextFile(["api", "repos/acme/widget/issues/7", "-f", "body=@-"])).toBe(false);
    });
  });

  // BLO-33171. The boundary is pinned in BOTH directions in this one block on
  // purpose: the tempting "fix" for the corruption is to exempt `content` from
  // the scrubber, which converts a loud-on-review corruption into a silent
  // credential-exfiltration bypass. Every positive case below is paired with
  // the prose case that must still be redacted.
  describe("repository content is refused, never rewritten", () => {
    // The shape that was actually eaten on #1542: a vendor-key literal used as
    // the INPUT FIXTURE of a redaction regression test.
    // Derived at runtime, never embedded: an inline literal here would be real
    // credential-shaped material in tracked source, which the git publish guard
    // (PEN-3156) refuses on any commit that touches this line.
    const VENDOR_TOKEN = ["sk", "ant", "api03-AAAAAAAAAAAAAAAAAAAA"].join("-");
    const SOURCE_WITH_FIXTURE = [
      "const REDACTION_FIXTURES = [",
      `  "${VENDOR_TOKEN}",`,
      "];",
    ].join("\n");

    it("passes clean content through byte-exact", () => {
      const argv = ["api", "repos/o/r/git/blobs", "-f", "content=export const x = 1;\n"];
      const result = scrubGitHubCliInvocation(argv, makeIo());

      expect(result.argv).toEqual(argv);
      expect(result.refusals).toEqual([]);
      expect(result.redacted).toBe(false);
    });

    it("leaves credential-shaped content byte-exact and refuses the call", () => {
      const argv = ["api", "repos/o/r/git/blobs", "-f", `content=${SOURCE_WITH_FIXTURE}`];
      const io = makeIo();
      const result = scrubGitHubCliInvocation(argv, io);

      // The bytes are untouched — this is what stops the silent corruption.
      expect(result.argv).toEqual(argv);
      expect(result.argv[3]).toContain(VENDOR_TOKEN);
      expect(io.written).toEqual([]);
      // ...but the invocation is not allowed to run.
      expect(result.refusals).toEqual([
        { field: "content", path: null, classes: ["vendor-key"] },
      ]);
    });

    it("still redacts the SAME token in a prose body (no blanket exemption)", () => {
      const result = scrubGitHubCliInvocation(
        ["api", "repos/o/r/issues/7/comments", "-f", `body=${SOURCE_WITH_FIXTURE}`],
        makeIo(),
      );

      expect(result.argv[3]).toContain(redactionMarker("vendor-key"));
      expect(result.argv[3]).not.toContain(VENDOR_TOKEN);
      expect(result.refusals).toEqual([]);
      expect(result.redacted).toBe(true);
    });

    it("refuses a typed content field backed by a file", () => {
      const io = makeIo({ "/tmp/src.ts": SOURCE_WITH_FIXTURE });
      const result = scrubGitHubCliInvocation(
        ["api", "repos/o/r/git/blobs", "-F", "content=@/tmp/src.ts"],
        io,
      );

      expect(result.argv[3]).toBe("content=@/tmp/src.ts");
      expect(io.written).toEqual([]); // no scrubbed temp copy for gh to send
      expect(result.refusals).toEqual([
        { field: "content", path: "/tmp/src.ts", classes: ["vendor-key"] },
      ]);
    });

    it("refuses a --input request body carrying file bytes", () => {
      const body = JSON.stringify({ content: SOURCE_WITH_FIXTURE, encoding: "utf-8" });
      const io = makeIo({ "/tmp/blob.json": body });
      const result = scrubGitHubCliInvocation(
        ["api", "repos/o/r/git/blobs", "--input", "/tmp/blob.json"],
        io,
      );

      expect(result.argv[3]).toBe("/tmp/blob.json");
      expect(io.written).toEqual([]);
      expect(result.refusals).toEqual([
        { field: "--input", path: "/tmp/blob.json", classes: ["vendor-key"] },
      ]);
    });

    it("refuses content nested in a git/trees request body", () => {
      const body = JSON.stringify({
        tree: [{ path: "a.ts", mode: "100644", content: SOURCE_WITH_FIXTURE }],
      });
      const io = makeIo({ "/tmp/tree.json": body });
      const result = scrubGitHubCliInvocation(
        ["api", "repos/o/r/git/trees", "--input", "/tmp/tree.json"],
        io,
      );

      // Behavioural assertion first: without the fix gh is handed a scrubbed
      // temp copy, so this fails on the corruption rather than on a shape.
      expect(io.written).toEqual([]);
      expect(result.argv[3]).toBe("/tmp/tree.json");
      expect(result.refusals).toHaveLength(1);
    });

    it("scrubs prose beside clean content instead of refusing the whole body", () => {
      // The `contents/{path}` write path: base64 bytes plus an authored commit
      // message. A detector firing in the MESSAGE must not condemn the bytes —
      // refusing on any-hit-anywhere would block the documented fleet path over
      // prose the scrubber is supposed to rewrite in place.
      const clean = Buffer.from("export const x = 1;\n", "utf8").toString("base64");
      const body = JSON.stringify({ content: clean, message: `rotate ${VENDOR_TOKEN}` });
      const io = makeIo({ "/tmp/put.json": body });
      const result = scrubGitHubCliInvocation(
        ["api", "repos/o/r/contents/a.ts", "--input", "/tmp/put.json"],
        io,
      );

      expect(result.refusals).toEqual([]);
      expect(io.written).toHaveLength(1);

      const sent = JSON.parse(io.written[0] as string) as Record<string, string>;
      // Bytes survive byte-exact...
      expect(sent.content).toBe(clean);
      // ...while the prose beside them is still redacted.
      expect(sent.message).toContain(redactionMarker("vendor-key"));
      expect(sent.message).not.toContain(VENDOR_TOKEN);
      expect(result.classes).toContain("vendor-key");
    });

    it("scrubs prose strings nested in arrays beside clean content", () => {
      // walk() used to hand primitive strings straight back, so a string
      // INSIDE an array reached neither the content branch nor the scrubber.
      // Once any `content` key set sawContent, the body was sent as-is and the
      // credential shipped verbatim — a leak, not a corruption.
      const clean = Buffer.from("export const x = 1;\n", "utf8").toString("base64");
      const body = JSON.stringify({
        content: clean,
        messages: [`rotate ${VENDOR_TOKEN}`, { note: `also ${VENDOR_TOKEN}` }],
      });
      const io = makeIo({ "/tmp/put.json": body });
      const result = scrubGitHubCliInvocation(
        ["api", "repos/o/r/contents/a.ts", "--input", "/tmp/put.json"],
        io,
      );

      expect(result.refusals).toEqual([]);
      expect(io.written).toHaveLength(1);
      expect(io.written[0]).not.toContain(VENDOR_TOKEN);

      const sent = JSON.parse(io.written[0] as string) as {
        content: string;
        messages: [string, { note: string }];
      };
      expect(sent.content).toBe(clean);
      expect(sent.messages[0]).toContain(redactionMarker("vendor-key"));
      expect(sent.messages[1].note).toContain(redactionMarker("vendor-key"));
      expect(result.classes).toContain("vendor-key");
    });

    it("refuses on the content value even when prose beside it is clean", () => {
      // The mirror of the case above: attribution has to work in both
      // directions, or "attribute the match" degrades into "never refuse".
      const body = JSON.stringify({ content: SOURCE_WITH_FIXTURE, message: "add fixtures" });
      const io = makeIo({ "/tmp/put.json": body });
      const result = scrubGitHubCliInvocation(
        ["api", "repos/o/r/contents/a.ts", "--input", "/tmp/put.json"],
        io,
      );

      expect(io.written).toEqual([]);
      expect(result.refusals).toEqual([
        { field: "--input", path: "/tmp/put.json", classes: ["vendor-key"] },
      ]);
    });

    it("still scrubs a --input body that is prose, not content", () => {
      const body = JSON.stringify({ body: `comment ${SOURCE_WITH_FIXTURE}` });
      const io = makeIo({ "/tmp/comment.json": body });
      const result = scrubGitHubCliInvocation(
        ["api", "repos/o/r/issues/7/comments", "--input", "/tmp/comment.json"],
        io,
      );

      expect(result.refusals).toEqual([]);
      expect(io.written).toHaveLength(1);
      expect(io.written[0]).toContain(redactionMarker("vendor-key"));
    });

    it("does not refuse prose that merely mentions a content key", () => {
      // Name-shaped text inside a PROSE value must not trip the content rule —
      // this is why the --input predicate parses JSON instead of grepping.
      const body = JSON.stringify({
        body: `the "content": field broke, see ${SOURCE_WITH_FIXTURE}`,
      });
      const io = makeIo({ "/tmp/c.json": body });
      const result = scrubGitHubCliInvocation(
        ["api", "repos/o/r/issues/7/comments", "--input", "/tmp/c.json"],
        io,
      );

      expect(result.refusals).toEqual([]);
      expect(io.written).toHaveLength(1);
    });

    it("leaves the documented base64 fleet write path working", () => {
      // AGENTS.md:300 — `contents/{path}` PUT with base64 content and a prose
      // commit message. Standard base64 has no `-`, so `sk-` cannot survive the
      // encoding; the message beside it is prose and must still be scrubbed.
      const encoded = Buffer.from(SOURCE_WITH_FIXTURE, "utf8").toString("base64");
      const result = scrubGitHubCliInvocation(
        [
          "api", "repos/o/r/contents/src/a.ts", "-X", "PUT",
          "-f", `message=land ${VENDOR_TOKEN}`,
          "-f", `content=${encoded}`,
          "-f", "branch=main",
        ],
        makeIo(),
      );

      expect(result.refusals).toEqual([]);
      expect(result.argv[7]).toBe(`content=${encoded}`); // content untouched
      expect(result.argv[5]).toContain(redactionMarker("vendor-key"));
    });
  });

  it("reports every class it removed across mixed argv", () => {
    const io = makeIo({ "/tmp/r.md": `body ${SYNTHETIC_PEM}` });
    const result = scrubGitHubCliInvocation(
      ["pr", "create", "--title", "fix ghp_S7kq2Vt9Lm4Xb8Nd3Wp6Zc1Yr5Hj0TgAbCd", "--body-file", "/tmp/r.md"],
      io,
    );

    expect(result.classes).toContain("vendor-key");
    expect(result.classes).toContain("private-key-block");
  });
});

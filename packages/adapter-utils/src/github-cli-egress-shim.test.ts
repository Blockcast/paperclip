import { describe, expect, it } from "vitest";

import {
  hasGitHubCliStdinTextFile,
  scrubGitHubCliInvocation,
  type GitHubCliScrubIo,
} from "./github-cli-egress-shim.js";

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
